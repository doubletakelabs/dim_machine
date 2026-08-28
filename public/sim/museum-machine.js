/**
 * The museum machine — one guest's relationship with the whole DIM area.
 *
 * EXPERIMENTAL, second iteration (team feedback interrogated 2026-08-28).
 * The first version tied Approach to a room's threshold. Now the hallway
 * itself makes the offer:
 *
 * - Each guest carries a QUEUE of rooms, seeded north→south.
 * - In the hallway, the guest is offered the closest room from their queue
 *   that is not full and has not been rejected this cycle ("Exhibit
 *   Approach"). A room rejected earlier is only offerable again once
 *   everything else is done or full — that is what "moving it to the end of
 *   the list" means functionally; the rotation in `queue` is the visible
 *   record of it.
 * - Entering the offered room's threshold plays "Continue".
 * - Inside, the old journey holds: Entrance → Instruction → Interaction →
 *   Complete.
 *
 * Rejection is a judgement about walking away, made by the harness (the
 * machine only hears the verdict): the guest is measurably past the offered
 * door — closer to another candidate than to the offer, with hysteresis and
 * a sustain so a BLE wobble cannot convict anyone — or they enter a
 * different room. Two rejections of the same room lock it forever: strike
 * one plays "Rejection" and the room's next offer is "Return Later"; walking
 * away from that locks silently, and every later visit to its threshold is
 * "Return, No State".
 *
 * Full rooms (maxOccupants) are skipped by the offer, and entering one is
 * SILENCE — no stem, no strike, no queue movement. The guest was refused by
 * capacity; they did not refuse. Walking away from a full room must never
 * read as rejection, which is why entering one consumes the offer without
 * prejudice.
 *
 * A room that was never in the queue was never theirs: its threshold plays
 * "Exhibit Approach, No State" once, then "Return, No State" — same for
 * locked-out rooms, and for completed rooms after their one "Return after
 * Completion".
 *
 * Everything is a pure transition on `{ state, event }`; geometry, timers,
 * and audio live in the harness. The three judgement calls the harness owns:
 * WHEN to evaluate (in the hallway, no offer, nothing playing, cool-off
 * elapsed), when the guest has walked PAST the offer, and what "closest"
 * measures (door-to-guest distance).
 */

export const STEMS = {
  approach: 'exhibit-approach',
  continue: 'continue',
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

export function initialState({ queue }) {
  return {
    queue: [...queue],   // offerable rooms, in cycle order; rotations are visible history
    deferred: [],        // rejected this cycle — not offerable until the cycle turns
    memory: {},          // roomId → what this room remembers about the guest
    offer: null,         // the room currently calling to them
    phase: 'hallway',    // hallway | court | thresholdIdle | entrance | instruction
                         //         | interaction | insideFull | insideDone
    room: null,          // the room of the current threshold/inside engagement
  };
}

const memOf = (s, roomId) => s.memory[roomId] ?? (s.queue.includes(roomId) ? 'fresh' : 'neverTheirs');
const without = (list, roomId) => list.filter((r) => r !== roomId);

/**
 * @param {object} state
 * @param {{ type: string, roomId?: string, distances?: object, full?: object }} event
 * @returns {{ state: object, play: string|null, roomActive?: boolean, rejected?: string }}
 */
export function transition(state, event) {
  const s = {
    ...state,
    queue: [...state.queue],
    deferred: [...state.deferred],
    memory: { ...state.memory },
  };
  const stay = { state: s, play: null };

  switch (event.type) {
    /**
     * The hallway decides who calls next. `distances` is roomId → how far,
     * `full` is roomId → at capacity right now.
     */
    case 'evaluate': {
      if (s.phase !== 'hallway' || s.offer) return stay;
      const offerable = s.queue.filter((r) => !event.full?.[r]);
      const thisCycle = offerable.filter((r) => !s.deferred.includes(r));
      // An empty cycle with candidates still standing turns the cycle: the
      // rooms sent to the back get their second hearing.
      const pool = thisCycle.length ? thisCycle : offerable;
      if (!pool.length) return stay;
      if (!thisCycle.length) s.deferred = [];
      const pick = pool.reduce((a, b) => ((event.distances?.[a] ?? 0) <= (event.distances?.[b] ?? 0) ? a : b));
      s.offer = pick;
      if (memOf(s, pick) === 'rejectedOnce') {
        // The second hearing announces itself as one.
        s.memory[pick] = 'secondChance';
        return { state: s, play: STEMS.returnLater };
      }
      return { state: s, play: STEMS.approach };
    }

    /** The harness judged them past the offered door. */
    case 'passedOffer':
      if (!s.offer || s.phase !== 'hallway') return stay;
      return reject(s, { silent: false });

    case 'enterThreshold': {
      if (s.phase !== 'hallway') return stay;
      const roomId = event.roomId;
      s.room = roomId;
      if (roomId === s.offer) {
        s.phase = 'court';
        return { state: s, play: STEMS.continue };
      }
      switch (memOf(s, roomId)) {
        case 'neverTheirs':
          s.phase = 'thresholdIdle';
          s.memory[roomId] = 'noStateHeard';
          return { state: s, play: STEMS.approachNoState };
        case 'noStateHeard':
        case 'lockedOut':
          s.phase = 'thresholdIdle';
          return { state: s, play: STEMS.returnNoState };
        case 'completed':
          s.phase = 'thresholdIdle';
          s.memory[roomId] = 'completedReturned';
          return { state: s, play: STEMS.returnAfterCompletion };
        case 'completedReturned':
          s.phase = 'thresholdIdle';
          return { state: s, play: STEMS.returnNoState };
        default:
          // A queued room they were not sent to. Their offer stands; being
          // near a different door is not an answer to it. Entering would be.
          s.phase = 'thresholdIdle';
          return { state: s, play: null };
      }
    }

    case 'exitThreshold':
      if (s.phase !== 'court' && s.phase !== 'thresholdIdle') return stay;
      // The offer survives leaving its threshold — circling is not refusing.
      // The passed-door watch decides refusal, out in the hallway.
      s.phase = 'hallway';
      s.room = null;
      return stay;

    case 'enterRoom': {
      const roomId = event.roomId;
      const mem = memOf(s, roomId);
      s.room = roomId;
      if (s.queue.includes(roomId) && !event.full) {
        let rejected = null;
        if (s.offer && s.offer !== roomId) {
          // Choosing a different room answers the offer. The strike lands,
          // but its stem is superseded — Entrance is what they hear, because
          // the room they chose speaks louder than the one they refused.
          rejected = s.offer;
          reject(s, { silent: true });
        }
        s.offer = null;
        s.phase = 'entrance';
        return { state: s, play: STEMS.entrance, ...(rejected ? { rejected } : {}) };
      }
      if (s.queue.includes(roomId) && event.full) {
        // Refused by capacity, not by choice: silence, no strike, and the
        // room keeps its place in the queue. The offer is consumed without
        // prejudice so walking away from a full door can never convict them.
        if (s.offer === roomId) s.offer = null;
        s.phase = 'insideFull';
        return stay;
      }
      // Locked, completed, or never theirs: physically inside, nothing more.
      // The threshold already said everything on the way in.
      void mem;
      s.phase = 'insideDone';
      return stay;
    }

    case 'entranceEnded':
      if (s.phase !== 'entrance') return stay;
      s.phase = 'instruction';
      return { state: s, play: STEMS.instruction };

    case 'advance':
      if (s.phase !== 'instruction') return stay;
      s.phase = 'interaction';
      return { state: s, play: STEMS.interaction, roomActive: true };

    case 'complete':
      if (s.phase !== 'interaction') return stay;
      s.phase = 'insideDone';
      s.memory[s.room] = 'completed';
      s.queue = without(s.queue, s.room);
      s.deferred = without(s.deferred, s.room);
      return { state: s, play: STEMS.complete, roomActive: false };

    case 'exitRoom': {
      if (['entrance', 'instruction', 'interaction'].includes(s.phase)) {
        // Abandonment, Entrance included: walking out mid-welcome is still
        // walking out. Locked silently; their next approach says it.
        s.memory[s.room] = 'lockedOut';
        s.queue = without(s.queue, s.room);
        s.deferred = without(s.deferred, s.room);
        s.phase = 'hallway';
        s.room = null;
        return { state: s, play: null, roomActive: false };
      }
      if (s.phase === 'insideFull' || s.phase === 'insideDone') {
        s.phase = 'hallway';
        s.room = null;
      }
      return stay;
    }

    default:
      return stay;
  }
}

/** The strike itself. Mutates the working copy `s`; returns the result shape. */
function reject(s, { silent }) {
  const roomId = s.offer;
  s.offer = null;
  if (memOf(s, roomId) === 'secondChance') {
    // Strike two. No stem was ever specified for it, deliberately — the next
    // approach to this door says everything ("Return, No State").
    s.memory[roomId] = 'lockedOut';
    s.queue = without(s.queue, roomId);
    s.deferred = without(s.deferred, roomId);
    return { state: s, play: null, rejected: roomId };
  }
  s.memory[roomId] = 'rejectedOnce';
  s.queue = [...without(s.queue, roomId), roomId];
  if (!s.deferred.includes(roomId)) s.deferred.push(roomId);
  return { state: s, play: silent ? null : STEMS.rejection, rejected: roomId };
}
