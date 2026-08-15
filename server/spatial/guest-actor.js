import { eligibilityStrategy, eligibilityConfigFor } from './eligibility.js';

const DEFAULT_INELIGIBLE = { policy: 'ignore' };

/**
 * One per guest (spec §3.2). Owns eligibility, and decides what happens when
 * this guest walks into a room.
 *
 * Deliberately not an XState actor yet. A statechart earns its place when there
 * are modes that reinterpret the same input; the two genuinely mode-shaped
 * things about a guest — phase and adherence — arrive in A6/A7, and this class
 * is where they will live. Where a guest *is* stays a variable on `Guest`.
 *
 * The asymmetry with rooms is the point of the whole v0.3 model: this actor and
 * the room actor both see the same entry event, and react differently. An
 * ineligible entry produces a response here and no change at all there.
 */
export class GuestActor {
  /**
   * @param {object} opts
   * @param {import('./guest.js').Guest} opts.guest
   * @param {object} opts.show — loaded show definition
   * @param {(roomId: string, context: object) => object} opts.requestActivation
   * @param {(roomId: string) => object | null} opts.roomSnapshot
   * @param {(event: object) => void} [opts.appendEvent]
   */
  constructor(opts) {
    this.guest = opts.guest;
    this.show = opts.show;
    this.requestActivation = opts.requestActivation;
    this.roomSnapshot = opts.roomSnapshot ?? (() => null);
    this.appendEvent = opts.appendEvent ?? (() => {});
  }

  get guestId() {
    return this.guest.guestId;
  }

  /** Is this room open to this guest right now? */
  isEligible(roomId) {
    const config = eligibilityConfigFor(this.guest, this.show);
    const strategy = eligibilityStrategy(config.strategy ?? 'goldenPath');
    if (!strategy) return false;
    return strategy({
      guest: this.guest,
      roomId,
      show: this.show,
      params: config.params ?? {},
    });
  }

  /** Every room currently open to this guest — for the operator panel. */
  eligibleRoomIds() {
    return Object.keys(this.show.rooms ?? {}).filter((roomId) => this.isEligible(roomId));
  }

  /** What this room declares should happen to a guest it is not for (§3.4). */
  ineligibleResponse(roomId) {
    const declared = this.show.rooms?.[roomId]?.ineligible ?? DEFAULT_INELIGIBLE;
    return { policy: declared.policy ?? 'ignore', audio: declared.audio ?? null };
  }

  /**
   * A committed occupancy change for this guest.
   * @param {import('./coordinator.js').ZoneOccupancyEvent} event
   */
  handleOccupancy(event) {
    if (event.guestId !== this.guestId) return null;
    const enteredRoom = event.occupancy === 'inside'
      && event.roomId
      && event.roomId !== event.previousRoomId;
    if (event.previousRoomId && event.previousRoomId !== event.roomId) {
      this.guest.lastEntry = null;
    }
    // Crossing between two zones of one room is not an arrival.
    if (!enteredRoom) return null;
    return this.enterRoom(event.roomId);
  }

  /**
   * Walking in is the trigger — there is nothing to press. Which means a false
   * positive from the location layer commits the physical layer with no human
   * in the loop, and is why entry is confirmed before it commits (§5.2).
   *
   * @param {string} roomId
   */
  enterRoom(roomId) {
    if (!this.isEligible(roomId)) return this.enterIneligible(roomId);

    const room = this.roomSnapshot(roomId);
    if (room?.lockHolder === this.guestId) {
      // Already ours — a resumed room, or a re-entry that never released.
      return this.record(roomId, { outcome: 'alreadyActive', state: room.state });
    }

    const history = this.guest.history(roomId);
    const result = this.requestActivation(roomId, {
      seen: history.seen,
      completed: history.completed,
      activatedByMe: history.activatedByMe,
    });

    if (result.ok) {
      this.appendEvent({ type: 'guest.activatedRoom', guestId: this.guestId, roomId });
      return this.record(roomId, { outcome: 'activated', state: result.state });
    }

    // Eligible, but the room would not take us. `locked` means someone else is
    // inside and running it — what this guest gets instead is the room's
    // multiGuest policy, which A5 implements. Recorded now so the decision is
    // visible in the operator panel rather than looking like nothing happened.
    const multiGuest = this.show.rooms?.[roomId]?.multiGuest ?? {};
    this.appendEvent({
      type: 'guest.activationRefused',
      guestId: this.guestId,
      roomId,
      reason: result.reason,
      multiGuestPolicy: multiGuest.policy ?? null,
    });
    return this.record(roomId, {
      outcome: 'refused',
      reason: result.reason,
      multiGuestPolicy: multiGuest.policy ?? null,
    });
  }

  /**
   * The room became theirs without them asking, because the holder left.
   *
   * Their own record still says `refused` from when they walked in, which is no
   * longer true and reads as a contradiction next to a room that names them as
   * its holder. It also counts as having activated it: the room is running for
   * them now, which is what that flag is asking.
   */
  inheritRoom(roomId) {
    this.guest.recordActivation(roomId);
    this.appendEvent({ type: 'guest.inheritedRoom', guestId: this.guestId, roomId });
    return this.record(roomId, { outcome: 'inherited' });
  }

  enterIneligible(roomId) {
    const response = this.ineligibleResponse(roomId);
    // The room actor hears nothing about this. No lock, no activation, no room
    // history — the entire response is on the guest's phone (Phase B).
    this.appendEvent({
      type: 'guest.ineligibleEntry',
      guestId: this.guestId,
      roomId,
      policy: response.policy,
      audio: response.audio,
    });
    return this.record(roomId, { outcome: 'ineligible', ...response });
  }

  record(roomId, detail) {
    this.guest.lastEntry = { roomId, ...detail };
    return this.guest.lastEntry;
  }

  snapshot() {
    return {
      eligibleRooms: this.eligibleRoomIds(),
      lastEntry: this.guest.lastEntry ?? null,
    };
  }
}
