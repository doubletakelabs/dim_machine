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
// The show's calibration steps take their gesture only some way into each clip
// (listenFrom) and play every clip to its end (playThrough); these tests walk
// the sequence at once. Both have their own tests below, against the show's
// own values.
const sequenceInShow = structuredClone(museum.guest.machine.guidance.states.prologue.states.calibration.sequence);
for (const step of museum.guest.machine.guidance.states.prologue.states.calibration.sequence) {
  delete step.listenFrom;
  delete step.playThrough;
}

function makeRuntime(mutate, io = {}) {
  const show = structuredClone(museum);
  if (mutate) mutate(show);
  const cues = [];
  const rt = new SpatialRuntime({
    enableTick: false,
    clock: new ManualClock(),
    onCue: (guestId, cue) => cues.push({ guestId, ...cue }),
    ...io,
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

/**
 * A guest at the desk who has pressed START DIM (the phone's first `ready`),
 * walked into calibration and waited out its 2 s settle — with the cues the
 * trip there produced forgotten.
 */
function arrive(rt, cues) {
  const g = rt.spawnGuest();
  walkTo(rt, g.guestId, 'frontDesk');
  rt.guestStarted(g.guestId);
  walkTo(rt, g.guestId, 'calibration', 5000);
  rt.testAdvanceTime(2100);
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

  it('generates the cue for each step', () => {
    const { def } = expand();
    assert.deepEqual(def.guest.cues['guidance.prologue.calibration.step1'], {
      audio: 'audio/guidance/1A-calibration1.mp3',
    });
  });

  it('pairs a screen with its clip when a step has both', () => {
    const { def } = expand((show) => { sequenceOf(show)[0].image = 'img/calibration_01_ontap.png'; });
    assert.deepEqual(def.guest.cues['guidance.prologue.calibration.step1'], {
      audio: 'audio/guidance/1A-calibration1.mp3',
      image: 'img/calibration_01_ontap.png',
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
  it('plays nothing until START DIM, then the pre-calibration clip from its top', () => {
    const { rt, cues } = makeRuntime();
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    assert.equal(guidance(rt, g.guestId), 'prologue.waiting', 'nothing starts before the press');
    assert.deepEqual(heard(cues), []);

    rt.testAdvanceTime(30_000);
    assert.equal(rt.guestStarted(g.guestId), true);
    assert.equal(guidance(rt, g.guestId), 'prologue.arrive');
    const pre = cues.find((c) => c.kind === 'audio' && c.slot === 'guidance');
    assert.equal(pre.assetId, 'audio/guidance/1-precalibration.mp3');
    assert.equal(pre.startAt, rt.now(), 'from its top at the press, not from when the guest arrived');
    assert.equal(rt.guestStarted(g.guestId), false, 'a second press (a reload) changes nothing');
  });

  it('starts calibration1 two seconds after walking into calibration', () => {
    const { rt, cues } = makeRuntime();
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    rt.guestStarted(g.guestId);
    cues.length = 0;

    walkTo(rt, g.guestId, 'calibration');
    assert.equal(guidance(rt, g.guestId), 'prologue.settling', 'a moment first');
    assert.deepEqual(heard(cues), []);
    rt.testAdvanceTime(2100);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
    assert.deepEqual(heard(cues), ['audio/guidance/1A-calibration1.mp3']);
  });

  it('a guest already in calibration when they press START is not left waiting', () => {
    const { rt } = makeRuntime();
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    walkTo(rt, g.guestId, 'calibration', 5000);
    rt.guestStarted(g.guestId);
    assert.equal(guidance(rt, g.guestId), 'prologue.walkedInEarly', 'pre-calibration first, where they stand');
    rt.testAdvanceTime(2100); // no clip lengths here: it counts as already over
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
  });

  it('cannot go back to the front desk from calibration', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    // The phone's own reading, which the way through judges (an operator's
    // drag is deliberately not).
    rt.readRoom(g.guestId, 'frontDesk');
    rt.testAdvanceTime(5000);
    assert.equal(rt.guestActors.get(g.guestId).currentRoom()?.roomId, 'calibration', 'the desk is behind them');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
    assert.equal(rt.desiredCues(g.guestId).get('room'), null, 'and the desk plays nothing over calibration1');
  });

  it('waits on the guest, however long they take', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);

    rt.testAdvanceTime(300_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'no timer rescues them');
    assert.deepEqual(heard(cues), [], 'and nothing new plays under them');

    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2');
    assert.deepEqual(heard(cues), ['audio/guidance/1B-calibration2.mp3']);
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
      'audio/guidance/1B-calibration2.mp3', 'audio/guidance/1C-calibration3.mp3', 'audio/guidance/1D-calibration4.mp3',
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
      cues.some((c) => c.kind === 'stopAudio' && c.assetId === 'audio/guidance/1D-calibration4.mp3'),
      'and its clip stops rather than following them out',
    );
  });

  it('plays the calibration room\'s own bg under every step, unbroken', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    const bg = () => rt.desiredCues(g.guestId).get('bg');
    const first = bg();
    assert.equal(first.assetId, museum.rooms.calibration.bg);
    for (const input of ['tap', 'swipe', 'drag']) {
      rt.guestInput(g.guestId, input);
      assert.equal(bg().key, first.key, 'the same bg, never restarted, as the steps go by');
    }
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
    rt.guestStarted(b.guestId);
    walkTo(rt, b.guestId, 'calibration', 5000);
    rt.testAdvanceTime(2100);

    rt.guestInput(a.guestId, 'tap');
    rt.guestInput(a.guestId, 'swipe');

    assert.equal(guidance(rt, a.guestId), 'prologue.calibration.step3');
    assert.equal(guidance(rt, b.guestId), 'prologue.calibration.step1');
    // A's gestures must not have moved B. This is the whole reason the sequence
    // lives on the guest and not in the room machine.
    assert.deepEqual(heard(cues.filter((c) => c.guestId === b.guestId)),
      ['audio/guidance/1-precalibration.mp3', 'audio/guidance/1A-calibration1.mp3']);
  });

  it('plays a reconnecting phone the clip it should be on', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    rt.guestInput(g.guestId, 'tap');
    rt.guestInput(g.guestId, 'swipe');
    cues.length = 0;

    rt.resyncCues(g.guestId);
    assert.deepEqual(heard(cues), ['audio/guidance/1C-calibration3.mp3'], 'a step is a state, not an event');
  });

  it('ignores a gesture the show binds to nothing', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    assert.equal(rt.guestInput(g.guestId, 'shake'), false);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
  });
});

/** The calibration clips' real lengths (2026-10-01). */
const CLIP_SECONDS = {
  'audio/guidance/1A-calibration1.mp3': 71.9,
  'audio/guidance/1B-calibration2.mp3': 8.6,
  'audio/guidance/1C-calibration3.mp3': 11.3,
  'audio/guidance/1D-calibration4.mp3': 14.9,
};

describe('every clip heard to its end (playThrough)', () => {
  const asShown = (show) => {
    show.guest.machine.guidance.states.prologue.states.calibration.sequence = structuredClone(sequenceInShow);
  };
  const io = { clipSeconds: (clip) => CLIP_SECONDS[clip] ?? null };
  /** On to `ms` into the guest's current clip. */
  const into = (rt, g, ms) => {
    const at = rt.now() - rt.guestActors.get(g.guestId).regionSince('guidance');
    rt.testAdvanceTime(Math.max(0, ms - at));
  };

  it('a gesture during the clip counts, and moves the guest on only when the clip ends', () => {
    const { rt, cues } = makeRuntime(asShown, io);
    const g = arrive(rt, cues);
    into(rt, g, 50_000);
    assert.equal(rt.guestInput(g.guestId, 'tap'), true, 'taken at 50 s');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'but calibration1 plays on');
    into(rt, g, 71_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'still playing at 71 s');
    rt.testAdvanceTime(1_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2', 'calibration2 as calibration1 ends');
    assert.ok(heard(cues).includes('audio/guidance/1B-calibration2.mp3'));
  });

  it('a clip that ends unanswered waits, and the gesture then moves the guest on at once', () => {
    const { rt, cues } = makeRuntime(asShown, io);
    const g = arrive(rt, cues);
    rt.testAdvanceTime(90_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'waiting, in silence');
    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2');
  });

  it('a gesture before the step allows it is ignored, and is not remembered', () => {
    const { rt, cues } = makeRuntime(asShown, io);
    const g = arrive(rt, cues);
    rt.testAdvanceTime(20_000);
    assert.equal(rt.guestInput(g.guestId, 'tap'), false);
    rt.testAdvanceTime(60_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1', 'the early tap did not count');
  });

  it('walks the whole sequence with each clip heard out', () => {
    const { rt, cues } = makeRuntime(asShown, io);
    const g = arrive(rt, cues);
    into(rt, g, 48_000);
    rt.guestInput(g.guestId, 'tap');
    into(rt, g, 72_000);                              // calibration1 ends at 71.9 s
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2');
    into(rt, g, 1_000);
    assert.equal(rt.guestInput(g.guestId, 'swipe'), false, 'swipe not yet: 3 s in');
    into(rt, g, 3_000);
    rt.guestInput(g.guestId, 'swipe');
    into(rt, g, 9_000);                               // calibration2 ends at 8.6 s
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step3');
    into(rt, g, 6_000);
    rt.guestInput(g.guestId, 'drag');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step3', 'calibration3 plays on');
    into(rt, g, 11_500);                              // calibration3 ends at 11.3 s
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step4');
  });

  it('a clip whose length cannot be read lets the gesture act at once, as before', () => {
    const { rt, cues } = makeRuntime(asShown, { clipSeconds: () => null });
    const g = arrive(rt, cues);
    rt.testAdvanceTime(48_000);
    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2');
  });

  it('is checked: needs a clip, and true or false', () => {
    const show = structuredClone(museum);
    const seq = show.guest.machine.guidance.states.prologue.states.calibration.sequence;
    seq[0].playThrough = 'yes';
    seq[1] = { image: 'x.png', advance: 'swipe', playThrough: true };
    const { errors } = expandSequences(show);
    assert.match(errors.join('\n'), /sequence\[0\]\.playThrough must be true or false/);
    assert.match(errors.join('\n'), /sequence\[1\]\.playThrough needs an audio clip/);
  });
});

describe('the lobby, driven from calibration', () => {
  // The lobby (dim_rooms 01_lobby) answers the same three gestures calibration
  // teaches; guests drive it while the sequence waits for them (2026-10-01).
  function withLobby({ asShown = false } = {}) {
    const sockets = [];
    const show = structuredClone(museum);
    if (asShown) show.guest.machine.guidance.states.prologue.states.calibration.sequence = structuredClone(sequenceInShow);
    show.rooms.calibration.experience.endpoint = 'ws://lobby.test:8080';
    const cues = [];
    const rt = new SpatialRuntime({
      enableTick: false,
      clock: new ManualClock(),
      onCue: (guestId, cue) => cues.push({ guestId, ...cue }),
      clipSeconds: (clip) => CLIP_SECONDS[clip] ?? null,
      openExperienceSocket: (url) => {
        const handlers = {};
        const socket = {
          url, sent: [],
          on: (event, fn) => { handlers[event] = fn; },
          send: (raw) => socket.sent.push(JSON.parse(raw)),
          close: () => {},
          last: (t) => [...socket.sent].reverse().find((m) => m.t === t) ?? null,
        };
        sockets.push(socket);
        queueMicrotask(() => handlers.open?.());
        socket.open = () => handlers.open?.();
        return socket;
      },
    });
    assert.deepEqual(rt.load(show).errors, []);
    rt.start();
    sockets[0].open();
    return { rt, cues, lobby: sockets[0] };
  }

  it('a guest in calibration drives the lobby, and the phone is told the show needs its gestures too', () => {
    const { rt, cues, lobby } = withLobby();
    const g = arrive(rt, cues);
    rt.resyncCues(g.guestId);

    assert.equal(lobby.last('lifecycle').state, 'live');
    assert.equal(lobby.last('drivers').drivers.length, 1);
    const cue = cues.find((c) => c.kind === 'experience' && c.guestId === g.guestId);
    assert.equal(cue.endpoint, 'ws://lobby.test:8080');
    assert.equal(cue.gesturesToShow, true);

    // And the sequence still hears them: the phone sends each one both ways.
    for (const input of ['tap', 'swipe', 'drag']) rt.guestInput(g.guestId, input);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step4');
  });

  it('hears only the gestures calibration has taught so far, re-cued as each unlocks', () => {
    const { rt, cues } = withLobby({ asShown: true });
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    rt.guestStarted(g.guestId);
    walkTo(rt, g.guestId, 'calibration', 5000);
    const allowed = () => cues.filter((c) => c.kind === 'experience' && c.guestId === g.guestId).at(-1)?.allow;

    assert.deepEqual(allowed(), [], 'nothing before calibration1 asks');
    rt.testAdvanceTime(2100 + 47_000);
    assert.deepEqual(allowed(), ['tap'], 'tap from 47 s into calibration1');
    rt.guestInput(g.guestId, 'tap');
    rt.testAdvanceTime(25_000);                       // into calibration2
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2');
    assert.deepEqual(allowed(), ['tap'], 'swipe not yet');
    rt.testAdvanceTime(3_000);
    assert.deepEqual(allowed(), ['tap', 'swipe'], 'swipe from 3 s into calibration2, and tap stays');
    rt.guestInput(g.guestId, 'swipe');
    rt.testAdvanceTime(6_000);                        // into calibration3
    assert.deepEqual(allowed(), ['tap', 'swipe']);
    rt.testAdvanceTime(6_000);
    assert.deepEqual(allowed(), ['tap', 'swipe', 'drag'], 'drag from 6 s into calibration3');
    rt.guestInput(g.guestId, 'drag');
    rt.testAdvanceTime(6_000);                        // calibration4
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step4');
    assert.deepEqual(allowed(), ['tap', 'swipe', 'drag'], 'all three in calibration4');
    // One link throughout: the phone is re-cued, never sent away and back.
    assert.equal(cues.filter((c) => c.kind === 'endExperience' && c.guestId === g.guestId).length, 0);
  });

  it('puts a guest on the side of the screen by the beacon their phone heard strongest, checked at each clip', () => {
    const { rt, cues, lobby } = withLobby();
    const left = arrive(rt, cues);
    const right = arrive(rt, cues);
    rt.resyncCues(left.guestId);
    const lastCue = (g) => cues.filter((c) => c.kind === 'experience' && c.guestId === g.guestId).at(-1);
    const cue = lastCue(left);
    assert.deepEqual([...cue.sides].sort(), [46849, 49152], 'the phone is told which beacons to sample');
    assert.equal(cue.sideAfterMs, 3000);
    assert.equal(cue.sideKey, 'guidance.prologue.calibration.step1', 'and in which step');
    assert.deepEqual(lobby.last('drivers').drivers.map((d) => d.side), [undefined, undefined], 'no side until the phone says');

    const step1 = 'guidance.prologue.calibration.step1';
    assert.equal(rt.setGuestSide(left.guestId, 49152, step1), true);
    assert.equal(rt.setGuestSide(right.guestId, 46849, step1), true);
    const driverOf = (g) => {
      const driverId = rt.experienceDrivers('calibration').find((d) => d.guestId === g.guestId).driverId;
      return lobby.last('drivers').drivers.find((d) => d.driverId === driverId);
    };
    assert.equal(driverOf(left).side, 'left');
    assert.equal(driverOf(right).side, 'right');
    assert.equal(driverOf(left).place, step1);

    assert.equal(rt.setGuestSide(left.guestId, 46849, step1), false, 'one pick per clip');
    assert.equal(rt.setGuestSide(left.guestId, 46849, 'guidance.prologue.calibration.step2'), false, 'not for a clip they are not on');
    assert.equal(rt.setGuestSide(right.guestId, 12345, step1), false, 'a beacon the room does not split on');

    // The next clip: the phone is re-cued to sample again, and may change sides.
    rt.guestInput(left.guestId, 'tap');
    const step2 = 'guidance.prologue.calibration.step2';
    assert.equal(lastCue(left).sideKey, step2);
    assert.equal(driverOf(left).side, 'left', 'kept until the new pick');
    assert.equal(rt.setGuestSide(left.guestId, 46849, step2), true);
    assert.equal(driverOf(left).side, 'right');
    assert.equal(driverOf(left).place, step2, 'a new place for the new clip');
    assert.equal(cues.filter((c) => c.kind === 'endExperience' && c.guestId === left.guestId).length, 0, 'one link throughout');
  });

  it('keeps a guest whose location flickers out and back within 15 s as the same driver', () => {
    const { rt, cues, lobby } = withLobby();
    const g = arrive(rt, cues);
    const driverId = () => rt.experienceDrivers('calibration').find((d) => d.guestId === g.guestId)?.driverId;
    const listed = () => lobby.last('drivers').drivers.map((d) => d.driverId);
    const first = driverId();
    assert.ok(first);

    rt.sendGuestToRoom(g.guestId, 'entranceHallway');
    rt.testAdvanceTime(3000);
    assert.deepEqual(listed(), [first], 'still on the piece while away');
    assert.equal(lobby.last('drivers').drivers[0].away, true, 'marked away, so the piece can fade their box now');
    rt.sendGuestToRoom(g.guestId, 'calibration');
    rt.testAdvanceTime(3000);
    assert.equal(driverId(), first, 'the same driver: same box, same place');
    assert.deepEqual(listed(), [first]);
    assert.equal(lobby.last('drivers').drivers[0].away, undefined, 'and back');
  });

  it('lets them go once they have been away longer', () => {
    const { rt, cues, lobby } = withLobby();
    const g = arrive(rt, cues);
    const first = rt.experienceDrivers('calibration')[0].driverId;
    rt.sendGuestToRoom(g.guestId, 'entranceHallway');
    rt.testAdvanceTime(20_000);
    assert.deepEqual(lobby.last('drivers').drivers, [], 'gone from the piece after 15 s');
    assert.equal(lobby.last('lifecycle').state, 'attract');
    rt.sendGuestToRoom(g.guestId, 'calibration');
    rt.testAdvanceTime(3000);
    assert.notEqual(rt.experienceDrivers('calibration')[0]?.driverId, first, 'a new driver now');
  });

  it('drops a guest removed from the show at once', () => {
    const { rt, cues, lobby } = withLobby();
    const g = arrive(rt, cues);
    rt.removeGuest(g.guestId);
    assert.deepEqual(lobby.last('drivers').drivers, []);
  });

  it('takes eight guests at once, each in a colour of their own', () => {
    const { rt, cues, lobby } = withLobby();
    for (let i = 0; i < 8; i++) arrive(rt, cues);
    const drivers = lobby.last('drivers').drivers;
    assert.equal(drivers.length, 8);
    assert.equal(new Set(drivers.map((d) => d.hue)).size, 8);
  });
});

describe('the Mask Room', () => {
  it('plays its clip while they are in it, and stops when they walk into Hall of Heroes', () => {
    const { rt, cues } = makeRuntime();
    const g = arrive(rt, cues);
    for (const input of ['tap', 'swipe', 'drag']) rt.guestInput(g.guestId, input);
    walkTo(rt, g.guestId, 'entranceHallway');
    walkTo(rt, g.guestId, 'maskRoom');
    const clip = () => rt.desiredCues(g.guestId).get('room')?.assetId ?? null;
    assert.equal(clip(), 'audio/guidance/3-maskroom.mp3');
    rt.guestInput(g.guestId, 'tap');
    assert.equal(clip(), 'audio/guidance/3-maskroom.mp3', 'a tap changes nothing');
    walkTo(rt, g.guestId, 'hallOfHeroes');
    assert.notEqual(clip(), 'audio/guidance/3-maskroom.mp3', 'it does not follow them out');
  });
});

describe('a step that only listens once its clip has asked (listenFrom)', () => {
  const withListenFrom = (seconds) => (show) => {
    show.guest.machine.guidance.states.prologue.states.calibration.sequence[0].listenFrom = seconds;
  };

  it('ignores the gesture before the clip asks for it, and takes it after', () => {
    const { rt, cues } = makeRuntime(withListenFrom(60));
    const g = arrive(rt, cues);
    rt.testAdvanceTime(30_000);
    assert.equal(rt.guestInput(g.guestId, 'tap'), false, 'half way through the clip');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
    rt.testAdvanceTime(31_000);
    rt.guestInput(g.guestId, 'tap');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step2', 'once it has asked');
  });

  it('holds only that step: the next ones take their gesture at once', () => {
    const { rt, cues } = makeRuntime(withListenFrom(60));
    const g = arrive(rt, cues);
    rt.testAdvanceTime(61_000);
    rt.guestInput(g.guestId, 'tap');
    rt.guestInput(g.guestId, 'swipe');
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step3');
  });

  it('is set in the show: tap from 47 s, swipe from 3 s, drag from 6 s', () => {
    assert.deepEqual(sequenceInShow.map((step) => step.listenFrom ?? null), [47, 3, 6, null]);
  });

  it('offers nothing to answer until then — the panel and the walkthrough wait too', () => {
    const { rt, cues } = makeRuntime(withListenFrom(60));
    const g = arrive(rt, cues);
    assert.deepEqual(rt.pendingInputs(g.guestId), []);
    rt.testAdvanceTime(61_000);
    assert.deepEqual(rt.pendingInputs(g.guestId), ['tap']);
  });

  it('is checked: seconds, 0 or more', () => {
    const { errors } = expandSequences((() => {
      const show = structuredClone(museum);
      withListenFrom(-1)(show);
      return show;
    })());
    assert.match(errors.join('\n'), /sequence\[0\]\.listenFrom must be a number of seconds/);
  });
});

describe('how long a guest has been in the show (the panel\'s Time)', () => {
  const panelRow = (rt, guestId) => rt.getGuestsRoster().find((g) => g.guestId === guestId);

  it('counts from START DIM, not from when the phone was handed over', () => {
    const { rt } = makeRuntime();
    const g = rt.spawnGuest({ kind: 'phone', guestId: 'mad0098' });
    walkTo(rt, g.guestId, 'frontDesk');
    rt.testAdvanceTime(30_000);
    assert.equal(panelRow(rt, g.guestId).startedAt, null, 'not started yet: the panel shows a dash');
    const pressed = rt.now();
    rt.guestStarted(g.guestId);
    assert.equal(panelRow(rt, g.guestId).startedAt, pressed);
  });

  it('is not reset by a reload or a reconnect, which send ready again', () => {
    const { rt } = makeRuntime();
    const g = rt.spawnGuest({ kind: 'phone', guestId: 'mad0098' });
    walkTo(rt, g.guestId, 'frontDesk');
    rt.guestStarted(g.guestId);
    const started = panelRow(rt, g.guestId).startedAt;
    rt.testAdvanceTime(120_000);
    rt.guestStarted(g.guestId);
    assert.equal(panelRow(rt, g.guestId).startedAt, started);
  });

  it('starts again for the next person on the same phone', () => {
    const { rt } = makeRuntime();
    const g = rt.spawnGuest({ kind: 'phone', guestId: 'mad0098' });
    walkTo(rt, g.guestId, 'frontDesk');
    rt.guestStarted(g.guestId);
    rt.removeGuest('mad0098');
    const next = rt.spawnGuest({ kind: 'phone', guestId: 'mad0098' });
    assert.equal(panelRow(rt, next.guestId).startedAt, null);
  });
});

describe('Help Me, in the runtime', () => {
  const row = (rt, guestId) => rt.getGuestsRoster().find((g) => g.guestId === guestId);

  it('marks the guest until someone is on their way, and a second press changes nothing', () => {
    const { rt } = makeRuntime();
    const g = rt.spawnGuest({ kind: 'phone', guestId: 'mad0098' });
    assert.equal(row(rt, g.guestId).help, null);
    const asked = rt.now();
    assert.equal(rt.guestNeedsHelp(g.guestId), true);
    rt.testAdvanceTime(10_000);
    rt.guestNeedsHelp(g.guestId);
    assert.deepEqual(row(rt, g.guestId).help, { at: asked }, 'still the first press');
    assert.equal(rt.helpOnTheWay(g.guestId), true);
    assert.equal(row(rt, g.guestId).help, null);
    assert.equal(rt.helpOnTheWay(g.guestId), false, 'nothing left to answer');
  });

  it('is gone with the visit: the next person on the phone has not asked', () => {
    const { rt } = makeRuntime();
    rt.spawnGuest({ kind: 'phone', guestId: 'mad0098' });
    rt.guestNeedsHelp('mad0098');
    rt.removeGuest('mad0098');
    const next = rt.spawnGuest({ kind: 'phone', guestId: 'mad0098' });
    assert.equal(row(rt, next.guestId).help, null);
  });
});

describe('pre-calibration, always heard to its end (2026-10-02)', () => {
  const PRE = 'audio/guidance/1-precalibration.mp3';
  const io = { clipSeconds: (clip) => (clip === PRE ? 14.4 : CLIP_SECONDS[clip] ?? null) };
  const pressed = (rt) => {
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    rt.guestStarted(g.guestId);
    return g;
  };
  const stopped = (cues, asset) => cues.some((c) => c.kind === 'stopAudio' && c.assetId === asset);

  it('plays on when the guest walks into calibration partway through', () => {
    const { rt, cues } = makeRuntime(null, io);
    const g = pressed(rt);
    const startedAt = rt.now();
    walkTo(rt, g.guestId, 'calibration'); // in, ~2.6 s after the press
    assert.equal(guidance(rt, g.guestId), 'prologue.walkedInEarly');
    assert.equal(stopped(cues, PRE), false, 'not cut off by walking in');
    assert.equal(rt.desiredCues(g.guestId).get('guidance')?.assetId, PRE, 'still what they hear');

    rt.testAdvanceTime(startedAt + 14_400 - rt.now() - 10);
    assert.deepEqual(heard(cues), [PRE], 'nothing of calibration while it plays');
    rt.testAdvanceTime(10);
    assert.equal(guidance(rt, g.guestId), 'prologue.settling', 'then the usual moment');
    rt.testAdvanceTime(1990);
    assert.deepEqual(heard(cues), [PRE]);
    rt.testAdvanceTime(10);
    assert.equal(guidance(rt, g.guestId), 'prologue.calibration.step1');
    assert.deepEqual(heard(cues), [PRE, 'audio/guidance/1A-calibration1.mp3'], 'two seconds after it ended');
  });

  it('leaves calibration to start two seconds after walking in, for a guest who heard it all at the desk', () => {
    const { rt, cues } = makeRuntime(null, io);
    const g = pressed(rt);
    rt.testAdvanceTime(20_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.heard');
    walkTo(rt, g.guestId, 'calibration');
    assert.equal(guidance(rt, g.guestId), 'prologue.settling');
    rt.testAdvanceTime(2100);
    assert.deepEqual(heard(cues), [PRE, 'audio/guidance/1A-calibration1.mp3']);
  });

  it('finishes for a guest who walks straight through to the hallway, and calibration is skipped', () => {
    const { rt, cues } = makeRuntime(null, io);
    const g = pressed(rt);
    walkTo(rt, g.guestId, 'calibration');
    walkTo(rt, g.guestId, 'entranceHallway');
    assert.equal(guidance(rt, g.guestId), 'prologue.done');
    assert.equal(stopped(cues, PRE), false, 'still playing in the hallway');
    assert.equal(rt.desiredCues(g.guestId).get('guidance')?.assetId, PRE);
    rt.testAdvanceTime(15_000);
    assert.equal(guidance(rt, g.guestId), 'prologue.done');
    assert.equal(rt.desiredCues(g.guestId).get('guidance'), null, 'over, and nothing of calibration');
    assert.deepEqual(heard(cues), [PRE]);
  });

  it('holds the entrance hallway\'s line until it ends, then plays that from its top', () => {
    const HALL = museum.rooms.entranceHallway.cues.idle.audio;
    const { rt, cues } = makeRuntime(null, io);
    const g = pressed(rt);
    const startedAt = rt.now();
    walkTo(rt, g.guestId, 'calibration');
    walkTo(rt, g.guestId, 'entranceHallway');
    const room = () => rt.desiredCues(g.guestId).get('room');
    assert.equal(room(), null, 'the hallway waits while pre-calibration plays');
    assert.equal(cues.some((c) => c.kind === 'audio' && c.assetId === HALL), false);

    rt.testAdvanceTime(startedAt + 14_400 - rt.now());
    assert.equal(room()?.assetId, HALL, 'then speaks');
    assert.equal(room().startAt, startedAt + 14_400, 'from its top, as pre-calibration ends');
    const sent = cues.filter((c) => c.kind === 'audio' && c.assetId === HALL);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].startAt, startedAt + 14_400);

    rt.testAdvanceTime(5000);
    assert.equal(room()?.startAt, startedAt + 14_400, 'and is not restarted after');
  });

  it('leaves the hallway\'s line alone for a guest who heard pre-calibration out', () => {
    const HALL = museum.rooms.entranceHallway.cues.idle.audio;
    const { rt } = makeRuntime(null, io);
    const g = pressed(rt);
    rt.testAdvanceTime(20_000);
    walkTo(rt, g.guestId, 'calibration');
    rt.testAdvanceTime(2100);
    for (const input of ['tap', 'swipe', 'drag']) rt.guestInput(g.guestId, input);
    walkTo(rt, g.guestId, 'entranceHallway');
    const room = rt.desiredCues(g.guestId).get('room');
    assert.equal(room?.assetId, HALL);
    const arrived = rt.coordinator.getRoomOccupants('entranceHallway').find((o) => o.guestId === g.guestId).sinceTs;
    assert.equal(room.startAt, arrived, 'on arrival, as ever');
  });

  it('plays a phone that reconnects partway the rest of it, from where it has got to', () => {
    const { rt, cues } = makeRuntime(null, io);
    const g = pressed(rt);
    const startedAt = rt.now();
    walkTo(rt, g.guestId, 'calibration');
    cues.length = 0;
    rt.resyncCues(g.guestId);
    const pre = cues.find((c) => c.kind === 'audio' && c.slot === 'guidance');
    assert.equal(pre.assetId, PRE);
    assert.equal(pre.startAt, startedAt, 'on the clock of the press, not restarted');
  });

  it('tells the phone to have it decoded before the press', () => {
    const { rt } = makeRuntime(null, io);
    assert.deepEqual(rt.warmAudio(), [PRE]);
  });
});

describe('the rooms after the museum speak (2026-10-02)', () => {
  it('a museum room\'s spoken line does not silence the rooms the guest walks into after', () => {
    const { rt } = makeRuntime(null, { clipSeconds: () => 10 });
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'frontDesk');
    rt.guestStarted(g.guestId);
    rt.testAdvanceTime(20_000);
    for (const r of ['calibration', 'entranceHallway', 'maskRoom', 'hallOfHeroes', 'cyclorama', 'museumHallway', 'slop']) {
      walkTo(rt, g.guestId, r, 6000);
    }
    assert.ok(rt.museum.guests.get(g.guestId)?.voice, 'slop spoke to them');
    for (const r of ['museumHallway', 'southCorridor', 'dataCenter']) walkTo(rt, g.guestId, r, 6000);
    assert.equal(guidance(rt, g.guestId), 'museum', 'still in the museum phase');
    assert.equal(rt.desiredCues(g.guestId).get('room')?.assetId, museum.rooms.dataCenter.cues.active.audio);
  });
});
