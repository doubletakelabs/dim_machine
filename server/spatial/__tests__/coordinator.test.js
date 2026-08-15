import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OccupancyCoordinator, nextStep } from '../coordinator.js';
import { ManualClock } from '../clock.js';

const OUT = { roomId: null, zoneId: null, occupancy: 'outside' };
const inRoom = (roomId, zoneId = null) => ({ roomId, zoneId, occupancy: 'inside' });

describe('nextStep', () => {
  it('steps outside → inside', () => {
    assert.deepEqual(nextStep(OUT, inRoom('library')), inRoom('library'));
  });

  it('steps inside → outside on exit', () => {
    assert.deepEqual(nextStep(inRoom('library'), OUT), {
      roomId: 'library', zoneId: null, occupancy: 'outside',
    });
  });

  it('leaves the current room before entering another', () => {
    assert.deepEqual(nextStep(inRoom('library'), inRoom('greenhouse')), {
      roomId: 'library', zoneId: null, occupancy: 'outside',
    });
  });

  it('returns null when already where we want to be', () => {
    assert.equal(nextStep(inRoom('library'), inRoom('library')), null);
    assert.equal(nextStep(OUT, OUT), null);
  });

  it('treats a zone change within one room as a step, not an exit', () => {
    const step = nextStep(inRoom('library', 'library-main'), inRoom('library', 'library-alcove'));
    assert.deepEqual(step, inRoom('library', 'library-alcove'));
  });
});

describe('OccupancyCoordinator', () => {
  const rooms = {
    library: {
      seen: { dwellMs: 5000 },
      location: { entryConfirmMs: 1500, exitConfirmMs: 800 },
      zones: { 'library-main': {}, 'library-alcove': {} },
    },
    greenhouse: {
      location: { entryConfirmMs: 1500, exitConfirmMs: 800 },
      zones: { greenhouse: {} },
    },
  };

  function makeCoordinator(roomDefs = rooms) {
    const clock = new ManualClock();
    const events = [];
    const coordinator = new OccupancyCoordinator({
      rooms: roomDefs,
      location: { contactLossMs: 5000 },
      clock,
      callbacks: { onOccupancyCommitted: (ev) => events.push(ev) },
    });
    return {
      coordinator,
      events,
      clock,
      advance(ms) {
        clock.advance(ms);
        coordinator.processTime(clock.now());
      },
    };
  }

  it('confirms entry before committing inside', () => {
    const { coordinator, events, advance } = makeCoordinator();
    coordinator.setDesired('g1', 'library', 'inside');
    assert.equal(events.length, 0);
    advance(1499);
    assert.equal(events.length, 0);
    advance(1);
    assert.equal(events.length, 1);
    assert.equal(events[0].occupancy, 'inside');
    assert.equal(events[0].roomId, 'library');
  });

  it('confirms exit on the separate exit hold', () => {
    const { coordinator, events, advance } = makeCoordinator();
    coordinator.ingestImmediate('g1', 'library', 'inside');
    events.length = 0;
    coordinator.setDesired('g1', null, 'outside');
    advance(799);
    assert.equal(events.length, 0);
    advance(1);
    assert.equal(events.at(-1).occupancy, 'outside');
    assert.equal(events.at(-1).roomId, null);
  });

  it('does not drop the room when someone steps to the doorway and back', () => {
    const { coordinator, events, advance } = makeCoordinator();
    coordinator.ingestImmediate('g1', 'library', 'inside');
    events.length = 0;
    coordinator.setDesired('g1', null, 'outside');
    advance(400);
    coordinator.setDesired('g1', 'library', 'inside');
    advance(400);
    assert.equal(events.length, 0);
    assert.equal(coordinator.getOccupancy('g1').occupancy, 'inside');
  });

  it('never records a guest in two rooms at once', () => {
    const { coordinator, advance } = makeCoordinator();
    coordinator.ingestImmediate('g1', 'library', 'inside');
    coordinator.setDesired('g1', 'greenhouse', 'inside');
    advance(800);
    assert.equal(coordinator.getRoomOccupants('library').length, 0);
    assert.equal(coordinator.getRoomOccupants('greenhouse').length, 0);
    advance(1500);
    assert.deepEqual(coordinator.getRoomOccupants('greenhouse').map((o) => o.guestId), ['g1']);
  });

  // -- multi-zone rooms ---------------------------------------------------

  it('moving between zones of one room is not an exit', () => {
    const { coordinator, events, advance } = makeCoordinator();
    coordinator.setDesired('g1', 'library', 'inside', 'virtual', 'library-main');
    advance(1500);
    events.length = 0;

    coordinator.setDesired('g1', 'library', 'inside', 'virtual', 'library-alcove');
    advance(0);

    // One event, still inside, still the same room — and no outside in between.
    assert.equal(events.length, 1);
    assert.equal(events[0].occupancy, 'inside');
    assert.equal(events[0].roomId, 'library');
    assert.equal(events[0].zoneId, 'library-alcove');
    assert.equal(events[0].previousRoomId, 'library');
    assert.ok(events.every((e) => e.occupancy !== 'outside'));
  });

  it('commits a zone change immediately, without an entry confirmation', () => {
    const { coordinator, advance } = makeCoordinator();
    coordinator.setDesired('g1', 'library', 'inside', 'virtual', 'library-main');
    advance(1500);
    coordinator.setDesired('g1', 'library', 'inside', 'virtual', 'library-alcove');
    assert.equal(coordinator.getOccupancy('g1').zoneId, 'library-alcove');
  });

  it('keeps arrival time across a zone change, so lock transfer order holds', () => {
    const { coordinator, clock, advance } = makeCoordinator();
    coordinator.setDesired('g1', 'library', 'inside', 'virtual', 'library-main');
    advance(1500);
    const arrived = coordinator.getRoomOccupants('library')[0].sinceTs;
    clock.advance(5000);
    coordinator.setDesired('g1', 'library', 'inside', 'virtual', 'library-alcove');
    assert.equal(coordinator.getRoomOccupants('library')[0].sinceTs, arrived);
  });

  it('dwell accumulates across zones of the same room', () => {
    const seen = [];
    const clock = new ManualClock();
    const coordinator = new OccupancyCoordinator({
      rooms: { library: { seen: { dwellMs: 1000 }, zones: { a: {}, b: {} } } },
      clock,
      callbacks: { onRoomSeen: (p) => seen.push(p) },
    });
    coordinator.ingestImmediate('g1', 'library', 'inside', 'virtual', 'a');
    clock.advance(600);
    coordinator.processTime(clock.now());
    coordinator.ingestImmediate('g1', 'library', 'inside', 'virtual', 'b');
    clock.advance(500);
    coordinator.processTime(clock.now());
    assert.equal(seen.length, 1);
    assert.equal(seen[0].roomId, 'library');
  });

  // -- contact loss -------------------------------------------------------

  it('beacon silence drops a streaming guest to outside after the hold', () => {
    const { coordinator, events, advance } = makeCoordinator();
    coordinator.setDesired('g1', 'library', 'inside', 'ble');
    advance(1500);
    events.length = 0;
    advance(5001);
    advance(800);
    assert.ok(events.some((e) => e.occupancy === 'outside'));
    assert.equal(coordinator.getOccupancy('g1').roomId, null);
  });

  it('a connected virtual placement persists — there is no stream to lose', () => {
    const { coordinator, events, advance } = makeCoordinator();
    coordinator.ingestImmediate('g1', 'library', 'inside', 'virtual');
    events.length = 0;
    advance(20000);
    assert.equal(events.length, 0);
    assert.equal(coordinator.getOccupancy('g1').occupancy, 'inside');
  });

  it('a dropped socket applies to every source, including virtual', () => {
    const { coordinator, advance } = makeCoordinator();
    coordinator.ingestImmediate('g1', 'library', 'inside', 'virtual');
    coordinator.setConnected('g1', false);
    advance(5001);
    advance(800);
    assert.equal(coordinator.getOccupancy('g1').roomId, null);
  });

  it('reconnecting inside the window keeps the guest in the room', () => {
    const { coordinator, advance } = makeCoordinator();
    coordinator.ingestImmediate('g1', 'library', 'inside', 'virtual');
    coordinator.setConnected('g1', false);
    advance(3000);
    coordinator.setConnected('g1', true);
    advance(3000);
    assert.equal(coordinator.getOccupancy('g1').roomId, 'library');
  });

  // -- dwell and locks ----------------------------------------------------

  it('resets dwell when accumulate is false', () => {
    const seen = [];
    const clock = new ManualClock();
    const coordinator = new OccupancyCoordinator({
      rooms: { library: { seen: { dwellMs: 1000, accumulate: false }, zones: { a: {} } } },
      clock,
      callbacks: { onRoomSeen: (p) => seen.push(p) },
    });
    coordinator.ingestImmediate('g1', 'library', 'inside');
    clock.advance(600);
    coordinator.processTime(clock.now());
    coordinator.ingestImmediate('g1', null, 'outside');
    clock.advance(10);
    coordinator.ingestImmediate('g1', 'library', 'inside');
    clock.advance(600);
    coordinator.processTime(clock.now());
    assert.equal(seen.length, 0);
    clock.advance(400);
    coordinator.processTime(clock.now());
    assert.equal(seen.length, 1);
  });

  it('emits room.seen after the dwell threshold', () => {
    const seen = [];
    const clock = new ManualClock();
    const coordinator = new OccupancyCoordinator({
      rooms: { library: { seen: { dwellMs: 1000 }, zones: { a: {} } } },
      clock,
      callbacks: { onRoomSeen: (p) => seen.push(p) },
    });
    coordinator.ingestImmediate('g1', 'library', 'inside');
    clock.advance(1001);
    coordinator.processTime(clock.now());
    assert.equal(seen.length, 1);
    assert.equal(seen[0].roomId, 'library');
  });

  it('acquireLock refuses a second holder', () => {
    const { coordinator } = makeCoordinator();
    assert.equal(coordinator.acquireLock('library', 'g1').ok, true);
    assert.equal(coordinator.acquireLock('library', 'g2').ok, false);
    assert.equal(coordinator.acquireLock('library', 'g2').reason, 'locked');
    assert.equal(coordinator.getLock('library').guestId, 'g1');
    coordinator.releaseLock('library', 'g1');
    assert.equal(coordinator.acquireLock('library', 'g2').ok, true);
  });

  it('removeGuest leaves the lock alone for the room actor to resolve', () => {
    const { coordinator } = makeCoordinator();
    coordinator.ingestImmediate('g1', 'library', 'inside');
    coordinator.acquireLock('library', 'g1');
    coordinator.removeGuest('g1');
    // Dropping it here would strand the room active with no holder.
    assert.equal(coordinator.getLock('library').guestId, 'g1');
    assert.equal(coordinator.getRoomOccupants('library').length, 0);
  });
});
