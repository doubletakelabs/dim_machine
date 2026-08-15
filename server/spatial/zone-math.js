/** @typedef {'outside' | 'inside'} Occupancy */

const OCCUPANCY_RANK = { outside: 0, inside: 1 };

/**
 * Ray-casting point-in-polygon (floor-plan coords).
 * @param {[number, number]} point
 * @param {[number, number][]} polygon
 */
export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Classify a floor-plan point against every room's zones.
 *
 * A room may own several zones — a long gallery, an alcove, a space split by a
 * structural wall. Occupancy is reported at the *room* level, because that is
 * what the show reasons about; the zone is carried alongside for diagnostics
 * and for future in-room positioning.
 *
 * @param {Record<string, { zones?: Record<string, { polygon?: [number, number][] }> }>} rooms
 * @param {number} x
 * @param {number} y
 * @returns {{ roomId: string | null, zoneId: string | null, occupancy: Occupancy }}
 */
export function classifyPoint(rooms, x, y) {
  const point = /** @type {[number, number]} */ ([x, y]);
  for (const [roomId, room] of Object.entries(rooms ?? {})) {
    for (const [zoneId, zone] of Object.entries(room?.zones ?? {})) {
      const polygon = zone?.polygon;
      if (!polygon?.length) continue;
      if (pointInPolygon(point, polygon)) {
        return { roomId, zoneId, occupancy: 'inside' };
      }
    }
  }
  return { roomId: null, zoneId: null, occupancy: 'outside' };
}

/** Every zone id in a show, mapped to the room that owns it. */
export function zoneIndex(rooms) {
  const index = new Map();
  for (const [roomId, room] of Object.entries(rooms ?? {})) {
    for (const zoneId of Object.keys(room?.zones ?? {})) {
      index.set(zoneId, roomId);
    }
  }
  return index;
}

export function occupancyRank(occupancy) {
  return OCCUPANCY_RANK[occupancy] ?? 0;
}

/**
 * Area centroid of a polygon, falling back to the vertex mean for degenerate
 * shapes. Used to aim a simulated guest at a room and to place a dot for a
 * guest whose location came from a beacon rather than a floor-plan drag.
 *
 * @param {[number, number][]} polygon
 * @returns {[number, number] | null}
 */
export function polygonCentroid(polygon) {
  if (!polygon?.length) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  area /= 2;
  if (!area) {
    const sum = polygon.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / polygon.length, sum[1] / polygon.length];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/**
 * Where to aim for a room — the centroid of its largest zone, so a guest walking
 * to a room with a big hall and a small alcove heads for the hall.
 *
 * @returns {[number, number] | null}
 */
export function roomCentroid(room) {
  let best = null;
  let bestArea = -1;
  for (const zone of Object.values(room?.zones ?? {})) {
    const polygon = zone?.polygon;
    if (!polygon?.length) continue;
    const area = Math.abs(polygonArea(polygon));
    if (area > bestArea) {
      bestArea = area;
      best = polygonCentroid(polygon);
    }
  }
  return best;
}

function polygonArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/**
 * Where a guest stands inside a room, given a slot number.
 *
 * Slots are laid out as a phyllotaxis spiral — the golden angle, radius growing
 * as sqrt(n) — which is the arrangement that keeps every point roughly
 * equidistant from its neighbours. Picking a random angle per guest instead
 * gives *distinct* points that are still frequently on top of each other, which
 * is the thing this is supposed to prevent: you cannot count a crowd whose dots
 * overlap.
 *
 * Deterministic in the slot, so a guest holds their spot frame to frame.
 *
 * @param {object} room
 * @param {number} slot — stable per guest; see `slotForGuest`
 * @param {number} [slots] — how many the room is laid out for
 * @returns {[number, number] | null}
 */
export function roomStandingSpot(room, slot = 0, slots = 12) {
  const centre = roomCentroid(room);
  if (!centre) return null;
  const zone = largestZone(room);
  if (!zone) return centre;

  const box = polygonBox(zone.polygon);
  // Stay clear of the walls, and of the room's own label.
  const maxRadius = Math.max(8, (Math.min(box.width, box.height) / 2) * 0.78);
  const n = Math.max(0, Math.floor(slot));
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  // Clamped: past the layout's capacity the spiral would grow straight through
  // the walls. Overflow packs onto the outer edge instead, still spread by the
  // golden angle — tighter than ideal, but inside the room.
  const radius = maxRadius * Math.min(1, Math.sqrt((n + 0.5) / Math.max(1, slots)));
  const angle = n * GOLDEN_ANGLE;
  return [centre[0] + Math.cos(angle) * radius, centre[1] + Math.sin(angle) * radius];
}

/**
 * A guest's slot, stable for the life of the show.
 *
 * Indexed across every guest rather than per room, so nobody's dot shifts when
 * someone else arrives or leaves — the alternative, numbering occupants as they
 * come and go, makes the whole room rearrange itself every time one person
 * walks out.
 *
 * @param {string[]} allGuestIds
 * @param {string} guestId
 */
export function slotForGuest(allGuestIds, guestId) {
  const index = [...allGuestIds].sort().indexOf(guestId);
  return index < 0 ? 0 : index;
}

function largestZone(room) {
  let best = null;
  let bestArea = -1;
  for (const zone of Object.values(room?.zones ?? {})) {
    if (!zone?.polygon?.length) continue;
    const area = Math.abs(polygonArea(zone.polygon));
    if (area > bestArea) { bestArea = area; best = zone; }
  }
  return best;
}

function polygonBox(polygon) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Bounding box of every zone in the show — the floor plan's natural extent. */
export function floorPlanExtent(rooms) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const room of Object.values(rooms ?? {})) {
    for (const zone of Object.values(room?.zones ?? {})) {
      for (const [x, y] of zone?.polygon ?? []) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
