import { createMachine, createActor } from 'xstate';
import { eligibilityStrategy, eligibilityConfigFor, routedRooms } from './eligibility.js';
import { enteredEvent } from './contract.js';
import { OUTSIDE, EXITED_EVENT, regionState } from './guest-machine.js';
import { systemClock } from './clock.js';

const DEFAULT_INELIGIBLE = { policy: 'ignore' };

/**
 * One per guest (spec §3.2). Owns the guest statechart, eligibility, and what
 * happens when this guest walks into a room.
 *
 * The asymmetry with rooms is the point of the whole v0.3 model: this actor and
 * the room actor both see the same entry event and react differently.
 */
export class GuestActor {
  /**
   * @param {object} opts
   * @param {import('./guest.js').Guest} opts.guest
   * @param {object} opts.show — loaded show definition
   * @param {object} opts.machineConfig — from buildGuestMachine, shared by all guests
   * @param {(roomId: string, context: object) => object} opts.requestActivation
   * @param {(roomId: string) => object | null} opts.roomSnapshot
   * @param {(from: string[]) => string} opts.assignPath — runtime owns the rotation
   * @param {object} [opts.clock]
   * @param {(event: object) => void} [opts.appendEvent]
   * @param {() => void} [opts.onStateChange]
   */
  constructor(opts) {
    this.guest = opts.guest;
    this.show = opts.show;
    this.machineConfig = opts.machineConfig;
    this.requestActivation = opts.requestActivation;
    this.roomSnapshot = opts.roomSnapshot ?? (() => null);
    this.assignPath = opts.assignPath ?? (() => null);
    this.clock = opts.clock ?? systemClock;
    this.appendEvent = opts.appendEvent ?? (() => {});
    this.onStateChange = opts.onStateChange ?? (() => {});
    this.actor = null;
    this._unsub = null;
    /** Timer handles by id, so a started timer is never started twice. */
    this._timers = new Map();
    /**
     * Rooms any path routes through. Entering one of these that is not on your
     * own path is going off-path; entering anything else — a corridor, a room
     * from an earlier part of the journey — is not. That is what confines the
     * off-path notion to the part of the show where a path is being led.
     */
    this.routedRooms = routedRooms(this.show);
  }

  get guestId() {
    return this.guest.guestId;
  }

  start() {
    this.stop();
    const machine = createMachine(this.machineConfig).provide({
      actions: {
        assignPath: (_ctx, params) => this.applyAssignPath(params),
      },
    });
    this.actor = createActor(machine, { clock: this.clock });
    this._unsub = this.actor.subscribe(() => {
      this.syncRegions();
      this.onStateChange();
    });
    this.actor.start();
    this.syncRegions();
  }

  stop() {
    for (const handle of this._timers.values()) this.clock.clearTimeout(handle);
    this._timers.clear();
    this._unsub?.unsubscribe?.();
    this._unsub = null;
    if (this.actor) {
      try { this.actor.stop(); } catch {}
      this.actor = null;
    }
  }

  send(event) {
    if (!this.actor) return;
    this.actor.send(typeof event === 'string' ? { type: event } : event);
  }

  regions() {
    const snap = this.actor?.getSnapshot();
    return {
      location: regionState(snap, 'location') ?? OUTSIDE,
      guidance: regionState(snap, 'guidance'),
      adherence: regionState(snap, 'adherence'),
    };
  }

  /** Mirror the machine onto the guest record, and arm any timers now due. */
  syncRegions() {
    const regions = this.regions();
    this.guest.regions = regions;
    this.startDueTimers(regions);
  }

  // ── declared timers ─────────────────────────────────────────────────────

  /**
   * `after` measures time since a state was last entered, so a guest who left
   * the museum and came back would restart it. These are total elapsed since
   * the state was *first* entered, and keep running through anything.
   */
  startDueTimers(regions) {
    for (const [timerId, timer] of Object.entries(this.show.guest?.timers ?? {})) {
      if (this._timers.has(timerId)) continue;
      const [region, stateId] = String(timer.sinceEntering ?? '').split('.');
      if (regions[region] !== stateId) continue;
      const handle = this.clock.setTimeout(() => {
        this._timers.delete(timerId);
        this.appendEvent({ type: 'guest.timer', guestId: this.guestId, timerId, event: timer.event });
        this.send(timer.event);
        this.onStateChange();
      }, timer.afterMs);
      this._timers.set(timerId, handle);
    }
  }

  // ── eligibility ─────────────────────────────────────────────────────────

  isEligible(roomId) {
    if ((this.show.rooms?.[roomId]?.kind ?? 'destination') === 'hallway') return true;
    const config = eligibilityConfigFor(this.guest, this.show);
    const strategy = eligibilityStrategy(config.strategy ?? 'goldenPath');
    if (!strategy) return false;
    return strategy({ guest: this.guest, roomId, show: this.show, params: config.params ?? {} });
  }

  eligibleRoomIds() {
    return Object.keys(this.show.rooms ?? {}).filter((roomId) => this.isEligible(roomId));
  }

  /** Next unvisited room on the assigned path — where guidance is pointing. */
  guidanceTarget() {
    const path = this.show.paths?.[this.guest.pathId];
    if (!path?.rooms?.length) return null;
    return path.rooms.find((roomId) => !this.guest.history(roomId).seen) ?? null;
  }

  ineligibleResponse(roomId) {
    const declared = this.show.rooms?.[roomId]?.ineligible ?? DEFAULT_INELIGIBLE;
    return { policy: declared.policy ?? 'ignore', audio: declared.audio ?? null };
  }

  // ── spatial ─────────────────────────────────────────────────────────────

  /** @param {import('./coordinator.js').ZoneOccupancyEvent} event */
  handleOccupancy(event) {
    if (event.guestId !== this.guestId) return null;

    const enteredRoom = event.occupancy === 'inside'
      && event.roomId
      && event.roomId !== event.previousRoomId;
    const left = event.previousRoomId && event.previousRoomId !== event.roomId;

    if (left) this.guest.lastEntry = null;

    // The machine follows the coordinator, always — including moves that could
    // not have happened, which the runtime flags separately.
    if (enteredRoom) this.send(enteredEvent(event.roomId));
    else if (event.occupancy !== 'inside' && left) this.send(EXITED_EVENT);

    if (!enteredRoom) return null;
    return this.enterRoom(event.roomId);
  }

  enterRoom(roomId) {
    if ((this.show.rooms?.[roomId]?.kind ?? 'destination') === 'hallway') {
      return this.record(roomId, { outcome: 'passingThrough' });
    }
    this.checkOffPath(roomId);
    if (!this.isEligible(roomId)) return this.enterIneligible(roomId);

    const room = this.roomSnapshot(roomId);
    if (room?.lockHolder === this.guestId) {
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

    const multiGuest = this.show.rooms?.[roomId]?.multiGuest ?? {};
    this.appendEvent({
      type: 'guest.activationRefused',
      guestId: this.guestId, roomId, reason: result.reason,
      multiGuestPolicy: multiGuest.policy ?? null,
    });
    return this.record(roomId, {
      outcome: 'refused', reason: result.reason, multiGuestPolicy: multiGuest.policy ?? null,
    });
  }

  /**
   * Going off-path is one-way: the tour goes off the rails and stays off.
   *
   * It only applies among the rooms paths actually route through. Wandering
   * back to an earlier part of the show, or through a corridor, is not a
   * deviation — there is no path being led there to deviate from.
   */
  checkOffPath(roomId) {
    if (this.regions().adherence !== 'onPath') return;
    if (!this.guest.pathId || !this.routedRooms.has(roomId)) return;
    const path = this.show.paths?.[this.guest.pathId];
    if (path?.rooms?.includes(roomId)) return;

    this.send('wentOffPath');
    this.appendEvent({
      type: 'guest.wentOffPath',
      guestId: this.guestId,
      roomId,
      target: this.guidanceTarget(),
      pathId: this.guest.pathId,
    });
  }

  /**
   * A room they were not sent to. Most stay dark — but a room declaring
   * `activateVariant` reacts, in its own variant state, and the guest holds it.
   */
  enterIneligible(roomId) {
    const response = this.ineligibleResponse(roomId);

    if (response.policy === 'activateVariant') {
      const result = this.requestActivation(roomId, { offPath: true });
      if (result.ok) {
        this.appendEvent({ type: 'guest.activatedRoom', guestId: this.guestId, roomId, offPath: true });
        return this.record(roomId, { outcome: 'activatedVariant', state: result.state });
      }
      return this.record(roomId, { outcome: 'refused', reason: result.reason, ...response });
    }

    this.appendEvent({
      type: 'guest.ineligibleEntry',
      guestId: this.guestId, roomId, policy: response.policy, audio: response.audio,
    });
    return this.record(roomId, { outcome: 'ineligible', ...response });
  }

  inheritRoom(roomId) {
    this.guest.recordActivation(roomId);
    this.appendEvent({ type: 'guest.inheritedRoom', guestId: this.guestId, roomId });
    return this.record(roomId, { outcome: 'inherited' });
  }

  applyAssignPath(params) {
    const pathId = this.assignPath(params?.from ?? [], params?.strategy ?? 'roundRobin');
    if (!pathId) return;
    this.guest.pathId = pathId;
    this.appendEvent({ type: 'guest.pathAssigned', guestId: this.guestId, pathId });
  }

  record(roomId, detail) {
    this.guest.lastEntry = { roomId, ...detail };
    return this.guest.lastEntry;
  }

  snapshot() {
    return {
      regions: this.regions(),
      eligibleRooms: this.eligibleRoomIds(),
      guidanceTarget: this.guidanceTarget(),
      lastEntry: this.guest.lastEntry ?? null,
    };
  }
}
