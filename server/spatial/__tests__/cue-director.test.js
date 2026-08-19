import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const demo = JSON.parse(readFileSync(join(root, 'shows/spatial-demo.json'), 'utf8'));

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
    // purpose. Here the room genuinely carries on where it was.
    const { rt, cues } = makeRuntime((s) => { delete s.rooms.greenhouse.machine.states.active.after; });
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
    assert.equal(hearing(rt, a.guestId).adherence, 'click.wav');
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
