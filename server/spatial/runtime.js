import { randomUUID } from 'node:crypto';
import { validateShowDefinition } from './validate.js';
import { OccupancyCoordinator } from './coordinator.js';
import { VirtualLocationAdapter } from './virtual-location.js';
import { RoomActor } from './room-actor.js';
import {
  CueDirector, roomCueFor, roomBgFor, guestCueFor, guestBgFor, audioPart, screenPart,
} from './cue-director.js';
import { Guest } from './guest.js';
import { GuestActor } from './guest-actor.js';
import { buildGuestMachine } from './guest-machine.js';
import { expandSequences } from './sequence.js';
import { WalkthroughDriver } from './walkthrough.js';
import { roomStandingSpot, slotForGuest, floorPlanExtent } from './zone-math.js';
import { MuseumLayer } from './museum.js';
import { systemClock } from './clock.js';
import {
  OCCUPANCY_STATES, CUE_SLOTS, AUDIO_CUE_SLOTS, SCREEN_CUE_SLOT, EXPERIENCE_CUE_SLOT,
  AUTHORED_GUEST_REGIONS, DRIVER_HUES, audioTiming, enteredEvent,
} from './contract.js';
import { ExperienceLink } from './experience-link.js';

/**
 * Standings that get to drive a room's experience. A spectator watches somebody
 * else's hand; a guest the room is not running for is not in it at all.
 */
const DRIVING_STANDINGS = ['holder', 'participant', 'present'];

/**
 * Coordinator wake-up granularity. A pending entry/exit confirmation can only
 * commit on a tick, so this is added latency on top of the configured confirm
 * hold — at 250ms it was a visible quarter-second of "why has nothing happened".
 */
const TICK_MS = 100;
const EVENT_LOG_CAP = 500;
const OUTPUT_LOG_CAP = 200;

/**
 * A layer as authored: a file name, or `{ audio, gain }`. Null for anything
 * else, which the validator will already have complained about.
 */
function layerDeclaration(value) {
  if (typeof value === 'string' && value) return { audio: value };
  if (value && typeof value === 'object' && typeof value.audio === 'string' && value.audio) {
    return {
      audio: value.audio,
      ...(value.gain != null ? { gain: value.gain } : {}),
      // Its own fade in and out, instead of the show's audioLayers.crossfadeMs.
      ...(value.crossfadeMs != null ? { crossfadeMs: value.crossfadeMs } : {}),
    };
  }
  return null;
}

/**
 * Spatial show runtime — v0.3 Phase A.
 * A1: occupancy coordinator + virtual location.
 * A2: room actors, activation, lock coherence.
 * A4: exit policies, grace timers, resume.
 * Guest actors wired in A3 (see guest.js).
 */
export class SpatialRuntime {
  /** @param {{ log?: (line: string) => void, onStateChange?: () => void, onOccupancy?: (event: object) => void, onEvent?: (event: object) => void, clock?: object, enableTick?: boolean, openExperienceSocket?: (url: string) => object }} io */
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
    /** roomId → ExperienceLink, for rooms that hand their interaction to a piece. */
    this.experiences = new Map();
    /** roomId → guestId → { driverId, hue, secret } — stable while they stay. */
    this._drivers = new Map();
    /** roomId → last presentation state seen, so a reset can be spotted once. */
    this._roomStateWas = new Map();
    /** guestId → { key, handle }: a gesture waiting for its step's clip to end (playThrough). */
    this._heldGestures = new Map();
    /** guestId → { at, handle }: when the guest's next gesture unlocks, to re-cue then. */
    this._unlockWakes = new Map();
    /** guestId → sequences they have stepped through, for what they have been taught. */
    this._sequencesSeen = new Map();
    /** Clips whose length could not be read, warned about once each. */
    this._unmeasuredClips = new Set();
    /** guestId → { roomId, key, side }: which half of a piece's screen is theirs (`sides`), as of which step. */
    this._sides = new Map();
    /**
     * guestId → the doorway their phone hears (§4.2c):
     * { thresholdId, roomId, since, entered }. `entered` once they have stood
     * there `location.doorDwellMs` — from then the door holds them in its room.
     */
    this.atThreshold = new Map();
    /**
     * guestId → the room beacon (major) their phone last reported, kept while a
     * door holds them elsewhere so that leaving the door lands them there.
     */
    this.lastRoomBeacon = new Map();
    /**
     * guestId → a beacon report held because it jumps further than a person
     * walks between reports: { roomId, zoneId, fromRoomId, steps, dueAt }.
     */
    this.beaconHolds = new Map();
    /**
     * guestId → the furthest `stage` they have reached, and the last room they
     * were inside — where a phone that lost contact is still judged from. The
     * way through the building (`rooms.*.stage`): no going back, no jumping on.
     */
    this.furthestStage = new Map();
    this.lastRoom = new Map();
    /** guestId → the room last refused, so a flicker is logged once. */
    this.lastRefused = new Map();
    /**
     * Guests an operator has placed by hand, whose phone's next reading is
     * believed wherever it is — a fresh start, as for a phone's first fix. A
     * placement can be wrong about where the phone really is, and judging the
     * phone from it would strand the guest (2026-09-26).
     */
    this.trustNextReading = new Set();
    /**
     * guestId → { bg: { audio, gain, since } | null, bed: since | null } — when
     * each layer began for them. A layer's startAt has to hold still while it
     * plays, or the director would restart it: the same bg carried into the
     * next room is the same cue.
     */
    this.layerSince = new Map();
    /**
     * guestId → roomId → { arrivedAt, state, startAt, played }, for rooms
     * whose clip picks up where the guest left it (`audio.resume`): when this
     * stay's clip began, and — per room state, since a room that emptied is
     * idle for a moment as they walk back in — how far into each state's clip
     * they were when they last left.
     */
    this.roomResume = new Map();
    /** Injected so tests drive a link without a socket; see experience-link.js. */
    this.openExperienceSocket = io.openExperienceSocket ?? null;
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
    this.atThreshold.clear();
    this.lastRoomBeacon.clear();
    this.furthestStage.clear();
    this.lastRoom.clear();
    this.lastRefused.clear();
    this.trustNextReading.clear();

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

    // The museum layer: each guest's relationship with the DIM rooms.
    // Prototyped in /sim/; the rules live in museum.js.
    this.museum = this.def.museum
      ? new MuseumLayer(this.def.museum, {
        now: () => this.now(),
        assetSeconds: (asset) => this.io.assetSeconds?.(asset) ?? null,
        activate: (guestId, roomId) => this.requestActivation(guestId, roomId),
        // A stand-down, not a hand-off: drop the lock first so nothing
        // transfers it to a bystander, then send the machine home.
        release: (roomId) => {
          this.releaseRoomLock(roomId, null);
          this.sendRoomEvent(roomId, 'RELEASE');
        },
        roomInfo: (roomId) => ({
          count: this.coordinator?.getRoomOccupants(roomId).length ?? 0,
          max: this.def.rooms?.[roomId]?.multiGuest?.maxOccupants ?? null,
          active: String(this.rooms.get(roomId)?.state ?? 'idle').split('.')[0] === 'active',
        }),
        occupantIds: (roomId) =>
          (this.coordinator?.getRoomOccupants(roomId) ?? []).map((o) => o.guestId),
        log: (line) => this.io.log?.(line),
      })
      : null;

    for (const link of this.experiences.values()) link.stop();
    this.experiences.clear();
    this._drivers.clear();
    this._roomStateWas.clear();
    for (const [roomId, room] of Object.entries(this.def.rooms ?? {})) {
      // Declared but not installed here: a rehearsal laptop runs one or two
      // pieces and the rest of the building is ordinary rooms. Nothing to reach,
      // so nothing to reach for.
      if (!room.experience?.endpoint) continue;
      this.experiences.set(roomId, new ExperienceLink({
        roomId,
        config: room.experience,
        clock: this.clock,
        openSocket: this.openExperienceSocket,
        onChange: () => this.io.onStateChange?.(),
        onEvent: (id, name) => this.roomEventFromExperience(id, name),
      }));
    }
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
    // The wall in a room may already be running, may be off, may come up in an
    // hour. None of that is this call's problem — the link keeps trying and the
    // show never waits on it.
    for (const link of this.experiences.values()) link.start();
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
    this.atThreshold.clear();
    this.lastRoomBeacon.clear();
    this.furthestStage.clear();
    this.lastRoom.clear();
    this.lastRefused.clear();
    this.trustNextReading.clear();
    this.layerSince.clear();
    this.roomResume.clear();
    this.beaconHolds.clear();
    for (const link of this.experiences.values()) link.stop();
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
      this.processBeaconHolds(this.now());
      this.processDoorDwell(this.now());
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

  /**
   * @param {{ label?: string, kind?: 'phone'|'simulated', guestId?: string }} [opts]
   *   `guestId` for a handset that names itself (its Headwind number), so the
   *   same phone is always the same guest; null if that guest already exists.
   */
  spawnGuest({ label, kind, guestId: wanted } = {}) {
    if (!this.def) return null;
    if (wanted && this.guests.has(wanted)) return null;
    const guestId = wanted ?? `u-${randomUUID().slice(0, 8)}`;
    const visitId = `v-${randomUUID().slice(0, 8)}`;
    const token = randomUUID();
    const num = ++this._guestSeq;

    // No path at the door. The journey assigns one when the guest reaches the
    // part of the show that has paths, which is also when there is real
    // occupancy to spread them against.
    const guest = new Guest({
      guestId,
      token,
      label: label ?? `Guest ${num}`,
      visitId,
      pathId: null,
      // A guest issued a handset is one the show can ask things of. A spawned
      // dot is not, and never becomes one.
      kind: kind ?? 'simulated',
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

    this.append({ type: 'guest.joined', guestId, visitId, label: guest.label });
    if (this.running) {
      this.io.log?.(`${guest.label} joined (visit ${visitId})`);
    }
    this.notifyChange();
    return { token, guestId, visitId, label: guest.label };
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
    this.atThreshold.delete(guestId);
    this.lastRoomBeacon.delete(guestId);
    this.beaconHolds.delete(guestId);
    this.furthestStage.delete(guestId);
    this.lastRoom.delete(guestId);
    this.lastRefused.delete(guestId);
    this.trustNextReading.delete(guestId);
    this.layerSince.delete(guestId);
    this.roomResume.delete(guestId);
    this.clock.clearTimeout(this._heldGestures.get(guestId)?.handle);
    this._heldGestures.delete(guestId);
    this.clock.clearTimeout(this._unlockWakes.get(guestId)?.handle);
    this._unlockWakes.delete(guestId);
    this._sequencesSeen.delete(guestId);
    this._sides.delete(guestId);
    // The museum remembers rooms per guestId, and a phone's guestId outlives
    // the visit: left here, a reset handset would come back to its rooms
    // already spent, hearing returns instead of the rooms themselves.
    this.museum?.removeGuest(guestId);
    this.director.dropGuest(guestId);
    this.append({ type: 'guest.left', guestId, visitId: p.visitId, roomId: occupied });
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

  /**
   * A room's piece says something happened in the room (§8.1): the event goes
   * to the room's statechart, and a new state is new clips for everyone inside
   * — each from its top, or together in a `together` room. Only events the
   * room's current state handles move it; anything else is logged and dropped.
   */
  roomEventFromExperience(roomId, name) {
    const room = this.rooms.get(roomId);
    if (!room || !this.running) return false;
    const from = room.state;
    room.send(name);
    const moved = room.state !== from;
    this.append({ type: 'room.experienceEvent', roomId, event: name, from, to: room.state, moved });
    this.io.log?.(moved ? `${roomId} ← ${name} (from its piece): ${from} → ${room.state}` : `${roomId} ← ${name} (from its piece): no change in ${from}`);
    if (moved) this.notifyChange();
    return moved;
  }

  /** Operator placement — bypasses floor-plan geometry, not hysteresis. */
  setVirtualOccupancy(guestIdOrToken, roomId, occupancy) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    if (!guestId || !this.virtualLocation || !this.running) return false;
    if (roomId && !this.rooms.has(roomId)) return false;
    if (!OCCUPANCY_STATES.includes(occupancy)) return false;
    this.virtualLocation.setOccupancy(guestId, roomId, occupancy);
    if (roomId && occupancy === 'inside') this.placedAt(guestId, roomId);
    return true;
  }

  /**
   * A guest's phone hears a room's door, or no door any more (thresholdId
   * null) — §4.2c. Doors play nothing (2026-09-26). Heard for
   * `location.doorDwellMs` (3000), the door enters its room: someone walking
   * past is not there long enough, and someone who really walked in is soon
   * seen by the room's own beacons anyway. From then the door holds them in
   * that room for as long as it is heard; when it goes, the phone's latest room
   * reading says where they are.
   */
  setGuestThreshold(guestIdOrToken, thresholdId) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    if (!guestId || !this.running) return false;
    const was = this.atThreshold.get(guestId) ?? null;
    if (thresholdId == null) {
      if (!was) return true;
      this.atThreshold.delete(guestId);
      this.append({ type: 'guest.threshold', guestId, thresholdId: null, left: was.thresholdId });
      if (was.entered) this.applyRoomReading(guestId);
    } else {
      const found = this.findThreshold(thresholdId);
      if (!found) return false;
      if (was?.thresholdId === thresholdId) return true;
      this.atThreshold.set(guestId, { thresholdId, roomId: found.roomId, since: this.now(), entered: false });
      this.append({ type: 'guest.threshold', guestId, thresholdId, roomId: found.roomId });
      this.processDoorDwell(this.now());
    }
    this.notifyChange();
    return true;
  }

  doorDwellMs() {
    return this.def?.location?.doorDwellMs ?? 3000;
  }

  /** Guests who have stood at a door long enough have entered its room. */
  processDoorDwell(now) {
    if (!this.running || !this.coordinator) return;
    for (const [guestId, at] of this.atThreshold) {
      if (at.entered) continue;
      // The dwell stands in for any hold, but not for the way through: a door
      // behind them, or rooms away, is not a way in. Nor is a door that skips a
      // room they have not reached — a door beacon is heard from the room
      // before it (the Museum Hallway's, from inside the Cyclorama), and only
      // a room's own beacons may skip, on the longer hold.
      const move = this.judgeMove(guestId, at.roomId);
      if (!move.refused && move.steps > 1 && this.stageOf(at.roomId) > (this.furthestStage.get(guestId) ?? 0)) {
        move.refused = 'too far';
      }
      if (move.refused) {
        this.refuseReading(guestId, at.roomId, move);
        // The dwell counts from when it is a way in: reaching the room before
        // it does not let a door already heard pull them straight through.
        at.since = now;
        continue;
      }
      if (now - at.since < this.doorDwellMs()) continue;
      at.entered = true;
      // The dwell is the confirmation; a jump held for this guest is moot.
      this.beaconHolds.delete(guestId);
      const zoneId = Object.keys(this.def.rooms[at.roomId]?.zones ?? {})[0] ?? null;
      this.append({ type: 'guest.doorEntered', guestId, thresholdId: at.thresholdId, roomId: at.roomId });
      this.io.log?.(`${this.guests.get(guestId)?.label ?? guestId}: at ${at.thresholdId} for ${this.doorDwellMs() / 1000}s → ${at.roomId}`);
      this.coordinator.ingestImmediate(guestId, at.roomId, 'inside', 'ble', zoneId);
    }
  }

  /** Off a door that held them: wherever the phone last said. */
  applyRoomReading(guestId) {
    const reading = this.lastRoomBeacon.get(guestId);
    if (typeof reading === 'string' && reading.startsWith('hallway:')) this.setGuestHallway(guestId, reading.slice(8));
    else if (reading != null) this.setGuestBeacon(guestId, reading);
  }

  /**
   * The phone app's beacon reading (dim_android_app): the major of the
   * strongest room group it hears. The phone already smooths, holds through
   * silence and estimates in dead spots (the location rule, 2026-09-25), so
   * this commits at once — no entry hold. A room beacon places the guest; a
   * door beacon or an unknown major places nobody. While a door they have
   * entered by is still heard, it wins: the reading is kept for when it goes.
   *
   * @returns {{ ok: boolean, roomId?: string, reason?: string }}
   */
  setGuestBeacon(guestIdOrToken, major) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    if (!guestId || !this.running || !this.coordinator) return { ok: false, reason: 'not running' };
    const beacon = this.def?.beacons?.[String(major)];
    if (!beacon?.room || !this.rooms.has(beacon.room)) {
      this.warnUnplacedBeacon(major, beacon);
      return { ok: false, reason: beacon?.door ? 'door beacon' : 'unknown beacon' };
    }
    this.lastRoomBeacon.set(guestId, major);
    return this.readRoom(guestId, beacon.room);
  }

  /**
   * The phone placing itself in a hallway that has no beacons of its own
   * (`impliedHallways`): it hears several of the hallway's rooms, none at its
   * threshold. Judged like any reading.
   *
   * @returns {{ ok: boolean, roomId?: string, reason?: string }}
   */
  setGuestHallway(guestIdOrToken, roomId) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    if (!guestId || !this.running || !this.coordinator) return { ok: false, reason: 'not running' };
    if (!this.impliedHallways()[roomId]) return { ok: false, reason: 'not an implied hallway' };
    this.lastRoomBeacon.set(guestId, `hallway:${roomId}`);
    return this.readRoom(guestId, roomId);
  }

  /** A room reading, from a beacon or a hallway, weighed and acted on. */
  readRoom(guestId, roomId) {
    const door = this.atThreshold.get(guestId);
    if (door?.entered && door.roomId !== roomId) {
      this.beaconHolds.delete(guestId);
      return { ok: true, roomId: door.roomId, heldByDoor: door.thresholdId };
    }
    const zoneId = Object.keys(this.def.rooms[roomId]?.zones ?? {})[0] ?? null;

    // Behind them, or too far on: ignored, and any hold already running for a
    // real move keeps running.
    const move = this.judgeMove(guestId, roomId);
    if (move.refused) {
      this.refuseReading(guestId, roomId, move);
      return { ok: false, reason: move.refused, roomId: this.guests.get(guestId)?.roomId ?? null };
    }

    // The same far room said again (the app re-sends on every reconnect)
    // keeps its hold running; anything else replaces it — so a flicker to a
    // far room that the phone takes back before the hold runs out never lands.
    const held = this.beaconHolds.get(guestId);
    if (held?.roomId === roomId) return { ok: true, roomId, heldMs: held.dueAt - this.now() };
    this.beaconHolds.delete(guestId);
    const { from, steps, holdMs } = move;
    if (holdMs > 0) {
      this.beaconHolds.set(guestId, { roomId, zoneId, fromRoomId: from, steps, dueAt: this.now() + holdMs });
      const label = this.guests.get(guestId)?.label ?? guestId;
      const apart = Number.isFinite(steps) ? `${steps} steps apart` : 'not connected';
      this.append({ type: 'guest.unlikelyJump', guestId, fromRoomId: from, roomId, steps: Number.isFinite(steps) ? steps : null, holdMs });
      this.io.log?.(`${label}: ${from} → ${roomId}, ${apart} — holding ${holdMs / 1000}s`);
      return { ok: true, roomId, heldMs: holdMs };
    }
    this.coordinator.ingestImmediate(guestId, roomId, 'inside', 'ble', zoneId);
    return { ok: true, roomId };
  }

  /**
   * Each room's `adjacent`, for the Android app's locator: a room it hears
   * can become the guest's only if it is next door, or across a hallway with
   * no beacons of its own (2026-09-27). Sent to phones with `hallways`.
   *
   * @returns {Record<string, string[]>}
   */
  roomAdjacency() {
    const out = {};
    for (const [id, room] of Object.entries(this.def?.rooms ?? {})) out[id] = [...(room?.adjacent ?? [])];
    return out;
  }

  /**
   * Hallways with no room beacons of their own, and the rooms around them
   * that have some — MAD-DIM's Museum Hallway. A phone that hears two or more
   * of those rooms, none at its threshold, is between them: in the hallway.
   * Sent to phones (`welcome`, `assets`); the phone applies it (2026-09-26).
   *
   * @returns {Record<string, { rooms: string[], minHeard: number }>}
   */
  impliedHallways() {
    const rooms = this.def?.rooms ?? {};
    const beaconed = new Set(Object.values(this.def?.beacons ?? {}).map((b) => b?.room).filter(Boolean));
    const out = {};
    for (const [id, room] of Object.entries(rooms)) {
      if (room?.kind !== 'hallway' || beaconed.has(id)) continue;
      const around = (room.adjacent ?? []).filter((r) => beaconed.has(r));
      if (around.length >= 2) out[id] = { rooms: around, minHeard: 2 };
    }
    return out;
  }

  /**
   * Whether a reading of `toRoomId` may move this guest, and after how long.
   *
   * Judged from the room they are in, or — out of contact — the last room they
   * were in, by the rooms' `adjacent` connections. In a show whose rooms have a
   * `stage` (the order a guest walks the building in):
   *
   * - a room at an earlier stage than the furthest they have reached is
   *   behind them: refused, so no room they have left plays to them again;
   * - more than one room away is refused — nobody crosses two rooms unseen;
   * - next door within the stages they have reached moves them after
   *   `location.sameStageMs` (0: at once; MAD-DIM 3000, so a reading through
   *   a museum room's wall that the phone takes back never lands);
   *   next door into a new stage holds `location.nextStageMs` (3000), as long
   *   as a door takes, because once there they cannot come back;
   * - one room skipped (a dead spot) holds `location.skipAheadMs` (5000) into
   *   a new stage — or is refused, with `location.skipAhead: false`, when the
   *   beacons are noisy enough that a skip is more often a misread than a
   *   dead spot (MAD, 2026-09-26) — and `location.jumpTwoStepsMs` (1500)
   *   within the stages reached, where a hallway with no beacons of its own
   *   always looks like a skip.
   *
   * A room with no stage, or a show with none, keeps the older rule: holds by
   * distance (`jumpHoldMs`), never a refusal. A guest with no room yet moves at
   * once, wherever they are.
   *
   * @returns {{ refused?: 'behind' | 'too far', from: string|null, steps: number, holdMs: number }}
   */
  judgeMove(guestId, toRoomId) {
    // Placed by hand since the phone last spoke: its reading is a fresh start.
    if (this.trustNextReading.has(guestId)) return { from: null, steps: 0, holdMs: 0 };
    const here = this.coordinator.getOccupancy(guestId);
    const from = here?.occupancy === 'inside' ? here.roomId : (this.lastRoom.get(guestId) ?? null);
    const steps = from ? this.stepsBetween(from, toRoomId) : 0;
    const toStage = this.stageOf(toRoomId);
    if (toStage == null) return { from, steps, holdMs: this.jumpHoldMs(steps) };
    const furthest = this.furthestStage.get(guestId) ?? 0;
    if (toStage < furthest) return { refused: 'behind', from, steps, holdMs: 0 };
    if (steps > 2) return { refused: 'too far', from, steps, holdMs: 0 };
    const onward = toStage > furthest;
    const cfg = this.def?.location ?? {};
    let holdMs = 0;
    const sameStageMs = cfg.sameStageMs ?? 0;
    if (steps === 1) holdMs = onward ? (cfg.nextStageMs ?? 3000) : sameStageMs;
    if (steps === 2 && onward && cfg.skipAhead === false) return { refused: 'too far', from, steps, holdMs: 0 };
    if (steps === 2) holdMs = onward ? (cfg.skipAheadMs ?? 5000) : Math.max(cfg.jumpTwoStepsMs ?? 1500, sameStageMs);
    return { from, steps, holdMs };
  }

  /** A room's place in the way through the building, or null. */
  stageOf(roomId) {
    const stage = this.def?.rooms?.[roomId]?.stage;
    return Number.isInteger(stage) ? stage : null;
  }

  /**
   * Which of the companion screen's phases a guest's phone is in
   * (`guest.companion`, 2026-09-27): `intro` — the pulsing DIM — until they
   * reach `introUntil`; `closing` once they reach `closingRoom`; `show` in
   * between. Reached means stood in it, or got to its stage or beyond, so a
   * phone that skipped the room itself still moves on. Null in a show without
   * a companion block.
   *
   * @returns {'intro'|'show'|'closing'|null}
   */
  companionPhase(guestId) {
    const companion = this.def?.guest?.companion;
    if (!companion) return null;
    const here = this.guestActors.get(guestId)?.currentRoom()?.roomId ?? null;
    const furthest = this.furthestStage.get(guestId) ?? 0;
    const reached = (roomId) => {
      if (!roomId) return false;
      if (here === roomId) return true;
      const stage = this.stageOf(roomId);
      return stage != null && furthest >= stage;
    };
    if (reached(companion.closingRoom)) return 'closing';
    if (companion.introUntil && !reached(companion.introUntil)) return 'intro';
    return 'show';
  }

  /** A reading the way through rules out: logged once until it changes. */
  refuseReading(guestId, roomId, move) {
    if (this.lastRefused.get(guestId) === roomId) return;
    this.lastRefused.set(guestId, roomId);
    const label = this.guests.get(guestId)?.label ?? guestId;
    this.append({ type: 'guest.readingRefused', guestId, fromRoomId: move.from, roomId, reason: move.refused });
    this.io.log?.(`${label}: ${roomId} ignored — ${move.refused === 'behind' ? 'behind them' : `${move.steps} rooms from ${move.from}`}`);
  }

  /**
   * How long a beacon report must stand before it is believed, by how far it
   * jumps along the building's connections (`adjacent`). Next door or the same
   * room: at once. One space skipped (a brisk walk through a short hallway with
   * no reading): a short hold. Further, or not connected at all: a long hold —
   * never a refusal, because a phone out of contact can genuinely reappear
   * anywhere, and a guest must not be stranded in the wrong room.
   * Show settings: `location.jumpTwoStepsMs` (1500) and `location.jumpFartherMs` (5000).
   */
  jumpHoldMs(steps) {
    if (steps <= 1) return 0;
    const cfg = this.def?.location ?? {};
    return steps === 2 ? (cfg.jumpTwoStepsMs ?? 1500) : (cfg.jumpFartherMs ?? 5000);
  }

  /** Fewest connections between two spaces (0 for the same one; Infinity if none). */
  stepsBetween(fromRoomId, toRoomId) {
    if (fromRoomId === toRoomId) return 0;
    const rooms = this.def?.rooms ?? {};
    const seen = new Set([fromRoomId]);
    let frontier = [fromRoomId];
    for (let steps = 1; frontier.length; steps++) {
      const next = [];
      for (const id of frontier) {
        for (const n of rooms[id]?.adjacent ?? []) {
          if (n === toRoomId) return steps;
          if (!seen.has(n)) { seen.add(n); next.push(n); }
        }
      }
      frontier = next;
    }
    return Infinity;
  }

  /** Believe held beacon reports whose hold has run out with nothing newer said. */
  processBeaconHolds(now) {
    for (const [guestId, hold] of this.beaconHolds) {
      if (now < hold.dueAt) continue;
      this.beaconHolds.delete(guestId);
      if (!this.running || !this.coordinator) continue;
      this.coordinator.ingestImmediate(guestId, hold.roomId, 'inside', 'ble', hold.zoneId);
      this.io.log?.(`${this.guests.get(guestId)?.label ?? guestId}: ${hold.fromRoomId} → ${hold.roomId} confirmed after the hold`);
    }
  }

  /** A phone at a door beacon (major), or away from any (null) — §4.2c. */
  setGuestDoorBeacon(guestIdOrToken, major) {
    if (major == null) return this.setGuestThreshold(guestIdOrToken, null);
    const beacon = this.def?.beacons?.[String(major)];
    if (!beacon?.door) {
      this.warnUnplacedBeacon(major, beacon);
      return false;
    }
    return this.setGuestThreshold(guestIdOrToken, beacon.door);
  }

  /**
   * Beacon and door edits from the zone editor, applied to the running show
   * (the server then sends phones the new list). `beacons` undefined leaves
   * them as they are; `doors` is roomId → that room's thresholds, or null;
   * `phone` (`location.phone`, how the app chooses a room) likewise, when
   * not undefined.
   * Where guests are is untouched: a door they stand at that no longer
   * exists simply stops being one on their next reading.
   */
  applyLocationEdits(beacons, doors = {}, phone = undefined) {
    if (!this.def) return false;
    if (phone !== undefined) {
      this.def.location ??= {};
      if (phone) this.def.location.phone = phone;
      else delete this.def.location.phone;
    }
    if (beacons !== undefined) {
      if (beacons) this.def.beacons = beacons;
      else delete this.def.beacons;
    }
    for (const [roomId, thresholds] of Object.entries(doors)) {
      const room = this.def.rooms?.[roomId];
      if (!room) continue;
      if (thresholds && Object.keys(thresholds).length) room.thresholds = thresholds;
      else delete room.thresholds;
    }
    this._warnedBeacons?.clear();
    this.append({ type: 'show.locationEdited' });
    this.io.log?.('beacons and doors updated from the zone editor — live');
    this.notifyChange();
    return true;
  }

  /** A phone began playing a clip — for the museum's "had it" clock. */
  clipPlaying(guestIdOrToken, assetId, at) {
    const guestId = this.resolveGuestId(guestIdOrToken);
    if (!guestId || typeof assetId !== 'string') return;
    this.museum?.clipPlaying(guestId, assetId, typeof at === 'number' ? at : null);
  }

  /** Once per major: a beacon the show cannot place is an install fault to fix. */
  warnUnplacedBeacon(major, beacon) {
    this._warnedBeacons ??= new Set();
    const key = String(major);
    if (this._warnedBeacons.has(key)) return;
    this._warnedBeacons.add(key);
    this.io.log?.(beacon
      ? `beacon ${key} is reported but is not assigned to a room or door in the show`
      : `beacon ${key} is reported but is not in the show's beacons`);
  }

  /** A threshold by id, with the room it leads into. */
  findThreshold(thresholdId) {
    for (const [roomId, room] of Object.entries(this.def?.rooms ?? {})) {
      const def = room?.thresholds?.[thresholdId];
      if (def) return { roomId, def };
    }
    return null;
  }

  /** Every threshold in the show, for the panel's doorway picker. */
  thresholdChoices() {
    const out = [];
    for (const [roomId, room] of Object.entries(this.def?.rooms ?? {})) {
      for (const thresholdId of Object.keys(room?.thresholds ?? {})) {
        out.push({ thresholdId, roomId, roomName: this.rooms.get(roomId)?.name ?? roomId });
      }
    }
    return out;
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
      this.processBeaconHolds(this.now());
      this.processDoorDwell(this.now());
      remaining -= step;
    } while (remaining > 0);
  }

  /** @param {import('./coordinator.js').ZoneOccupancyEvent} event */
  handleOccupancyCommitted(event) {
    this.append(event);
    // A placement by hand says where the guest is now, not how far through
    // the building they have come: only the phone's own readings count.
    if (event.source === 'ble') this.trustNextReading.delete(event.guestId);
    if (event.occupancy === 'inside' && event.roomId && !this.trustNextReading.has(event.guestId)) {
      this.lastRoom.set(event.guestId, event.roomId);
      this.lastRefused.delete(event.guestId);
      const stage = this.stageOf(event.roomId);
      if (stage != null && stage > (this.furthestStage.get(event.guestId) ?? 0)) {
        this.furthestStage.set(event.guestId, stage);
      }
    }
    // Leaving a room whose clip resumes: remember how far into it they were.
    if (event.previousRoomId && event.previousRoomId !== event.roomId) {
      const left = this.roomResume.get(event.guestId)?.get(event.previousRoomId);
      if (left) left.played[left.state] = Math.max(0, event.timestamp - left.startAt);
    }
    this.guests.get(event.guestId)?.applyOccupancy(event);
    // Rooms react first — a departure has to settle the room they left before
    // the guest actor decides anything about the room they entered.
    this.fanoutSpatialEvent(event);
    // Then the guest decides. Walking in is the trigger; there is nothing to
    // press. An ineligible entry resolves entirely here and the room, which
    // already saw the same event, is untouched by it (§3.4).
    const outcome = this.guestActors.get(event.guestId)?.handleOccupancy(event);
    if (outcome) this.logEntryOutcome(event.guestId, outcome);
    if (this.running) this.museum?.handleOccupancy(event);
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
    // The museum layer owns who wakes a DIM room. A return, a spent guest —
    // the room is dead to them, and walking in must not resurrect it.
    if (this.museum && !this.museum.wouldEngage(guestId, roomId)) {
      return { ok: false, reason: 'museumDeclined' };
    }
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
      // For the panel's Send to picker.
      rooms: this.roomChoices(),
      thresholds: this.thresholdChoices(),
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
      // What the show is holding this guest for, and whether anyone is there to
      // provide it — the pair of facts that explains a guest who has stopped.
      pendingInputs: this.pendingInputs(g.guestId),
      kind: g.kind,
      position: this.displayPosition(g.guestId),
      museum: this.museum?.snapshot(g.guestId) ?? null,
      way: this.wayThrough(g.guestId),
      walking: this.walkthrough?.walkers.has(g.guestId) ?? false,
      threshold: this.atThreshold.get(g.guestId)?.thresholdId ?? null,
      intent: this.walkthrough?.intent(g.guestId) ?? null,
    }));
  }

  /**
   * Where a guest stands on the way through the building (`rooms.*.stage`),
   * for the panel: the answer to "why is this person stuck?". Null in a show
   * with no stages.
   */
  wayThrough(guestId) {
    const staged = Object.values(this.def?.rooms ?? {}).some((r) => Number.isInteger(r?.stage));
    if (!staged) return null;
    const refused = this.lastRefused.get(guestId) ?? null;
    const lastRefusal = refused
      ? [...this.eventLog].reverse().find((e) => e.type === 'guest.readingRefused' && e.guestId === guestId && e.roomId === refused)
      : null;
    return {
      furthestStage: this.furthestStage.get(guestId) ?? null,
      lastRoom: this.lastRoom.get(guestId) ?? null,
      trustNextReading: this.trustNextReading.has(guestId),
      ignoring: refused ? { roomId: refused, reason: lastRefusal?.reason ?? null, at: lastRefusal?.at ?? null } : null,
    };
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
    /** The room state's own bg, and — in a room on one timeline — when it began. */
    let roomBg = null;

    const here = actor.currentRoom();
    if (here) {
      const room = this.rooms.get(here.roomId);
      const def = this.def.rooms?.[here.roomId];
      if (room && def) {
        // `audio.timing` decides whose clock the room's cues run on (§8.1).
        // own (the default): this guest's arrival, so each visitor hears the
        // clip from its top; a guest already inside when the state changed
        // starts at the change, hence the max. together: the state's own
        // timestamp, one moment for everyone in the room, joined partway
        // through by anyone who arrives late.
        const arrived = this.coordinator?.getRoomOccupants(here.roomId)
          .find((o) => o.guestId === guestId)?.sinceTs;
        const startAt = audioTiming(def) === 'together'
          ? room.stateSince
          : this.resumedStart(guestId, here.roomId, def, room, arrived,
            Math.max(arrived ?? room.stateSince, room.stateSince));
        resolved.room = roomCueFor(def, room.state, here.standing, startAt);
        const stateBg = roomBgFor(def, room.state);
        if (stateBg != null) {
          roomBg = { bg: stateBg, since: audioTiming(def) === 'together' ? room.stateSince : null };
        }
      }
    }
    const regions = actor.regions();
    for (const region of AUTHORED_GUEST_REGIONS) {
      resolved[region] = guestCueFor(this.def, region, regions[region], actor.regionSince(region));
    }

    for (const slot of AUDIO_CUE_SLOTS) desired.set(slot, audioPart(resolved[slot]));

    // The museum layer speaks through the same two slots the authored show
    // uses: `room` for the in_room bed, `guidance` for the spoken line. Where
    // it has something to say — or deliberate silence, in a dead room — it
    // wins over the authored cues; everywhere else the show is untouched.
    const museum = this.museum?.guestCues(guestId, here?.roomId ?? null);
    if (museum) {
      desired.set('room', museum.room ? audioPart(museum.room) : null);
      if (museum.guidance) desired.set('guidance', audioPart(museum.guidance));
    }

    const layers = this.layersFor(guestId, here?.roomId ?? null, guestBgFor(this.def, regions), roomBg);
    desired.set('bg', layers.bg);
    desired.set('bed', layers.bed);

    desired.set(EXPERIENCE_CUE_SLOT, this.experienceCueFor(guestId, here));

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
   * When a room's clip began for this guest, for a room with `audio.resume`:
   * coming back in during the same visit picks the clip up where they left
   * it, rather than from the top (the Cyclorama, 2026-09-30). The phone joins
   * a clip partway when its start is in the past, so resuming is only a
   * matter of backdating the start by what they had already heard. A clip
   * they heard to the end stays finished. The room moving to a new state
   * while they are in it starts that state's clip afresh, as ever.
   */
  resumedStart(guestId, roomId, def, room, arrived, fresh) {
    if (!def.audio?.resume || arrived == null) return fresh;
    let rooms = this.roomResume.get(guestId);
    if (!rooms) this.roomResume.set(guestId, (rooms = new Map()));
    const was = rooms.get(roomId);
    if (was && was.arrivedAt === arrived && was.state === room.state) return was.startAt;
    const played = was?.played ?? {};
    const startAt = played[room.state] != null ? fresh - played[room.state] : fresh;
    rooms.set(roomId, { arrivedAt: arrived, state: room.state, startAt, played });
    return startAt;
  }

  /**
   * The two layers under the voices, for a guest standing in `roomId`.
   *
   * bg is the guest's own state's if it names one (a calibration step), else
   * the room state's (`rooms.<id>.cues[state].bg`, `roomBg`), else the room's
   * (`rooms.<id>.bg`). A room state's bg in a room on one timeline starts at
   * the state's own moment, so everyone inside hears it together. Moving on to the same one carries it on
   * unbroken; a room with none fades it out. Standing in no room at all —
   * between zones, or a phone out of contact — keeps whatever was playing,
   * because that is a gap in the sensing and not a place.
   *
   * The bed (`guest.bed`) begins the first time they stand in its `from` room
   * and runs under everything after.
   */
  layersFor(guestId, roomId, stateBg, roomBg = null) {
    const was = this.layerSince.get(guestId) ?? { bg: null, bed: null };
    const now = this.now();
    let { bg } = was;
    if (stateBg != null || roomId != null) {
      const fromRoomState = stateBg == null && roomBg != null;
      const want = layerDeclaration(stateBg ?? roomBg?.bg ?? this.def.rooms?.[roomId]?.bg);
      const since = (fromRoomState && roomBg.since) || now;
      bg = !want ? null
        : want.audio === bg?.audio && (!fromRoomState || !roomBg.since || bg.since === since) ? bg
        : { ...want, since };
    }
    const bedDef = layerDeclaration(this.def.guest?.bed);
    const bed = was.bed ?? (bedDef && roomId === this.def.guest.bed.from ? now : null);
    this.layerSince.set(guestId, { bg, bed });

    const cue = (slot, layer, since) => ({
      assetId: layer.audio,
      gain: layer.gain,
      loop: true,
      startAt: since,
      key: `${slot}:${layer.audio}:${since}`,
      // Fades in over this, and the director fades it out over the same.
      ...(layer.crossfadeMs != null ? { fadeMs: layer.crossfadeMs } : {}),
    });
    return {
      bg: bg ? cue('bg', bg, bg.since) : null,
      bed: bedDef && bed != null ? cue('bed', bedDef, bed) : null,
    };
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
  // -------------------------------------------------------------------------
  // Room experiences
  //
  // A room may hand its interaction to a separate piece running its own server
  // in that room. The show tells it who is driving and what the room is doing;
  // the guest's finger goes straight from their phone to that server, never
  // through here. See experience-link.js.
  // -------------------------------------------------------------------------

  /**
   * Who is driving this room's experience, as a set rather than a sequence of
   * changes — the experience is a separate program that may restart at any time,
   * and the first message it gets has to be the whole truth.
   *
   * A driver id and hue stay with a guest for as long as they are in the room:
   * an experience tints things by hue, and a colour that shuffled when somebody
   * else walked in would read as the piece glitching.
   */
  experienceDrivers(roomId) {
    const def = this.def?.rooms?.[roomId]?.experience;
    if (!def?.endpoint) return [];
    let assigned = this._drivers.get(roomId);
    if (!assigned) {
      assigned = new Map();
      this._drivers.set(roomId, assigned);
    }

    const driving = [];
    for (const guest of this.guests.values()) {
      const here = this.guestActors.get(guest.guestId)?.currentRoom();
      if (here?.roomId !== roomId) continue;
      if (!DRIVING_STANDINGS.includes(here.standing)) continue;
      driving.push(guest.guestId);
    }

    // A guest who has left stops driving — unless the room keeps drivers a
    // while (`keepDriverMs`: the lobby, from calibration, 2026-10-01). A phone
    // whose location flickers out of the room and back within that keeps its
    // driver, and with it its box, place and side on the piece; in between it
    // stays in the set, so the piece changes nothing.
    const keepMs = def.keepDriverMs ?? 0;
    const lingering = [];
    for (const [guestId, entry] of assigned) {
      if (driving.includes(guestId)) { entry.leftAt = null; continue; }
      entry.leftAt ??= this.now();
      if (!this.guests.has(guestId) || this.now() - entry.leftAt >= keepMs) {
        assigned.delete(guestId);
        continue;
      }
      lingering.push(guestId);
      // Re-reconcile when the wait is up, so the piece hears they have gone.
      if (!entry.dropTimer) {
        entry.dropTimer = this.clock.setTimeout(() => { entry.dropTimer = null; this.notifyChange(); }, keepMs - (this.now() - entry.leftAt) + 1);
      }
    }

    const cap = Math.min(
      def.maxDrivers ?? DRIVER_HUES.length,
      this.experiences.get(roomId)?.remote?.maxDrivers ?? DRIVER_HUES.length,
    );
    const out = [];
    for (const guestId of driving) {
      if (out.length >= cap) break;
      if (!assigned.has(guestId)) {
        const taken = new Set([...assigned.values()].map((d) => d.hue));
        assigned.set(guestId, {
          driverId: `d-${randomUUID().slice(0, 8)}`,
          hue: DRIVER_HUES.find((h) => !taken.has(h)) ?? DRIVER_HUES[assigned.size % DRIVER_HUES.length],
          // Not security — this is a closed network. It stops the room server
          // taking orders from anything that happens to find the port.
          secret: randomUUID(),
          guestId,
        });
      }
      out.push(assigned.get(guestId));
    }
    for (const guestId of lingering) {
      if (out.length >= cap) break;
      out.push(assigned.get(guestId));
    }
    return out;
  }

  /**
   * What the room is doing, in the four words an experience understands.
   *
   * `attract` is the one that matters: a piece left to itself infers "nobody is
   * here" from having no sockets, which is wrong whenever a guest is standing
   * in the room without driving.
   */
  experienceLifecycle(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !this.running) return 'attract';
    const state = String(room.state).split('.')[0];
    if (state === 'settling') return 'settling';
    if (state === 'idle') return 'attract';
    return this.experienceDrivers(roomId).length ? 'live' : 'attract';
  }

  /**
   * Bring every room experience in line with the show.
   *
   * Conditions are reconciled; a reset is fired once. The distinction matters
   * because a state is re-sent on every reconnect, and an experience that wiped
   * itself each time the link flapped would lose a guest's session to a network
   * blip rather than to them leaving.
   */
  reconcileExperiences() {
    for (const [roomId, link] of this.experiences) {
      const state = String(this.rooms.get(roomId)?.state ?? 'idle').split('.')[0];
      const previous = this._roomStateWas.get(roomId);
      this._roomStateWas.set(roomId, state);

      // A room whose songs come from a folder (rooms.<id>.tracks) tells its
      // piece how many there are and how long each runs.
      const tracks = this.def?.rooms?.[roomId]?.tracks?.list;
      link.reconcile({
        lifecycle: this.experienceLifecycle(roomId),
        drivers: this.experienceDrivers(roomId).map(({ driverId, hue, secret, guestId }) => {
          const side = this._sides.get(guestId);
          // `place` changes with each new pick: the piece places the guest afresh.
          return { driverId, hue, secret, ...(side?.roomId === roomId ? { side: side.side, place: side.key } : {}) };
        }),
        ...(Array.isArray(tracks) ? { tracks: tracks.map(({ n, seconds }) => ({ n, seconds })) } : {}),
      });

      // The room has come back to rest, so whatever the last guest built should
      // not be waiting for the next one. Deliberately keyed on reaching `idle`
      // rather than on leaving `settling`: settling also ends when the guest
      // walks back in, and that is the case where the piece must *not* wipe.
      if (previous !== undefined && previous !== state && state === 'idle') {
        link.event('reset');
      }
    }
  }

  /**
   * An operator asking a room's piece to reload its display pages — the
   * un-wedge button for a stuck wall. An event, not a state: run state
   * survives, and a refresh that finds the link down simply doesn't happen.
   */
  refreshExperience(roomId) {
    const sent = this.experiences.get(roomId)?.event('refresh') ?? false;
    if (sent) this.io.log?.(`${roomId}: refresh sent to experience`);
    return sent;
  }

  /** Every room experience's health, for the operator panel. */
  experienceSnapshot() {
    return [...this.experiences.values()].map((link) => link.snapshot());
  }

  /**
   * Put a guest in a room, or nowhere.
   *
   * Placement, not travel — one deliberate act with no timer behind it. This is
   * how a guest carrying a phone moves while there are no BLE zones to move
   * them: an operator sends them, or the handset reports its own room. Either
   * way somebody decided, which is the whole difference from the walkthrough
   * driver.
   *
   * It goes through the same virtual-position channel a dragged dot uses, so
   * entry and exit still confirm on their normal holds and the show cannot tell
   * this apart from someone walking in.
   *
   * @param {string} guestId
   * @param {string|null} roomId — null to put them outside
   * @returns {boolean} whether the move was made
   */
  sendGuestToRoom(guestId, roomId) {
    if (!this.guests.has(guestId)) return false;
    if (roomId == null) return this.setVirtualOccupancy(guestId, null, 'outside');
    const spot = this.standingSpot(roomId, guestId);
    if (!spot) return false;
    // Somebody decided where they are now; their phone's next reading is
    // believed wherever it is (`placedAt`).
    if (!this.setVirtualPosition(guestId, spot[0], spot[1])) return false;
    this.placedAt(guestId, roomId);
    return true;
  }

  /**
   * An operator's placement: the guest is in that room now, and the way
   * through starts again from the phone's next reading, wherever it is — as
   * for a phone's first fix. Rooms reached by hand do not count as reached.
   */
  placedAt(guestId, roomId) {
    this.furthestStage.delete(guestId);
    this.lastRoom.delete(guestId);
    this.lastRefused.delete(guestId);
    this.beaconHolds.delete(guestId);
    this.trustNextReading.add(guestId);
    return true;
  }

  /**
   * Put a guest on a path, or take them off one.
   *
   * The `manual` assignment strategy the contract has always declared, arriving
   * by the back door: an operator naming the path rather than the show drawing
   * it. Mostly a rehearsal tool — only one path in four routes through any given
   * museum room, so testing a specific room otherwise means rejoining until the
   * dice land.
   *
   * @param {string} guestId
   * @param {string|null} pathId
   * @returns {boolean} whether it took
   */
  setGuestPath(guestId, pathId) {
    const guest = this.guests.get(guestId);
    if (!guest) return false;
    if (pathId != null && !this.def?.paths?.[pathId]) return false;
    guest.pathId = pathId;
    // Pinned, so reaching the museum does not draw over it. Clearing the path
    // hands the guest back to the show.
    guest.pathPinned = pathId != null;
    this.append({ type: 'guest.pathSet', guestId, pathId });
    this.notifyChange();
    return true;
  }

  /** Room ids and names, for a picker. */
  roomChoices() {
    return Object.entries(this.def?.rooms ?? {}).map(([roomId, room]) => ({
      roomId, name: room.name ?? roomId, kind: room.kind ?? 'destination',
    }));
  }

  /**
   * Inputs the guest's machine would act on right now.
   *
   * Empty most of the time — the show asks for a gesture rarely. When it is not
   * empty the show has asked this guest a question and is holding for the
   * answer, which is a state anything moving guests around needs to respect.
   *
   * @returns {string[]} input kinds, from `inputBindings`
   */
  pendingInputs(guestId) {
    const actor = this.guestActors.get(guestId);
    if (!actor || !this.running || this.gestureHeld(actor)) return [];
    return Object.entries(this.def?.inputBindings ?? {})
      .filter(([, event]) => actor.canAccept(event))
      .map(([input]) => input);
  }

  /**
   * Whether the guest's step has yet to ask for its gesture (a sequence
   * step's `listenFrom`): until then it takes none, and offers none — the
   * operator panel and the walkthrough see nothing to answer.
   */
  gestureHeld(actor) {
    const step = actor.regions().guidance;
    const gate = step ? this.def?.guest?.inputGates?.[`guidance.${step}`] : null;
    return gate != null && this.now() - actor.regionSince('guidance') < gate;
  }

  /**
   * The guest pressed START DIM (the phone's first `ready`, 2026-10-01): the
   * show's guide hears `STARTED`, which a script waiting for it (MAD-DIM's
   * prologue) takes as its cue to begin — the pre-calibration clip, from its
   * top. Then the room the guest already stands in is said again, so a guide
   * that moves on room entry is not left waiting for a room they entered
   * before pressing. A guide that is not waiting ignores both.
   *
   * @returns {boolean} whether the guide took STARTED
   */
  guestStarted(guestId) {
    const actor = this.guestActors.get(guestId);
    if (!actor || !this.running || !actor.canAccept('STARTED')) return false;
    actor.send('STARTED');
    const here = actor.currentRoom()?.roomId;
    if (here && actor.canAccept(enteredEvent(here))) actor.send(enteredEvent(here));
    this.append({ type: 'guest.started', guestId, roomId: here ?? null });
    this.notifyChange();
    return true;
  }

  guestInput(guestId, input) {
    const actor = this.guestActors.get(guestId);
    if (!actor || !this.running) return false;
    const event = this.def?.inputBindings?.[input];
    if (!event) return false;
    if (this.gestureHeld(actor)) return false;
    const left = this.clipLeftMs(actor);
    if (left > 0) return this.holdGesture(guestId, actor, event, left);
    actor.send(event);
    this.notifyChange();
    return true;
  }

  /** The guest's guidance step, as its sequence keys spell it (`guidance.<state>`). */
  guidanceKey(actor) {
    const step = actor.regions().guidance;
    return step ? `guidance.${step}` : null;
  }

  /**
   * How much of a `playThrough` step's clip is still to play, in ms; 0 when
   * the step has none, it has finished, or its length cannot be read (then
   * the gesture acts at once, as before, and the operator log says why).
   */
  clipLeftMs(actor) {
    const clip = this.def?.guest?.playThrough?.[this.guidanceKey(actor)];
    if (!clip) return 0;
    const seconds = this.io.clipSeconds?.(clip);
    if (!(seconds > 0)) {
      if (!this._unmeasuredClips.has(clip)) {
        this._unmeasuredClips.add(clip);
        this.io.log?.(`playThrough: cannot read the length of ${clip}; its gesture will cut it short`);
      }
      return 0;
    }
    return Math.max(0, Math.round(seconds * 1000) - (this.now() - actor.regionSince('guidance')));
  }

  /**
   * A gesture made while a `playThrough` clip is still playing: it counts, and
   * moves the guest on the moment the clip ends. One per step — the rest are
   * the guest enjoying the piece they are driving, not more answers.
   */
  holdGesture(guestId, actor, event, leftMs) {
    if (!actor.canAccept(event)) return false;
    const key = this.guidanceKey(actor);
    if (this._heldGestures.get(guestId)?.key === key) return true;
    const since = actor.regionSince('guidance');
    const handle = this.clock.setTimeout(() => {
      if (this._heldGestures.get(guestId)?.handle !== handle) return;
      this._heldGestures.delete(guestId);
      const now = this.guestActors.get(guestId);
      // Somewhere else by now (an operator, a reset): the answer was to a step
      // they have left.
      if (!now || !this.running || this.guidanceKey(now) !== key || now.regionSince('guidance') !== since) return;
      if (!now.canAccept(event)) return;
      now.send(event);
      this.notifyChange();
    }, leftMs);
    this._heldGestures.set(guestId, { key, handle });
    return true;
  }

  /**
   * The gestures a guest has been taught so far, for a piece they drive while
   * a sequence teaches them (`gesturesToShow`: the lobby, in calibration).
   * In a step: what earlier steps asked for, plus this step's own once its
   * listenFrom has passed. Outside one: nothing before the sequence, all it
   * taught after. `nextAt` is when the set next grows, if it will.
   */
  taughtInputs(guestId) {
    const actor = this.guestActors.get(guestId);
    if (!actor) return { inputs: [], nextAt: null };
    const seen = this._sequencesSeen.get(guestId) ?? new Set();
    const step = this.def?.guest?.stepInputs?.[this.guidanceKey(actor)];
    if (step) {
      seen.add(step.sequence);
      this._sequencesSeen.set(guestId, seen);
      const opensAt = actor.regionSince('guidance') + step.fromMs;
      const open = step.input && this.now() >= opensAt;
      const inputs = open && !step.taught.includes(step.input) ? [...step.taught, step.input] : step.taught;
      return { inputs, nextAt: step.input && !open ? opensAt : null };
    }
    const all = new Set([...seen].flatMap((at) => this.def?.guest?.sequenceInputs?.[at] ?? []));
    return { inputs: [...all], nextAt: null };
  }

  /**
   * Which half of a piece's screen is the guest's, from the room beacon their
   * phone heard strongest over the first few seconds of each step of their
   * sequence (`sides`: the lobby, from calibration's two beacons — checked
   * at every clip, 2026-10-01). One pick per step; a guest can change sides
   * between clips, and the piece places them afresh each time.
   *
   * @param {string} key — the step the phone sampled in (its cue's `sideKey`)
   * @returns {boolean} whether it was taken
   */
  setGuestSide(guestId, major, key) {
    const actor = this.guestActors.get(guestId);
    const roomId = actor?.currentRoom()?.roomId;
    const side = roomId ? this.def?.rooms?.[roomId]?.experience?.sides?.[String(major)] : null;
    if (!side || key == null || key !== this.sideKeyFor(guestId)) return false;
    const was = this._sides.get(guestId);
    if (was?.roomId === roomId && was.key === key) return false;
    this._sides.set(guestId, { roomId, key, side });
    this.append({ type: 'guest.side', guestId, roomId, step: key, major: Number(major), side });
    this.notifyChange();
    return true;
  }

  /** The sequence step a guest's side is sampled for, or null outside a sequence. */
  sideKeyFor(guestId) {
    const actor = this.guestActors.get(guestId);
    const key = actor ? this.guidanceKey(actor) : null;
    return key && this.def?.guest?.stepInputs?.[key] ? key : null;
  }

  /** Re-cue a guest at `at` (show clock), when a gesture unlocks. One pending per guest. */
  wakeAt(guestId, at) {
    const pending = this._unlockWakes.get(guestId);
    if (pending?.at === at) return;
    if (pending) this.clock.clearTimeout(pending.handle);
    const handle = this.clock.setTimeout(() => {
      if (this._unlockWakes.get(guestId)?.handle !== handle) return;
      this._unlockWakes.delete(guestId);
      this.notifyChange();
    }, Math.max(0, at - this.now()));
    this._unlockWakes.set(guestId, { at, handle });
  }

  /**
   * The connection details a phone needs to drive this room's experience, or
   * null if it should not be driving anything.
   *
   * A cue slot rather than a message, so a phone that drops and comes back is
   * handed to the experience again by the same reconcile that restores its
   * audio — being connected is a state, not an event that happened once.
   *
   * `phoneEndpoint` exists because the two ends may not share an address: the
   * show server can reach a room machine on one route while a handset on the
   * guest wifi needs another.
   */
  experienceCueFor(guestId, here) {
    if (!here) return null;
    const config = this.def?.rooms?.[here.roomId]?.experience;
    if (!config?.endpoint) return null;
    // A piece the show talks to and phones do not (inputMode "none").
    if (config.inputMode === 'none') return null;
    const driver = this.experienceDrivers(here.roomId).find((d) => d.guestId === guestId);
    if (!driver) return null;
    // A piece driven while the show teaches its gestures hears only those the
    // guest has been taught so far; the phone is re-cued as each unlocks.
    let allow = null;
    if (config.gesturesToShow === true) {
      const taught = this.taughtInputs(guestId);
      allow = taught.inputs;
      if (taught.nextAt != null) this.wakeAt(guestId, taught.nextAt);
    }
    // Re-sampled at each step, so the cue changes with the step.
    const sideKey = config.sides ? this.sideKeyFor(guestId) : null;
    return {
      assetId: `${here.roomId}:${driver.driverId}`,
      key: `${here.roomId}:${driver.driverId}` + (allow ? `:${allow.join('+')}` : '') + (sideKey ? `@${sideKey}` : ''),
      ...(allow ? { allow } : {}),
      // Beacons to sample for the guest's side of the screen, and for how long.
      ...(config.sides ? { sides: Object.keys(config.sides).map(Number), sideAfterMs: config.sideAfterMs ?? 3000, sideKey } : {}),
      endpoint: config.phoneEndpoint ?? config.endpoint,
      experienceId: config.experienceId ?? null,
      inputMode: config.inputMode ?? 'stream',
      inputs: config.inputs ?? null,
      // The show's own steps need the same gestures (the lobby, in calibration).
      ...(config.gesturesToShow === true ? { gesturesToShow: true } : {}),
      driverId: driver.driverId,
      hue: driver.hue,
      secret: driver.secret,
      startAt: this.rooms.get(here.roomId)?.stateSince ?? this.now(),
    };
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
    this.reconcileExperiences();
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
      experiences: this.experienceSnapshot(),
      recentEvents: this.eventLog.slice(-30),
      outputLog: this.outputLog.slice(-50),
    };
  }
}

/** Path rotation is show-wide, so it lives here rather than on any one guest. */
