/**
 * The museum layer — each guest's relationship with the DIM rooms.
 *
 * Prototyped in /sim/ (public/sim/museum-machine.js) and implemented here for
 * the show. Deliberately NOT the same file: the sim is a prototyping sandbox
 * that will diverge again; this is the current design, wired to the runtime.
 *
 * The rules, as the team settled them (2026-09-08 … 2026-09-11; complete
 * removed 2026-09-25; no limit, a choice of one, and returns that run
 * 2026-09-26; MAD-DIM's Kin-or-Faerie choice dropped 2026-10-01):
 *
 * - Guests go where they like. Entering a museum room activates it and the
 *   journey runs — entrance, then in_room the moment the entrance clip ends,
 *   for as long as they stay. There is no completion: a room runs until every
 *   guest it is running for has walked out. A show may still cap how many
 *   rooms a guest gets (`limit`); MAD-DIM does not.
 * - `chooseOne` groups rooms a guest gets only one of (MAD-DIM sets none;
 *   it once paired Kin and Faerie). The first of a group they enter is theirs; from then on the rest
 *   of the group — and any room past a `limit` — cannot activate for them:
 *   in_room_disabled once, return_disabled every entry after.
 * - Returning to a room they have had runs it again, so they can use it, but
 *   without its entrance or in_room: they have heard those. The
 *   return_visited clip plays instead.
 * - A room is only *had* once they are still in it `doneAfterMs` after its
 *   first clip actually started playing on their phone (MAD-DIM: 5s; the
 *   phone reports the start). A room with no clips has nothing to wait for:
 *   it counts from the entry. Out sooner — a misread that landed, a step in
 *   and back, a clip that never got to play — and it is as if they never went
 *   in: no slot, no choice made, and the next entry plays it from the top
 *   (2026-09-27).
 * - A room may wait for its own piece before it speaks (`waitFor`, MAD-DIM:
 *   Kin waits for KIN_RUN, 2026-10-01). Walking in still wakes the room and
 *   its background plays, but the entrance and in_room hold until the piece
 *   says the event — Kin's actuator starting a run, so a guest who walks in
 *   during a run or its cooldown hears nothing until the pop-up they will see.
 *   Out before then is as if they never went in, like any too-brief visit.
 *   Nothing is held while the piece is not connected, a dropped link lets
 *   everyone waiting hear the room at once, and nobody waits longer than
 *   `waitMaxMs` (60s): a dead or stuck piece must never mean silence.
 * - A full room (maxOccupants) refuses by capacity: silence, nothing burned,
 *   nothing remembered. Walking away from it can never count against anyone.
 * - A below-capacity room that is already running activates *for the joiner*
 *   too: they burn a slot and get their own entrance and in_room.
 * - Stepping back into the world after each visit is in_hallway — one state,
 *   a track per progress count, the show's pick. Not after a capacity refusal.
 *
 * ## How it meets the runtime
 *
 * Entry and exit come from the coordinator's committed occupancy events — the
 * one spatial trigger the whole design was reduced to, because it is the one
 * BLE reports well. The only thing that ends a museum room is this layer
 * standing it down, when the last guest it is running for walks out — no
 * timer, and nothing the room's own software says.
 *
 * Audio rides the existing cue slots, reconciled like everything else:
 * `room` carries the in_room bed (scheduled to start exactly when the
 * entrance clip ends — the server knows the clip's length), and `guidance`
 * carries the spoken line (entrance, the returns, in_hallway).
 * A reconnecting phone converges on the right audio for free.
 */

export const MUSEUM_STEMS = [
  'entrance', 'inRoom', 'returnVisited',
  'inRoomDisabled', 'returnDisabled', 'inHallway',
];

/**
 * The stems a single room may have its own take on (`museum.roomStems`).
 * `inHallway` is the hallway's, chosen by progress count, never a room's.
 */
export const ROOM_STEMS = MUSEUM_STEMS.filter((stem) => stem !== 'inHallway');

export class MuseumLayer {
  /**
   * @param {object} config — the show's `museum` block
   * @param {object} io
   * @param {() => number} io.now
   * @param {(asset: string) => number|null} io.assetSeconds — clip length, for scheduling in_room
   * @param {(guestId: string, roomId: string) => void} io.activate
   * @param {(roomId: string) => void} io.release — stand an abandoned room down
   * @param {(roomId: string) => { count: number, max: number|null, active: boolean }} io.roomInfo
   * @param {(roomId: string) => string[]} io.occupantIds — who is physically inside right now
   * @param {(roomId: string) => boolean} [io.pieceReady] — the room's piece is connected
   * @param {(at: number) => void} [io.wakeAt] — re-cue everyone at `at`
   * @param {(line: string) => void} [io.log]
   */
  constructor(config, io) {
    this.config = config;
    this.io = io;
    this.rooms = new Set(config.rooms ?? []);
    /** How many rooms a guest gets; no `limit`, no cap. */
    this.limit = config.limit ?? Infinity;
    /** How long after its first clip starts a room becomes theirs; 0, at once. */
    this.doneAfterMs = config.doneAfterMs ?? 0;
    /** roomId → the other rooms of its `chooseOne` group. */
    this.rivals = new Map();
    for (const group of config.chooseOne ?? []) {
      for (const roomId of group) this.rivals.set(roomId, group.filter((r) => r !== roomId));
    }
    /** roomId → the event from its piece that its entrance waits for. */
    this.waitFor = new Map(Object.entries(config.waitFor ?? {}));
    /** The longest a guest waits for it before hearing the room anyway. */
    this.waitMaxMs = config.waitMaxMs ?? 60000;
    /** guestId → { seen, memory: Map, engagedRoom, engagedAt, visitKind, voice } */
    this.guests = new Map();
    /** roomId → Set<guestId> currently engaged (their room, running for them) */
    this.engaged = new Map();
  }

  guest(guestId) {
    if (!this.guests.has(guestId)) {
      this.guests.set(guestId, {
        seen: 0,
        memory: new Map(),   // roomId → 'visited' | 'disabled'
        engagedRoom: null,
        engagedAt: 0,
        replay: false,       // engaged on a return: the room runs, its clips do not
        clipAt: null,        // when the engaged room's first clip began on their phone
        heldAt: null,        // waiting since then for the room's piece (`waitFor`)
        visitKind: null,     // what this entry was, consumed on exit
        voice: null,         // the current spoken line: { stem, assetId, startAt }
      });
    }
    return this.guests.get(guestId);
  }

  removeGuest(guestId) {
    const g = this.guests.get(guestId);
    if (g?.engagedRoom) this.disengage(guestId, g.engagedRoom);
    this.guests.delete(guestId);
  }

  /**
   * May this entry wake the room? The runtime's walk-in auto-activation asks
   * before the entry is processed here, so the answer reads like a promise:
   * true exactly when handleEntry is about to engage them. A return, a spent
   * guest, or a stranger to the museum must not wake a dead room.
   */
  wouldEngage(guestId, roomId) {
    if (!this.rooms.has(roomId)) return true; // not ours to gate
    const g = this.guest(guestId);
    const mem = g.memory.get(roomId);
    if (mem === 'visited') return true; // a return runs the room again
    if (mem === 'disabled') return false;
    return g.seen < this.limit && !this.barred(g, roomId);
  }

  /** Another room of its `chooseOne` group is already theirs. */
  barred(g, roomId) {
    return (this.rivals.get(roomId) ?? []).some((r) => g.memory.get(r) === 'visited');
  }

  /** The one spatial trigger: a committed entry or exit. */
  handleOccupancy(event) {
    const { guestId, roomId, previousRoomId } = event;
    const left = previousRoomId && this.rooms.has(previousRoomId) && roomId !== previousRoomId;
    const entered = roomId && this.rooms.has(roomId) && roomId !== previousRoomId;
    if (left) this.handleExit(guestId, previousRoomId);
    if (entered) this.handleEntry(guestId, roomId);
  }

  handleEntry(guestId, roomId) {
    const g = this.guest(guestId);
    const mem = g.memory.get(roomId);
    const now = this.io.now();

    // Been here before: the room runs again for them to use, but without its
    // entrance or in_room — they have heard those.
    if (mem === 'visited') {
      const info = this.io.roomInfo(roomId);
      if (info.max != null && info.count > info.max) {
        g.visitKind = 'full';
        return;
      }
      this.engage(g, guestId, roomId, now, true);
      this.say(g, 'returnVisited', now, roomId);
      if (!info.active) this.io.activate(guestId, roomId);
      this.io.log?.(`museum: ${guestId} back in ${roomId}`);
      return;
    }
    if (mem === 'disabled') {
      g.visitKind = 'return';
      return this.say(g, 'returnDisabled', now, roomId);
    }

    // Refused by capacity is not an entrance: nothing burns, nothing is
    // remembered, and the exit stays silent. The committed count includes
    // this guest, so "full" means the room was at capacity before them.
    const info = this.io.roomInfo(roomId);
    if (info.max != null && info.count > info.max) {
      g.visitKind = 'full';
      return;
    }

    // Out of slots, or the other of a choose-one pair already theirs: the room
    // will not run for them, and says so — once.
    if (g.seen >= this.limit || this.barred(g, roomId)) {
      g.memory.set(roomId, 'disabled');
      g.visitKind = 'return';
      return this.say(g, 'inRoomDisabled', now, roomId);
    }

    // Theirs. The slot burns here — an entrance has begun — and a choose-one
    // pair is decided.
    g.seen += 1;
    g.memory.set(roomId, 'visited');
    this.engage(g, guestId, roomId, now, false);
    if (this.waitFor.has(roomId) && this.io.pieceReady?.(roomId)) {
      // Its piece first: nothing spoken until it says so (`waitFor`).
      g.heldAt = now;
      g.voice = null;
      this.io.wakeAt?.(now + this.waitMaxMs);
      this.io.log?.(`museum: ${guestId} in ${roomId}, waiting for ${this.waitFor.get(roomId)}`);
    } else {
      this.say(g, 'entrance', now, roomId);
    }
    // First one in wakes the room; a joiner finds it already running and the
    // room activates *for them* all the same — their own entrance, their own
    // in_room.
    if (!info.active) this.io.activate(guestId, roomId);
    this.io.log?.(`museum: ${guestId} engaged ${roomId} (${g.seen}${Number.isFinite(this.limit) ? `/${this.limit}` : ''})`);
  }

  /** Still in it `doneAfterMs` after its first clip began: the room is theirs. */
  had(g) {
    if (this.doneAfterMs <= 0) return true;
    return g.clipAt != null && this.io.now() - g.clipAt >= this.doneAfterMs;
  }

  /**
   * Their phone began playing a clip (`{ type: "playing" }`). The first of the
   * engaged room's own clips starts the clock on it becoming theirs.
   */
  clipPlaying(guestId, assetId, at) {
    const g = this.guests.get(guestId);
    if (!g?.engagedRoom || g.replay || g.clipAt != null) return;
    const own = ['entrance', 'inRoom'].map((stem) => this.stemAsset(stem, g, g.engagedRoom));
    if (!own.includes(assetId)) return;
    g.clipAt = Math.min(at ?? this.io.now(), this.io.now());
  }

  /** The room is running for them from now until they walk out. */
  engage(g, guestId, roomId, now, replay) {
    g.engagedRoom = roomId;
    g.engagedAt = now;
    g.replay = replay;
    // A room with no clips has nothing to wait for: its clock starts now.
    const clips = ['entrance', 'inRoom'].some((stem) => this.stemAsset(stem, g, roomId));
    g.clipAt = clips ? null : now;
    g.visitKind = replay ? 'return' : 'engaged';
    if (!this.engaged.has(roomId)) this.engaged.set(roomId, new Set());
    this.engaged.get(roomId).add(guestId);
  }

  handleExit(guestId, roomId) {
    const g = this.guest(guestId);
    let kind = g.visitKind;
    g.visitKind = null;
    if (g.engagedRoom === roomId) {
      // Too brief to have heard it: forgotten, slot and choice with it.
      if (kind === 'engaged' && !this.had(g)) {
        g.memory.delete(roomId);
        g.seen -= 1;
        kind = null; // nothing happened in there, so the hallway says nothing
        this.io.log?.(`museum: ${guestId} left ${roomId} too soon to have had it — forgotten`);
      }
      this.disengage(guestId, roomId);
    }
    // The hallway speaks after every visit — except a capacity refusal, which
    // has been a non-event in every ruling: nothing happened in there.
    if (kind && kind !== 'full') this.say(g, 'inHallway', this.io.now());
  }

  /** Their wait is over: the room speaks from `at`, entrance then in_room. */
  unhold(g, at) {
    g.heldAt = null;
    g.engagedAt = at;
    this.say(g, 'entrance', at, g.engagedRoom);
  }

  /**
   * The room's piece said something. If it is what the room waits for, everyone
   * waiting in it hears the room now. Returns how many were waiting.
   */
  pieceEvent(roomId, name) {
    if (this.waitFor.get(roomId) !== name) return 0;
    return this.unholdRoom(roomId, `${name} from its piece`);
  }

  /** The room's piece is no longer connected: nobody waits for it. */
  pieceLost(roomId) {
    if (!this.waitFor.has(roomId)) return 0;
    return this.unholdRoom(roomId, 'its piece is not connected');
  }

  unholdRoom(roomId, why) {
    const now = this.io.now();
    let n = 0;
    for (const guestId of this.engaged.get(roomId) ?? []) {
      const g = this.guests.get(guestId);
      if (g?.heldAt == null) continue;
      this.unhold(g, now);
      n += 1;
    }
    if (n) this.io.log?.(`museum: ${roomId} speaks for ${n} waiting (${why})`);
    return n;
  }

  /** Walked out: the slot stays burned, and the room may stand down. */
  disengage(guestId, roomId) {
    const g = this.guest(guestId);
    g.engagedRoom = null;
    g.replay = false;
    g.heldAt = null;
    const set = this.engaged.get(roomId);
    set?.delete(guestId);
    if (set && set.size === 0 && this.io.roomInfo(roomId).active) {
      // Nobody left inside whose room this is — the one thing that ends a
      // museum room. Anyone still standing there it was not running for.
      this.io.release(roomId);
      this.io.log?.(`museum: ${roomId} — its last guest left, standing down`);
    }
  }

  /** One spoken line at a time; a new one replaces whatever was saying. */
  say(g, stem, startAt, roomId = null) {
    const assetId = this.stemAsset(stem, g, roomId);
    if (!assetId) return;
    g.voice = { stem, assetId, startAt };
  }

  /**
   * A room's own take on a stem wins (`museum.roomStems.<roomId>`); anything it
   * does not declare falls back to the shared `museum.stems`.
   */
  stemAsset(stem, g, roomId = null) {
    const stems = this.config.stems ?? {};
    if (stem !== 'inHallway') return this.config.roomStems?.[roomId]?.[stem] ?? stems[stem] ?? null;
    const variants = stems.inHallway ?? [];
    if (!variants.length) return null;
    // A track per progress count — "two rooms now, play this one".
    return variants[Math.max(0, Math.min(variants.length - 1, g.seen - 1))];
  }

  /**
   * What this guest should be hearing from the museum, per slot — or null when
   * the museum has nothing to say and the authored show cues apply.
   *
   * @returns {{ room: object|null, guidance: object|null } | null}
   */
  guestCues(guestId, roomIdHere) {
    const g = this.guests.get(guestId);
    if (!g) return null;
    // Waited as long as anyone should: the room speaks from when it ran out.
    if (g.heldAt != null && this.io.now() - g.heldAt >= this.waitMaxMs) {
      this.io.log?.(`museum: ${guestId} waited ${this.waitMaxMs / 1000}s for ${g.engagedRoom}'s piece — hearing it anyway`);
      this.unhold(g, g.heldAt + this.waitMaxMs);
    }
    const inMuseumRoom = roomIdHere && this.rooms.has(roomIdHere);
    if (!inMuseumRoom && !g.voice) return null;

    const cues = { room: null, guidance: null };
    if (g.voice) {
      cues.guidance = {
        assetId: g.voice.assetId,
        startAt: g.voice.startAt,
        seek: true, // a reconnecting phone joins the line where it is
        key: `museum:${g.voice.stem}:${g.voice.startAt}`,
      };
    }
    if (g.engagedRoom && g.engagedRoom === roomIdHere && !g.replay && g.heldAt == null
      && this.io.roomInfo(roomIdHere).active) {
      // The bed starts exactly when the entrance clip ends — the server knows
      // the clip's length, so the phone just schedules it.
      const entrance = this.stemAsset('entrance', g, roomIdHere);
      const lead = entrance ? (this.io.assetSeconds(entrance) ?? 0) * 1000 : 0;
      const startAt = g.engagedAt + Math.round(lead);
      cues.room = {
        assetId: this.stemAsset('inRoom', g, roomIdHere),
        startAt,
        loop: true,
        seek: true,
        key: `museum:inRoom:${startAt}`,
      };
      if (!cues.room.assetId) cues.room = null;
    }
    return cues;
  }

  /** For the roster and the inspector. */
  snapshot(guestId) {
    const g = this.guests.get(guestId);
    const limit = Number.isFinite(this.limit) ? this.limit : null;
    if (!g) return { seen: 0, limit, rooms: {} };
    return {
      seen: g.seen,
      limit,
      engagedRoom: g.engagedRoom,
      waiting: g.heldAt != null,
      rooms: Object.fromEntries(g.memory),
    };
  }
}

/** Validation for the show's `museum` block; called from validate.js. */
export function checkMuseum(museum, rooms, errors, warnings) {
  if (museum == null) return;
  if (typeof museum !== 'object' || Array.isArray(museum)) {
    errors.push('museum must be an object');
    return;
  }
  if (museum.limit != null && (!Number.isInteger(museum.limit) || museum.limit < 1)) {
    errors.push('museum.limit must be a positive integer');
  }
  if (museum.doneAfterMs != null && !(typeof museum.doneAfterMs === 'number' && museum.doneAfterMs >= 0)) {
    errors.push('museum.doneAfterMs must be a non-negative number of milliseconds');
  }
  if (museum.waitMaxMs != null && !(typeof museum.waitMaxMs === 'number' && museum.waitMaxMs > 0)) {
    errors.push('museum.waitMaxMs must be a positive number of milliseconds');
  }
  if (museum.waitFor != null) {
    if (typeof museum.waitFor !== 'object' || Array.isArray(museum.waitFor)) {
      errors.push('museum.waitFor must map room ids to an event from that room\'s piece, e.g. { "kin": "KIN_RUN" }');
    } else {
      const museumRooms = new Set(Array.isArray(museum.rooms) ? museum.rooms : []);
      for (const [roomId, name] of Object.entries(museum.waitFor)) {
        if (!museumRooms.has(roomId)) errors.push(`museum.waitFor names "${roomId}", which is not one of museum.rooms`);
        if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
          errors.push(`museum.waitFor.${roomId} must be an event name like KIN_RUN`);
        }
        // Without a piece it would wait for nothing; it never holds, but say so.
        if (rooms?.[roomId] && !rooms[roomId].experience) {
          warnings.push(`museum.waitFor.${roomId}: the room has no experience to send ${name}, so nothing will wait`);
        }
      }
    }
  }
  if (!Array.isArray(museum.rooms) || !museum.rooms.length) {
    errors.push('museum.rooms must be a non-empty array of room ids');
  } else {
    for (const roomId of museum.rooms) {
      if (!rooms?.[roomId]) errors.push(`museum.rooms names "${roomId}", which the show does not have`);
    }
  }
  if (museum.chooseOne != null) {
    const museumRooms = new Set(Array.isArray(museum.rooms) ? museum.rooms : []);
    const seen = new Set();
    if (!Array.isArray(museum.chooseOne)) {
      errors.push('museum.chooseOne must be an array of room groups, e.g. [["kin", "faerie"]]');
    } else {
      museum.chooseOne.forEach((group, i) => {
        const at = `museum.chooseOne[${i}]`;
        if (!Array.isArray(group) || group.length < 2) {
          errors.push(`${at} must list at least two rooms`);
          return;
        }
        for (const roomId of group) {
          if (!museumRooms.has(roomId)) errors.push(`${at}: "${roomId}" is not one of museum.rooms`);
          if (seen.has(roomId)) errors.push(`${at}: "${roomId}" is in more than one group`);
          seen.add(roomId);
        }
      });
    }
  }
  if (museum.hallway != null && !rooms?.[museum.hallway]) {
    errors.push(`museum.hallway names "${museum.hallway}", which the show does not have`);
  }
  const stems = museum.stems ?? {};
  for (const stem of Object.keys(stems)) {
    if (!MUSEUM_STEMS.includes(stem)) {
      warnings.push(stem === 'complete'
        ? 'museum.stems.complete is no longer used — museum rooms do not complete'
        : `museum.stems.${stem} is not a museum stem (${MUSEUM_STEMS.join(', ')})`);
    }
  }
  for (const stem of MUSEUM_STEMS) {
    const value = stems[stem];
    if (value == null) {
      warnings.push(`museum.stems.${stem} is not set — that state will be silent`);
    } else if (stem === 'inHallway') {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        errors.push('museum.stems.inHallway must be an array of asset names (one per room count)');
      }
    } else if (typeof value !== 'string') {
      errors.push(`museum.stems.${stem} must be an asset name`);
    }
  }
  // Per-room takes on the shared stems. Only museum rooms play them, and only
  // the stems that belong to a room — a typo would otherwise be silence.
  const roomStems = museum.roomStems;
  if (roomStems == null) return;
  if (typeof roomStems !== 'object' || Array.isArray(roomStems)) {
    errors.push('museum.roomStems must be an object keyed by room id');
    return;
  }
  const museumRooms = new Set(Array.isArray(museum.rooms) ? museum.rooms : []);
  for (const [roomId, own] of Object.entries(roomStems)) {
    const at = `museum.roomStems.${roomId}`;
    if (!museumRooms.has(roomId)) errors.push(`${at}: "${roomId}" is not one of museum.rooms`);
    if (own == null || typeof own !== 'object' || Array.isArray(own)) {
      errors.push(`${at} must be an object of stem → asset name`);
      continue;
    }
    for (const [stem, value] of Object.entries(own)) {
      if (!ROOM_STEMS.includes(stem)) errors.push(`${at}.${stem} is not a room stem (${ROOM_STEMS.join(', ')})`);
      else if (typeof value !== 'string' || !value) errors.push(`${at}.${stem} must be an asset name`);
    }
  }
}
