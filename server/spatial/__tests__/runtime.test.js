import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const spatialDemo = JSON.parse(
  readFileSync(join(root, 'shows/spatial-demo.json'), 'utf8'),
);

describe('SpatialRuntime', () => {
  /** Every runtime under test runs on a manual show clock. */
  function makeRuntime(io = {}) {
    return new SpatialRuntime({ enableTick: false, clock: new ManualClock(), ...io });
  }

  it('loads spatial-demo and reports three rooms', () => {
    const rt = makeRuntime();
    const result = rt.load(spatialDemo);
    assert.equal(result.ok, true);
    assert.equal(rt.rooms.size, 3);
    assert.deepEqual([...rt.rooms.keys()].sort(), ['cellar', 'greenhouse', 'library']);
  });

  it('rejects v2 definitions', () => {
    const rt = makeRuntime();
    const result = rt.load({ contractVersion: 2, showId: 'old', name: 'Old' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('start requires loaded show', () => {
    const rt = makeRuntime();
    assert.equal(rt.start(), false);
    rt.load(spatialDemo);
    assert.equal(rt.start(), true);
    assert.equal(rt.running, true);
  });

  it('spawnGuest assigns paths round-robin', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const a = rt.spawnGuest();
    const b = rt.spawnGuest();
    const c = rt.spawnGuest();
    assert.ok(a && b && c);
    assert.notEqual(a.pathId, b.pathId);
    assert.equal(a.pathId, c.pathId);
    assert.equal(rt.guests.size, 3);
  });

  it('operator snapshot includes rooms and zero occupancy', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const snap = rt.getOperatorSnapshot();
    assert.equal(snap.show.roomCount, 3);
    assert.equal(snap.guests.length, 0);
    assert.equal(snap.rooms.every((r) => r.state === 'idle'), true);
    assert.deepEqual(snap.coordinator.occupancy, {});
  });

  it('emitRoomOutput appends to output log', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.emitRoomOutput({ type: 'roomOutput', roomId: 'library', state: 'active' });
    assert.equal(rt.outputLog.length, 1);
    assert.equal(rt.outputLog[0].roomId, 'library');
  });

  it('setVirtualPosition commits occupancy after the entry hold', () => {
    const events = [];
    const rt = makeRuntime({ onOccupancy: (ev) => events.push(ev) });
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest({ label: 'Walker' });
    rt.setVirtualPosition(p.guestId, 200, 140);
    // Entry is confirmed, not immediate — nothing commits until the hold passes.
    assert.equal(rt.getGuestByToken(p.token).occupancy, 'outside');
    assert.equal(rt.getGuestByToken(p.token).roomId, null);
    rt.testAdvanceTime(1500);
    assert.equal(rt.getGuestByToken(p.token).occupancy, 'inside');
    assert.ok(events.some((e) => e.type === 'zone.occupancy' && e.occupancy === 'inside'));
    const library = rt.getRoomsRoster().find((r) => r.roomId === 'library');
    assert.ok(library.occupants.includes(p.guestId));
  });

  it('entering an eligible room activates it automatically', () => {
    // Walking in is the trigger — there is nothing to press (§3.4).
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();          // pathA: library + greenhouse
    rt.setVirtualPosition(p.guestId, 200, 140);

    // Nothing happens until entry is confirmed.
    assert.equal(rt.getRoomsRoster().find((r) => r.roomId === 'library').state, 'idle');
    rt.testAdvanceTime(1500);

    const library = rt.getRoomsRoster().find((r) => r.roomId === 'library');
    assert.match(library.state, /^activating|^active/);
    assert.equal(library.lockHolder, p.guestId);
    assert.equal(rt.getGuestByToken(p.token).lastEntry.outcome, 'activated');
  });

  it('requestActivation accepts then refuses a second guest', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const a = rt.spawnGuest({ label: 'A' });
    const b = rt.spawnGuest({ label: 'B' });
    const first = rt.requestActivation(a.guestId, 'library');
    assert.equal(first.ok, true);
    rt.testAdvanceTime(1200);
    const library = rt.getRoomsRoster().find((r) => r.roomId === 'library');
    assert.equal(library.lockHolder, a.guestId);
    assert.match(library.state, /^active/);
    const second = rt.requestActivation(b.guestId, 'library');
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'locked');
    assert.ok(rt.outputLog.some((o) => o.roomId === 'library' && String(o.state).startsWith('active')));
  });

  it('operator snapshot includes zone floor plan geometry', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    assert.ok(rt.getOperatorSnapshot().zones['library-main'].polygon.length >= 3);
  });

  it('setVirtualOccupancy places a guest without floor-plan geometry', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();
    assert.equal(rt.setVirtualOccupancy(p.guestId, 'cellar', 'inside'), true);
    rt.testAdvanceTime(5000);
    assert.equal(rt.getGuestByToken(p.token).roomId, 'cellar');
    assert.equal(rt.getGuestByToken(p.token).occupancy, 'inside');
    assert.equal(rt.setVirtualOccupancy(p.guestId, 'nowhere', 'inside'), false);
    assert.equal(rt.setVirtualOccupancy(p.guestId, 'cellar', 'nearby'), false);
  });

  it('records every mutation on the single event log', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest({ label: 'Logged' });
    rt.setVirtualPosition(p.guestId, 200, 140);
    rt.testAdvanceTime(1500);
    rt.requestActivation(p.guestId, 'library');

    const types = rt.eventLog.map((e) => e.type);
    for (const expected of ['show.loaded', 'show.started', 'guest.joined', 'zone.occupancy', 'room.activated']) {
      assert.ok(types.includes(expected), `missing ${expected} in event log`);
    }
    assert.ok(rt.eventLog.every((e) => typeof e.at === 'number'));
  });

  it('guest history records visits, seen, and self-activation', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();
    rt.setVirtualPosition(p.guestId, 200, 140);
    rt.testAdvanceTime(1500);
    rt.requestActivation(p.guestId, 'library');
    rt.testAdvanceTime(20000);

    const record = rt.getGuestByToken(p.token).visitHistory.library;
    assert.equal(record.visits, 1);
    assert.equal(record.seen, true);
    assert.equal(record.activatedByMe, true);
    assert.ok(record.firstEnteredAt > 0);
  });

  it('releasing a lock moves the room out of active', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();
    rt.requestActivation(p.guestId, 'library');
    rt.testAdvanceTime(1200);
    assert.equal(rt.releaseRoomLock('library', p.guestId), true);
    const library = rt.getRoomsRoster().find((r) => r.roomId === 'library');
    assert.equal(library.lockHolder, null);
    assert.equal(library.state, 'settling');
  });

  it('walking out of a room drives the full exit path end to end', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();

    rt.setVirtualPosition(p.guestId, 200, 140);   // into the library
    rt.testAdvanceTime(1500);
    rt.requestActivation(p.guestId, 'library');
    rt.testAdvanceTime(1200);
    assert.match(rt.getRoomsRoster().find((r) => r.roomId === 'library').state, /^active/);

    rt.setVirtualPosition(p.guestId, 10, 10);     // out into the corridor
    rt.testAdvanceTime(800);                     // exit confirmation hold
    let library = rt.getRoomsRoster().find((r) => r.roomId === 'library');
    assert.equal(library.state, 'settling');
    assert.equal(library.lockHolder, null);
    assert.equal(library.resetInMs, 10000);

    rt.testAdvanceTime(10000);                   // grace expires
    library = rt.getRoomsRoster().find((r) => r.roomId === 'library');
    assert.equal(library.state, 'idle');
    assert.equal(library.resetInMs, null);
    assert.ok(rt.eventLog.some((e) => e.type === 'room.emptied'));
    assert.ok(rt.eventLog.some((e) => e.type === 'room.reset'));
  });

  it('stepping back into the library within the grace window resumes it', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();
    rt.setVirtualPosition(p.guestId, 200, 140);
    rt.testAdvanceTime(1500);
    rt.requestActivation(p.guestId, 'library');
    rt.testAdvanceTime(1200);

    rt.setVirtualPosition(p.guestId, 10, 10);
    rt.testAdvanceTime(800);
    assert.equal(rt.getRoomsRoster().find((r) => r.roomId === 'library').state, 'settling');

    rt.setVirtualPosition(p.guestId, 200, 140);
    rt.testAdvanceTime(1500);
    const library = rt.getRoomsRoster().find((r) => r.roomId === 'library');
    assert.match(library.state, /^active/);
    assert.equal(library.lockHolder, p.guestId);
  });

  it('a finish room plays out after its occupant leaves', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();
    rt.setVirtualPosition(p.guestId, 440, 140);   // greenhouse: exit policy "finish"
    rt.testAdvanceTime(1500);
    rt.requestActivation(p.guestId, 'greenhouse');

    rt.setVirtualPosition(p.guestId, 10, 10);
    rt.testAdvanceTime(800);
    assert.equal(rt.getRoomsRoster().find((r) => r.roomId === 'greenhouse').state, 'active');

    rt.testAdvanceTime(5000);                    // content runs out in an empty room
    assert.equal(rt.getRoomsRoster().find((r) => r.roomId === 'greenhouse').state, 'settling');
    rt.testAdvanceTime(10000);
    assert.equal(rt.getRoomsRoster().find((r) => r.roomId === 'greenhouse').state, 'idle');
  });

  it('removing a guest runs the same exit path as walking out', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();
    rt.setVirtualPosition(p.guestId, 200, 140);
    rt.testAdvanceTime(1500);
    rt.requestActivation(p.guestId, 'library');
    rt.testAdvanceTime(1200);

    rt.removeGuest(p.guestId);
    const library = rt.getRoomsRoster().find((r) => r.roomId === 'library');
    assert.equal(library.state, 'settling');
    assert.equal(library.lockHolder, null);
    rt.testAdvanceTime(10000);
    assert.equal(rt.getRoomsRoster().find((r) => r.roomId === 'library').state, 'idle');
  });

  it('removing a guest releases any lock they held', () => {
    const rt = makeRuntime();
    rt.load(spatialDemo);
    rt.start();
    const p = rt.spawnGuest();
    rt.requestActivation(p.guestId, 'library');
    rt.removeGuest(p.guestId);
    assert.equal(rt.getRoomsRoster().find((r) => r.roomId === 'library').lockHolder, null);
  });
});
