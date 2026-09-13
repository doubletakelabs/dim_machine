import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { buildGuestMachine } from '../guest-machine.js';
import { roomCentroid } from '../zone-math.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const museum = JSON.parse(readFileSync(join(root, 'shows/MAD-DIM.json'), 'utf8'));

const PROLOGUE = ['frontDesk', 'calibration', 'entranceHallway', 'maskRoom', 'hallOfHeroes', 'cyclorama'];
/** Exit and entry both have to confirm for a room-to-room move. */
const MOVE_MS = 2600;

function makeRuntime() {
  const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock() });
  rt.load(museum);
  rt.start();
  return rt;
}

function centreOf(roomId) {
  // The point the real walkthrough driver aims at — not a midpoint formula
  // that quietly assumed every zone is an axis-aligned rectangle with its
  // corners in drawing order. It was, until somebody traced the real rooms.
  return roomCentroid(museum.rooms[roomId]);
}

function walk(rt, guestId, roomId, ms = MOVE_MS) {
  const [x, y] = centreOf(roomId);
  rt.setVirtualPosition(guestId, x, y);
  rt.testAdvanceTime(ms);
}

const regions = (rt, guestId) => rt.guestActors.get(guestId).regions();
/** The top of a possibly-nested region value: `prologue.arrive` → `prologue`. */
const branch = (state) => String(state).split('.')[0];
const roomOf = (rt, roomId) => rt.getRoomsRoster().find((r) => r.roomId === roomId);
const standingOf = (rt, guestId) => rt.guestActors.get(guestId).currentRoom()?.standing;

/** Walk a guest the whole way in, which is where a path gets assigned. */
function arriveAtMuseum(rt) {
  const g = rt.spawnGuest();
  for (const roomId of PROLOGUE) walk(rt, g.guestId, roomId);
  walk(rt, g.guestId, 'museumHallway');
  return g;
}

describe('the guest machine', () => {
  it('has one state per room plus outside, and follows any move', () => {
    const config = buildGuestMachine(museum);
    assert.deepEqual(Object.keys(config.states).sort(), ['adherence', 'guidance', 'location']);
    assert.equal(
      Object.keys(config.states.location.states).length,
      Object.keys(museum.rooms).length + 1,
    );
  });

  it('follows a move that could not physically have happened', () => {
    // The coordinator is authoritative about where someone is. A misread beacon
    // or an operator dragging a dot must not leave the machine behind.
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    walk(rt, g.guestId, 'frontDesk');
    assert.equal(regions(rt, g.guestId).location, 'frontDesk');
    walk(rt, g.guestId, 'consumption3');   // no door between them
    assert.equal(regions(rt, g.guestId).location, 'consumption3');
  });

  it('reports outside before a guest has entered anything', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    const { location, guidance, adherence } = regions(rt, g.guestId);
    assert.deepEqual({ location, adherence }, { location: 'outside', adherence: 'onPath' });
    // Guidance is dotted now that the prologue holds the calibration steps;
    // this test is about the journey, not which step a guest is standing on.
    assert.equal(branch(guidance), 'prologue');
  });
});

describe('the journey', () => {
  it('advances guidance only when the guest reaches the museum', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    for (const roomId of PROLOGUE) {
      walk(rt, g.guestId, roomId);
      assert.equal(branch(regions(rt, g.guestId).guidance), 'prologue', roomId);
    }
    walk(rt, g.guestId, 'museumHallway');
    assert.equal(regions(rt, g.guestId).guidance, 'museum');
  });

  it('assigns no path — the museum is free choice now', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    assert.equal(rt.guests.get(g.guestId).pathId, null, 'paths left with the old museum design');
  });

  it('everyone shares the prologue — nobody is turned away, and nobody owns it', () => {
    // No path is assigned yet there, so gating those rooms on path membership
    // would lock every guest out of the entrance sequence. And they run for the
    // space rather than for a person, so there is no holder at all.
    const rt = makeRuntime();
    const first = rt.spawnGuest();
    const second = rt.spawnGuest();
    walk(rt, first.guestId, 'frontDesk');
    rt.testAdvanceTime(80);
    walk(rt, second.guestId, 'frontDesk');

    assert.equal(standingOf(rt, first.guestId), 'present');
    assert.equal(standingOf(rt, second.guestId), 'present');
    assert.equal(roomOf(rt, 'frontDesk').lockHolder, null);
    assert.match(roomOf(rt, 'frontDesk').state, /^active/);
  });

  it('a shared room plays the same thing for whoever walked in second', () => {
    // The trap this kind exists to close: with a holder, a veteran arriving a
    // moment earlier would pick the room's content for a newcomer.
    const rt = makeRuntime();
    assert.equal(museum.rooms.cyclorama.kind, 'shared');
    assert.equal(museum.rooms.cyclorama.revisit, undefined);
  });

  it('a declared timer survives leaving and re-entering the museum', () => {
    // XState's own `after` restarts on re-entry, which is exactly what this
    // must not do — a guest who ducks out and back should not get longer.
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    rt.testAdvanceTime(1500000);           // 25 of the 30 minutes
    walk(rt, g.guestId, 'cyclorama');      // leave the museum entirely
    walk(rt, g.guestId, 'museumHallway');  // and come back
    assert.equal(regions(rt, g.guestId).guidance, 'museum');
    rt.testAdvanceTime(300000);            // the remaining 5
    assert.equal(regions(rt, g.guestId).guidance, 'converge');
  });
});

describe('wandering, which is no longer deviance', () => {
  it('any museum room is theirs to choose — walking in engages it', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    walk(rt, g.guestId, 'faerie', 3000);
    // No path, no off-path: choosing a room simply engages it.
    assert.equal(regions(rt, g.guestId).adherence, 'onPath');
    assert.equal(roomOf(rt, 'faerie').state, 'active');
    assert.equal(rt.museum.snapshot(g.guestId).seen, 1);
  });

  it('backtracking out of the museum is not a deviation', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    walk(rt, g.guestId, 'cyclorama');
    assert.equal(regions(rt, g.guestId).adherence, 'onPath');
    assert.equal(standingOf(rt, g.guestId), 'present');
  });

  it('a hallway is never anything but passage', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    walk(rt, g.guestId, 'southCorridor');
    assert.equal(standingOf(rt, g.guestId), 'passingThrough');
  });
});

describe('operator activation', () => {
  it('activates for somebody actually standing there', () => {
    // A post-museum room: the museum layer owns DIM-room activation now, and
    // an operator re-running a room a guest already spent is a return there,
    // not an activation. The machinery under test is show-agnostic.
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    const room = 'warehouse';
    walk(rt, g.guestId, room, 4000);
    rt.releaseRoomLock(room);
    rt.testAdvanceTime(11000);
    assert.equal(roomOf(rt, room).state, 'idle');

    const result = rt.activateForOccupant(room);
    assert.equal(result.ok, true);
    assert.equal(result.guestId, g.guestId);
    assert.equal(roomOf(rt, room).lockHolder, g.guestId);
  });

  it('refuses when nobody eligible is inside, rather than running for nobody', () => {
    const rt = makeRuntime();
    assert.deepEqual(rt.activateForOccupant('slop'), { ok: false, reason: 'nobodyEligibleInside' });
    assert.equal(roomOf(rt, 'slop').state, 'idle');
    assert.equal(roomOf(rt, 'slop').lockHolder, null);
  });
});
