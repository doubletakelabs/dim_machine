import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock, ScaledClock } from '../clock.js';
import { polygonCentroid, roomCentroid, roomStandingSpot, slotForGuest, floorPlanExtent } from '../zone-math.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const spatialDemo = JSON.parse(readFileSync(join(root, 'shows/spatial-demo.json'), 'utf8'));

function makeRuntime() {
  const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock() });
  rt.load(spatialDemo);
  rt.start();
  return rt;
}

describe('ScaledClock', () => {
  it('advances at the configured multiple of real time', () => {
    const clock = new ScaledClock(10);
    const start = clock.now();
    clock._realBase -= 100;              // simulate 100ms of wall time
    assert.ok(clock.now() - start >= 1000);
  });

  it('changes rate without a discontinuity in virtual time', () => {
    const clock = new ScaledClock(1);
    clock._realBase -= 1000;             // 1s elapsed at 1x
    const before = clock.now();
    clock.setRate(20);
    const after = clock.now();
    // Re-basing must not move the clock backwards or jump it forwards.
    assert.ok(after >= before && after - before < 50);
  });

  it('rate 0 freezes time and holds pending timers', () => {
    const clock = new ScaledClock(1);
    let fired = false;
    clock.setTimeout(() => { fired = true; }, 50);
    clock.setRate(0);
    const frozen = clock.now();
    clock._realBase -= 5000;
    assert.equal(clock.now(), frozen);
    assert.equal(fired, false);
    assert.equal(clock._timers.size, 1);  // held, not dropped
  });

  it('re-arms held timers when the rate returns', () => {
    const clock = new ScaledClock(1);
    clock.setTimeout(() => {}, 1000);
    clock.setRate(0);
    clock.setRate(1);
    const timer = [...clock._timers.values()][0];
    assert.ok(timer.real != null);
  });

  it('clearTimeout drops a timer whether armed or held', () => {
    const clock = new ScaledClock(0);
    const id = clock.setTimeout(() => {}, 100);
    clock.clearTimeout(id);
    assert.equal(clock._timers.size, 0);
  });
});

describe('floor-plan geometry', () => {
  it('computes a polygon centroid', () => {
    const centre = polygonCentroid([[0, 0], [10, 0], [10, 10], [0, 10]]);
    assert.deepEqual(centre.map(Math.round), [5, 5]);
  });

  it('aims at the largest zone of a multi-zone room', () => {
    const centre = roomCentroid(spatialDemo.rooms.library);
    // library-main is far larger than library-alcove, so the target sits in it.
    assert.ok(centre[0] > 120 && centre[0] < 280);
  });

  it('computes the extent across every room', () => {
    const extent = floorPlanExtent(spatialDemo.rooms);
    assert.equal(extent.minX, 120);
    assert.equal(extent.maxX, 520);
    assert.equal(extent.maxY, 360);
  });

  it('returns null when nothing has geometry', () => {
    assert.equal(floorPlanExtent({ a: {} }), null);
  });

  /** Roughly a dot's width on the plan; spots must clear it comfortably. */
  const DOT_WIDTH = 11;

  function minSeparation(room, count) {
    const spots = Array.from({ length: count }, (_, i) => roomStandingSpot(room, i, 12));
    let min = Infinity;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        min = Math.min(min, Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]));
      }
    }
    return min;
  }

  it('spaces standing spots far enough apart that dots do not overlap', () => {
    // Distinct is not enough — two random points can be distinct and still sit
    // on top of each other. This asserts the separation itself.
    for (const count of [2, 5, 8, 12]) {
      const min = minSeparation(spatialDemo.rooms.library, count);
      assert.ok(min > DOT_WIDTH * 1.5, `${count} guests separated by only ${min.toFixed(1)}`);
    }
  });

  it('holds that spacing in the smallest room too', () => {
    const min = minSeparation(spatialDemo.rooms.cellar, 8);
    assert.ok(min > DOT_WIDTH, `cellar spacing ${min.toFixed(1)} too tight`);
  });

  it('keeps standing spots inside the room polygon', () => {
    const poly = spatialDemo.rooms.library.zones['library-main'].polygon;
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    for (let i = 0; i < 25; i++) {
      const [x, y] = roomStandingSpot(spatialDemo.rooms.library, i, 12);
      assert.ok(x > Math.min(...xs) && x < Math.max(...xs), `x ${x} outside`);
      assert.ok(y > Math.min(...ys) && y < Math.max(...ys), `y ${y} outside`);
    }
  });

  it('is stable for a given slot, so dots do not jitter between steps', () => {
    assert.deepEqual(
      roomStandingSpot(spatialDemo.rooms.cellar, 7),
      roomStandingSpot(spatialDemo.rooms.cellar, 7),
    );
  });

  it('a guest keeps their slot when other guests come and go', () => {
    // Numbering occupants as they arrive would rearrange the whole room every
    // time one person walked out.
    const all = ['u-c', 'u-a', 'u-d', 'u-b'];
    const before = slotForGuest(all, 'u-d');
    assert.equal(slotForGuest(all.filter((id) => id !== 'u-x'), 'u-d'), before);
    assert.equal(slotForGuest([...all, 'u-z'], 'u-d'), before);
  });
});

describe('WalkthroughDriver', () => {
  it('walks a guest into a room on their path without any dragging', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest({ label: 'Walker' });
    rt.walkthrough.configure({ speed: 400, stepMs: 100, dwellPadMs: 0 });
    rt.walkthrough.start([g.guestId]);

    for (let i = 0; i < 60; i++) rt.testAdvanceTime(100);

    const guest = rt.getGuestByToken(g.token);
    assert.ok(guest.roomId, 'walker should have reached a room');
    assert.ok(rt.guestActors.get(g.guestId).eligibleRoomIds().includes(guest.roomId));
  });

  it('produces ordinary virtual position events, indistinguishable from a drag', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.walkthrough.configure({ speed: 400, stepMs: 100, dwellPadMs: 0 });
    rt.walkthrough.start([g.guestId]);
    for (let i = 0; i < 40; i++) rt.testAdvanceTime(100);

    const events = rt.eventLog.filter((e) => e.type === 'zone.occupancy');
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.source === 'virtual'));
  });

  it('moves on to a second room once the first is seen', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.walkthrough.configure({ speed: 400, stepMs: 100 });
    rt.walkthrough.start([g.guestId]);
    for (let i = 0; i < 700; i++) rt.testAdvanceTime(100);

    const seen = Object.values(rt.getGuestByToken(g.token).visitHistory).filter((v) => v.seen);
    assert.ok(seen.length >= 2, `expected two rooms seen, got ${seen.length}`);
  });

  it('derives dwell from each room rather than one flat number', () => {
    // A flat dwell has to be as long as the slowest room, and then every other
    // room drags. The demo rooms differ: library 20s, greenhouse 15s, cellar 10s.
    const rt = makeRuntime();
    rt.walkthrough.configure({ dwellPadMs: 2000 });
    assert.equal(rt.walkthrough.dwellMsFor('library'), 22000);
    assert.equal(rt.walkthrough.dwellMsFor('greenhouse'), 17000);
    assert.equal(rt.walkthrough.dwellMsFor('cellar'), 12000);
  });

  it('caps dwell for a room with an extreme threshold', () => {
    const rt = makeRuntime();
    rt.def.rooms.library.seen.dwellMs = 600000;
    rt.walkthrough.configure({ dwellPadMs: 2000, maxDwellMs: 40000 });
    assert.equal(rt.walkthrough.dwellMsFor('library'), 40000);
  });

  it('reports what a walker is doing and when it will move', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.walkthrough.configure({ speed: 400, stepMs: 100 });
    rt.walkthrough.start([g.guestId]);

    rt.testAdvanceTime(100);
    let intent = rt.walkthrough.intent(g.guestId);
    assert.equal(intent.phase, 'walking');
    assert.ok(intent.targetRoomId);

    for (let i = 0; i < 40; i++) rt.testAdvanceTime(100);
    intent = rt.walkthrough.intent(g.guestId);
    assert.equal(intent.phase, 'dwelling');
    assert.ok(intent.movesInMs > 0);
    assert.equal(intent.dwellRoomId, rt.getGuestByToken(g.token).roomId);
  });

  it('surfaces the walker intent on the guest roster', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.walkthrough.start([g.guestId]);
    rt.testAdvanceTime(120);
    const row = rt.getGuestsRoster().find((x) => x.guestId === g.guestId);
    assert.equal(row.walking, true);
    assert.ok(row.intent);
  });

  it('stops cleanly and forgets its walkers', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.walkthrough.start([g.guestId]);
    assert.equal(rt.walkthrough.status().walking.length, 1);
    rt.walkthrough.stop();
    assert.equal(rt.walkthrough.running, false);
    assert.deepEqual(rt.walkthrough.status().walking, []);
  });

  it('drops a walker when the guest leaves the show', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.walkthrough.start([g.guestId]);
    rt.removeGuest(g.guestId);
    assert.deepEqual(rt.walkthrough.status().walking, []);
  });
});

describe('operator snapshot for the floor plan', () => {
  it('carries geometry, time scale, and walkthrough state', () => {
    const rt = makeRuntime();
    const snap = rt.getOperatorSnapshot();
    assert.equal(snap.floorPlan.width, 640);
    assert.equal(snap.floorPlan.extent.minX, 120);
    assert.equal(snap.timeScale, 1);
    assert.equal(snap.walkthrough.running, false);
  });

  it('carries a show clock the panel can extrapolate between pushes', () => {
    const rt = makeRuntime();
    assert.equal(rt.getOperatorSnapshot().clock.elapsedMs, 0);
    rt.testAdvanceTime(5000);
    const clock = rt.getOperatorSnapshot().clock;
    assert.equal(clock.elapsedMs, 5000);
    assert.equal(clock.rate, 1);
    assert.ok(clock.startedAt != null);
  });

  it('has no elapsed time before the show starts', () => {
    const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock() });
    rt.load(spatialDemo);
    assert.equal(rt.getOperatorSnapshot().clock.elapsedMs, null);
  });

  it('tags every zone with the room that owns it', () => {
    const rt = makeRuntime();
    const zones = rt.getOperatorSnapshot().zones;
    assert.equal(zones['library-alcove'].roomId, 'library');
    assert.equal(zones['library-main'].roomId, 'library');
    assert.equal(Object.keys(zones).length, 4);
  });

  it('gives a dragged guest their exact point', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.setVirtualPosition(g.guestId, 200, 140);
    const snap = rt.getGuestsRoster().find((x) => x.guestId === g.guestId);
    assert.deepEqual(snap.position, { x: 200, y: 140, source: 'virtual' });
  });

  it('falls back to the room centroid for a guest located without coordinates', () => {
    // How a BLE guest will appear: a room, but no floor-plan point.
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.setVirtualOccupancy(g.guestId, 'cellar', 'inside');
    rt.testAdvanceTime(1600);
    const snap = rt.getGuestsRoster().find((x) => x.guestId === g.guestId);
    assert.equal(snap.position.source, 'room');
    assert.ok(snap.position.x > 220 && snap.position.x < 380);
  });

  it('carries a pending confirmation on the motion channel', () => {
    // It lives for entryConfirmMs and would be missed on the periodic roster —
    // and it is exactly the gap between the dot being inside and the room
    // reacting, so the panel needs it to show progress rather than a freeze.
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.setVirtualPosition(g.guestId, 200, 140);
    const row = rt.getPositionsSnapshot().find((x) => x.guestId === g.guestId);
    assert.equal(row.pending.roomId, 'library');
    assert.equal(row.pending.occupancy, 'inside');
    assert.equal(row.pending.holdMs, 1500);
    assert.ok(typeof row.now === 'number');
  });

  it('clears the pending confirmation once it commits', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    rt.setVirtualPosition(g.guestId, 200, 140);
    rt.testAdvanceTime(1600);
    const row = rt.getPositionsSnapshot().find((x) => x.guestId === g.guestId);
    assert.equal(row.pending, null);
    assert.equal(row.roomId, 'library');
  });

  it('reports no position for a guest who is nowhere', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    assert.equal(rt.getGuestsRoster().find((x) => x.guestId === g.guestId).position, null);
  });
});

describe('operator overrides', () => {
  it('sends an event straight into a room machine', () => {
    const rt = makeRuntime();
    assert.equal(rt.sendRoomEvent('cellar', 'ACTIVATE'), true);
    assert.match(rt.getRoomsRoster().find((r) => r.roomId === 'cellar').state, /^active/);
    assert.ok(rt.eventLog.some((e) => e.type === 'room.operatorEvent'));
  });

  it('ignores an unknown room', () => {
    const rt = makeRuntime();
    assert.equal(rt.sendRoomEvent('nowhere', 'ACTIVATE'), false);
  });

  it('setTimeScale is a no-op on a clock that cannot scale', () => {
    const rt = makeRuntime();          // ManualClock has no setRate
    assert.equal(rt.setTimeScale(10), null);
    assert.equal(rt.timeScale(), 1);
  });
});
