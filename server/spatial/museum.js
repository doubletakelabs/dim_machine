/**
 * The museum layer — each guest's relationship with the DIM rooms.
 *
 * Prototyped in /sim/ (public/sim/museum-machine.js) and implemented here for
 * the show. Deliberately NOT the same file: the sim is a prototyping sandbox
 * that will diverge again; this is the current design, wired to the runtime.
 *
 * The rules, as the team settled them (2026-09-08 … 2026-09-11; complete
 * removed 2026-09-25):
 *
 * - Guests choose. The first `limit` museum rooms a guest enters are theirs:
 *   entering activates the room and the journey runs — entrance, then
 *   in_room the moment the entrance clip ends, for as long as they stay. The
 *   slot burns as the entrance begins. There is no completion: a room runs
 *   until every guest it is running for has walked out.
 * - A room entered after the slots are spent cannot activate: in_room_disabled
 *   once, return_disabled every entry after.
 * - Returning to any room they have been in is a dead room with the
 *   return_visited clip. Every return; no resume.
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
   * @param {(line: string) => void} [io.log]
   */
  constructor(config, io) {
    this.config = config;
    this.io = io;
    this.rooms = new Set(config.rooms ?? []);
    this.limit = config.limit ?? 4;
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
    return !g.memory.has(roomId) && g.seen < this.limit;
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

    // Been here before — the room is dead to them, but it remembers.
    if (mem === 'visited') {
      g.visitKind = 'return';
      return this.say(g, 'returnVisited', now, roomId);
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

    // Out of slots: the room will not run for them, and says so — once.
    if (g.seen >= this.limit) {
      g.memory.set(roomId, 'disabled');
      g.visitKind = 'return';
      return this.say(g, 'inRoomDisabled', now, roomId);
    }

    // One of their four. The slot burns here — an entrance has begun.
    g.seen += 1;
    g.memory.set(roomId, 'visited');
    g.engagedRoom = roomId;
    g.engagedAt = now;
    g.visitKind = 'engaged';
    if (!this.engaged.has(roomId)) this.engaged.set(roomId, new Set());
    this.engaged.get(roomId).add(guestId);
    this.say(g, 'entrance', now, roomId);
    // First one in wakes the room; a joiner finds it already running and the
    // room activates *for them* all the same — their own entrance, their own
    // in_room.
    if (!info.active) this.io.activate(guestId, roomId);
    this.io.log?.(`museum: ${guestId} engaged ${roomId} (${g.seen}/${this.limit})`);
  }

  handleExit(guestId, roomId) {
    const g = this.guest(guestId);
    const kind = g.visitKind;
    g.visitKind = null;
    if (g.engagedRoom === roomId) this.disengage(guestId, roomId);
    // The hallway speaks after every visit — except a capacity refusal, which
    // has been a non-event in every ruling: nothing happened in there.
    if (kind && kind !== 'full') this.say(g, 'inHallway', this.io.now());
  }

  /** Walked out: the slot stays burned, and the room may stand down. */
  disengage(guestId, roomId) {
    const g = this.guest(guestId);
    g.engagedRoom = null;
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
    if (g.engagedRoom && g.engagedRoom === roomIdHere && this.io.roomInfo(roomIdHere).active) {
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
    if (!g) return { seen: 0, limit: this.limit, rooms: {} };
    return {
      seen: g.seen,
      limit: this.limit,
      engagedRoom: g.engagedRoom,
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
  if (!Array.isArray(museum.rooms) || !museum.rooms.length) {
    errors.push('museum.rooms must be a non-empty array of room ids');
  } else {
    for (const roomId of museum.rooms) {
      if (!rooms?.[roomId]) errors.push(`museum.rooms names "${roomId}", which the show does not have`);
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
