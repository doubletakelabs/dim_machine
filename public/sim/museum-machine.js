/**
 * The museum machine — one guest's relationship with the whole DIM area.
 *
 * EXPERIMENTAL, fourth iteration (2026-09-08). The approach is gone, and it
 * took the fuzzy BLE judgements with it: no offers, no thresholds, no
 * walked-past-the-door verdicts, no strikes. The team traded persuasion for
 * choice because beacons cannot referee persuasion.
 *
 * The whole rule set now:
 *
 * - Guests CHOOSE. The first `limit` rooms they actually enter (four in the
 *   show) are theirs: entering activates the room and runs the journey —
 *   Entrance → Instruction → Interaction → Complete. The slot burns when the
 *   entrance begins, so abandoning mid-experience still costs it.
 * - A room entered after the slots are spent cannot activate: it says
 *   "no state" once, and "Return, No State" on every entry after that.
 * - Returning to a room they have been in — completed OR abandoned — plays
 *   the return clip, a different voice than their first time. Every return,
 *   no laddering (flagged assumption: "they get a different audio clip" is a
 *   stable rule, not a one-shot).
 * - Full rooms (maxOccupants) still refuse by capacity: silence, no slot
 *   burned, no memory — an entrance that never began. Come back later.
 *
 * Entry is the only spatial trigger left, which is exactly the event BLE is
 * best at. Everything a beacon is bad at judging is no longer judged.
 */

/**
 * The team's vocabulary, verbatim (2026-09-11): six states, six clips.
 * `in_room` is the whole occupied-and-running stretch — what iteration 4
 * split into Instruction and Interaction merged into one, which also
 * retired the manual advance between them. The room is active exactly
 * while in_room plays.
 */
export const STEMS = {
  entrance: 'entrance',
  inRoom: 'in_room',
  complete: 'complete',
  returnVisited: 'return_visited',
  inRoomDisabled: 'in_room_disabled',
  returnDisabled: 'return_disabled',
  inHallway: 'in_hallway',
};

export function initialState({ rooms, limit = 4 }) {
  return {
    rooms: [...rooms],
    limit,               // how many rooms this guest gets to activate
    seen: 0,             // entrances begun, abandonments included
    memory: {},          // roomId → 'visited' | 'completed' | 'disabled'
    phase: 'hallway',    // hallway | entrance | inRoom | insideFull | insideDone
    room: null,
  };
}

const journeyDone = (s) => s.seen >= s.limit;

/**
 * @param {object} state
 * @param {{ type: string, roomId?: string, full?: boolean }} event
 * @returns {{ state: object, play: string|null, roomActive?: boolean }}
 */
export function transition(state, event) {
  const s = { ...state, memory: { ...state.memory } };
  const stay = { state: s, play: null };

  switch (event.type) {
    case 'enterRoom': {
      if (s.phase !== 'hallway') return stay;
      const roomId = event.roomId;
      const mem = s.memory[roomId];
      s.room = roomId;

      // Been here before — completed or walked out on it, the room remembers
      // either way, and greets them differently than it did the first time.
      if (mem === 'visited' || mem === 'completed') {
        s.phase = 'insideDone';
        return { state: s, play: STEMS.returnVisited };
      }
      // Entered once without a slot: the room said so then; now it just
      // repeats that there is nothing here for them.
      if (mem === 'disabled') {
        s.phase = 'insideDone';
        return { state: s, play: STEMS.returnDisabled };
      }
      // Refused by capacity is not an entrance: nothing burns, nothing is
      // remembered. They will need to come back.
      if (event.full) {
        s.phase = 'insideFull';
        return stay;
      }
      // A fresh room, but the slots are spent: they may stand in it, and it
      // will not run for them.
      if (journeyDone(s)) {
        s.phase = 'insideDone';
        s.memory[roomId] = 'disabled';
        return { state: s, play: STEMS.inRoomDisabled };
      }
      // One of their four. The slot burns here — an entrance has begun.
      s.phase = 'entrance';
      s.seen += 1;
      s.memory[roomId] = 'visited';
      return { state: s, play: STEMS.entrance };
    }

    case 'entranceEnded':
      // in_room begins the moment the welcome ends, and the room runs with
      // it — the manual advance between instruction and interaction retired
      // when the two merged.
      if (s.phase !== 'entrance') return stay;
      s.phase = 'inRoom';
      return { state: s, play: STEMS.inRoom, roomActive: true };

    case 'complete':
      if (s.phase !== 'inRoom') return stay;
      s.phase = 'insideDone';
      s.memory[s.room] = 'completed';
      return { state: s, play: STEMS.complete, roomActive: false };

    case 'exitRoom': {
      // Stepping back into the hallway after a visit is a state of its own:
      // in_hallway. The machine names the state; WHICH track that means is
      // the show's choice, made from the guest's progress — `seen` rides in
      // the state for exactly that ("two rooms now, play this one"). It does
      // not fire after a full-room turn-away, because refused-by-capacity has
      // been a non-event in every ruling so far: nothing happened in there.
      if (['entrance', 'inRoom'].includes(s.phase)) {
        // Abandonment. The slot was burned at the door and stays burned; the
        // room deactivates, and remembers them as having been here — their
        // return gets the return clip like anyone else's.
        s.phase = 'hallway';
        s.room = null;
        return { state: s, play: STEMS.inHallway, roomActive: false };
      }
      if (s.phase === 'insideDone') {
        s.phase = 'hallway';
        s.room = null;
        return { state: s, play: STEMS.inHallway };
      }
      if (s.phase === 'insideFull') {
        s.phase = 'hallway';
        s.room = null;
      }
      return stay;
    }

    default:
      return stay;
  }
}
