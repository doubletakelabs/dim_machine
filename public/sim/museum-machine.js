/**
 * The museum machine — one guest's relationship with the whole DIM area.
 *
 * EXPERIMENTAL, third iteration (creative meeting, 2026-08-31). The queue is
 * gone. Each guest gets to ENTER a fixed number of rooms (four in the show),
 * and each offer is drawn at random from the rooms available — not full, not
 * completed, not locked — at that moment. No pre-assigned set exists at all:
 * who you are offered depends on where the crowd is when the hallway calls.
 *
 * What survived the previous iterations, confirmed again:
 *
 * - Two refusals still lock a room forever: strike one plays "Rejection" and
 *   the room's next draw announces itself as "Return Later"; refusing that
 *   locks silently, and its threshold answers "Return, No State" ever after.
 * - A rejected room is not immediately re-drawable — it waits until every
 *   non-rejected candidate is done or full (the cycle, minus the queue).
 * - Full rooms are skipped by the draw, and entering one is SILENCE: no
 *   stem, no strike, no slot burned. Refused by capacity is not a refusal,
 *   and the consumed offer cannot convict them on the way out.
 * - The offered threshold plays "Continue"; other candidates' thresholds are
 *   silent while the journey runs. Inside: Entrance → Instruction →
 *   Interaction → Complete.
 *
 * The count: a slot burns when an ENTRANCE BEGINS — the team ruled "4
 * entered", so abandonment burns the slot and locks the room both. Entering
 * a full room burns nothing, because no entrance ever began (flagged
 * assumption: "entered" means an engagement started, not a doorway crossed).
 *
 * Once the slots are spent, the museum closes to them: the hallway stops
 * calling, and every unvisited room's threshold says "Exhibit Approach, No
 * State", then "Return, No State" — the same voice a locked room uses,
 * because the meaning is the same: nothing here for you. Completed rooms
 * still grant their one "Return after Completion".
 *
 * Purity: the machine cannot roll dice. `evaluate` carries a `roll` (0..1)
 * from the harness and indexes the candidate list with it — tests pass fixed
 * rolls, the simulator passes Math.random().
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

export function initialState({ rooms, limit = 4 }) {
  return {
    rooms: [...rooms],   // every DIM room is a candidate until memory says otherwise
    limit,               // how many rooms this guest gets to enter
    seen: 0,             // entrances begun, abandonments included
    deferred: [],        // rejected and waiting for the cycle to turn
    memory: {},          // roomId → what this room remembers about the guest
    offer: null,
    phase: 'hallway',    // hallway | court | thresholdIdle | entrance | instruction
                         //         | interaction | insideFull | insideDone
    room: null,
  };
}

const memOf = (s, roomId) => s.memory[roomId] ?? 'fresh';
const engageable = (s, roomId) => ['fresh', 'rejectedOnce', 'secondChance'].includes(memOf(s, roomId));
const journeyDone = (s) => s.seen >= s.limit;

/**
 * @param {object} state
 * @param {{ type: string, roomId?: string, roll?: number, full?: object }} event
 * @returns {{ state: object, play: string|null, roomActive?: boolean, rejected?: string }}
 */
export function transition(state, event) {
  const s = {
    ...state,
    deferred: [...state.deferred],
    memory: { ...state.memory },
  };
  const stay = { state: s, play: null };

  switch (event.type) {
    /** The hallway rolls the dice among whoever is available right now. */
    case 'evaluate': {
      if (s.phase !== 'hallway' || s.offer || journeyDone(s)) return stay;
      const eligible = s.rooms.filter((r) => engageable(s, r) && !event.full?.[r]);
      const thisCycle = eligible.filter((r) => !s.deferred.includes(r));
      const pool = thisCycle.length ? thisCycle : eligible;
      if (!pool.length) return stay;
      if (!thisCycle.length) s.deferred = [];
      const pick = pool[Math.min(pool.length - 1, Math.floor((event.roll ?? 0) * pool.length))];
      s.offer = pick;
      if (memOf(s, pick) === 'rejectedOnce') {
        s.memory[pick] = 'secondChance';
        return { state: s, play: STEMS.returnLater };
      }
      return { state: s, play: STEMS.approach };
    }

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
      s.phase = 'thresholdIdle';
      switch (memOf(s, roomId)) {
        case 'lockedOut':
        case 'noStateHeard':
        case 'completedReturned':
          return { state: s, play: STEMS.returnNoState };
        case 'completed':
          s.memory[roomId] = 'completedReturned';
          return { state: s, play: STEMS.returnAfterCompletion };
        default:
          // A candidate they were not sent to. While the journey runs, being
          // near it says nothing — their offer stands, and entering would
          // answer it. Once the slots are spent, the room says what every
          // door now says: nothing here for you.
          if (!journeyDone(s)) return stay;
          if (memOf(s, roomId) === 'fresh') {
            s.memory[roomId] = 'noStateHeard';
            return { state: s, play: STEMS.approachNoState };
          }
          return { state: s, play: STEMS.returnNoState };
      }
    }

    case 'exitThreshold':
      if (s.phase !== 'court' && s.phase !== 'thresholdIdle') return stay;
      // The offer survives leaving its threshold — circling is not refusing.
      s.phase = 'hallway';
      s.room = null;
      return stay;

    case 'enterRoom': {
      const roomId = event.roomId;
      s.room = roomId;
      if (engageable(s, roomId) && !journeyDone(s) && !event.full) {
        let rejected = null;
        if (s.offer && s.offer !== roomId) {
          // Choosing a different room answers the offer. The strike lands
          // silently — Entrance is what they hear.
          rejected = s.offer;
          reject(s, { silent: true });
        }
        s.offer = null;
        s.phase = 'entrance';
        s.seen += 1;   // the slot burns here: an entrance has begun
        return { state: s, play: STEMS.entrance, ...(rejected ? { rejected } : {}) };
      }
      if (engageable(s, roomId) && !journeyDone(s) && event.full) {
        // Refused by capacity: silence, no strike, no slot. The offer is
        // consumed without prejudice so walking away cannot convict them.
        if (s.offer === roomId) s.offer = null;
        s.phase = 'insideFull';
        return stay;
      }
      // Locked, completed, out of slots: physically inside, nothing more.
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
      return { state: s, play: STEMS.complete, roomActive: false };

    case 'exitRoom': {
      if (['entrance', 'instruction', 'interaction'].includes(s.phase)) {
        // Abandonment, Entrance included. The slot was burned at the door;
        // the lock lands now. Both are theirs to keep.
        s.memory[s.room] = 'lockedOut';
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
    // Strike two — silent; the next approach to this door says everything.
    s.memory[roomId] = 'lockedOut';
    s.deferred = s.deferred.filter((r) => r !== roomId);
    return { state: s, play: null, rejected: roomId };
  }
  s.memory[roomId] = 'rejectedOnce';
  if (!s.deferred.includes(roomId)) s.deferred.push(roomId);
  return { state: s, play: silent ? null : STEMS.rejection, rejected: roomId };
}
