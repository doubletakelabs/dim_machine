import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { validateShowDefinition } from '../validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const demo = JSON.parse(readFileSync(join(root, 'fixtures/small-show.json'), 'utf8'));

const AT = { hallway: [320, 235], library: [200, 140], greenhouse: [440, 140], cellar: [300, 340], out: [10, 10] };

function makeRuntime(mutate) {
  const show = structuredClone(demo);
  if (mutate) mutate(show);
  const cues = [];
  const rt = new SpatialRuntime({
    enableTick: false,
    clock: new ManualClock(),
    onCue: (guestId, cue) => cues.push({ guestId, ...cue }),
  });
  const result = rt.load(show);
  assert.deepEqual(result.errors, []);
  rt.start();
  return { rt, cues };
}

const walk = (rt, guestId, point, ms = 2600) => {
  rt.setVirtualPosition(guestId, point[0], point[1]);
  rt.testAdvanceTime(ms);
};

/** Walk in and let the room finish opening — the library holds `activating` for
 *  1200ms, and activation only starts once entry is confirmed. */
const enter = (rt, guestId, point) => {
  walk(rt, guestId, point);
  rt.testAdvanceTime(1500);
};

function spawnOnPath(rt, pathId) {
  for (let i = 0; i < 8; i++) {
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway, 1700);
    if (rt.guests.get(g.guestId).pathId === pathId) return g;
    rt.removeGuest(g.guestId);
  }
  throw new Error(`no guest assigned to ${pathId}`);
}

/** What each phone is playing per slot, as the director believes it. */
const hearing = (rt, guestId) => rt.cueSnapshot(guestId);
const forGuest = (cues, guestId) => cues.filter((c) => c.guestId === guestId);

describe('cue director', () => {
  it('plays a room cue to the guest the room is running for', () => {
    const { rt } = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.library);
    assert.equal(rt.guestActors.get(a.guestId).currentRoom().standing, 'holder');
    assert.equal(hearing(rt, a.guestId).room, 'whisper.wav');
  });

  it('gives a spectator different audio from a participant, in the same room', () => {
    // The point of the whole layer: one room state, two audiences, decided from
    // standing rather than from anything the room knows about either guest.
    const { rt } = makeRuntime((s) => { delete s.rooms.greenhouse.machine.states.active.after; });
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.greenhouse);
    const b = spawnOnPath(rt, 'pathA');
    enter(rt, b.guestId, AT.greenhouse);

    assert.equal(rt.guestActors.get(b.guestId).currentRoom().standing, 'spectator');
    assert.equal(hearing(rt, a.guestId).room, 'whisper.wav');
    assert.equal(hearing(rt, b.guestId).room, 'ambient.wav');
  });

  it('hands a late arrival the running content, seeked to where it is', () => {
    // The case an event-driven director gets wrong: the activation happened
    // before this guest existed, so there is no event left to receive.
    // The greenhouse, not the library: the library moves to a collaborative
    // sub-state when a second guest arrives, which restarts its content on
    // purpose. Here the room genuinely carries on where it was — and runs one
    // timeline for everyone (`together`), so the late arrival joins partway.
    const { rt, cues } = makeRuntime((s) => {
      delete s.rooms.greenhouse.machine.states.active.after;
      s.rooms.greenhouse.audio = { ...s.rooms.greenhouse.audio, timing: 'together' };
    });
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.greenhouse);
    rt.testAdvanceTime(30_000);

    const b = spawnOnPath(rt, 'pathA');
    enter(rt, b.guestId, AT.greenhouse);
    const cue = forGuest(cues, b.guestId).filter((c) => c.kind === 'audio' && c.slot === 'room').pop();

    assert.equal(cue.assetId, 'ambient.wav', 'joins as a spectator, mid-content');
    assert.equal(cue.seek, true);
    assert.ok(rt.clock.now() - cue.startAt >= 30_000, 'startAt is when the room began, not now');
  });

  it('sends nothing when nothing changed', () => {
    const { rt, cues } = makeRuntime((s) => { });
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.library);
    const before = forGuest(cues, a.guestId).length;
    for (let i = 0; i < 5; i++) rt.reconcileCues();
    assert.equal(forGuest(cues, a.guestId).length, before);
  });

  it('stops room audio when the guest walks out', () => {
    const { rt, cues } = makeRuntime((s) => { });
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.library);
    walk(rt, a.guestId, AT.hallway);

    assert.notEqual(hearing(rt, a.guestId).room, 'whisper.wav');
    assert.ok(forGuest(cues, a.guestId).some((c) => c.kind === 'stopAudio' && c.assetId === 'whisper.wav'));
  });

  it('resends everything to a phone that reconnected', () => {
    const { rt, cues } = makeRuntime((s) => { });
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.library);
    const before = forGuest(cues, a.guestId).length;

    rt.resyncCues(a.guestId);
    const resent = forGuest(cues, a.guestId).slice(before);
    assert.ok(resent.some((c) => c.kind === 'audio' && c.assetId === 'whisper.wav'));
  });

  it('plays guest cues from an authored region, independently of the room', () => {
    const { rt } = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.library);
    rt.guestActors.get(a.guestId).send({ type: 'wentOffPath' });
    rt.reconcileCues();
    assert.equal(hearing(rt, a.guestId).adherence, 'chime.wav');
    assert.equal(hearing(rt, a.guestId).room, 'whisper.wav', 'room slot is untouched');
  });

  it('matches a cue keyed on the root of a nested room state', () => {
    // The dotted-state bug, in its third home. The library's `active` is a
    // nested state already, so `active.main` must find the cue keyed `active`.
    const { rt } = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.library);
    assert.match(rt.getRoomsRoster().find((r) => r.roomId === 'library').state, /^active/);
    assert.equal(hearing(rt, a.guestId).room, 'whisper.wav');
  });

  it('leaves an ineligible guest in silence when the room declares it', () => {
    const { rt } = makeRuntime((s) => { });
    const a = spawnOnPath(rt, 'pathA');
    enter(rt, a.guestId, AT.library);
    const b = spawnOnPath(rt, 'pathB');
    enter(rt, b.guestId, AT.cellar);
    enter(rt, b.guestId, AT.library);
    assert.equal(rt.guestActors.get(b.guestId).currentRoom().standing, 'participant');
    assert.equal(hearing(rt, a.guestId).room, 'whisper.wav');
  });
});

describe('audio timing — whose clock a room\'s cues run on', () => {
  // §8.1 `audio.timing` (2026-09-26). own (the default) keys a clip to each
  // guest's arrival, so everyone hears it from its top. together keys it to the
  // state's own timestamp: one timeline for the room, joined partway through.
  function twoArrivals(mutate) {
    const { rt } = makeRuntime(mutate);
    const a = rt.spawnGuest();
    walk(rt, a.guestId, AT.hallway);
    const b = rt.spawnGuest();
    rt.testAdvanceTime(5000);
    walk(rt, b.guestId, AT.hallway);
    const cueA = rt.desiredCues(a.guestId).get('room');
    const cueB = rt.desiredCues(b.guestId).get('room');
    assert.ok(cueA && cueB, 'both hear the hallway bed');
    return { rt, a, b, cueA, cueB };
  }

  it('own, the default: each guest hears the clip from their own arrival', () => {
    const { cueA, cueB } = twoArrivals();
    assert.ok(cueB.startAt > cueA.startAt, 'the later arrival starts later');
    // And the key carries the difference, so the director actually re-cues
    // per guest rather than treating both as the same playing thing.
    assert.notEqual(cueA.key, cueB.key);
  });

  it('own: a change of state starts the new clip from its top for everyone inside', () => {
    const { rt, a, b } = twoArrivals();
    rt.testAdvanceTime(3000);
    const room = rt.rooms.get('hallway');
    const before = room.stateSince;
    // Stand in for the room's computer moving the room on.
    room.stateSince = rt.now();
    const cueA = rt.desiredCues(a.guestId).get('room');
    const cueB = rt.desiredCues(b.guestId).get('room');
    assert.ok(room.stateSince > before);
    assert.equal(cueA.startAt, room.stateSince);
    assert.equal(cueB.startAt, room.stateSince);
  });

  it('together: two guests hear the same moment', () => {
    const { cueA, cueB } = twoArrivals((show) => { show.rooms.hallway.audio = { timing: 'together' }; });
    assert.equal(cueA.startAt, cueB.startAt, 'anchored to the state, not to either of them');
  });

  it('the old names still work, and are warned about', () => {
    const { cueA, cueB } = twoArrivals((show) => { show.rooms.hallway.audio = { timing: 'masterTimeline' }; });
    assert.equal(cueA.startAt, cueB.startAt);
    const def = structuredClone(demo);
    def.rooms.greenhouse.audio = { ...def.rooms.greenhouse.audio, timing: 'perGuest' };
    assert.match(validateShowDefinition(def).warnings.join('\n'), /"perGuest" was renamed "own"/);
  });
});

describe('the mixer numbers reach the wire', () => {
  it('a vacated bg fades over the show-authored crossfade', () => {
    const { rt, cues } = makeRuntime((show) => {
      show.guest = { ...show.guest, audioLayers: { crossfadeMs: 2000 } };
      show.rooms.hallway.bg = 'bg/rain.mp3';
    });
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway);
    walk(rt, g.guestId, AT.cellar);
    const stop = forGuest(cues, g.guestId).filter((c) => c.kind === 'stopAudio' && c.assetId === 'bg/rain.mp3');
    assert.equal(stop.length, 1, 'a room with no bg vacates it');
    assert.equal(stop[0].fadeMs, 2000, 'the fade is the authored crossfade, not the hard default');
  });

  it('a room clip is a voice: leaving it keeps the short tail', () => {
    const { rt, cues } = makeRuntime((show) => {
      show.guest = { ...show.guest, audioLayers: { crossfadeMs: 2000 } };
    });
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway);
    assert.ok(rt.desiredCues(g.guestId).get('room'), 'the hallway clip is playing');
    walk(rt, g.guestId, AT.out);
    const stop = forGuest(cues, g.guestId).filter((c) => c.kind === 'stopAudio').at(-1);
    assert.equal(stop.fadeMs, 400);
  });
});

describe('the layers under the voices', () => {
  const layerCues = (cues, guestId, slot) => forGuest(cues, guestId).filter((c) => c.slot === slot);
  const stopsOf = (cues, guestId, assetId) => forGuest(cues, guestId)
    .filter((c) => c.kind === 'stopAudio' && c.assetId === assetId);

  it('a room\'s bg loops', () => {
    const { rt, cues } = makeRuntime((show) => { show.rooms.hallway.bg = 'bg/rain.mp3'; });
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway);
    const [bg] = layerCues(cues, g.guestId, 'bg');
    assert.equal(bg.assetId, 'bg/rain.mp3');
    assert.equal(bg.loop, true);
  });

  it('carries the same bg on unbroken into the next room', () => {
    const { rt, cues } = makeRuntime((show) => {
      show.rooms.hallway.bg = 'bg/rain.mp3';
      show.rooms.cellar.bg = { audio: 'bg/rain.mp3', gain: 0.5 };
    });
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway);
    walk(rt, g.guestId, AT.cellar);
    walk(rt, g.guestId, AT.hallway);
    assert.equal(layerCues(cues, g.guestId, 'bg').length, 1, 'sent once, never restarted');
    assert.equal(stopsOf(cues, g.guestId, 'bg/rain.mp3').length, 0);
  });

  it('hands a different bg over, the old one fading as the new one starts', () => {
    const { rt, cues } = makeRuntime((show) => {
      show.rooms.hallway.bg = 'bg/rain.mp3';
      show.rooms.cellar.bg = 'bg/wind.mp3';
    });
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway);
    walk(rt, g.guestId, AT.cellar);
    assert.deepEqual(layerCues(cues, g.guestId, 'bg').map((c) => c.assetId), ['bg/rain.mp3', 'bg/wind.mp3']);
    assert.equal(stopsOf(cues, g.guestId, 'bg/rain.mp3').length, 1);
  });

  it('keeps the bg through a gap in the sensing — no room is not a room without one', () => {
    const { rt, cues } = makeRuntime((show) => { show.rooms.hallway.bg = 'bg/rain.mp3'; });
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway);
    walk(rt, g.guestId, AT.out);
    assert.equal(rt.desiredCues(g.guestId).get('bg')?.assetId, 'bg/rain.mp3');
    assert.equal(stopsOf(cues, g.guestId, 'bg/rain.mp3').length, 0);
  });

  it('starts the bed in its room, and keeps it under everything after', () => {
    const { rt, cues } = makeRuntime((show) => {
      show.guest = { ...show.guest, bed: { audio: 'bed/drone.mp3', from: 'cellar' } };
    });
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway);
    assert.equal(rt.desiredCues(g.guestId).get('bed'), null, 'not before its room');

    walk(rt, g.guestId, AT.cellar);
    const bed = rt.desiredCues(g.guestId).get('bed');
    assert.equal(bed.assetId, 'bed/drone.mp3');
    assert.equal(bed.loop, true);

    walk(rt, g.guestId, AT.hallway);
    walk(rt, g.guestId, AT.out);
    assert.equal(rt.desiredCues(g.guestId).get('bed').key, bed.key, 'the same bed, never restarted');
    assert.equal(layerCues(cues, g.guestId, 'bed').length, 1);
  });

  it('gives each guest their own bed, from their own arrival', () => {
    const { rt } = makeRuntime((show) => {
      show.guest = { ...show.guest, bed: { audio: 'bed/drone.mp3', from: 'hallway' } };
    });
    const a = rt.spawnGuest();
    walk(rt, a.guestId, AT.hallway);
    rt.testAdvanceTime(5000);
    const b = rt.spawnGuest();
    walk(rt, b.guestId, AT.hallway);
    assert.ok(rt.desiredCues(b.guestId).get('bed').startAt > rt.desiredCues(a.guestId).get('bed').startAt);
  });
});
