import { createMachine, createActor } from 'xstate';
import { systemClock } from './clock.js';
import { REVISIT_EVENTS, OFF_PATH_ACTIVATION_EVENT } from './contract.js';
import { roomCentroid } from './zone-math.js';

/**
 * Presentation roots from which an activation request can be accepted (§3.4).
 *
 * `settling` is included: a room winding down has not reset yet, and making an
 * arriving guest wait out a grace timer they cannot see is the worst version of
 * this — they stand in a room where nothing happens. An arrival interrupts the
 * settle and takes the room instead.
 *
 * Whether that actually happens is the machine's call: a room is interruptible
 * exactly when its `settling` state declares a transition for the activation
 * event. One that does not simply refuses, and the rollback in
 * `requestActivation` keeps the lock from being stranded.
 */
const ACTIVATABLE = new Set(['idle', 'settling']);

/** Presentation roots that require a lock holder to be coherent. */
const REQUIRES_LOCK = new Set(['active']);

export const DEFAULT_GRACE_MS = 10000;

export function stateToString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return Object.entries(value)
    .map(([k, sub]) => `${k}.${stateToString(sub)}`)
    .join(' ∥ ');
}

/**
 * The top-level presentation state, from either a snapshot value or a state
 * string this module produced.
 *
 * The string form matters: `stateToString` yields "active.main" for a nested
 * state, and returning that verbatim made every `REQUIRES_LOCK.has(...)` check
 * miss — so a room with sub-states under `active` never released its lock on
 * the way out. Rooms without sub-states worked, which is why it went unseen.
 */
export function rootState(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.split(' ')[0].split('.')[0];
  return Object.keys(value)[0] ?? null;
}

/**
 * One XState actor per physical room. Presentation state only.
 *
 * Occupancy and the lock table live on the coordinator (one authority makes the
 * operator snapshot coherent and keeps acquisition race-free); this actor is the
 * only thing that asks for them, so the lock and the machine cannot drift apart.
 */
export class RoomActor {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {object} opts.def — room block from the show JSON
   * @param {import('./coordinator.js').OccupancyCoordinator} opts.coordinator
   * @param {object} [opts.clock]
   * @param {(intent: object) => void} [opts.emitOutput]
   * @param {(event: object) => void} [opts.appendEvent]
   * @param {(guestId: string) => boolean} [opts.eligibleToHold] — may this guest
   *   hold the room? The room cannot answer that itself and must not learn how;
   *   it asks, exactly as it receives history on an activation request.
   * @param {(from: string, to: string) => void} [opts.onLockTransferred] — the
   *   room changed hands without anyone asking, so whoever inherited it needs
   *   to know: their own record still says they were refused.
   * @param {() => void} [opts.onAvailable] — the room reset with eligible guests
   *   still standing in it, and its policy says to play for them.
   * @param {() => void} [opts.onStateChange]
   */
  constructor(opts) {
    this.roomId = opts.roomId;
    this.name = opts.def.name ?? opts.roomId;
    this.def = opts.def;
    this.kind = opts.def.kind ?? 'destination';
    this.coordinator = opts.coordinator;
    this.clock = opts.clock ?? systemClock;
    this.emitOutput = opts.emitOutput ?? (() => {});
    this.appendEvent = opts.appendEvent ?? (() => {});
    this.eligibleToHold = opts.eligibleToHold ?? (() => true);
    this.onLockTransferred = opts.onLockTransferred ?? (() => {});
    this.onAvailable = opts.onAvailable ?? (() => {});
    this.onStateChange = opts.onStateChange ?? (() => {});
    this.actor = null;
    this.state = 'idle';
    this.lastRefuse = null;
    this._unsub = null;
    /** Exit-grace timer handle, live only while the room sits in `settling`. */
    this._resetTimer = null;
    this._resetDueAt = null;
    /** Who held the lock when this room last emptied — the only guest it will resume for. */
    this.lastHolder = null;
  }

  /** What to do when this room frees up with someone already inside (§3.5). */
  whenAvailablePolicy() {
    return this.def.whenAvailable?.policy ?? 'wait';
  }

  /** @returns {{ policy: string, graceMs: number, resumeIfReturned: boolean }} */
  exitPolicy() {
    const exit = this.def.exit ?? {};
    return {
      policy: exit.policy ?? 'resetAfter',
      graceMs: exit.policy === 'resetImmediate' ? 0 : (exit.graceMs ?? DEFAULT_GRACE_MS),
      resumeIfReturned: exit.resumeIfReturned === true,
    };
  }

  now() {
    return this.clock.now();
  }

  start() {
    this.stop();
    // A hallway is never activated, so it is not required to declare a machine.
    // It still gets an actor: guests occupy it, and the operator view lists it
    // alongside everything else.
    const config = this.def.machine ?? { initial: 'idle', states: { idle: {} } };
    const machine = createMachine({ ...config, id: config.id ?? this.roomId });
    // The show clock drives authored `after` transitions too, so scripted
    // walkthroughs replay room timing at speed along with everything else.
    this.actor = createActor(machine, { clock: this.clock });
    this._unsub = this.actor.subscribe((snap) => {
      const next = stateToString(snap.value);
      if (next === this.state) return;
      const previous = this.state;
      this.state = next;
      this.emitOutput({
        type: 'roomOutput',
        roomId: this.roomId,
        state: next,
        previousState: previous,
        lockHolder: this.coordinator.getLock(this.roomId)?.guestId ?? null,
      });
      this.appendEvent({
        type: 'room.state',
        roomId: this.roomId,
        state: next,
        previousState: previous,
      });
      // Every route into `settling` gets the same grace timer — occupancy
      // dropping to zero, an authored DONE at the end of the content, or an
      // operator forcing it. Hanging the timer off the state rather than off
      // the departure is what makes `finish` fall out for free.
      const root = rootState(snap.value);
      if (root === 'settling') this.scheduleReset();
      else this.cancelReset();
      this.dropStaleLock(rootState(previous), root);
      this.onStateChange();
      this.offerToOccupants(rootState(previous), root);
    });
    this.actor.start();
    this.state = stateToString(this.actor.getSnapshot().value);
  }

  stop() {
    this.cancelReset();
    this._unsub?.unsubscribe?.();
    this._unsub = null;
    if (this.actor) {
      try { this.actor.stop(); } catch {}
      this.actor = null;
    }
    this.coordinator.releaseLock(this.roomId);
    this.state = 'idle';
    this.lastRefuse = null;
    this.lastHolder = null;
  }

  /**
   * The lock invariant runs both ways.
   *
   * An `active` room with no holder is incoherent — that is why `RELEASE`
   * exists. The inverse is equally incoherent and easier to miss: a room that
   * has left its activated states still holding a lock. It happens whenever a
   * room finishes its own content while someone is still standing in it — the
   * authored `after` runs to `settling`, resets to `idle`, and nobody ever
   * departed to trigger a release. The room then looks available while
   * silently refusing everyone but the stale holder.
   *
   * @param {string | null} previousRoot
   * @param {string | null} nextRoot
   */
  dropStaleLock(previousRoot, nextRoot) {
    if (!REQUIRES_LOCK.has(previousRoot) || REQUIRES_LOCK.has(nextRoot)) return;
    const lock = this.coordinator.getLock(this.roomId);
    if (!lock) return;
    this.lastHolder = lock.guestId;
    this.coordinator.releaseLock(this.roomId, lock.guestId);
    this.appendEvent({
      type: 'room.lockReleased',
      roomId: this.roomId,
      guestId: lock.guestId,
      reason: 'contentEnded',
    });
  }

  /**
   * The room just became available with people already inside.
   *
   * Without this they stand in a reset room holding a stale refusal, and nothing
   * ever offers it to them — they never left, so no arrival fires. Only rooms
   * that opt in replay; the default is to sit idle until somebody walks in.
   */
  offerToOccupants(previousRoot, nextRoot) {
    if (nextRoot !== 'idle' || previousRoot === 'idle') return;
    if (this.whenAvailablePolicy() !== 'activate') return;
    if (this.coordinator.getLock(this.roomId)) return;
    if (!this.holderCandidates().length) return;

    // Deferred deliberately. This runs inside the machine's own subscriber, and
    // XState *queues* a send made from there rather than processing it inline —
    // so `requestActivation` would compare state before and after its send, see
    // no change, roll the lock back as rejected, and only then would the queued
    // ACTIVATE land. The room would end up active with no holder.
    this.clock.setTimeout(() => {
      // Re-check: the world may have moved on before this ran.
      if (this.presentationRoot() !== 'idle') return;
      if (this.coordinator.getLock(this.roomId)) return;
      if (!this.holderCandidates().length) return;
      this.onAvailable();
    }, 0);
  }

  scheduleReset() {
    this.cancelReset();
    const { graceMs } = this.exitPolicy();
    this._resetDueAt = this.now() + graceMs;
    this._resetTimer = this.clock.setTimeout(() => {
      this._resetTimer = null;
      this._resetDueAt = null;
      if (this.presentationRoot() !== 'settling') return;
      this.actor.send({ type: 'RESET' });
      this.appendEvent({ type: 'room.reset', roomId: this.roomId, state: this.state });
      this.onStateChange();
    }, graceMs);
  }

  cancelReset() {
    if (this._resetTimer != null) {
      this.clock.clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }
    this._resetDueAt = null;
  }

  presentationRoot() {
    if (!this.actor) return 'idle';
    return rootState(this.actor.getSnapshot().value);
  }

  /**
   * Spatial fan-out from the coordinator.
   *
   * Arrivals never activate a room — that is an explicit request from the guest
   * actor, because eligibility is not the room's business. Departures, by
   * contrast, are entirely the room's business: nobody else can decide what an
   * emptied room should do.
   *
   * Occupancy is room-level, so a guest moving between two of this room's zones
   * is neither an arrival nor a departure.
   *
   * @param {import('./coordinator.js').ZoneOccupancyEvent} event
   */
  handleSpatialEvent(event) {
    const left = event.previousRoomId === this.roomId && event.roomId !== this.roomId;
    const arrived = event.roomId === this.roomId
      && event.occupancy === 'inside'
      && event.previousRoomId !== this.roomId;
    if (left) this.handleDeparture(event.guestId);
    if (arrived) this.handleArrival(event.guestId);
    this.onStateChange();
  }

  /**
   * Occupants who could actually hold this room.
   *
   * A guest standing in a room that is not theirs is physically present but is
   * nobody the room is running for — they got its `ineligible` response and the
   * room never changed for them. Counting them would let a room be held by
   * someone it is not playing to, and would keep it running for an empty house.
   */
  holderCandidates(excludeGuestId = null) {
    return this.coordinator
      .getRoomOccupants(this.roomId)
      .filter((o) => o.guestId !== excludeGuestId && this.eligibleToHold(o.guestId));
  }

  handleDeparture(guestId) {
    const remaining = this.holderCandidates(guestId);
    const lock = this.coordinator.getLock(this.roomId);

    if (remaining.length > 0) {
      // Someone it is running for is still inside. If the departing guest held
      // the lock it transfers to the longest-present of them; the room does not
      // reset under the people standing in it.
      if (lock?.guestId === guestId) this.release(guestId);
      return;
    }

    if (!REQUIRES_LOCK.has(this.presentationRoot())) return;
    this.applyExitPolicy(guestId);
  }

  /** Occupancy has reached zero while the room is running (§3.5). */
  applyExitPolicy(lastGuestId) {
    const { policy } = this.exitPolicy();
    this.appendEvent({
      type: 'room.emptied',
      roomId: this.roomId,
      lastGuestId,
      policy,
      state: this.state,
    });

    if (policy === 'hold') {
      // Freeze in place. The lock is deliberately retained: "until someone
      // returns or the operator intervenes" means this room is still theirs,
      // and it must not be activatable by anyone else mid-content. This is the
      // one documented exception to release-on-exit (§3.4).
      return;
    }

    if (policy === 'finish') {
      // Let the content play out to its own end in an empty room. The lock is
      // released — nobody is coming back to it — but the machine is left alone
      // until it reaches `settling` by itself, which starts the grace timer.
      this.coordinator.releaseLock(this.roomId);
      this.appendEvent({ type: 'room.lockReleased', roomId: this.roomId, guestId: lastGuestId });
      return;
    }

    // resetAfter (default) and resetImmediate both go to `settling` now; they
    // differ only in the grace time the settling timer runs for.
    this.release(null);
  }

  handleArrival(guestId) {
    if (this.presentationRoot() !== 'settling') return;
    const { resumeIfReturned } = this.exitPolicy();
    if (!resumeIfReturned) return;
    // Resume for the guest who left it, and nobody else. The room cannot judge
    // eligibility — that is the guest actor's job — so "they came back" is the
    // only claim it can safely make. Anyone else entering a settling room is an
    // ordinary arrival, and their own actor decides what it means.
    if (guestId !== this.lastHolder) return;

    // They came back inside the grace window — cancel the reset and hand the
    // room back rather than making them watch it restart.
    this.cancelReset();
    const before = this.state;
    this.actor.send({ type: 'RESUME', guestId });
    if (this.state === before) {
      // The machine declined RESUME; the room stays in settling, so put the
      // grace timer back rather than stranding it there.
      this.scheduleReset();
      return;
    }
    this.coordinator.acquireLock(this.roomId, guestId);
    this.lastHolder = null;
    this.appendEvent({
      type: 'room.resumed',
      roomId: this.roomId,
      guestId,
      state: this.state,
    });
  }

  /**
   * @param {string} guestId
   * @param {{ seen?: boolean, completed?: boolean, activatedByMe?: boolean }} [context]
   *   What this room's history is *for the activating guest* — enough for
   *   a revisit variant, and nothing about their path or identity.
   * @returns {{ ok: true, state: string } | { ok: false, reason: string }}
   */
  requestActivation(guestId, context = {}) {
    if (this.kind === 'hallway') return this.refuse(guestId, 'hallway');
    const root = this.presentationRoot();
    if (!ACTIVATABLE.has(root)) {
      return this.refuse(guestId, this.coordinator.getLock(this.roomId) ? 'locked' : 'busy');
    }

    const lock = this.coordinator.acquireLock(this.roomId, guestId);
    if (!lock.ok) return this.refuse(guestId, lock.reason);

    // Must not be called from inside this machine's own subscriber: XState
    // would queue the send and this check would misread it as a refusal. See
    // `offerToOccupants`, which defers for exactly that reason.
    const before = this.state;
    this.actor.send({
      type: this.activationEventFor(context),
      guestId,
      seen: !!context.seen,
      completed: !!context.completed,
      activatedByMe: !!context.activatedByMe,
      offPath: !!context.offPath,
    });

    if (this.state === before) {
      // The machine declined the event. Never leave a lock behind for a room
      // that did not actually activate — that would strand it for the show.
      this.coordinator.releaseLock(this.roomId, guestId);
      return this.refuse(guestId, 'rejected');
    }

    // Whatever the room was winding down from, it is this guest's now — so it
    // is no longer the previous holder's to resume.
    const interrupted = ACTIVATABLE.has(root) && root === 'settling';
    this.lastHolder = null;
    this.appendEvent({
      type: 'room.activated',
      roomId: this.roomId,
      guestId,
      state: this.state,
      revisit: !!context.seen,
      offPath: !!context.offPath,
      interruptedSettling: interrupted,
    });
    return { ok: true, state: this.state, interruptedSettling: interrupted };
  }

  /**
   * Which activation event this guest's history calls for.
   *
   * The branch is resolved here rather than by a guard inside the statechart:
   * show JSON has no condition language, and conditions belong with the
   * orchestrator that can actually compute them. The chart sees plain named
   * transitions, which is also what makes it readable as a diagram.
   *
   * Precedence is most-specific-first, and a variant only applies if the room
   * both declares it in `revisit` and handles the event — validated at load, so
   * there is no silent fallback here.
   */
  activationEventFor(context) {
    // A guest who was not sent here gets the room's variant, if it declares one.
    // Eligibility therefore selects which activation a room gets rather than
    // gating activation outright.
    if (context.offPath) return OFF_PATH_ACTIVATION_EVENT;
    const revisit = this.def.revisit ?? {};
    if (context.completed && revisit.whenCompleted) return REVISIT_EVENTS.whenCompleted;
    if (context.seen && revisit.whenSeen) return REVISIT_EVENTS.whenSeen;
    return 'ACTIVATE';
  }

  refuse(guestId, reason) {
    this.lastRefuse = { guestId, reason, at: this.now() };
    this.appendEvent({ type: 'room.activationRefused', roomId: this.roomId, guestId, reason });
    return { ok: false, reason };
  }

  /**
   * Release the activation lock (holder left, operator override, disconnect).
   *
   * Per §3.4 the lock transfers to the longest-present remaining occupant
   * rather than resetting the room under them. Only when nobody is left does
   * the room actually give up the lock — and then it must leave its activated
   * states, because an `active` room with no holder is exactly the incoherence
   * this path exists to prevent.
   *
   * @param {string | null} guestId — restrict to this holder, or null to force
   * @returns {{ ok: boolean, transferredTo?: string, reason?: string }}
   */
  release(guestId = null) {
    const lock = this.coordinator.getLock(this.roomId);
    if (!lock) return { ok: false, reason: 'unlocked' };
    if (guestId && lock.guestId !== guestId) return { ok: false, reason: 'notHolder' };

    const successor = this.holderCandidates(lock.guestId)
      .sort((a, b) => (a.sinceTs ?? 0) - (b.sinceTs ?? 0))[0];

    if (successor) {
      this.coordinator.transferLock(this.roomId, successor.guestId);
      this.appendEvent({
        type: 'room.lockTransferred',
        roomId: this.roomId,
        from: lock.guestId,
        to: successor.guestId,
      });
      this.onLockTransferred(lock.guestId, successor.guestId);
      this.onStateChange();
      return { ok: true, transferredTo: successor.guestId };
    }

    this.lastHolder = lock.guestId;
    this.coordinator.releaseLock(this.roomId, lock.guestId);
    this.appendEvent({ type: 'room.lockReleased', roomId: this.roomId, guestId: lock.guestId });
    if (REQUIRES_LOCK.has(this.presentationRoot())) {
      this.actor.send({ type: 'RELEASE' });
    }
    this.onStateChange();
    return { ok: true };
  }

  /** Operator/runtime-driven event into the room machine (RESET, DONE, …). */
  send(event) {
    if (!this.actor) return false;
    this.actor.send(typeof event === 'string' ? { type: event } : event);
    return true;
  }

  snapshot() {
    const lock = this.coordinator.getLock(this.roomId);
    const occupants = this.coordinator.getRoomOccupants(this.roomId);
    return {
      roomId: this.roomId,
      name: this.name,
      centre: roomCentroid(this.def),
      state: this.state,
      kind: this.kind,
      lockHolder: lock?.guestId ?? null,
      lastHolder: this.lastHolder,
      // Everyone physically inside, and the subset the room is actually running
      // for. The two differ whenever somebody wanders into a room not theirs.
      occupantCount: occupants.length,
      occupants: occupants.map((o) => o.guestId),
      eligibleOccupants: this.holderCandidates().map((o) => o.guestId),
      lastRefuse: this.lastRefuse,
      exitPolicy: this.exitPolicy().policy,
      // Operators need to see the grace window ticking, not infer it.
      resetDueAt: this._resetDueAt,
      resetInMs: this._resetDueAt == null ? null : Math.max(0, this._resetDueAt - this.now()),
    };
  }
}
