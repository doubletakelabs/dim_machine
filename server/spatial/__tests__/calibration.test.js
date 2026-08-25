/**
 * The calibration sequence: screens, their audio, and a run a guest paces
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

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const museum = JSON.parse(readFileSync(join(root, 'shows/the-museum.json'), 'utf8'));

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

function centreOf(room) {
  const points = Object.values(room.zones)[0].polygon;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

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

  it('turns each screen into a state that waits for its own gesture', () => {
    const { def, errors } = expand();
    assert.deepEqual(errors, []);
    const { states } = calibration(def);
    assert.deepEqual(states.step1.on, { TAP: 'step2' });
    assert.deepEqual(states.step6.on, { SWIPE: 'step7' }, 'the swipe screen wants a swipe');
  });

  it('sends the last screen out of the sequence, not to a sibling step', () => {
    const { def } = expand();
    // A bare `onComplete` names a sibling of the sequence itself, so it has to
    // resolve absolutely — XState would look for it among the steps. The last
    // screen leaves on a delay, so the target hangs off `after`.
    assert.deepEqual(calibration(def).states.step7.after, { 5000: '#guest.guidance.prologue.done' });
  });

  it('generates the cue for each step, pairing screen with clip', () => {
    const { def } = expand();
    assert.deepEqual(def.guest.cues['guidance.prologue.calibration.step1'], {
      audio: 'audio/calibrationsteps_01.mp3',
      image: 'img/calibration_01_ontap.png',
    });
  });

  it('takes a delay from the filename when there is one', () => {
    const { def, errors } = expand((show) => {
      const seq = show.guest.machine.guidance.states.prologue.states.calibration.sequence;
      seq[0].image = 'img/calibration_01_ondelay2500.png';
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(calibration(def).states.step1, { after: { 2500: 'step2' } });
  });

  it('refuses a screen whose rule it cannot read', () => {
    const { errors } = expand((show) => {
      const seq = show.guest.machine.guidance.states.prologue.states.calibration.sequence;
      seq[2].image = 'img/calibration_03.png';
    });
    assert.match(errors.join('\n'), /sequence\[2\] has no advance rule/);
  });

  it('refuses a gesture the show does not bind — that would strand the guest', () => {
    const { errors } = expand((show) => { show.inputBindings = { tap: 'TAP' }; });
    assert.match(errors.join('\n'), /waits for a swipe, but inputBindings does not bind/);
  });

  it('warns when nothing follows the last screen', () => {
    const { warnings } = expand((show) => {
      delete show.guest.machine.guidance.states.prologue.states.calibration.onComplete;
    });
    assert.match(warnings.join('\n'), /no onComplete — the last screen stays up/);
  });
});

describe('the calibration sequence, running', () => {
  it('puts the first screen up on arrival, with its clip', () => {
    const { rt, cues } = makeRuntime();
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    assert.equal(guidance(rt, g.guestId), 'prologue.arrive', 'nothing starts at the desk');

    walkTo(rt, g.guestId, 'calibration');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
    assert.deepEqual(screens(cues), ['img/calibration_01_ontap.png']);
    assert.deepEqual(heard(cues), ['audio/calibrationsteps_01.mp3']);
  });

  it('waits on the guest, however long they take', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);

    rt.testAdvanceTime(300_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'no timer rescues them');
    assert.deepEqual(screens(cues), [], 'and the screen does not change under them');

    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2');
    assert.deepEqual(screens(cues), ['img/calibration_02_ontap.png']);
  });

  it('wants the gesture the screen asked for, and only one of it', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    rt.guestInput(g.guestId, 'swipe');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'a swipe is not a tap');

    for (let i = 0; i < 5; i++) rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step6', 'five taps, five screens');

    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step6', 'and this one wants a swipe');
    rt.guestInput(g.guestId, 'swipe');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step7');
  });

  it('leaves the sequence when the last screen has had its time', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    for (let i = 0; i < 5; i++) rt.guestInput(g.guestId, 'tap');
    rt.guestInput(g.guestId, 'swipe');
    cues.length = 0;

    rt.testAdvanceTime(4900);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step7', 'not a moment early');
    rt.testAdvanceTime(200);
    assert.equal(guidance(rt, g.guestId), 'prologue.done');
    assert.ok(
      cues.some((c) => c.kind === 'clearImage'),
      'the last screen comes down rather than being left up',
    );
  });

  it('lets two guests be on different screens in the same room', () => {
    const { rt, cues } = makeRuntime();
    const a = arrive(rt, cues);
    const b = rt.spawnGuest();
    walkTo(rt, b.guestId, 'frontDesk');
    walkTo(rt, b.guestId, 'calibration');

    rt.guestInput(a.guestId, 'tap');
    rt.guestInput(a.guestId, 'tap');

    assert.equal(guidance(rt, a.guestId), 'prologue.calibration.step3');
    assert.equal(guidance(rt, b.guestId), 'prologue.calibration.step1');
    // A's taps must not have moved B. This is the whole reason the sequence
    // lives on the guest and not in the room machine.
    const bScreens = screens(cues.filter((c) => c.guestId === b.guestId));
    assert.deepEqual(bScreens, ['img/calibration_01_ontap.png']);
  });

  it('shows a reconnecting phone the screen it should be on', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    rt.guestInput(g.guestId, 'tap');
    rt.guestInput(g.guestId, 'tap');
    cues.length = 0;

    rt.resyncCues(g.guestId);
    assert.deepEqual(screens(cues), ['img/calibration_03_ontap.png'], 'a screen is a state, not an event');
    assert.deepEqual(heard(cues), ['audio/calibrationsteps_03.mp3']);
  });

  it('ignores a gesture the show binds to nothing', () => {
    const { rt, cues } = makeRuntime((show) => { show.inputBindings = { tap: 'TAP', swipe: 'SWIPE' }; });
    const g = arrive(rt, cues);
    assert.equal(rt.guestInput(g.guestId, 'shake'), false);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
  });
});
