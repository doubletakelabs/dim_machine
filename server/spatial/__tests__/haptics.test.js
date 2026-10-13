/**
 * Haptics: named vibrations as moments — a calibration step's gesture opening,
 * and a guest's first entry to a room with something to do on the phone.
 *
 * Against the real museum show, like calibration.test.js, so the authored
 * heartbeats are what is tested.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { validateShowDefinition } from '../validate.js';
import { roomCentroid } from '../zone-math.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const museum = JSON.parse(readFileSync(join(root, 'shows/MAD-DIM.json'), 'utf8'));
const calibration = (show) => show.guest.machine.guidance.states.prologue.states.calibration;

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

function walkTo(rt, guestId, roomId, ms = 2600) {
  const [x, y] = roomCentroid(museum.rooms[roomId]);
  rt.setVirtualPosition(guestId, x, y);
  rt.testAdvanceTime(ms);
}

const buzzes = (cues, guestId) => cues.filter((c) => c.kind === 'haptic' && (!guestId || c.guestId === guestId));
const guidance = (rt, guestId) => rt.guestActors.get(guestId).regions().guidance;
/** Room heartbeats off, so only the steps' are counted. */
const noRoomHaptics = (show) => { for (const r of Object.values(show.rooms)) delete r.haptic; };

/** Pressed START at the desk, walked into calibration, waited out its settle. */
function arrive(rt, cues) {
  const g = rt.spawnGuest();
  walkTo(rt, g.guestId, 'frontDesk');
  rt.guestStarted(g.guestId);
  walkTo(rt, g.guestId, 'calibration', 5000);
  rt.testAdvanceTime(2100);
  assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
  cues.length = 0;
  return g;
}

describe('a heartbeat as each calibration gesture opens', () => {
  const into = (rt, g, ms) => {
    const at = rt.now() - rt.guestActors.get(g.guestId).regionSince('guidance');
    rt.testAdvanceTime(Math.max(0, ms - at));
  };

  it('the tap: at its listenFrom, not before, once', () => {
    const { rt, cues } = makeRuntime(noRoomHaptics);
    const g = arrive(rt, cues);
    into(rt, g, 46_900);
    assert.equal(buzzes(cues).length, 0, 'nothing while calibration1 has yet to ask');
    into(rt, g, 47_000);
    assert.deepEqual(buzzes(cues).map((c) => c.effect), ['heartbeat']);
    into(rt, g, 60_000);
    assert.equal(buzzes(cues).length, 1, 'waiting on the step does not buzz again');
  });

  it('then the swipe and the drag, each when it opens; nothing on the last step', () => {
    const { rt, cues } = makeRuntime(noRoomHaptics);
    const g = arrive(rt, cues);
    into(rt, g, 47_000);
    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2');
    into(rt, g, 2_900);
    assert.equal(buzzes(cues).length, 1);
    into(rt, g, 3_000);
    assert.equal(buzzes(cues).length, 2, 'the swipe opens at 3 s');
    rt.guestInput(g.guestId, 'swipe');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step3');
    into(rt, g, 6_000);
    assert.equal(buzzes(cues).length, 3, 'the drag opens at 6 s');
    rt.guestInput(g.guestId, 'drag');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step4');
    rt.testAdvanceTime(60_000);
    assert.equal(buzzes(cues).length, 3, 'step 4 takes no gesture, and has no heartbeat');
  });

  it('a guest who leaves the step before it opens feels nothing for it', () => {
    const { rt, cues } = makeRuntime(noRoomHaptics);
    const g = arrive(rt, cues);
    rt.testAdvanceTime(10_000);
    walkTo(rt, g.guestId, 'entranceHallway');
    assert.equal(guidance(rt, g.guestId), 'prologue.done');
    rt.testAdvanceTime(60_000);
    assert.equal(buzzes(cues).length, 0);
  });

  it('a phone that reconnects is not buzzed again', () => {
    const { rt, cues } = makeRuntime(noRoomHaptics);
    const g = arrive(rt, cues);
    into(rt, g, 47_000);
    rt.resyncCues(g.guestId);
    rt.testAdvanceTime(1_000);
    assert.equal(buzzes(cues).length, 1);
  });

  it('is recorded in the event log', () => {
    const { rt, cues } = makeRuntime(noRoomHaptics);
    const g = arrive(rt, cues);
    into(rt, g, 47_000);
    const logged = rt.eventLog.filter((e) => e.type === 'guest.haptic');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].guestId, g.guestId);
    assert.equal(logged[0].why, 'guidance.prologue.calibration.step1');
  });
});

describe('a heartbeat on the first entry to a room with something to do on the phone', () => {
  const rooms = ['entranceHallway', 'cyclorama', 'saas', 'slop', 'influence', 'consumption2'];
  /** Calibration's steps off, so only the rooms' are counted. */
  const noStepHaptics = (show) => { for (const s of calibration(show).sequence) delete s.haptic; };

  it('the show gives it to exactly these rooms', () => {
    const given = Object.entries(museum.rooms).filter(([, r]) => r.haptic?.firstEntry).map(([id]) => id);
    assert.deepEqual(given.sort(), [...rooms].sort());
  });

  it('every one of them buzzes on the way in', () => {
    const { rt, cues } = makeRuntime(noStepHaptics);
    const g = rt.spawnGuest();
    for (const roomId of rooms) {
      const before = buzzes(cues).length;
      walkTo(rt, g.guestId, roomId);
      assert.equal(buzzes(cues).length, before + 1, roomId);
    }
  });

  it('only the first time — walking back in is quiet', () => {
    const { rt, cues } = makeRuntime(noStepHaptics);
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'cyclorama');
    walkTo(rt, g.guestId, 'museumHallway');
    walkTo(rt, g.guestId, 'cyclorama');
    assert.equal(buzzes(cues).length, 1);
  });

  it('once the entry is confirmed, not while it is still being judged', () => {
    const { rt, cues } = makeRuntime(noStepHaptics);
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'cyclorama', 500);
    assert.equal(buzzes(cues).length, 0);
    rt.testAdvanceTime(2_000);
    assert.equal(buzzes(cues).length, 1);
  });

  it('every guest feels it, whoever else is inside or driving', () => {
    const { rt, cues } = makeRuntime(noStepHaptics);
    const a = rt.spawnGuest();
    const b = rt.spawnGuest();
    walkTo(rt, a.guestId, 'slop');
    walkTo(rt, b.guestId, 'slop');
    assert.equal(buzzes(cues, a.guestId).length, 1);
    assert.equal(buzzes(cues, b.guestId).length, 1);
  });

  it('rooms without it stay quiet', () => {
    const { rt, cues } = makeRuntime(noStepHaptics);
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'kin');
    walkTo(rt, g.guestId, 'library');
    assert.equal(buzzes(cues).length, 0);
  });
});

describe('haptics are checked at load', () => {
  const errorsFor = (mutate) => {
    const show = structuredClone(museum);
    mutate(show);
    return validateShowDefinition(show);
  };

  it('a step naming a vibration the app does not have is an error', () => {
    const { errors } = errorsFor((s) => { calibration(s).sequence[0].haptic = 'thump'; });
    assert.ok(errors.some((e) => /sequence\[0\]\.haptic must be one of purr, heartbeat/.test(e)), errors.join('\n'));
  });

  it('a room naming one is an error too, and the shape is checked', () => {
    let { errors } = errorsFor((s) => { s.rooms.cyclorama.haptic = { firstEntry: 'thump' }; });
    assert.ok(errors.some((e) => /rooms\.cyclorama\.haptic\.firstEntry must be one of/.test(e)), errors.join('\n'));
    ({ errors } = errorsFor((s) => { s.rooms.cyclorama.haptic = 'heartbeat'; }));
    assert.ok(errors.some((e) => /rooms\.cyclorama\.haptic must be an object/.test(e)), errors.join('\n'));
  });

  it('an unknown moment is a warning, not silence', () => {
    const { errors, warnings } = errorsFor((s) => { s.rooms.cyclorama.haptic = { firstEntry: 'heartbeat', onExit: 'purr' }; });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => /rooms\.cyclorama\.haptic\.onExit is not a haptic moment/.test(w)));
  });
});
