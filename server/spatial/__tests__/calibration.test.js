/**
 * The calibration sequence: screens, segmented narration, and a room a guest
 * paces themselves through.
 *
 * Run against the real museum show rather than a fixture. The point of these
 * tests is that the authored sequence works, and a fixture would keep passing
 * after somebody edited the show and broke it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';

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

/** Stand a guest in a room by id, and let entry confirm. */
function walkTo(rt, guestId, roomId, ms = 2600) {
  const [x, y] = centreOf(museum.rooms[roomId]);
  rt.setVirtualPosition(guestId, x, y);
  rt.testAdvanceTime(ms);
}

function centreOf(room) {
  const points = Object.values(room.zones)[0].polygon;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

const guidance = (rt, guestId) => rt.guestActors.get(guestId).regions().guidance;
const screens = (cues) => cues.filter((c) => c.kind === 'image').map((c) => c.assetId);
const lastAudio = (cues) => [...cues].reverse().find((c) => c.kind === 'audio');

/** Walk a guest to calibration and clear the cues the trip there produced. */
function arrive(rt, cues) {
  const g = rt.spawnGuest();
  walkTo(rt, g.guestId, 'frontDesk');
  walkTo(rt, g.guestId, 'calibration');
  cues.length = 0;
  return g;
}

describe('the calibration sequence', () => {
  it('puts the first screen up on arrival, with its own slice of the narration', () => {
    const { rt, cues } = makeRuntime();
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    assert.equal(guidance(rt, g.guestId), 'prologue.arrive', 'nothing starts at the desk');

    walkTo(rt, g.guestId, 'calibration');
    assert.equal(guidance(rt, g.guestId), 'prologue.headphones');
    assert.deepEqual(screens(cues), ['img/01DIM.png']);

    const audio = lastAudio(cues);
    assert.equal(audio.assetId, 'audio/calibrationsteps.mp3');
    assert.equal(audio.offset, 0);
    assert.ok(audio.duration > 0, 'a segment, not the whole recording');
  });

  it('advances itself through the steps that only need to be heard', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);

    rt.testAdvanceTime(12_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.volume');
    assert.deepEqual(screens(cues), ['img/02DIM.png']);
    // The second segment starts where the first ended, in one file.
    assert.ok(lastAudio(cues).offset > 0);
  });

  it('waits on the guest at the tap step, however long they take', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    advanceTo(rt, g, 'prologue.tapTest');
    cues.length = 0;

    rt.testAdvanceTime(120_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.tapTest', 'no timer rescues them');
    assert.deepEqual(screens(cues), [], 'and the screen does not change under them');

    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.swipeTest');
    assert.deepEqual(screens(cues), ['img/06DIM.png']);
  });

  it('wants the gesture it asked for, not just any gesture', () => {
    const { rt } = makeRuntime();
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    walkTo(rt, g.guestId, 'calibration');
    advanceTo(rt, g, 'prologue.tapTest');

    rt.guestInput(g.guestId, 'swipe');
    assert.equal(guidance(rt, g.guestId), 'prologue.tapTest', 'a swipe is not a tap');
    rt.guestInput(g.guestId, 'tap');
    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.swipeTest', 'and a second tap does not skip ahead');
  });

  it('lets two guests be on different steps in the same room', () => {
    const { rt, cues } = makeRuntime();
    const a = arrive(rt, cues);
    const b = rt.spawnGuest();
    walkTo(rt, b.guestId, 'frontDesk');
    walkTo(rt, b.guestId, 'calibration');

    advanceTo(rt, a, 'prologue.tapTest');
    rt.guestInput(a.guestId, 'tap');

    assert.equal(guidance(rt, a.guestId), 'prologue.swipeTest');
    assert.notEqual(guidance(rt, b.guestId), 'prologue.swipeTest');
    // A's tap must not have advanced B — this is the whole reason the sequence
    // lives on the guest and not in the room machine.
    const bScreens = screens(cues.filter((c) => c.guestId === b.guestId));
    assert.ok(!bScreens.includes('img/06DIM.png'));
  });

  it('shows a reconnecting phone the screen it should be on', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    advanceTo(rt, g, 'prologue.tapTest');
    cues.length = 0;

    rt.resyncCues(g.guestId);
    assert.deepEqual(screens(cues), ['img/05DIM.png'], 'the screen is a state, not an event');
    assert.equal(lastAudio(cues).assetId, 'audio/calibrationsteps.mp3');
  });

  it('takes the screen down when the sequence ends', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    advanceTo(rt, g, 'prologue.tapTest');
    rt.guestInput(g.guestId, 'tap');
    rt.guestInput(g.guestId, 'swipe');
    advanceTo(rt, g, 'prologue.done');

    const cleared = cues.filter((c) => c.kind === 'clearImage');
    assert.ok(cleared.length, 'the last screen is cleared rather than left up');
  });

  it('ignores a gesture the show binds to nothing', () => {
    const { rt, cues } = makeRuntime((show) => { show.inputBindings = {}; });
    const g = arrive(rt, cues);
    assert.equal(rt.guestInput(g.guestId, 'tap'), false);
  });
});

/** Nudge the clock until a guest reaches a step, rather than hard-coding sums. */
function advanceTo(rt, g, target, limitMs = 180_000) {
  for (let spent = 0; spent < limitMs; spent += 500) {
    if (guidance(rt, g.guestId) === target) return;
    rt.testAdvanceTime(500);
  }
  assert.fail(`never reached ${target} (stuck at ${guidance(rt, g.guestId)})`);
}
