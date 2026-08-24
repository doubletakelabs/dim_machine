/**
 * Per-guest state (spec §3.2, §3.6).
 *
 * This is deliberately a separate module even though it is still plain state:
 * a guest statechart arrives with phases and adherence, which are the two
 * genuinely mode-shaped things about a guest. Where they *are* is a variable,
 * not a state, and lives here.
 *
 * The coordinator owns the occupancy *relation* (who is where, for how long).
 * The guest owns what that movement *means* to them: what they have seen, where
 * they are in the show, how far they have strayed. `roomId` / `occupancy` here
 * are a read-model of the coordinator, never the source of truth.
 */
export class Guest {
  /**
   * @param {{ guestId: string, token: string, label: string, pathId?: string|null }} init
   */
  constructor(init) {
    this.guestId = init.guestId;
    this.token = init.token;
    this.label = init.label;
    this.pathId = init.pathId;
    /** Mirror of the guest machine's parallel regions. */
    this.regions = { location: 'outside', guidance: null, adherence: null };
    this.adherence = /** @type {'golden' | 'drifting' | 'cursed'} */ ('golden');
    this.adherenceScore = 0;
    this.connected = true;
    /**
     * Whether a phone is actually attached to this guest right now.
     *
     * Distinct from `connected`, which is about location contact and is true
     * for a guest the operator spawned to drag around the plan. This one
     * answers "is there a person holding a handset" — which is the difference
     * between a question the show can wait on and one nobody will ever answer.
     */
    this.hasPhone = false;
    // Read-model of coordinator occupancy.
    this.roomId = /** @type {string | null} */ (null);
    this.zoneId = /** @type {string | null} */ (null);
    this.occupancy = /** @type {'outside' | 'inside'} */ ('outside');
    /** @type {Record<string, VisitRecord>} */
    this.visitHistory = {};
  }

  /** @param {string} roomId */
  history(roomId) {
    if (!this.visitHistory[roomId]) {
      this.visitHistory[roomId] = {
        roomId,
        firstEnteredAt: null,
        totalDwellMs: 0,
        visits: 0,
        seen: false,
        completed: false,
        activatedByMe: false,
      };
    }
    return this.visitHistory[roomId];
  }

  /**
   * Mirror a committed coordinator occupancy event.
   * @param {import('./coordinator.js').ZoneOccupancyEvent} event
   */
  applyOccupancy(event) {
    const enteredRoom = event.occupancy === 'inside'
      && event.roomId
      && event.roomId !== event.previousRoomId;

    this.roomId = event.roomId;
    this.zoneId = event.zoneId;
    this.occupancy = event.occupancy;

    // Moving between zones of one room is not a new visit.
    if (enteredRoom) {
      const record = this.history(event.roomId);
      record.visits += 1;
      record.firstEnteredAt ??= event.timestamp;
    }
  }

  /** @param {{ roomId: string, dwellMs: number, at: number }} payload */
  recordSeen({ roomId, dwellMs, at }) {
    const record = this.history(roomId);
    record.totalDwellMs = dwellMs;
    record.seen = true;
    record.lastSeenAt = at;
    return record;
  }

  /** @param {string} roomId */
  recordActivation(roomId) {
    this.history(roomId).activatedByMe = true;
  }

  /** Rooms this guest has seen — the basis for phase advance (§4.1). */
  seenRoomIds() {
    return Object.values(this.visitHistory).filter((r) => r.seen).map((r) => r.roomId);
  }

  snapshot() {
    return {
      guestId: this.guestId,
      token: this.token,
      label: this.label,
      pathId: this.pathId,
      regions: this.regions,
      adherence: this.adherence,
      adherenceScore: this.adherenceScore,
      roomId: this.roomId,
      zoneId: this.zoneId,
      occupancy: this.occupancy,
      connected: this.connected,
      hasPhone: this.hasPhone,
      visitHistory: this.visitHistory,
    };
  }
}

/**
 * @typedef {Object} VisitRecord
 * @property {string} roomId
 * @property {number | null} firstEnteredAt
 * @property {number} totalDwellMs
 * @property {number} visits
 * @property {boolean} seen
 * @property {boolean} completed
 * @property {boolean} activatedByMe
 * @property {number} [lastSeenAt]
 */
