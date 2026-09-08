/**
 * The museum machine, iteration 4 — guests choose, entry is the only spatial
 * trigger, and the rules fit in one breath (team change 2026-09-08). When the
 * team changes its mind, the test that stops matching IS the change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition, STEMS } from '../sim/museum-machine.js';

const ROOMS = ['a', 'b', 'c', 'd', 'e'];

function run(events, opts = {}) {
  let state = initialState({ rooms: ROOMS, limit: 4, ...opts });
  const played = [];
  let roomActive = false;
  for (const raw of events) {
    const event = typeof raw === 'string' ? { type: raw } : raw;
    const result = transition(state, event);
    state = result.state;
    if (result.play) played.push(result.play);
    if (result.roomActive != null) roomActive = result.roomActive;
  }
  return { state, played, roomActive };
}

const enter = (roomId, full = false) => ({ type: 'enterRoom', roomId, full });
const doRoom = (roomId) => [enter(roomId), 'entranceEnded', 'advance', 'complete', 'exitRoom'];

describe('choosing a room', () => {
  it('entering runs the journey: entrance → instruction → interaction → complete', () => {
    const { played, state, roomActive } = run(doRoom('a'));
    assert.deepEqual(played, [STEMS.entrance, STEMS.instruction, STEMS.interaction, STEMS.complete]);
    assert.equal(state.memory.a, 'completed');
    assert.equal(roomActive, false, 'idle again the instant complete fires');
  });

  it('the room is active exactly while interaction runs', () => {
    const { roomActive } = run([enter('a'), 'entranceEnded', 'advance']);
    assert.equal(roomActive, true);
  });

  it('the slot burns when the entrance begins', () => {
    assert.equal(run([enter('a')]).state.seen, 1);
  });
});

describe('the four', () => {
  const FOUR = [...doRoom('a'), ...doRoom('b'), ...doRoom('c'), ...doRoom('d')];

  it('the first four rooms entered are theirs', () => {
    const { state } = run(FOUR);
    assert.equal(state.seen, 4);
    for (const r of ['a', 'b', 'c', 'd']) assert.equal(state.memory[r], 'completed');
  });

  it('a fifth room cannot activate — it says no state, once', () => {
    const { played, state } = run([...FOUR, enter('e')]);
    assert.equal(played.at(-1), STEMS.noActivation);
    assert.equal(state.phase, 'insideDone', 'they may stand in it; it will not run');
    assert.equal(state.memory.e, 'noActivation');
  });

  it('and Return No State on every entry after that', () => {
    const { played } = run([...FOUR, enter('e'), 'exitRoom', enter('e'), 'exitRoom', enter('e')]);
    assert.deepEqual(played.slice(-3), [STEMS.noActivation, STEMS.returnNoState, STEMS.returnNoState]);
  });

  it('a smaller limit closes the museum sooner', () => {
    const { played } = run([...doRoom('a'), ...doRoom('b'), enter('c')], { limit: 2 });
    assert.equal(played.at(-1), STEMS.noActivation);
  });
});

describe('returning', () => {
  it('a completed room greets a return with the return clip, not the entrance', () => {
    const { played, state } = run([...doRoom('a'), enter('a')]);
    assert.equal(played.at(-1), STEMS.returnVisit);
    assert.equal(state.phase, 'insideDone', 'the experience does not run twice');
  });

  it('every return, not just the first', () => {
    const { played } = run([...doRoom('a'), enter('a'), 'exitRoom', enter('a')]);
    assert.deepEqual(played.slice(-2), [STEMS.returnVisit, STEMS.returnVisit]);
  });

  it('returning does not burn another slot', () => {
    const { state } = run([...doRoom('a'), enter('a')]);
    assert.equal(state.seen, 1);
  });
});

describe('abandonment', () => {
  it('keeps the burned slot and deactivates the room', () => {
    const { state, roomActive } = run([enter('a'), 'entranceEnded', 'advance', 'exitRoom']);
    assert.equal(state.seen, 1, 'the slot does not come back');
    assert.equal(roomActive, false, 'a room must not stay running for somebody who left');
    assert.equal(state.memory.a, 'visited');
  });

  it('an abandoned room greets a return like any room they have been to', () => {
    const { played } = run([enter('a'), 'exitRoom', enter('a')]);
    assert.equal(played.at(-1), STEMS.returnVisit);
  });

  it('an abandoned slot still counts against the four', () => {
    const { played } = run([
      enter('a'), 'exitRoom',   // burned, walked out during entrance
      ...doRoom('b'), ...doRoom('c'), ...doRoom('d'),
      enter('e'),
    ]);
    assert.equal(played.at(-1), STEMS.noActivation);
  });
});

describe('full rooms', () => {
  it('refused by capacity is not an entrance: silence, nothing burned, nothing remembered', () => {
    const { state, played } = run([enter('a', true)]);
    assert.deepEqual(played, []);
    assert.equal(state.phase, 'insideFull');
    assert.equal(state.seen, 0);
    assert.equal(state.memory.a, undefined);
  });

  it('coming back when there is room works normally', () => {
    const { played, state } = run([enter('a', true), 'exitRoom', ...doRoom('a')]);
    assert.equal(played[0], STEMS.entrance);
    assert.equal(state.memory.a, 'completed');
  });
});
