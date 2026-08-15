import { classifyPoint } from './zone-math.js';

/**
 * Virtual walkthrough adapter — floor-plan coords → coordinator desired occupancy.
 *
 * Produces exactly the events BLE will, so dragging a dot exercises the real
 * code path (spec §5.4).
 */
export class VirtualLocationAdapter {
  /**
   * @param {{ rooms: Record<string, object>, coordinator: import('./coordinator.js').OccupancyCoordinator }} opts
   */
  constructor(opts) {
    this.rooms = opts.rooms;
    this.coordinator = opts.coordinator;
    /**
     * Last floor-plan point per guest. Virtual-only by nature: a guest located
     * by a beacon has a room but no coordinates, and the floor plan falls back
     * to the room centroid for them.
     * @type {Map<string, { x: number, y: number }>}
     */
    this.positions = new Map();
  }

  /**
   * @param {string} guestId
   * @param {number} x
   * @param {number} y
   */
  setPosition(guestId, x, y) {
    this.positions.set(guestId, { x, y });
    const { roomId, zoneId, occupancy } = classifyPoint(this.rooms, x, y);
    this.coordinator.setDesired(guestId, roomId, occupancy, 'virtual', zoneId);
  }

  getPosition(guestId) {
    return this.positions.get(guestId) ?? null;
  }

  forget(guestId) {
    this.positions.delete(guestId);
  }

  /**
   * Operator placement straight into a room, without floor-plan coordinates.
   * @param {string} guestId
   * @param {string | null} roomId
   * @param {'outside' | 'inside'} occupancy
   */
  setOccupancy(guestId, roomId, occupancy) {
    this.coordinator.setDesired(guestId, roomId, occupancy, 'operator', null);
  }
}
