/**
 * The calibration sequence: clips, their screens, and a run a guest paces
 * themselves through one gesture at a time.
 *
 * Run against the real museum show rather than a fixture. The point is that the
 * authored sequence works — a fixture would keep passing after somebody swapped
 * the artwork and broke it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { advanceFromFilename, advanceForStep, expandSequences } from '../sequence.js';
import { roomCentroid } from '../zone-math.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const museum = JSON.parse(readFileSync(join(root, 'shows/MAD-DIM.json'), 'utf8'));

function makeRuntime(mutate) {
  const show = structuredClone(museum);
  if (mutate) mutate(show);
  const cues = [];
  const rt = new SpatialRuntime({
    enableTick: false,
    clock: new ManualClock(),
    onCue: (guestId, cue) => cues.push({ guestId, ...cue }),
  });
  assert.deepEqual(rt.load(show).errors, []);
  rt.start();
  return { rt, cues };
}

// The point the walkthrough driver itself aims at. A bounding-box middle can
// sit outside a traced polygon; this cannot, for any shape a room here has.
const centreOf = (room) => roomCentroid(room);

function walkTo(rt, guestId, roomId, ms = 2600) {
  const [x, y] = centreOf(museum.rooms[roomId]);
  rt.setVirtualPosition(guestId, x, y);
  rt.testAdvanceTime(ms);
}

const guidance = (rt, guestId) => rt.guestActors.get(guestId).regions().guidance;
const screens = (cues) => cues.filter((c) => c.kind === 'image').map((c) => c.assetId);
/** Audio in the guidance slot — the room slot is its own conversation. */
const heard = (cues) => cues
  .filter((c) => c.kind === 'audio' && c.slot === 'guidance')
  .map((c) => c.assetId);

/** Walk a guest into calibration and forget the cues the trip there produced. */
function arrive(rt, cues) {
  const g = rt.spawnGuest();
  walkTo(rt, g.guestId, 'frontDesk');
  walkTo(rt, g.guestId, 'calibration');
  cues.length = 0;
  return g;
}

describe('reading the advance rule off a filename', () => {
  it('understands the three forms', () => {
    assert.deepEqual(advanceFromFilename('calibration_01_ontap.png'), { kind: 'input', input: 'tap' });
    assert.deepEqual(advanceFromFilename('calibration_06_onswipe.png'), { kind: 'input', input: 'swipe' });
    assert.deepEqual(advanceFromFilename('splash_ondelay2500.png'), { kind: 'delay', ms: 2500 });
  });

  it('refuses what it cannot read rather than guessing', () => {
    assert.equal(advanceFromFilename('calibration_01.png'), null, 'no rule at all');
    assert.equal(advanceFromFilename('screen_onwiggle.png'), null, 'not a gesture we have');
    assert.equal(advanceFromFilename('screen_ondelay.png'), null, 'a delay with no number');
    assert.equal(advanceFromFilename(''), null);
    assert.equal(advanceFromFilename(undefined), null);
  });

  it('is only a default — the step may say so itself', () => {
    // For the screens whose filename cannot carry the truth, or artwork that
    // arrives named by someone who never heard of this convention.
    assert.deepEqual(advanceForStep({ image: 'a_ontap.png', advance: 4000 }), { kind: 'delay', ms: 4000 });
    assert.deepEqual(advanceForStep({ image: 'plain.png', advance: 'swipe' }), { kind: 'input', input: 'swipe' });
    assert.deepEqual(advanceForStep({ image: 'plain_ontap.png' }), { kind: 'input', input: 'tap' });
  });
});

describe('expanding a sequence into a machine', () => {
  const expand = (mutate) => {
    const show = structuredClone(museum);
    mutate?.(show);
    return expandSequences(show);
  };
  const calibration = (def) => def.guest.machine.guidance.states.prologue.states.calibration;
  const sequenceOf = (show) => show.guest.machine.guidance.states.prologue.states.calibration.sequence;

  it('turns each step into a state that waits for its own gesture', () => {
    const { def, errors } = expand();
    assert.deepEqual(errors, []);
    const { states } = calibration(def);
    assert.deepEqual(states.step1.on, { TAP: 'step2' });
    assert.deepEqual(states.step2.on, { SWIPE: 'step3' });
    assert.deepEqual(states.step3.on, { DRAG: 'step4' });
  });

  it('holds on a last step that advances on "none" — the room moves the guest on', () => {
    const { def, warnings } = expand();
    assert.deepEqual(calibration(def).states.step4, {}, 'no gesture or timer leaves it');
    assert.deepEqual(calibration(def).on, { 'entered.entranceHallway': 'done' });
    assert.ok(!warnings.some((w) => /onComplete/.test(w)), 'and nothing is missing an onComplete');
  });

  it('sends the last step out of the sequence, not to a sibling step', () => {
    const { def } = expand((show) => {
      const seq = sequenceOf(show);
      seq.at(-1).advance = 5000;
      show.guest.machine.guidance.states.prologue.states.calibration.onComplete = 'done';
    });
    // A bare `onComplete` names a sibling of the sequence itself, so it has to
    // resolve absolutely — XState would look for it among the steps.
    assert.deepEqual(calibration(def).states.step4.after, { 5000: '#guest.guidance.prologue.done' });
  });

  it('generates the cue for each step, with the bg under it', () => {
    const { def } = expand();
    assert.deepEqual(def.guest.cues['guidance.prologue.calibration.step1'], {
      audio: 'audio/guidance/0102-calibration1.mp3',
      bg: 'audio/bg/0102_CALIBRATION1.mp3',
    });
  });

  it('pairs a screen with its clip when a step has both', () => {
    const { def } = expand((show) => { sequenceOf(show)[0].image = 'img/calibration_01_ontap.png'; });
    assert.deepEqual(def.guest.cues['guidance.prologue.calibration.step1'], {
      audio: 'audio/guidance/0102-calibration1.mp3',
      image: 'img/calibration_01_ontap.png',
      bg: 'audio/bg/0102_CALIBRATION1.mp3',
    });
  });

  it('takes a delay from the filename when the step does not say', () => {
    const { def, errors } = expand((show) => {
      sequenceOf(show)[0] = { image: 'img/calibration_01_ondelay2500.png' };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(calibration(def).states.step1, { after: { 2500: 'step2' } });
  });

  it('refuses a step whose rule it cannot read', () => {
    const { errors } = expand((show) => { sequenceOf(show)[2] = { image: 'img/calibration_03.png' }; });
    assert.match(errors.join('\n'), /sequence\[2\] has no advance rule/);
  });

  it('refuses "none" anywhere but the last step — what follows could never be reached', () => {
    const { errors } = expand((show) => { sequenceOf(show)[1].advance = 'none'; });
    assert.match(errors.join('\n'), /sequence\[1\] advances on "none", which only the last step may do/);
  });

  it('refuses a gesture the show does not bind — that would strand the guest', () => {
    const { errors } = expand((show) => { show.inputBindings = { tap: 'TAP', swipe: 'SWIPE' }; });
    assert.match(errors.join('\n'), /waits for a drag, but inputBindings does not bind/);
  });

  it('warns when nothing follows a last step that leaves', () => {
    const { warnings } = expand((show) => { sequenceOf(show).at(-1).advance = 'tap'; });
    assert.match(warnings.join('\n'), /no onComplete — the last screen stays up/);
  });

  it('warns about an onComplete a "none" step can never reach', () => {
    const { warnings } = expand((show) => {
      show.guest.machine.guidance.states.prologue.states.calibration.onComplete = 'done';
    });
    assert.match(warnings.join('\n'), /onComplete is never reached/);
  });
});

describe('the calibration sequence, running', () => {
  it('starts the first clip on arrival', () => {
    const { rt, cues } = makeRuntime();
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    assert.equal(guidance(rt, g.guestId), 'prologue.arrive', 'nothing starts at the desk');

    walkTo(rt, g.guestId, 'calibration');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
    assert.deepEqual(heard(cues), ['audio/guidance/0102-calibration1.mp3']);
  });

  it('waits on the guest, however long they take', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);

    rt.testAdvanceTime(300_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'no timer rescues them');
    assert.deepEqual(heard(cues), [], 'and nothing new plays under them');

    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2');
    assert.deepEqual(heard(cues), ['audio/guidance/0103-calibration2.mp3']);
  });

  it('wants the gesture each step asked for, and only one of it', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    rt.guestInput(g.guestId, 'swipe');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'a swipe is not a tap');

    rt.guestInput(g.guestId, 'tap');
    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2', 'a second tap is not a swipe');

    rt.guestInput(g.guestId, 'swipe');
    rt.guestInput(g.guestId, 'swipe');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step3', 'nor is a second swipe a drag');

    rt.guestInput(g.guestId, 'drag');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step4');
    assert.deepEqual(heard(cues), [
      'audio/guidance/0103-calibration2.mp3', 'audio/guidance/0104-calibration3.mp3', 'audio/guidance/0105-calibration4.mp3',
    ]);
  });

  it('stays on the last step until the guest walks into the entrance hallway', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    for (const input of ['tap', 'swipe', 'drag']) rt.guestInput(g.guestId, input);
    cues.length = 0;

    rt.testAdvanceTime(600_000);
    for (const input of ['tap', 'swipe', 'drag']) rt.guestInput(g.guestId, input);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step4', 'no time or gesture ends it');

    walkTo(rt, g.guestId, 'entranceHallway');
    assert.equal(guidance(rt, g.guestId), 'prologue.done');
    assert.ok(
      cues.some((c) => c.kind === 'stopAudio' && c.assetId === 'audio/guidance/0105-calibration4.mp3'),
      'and its clip stops rather than following them out',
    );
  });

  it('changes the bg with each step, and hands it to the room at the hallway', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    const bg = () => rt.desiredCues(g.guestId).get('bg')?.assetId;
    assert.equal(bg(), 'audio/bg/0102_CALIBRATION1.mp3');
    rt.guestInput(g.guestId, 'tap');
    assert.equal(bg(), 'audio/bg/0103_CALIBRATION2.mp3');
    rt.guestInput(g.guestId, 'swipe');
    rt.guestInput(g.guestId, 'drag');
    assert.equal(bg(), 'audio/bg/0105_CALIBRATION4.mp3');
    walkTo(rt, g.guestId, 'entranceHallway');
    assert.equal(bg(), museum.rooms.entranceHallway.bg, 'the room\'s own, once calibration is done');
  });

  it('ends early for a guest who walks out partway through', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    rt.guestInput(g.guestId, 'tap');
    walkTo(rt, g.guestId, 'entranceHallway');
    assert.equal(guidance(rt, g.guestId), 'prologue.done');
  });

  it('lets two guests be on different steps in the same room', () => {
    const { rt, cues } = makeRuntime();
    const a = arrive(rt, cues);
    const b = rt.spawnGuest();
    walkTo(rt, b.guestId, 'frontDesk');
    walkTo(rt, b.guestId, 'calibration');

    rt.guestInput(a.guestId, 'tap');
    rt.guestInput(a.guestId, 'swipe');

    assert.equal(guidance(rt, a.guestId), 'prologue.calibration.step3');
    assert.equal(guidance(rt, b.guestId), 'prologue.calibration.step1');
    // A's gestures must not have moved B. This is the whole reason the sequence
    // lives on the guest and not in the room machine.
    assert.deepEqual(heard(cues.filter((c) => c.guestId === b.guestId)), ['audio/guidance/0102-calibration1.mp3']);
  });

  it('plays a reconnecting phone the clip it should be on', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    rt.guestInput(g.guestId, 'tap');
    rt.guestInput(g.guestId, 'swipe');
    cues.length = 0;

    rt.resyncCues(g.guestId);
    assert.deepEqual(heard(cues), ['audio/guidance/0104-calibration3.mp3'], 'a step is a state, not an event');
  });

  it('ignores a gesture the show binds to nothing', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    assert.equal(rt.guestInput(g.guestId, 'shake'), false);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
  });
});
