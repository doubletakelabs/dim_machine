import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { buildGuestMachine } from '../guest-machine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const museum = JSON.parse(readFileSync(join(root, 'shows/the-museum.json'), 'utf8'));

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
  const zone = Object.values(museum.rooms[roomId].zones)[0].polygon;
  return [(zone[0][0] + zone[1][0]) / 2, (zone[0][1] + zone[2][1]) / 2];
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

  it('assigns a path on arrival, not at the door', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    assert.equal(rt.guests.get(g.guestId).pathId, null);
    for (const roomId of PROLOGUE) walk(rt, g.guestId, roomId);
    assert.equal(rt.guests.get(g.guestId).pathId, null, 'still nothing through the prologue');
    walk(rt, g.guestId, 'museumHallway');
    assert.ok(museum.paths[rt.guests.get(g.guestId).pathId]);
  });

  it('does not redraw a path somebody chose', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    assert.equal(rt.setGuestPath(g.guestId, 'pathC'), true);
    for (const roomId of PROLOGUE) walk(rt, g.guestId, roomId);
    walk(rt, g.guestId, 'museumHallway');
    // Reaching the museum is what assigns a path. An operator's choice made
    // before that must survive it, or the panel looks like it ignored the click.
    assert.equal(rt.guests.get(g.guestId).pathId, 'pathC');

    // And handing them back to the show lets it draw again.
    rt.setGuestPath(g.guestId, null);
    assert.equal(rt.guests.get(g.guestId).pathPinned, false);
  });

  it('refuses a path the show does not have', () => {
    const rt = makeRuntime();
    const g = rt.spawnGuest();
    assert.equal(rt.setGuestPath(g.guestId, 'pathZ'), false);
    assert.equal(rt.guests.get(g.guestId).pathId, null);
  });

  it('rotates paths between guests', () => {
    const rt = makeRuntime();
    const assigned = [arriveAtMuseum(rt), arriveAtMuseum(rt)].map((g) => rt.guests.get(g.guestId).pathId);
    assert.notEqual(assigned[0], assigned[1]);
  });

  it('guides toward the first unvisited room on the assigned path', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    const actor = rt.guestActors.get(g.guestId);
    const path = museum.paths[rt.guests.get(g.guestId).pathId].rooms;
    assert.equal(actor.guidanceTarget(), path[0]);
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

describe('going off-path', () => {
  /** A room that no path of theirs routes through. */
  function otherPathRoom(rt, guestId) {
    const mine = museum.paths[rt.guests.get(guestId).pathId].rooms;
    return Object.entries(museum.paths)
      .flatMap(([, p]) => p.rooms)
      .find((roomId) => !mine.includes(roomId));
  }

  it('flips when a guest goes to a museum room that is not theirs', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    const stray = otherPathRoom(rt, g.guestId);
    assert.equal(regions(rt, g.guestId).adherence, 'onPath');
    walk(rt, g.guestId, stray);
    assert.equal(regions(rt, g.guestId).adherence, 'offPath');
    const event = rt.eventLog.filter((e) => e.type === 'guest.wentOffPath').at(-1);
    assert.equal(event.roomId, stray);
    assert.ok(event.target, 'records what guidance was asking for');
  });

  it('stays off once off — the tour does not get back on the rails', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    walk(rt, g.guestId, otherPathRoom(rt, g.guestId));
    walk(rt, g.guestId, 'museumHallway');
    walk(rt, g.guestId, museum.paths[rt.guests.get(g.guestId).pathId].rooms[0]);
    assert.equal(regions(rt, g.guestId).adherence, 'offPath');
  });

  it('backtracking out of the museum is not a deviation', () => {
    // No path routes through the Cyclorama, so there is nothing there to
    // deviate from.
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    walk(rt, g.guestId, 'cyclorama');
    assert.equal(regions(rt, g.guestId).adherence, 'onPath');
    // And they were never turned away from it — the Cyclorama is shared.
    assert.equal(standingOf(rt, g.guestId), 'present');
  });

  it('a hallway is never a deviation', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    walk(rt, g.guestId, 'southCorridor');
    assert.equal(regions(rt, g.guestId).adherence, 'onPath');
    assert.equal(standingOf(rt, g.guestId), 'passingThrough');
  });
});

describe('rooms reacting to a guest they were not sent', () => {
  function strayInto(rt, kind) {
    for (let i = 0; i < 6; i++) {
      const g = arriveAtMuseum(rt);
      const mine = museum.paths[rt.guests.get(g.guestId).pathId].rooms;
      const target = Object.entries(museum.rooms).find(([id, r]) =>
        !mine.includes(id)
        && (r.ineligible?.policy ?? 'ignore') === kind
        && Object.values(museum.paths).some((p) => p.rooms.includes(id)));
      if (target) { walk(rt, g.guestId, target[0]); return { g, roomId: target[0] }; }
      rt.removeGuest(g.guestId);
    }
    throw new Error(`no ${kind} room off-path for any guest`);
  }

  it('most rooms stay dark, and are untouched by the visit', () => {
    const rt = makeRuntime();
    const { g, roomId } = strayInto(rt, 'ignore');
    const room = roomOf(rt, roomId);
    assert.equal(room.state, 'idle');
    assert.equal(room.lockHolder, null);
    assert.equal(room.lastRefuse, null, 'it never even heard a request');
    assert.equal(standingOf(rt, g.guestId), 'notTheirs');
  });

  it('a room declaring activateVariant runs its variant, and they hold it', () => {
    const rt = makeRuntime();
    const { g, roomId } = strayInto(rt, 'activateVariant');
    const room = roomOf(rt, roomId);
    assert.equal(room.state, 'active.offPath');
    assert.equal(room.lockHolder, g.guestId);
    assert.equal(standingOf(rt, g.guestId), 'holder');
    assert.equal(rt.eventLog.filter((e) => e.type === 'room.activated').at(-1).offPath, true);
  });
});

describe('operator activation', () => {
  it('activates for somebody actually standing there', () => {
    const rt = makeRuntime();
    const g = arriveAtMuseum(rt);
    const room = museum.paths[rt.guests.get(g.guestId).pathId].rooms[0];
    walk(rt, g.guestId, room);
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
