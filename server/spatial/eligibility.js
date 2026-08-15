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
  /** The room is on the guest's assigned path. */
  goldenPath({ guest, roomId, show, params }) {
    const path = show.paths?.definitions?.[guest.pathId];
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
