import { systemClock } from './clock.js';

/** @typedef {'outside' | 'inside'} Occupancy */

/**
 * @typedef {Object} ZoneOccupancyEvent
 * @property {'zone.occupancy'} type
 * @property {string} guestId
 * @property {string | null} roomId
 * @property {string | null} zoneId — which of the room's zones, for diagnostics
 * @property {Occupancy} occupancy
 * @property {Occupancy} previousOccupancy
 * @property {string | null} previousRoomId
 * @property {string | null} previousZoneId
 * @property {string} source
 * @property {number} timestamp
 */

/**
 * @typedef {Object} CoordinatorCallbacks
 * @property {(event: ZoneOccupancyEvent) => void} [onOccupancyCommitted]
 * @property {(payload: { guestId: string, roomId: string, dwellMs: number, at: number }) => void} [onRoomSeen]
 */

const DEFAULTS = {
  /**
   * Entry is confirmed before it commits, because its consequences are
   * expensive: locking a room and committing the physical layer, with no human
   * in the loop. Exit is confirmed too, and the two are deliberately different
   * — that asymmetry is what stops someone in a doorway flapping the room.
   */
  entryConfirmMs: 1500,
  exitConfirmMs: 800,
  /**
   * How long a guest may be out of contact before they are treated as outside.
   * Covers both a silent beacon and a dropped socket (§11).
   */
  contactLossMs: 5000,
};

/** Location sources that stream continuously, and so go silent if lost. */
const STREAMING_SOURCES = new Set(['ble', 'rtls']);

/**
 * Authoritative occupancy relation + entry/exit hysteresis (spec §3.3, §5.2).
 *
 * Occupancy is tracked per **room**, not per zone: a room may own several zones
 * and moving between them is not an exit. The zone is carried on events for
 * diagnostics only.
 */
export class OccupancyCoordinator {
  /** @param {{ rooms?: Record<string, object>, location?: object, clock?: object, callbacks?: CoordinatorCallbacks }} opts */
  constructor(opts = {}) {
    this.roomDefs = opts.rooms ?? {};
    this.config = { ...DEFAULTS, ...(opts.location ?? {}) };
    this.clock = opts.clock ?? systemClock;
    this.callbacks = opts.callbacks ?? {};
    /** @type {Map<string, GuestOccupancy>} */
    this.guests = new Map();
    /** @type {Map<string, Map<string, { zoneId: string | null, sinceTs: number }>>} */
    this.byRoom = new Map();
    /** @type {Map<string, { insideSince: number | null, accumulatedMs: number, seenEmitted: boolean }>} */
    this.dwell = new Map();
    /** @type {Map<string, { guestId: string, sinceTs: number }>} */
    this.locks = new Map();
  }

  now() {
    return this.clock.now();
  }

  reset() {
    this.guests.clear();
    this.byRoom.clear();
    this.dwell.clear();
    this.locks.clear();
  }

  ensureGuest(guestId) {
    if (!this.guests.has(guestId)) {
      this.guests.set(guestId, createGuestOccupancy(guestId));
    }
    return this.guests.get(guestId);
  }

  /**
   * Drop a guest from the occupancy relation.
   *
   * Deliberately does **not** release any lock they hold. Dropping a lock here
   * would strand the room actor in an activated state with no holder — the
   * exact desync the single-owner lock table exists to prevent. Callers release
   * through the room actor, which decides between transfer and reset.
   */
  removeGuest(guestId) {
    const g = this.guests.get(guestId);
    if (!g) return;
    if (g.committed.roomId) this.unindexGuest(guestId, g.committed.roomId);
    this.guests.delete(guestId);
    for (const key of [...this.dwell.keys()]) {
      if (key.startsWith(`${guestId}:`)) this.dwell.delete(key);
    }
  }

  touchLocation(guestId) {
    const g = this.ensureGuest(guestId);
    g.lastContactAt = this.now();
    g.connected = true;
  }

  setConnected(guestId, connected) {
    const g = this.ensureGuest(guestId);
    g.connected = connected;
    // A disconnect is a loss of contact like any other; the same timer runs
    // whichever way we lost them, and reconnecting inside it restores them.
    g.lastContactAt = this.now();
  }

  /**
   * @param {string} guestId
   * @param {string | null} roomId
   * @param {Occupancy} occupancy
   * @param {string} [source]
   * @param {string | null} [zoneId]
   */
  setDesired(guestId, roomId, occupancy, source = 'virtual', zoneId = null) {
    const g = this.ensureGuest(guestId);
    g.desired = { roomId, occupancy, zoneId };
    g.source = source;
    g.lastContactAt = this.now();
    this.syncPending(guestId);
    this.advance(guestId);
  }

  /** Bypass hysteresis — operator/testing only. */
  ingestImmediate(guestId, roomId, occupancy, source = 'operator', zoneId = null) {
    const g = this.ensureGuest(guestId);
    g.pending = null;
    g.desired = { roomId, occupancy, zoneId };
    g.lastContactAt = this.now();
    this.commit(guestId, { roomId, occupancy, zoneId }, source);
  }

  processTime(now = this.now()) {
    for (const guestId of this.guests.keys()) {
      this.checkContactLoss(guestId, now);
      this.advance(guestId, now);
      this.updateDwell(guestId, now);
    }
  }

  getOccupancy(guestId) {
    const g = this.guests.get(guestId);
    if (!g) return { roomId: null, zoneId: null, occupancy: 'outside', sinceTs: null };
    return { ...g.committed, sinceTs: g.committedSince };
  }

  /** Everyone indexed against a room is inside it — `outside` unindexes. */
  getRoomOccupants(roomId) {
    const room = this.byRoom.get(roomId);
    if (!room) return [];
    return [...room.entries()].map(([guestId, o]) => ({
      guestId,
      zoneId: o.zoneId,
      sinceTs: o.sinceTs,
    }));
  }

  getSnapshot() {
    const occupancy = {};
    for (const [guestId, g] of this.guests) {
      occupancy[guestId] = {
        roomId: g.committed.roomId,
        zoneId: g.committed.zoneId,
        occupancy: g.committed.occupancy,
        sinceTs: g.committedSince,
        desired: g.desired,
        pending: g.pending
          ? { ...g.pending.target, holdMs: g.pending.holdMs, startedAt: g.pending.startedAt }
          : null,
        connected: g.connected,
        lastContactAt: g.lastContactAt,
      };
    }
    const byRoom = {};
    for (const [roomId, map] of this.byRoom) {
      byRoom[roomId] = Object.fromEntries(map);
    }
    const locks = {};
    for (const [roomId, lock] of this.locks) {
      locks[roomId] = { ...lock };
    }
    return { occupancy, byRoom, locks };
  }

  getLock(roomId) {
    return this.locks.get(roomId) ?? null;
  }

  /**
   * Coordinator is the lock table of record. Room actors request acquire/release.
   * @returns {{ ok: true } | { ok: false, reason: 'locked' }}
   */
  acquireLock(roomId, guestId) {
    const existing = this.locks.get(roomId);
    if (existing && existing.guestId !== guestId) {
      return { ok: false, reason: 'locked' };
    }
    this.locks.set(roomId, { guestId, sinceTs: this.now() });
    return { ok: true };
  }

  releaseLock(roomId, guestId = null) {
    const existing = this.locks.get(roomId);
    if (!existing) return false;
    if (guestId && existing.guestId !== guestId) return false;
    this.locks.delete(roomId);
    return true;
  }

  transferLock(roomId, toGuestId) {
    if (!this.locks.has(roomId)) return false;
    this.locks.set(roomId, { guestId: toGuestId, sinceTs: this.now() });
    return true;
  }

  /**
   * One timeout covers every way of losing track of a guest (§11): a silent
   * beacon, a dead phone, a dropped socket. When it expires they are outside,
   * which starts the room's own exit grace on top.
   */
  checkContactLoss(guestId, now = this.now()) {
    const g = this.guests.get(guestId);
    if (!g) return;
    if (g.committed.occupancy === 'outside' && !g.committed.roomId) return;

    // A virtual or operator placement is an explicit statement that persists —
    // there is no stream to go silent. A disconnect, though, applies to every
    // source: it says nothing about how they were located.
    const streaming = STREAMING_SOURCES.has(g.source);
    if (!streaming && g.connected) return;

    const hold = this.config.contactLossMs ?? DEFAULTS.contactLossMs;
    if (now - g.lastContactAt < hold) return;
    g.desired = { roomId: null, occupancy: 'outside', zoneId: null };
    this.syncPending(guestId, now);
    this.advance(guestId, now);
  }

  syncPending(guestId, now = this.now()) {
    const g = this.guests.get(guestId);
    if (!g) return;
    const step = nextStep(g.committed, g.desired);
    if (!step) {
      g.pending = null;
      return;
    }
    // Moving between zones of the same room does not change occupancy, so it
    // commits immediately rather than waiting out a confirmation.
    if (step.roomId === g.committed.roomId && step.occupancy === g.committed.occupancy) {
      g.pending = null;
      this.commit(guestId, step, g.source);
      return;
    }
    const holdMs = this.holdMsForStep(g.committed, step);
    if (
      g.pending
      && g.pending.target.roomId === step.roomId
      && g.pending.target.occupancy === step.occupancy
    ) {
      return;
    }
    g.pending = { target: step, holdMs, startedAt: now };
  }

  advance(guestId, now = this.now()) {
    const g = this.guests.get(guestId);
    if (!g?.pending) return;
    if (now - g.pending.startedAt < g.pending.holdMs) return;

    const { target } = g.pending;
    g.pending = null;
    this.commit(guestId, target, g.source);

    this.syncPending(guestId, now);
    if (g.pending) this.advance(guestId, now);
  }

  commit(guestId, target, source) {
    const g = this.guests.get(guestId);
    if (!g) return;

    const previousRoomId = g.committed.roomId;
    const previousZoneId = g.committed.zoneId;
    const previousOccupancy = g.committed.occupancy;
    let { roomId, zoneId, occupancy } = target;

    if (occupancy === 'outside') {
      roomId = null;
      zoneId = null;
    }

    if (previousRoomId && previousRoomId !== roomId) {
      this.unindexGuest(guestId, previousRoomId);
    }

    g.committed = { roomId, zoneId: zoneId ?? null, occupancy };
    g.committedSince = this.now();

    if (roomId && occupancy === 'inside') {
      this.indexGuest(guestId, roomId, zoneId ?? null, g.committedSince);
    }

    /** @type {ZoneOccupancyEvent} */
    const event = {
      type: 'zone.occupancy',
      guestId,
      roomId,
      zoneId: zoneId ?? null,
      occupancy,
      previousOccupancy,
      previousRoomId,
      previousZoneId,
      source,
      timestamp: g.committedSince,
    };
    this.callbacks.onOccupancyCommitted?.(event);

    if (occupancy === 'inside' && roomId) {
      this.startDwell(guestId, roomId);
    }
    if (occupancy !== 'inside' && previousOccupancy === 'inside' && previousRoomId) {
      this.pauseDwell(guestId, previousRoomId);
    }
  }

  indexGuest(guestId, roomId, zoneId, sinceTs) {
    if (!this.byRoom.has(roomId)) this.byRoom.set(roomId, new Map());
    const existing = this.byRoom.get(roomId).get(guestId);
    // Keep the original arrival time across zone changes within the room, so
    // lock transfer still goes to the longest-present occupant.
    this.byRoom.get(roomId).set(guestId, { zoneId, sinceTs: existing?.sinceTs ?? sinceTs });
  }

  unindexGuest(guestId, roomId) {
    this.byRoom.get(roomId)?.delete(guestId);
  }

  holdMsForStep(committed, target) {
    const roomConfig = this.roomLocationConfig(target.roomId ?? committed.roomId);
    if (target.occupancy === 'inside') {
      return roomConfig.entryConfirmMs ?? this.config.entryConfirmMs ?? DEFAULTS.entryConfirmMs;
    }
    return roomConfig.exitConfirmMs ?? this.config.exitConfirmMs ?? DEFAULTS.exitConfirmMs;
  }

  roomLocationConfig(roomId) {
    if (!roomId) return {};
    return this.roomDefs[roomId]?.location ?? {};
  }

  startDwell(guestId, roomId) {
    const key = `${guestId}:${roomId}`;
    const existing = this.dwell.get(key);
    if (existing?.insideSince != null) return;
    this.dwell.set(key, {
      insideSince: this.now(),
      accumulatedMs: existing?.accumulatedMs ?? 0,
      seenEmitted: existing?.seenEmitted ?? false,
    });
  }

  pauseDwell(guestId, roomId) {
    const key = `${guestId}:${roomId}`;
    const d = this.dwell.get(key);
    if (!d || d.insideSince == null) return;
    const elapsed = this.now() - d.insideSince;
    d.insideSince = null;
    const accumulate = this.roomDefs[roomId]?.seen?.accumulate !== false;
    if (!accumulate && !d.seenEmitted) {
      d.accumulatedMs = 0;
      return;
    }
    d.accumulatedMs += elapsed;
  }

  updateDwell(guestId, now = this.now()) {
    const g = this.guests.get(guestId);
    if (!g || g.committed.occupancy !== 'inside' || !g.committed.roomId) return;

    const roomId = g.committed.roomId;
    const key = `${guestId}:${roomId}`;
    const d = this.dwell.get(key);
    if (!d || d.seenEmitted) return;

    const threshold = this.roomDefs[roomId]?.seen?.dwellMs ?? 20000;
    const total = d.accumulatedMs + (d.insideSince != null ? now - d.insideSince : 0);
    if (total < threshold) return;

    d.seenEmitted = true;
    this.callbacks.onRoomSeen?.({ guestId, roomId, dwellMs: total, at: now });
  }
}

/**
 * The single step to take next, or null when already where we want to be.
 *
 * Moving between rooms still takes two commits — you leave the first before you
 * enter the second — so a guest is never recorded in two rooms at once.
 *
 * @param {{ roomId: string | null, zoneId: string | null, occupancy: Occupancy }} committed
 * @param {{ roomId: string | null, zoneId: string | null, occupancy: Occupancy }} desired
 */
export function nextStep(committed, desired) {
  const desiredRoom = desired.occupancy === 'inside' ? desired.roomId : null;
  const desiredOccupancy = desiredRoom ? 'inside' : 'outside';
  const desiredZone = desiredRoom ? desired.zoneId ?? null : null;

  if (
    committed.roomId === desiredRoom
    && committed.occupancy === desiredOccupancy
    && committed.zoneId === desiredZone
  ) {
    return null;
  }

  // Leave the current room before entering any other.
  if (committed.roomId && committed.roomId !== desiredRoom) {
    return { roomId: committed.roomId, zoneId: null, occupancy: /** @type {Occupancy} */ ('outside') };
  }

  if (desiredRoom) {
    return { roomId: desiredRoom, zoneId: desiredZone, occupancy: /** @type {Occupancy} */ ('inside') };
  }

  return { roomId: null, zoneId: null, occupancy: /** @type {Occupancy} */ ('outside') };
}

function createGuestOccupancy(guestId) {
  return {
    guestId,
    committed: { roomId: null, zoneId: null, occupancy: /** @type {Occupancy} */ ('outside') },
    committedSince: null,
    desired: { roomId: null, zoneId: null, occupancy: /** @type {Occupancy} */ ('outside') },
    pending: null,
    source: 'virtual',
    lastContactAt: 0,
    connected: true,
  };
}
