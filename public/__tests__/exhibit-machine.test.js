/**
 * The exhibit machine, tested case by case as the team specified it.
 *
 * Each edge case below is one bullet from the meeting notes, in order. If the
 * team changes its mind, the test that no longer matches IS the change —
 * update it and the machine together, and the notes stay executable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition, STEMS } from '../sim/exhibit-machine.js';

/** Run a sequence of events; return every stem played, in order, plus the end state. */
function run(events, opts) {
  let state = initialState(opts);
  const played = [];
  let roomActive = false;
  for (const event of events) {
    const result = transition(state, event);
    state = result.state;
    if (result.play) played.push(result.play);
    if (result.roomActive != null) roomActive = result.roomActive;
  }
  return { state, played, roomActive };
}

const HAPPY = ['enterThreshold', 'enterRoom', 'entranceEnded', 'advance', 'complete', 'exitRoom', 'exitThreshold'];

describe('the intended journey', () => {
  it('approach → entrance → instruction → interaction → complete', () => {
    const { played, state } = run(HAPPY);
    assert.deepEqual(played, [
      STEMS.approach, STEMS.entrance, STEMS.instruction, STEMS.interaction, STEMS.complete,
    ]);
    assert.equal(state.memory, 'completed');
    assert.equal(state.phase, 'away');
  });

  it('instruction follows entrance with no other trigger than the audio ending', () => {
    const { played } = run(['enterThreshold', 'enterRoom', 'entranceEnded']);
    assert.equal(played.at(-1), STEMS.instruction);
  });

  it('the room is active exactly while interaction runs', () => {
    let { roomActive } = run(['enterThreshold', 'enterRoom', 'entranceEnded', 'advance']);
    assert.equal(roomActive, true);
    ({ roomActive } = run(['enterThreshold', 'enterRoom', 'entranceEnded', 'advance', 'complete']));
    assert.equal(roomActive, false, 'idle again the instant complete fires');
  });
});

describe('a room that is not allowed for them', () => {
  it('plays Approach No State the first time near', () => {
    const { played } = run(['enterThreshold'], { allowed: false });
    assert.deepEqual(played, [STEMS.approachNoState]);
  });

  it('plays Return No State when they leave and come back', () => {
    const { played } = run(['enterThreshold', 'exitThreshold', 'enterThreshold'], { allowed: false });
    assert.deepEqual(played, [STEMS.approachNoState, STEMS.returnNoState]);
  });

  it('walking in gets them nothing more — the room has no content for them', () => {
    const { played, state } = run(['enterThreshold', 'enterRoom', 'entranceEnded', 'advance'], { allowed: false });
    assert.deepEqual(played, [STEMS.approachNoState]);
    assert.equal(state.phase, 'insideDone');
  });
});

describe('rejection and the second chance', () => {
  const REFUSE = ['enterThreshold', 'exitThreshold', 'walkedAway'];

  it('walking away from the offer is Rejection', () => {
    const { played, state } = run(REFUSE);
    assert.deepEqual(played, [STEMS.approach, STEMS.rejection]);
    assert.equal(state.memory, 'rejectedOnce');
  });

  it('a doorway hesitation is not a rejection — coming back resumes silently', () => {
    // Out of the threshold and back in before the 3s walk-away watch fires:
    // no Rejection, no replayed Approach, the offer simply stands.
    const { played, state } = run(['enterThreshold', 'exitThreshold', 'enterThreshold', 'enterRoom']);
    assert.deepEqual(played, [STEMS.approach, STEMS.entrance]);
    assert.equal(state.phase, 'entrance');
  });

  it('coming back after Rejection earns Return Later, and entry still works', () => {
    const { played } = run([...REFUSE, 'enterThreshold', 'enterRoom', 'entranceEnded']);
    assert.deepEqual(played, [
      STEMS.approach, STEMS.rejection, STEMS.returnLater, STEMS.entrance, STEMS.instruction,
    ]);
  });

  it('walking away from the second chance locks them out, silently', () => {
    const { played, state } = run([...REFUSE, ...REFUSE]);
    assert.deepEqual(played, [STEMS.approach, STEMS.rejection, STEMS.returnLater],
      'no second rejection stem — the next approach will say it');
    assert.equal(state.memory, 'lockedOut');
  });

  it('after that, every approach is Return No State and entry gets nothing', () => {
    const { played, state } = run([
      ...REFUSE, ...REFUSE,
      'enterThreshold', 'exitThreshold',
      'enterThreshold', 'enterRoom', 'entranceEnded', 'advance',
    ]);
    assert.deepEqual(played.slice(3), [STEMS.returnNoState, STEMS.returnNoState]);
    assert.equal(state.phase, 'insideDone', 'physically inside, nothing running for them');
  });
});

describe('returning after completion', () => {
  it('the first return is Return after Completion', () => {
    const { played } = run([...HAPPY, 'enterThreshold']);
    assert.equal(played.at(-1), STEMS.returnAfterCompletion);
  });

  it('every return after that is Return No State', () => {
    const { played } = run([...HAPPY, 'enterThreshold', 'exitThreshold', 'enterThreshold']);
    assert.deepEqual(played.slice(-2), [STEMS.returnAfterCompletion, STEMS.returnNoState]);
  });
});

describe('abandoning mid-experience', () => {
  for (const [label, events] of Object.entries({
    'during entrance': ['enterThreshold', 'enterRoom', 'exitRoom'],
    'during instruction': ['enterThreshold', 'enterRoom', 'entranceEnded', 'exitRoom'],
    'during interaction': ['enterThreshold', 'enterRoom', 'entranceEnded', 'advance', 'exitRoom'],
  })) {
    it(`${label} locks them out — their return is Return No State`, () => {
      const { state, played } = run([...events, 'enterThreshold', 'exitThreshold', 'enterThreshold']);
      assert.equal(state.memory, 'lockedOut');
      assert.deepEqual(played.filter((p) => p === STEMS.returnNoState).length, 2);
    });
  }

  it('abandoning during interaction also returns the room to idle', () => {
    const { roomActive } = run(['enterThreshold', 'enterRoom', 'entranceEnded', 'advance', 'exitRoom']);
    assert.equal(roomActive, false, 'a room must not stay running for somebody who left');
  });
});

describe('what BLE will actually do', () => {
  it('a guest who blinks straight into the room still gets the whole journey', () => {
    // A misread beacon or a fast walker can report `inside` with the
    // threshold never registering. Entry runs the approach bookkeeping on the
    // way in, so nothing downstream can be skipped.
    const { played, state } = run(['enterRoom', 'entranceEnded', 'advance', 'complete']);
    assert.deepEqual(played, [STEMS.entrance, STEMS.instruction, STEMS.interaction, STEMS.complete]);
    assert.equal(state.memory, 'completed');
  });

  it('a locked-out guest who blinks straight in gets Return No State, once', () => {
    const lockout = ['enterThreshold', 'exitThreshold', 'walkedAway',
      'enterThreshold', 'exitThreshold', 'walkedAway'];
    const { played } = run([...lockout, 'enterRoom']);
    assert.equal(played.at(-1), STEMS.returnNoState);
  });
});
