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
  const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock() });
  const result = rt.load(show);
  assert.deepEqual(result.errors, []);
  rt.start();
  return rt;
}

const walk = (rt, guestId, point, ms = 2600) => {
  rt.setVirtualPosition(guestId, point[0], point[1]);
  rt.testAdvanceTime(ms);
};

/** Paths are handed out at the hallway, so every guest passes through it. */
function spawnOnPath(rt, pathId) {
  for (let i = 0; i < 6; i++) {
    const g = rt.spawnGuest();
    walk(rt, g.guestId, AT.hallway, 1700);
    if (rt.guests.get(g.guestId).pathId === pathId) return g;
    rt.removeGuest(g.guestId);
  }
  throw new Error(`no guest assigned to ${pathId}`);
}

const standing = (rt, guestId) => rt.guestActors.get(guestId).currentRoom()?.standing;
const roomOf = (rt, roomId) => rt.getRoomsRoster().find((r) => r.roomId === roomId);

/** Fill a room with n guests eligible for it, in arrival order. */
function fill(rt, pathId, point, n) {
  const guests = [];
  for (let i = 0; i < n; i++) {
    const g = spawnOnPath(rt, pathId);
    walk(rt, g.guestId, point);
    rt.testAdvanceTime(80);
    guests.push(g);
  }
  return guests;
}

describe('multi-guest policies', () => {
  it('collaborative: company joins as participants, and one holder remains', () => {
    const rt = makeRuntime((s) => { s.rooms.library.multiGuest.maxOccupants = 6; });
    const [a, b, c] = fill(rt, 'pathA', AT.library, 3);
    assert.equal(standing(rt, a.guestId), 'holder');
    assert.equal(standing(rt, b.guestId), 'participant');
    assert.equal(standing(rt, c.guestId), 'participant');
    assert.equal(roomOf(rt, 'library').lockHolder, a.guestId);
  });

  it('spectator: company watches, whatever the capacity', () => {
    // Without removing the greenhouse's self-ending timer the content would run
    // out mid-test and the second arrival would inherit an idle room instead.
    const rt = makeRuntime((s) => { delete s.rooms.greenhouse.machine.states.active.after; });
    const [a, b] = fill(rt, 'pathA', AT.greenhouse, 2);
    assert.equal(standing(rt, a.guestId), 'holder');
    assert.equal(standing(rt, b.guestId), 'spectator');
  });

  it('refuse: company is turned away', () => {
    const rt = makeRuntime();
    const [a, b] = fill(rt, 'pathB', AT.cellar, 2);
    assert.equal(standing(rt, a.guestId), 'holder');
    assert.equal(standing(rt, b.guestId), 'refused');
    assert.equal(rt.guestActors.get(b.guestId).currentRoom().reason, 'refuse');
  });

  it('personalVariant: the room is unchanged and their phone differs', () => {
    const rt = makeRuntime((s) => { s.rooms.library.multiGuest.policy = 'personalVariant'; });
    const [a, b] = fill(rt, 'pathA', AT.library, 2);
    assert.equal(standing(rt, a.guestId), 'holder');
    assert.equal(standing(rt, b.guestId), 'personalVariant');
    assert.equal(roomOf(rt, 'library').lockHolder, a.guestId);
  });
});

describe('capacity', () => {
  it('caps participation, and hands the overflow its atCapacity treatment', () => {
    const rt = makeRuntime();   // library: collaborative, max 2, atCapacity spectator
    const [a, b, c] = fill(rt, 'pathA', AT.library, 3);
    assert.equal(standing(rt, a.guestId), 'holder');
    assert.equal(standing(rt, b.guestId), 'participant');
    assert.equal(standing(rt, c.guestId), 'spectator');
    assert.equal(rt.guestActors.get(c.guestId).currentRoom().reason, 'atCapacity');
  });

  it('can refuse the overflow instead', () => {
    const rt = makeRuntime((s) => { s.rooms.library.multiGuest.atCapacity = 'refuse'; });
    const [, , c] = fill(rt, 'pathA', AT.library, 3);
    assert.equal(standing(rt, c.guestId), 'refused');
    assert.equal(rt.guestActors.get(c.guestId).currentRoom().reason, 'atCapacity');
  });

  it('promotes the next in line when a slot frees, with no bookkeeping', () => {
    // Standing is derived from arrival order rather than a membership list, so
    // somebody leaving promotes whoever was waiting without anything tracking it.
    const rt = makeRuntime();
    const [, b, c] = fill(rt, 'pathA', AT.library, 3);
    assert.equal(standing(rt, c.guestId), 'spectator');
    walk(rt, b.guestId, AT.out, 900);
    rt.testAdvanceTime(200);
    assert.equal(standing(rt, c.guestId), 'participant');
  });

  it('counts the guests the room is running for, not the bodies in it', () => {
    // Somebody standing in a room that is not theirs took no slot: they got the
    // ineligible response and the room never changed for them. The cellar
    // refuses company and stays dark for a guest it is not for.
    const rt = makeRuntime();
    const owner = spawnOnPath(rt, 'pathB');      // the cellar is pathB's
    walk(rt, owner.guestId, AT.cellar);
    const stray = spawnOnPath(rt, 'pathA');      // it is not pathA's
    walk(rt, stray.guestId, AT.cellar);

    const cellar = roomOf(rt, 'cellar');
    assert.equal(cellar.occupantCount, 2, 'two bodies in the space');
    assert.deepEqual(cellar.eligibleOccupants, [owner.guestId], 'one guest it runs for');
    assert.equal(standing(rt, stray.guestId), 'notTheirs');
    // And the owner keeps it — a body that took no slot cannot displace them.
    assert.equal(standing(rt, owner.guestId), 'holder');
  });
});

describe('telling the room how many it is running for', () => {
  it('opens a collaborative beat on the second guest, and closes it after', () => {
    const rt = makeRuntime();
    const [a, b] = fill(rt, 'pathA', AT.library, 1);
    rt.testAdvanceTime(1400);
    assert.equal(roomOf(rt, 'library').state, 'active.main');

    const second = spawnOnPath(rt, 'pathA');
    walk(rt, second.guestId, AT.library);
    assert.equal(roomOf(rt, 'library').state, 'active.together');

    walk(rt, second.guestId, AT.out, 900);
    rt.testAdvanceTime(200);
    assert.equal(roomOf(rt, 'library').state, 'active.main');
    assert.equal(roomOf(rt, 'library').lockHolder, a?.guestId ?? b?.guestId);
  });

  it('says nothing to a room that is not running', () => {
    const rt = makeRuntime();
    const owner = spawnOnPath(rt, 'pathB');
    walk(rt, owner.guestId, AT.cellar);
    const stray = spawnOnPath(rt, 'pathA');
    walk(rt, stray.guestId, AT.cellar);
    // The cellar declares `lockedMessage`, so it never heard about the stray at
    // all — and its occupant count never counted them.
    assert.equal(roomOf(rt, 'cellar').lastRefuse, null);
    assert.equal(standing(rt, stray.guestId), 'notTheirs');
  });
});
