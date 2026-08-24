import { roomStandingSpot, slotForGuest } from './zone-math.js';

const DEFAULTS = {
  /** Floor-plan units per second. The demo plan is ~400 units wide. */
  speed: 90,
  /**
   * How long to linger *past* the room's own `seen.dwellMs`, so a visit
   * reliably counts. Derived per room rather than flat, because a flat number
   * has to be as long as the slowest room and then every other room drags.
   */
  dwellPadMs: 2000,
  /** Cap, for rooms with a very long seen threshold. */
  maxDwellMs: 40000,
  /** How long to wait before setting off again when there is nowhere to go. */
  pauseMs: 2000,
  /**
   * How long a simulated guest takes to answer a screen that wants a gesture.
   * Long enough to read a line of type and reach for the glass.
   */
  answerMs: 3500,
  stepMs: 120,
};

/**
 * Drives simulated guests around the floor plan on their own.
 *
 * This exists because the behavioural matrix cannot be tested by hand. Capacity
 * needs five guests inside one room; phase advance needs several guests seeing
 * several rooms; the load target is fifty. One mouse cannot drag five dots at
 * once, so without this the later sub-phases are untestable rather than merely
 * tedious.
 *
 * It lives on the server rather than in the panel so it keeps running with the
 * browser closed, works headless for load tests, and produces exactly the same
 * `setVirtualPosition` calls a human dragging a dot would — the runtime cannot
 * tell the difference, which is the whole point of the location abstraction.
 */
export class WalkthroughDriver {
  /**
   * @param {object} opts
   * @param {import('./runtime.js').SpatialRuntime} opts.runtime
   * @param {object} opts.clock
   */
  constructor(opts) {
    this.runtime = opts.runtime;
    this.clock = opts.clock;
    this.config = { ...DEFAULTS };
    this.running = false;
    /** @type {Map<string, WalkState>} */
    this.walkers = new Map();
    this._timer = null;
  }

  configure(patch = {}) {
    this.config = { ...this.config, ...patch };
  }

  /** @param {string[]} [guestIds] — defaults to every guest currently in the show */
  start(guestIds) {
    const ids = guestIds ?? [...this.runtime.guests.keys()];
    for (const guestId of ids) {
      if (!this.walkers.has(guestId)) {
        this.walkers.set(guestId, {
          guestId, target: null, waitUntil: 0, phase: 'idle', dwellRoomId: null,
          pendingInput: null,
        });
      }
    }
    if (this.running) return this.status();
    this.running = true;
    this.schedule();
    return this.status();
  }

  stop(guestIds) {
    if (guestIds) {
      for (const guestId of guestIds) this.walkers.delete(guestId);
      if (this.walkers.size) return this.status();
    } else {
      this.walkers.clear();
    }
    this.running = false;
    if (this._timer != null) {
      this.clock.clearTimeout(this._timer);
      this._timer = null;
    }
    return this.status();
  }

  remove(guestId) {
    this.walkers.delete(guestId);
  }

  schedule() {
    if (!this.running) return;
    this._timer = this.clock.setTimeout(() => {
      this._timer = null;
      this.step();
      this.schedule();
    }, this.config.stepMs);
  }

  step() {
    if (!this.runtime.running) return;
    const now = this.clock.now();
    for (const walker of this.walkers.values()) {
      const guest = this.runtime.guests.get(walker.guestId);
      if (!guest) {
        this.walkers.delete(walker.guestId);
        continue;
      }
      this.advanceWalker(walker, guest, now);
    }
  }

  advanceWalker(walker, guest, now) {
    if (now < walker.waitUntil) return;

    // The show has asked this guest for a gesture and is holding for it.
    // Walking them out of the room would be the simulation answering by
    // leaving — and for a guest with a handset in their hand, it looks like the
    // show wandering off mid-question.
    const pending = this.runtime.pendingInputs(guest.guestId);
    if (pending.length) return this.answerOrWait(walker, guest, pending, now);
    if (walker.phase === 'answering' || walker.phase === 'held') walker.phase = 'idle';

    if (!walker.target) {
      const target = this.chooseTarget(guest);
      if (!target) {
        // Nothing left to see. Wait, rather than spinning — a guest who has
        // finished their path is a legitimate end state, not an error.
        walker.phase = 'done';
        walker.waitUntil = now + this.config.pauseMs;
        return;
      }
      walker.target = target;
      walker.phase = 'walking';
    }

    const position = this.runtime.getVirtualPosition(walker.guestId) ?? this.startingPoint();
    const [tx, ty] = walker.target.point;
    const dx = tx - position.x;
    const dy = ty - position.y;
    const distance = Math.hypot(dx, dy);
    const stepDistance = (this.config.speed * this.config.stepMs) / 1000;

    if (distance <= stepDistance) {
      this.runtime.setVirtualPosition(walker.guestId, tx, ty);
      // Linger past this room's own seen threshold, then move on.
      walker.phase = 'dwelling';
      walker.dwellRoomId = walker.target.roomId;
      walker.waitUntil = now + this.dwellMsFor(walker.target.roomId);
      walker.target = null;
      return;
    }

    this.runtime.setVirtualPosition(
      walker.guestId,
      position.x + (dx / distance) * stepDistance,
      position.y + (dy / distance) * stepDistance,
    );
  }

  /**
   * Sit still while the show waits on this guest.
   *
   * A guest issued a phone is left alone: a person is going to answer, and
   * answering for them is the bug this exists to avoid. Deliberately keyed on
   * what the guest *is* rather than on whether their socket is up this second —
   * a backgrounded handset is still in somebody's hand, and tapping through
   * their orientation while they get the app back is precisely the fault.
   *
   * A simulated guest has nobody to tap for them, so the driver taps. That is
   * the honest simulation, and it keeps the rest of the show reachable in a
   * load test rather than stranding every dot on the first screen.
   */
  answerOrWait(walker, guest, pending, now) {
    walker.target = null;

    if (guest.kind === 'phone') {
      walker.phase = 'held';
      walker.waitUntil = now + this.config.pauseMs;
      return;
    }
    if (walker.phase !== 'answering') {
      walker.phase = 'answering';
      walker.pendingInput = pending[0];
      walker.waitUntil = now + this.config.answerMs;
      return;
    }
    // Re-read rather than trusting what was pending when the pause began — the
    // guest may have been moved, or answered from a real phone meanwhile.
    this.runtime.guestInput(guest.guestId, pending[0]);
    walker.phase = 'idle';
    walker.pendingInput = null;
  }

  /** Long enough that this room's `seen` threshold is comfortably crossed. */
  dwellMsFor(roomId) {
    const threshold = this.runtime.def?.rooms?.[roomId]?.seen?.dwellMs ?? 20000;
    return Math.min(threshold + this.config.dwellPadMs, this.config.maxDwellMs);
  }

  /**
   * Head for an eligible room they have not seen yet; failing that, any eligible
   * room. Deliberately naive — it walks in a straight line through walls,
   * because a simulated guest is a source of spatial events, not a pedestrian.
   */
  chooseTarget(guest) {
    const actor = this.runtime.guestActors.get(guest.guestId);

    // Follow the show where it is leading: while a path is assigned, guidance
    // names the room to head for, and walking anywhere else would make the
    // simulation contradict the thing it is supposed to be exercising.
    const guided = actor?.guidanceTarget();
    const roomId = guided && guided !== guest.roomId
      ? guided
      : this.nextUnseen(guest, actor);

    if (!roomId) return null;
    // Each guest gets their own spot in the room, so a crowd reads as a crowd.
    const point = this.runtime.standingSpot(roomId, guest.guestId);
    return point ? { roomId, point } : null;
  }

  /**
   * Somewhere they have not been, or nowhere.
   *
   * Deliberately no fallback to rooms they have already seen. There used to be
   * one, and a guest who had seen everything ping-ponged between the first two
   * rooms in the show's declaration order for the rest of the night — the list
   * is ordered, so "the first eligible room that is not this one" oscillates
   * between exactly two. Having finished is a legitimate end state.
   */
  nextUnseen(guest, actor) {
    const eligible = actor ? actor.eligibleRoomIds() : Object.keys(this.runtime.def?.rooms ?? {});
    return eligible.find((roomId) => roomId !== guest.roomId && !guest.history(roomId).seen) ?? null;
  }

  startingPoint() {
    const extent = this.runtime.floorPlan()?.extent;
    if (!extent) return { x: 0, y: 0 };
    return { x: extent.minX, y: extent.minY };
  }

  /** What this walker is doing right now — the panel shows it per guest. */
  intent(guestId) {
    const walker = this.walkers.get(guestId);
    if (!walker) return null;
    const remaining = Math.max(0, walker.waitUntil - this.clock.now());
    return {
      phase: walker.phase,
      targetRoomId: walker.target?.roomId ?? null,
      dwellRoomId: walker.dwellRoomId,
      pendingInput: walker.pendingInput ?? null,
      movesInMs: ['dwelling', 'done', 'answering'].includes(walker.phase) ? remaining : null,
    };
  }

  status() {
    return {
      running: this.running,
      walking: [...this.walkers.keys()],
      config: { ...this.config },
    };
  }
}

/**
 * @typedef {Object} WalkState
 * @property {string} guestId
 * @property {{ roomId: string, point: [number, number] } | null} target
 * @property {number} waitUntil
 */
