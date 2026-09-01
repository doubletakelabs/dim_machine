/**
 * The museum machine, iteration 3 — tested rule by rule as the team decided
 * them (creative meeting 2026-08-31, confirmed 2026-09-01). When the team
 * changes its mind, the test that stops matching IS the change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition, STEMS } from '../sim/museum-machine.js';

const ROOMS = ['a', 'b', 'c', 'd'];

function run(events, opts = {}) {
  let state = initialState({ rooms: ROOMS, limit: 4, ...opts });
  const played = [];
  const rejections = [];
  let roomActive = false;
  for (const raw of events) {
    const event = typeof raw === 'string' ? { type: raw } : raw;
    const result = transition(state, event);
    state = result.state;
    if (result.play) played.push(result.play);
    if (result.rejected) rejections.push(result.rejected);
    if (result.roomActive != null) roomActive = result.roomActive;
  }
  return { state, played, rejections, roomActive };
}

// roll: 0 picks the first candidate, .99 the last — the dice are in the test's hand.
const evaluate = (roll = 0, full = {}) => ({ type: 'evaluate', roll, full });
const enter = (roomId, full = false) => ({ type: 'enterRoom', roomId, full });
const threshold = (roomId) => ({ type: 'enterThreshold', roomId });
const doRoom = (roomId) => [threshold(roomId), enter(roomId), 'entranceEnded', 'advance', 'complete', 'exitRoom', 'exitThreshold'];

describe('the draw', () => {
  it('offers a random available room — the roll decides', () => {
    assert.equal(run([evaluate(0)]).state.offer, 'a');
    assert.equal(run([evaluate(0.99)]).state.offer, 'd');
    assert.equal(run([evaluate(0.5)]).state.offer, 'c');
  });

  it('draws only among rooms that are not full at that moment', () => {
    const { state } = run([evaluate(0, { a: true, b: true })]);
    assert.equal(state.offer, 'c');
  });

  it('offers nobody when everything is full — silence, not a lie', () => {
    const { state } = run([evaluate(0, { a: true, b: true, c: true, d: true })]);
    assert.equal(state.offer, null);
  });

  it('latches: no re-draw while an offer stands', () => {
    const { state } = run([evaluate(0), evaluate(0.99)]);
    assert.equal(state.offer, 'a');
  });

  it('does not re-draw a rejected room while other candidates stand', () => {
    const { state } = run([evaluate(0), 'passedOffer', evaluate(0)]);
    assert.equal(state.memory.a, 'rejectedOnce');
    assert.equal(state.offer, 'b', 'a is waiting for the cycle to turn');
  });

  it('the cycle turns when only rejected rooms remain — and announces Return Later', () => {
    const full = { b: true, c: true, d: true };
    const { state, played } = run([evaluate(0), 'passedOffer', evaluate(0, full)]);
    assert.equal(state.offer, 'a');
    assert.equal(played.at(-1), STEMS.returnLater);
    assert.equal(state.memory.a, 'secondChance');
  });
});

describe('the strikes', () => {
  it('walking past the offer plays Rejection — strike one', () => {
    const { played, state } = run([evaluate(0), 'passedOffer']);
    assert.deepEqual(played, [STEMS.approach, STEMS.rejection]);
    assert.equal(state.memory.a, 'rejectedOnce');
  });

  it('refusing the second chance locks the room, silently', () => {
    const full = { b: true, c: true, d: true };
    const { state, played } = run([
      evaluate(0), 'passedOffer', evaluate(0, full), 'passedOffer',
    ]);
    assert.equal(state.memory.a, 'lockedOut');
    assert.equal(played.at(-1), STEMS.returnLater, 'no second rejection stem');
  });

  it('a locked room answers its threshold with Return No State forever', () => {
    const full = { b: true, c: true, d: true };
    const { played } = run([
      evaluate(0), 'passedOffer', evaluate(0, full), 'passedOffer',
      threshold('a'), 'exitThreshold', threshold('a'),
    ]);
    assert.deepEqual(played.slice(-2), [STEMS.returnNoState, STEMS.returnNoState]);
  });

  it('entering a different available room strikes the offer, but Entrance is what they hear', () => {
    const { played, rejections, state } = run([evaluate(0), threshold('b'), enter('b')]);
    assert.deepEqual(played, [STEMS.approach, STEMS.entrance]);
    assert.deepEqual(rejections, ['a']);
    assert.equal(state.memory.a, 'rejectedOnce');
  });
});

describe('the count — four entrances, however they end', () => {
  it('a slot burns when an entrance begins', () => {
    const { state } = run([evaluate(0), threshold('a'), enter('a')]);
    assert.equal(state.seen, 1);
  });

  it('abandonment keeps the burned slot and locks the room', () => {
    const { state } = run([evaluate(0), threshold('a'), enter('a'), 'exitRoom']);
    assert.equal(state.seen, 1, 'the slot does not come back');
    assert.equal(state.memory.a, 'lockedOut');
  });

  it('entering a full room burns nothing — no entrance ever began', () => {
    const { state, played } = run([evaluate(0), threshold('a'), enter('a', true)]);
    assert.equal(state.seen, 0);
    assert.equal(state.phase, 'insideFull');
    assert.deepEqual(played, [STEMS.approach, STEMS.continue]);
    assert.equal(state.memory.a, undefined, 'refused by capacity is not a refusal');
  });

  it('the consumed offer cannot convict them on the way out of a full room', () => {
    const { state } = run([evaluate(0), threshold('a'), enter('a', true), 'exitRoom', 'passedOffer']);
    assert.equal(state.memory.a, undefined);
  });

  it('after the last slot, the hallway stops calling', () => {
    const journey = [
      evaluate(0), ...doRoom('a'),
      evaluate(0), ...doRoom('b'),
      evaluate(0), ...doRoom('c'),
      evaluate(0), ...doRoom('d'),
      evaluate(0),
    ];
    const { state } = run(journey);
    assert.equal(state.seen, 4);
    assert.equal(state.offer, null, 'the museum is done with them, kindly');
  });

  it('a smaller limit closes the museum sooner', () => {
    const { state } = run([
      evaluate(0), ...doRoom('a'),
      evaluate(0), ...doRoom('b'),
      evaluate(0),
    ], { limit: 2 });
    assert.equal(state.offer, null);
  });

  it('once the slots are spent, an unvisited door says No State — once, then Return', () => {
    const { played, state } = run([
      evaluate(0), ...doRoom('a'), evaluate(0), ...doRoom('b'),
      threshold('c'), 'exitThreshold', threshold('c'),
    ], { limit: 2 });
    assert.deepEqual(played.slice(-2), [STEMS.approachNoState, STEMS.returnNoState]);
    assert.equal(state.memory.c, 'noStateHeard');
  });

  it('and entering it gets nothing', () => {
    const { state } = run([
      evaluate(0), ...doRoom('a'), evaluate(0), ...doRoom('b'),
      threshold('c'), enter('c'),
    ], { limit: 2 });
    assert.equal(state.phase, 'insideDone');
    assert.equal(state.seen, 2);
  });

  it('a completed room still grants its one Return after Completion when the journey is over', () => {
    const { played } = run([
      evaluate(0), ...doRoom('a'), evaluate(0), ...doRoom('b'),
      threshold('a'), 'exitThreshold', threshold('a'),
    ], { limit: 2 });
    assert.deepEqual(played.slice(-2), [STEMS.returnAfterCompletion, STEMS.returnNoState]);
  });
});

describe('thresholds mid-journey', () => {
  it('the offered threshold plays Continue', () => {
    const { played } = run([evaluate(0), threshold('a')]);
    assert.deepEqual(played, [STEMS.approach, STEMS.continue]);
  });

  it('an unoffered candidate threshold is silent while the journey runs', () => {
    const { played, state } = run([evaluate(0), threshold('b')]);
    assert.deepEqual(played, [STEMS.approach]);
    assert.equal(state.offer, 'a', 'being near a different door is not an answer');
  });

  it('leaving the offered threshold does not refuse it — circling is allowed', () => {
    const { state } = run([evaluate(0), threshold('a'), 'exitThreshold']);
    assert.equal(state.offer, 'a');
  });
});

describe('what BLE will actually do', () => {
  it('blinking straight into an available room works and burns its slot', () => {
    const { played, state } = run([enter('a'), 'entranceEnded', 'advance', 'complete']);
    assert.deepEqual(played, [STEMS.entrance, STEMS.instruction, STEMS.interaction, STEMS.complete]);
    assert.equal(state.seen, 1);
    assert.equal(state.memory.a, 'completed');
  });

  it('an evaluate that arrives mid-engagement changes nothing', () => {
    const { state } = run([evaluate(0), threshold('a'), enter('a'), evaluate(0.99)]);
    assert.equal(state.phase, 'entrance');
    assert.equal(state.offer, null);
  });
});
