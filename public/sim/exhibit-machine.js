/**
 * The exhibit machine — one guest's relationship with one DIM room.
 *
 * EXPERIMENTAL (team meeting, 2026-08-27). This models the audio journey the
 * team sketched, as a pure transition function so the logic can be argued
 * with, tested, and — only if it survives BLE contact — ported into the
 * runtime. Nothing here touches the show; the simulator drives it with a
 * draggable dot, and the real thing would drive it with location events.
 *
 * The guest's story, as told by which stem plays:
 *
 *   approach the room (threshold zone)      → "Exhibit Approach"
 *   enter                                   → "Entrance", then "Instruction"
 *   the room runs                           → "Interaction"
 *   it finishes                             → "Complete"
 *
 * And the edges, which are most of the design:
 *
 *   not your room                           → "Approach, No State", then ever after "Return, No State"
 *   walked away from the offer             → "Rejection"           (strike one)
 *   came back                               → "Return Later"        (the second chance)
 *   walked away again                       → locked out, silently — every return is "Return, No State"
 *   abandoned it mid-experience             → locked out
 *   came back after finishing               → "Return after Completion", once — then "Return, No State"
 *
 * Two chances per room, total. A locked-out guest can still physically walk
 * in — nothing here is a door — but the room has no content for them.
 *
 * ## Shape
 *
 * State is `{ phase, memory, allowed }`:
 *
 * `phase` is the current engagement, and dies with it:
 *   away | court        (in threshold, an offer is live)
 *        | thresholdIdle (in threshold, nothing on offer)
 *        | leaving       (left mid-courtship; the walk-away watch is running)
 *        | entrance | instruction | interaction
 *        | insideDone    (in the room with no content running for them)
 *
 * `memory` is what this room remembers about them, and persists:
 *   fresh | noStateHeard | rejectedOnce | secondChance
 *         | lockedOut | completed | completedReturned
 *
 * ## Events
 *
 * From location:  enterThreshold, exitThreshold, enterRoom, exitRoom
 * From the timer: walkedAway   — the harness fires this after the guest has
 *                 been ≥3s clear of the threshold AND is moving away; a
 *                 doorway-flap or a hesitation must never count as rejection
 * From audio:     entranceEnded — Instruction follows Entrance immediately
 * Manual for now: advance (instruction→interaction), complete
 *
 * Deliberate assumptions, flagged for the team:
 * - Leaving during *Entrance* counts as abandonment too, not just during
 *   Instruction/Interaction. (The stem is seconds long; walking out during it
 *   is still walking out.)
 * - Walking away from the second chance locks silently — no second Rejection
 *   stem was specified, and the next approach says everything ("Return, No
 *   State").
 * - A guest can enter the room without the threshold ever registering (BLE
 *   will do this). Entry applies the approach logic on the way in, so the
 *   bookkeeping cannot be skipped by a fast walker or a misread beacon.
 */

export const STEMS = {
  approach: 'exhibit-approach',
  entrance: 'entrance',
  instruction: 'instruction',
  interaction: 'interaction',
  complete: 'complete',
  approachNoState: 'approach-no-state',
  returnNoState: 'return-no-state',
  rejection: 'rejection',
  returnLater: 'return-later',
  returnAfterCompletion: 'return-after-completion',
};

export function initialState({ allowed = true } = {}) {
  return { phase: 'away', memory: 'fresh', allowed };
}

/**
 * @returns {{ state: object, play: string|null, roomActive?: boolean }}
 *   `play` is the stem this transition produces, if any. `roomActive` is set
 *   on the two transitions that flip the room, for the harness to mirror.
 */
export function transition(state, event) {
  const s = { ...state };
  const stay = { state: s, play: null };

  switch (event) {
    case 'enterThreshold': {
      // Coming back from `leaving` resumes the live offer silently — they
      // already heard it this visit, and replaying it punishes hesitation.
      if (s.phase === 'leaving') return { state: { ...s, phase: 'court' }, play: null };
      if (s.phase !== 'away') return stay;
      return approachStem(s);
    }

    case 'exitThreshold': {
      if (s.phase === 'court') return { state: { ...s, phase: 'leaving' }, play: null };
      if (s.phase === 'thresholdIdle') return { state: { ...s, phase: 'away' }, play: null };
      return stay;
    }

    case 'walkedAway': {
      if (s.phase !== 'leaving') return stay;
      if (s.memory === 'fresh') {
        // Strike one. They were invited and they walked away.
        return { state: { ...s, phase: 'away', memory: 'rejectedOnce' }, play: STEMS.rejection };
      }
      if (s.memory === 'secondChance') {
        // Strike two. Silent — the next approach will say it.
        return { state: { ...s, phase: 'away', memory: 'lockedOut' }, play: null };
      }
      return { state: { ...s, phase: 'away' }, play: null };
    }

    case 'enterRoom': {
      // A guest with content on offer begins it.
      if (s.phase === 'court' || s.phase === 'leaving') {
        return { state: { ...s, phase: 'entrance' }, play: STEMS.entrance };
      }
      // A guest the room has nothing for is simply inside.
      if (s.phase === 'thresholdIdle') return { state: { ...s, phase: 'insideDone' }, play: null };
      // Straight in, no threshold registered (a fast walker, a misread
      // beacon): run the approach bookkeeping, then act on what it decided.
      if (s.phase === 'away') {
        const approached = approachStem(s);
        if (approached.state.phase === 'court') {
          // The offer and the acceptance collapse into one step; Entrance is
          // the stem that plays, because they are already through the door.
          return { state: { ...approached.state, phase: 'entrance' }, play: STEMS.entrance };
        }
        return { state: { ...approached.state, phase: 'insideDone' }, play: approached.play };
      }
      return stay;
    }

    case 'entranceEnded': {
      if (s.phase !== 'entrance') return stay;
      return { state: { ...s, phase: 'instruction' }, play: STEMS.instruction };
    }

    case 'advance': {
      if (s.phase !== 'instruction') return stay;
      return { state: { ...s, phase: 'interaction' }, play: STEMS.interaction, roomActive: true };
    }

    case 'complete': {
      if (s.phase !== 'interaction') return stay;
      return {
        state: { ...s, phase: 'insideDone', memory: 'completed' },
        play: STEMS.complete,
        roomActive: false,
      };
    }

    case 'exitRoom': {
      // Leaving before Complete is abandonment, Entrance included — walking
      // out mid-welcome is still walking out. The lock is silent; their next
      // approach says "Return, No State".
      if (['entrance', 'instruction', 'interaction'].includes(s.phase)) {
        return {
          state: { ...s, phase: 'away', memory: 'lockedOut' },
          play: null,
          roomActive: false,
        };
      }
      if (s.phase === 'insideDone') return { state: { ...s, phase: 'away' }, play: null };
      return stay;
    }

    default:
      return stay;
  }
}

/** What approaching this room gets this guest, given everything so far. */
function approachStem(s) {
  if (!s.allowed) {
    if (s.memory === 'fresh') {
      return { state: { ...s, phase: 'thresholdIdle', memory: 'noStateHeard' }, play: STEMS.approachNoState };
    }
    return { state: { ...s, phase: 'thresholdIdle' }, play: STEMS.returnNoState };
  }
  switch (s.memory) {
    case 'fresh':
      return { state: { ...s, phase: 'court' }, play: STEMS.approach };
    case 'rejectedOnce':
      // The second chance is granted by hearing "Return Later" — and it is
      // now the chance in play: walking away from it is strike two.
      return { state: { ...s, phase: 'court', memory: 'secondChance' }, play: STEMS.returnLater };
    case 'secondChance':
      // Only reachable by re-approaching after the watch never fired (they
      // lingered rather than left). The offer stands; no replay.
      return { state: { ...s, phase: 'court' }, play: null };
    case 'completed':
      return { state: { ...s, phase: 'thresholdIdle', memory: 'completedReturned' }, play: STEMS.returnAfterCompletion };
    case 'completedReturned':
    case 'noStateHeard':
    case 'lockedOut':
      return { state: { ...s, phase: 'thresholdIdle' }, play: STEMS.returnNoState };
    default:
      return { state: { ...s, phase: 'thresholdIdle' }, play: null };
  }
}
