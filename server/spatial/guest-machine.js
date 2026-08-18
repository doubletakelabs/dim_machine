import { enteredEvent, AUTHORED_GUEST_REGIONS } from './contract.js';

/** Where a guest is before they have entered anything. */
export const OUTSIDE = 'outside';
export const EXITED_EVENT = 'exited';

/**
 * Builds the guest statechart from the show.
 *
 * Three parallel regions, from two sources:
 *
 * - `location` is **generated** from room adjacency. It is a map of the
 *   building, and authoring it would mean writing the same adjacency twice and
 *   letting the two drift.
 * - `guidance` and `adherence` are **authored**. Guidance is the journey — the
 *   small, readable chart an author reasons about — and adherence is whether
 *   the guest is still following it.
 *
 * The regions are parallel because the facts are independent: a timer can move
 * guidance to `converge` while the guest stands in the Data Center, and a guest
 * can wander back to the museum without guidance changing its mind.
 */
export function buildGuestMachine(def) {
  const rooms = def.rooms ?? {};
  const authored = def.guest?.machine ?? {};
  const states = { location: buildLocationRegion(rooms) };

  for (const region of AUTHORED_GUEST_REGIONS) {
    if (authored[region]) states[region] = normaliseRegion(authored[region]);
  }

  return { id: 'guest', type: 'parallel', states };
}

/**
 * One state per room, plus `outside`.
 *
 * Adjacency transitions live on each room state so the generated chart reads as
 * the building. The same transitions repeated at the region root are what make
 * the guest machine *always* able to follow the coordinator: a guest who turns
 * up somewhere they could not have walked to — a misread beacon, an operator
 * dragging a dot — still has somewhere to be. The deeper transition wins where
 * both apply, so the adjacency version is used whenever the move was plausible.
 */
function buildLocationRegion(rooms) {
  const roomIds = Object.keys(rooms);
  const states = { [OUTSIDE]: { on: {} } };

  for (const roomId of roomIds) {
    const on = {};
    for (const neighbour of rooms[roomId]?.adjacent ?? []) {
      if (roomIds.includes(neighbour)) on[enteredEvent(neighbour)] = neighbour;
    }
    states[roomId] = { on };
  }

  const recovery = {};
  for (const roomId of roomIds) recovery[enteredEvent(roomId)] = `.${roomId}`;
  recovery[EXITED_EVENT] = `.${OUTSIDE}`;
  for (const roomId of roomIds) states[roomId].on[EXITED_EVENT] = `#guest.location.${OUTSIDE}`;

  return { initial: OUTSIDE, on: recovery, states };
}

/**
 * XState v5 wants action parameters under `params`. Authors write the flatter
 * `{ type, from, strategy }`, so normalise rather than making them nest it.
 */
function normaliseRegion(region) {
  const states = {};
  for (const [stateId, state] of Object.entries(region.states ?? {})) {
    states[stateId] = { ...state, ...(state.entry ? { entry: normaliseActions(state.entry) } : {}) };
  }
  return { ...region, states };
}

function normaliseActions(entry) {
  return [].concat(entry).map((action) => {
    if (typeof action === 'string' || action?.params) return action;
    const { type, ...params } = action;
    return { type, params };
  });
}

/** `region.state` → the value the actor reports for that region. */
export function regionState(snapshot, region) {
  const value = snapshot?.value;
  if (!value || typeof value !== 'object') return null;
  const branch = value[region];
  if (branch == null) return null;
  return typeof branch === 'string' ? branch : Object.keys(branch)[0] ?? null;
}
