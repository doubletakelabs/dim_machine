/**
 * The museum machine, tested rule by rule as the team confirmed them
 * (interrogated 2026-08-28). When the team changes its mind, the test that
 * stops matching IS the change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition, STEMS } from '../sim/museum-machine.js';

const QUEUE = ['a', 'b', 'c'];   // north → south; 'x' exists but was never theirs

/** Distances as if standing at the north end: a nearest, c farthest. */
const NORTH = { a: 50, b: 150, c: 250, x: 300 };
const SOUTH = { a: 250, b: 150, c: 50, x: 90 };

function run(events, { queue = QUEUE } = {}) {
  let state = initialState({ queue });
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

const evalNorth = (full = {}) => ({ type: 'evaluate', distances: NORTH, full });
const evalSouth = (full = {}) => ({ type: 'evaluate', distances: SOUTH, full });
const enter = (roomId, full = false) => ({ type: 'enterRoom', roomId, full });
const threshold = (roomId) => ({ type: 'enterThreshold', roomId });

const COMPLETE_A = [evalNorth(), threshold('a'), enter('a'), 'entranceEnded', 'advance', 'complete', 'exitRoom'];

describe('the offer', () => {
  it('calls the closest queued room that is not full', () => {
    assert.equal(run([evalNorth()]).state.offer, 'a');
    assert.equal(run([evalSouth()]).state.offer, 'c');
  });

  it('skips a full room and calls the next closest', () => {
    const { state, played } = run([evalNorth({ a: true })]);
    assert.equal(state.offer, 'b');
    assert.deepEqual(played, [STEMS.approach]);
  });

  it('calls nobody when everything is full — silence, not a lie', () => {
    const { state } = run([evalNorth({ a: true, b: true, c: true })]);
    assert.equal(state.offer, null);
  });

  it('does not re-evaluate while an offer stands', () => {
    const { state } = run([evalNorth(), evalSouth()]);
    assert.equal(state.offer, 'a', 'the offer latches; RSSI wobble must not re-deal it');
  });
});

describe('continue, and other thresholds', () => {
  it('the offered threshold plays Continue', () => {
    const { played } = run([evalNorth(), threshold('a')]);
    assert.deepEqual(played, [STEMS.approach, STEMS.continue]);
  });

  it('a queued-but-unoffered threshold is silent, and the offer stands', () => {
    const { played, state } = run([evalNorth(), threshold('b')]);
    assert.deepEqual(played, [STEMS.approach]);
    assert.equal(state.offer, 'a', 'being near a different door is not an answer');
  });

  it('leaving the offered threshold does not refuse it — circling is allowed', () => {
    const { state } = run([evalNorth(), threshold('a'), 'exitThreshold']);
    assert.equal(state.offer, 'a');
  });

  it('a room that was never theirs says so, once, then Return No State', () => {
    const { played } = run([threshold('x'), 'exitThreshold', threshold('x')]);
    assert.deepEqual(played, [STEMS.approachNoState, STEMS.returnNoState]);
  });
});

describe('rejection, the cycle, and the two strikes', () => {
  it('walking past the offer plays Rejection and sends the room to the back', () => {
    const { state, played } = run([evalNorth(), 'passedOffer']);
    assert.deepEqual(played, [STEMS.approach, STEMS.rejection]);
    assert.deepEqual(state.queue, ['b', 'c', 'a'], 'the rotation is the visible record');
    assert.deepEqual(state.deferred, ['a'], 'and not offerable again this cycle');
  });

  it('a rejected room is not re-offered while others remain, even standing beside it', () => {
    const { state } = run([evalNorth(), 'passedOffer', evalNorth()]);
    // Still nearest to a's door — but a was sent to the back of the cycle.
    assert.equal(state.offer, 'b');
  });

  it('the cycle turns when everything else is done or full — and announces Return Later', () => {
    const { state, played } = run([
      evalNorth(), 'passedOffer',                       // a rejected
      { type: 'evaluate', distances: NORTH, full: { b: true, c: true } },
    ]);
    assert.equal(state.offer, 'a');
    assert.equal(played.at(-1), STEMS.returnLater);
    assert.equal(state.memory.a, 'secondChance');
  });

  it('walking away from the second chance locks the room, silently', () => {
    const full = { b: true, c: true };
    const { state, played } = run([
      evalNorth(), 'passedOffer',
      { type: 'evaluate', distances: NORTH, full }, 'passedOffer',
    ]);
    assert.equal(state.memory.a, 'lockedOut');
    assert.ok(!state.queue.includes('a'), 'gone from the queue for good');
    assert.equal(played.at(-1), STEMS.returnLater, 'no second rejection stem');
  });

  it('a locked room answers its threshold with Return No State, and entry gets nothing', () => {
    const full = { b: true, c: true };
    const { played, state } = run([
      evalNorth(), 'passedOffer',
      { type: 'evaluate', distances: NORTH, full }, 'passedOffer',
      threshold('a'), enter('a'),
    ]);
    assert.equal(played.at(-1), STEMS.returnNoState);
    assert.equal(state.phase, 'insideDone');
  });

  it('entering a different queued room strikes the offer, but Entrance is what they hear', () => {
    const { state, played, rejections } = run([evalNorth(), threshold('b'), enter('b')]);
    assert.deepEqual(played, [STEMS.approach, STEMS.entrance]);
    assert.deepEqual(rejections, ['a'], 'the strike lands without its stem');
    assert.equal(state.memory.a, 'rejectedOnce');
    assert.deepEqual(state.queue, ['b', 'c', 'a']);
  });
});

describe('full rooms', () => {
  it('entering a full queued room is silence — no stem, no strike, no queue movement', () => {
    const { state, played } = run([evalNorth(), threshold('a'), enter('a', true)]);
    assert.deepEqual(played, [STEMS.approach, STEMS.continue]);
    assert.equal(state.phase, 'insideFull');
    assert.equal(state.memory.a, undefined, 'refused by capacity is not a refusal');
    assert.deepEqual(state.queue, QUEUE, 'they will need to come back — their place holds');
  });

  it('the consumed offer cannot convict them on the way out', () => {
    const { state } = run([evalNorth(), threshold('a'), enter('a', true), 'exitRoom', 'passedOffer']);
    assert.equal(state.memory.a, undefined, 'no offer stands, so no walk-away can strike');
  });
});

describe('inside — the journey holds', () => {
  it('entrance → instruction → interaction → complete, and the room runs only for interaction', () => {
    const { played, state, roomActive } = run(COMPLETE_A);
    assert.deepEqual(played, [
      STEMS.approach, STEMS.continue, STEMS.entrance,
      STEMS.instruction, STEMS.interaction, STEMS.complete,
    ]);
    assert.equal(roomActive, false, 'idle again the instant complete fires');
    assert.equal(state.memory.a, 'completed');
    assert.ok(!state.queue.includes('a'));
  });

  it('a completed room grants one Return after Completion, then Return No State', () => {
    const { played } = run([
      ...COMPLETE_A, 'exitThreshold',
      threshold('a'), 'exitThreshold', threshold('a'),
    ]);
    assert.deepEqual(played.slice(-2), [STEMS.returnAfterCompletion, STEMS.returnNoState]);
  });

  it('abandoning mid-experience locks the room and stops it', () => {
    const { state, roomActive } = run([
      evalNorth(), threshold('a'), enter('a'), 'entranceEnded', 'advance', 'exitRoom',
    ]);
    assert.equal(state.memory.a, 'lockedOut');
    assert.ok(!state.queue.includes('a'));
    assert.equal(roomActive, false, 'a room must not stay running for somebody who left');
  });

  it('after completing one room, the hallway offers the next', () => {
    const { state } = run([...COMPLETE_A, evalSouth()]);
    assert.equal(state.offer, 'c', 'closest remaining from where they now stand');
  });
});

describe('what BLE will actually do', () => {
  it('blinking straight into a queued room without threshold or offer still works', () => {
    const { played, state } = run([enter('a'), 'entranceEnded', 'advance', 'complete']);
    assert.deepEqual(played, [STEMS.entrance, STEMS.instruction, STEMS.interaction, STEMS.complete]);
    assert.equal(state.memory.a, 'completed');
  });

  it('an evaluate that arrives mid-engagement changes nothing', () => {
    const { state } = run([evalNorth(), threshold('a'), enter('a'), evalSouth()]);
    assert.equal(state.phase, 'entrance');
    assert.equal(state.offer, null);
  });
});
