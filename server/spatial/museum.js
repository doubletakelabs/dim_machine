/**
 * The museum layer — each guest's relationship with the DIM rooms.
 *
 * Prototyped in /sim/ (public/sim/museum-machine.js) and implemented here for
 * the show. Deliberately NOT the same file: the sim is a prototyping sandbox
 * that will diverge again; this is the current design, wired to the runtime.
 *
 * The rules, as the team settled them (2026-09-08 … 2026-09-11):
 *
 * - Guests choose. The first `limit` museum rooms a guest enters are theirs:
 *   entering activates the room and the journey runs — entrance, then
 *   in_room the moment the entrance clip ends, then complete when the room
 *   finishes. The slot burns as the entrance begins, so abandonment keeps it.
 * - A room entered after the slots are spent cannot activate: in_room_disabled
 *   once, return_disabled every entry after.
 * - Returning to any room they have been in — completed or abandoned — is a
 *   dead room with the return_visited clip. Every return; no resume.
 * - A full room (maxOccupants) refuses by capacity: silence, nothing burned,
 *   nothing remembered. Walking away from it can never count against anyone.
 * - A below-capacity room that is already running activates *for the joiner*
 *   too: they burn a slot and get their own entrance and in_room. When the
 *   room completes, everyone engaged gets the same complete at the same time.
 * - Stepping back into the world after each visit is in_hallway — one state,
 *   a track per progress count, the show's pick. Not after a capacity refusal.
 *
 * ## How it meets the runtime
 *
 * Entry and exit come from the coordinator's committed occupancy events — the
 * one spatial trigger the whole design was reduced to, because it is the one
 * BLE reports well. Completion comes from the room going idle on its own
 * (authored duration today, the room's own software tomorrow); this layer
 * tells an abandoned room to stand down itself, and tells the two apart by
 * who initiated the transition.
 *
 * Audio rides the existing cue slots, reconciled like everything else:
 * `room` carries the in_room bed (scheduled to start exactly when the
 * entrance clip ends — the server knows the clip's length), and `guidance`
 * carries the spoken line (entrance, complete, the returns, in_hallway).
 * A reconnecting phone converges on the right audio for free.
 */

export const MUSEUM_STEMS = [
  'entrance', 'inRoom', 'complete', 'returnVisited',
  'inRoomDisabled', 'returnDisabled', 'inHallway',
];

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
    /** Rooms this layer itself stood down — their idle is abandonment, not completion. */
    this.selfReleased = new Set();
  }

  guest(guestId) {
    if (!this.guests.has(guestId)) {
      this.guests.set(guestId, {
        seen: 0,
        memory: new Map(),   // roomId → 'visited' | 'completed' | 'disabled'
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
    if (mem === 'visited' || mem === 'completed') {
      g.visitKind = 'return';
      return this.say(g, 'returnVisited', now);
    }
    if (mem === 'disabled') {
      g.visitKind = 'return';
      return this.say(g, 'returnDisabled', now);
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
      return this.say(g, 'inRoomDisabled', now);
    }

    // One of their four. The slot burns here — an entrance has begun.
    g.seen += 1;
    g.memory.set(roomId, 'visited');
    g.engagedRoom = roomId;
    g.engagedAt = now;
    g.visitKind = 'engaged';
    if (!this.engaged.has(roomId)) this.engaged.set(roomId, new Set());
    this.engaged.get(roomId).add(guestId);
    this.say(g, 'entrance', now);
    // First one in wakes the room; a joiner finds it already running and the
    // room activates *for them* all the same — their own entrance, their own
    // in_room, and the shared complete when it lands.
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

  /** Walked out mid-experience: the slot stays burned, the room may stand down. */
  disengage(guestId, roomId) {
    const g = this.guest(guestId);
    g.engagedRoom = null;
    const set = this.engaged.get(roomId);
    set?.delete(guestId);
    if (set && set.size === 0 && this.io.roomInfo(roomId).active) {
      // Nobody left inside whose room this is — stand it down. Marked as ours
      // so the resulting idle reads as abandonment, not completion.
      this.selfReleased.add(roomId);
      this.io.release(roomId);
      this.io.log?.(`museum: ${roomId} abandoned — standing down`);
    }
  }

  /**
   * A museum room's machine changed state. Idle with engaged guests still
   * inside means the room finished on its own — that is completion, and
   * everyone engaged hears the same complete at the same moment.
   */
  handleRoomState(roomId, rootState) {
    if (!this.rooms.has(roomId)) return;
    if (rootState !== 'idle') return;
    if (this.selfReleased.delete(roomId)) return; // our own stand-down: abandonment
    const set = this.engaged.get(roomId);
    if (!set?.size) return;
    // Only guests still physically inside completed. The room actor reacts to
    // a departure before this layer hears about it, so an emptying room can
    // reach idle while the leaver is still in the engaged set — and someone
    // mid-walk-out did not finish the experience.
    const inside = new Set(this.io.occupantIds(roomId));
    const now = this.io.now();
    for (const guestId of [...set]) {
      if (!inside.has(guestId)) continue;
      const g = this.guest(guestId);
      g.memory.set(roomId, 'completed');
      g.engagedRoom = null;
      g.visitKind = 'engaged'; // their exit still earns the hallway line
      this.say(g, 'complete', now);
      this.io.log?.(`museum: ${guestId} completed ${roomId}`);
      set.delete(guestId);
    }
  }

  /** One spoken line at a time; a new one replaces whatever was saying. */
  say(g, stem, startAt) {
    const assetId = this.stemAsset(stem, g);
    if (!assetId) return;
    g.voice = { stem, assetId, startAt };
  }

  stemAsset(stem, g) {
    const stems = this.config.stems ?? {};
    if (stem !== 'inHallway') return stems[stem] ?? null;
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
      const entrance = this.config.stems?.entrance;
      const lead = entrance ? (this.io.assetSeconds(entrance) ?? 0) * 1000 : 0;
      const startAt = g.engagedAt + Math.round(lead);
      cues.room = {
        assetId: this.config.stems?.inRoom,
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
}
