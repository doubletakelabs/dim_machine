/**
 * Eligibility strategies (spec §3.2).
 *
 * A pluggable predicate owned by the guest actor, never by the room. This is
 * the seam that lets a future show swap assigned paths for roles without
 * touching a room definition, the coordinator, or the location layer — a new
 * access mechanism is a new function in this file and nothing else.
 *
 * @typedef {Object} EligibilityContext
 * @property {import('./guest.js').Guest} guest
 * @property {string} roomId
 * @property {object} show — the loaded show definition
 * @property {object} params — the strategy's own config block
 */

/** @type {Record<string, (ctx: EligibilityContext) => boolean>} */
const STRATEGIES = {
  /**
   * The room is on the guest's assigned path — but only among rooms that paths
   * route through at all.
   *
   * A show is rarely paths end to end. This one has a shared prologue, a museum
   * where paths apply, and a free-roam area after; only the museum rooms appear
   * in any path. Treating an unrouted room as "not yours" would make the
   * entrance sequence ineligible for everybody, and would leave a guest with no
   * path assigned yet — every guest, for the whole prologue — locked out of the
   * entire show. So paths gate only what they actually route.
   */
  goldenPath({ guest, roomId, show, params }) {
    if (!routedRooms(show).has(roomId)) return true;
    const path = show.paths?.[guest.pathId];
    if (!path?.rooms?.includes(roomId)) return false;
    // A path room they have already seen stays open unless the show says
    // otherwise — most shows want people to be able to wander back in.
    if (params.allowRevisit === false && guest.history(roomId).seen) return false;
    return true;
  },

  /** Every room is open. Useful for rehearsal and for single-path shows. */
  all() {
    return true;
  },

  /** Nothing is open. */
  none() {
    return false;
  },
};

/** Every room any path routes through. Cached per show definition. */
const routedCache = new WeakMap();
export function routedRooms(show) {
  if (!routedCache.has(show)) {
    routedCache.set(show, new Set(Object.values(show.paths ?? {}).flatMap((p) => p.rooms ?? [])));
  }
  return routedCache.get(show);
}

/**
 * Strategies this build can actually evaluate.
 *
 * The contract declares more (`roleBased`, `progressGated`, `inverted`,
 * `custom`) for shows yet to be written. Loading a show that names one of those
 * is a load error rather than a warning: an eligibility predicate that silently
 * returned the wrong answer would lock guests out of every room, and it would
 * look like a location bug.
 */
export const IMPLEMENTED_ELIGIBILITY_STRATEGIES = Object.keys(STRATEGIES);

/**
 * @param {string} name
 * @returns {(ctx: EligibilityContext) => boolean}
 */
export function eligibilityStrategy(name) {
  return STRATEGIES[name] ?? null;
}

/**
 * Resolve which eligibility config applies to a guest right now.
 *
 * Today that is always `golden`. Adherence-driven variants (a strayed guest
 * getting a different predicate) hang off this function once A7 lands, which is
 * why the lookup exists rather than reading `eligibility.golden` directly.
 */
export function eligibilityConfigFor(guest, show) {
  const eligibility = show.guest?.eligibility ?? {};
  return eligibility[guest.adherence] ?? eligibility.golden ?? { strategy: 'goldenPath' };
}
