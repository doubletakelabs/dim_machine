import { randomUUID } from 'node:crypto';
import { validateShowDefinition } from './validate.js';
import { OccupancyCoordinator } from './coordinator.js';
import { VirtualLocationAdapter } from './virtual-location.js';
import { RoomActor } from './room-actor.js';
import {
  CueDirector, roomCueFor, guestCueFor, audioPart, screenPart,
} from './cue-director.js';
import { Guest } from './guest.js';
import { GuestActor } from './guest-actor.js';
import { buildGuestMachine } from './guest-machine.js';
import { expandSequences } from './sequence.js';
import { WalkthroughDriver } from './walkthrough.js';
import { roomStandingSpot, slotForGuest, floorPlanExtent } from './zone-math.js';
import { systemClock } from './clock.js';
import {
  OCCUPANCY_STATES, CUE_SLOTS, AUDIO_CUE_SLOTS, SCREEN_CUE_SLOT, AUTHORED_GUEST_REGIONS,
} from './contract.js';

/**
 * Coordinator wake-up granularity. A pending entry/exit confirmation can only
 * commit on a tick, so this is added latency on top of the configured confirm
 * hold — at 250ms it was a visible quarter-second of "why has nothing happened".
 */
const TICK_MS = 100;
const EVENT_LOG_CAP = 500;
const OUTPUT_LOG_CAP = 200;

/**
 * Spatial show runtime — v0.3 Phase A.
 * A1: occupancy coordinator + virtual location.
 * A2: room actors, activation, lock coherence.
 * A4: exit policies, grace timers, resume.
 * Guest actors wired in A3 (see guest.js).
 */
export class SpatialRuntime {
  /** @param {{ log?: (line: string) => void, onStateChange?: () => void, onOccupancy?: (event: object) => void, onEvent?: (event: object) => void, clock?: object, enableTick?: boolean }} io */
  constructor(io = {}) {
    this.io = io;
    this.director = new CueDirector({
      emitCue: (guestId, cue) => this.io.onCue?.(guestId, cue),
      clock: io.clock ?? systemClock,
    });
    this.clock = io.clock ?? systemClock;
    this.enableTick = io.enableTick !== false;
    this.def = null;
    this.running = false;
    /** @type {Map<string, RoomActor>} */
    this.rooms = new Map();
    /** @type {Map<string, Guest>} */
    this.guests = new Map();
    /** @type {Map<string, GuestActor>} */
    this.guestActors = new Map();
    /** @type {Map<string, string>} token → guestId */
    this.tokens = new Map();
    this.globals = {};
    this._pathAssignIndex = 0;
    /** Monotonic, so labels stay unique after a guest is removed. */
    this._guestSeq = 0;
    this.outputLog = [];
    /**
     * The event log. Today an in-memory ring buffer; §12 replaces the sink with
     * an append-only Postgres table. Every state mutation goes through
     * `append()` so that swap stays a sink change and nothing else — event
     * sourcing cannot be retrofitted after the mutations have scattered.
     */
    this.eventLog = [];
    /** @type {OccupancyCoordinator | null} */
    this.coordinator = null;
    /** @type {VirtualLocationAdapter | null} */
    this.virtualLocation = null;
    /** @type {WalkthroughDriver | null} */
    this.walkthrough = null;
    /** Show-clock instant the show started, for elapsed-time display. */
    this.startedAt = null;
    this._tickHandle = null;
  }

  now() {
    return this.clock.now();
  }

  load(def) {
    // The validator expands sequences itself and reports on the result, so a
    // show file is checkable exactly as authored. Expanding again here is a pure
    // function of the same input, and what the runtime actually runs.
    const { errors, warnings } = validateShowDefinition(def);
    if (errors.length) return { errors, warnings, ok: false };

    this.stop({ quiet: true });
    this.def = expandSequences(def).def;
    this.globals = Object.fromEntries(
      Object.entries(def.globals ?? {}).map(([k, g]) => [k, g.initial ?? null]),
    );
    this.rooms.clear();
    this.guests.clear();
    this.guestActors.clear();
    this.tokens.clear();
    this._pathAssignIndex = 0;
    this._guestSeq = 0;
    this.outputLog = [];
    this.eventLog = [];

    this.coordinator = new OccupancyCoordinator({
      rooms: this.def.rooms,
      location: this.def.location,
      clock: this.clock,
      callbacks: {
        onOccupancyCommitted: (ev) => this.handleOccupancyCommitted(ev),
        onRoomSeen: (payload) => this.handleRoomSeen(payload),
      },
    });

    this.virtualLocation = new VirtualLocationAdapter({
      rooms: this.def.rooms,
      coordinator: this.coordinator,
    });

    this.walkthrough = new WalkthroughDriver({ runtime: this, clock: this.clock });
    this.guestMachineConfig = buildGuestMachine(this.def);

    for (const roomId of Object.keys(this.def.rooms)) {
      this.rooms.set(roomId, new RoomActor({
        roomId,
        def: this.def.rooms[roomId],
        coordinator: this.coordinator,
        clock: this.clock,
        emitOutput: (intent) => this.emitRoomOutput(intent),
        appendEvent: (event) => this.append(event),
        // The room asks; the guest actor answers. Rooms still never learn what
        // eligibility means, only whether a given guest passes it.
        eligibleToHold: (guestId) => this.guestActors.get(guestId)?.isEligible(roomId) ?? false,
        onLockTransferred: (from, to) => this.handleLockTransferred(roomId, from, to),
        onAvailable: () => this.handleRoomAvailable(roomId),
        onStateChange: () => this.notifyChange(),
      }));
    }

    this.director.load(this.def);
    this.append({ type: 'show.loaded', showId: this.def.showId, rooms: [...this.rooms.keys()] });
    this.io.log?.(`show loaded: ${def.name ?? def.showId} (contract v3, ${this.rooms.size} rooms)`);
    this.notifyChange();
    return { errors: [], warnings, ok: true };
  }

  start() {
    if (!this.def || !this.coordinator) return false;
    if (this.running) return true;
    this.running = true;
    this.startedAt = this.now();
    for (const room of this.rooms.values()) room.start();
    for (const p of this.guests.values()) {
      this.coordinator.ensureGuest(p.guestId);
      this.coordinator.setConnected(p.guestId, p.connected);
      this.guestActors.get(p.guestId)?.start();
    }
    this.startTick();
    this.append({ type: 'show.started', showId: this.def.showId });
    this.io.log?.(`show started: ${this.def.name ?? this.def.showId}`);
    this.notifyChange();
    return true;
  }

  /** @param {{ quiet?: boolean }} [opts] */
  stop(opts = {}) {
    this.stopTick();
    if (!this.running && !this.def) return;
    const wasRunning = this.running;
    this.running = false;
    if (this.coordinator) {
      for (const p of this.guests.values()) {
        p.roomId = null;
        p.zoneId = null;
        p.occupancy = 'outside';
        this.coordinator.removeGuest(p.guestId);
      }
    }
    this.walkthrough?.stop();
    for (const actor of this.guestActors.values()) actor.stop();
    this.startedAt = null;
    for (const room of this.rooms.values()) room.stop();
    if (wasRunning) this.append({ type: 'show.stopped', showId: this.def?.showId ?? null });
    if (!opts.quiet) {
      this.io.log?.('show stopped');
      this.notifyChange();
    }
  }

  /**
   * The tick is scheduled on the show clock, not `setInterval`, so a manual
   * clock advancing through a scripted walkthrough drives coordinator timers
   * exactly as wall-clock does in the venue.
   */
  startTick() {
    if (!this.enableTick) return;
    this.stopTick();
    const tick = () => {
      if (!this.running || !this.coordinator) return;
      this.coordinator.processTime(this.now());
      this._tickHandle = this.clock.setTimeout(tick, TICK_MS);
    };
    this._tickHandle = this.clock.setTimeout(tick, TICK_MS);
  }

  stopTick() {
    if (this._tickHandle != null) {
      this.clock.clearTimeout(this._tickHandle);
      this._tickHandle = null;
    }
  }

  spawnGuest({ label } = {}) {
    if (!this.def) return null;
    const guestId = `u-${randomUUID().slice(0, 8)}`;
    const token = randomUUID();
    const num = ++this._guestSeq;

    // No path at the door. The journey assigns one when the guest reaches the
    // part of the show that has paths, which is also when there is real
    // occupancy to spread them against.
    const guest = new Guest({
      guestId,
      token,
      label: label ?? `Guest ${num}`,
      pathId: null,

    });

    this.guests.set(guestId, guest);
    const actor = new GuestActor({
      guest,
      show: this.def,
      machineConfig: this.guestMachineConfig,
      clock: this.clock,
      requestActivation: (roomId, context) => this.activateFor(guestId, roomId, context),
      roomSnapshot: (roomId) => this.rooms.get(roomId)?.snapshot() ?? null,
      assignPath: (from, strategy) => this.nextPath(from, strategy),
      appendEvent: (event) => this.append(event),
      onStateChange: () => this.notifyChange(),
    });
    this.guestActors.set(guestId, actor);
    if (this.running) actor.start();
    this.tokens.set(token, guestId);
    this.coordinator?.ensureGuest(guestId);
    this.coordinator?.setConnected(guestId, true);

    this.append({ type: 'guest.joined', guestId, label: guest.label });
    if (this.running) {
      this.io.log?.(`${guest.label} joined`);
    }
    this.notifyChange();
    return { token, guestId, label: guest.label };
  }

  removeGuest(guestId) {
    const p = this.guests.get(guestId);
    if (!p) return false;

    // Leaving the show is a departure like any other: unindex first so the room
    // sees accurate occupancy, then run the same exit path a walk-out takes.
    // Anything else would let `hold` and `finish` rooms behave differently
    // depending on how the guest happened to vanish.
    const occupied = this.coordinator?.getOccupancy(guestId)?.roomId ?? null;
    this.coordinator?.removeGuest(guestId);
    if (occupied) this.rooms.get(occupied)?.handleDeparture(guestId);
    for (const room of this.rooms.values()) {
      if (this.coordinator?.getLock(room.roomId)?.guestId === guestId) room.release(guestId);
    }

    this.tokens.delete(p.token);
    this.guests.delete(guestId);
    this.guestActors.get(guestId)?.stop();
    this.guestActors.delete(guestId);
    this.walkthrough?.remove(guestId);
    this.virtualLocation?.forget(guestId);
    this.director.dropGuest(guestId);
    this.append({ type: 'guest.left', guestId, roomId: occupied });
    this.notifyChange();
    return true;
  }

  getGuestByToken(token) {
    const guestId = this.tokens.get(token);
    return guestId ? this.guests.get(guestId) ?? null : null;
  }

  getGuestRoomId(token) {
    return this.getGuestByToken(token)?.roomId ?? null;
  }

  getRoomMemberTokens(roomId) {
    const out = [];
    for (const p of this.guests.values()) {
      if (p.roomId === roomId && p.connected && p.occupancy === 'inside') out.push(p.token);
    }
    return out;
  }

  setVirtualPosition(guestIdOrToken, x, y) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    if (!guestId || !this.virtualLocation || !this.running) return false;
    this.virtualLocation.setPosition(guestId, x, y);
    // Movement inside a room commits nothing, so it would otherwise reach the
    // panel only on the periodic roster — dots teleporting every two seconds.
    // This is a separate, deliberately tiny notification: the full roster
    // carries every guest's visit history and is far too heavy to push at
    // motion rates.
    this.io.onPositionChange?.(guestId);
    return true;
  }

  /** Just enough to move the dots — see `onPositionChange`. */
  getPositionsSnapshot() {
    return [...this.guests.values()].map((g) => ({
      guestId: g.guestId,
      position: this.displayPosition(g.guestId),
      roomId: g.roomId,
      occupancy: g.occupancy,
      // A confirmation in flight. It lives for `entryConfirmMs`, so it would be
      // missed entirely on the periodic roster — and it is precisely the gap
      // between "the dot is inside" and "the room reacted".
      pending: this.coordinator?.getSnapshot().occupancy[g.guestId]?.pending ?? null,
      now: this.now(),
    }));
  }

  getVirtualPosition(guestIdOrToken) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    return guestId ? this.virtualLocation?.getPosition(guestId) ?? null : null;
  }

  /**
   * This guest's own spot inside a room — evenly spaced from everyone else's.
   *
   * One layout used by both the simulated walkers (who walk to it) and the
   * display fallback (for guests located without coordinates), so a crowd is
   * spaced the same way however its members got there.
   */
  standingSpot(roomId, guestId) {
    const room = this.def?.rooms?.[roomId];
    if (!room) return null;
    return roomStandingSpot(room, slotForGuest([...this.guests.keys()], guestId));
  }

  /**
   * Where to draw this guest: their floor-plan point if they have one, else
   * their standing spot in the room they occupy. A BLE guest has a room but no
   * coordinates, and everyone in that room would otherwise stack on the centre.
   */
  displayPosition(guestId) {
    const virtual = this.virtualLocation?.getPosition(guestId);
    if (virtual) return { ...virtual, source: 'virtual' };
    const roomId = this.guests.get(guestId)?.roomId;
    if (!roomId) return null;
    const spot = this.standingSpot(roomId, guestId);
    return spot ? { x: spot[0], y: spot[1], source: 'room' } : null;
  }

  /** Geometry the floor plan needs: declared extent if any, else computed. */
  floorPlan() {
    if (!this.def) return null;
    const declared = this.def.floorplan ?? {};
    const extent = floorPlanExtent(this.def.rooms);
    return {
      image: declared.image ?? null,
      width: declared.width ?? null,
      height: declared.height ?? null,
      extent,
    };
  }

  /** Test-mode time scaling (see ScaledClock). 0 pauses, 1 is real time. */
  setTimeScale(rate) {
    if (typeof this.clock.setRate !== 'function') return null;
    this.clock.setRate(rate);
    this.append({ type: 'show.timeScale', rate: this.clock.rate });
    this.notifyChange();
    return this.clock.rate;
  }

  timeScale() {
    return typeof this.clock.rate === 'number' ? this.clock.rate : 1;
  }

  /**
   * Activate a room the way a guest walking in would, on behalf of somebody
   * actually standing there.
   *
   * The raw ACTIVATE event bypasses eligibility and the lock, which leaves the
   * room running for nobody and refusing everyone. This goes through the same
   * path an arrival takes, so the room ends up genuinely someone's.
   *
   * Picks the longest-present eligible occupant — the same ordering lock
   * succession and `whenAvailable` use, so "who gets the room" is answered one
   * way across the system.
   */
  activateForOccupant(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: 'unknown' };
    const next = room.holderCandidates()
      .sort((a, b) => (a.sinceTs ?? 0) - (b.sinceTs ?? 0))[0];
    if (!next) return { ok: false, reason: 'nobodyEligibleInside' };
    const outcome = this.guestActors.get(next.guestId)?.enterRoom(roomId);
    if (outcome) this.logEntryOutcome(next.guestId, outcome);
    this.notifyChange();
    return { ok: true, guestId: next.guestId, outcome };
  }

  /** Send an event straight into a room machine — operator override. */
  sendRoomEvent(roomId, event) {
    const room = this.rooms.get(roomId);
    if (!room || !event) return false;
    const ok = room.send(event);
    if (ok) this.append({ type: 'room.operatorEvent', roomId, event: String(event) });
    this.notifyChange();
    return ok;
  }

  /** Operator placement — bypasses floor-plan geometry, not hysteresis. */
  setVirtualOccupancy(guestIdOrToken, roomId, occupancy) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    if (!guestId || !this.virtualLocation || !this.running) return false;
    if (roomId && !this.rooms.has(roomId)) return false;
    if (!OCCUPANCY_STATES.includes(occupancy)) return false;
    this.virtualLocation.setOccupancy(guestId, roomId, occupancy);
    return true;
  }

  /**
   * User-actor seam (A3). A2 exposes this so activation can be tested
   * without putting eligibility in handleOccupancyCommitted.
   */
  requestActivation(guestIdOrToken, roomId) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    const room = this.rooms.get(roomId);
    if (!guestId || !room || !this.running) {
      return { ok: false, reason: 'unknown' };
    }
    // The guest's own history rides along, so the room can present a revisit
    // variant without ever learning who they are (§3.6).
    const guest = this.guests.get(guestId);
    const history = guest?.visitHistory[roomId];
    const result = room.requestActivation(guestId, {
      seen: history?.seen,
      completed: history?.completed,
      activatedByMe: history?.activatedByMe,
    });
    if (result.ok) guest?.recordActivation(roomId);
    this.notifyChange();
    return result;
  }

  /** Release goes through the room actor so the lock and the machine stay in step. */
  releaseRoomLock(roomId, guestId = null) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const result = room.release(guestId);
    this.notifyChange();
    return result.ok;
  }

  /** Test / scripted-walkthrough helper — advance the show clock. */
  testAdvanceTime(ms) {
    if (typeof this.clock.advance !== 'function') {
      throw new Error('testAdvanceTime requires a ManualClock');
    }
    // Step in tick-sized chunks rather than one jump. A move between rooms
    // takes two commits — you leave one before entering the next — and a single
    // processTime only ever completes the first, which makes tests quietly
    // measure half a transition.
    let remaining = ms;
    do {
      const step = Math.min(TICK_MS, remaining);
      this.clock.advance(step);
      this.coordinator?.processTime(this.now());
      remaining -= step;
    } while (remaining > 0);
  }

  /** @param {import('./coordinator.js').ZoneOccupancyEvent} event */
  handleOccupancyCommitted(event) {
    this.append(event);
    this.guests.get(event.guestId)?.applyOccupancy(event);
    // Rooms react first — a departure has to settle the room they left before
    // the guest actor decides anything about the room they entered.
    this.fanoutSpatialEvent(event);
    // Then the guest decides. Walking in is the trigger; there is nothing to
    // press. An ineligible entry resolves entirely here and the room, which
    // already saw the same event, is untouched by it (§3.4).
    const outcome = this.guestActors.get(event.guestId)?.handleOccupancy(event);
    if (outcome) this.logEntryOutcome(event.guestId, outcome);
    this.io.onOccupancy?.(event);
    this.notifyChange();
  }

  /**
   * A room reset with eligible guests still inside and asked for it to play.
   * Offer it to the longest-present of them — the same ordering lock
   * succession uses, so "who gets it" is answered one way across the system.
   */
  handleRoomAvailable(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const next = room.holderCandidates()
      .sort((a, b) => (a.sinceTs ?? 0) - (b.sinceTs ?? 0))[0];
    if (!next) return;
    const outcome = this.guestActors.get(next.guestId)?.enterRoom(roomId);
    if (outcome) this.logEntryOutcome(next.guestId, outcome);
    this.notifyChange();
  }

  /** @param {string[]} from @param {string} strategy */
  nextPath(from, strategy = 'roundRobin') {
    const options = from.filter((id) => this.def?.paths?.[id]);
    if (!options.length) return null;
    if (strategy === 'random') return options[Math.floor(Math.random() * options.length)];
    return options[this._pathAssignIndex++ % options.length];
  }

  /** The room changed hands; the guest who inherited it must stop saying "refused". */
  handleLockTransferred(roomId, fromGuestId, toGuestId) {
    this.guestActors.get(toGuestId)?.inheritRoom(roomId);
    const from = this.guests.get(fromGuestId)?.label ?? fromGuestId;
    const to = this.guests.get(toGuestId)?.label ?? toGuestId;
    this.io.log?.(`${this.def?.rooms?.[roomId]?.name ?? roomId}: ${from} left → now ${to}'s`);
    this.notifyChange();
  }

  logEntryOutcome(guestId, outcome) {
    const label = this.guests.get(guestId)?.label ?? guestId;
    const room = this.def?.rooms?.[outcome.roomId]?.name ?? outcome.roomId;
    if (outcome.outcome === 'activated') this.io.log?.(`${label} activated ${room}`);
    else if (outcome.outcome === 'ineligible') {
      this.io.log?.(`${label} entered ${room} — not on their path (${outcome.policy})`);
    } else if (outcome.outcome === 'refused') {
      this.io.log?.(`${label} could not activate ${room}: ${outcome.reason}`);
    }
  }

  /** Activation on behalf of a guest actor — eligibility has already passed. */
  activateFor(guestId, roomId, context) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: 'unknown' };
    const result = room.requestActivation(guestId, context);
    if (result.ok) this.guests.get(guestId)?.recordActivation(roomId);
    return result;
  }

  /** Notify room actors independently. Does not request activation. */
  fanoutSpatialEvent(event) {
    const ids = new Set([event.roomId, event.previousRoomId].filter(Boolean));
    for (const roomId of ids) {
      this.rooms.get(roomId)?.handleSpatialEvent(event);
    }
  }

  handleRoomSeen({ guestId, roomId, dwellMs, at }) {
    const p = this.guests.get(guestId);
    if (!p) return;
    p.recordSeen({ roomId, dwellMs, at });
    this.append({ type: 'room.seen', guestId, roomId, dwellMs });
    this.notifyChange();
  }

  /**
   * The single write path for the event log (§12). Stamps on the show clock so
   * a replayed log carries replayed time.
   */
  append(event) {
    const entry = { ...event, at: event.timestamp ?? this.now() };
    this.eventLog.push(entry);
    if (this.eventLog.length > EVENT_LOG_CAP) this.eventLog.shift();
    this.io.onEvent?.(entry);
    return entry;
  }

  emitRoomOutput(intent) {
    const entry = { ...intent, at: this.now() };
    this.outputLog.push(entry);
    if (this.outputLog.length > OUTPUT_LOG_CAP) this.outputLog.shift();
    this.notifyChange();
    return entry;
  }

  resolveGuestId(guestIdOrToken) {
    if (this.guests.has(guestIdOrToken)) return guestIdOrToken;
    return this.tokens.get(guestIdOrToken) ?? null;
  }

  setGuestConnected(guestId, connected) {
    const p = this.guests.get(guestId);
    if (!p) return;
    p.connected = connected;
    this.coordinator?.setConnected(guestId, connected);
    if (connected) this.coordinator?.touchLocation(guestId);
  }

  rosterInfo() {
    return {
      loaded: !!this.def,
      running: this.running,
      contractVersion: 3,
      showId: this.def?.showId ?? null,
      name: this.def?.name ?? null,
      roomCount: this.rooms.size,
      guestCount: this.guests.size,
      pathIds: Object.keys(this.def?.paths ?? {}),
      // Full definitions, not just ids: the panel needs the ordered route to
      // show where a guest is being led and how far along they are.
      paths: this.def?.paths ?? {},
      globals: { ...this.globals },
    };
  }

  /** Flattened zone geometry for the operator floor plan, tagged by room. */
  getZonesForFloorPlan() {
    const zones = {};
    for (const [roomId, room] of Object.entries(this.def?.rooms ?? {})) {
      for (const [zoneId, zone] of Object.entries(room.zones ?? {})) {
        zones[zoneId] = {
          roomId,
          roomName: this.rooms.get(roomId)?.name ?? roomId,
          polygon: zone.polygon ?? [],
          label: zone.label ?? null,
        };
      }
    }
    return zones;
  }

  getRoomsRoster() {
    return [...this.rooms.values()].map((r) => r.snapshot());
  }

  getGuestsRoster() {
    return [...this.guests.values()].map((g) => ({
      ...g.snapshot(),
      ...(this.guestActors.get(g.guestId)?.snapshot() ?? {}),
      // What their phone is playing, so the panel can answer "what is this
      // person actually experiencing" without anyone holding the phone.
      cues: this.cueSnapshot(g.guestId),
      position: this.displayPosition(g.guestId),
      walking: this.walkthrough?.walkers.has(g.guestId) ?? false,
      intent: this.walkthrough?.intent(g.guestId) ?? null,
    }));
  }

  getCoordinatorSnapshot() {
    return this.coordinator?.getSnapshot() ?? { occupancy: {}, byRoom: {}, locks: {} };
  }

  /**
   * Everything a guest should be hearing right now, per slot.
   *
   * Computed from live state every time rather than remembered, so a guest who
   * walks into a running room, is promoted from spectator to participant, or
   * reconnects a dead phone all converge on the right audio without any of
   * those being a case handled here. See cue-director.js.
   *
   * @returns {Map<string, object|null>}
   */
  desiredCues(guestId) {
    const desired = new Map(CUE_SLOTS.map((slot) => [slot, null]));
    const actor = this.guestActors.get(guestId);
    if (!actor || !this.running || !this.def) return desired;

    /** slot → the resolved declaration behind it, before it is split. */
    const resolved = { room: null, guidance: null, adherence: null };

    const here = actor.currentRoom();
    if (here) {
      const room = this.rooms.get(here.roomId);
      const def = this.def.rooms?.[here.roomId];
      if (room && def) {
        resolved.room = roomCueFor(def, room.state, here.standing, room.stateSince);
      }
    }
    const regions = actor.regions();
    for (const region of AUTHORED_GUEST_REGIONS) {
      resolved[region] = guestCueFor(this.def, region, regions[region], actor.regionSince(region));
    }

    for (const slot of AUDIO_CUE_SLOTS) desired.set(slot, audioPart(resolved[slot]));

    // A phone has one screen, so the sources compete for it rather than mixing.
    // Guidance wins: when the tour is talking directly to a guest — the
    // calibration sequence, an instruction — it is addressing them, and the room
    // they happen to be standing in should not talk over it. Adherence sits
    // between the two because it is also about this guest and not the space.
    desired.set(
      SCREEN_CUE_SLOT,
      screenPart(resolved.guidance) ?? screenPart(resolved.adherence) ?? screenPart(resolved.room),
    );
    return desired;
  }

  /**
   * A gesture on a phone, on its way to becoming a show event.
   *
   * The phone reports what the finger did and nothing more. What a tap *means*
   * is `inputBindings` in the show — so the calibration sequence can ask for a
   * tap, and a later room can ask for the same tap and get a different event,
   * without either the client or this runtime learning why.
   *
   * @param {string} guestId
   * @param {string} input — one of INPUT_KINDS
   * @returns {boolean} whether the input was bound to anything
   */
  guestInput(guestId, input) {
    const actor = this.guestActors.get(guestId);
    if (!actor || !this.running) return false;
    const event = this.def?.inputBindings?.[input];
    if (!event) return false;
    actor.send(event);
    this.notifyChange();
    return true;
  }

  /** Bring every phone in line with the world. Sends nothing when nothing differs. */
  reconcileCues() {
    for (const guestId of this.guestActors.keys()) {
      this.director.reconcile(guestId, this.desiredCues(guestId));
    }
  }

  /**
   * A phone that just reconnected came back silent with no memory of what it was
   * playing, so the director must forget too before it can resend.
   */
  resyncCues(guestId) {
    this.director.resetGuest(guestId);
    this.director.reconcile(guestId, this.desiredCues(guestId));
  }

  /** What each phone is currently playing, for the operator panel. */
  cueSnapshot(guestId) {
    return this.director.snapshot(guestId);
  }

  /**
   * Single funnel for "the world moved". Audio reconciles before observers are
   * told, so the panel and the phones never disagree about what is playing.
   */
  notifyChange() {
    this.reconcileCues();
    this.io.onStateChange?.();
  }

  getOperatorSnapshot() {
    return {
      show: this.rosterInfo(),
      rooms: this.getRoomsRoster(),
      guests: this.getGuestsRoster(),
      coordinator: this.getCoordinatorSnapshot(),
      zones: this.getZonesForFloorPlan(),
      floorPlan: this.floorPlan(),
      timeScale: this.timeScale(),
      /**
       * The show clock, for the panel to display and extrapolate between
       * pushes: `now + (Date.now() - receivedAt) * rate`.
       */
      clock: {
        now: this.now(),
        startedAt: this.startedAt,
        elapsedMs: this.startedAt == null ? null : this.now() - this.startedAt,
        rate: this.timeScale(),
      },
      walkthrough: this.walkthrough?.status() ?? null,
      recentEvents: this.eventLog.slice(-30),
      outputLog: this.outputLog.slice(-50),
    };
  }
}

/** Path rotation is show-wide, so it lives here rather than on any one guest. */
