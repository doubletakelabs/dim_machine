import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OccupancyCoordinator } from '../coordinator.js';
import { RoomActor, rootState } from '../room-actor.js';
import { ManualClock } from '../clock.js';

const roomDef = {
  name: 'Library',
  machine: {
    id: 'library',
    initial: 'idle',
    states: {
      idle: { on: { ACTIVATE: 'activating' } },
      activating: {
        on: { READY: 'active', RELEASE: 'settling' },
        after: { 1200: { target: 'active' } },
      },
      active: { on: { RELEASE: 'settling' } },
      settling: { on: { RESET: 'idle' } },
    },
  },
};

describe('RoomActor', () => {
  function make(def = roomDef) {
    const clock = new ManualClock();
    const coordinator = new OccupancyCoordinator({ clock });
    const outputs = [];
    const events = [];
    const room = new RoomActor({
      roomId: 'library',
      def,
      coordinator,
      clock,
      emitOutput: (intent) => outputs.push(intent),
      appendEvent: (event) => events.push(event),
    });
    room.start();
    return { coordinator, room, outputs, events, clock };
  }

  it('activates into activating and holds there until the authored delay', () => {
    const { room, clock } = make();
    assert.equal(room.state, 'idle');
    assert.equal(room.requestActivation('u1').ok, true);
    assert.equal(rootState(room.state), 'activating');
    clock.advance(1200);
    assert.equal(rootState(room.state), 'active');
  });

  it('runs authored `after` timers on the show clock', () => {
    const { room, clock } = make();
    room.requestActivation('u1');
    clock.advance(1199);
    assert.equal(rootState(room.state), 'activating');
    clock.advance(1);
    assert.equal(rootState(room.state), 'active');
  });

  it('refuses activation when locked', () => {
    const { room } = make();
    assert.equal(room.requestActivation('u1').ok, true);
    const second = room.requestActivation('u2');
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'locked');
  });

  it('does not strand a lock when the machine declines ACTIVATE', () => {
    const { room, coordinator } = make({
      ...roomDef,
      machine: {
        ...roomDef.machine,
        states: { ...roomDef.machine.states, idle: {} },
      },
    });
    const result = room.requestActivation('u1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'rejected');
    assert.equal(coordinator.getLock('library'), null);
    // The room must stay activatable rather than being locked out for the show.
    assert.equal(room.presentationRoot(), 'idle');
  });

  it('carries the activating guest history on ACTIVATE', () => {
    const { room } = make();
    const sent = [];
    const send = room.actor.send.bind(room.actor);
    room.actor.send = (event) => { sent.push(event); return send(event); };

    room.requestActivation('u1', { seen: true, completed: false, activatedByMe: true });

    const activate = sent.find((e) => e.type === 'ACTIVATE');
    assert.deepEqual(activate, {
      type: 'ACTIVATE',
      guestId: 'u1',
      seen: true,
      completed: false,
      activatedByMe: true,
      offPath: false,
    });
  });

  it('reports a revisit on the activation event', () => {
    const { room, events } = make();
    room.requestActivation('u1', { seen: true });
    const activated = events.find((e) => e.type === 'room.activated');
    assert.equal(activated.revisit, true);
  });

  it('defaults history flags to false for a first visit', () => {
    const { room, events } = make();
    room.requestActivation('u1');
    assert.equal(events.find((e) => e.type === 'room.activated').revisit, false);
  });

  it('releasing during an intro state leaves it too, not just `active`', () => {
    // A room may declare states beyond the canonical three. Every one of them
    // is the room running for somebody, so none may outlive the lock.
    const { room, coordinator } = make();
    room.requestActivation('u1');
    assert.equal(rootState(room.state), 'activating');
    assert.equal(room.release('u1').ok, true);
    assert.equal(coordinator.getLock('library'), null);
    assert.equal(rootState(room.state), 'settling');
  });

  it('release with no occupants drops the lock and leaves the active state', () => {
    const { room, coordinator, clock } = make();
    room.requestActivation('u1');
    clock.advance(1200);
    assert.equal(rootState(room.state), 'active');
    assert.equal(room.release('u1').ok, true);
    assert.equal(coordinator.getLock('library'), null);
    assert.equal(rootState(room.state), 'settling');
  });

  it('release transfers the lock to the longest-present remaining occupant', () => {
    const { room, coordinator, clock } = make();
    coordinator.ingestImmediate('u1', 'library', 'inside');
    clock.advance(10);
    coordinator.ingestImmediate('u2', 'library', 'inside');
    clock.advance(10);
    coordinator.ingestImmediate('u3', 'library', 'inside');
    room.requestActivation('u1');
    clock.advance(1200);

    const result = room.release('u1');
    assert.equal(result.transferredTo, 'u2');
    assert.equal(coordinator.getLock('library').guestId, 'u2');
    // The room must not reset under the people still standing in it.
    assert.equal(rootState(room.state), 'active');
  });

  it('refuses release from a non-holder', () => {
    const { room, coordinator } = make();
    room.requestActivation('u1');
    const result = room.release('u2');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'notHolder');
    assert.equal(coordinator.getLock('library').guestId, 'u1');
  });

  // -- A4: exit and reset -------------------------------------------------

  /** Room whose content ends on its own after 5s, for `finish`. */
  const timedRoomDef = {
    ...roomDef,
    machine: {
      ...roomDef.machine,
      states: {
        ...roomDef.machine.states,
        active: {
          on: { RELEASE: 'settling' },
          after: { 5000: { target: 'settling' } },
        },
      },
    },
  };

  function occupy(coordinator, room, guestId) {
    const previousRoomId = coordinator.getOccupancy(guestId).roomId;
    coordinator.ingestImmediate(guestId, 'library', 'inside');
    room.handleSpatialEvent({
      guestId, roomId: 'library', zoneId: 'library-main', occupancy: 'inside',
      previousRoomId, previousOccupancy: previousRoomId ? 'inside' : 'outside',
    });
  }

  function depart(coordinator, room, guestId) {
    coordinator.ingestImmediate(guestId, null, 'outside');
    room.handleSpatialEvent({
      guestId, roomId: null, zoneId: null, occupancy: 'outside',
      previousRoomId: 'library', previousOccupancy: 'inside',
    });
  }

  /** A guest crossing between two zones of the same room. */
  function moveZone(coordinator, room, guestId, zoneId) {
    coordinator.ingestImmediate(guestId, 'library', 'inside', 'virtual', zoneId);
    room.handleSpatialEvent({
      guestId, roomId: 'library', zoneId, occupancy: 'inside',
      previousRoomId: 'library', previousOccupancy: 'inside',
    });
  }

  it('emptying a room starts the exit grace, and reset fires when it expires', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'resetAfter', graceMs: 10000 } });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    assert.equal(rootState(room.state), 'active');

    depart(coordinator, room, 'u1');
    assert.equal(rootState(room.state), 'settling');
    assert.equal(coordinator.getLock('library'), null);

    clock.advance(9999);
    assert.equal(rootState(room.state), 'settling');
    clock.advance(1);
    assert.equal(rootState(room.state), 'idle');
  });

  it('returning within the grace window resumes instead of resetting', () => {
    const { room, coordinator, clock, events } = make({
      ...roomDef,
      exit: { policy: 'resetAfter', graceMs: 10000, resumeIfReturned: true },
      machine: {
        ...roomDef.machine,
        states: {
          ...roomDef.machine.states,
          settling: { on: { RESET: 'idle', RESUME: 'active' } },
        },
      },
    });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    depart(coordinator, room, 'u1');
    assert.equal(rootState(room.state), 'settling');

    clock.advance(4000);
    occupy(coordinator, room, 'u1');
    assert.equal(rootState(room.state), 'active');
    assert.equal(coordinator.getLock('library').guestId, 'u1');

    // The cancelled timer must not fire later and reset an occupied room.
    clock.advance(20000);
    assert.equal(rootState(room.state), 'active');
    assert.ok(events.some((e) => e.type === 'room.resumed'));
  });

  it('does not resume when the room has not opted in', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'resetAfter', graceMs: 10000 } });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    depart(coordinator, room, 'u1');
    clock.advance(1000);
    occupy(coordinator, room, 'u1');
    assert.equal(rootState(room.state), 'settling');
    clock.advance(9000);
    assert.equal(rootState(room.state), 'idle');
  });

  it('resetImmediate skips the grace window', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'resetImmediate' } });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    depart(coordinator, room, 'u1');
    clock.advance(1);
    assert.equal(rootState(room.state), 'idle');
  });

  it('hold freezes the room and keeps the lock for the absent holder', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'hold' } });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    depart(coordinator, room, 'u1');

    clock.advance(60000);
    assert.equal(rootState(room.state), 'active');
    // Retained deliberately: nobody else may take a room frozen mid-content.
    assert.equal(coordinator.getLock('library').guestId, 'u1');
  });

  it('finish plays the content out in an empty room, then resets', () => {
    const { room, coordinator, clock } = make({
      ...timedRoomDef,
      exit: { policy: 'finish', graceMs: 2000 },
    });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    assert.equal(rootState(room.state), 'active');

    depart(coordinator, room, 'u1');
    // Still running — the room is empty but its content has not finished.
    assert.equal(rootState(room.state), 'active');
    assert.equal(coordinator.getLock('library'), null);

    clock.advance(5000);
    assert.equal(rootState(room.state), 'settling');
    clock.advance(2000);
    assert.equal(rootState(room.state), 'idle');
  });

  it('one of two occupants leaving transfers the lock and holds the room', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'resetAfter', graceMs: 5000 } });
    occupy(coordinator, room, 'u1');
    clock.advance(10);
    occupy(coordinator, room, 'u2');
    room.requestActivation('u1');
    clock.advance(1200);

    depart(coordinator, room, 'u1');
    assert.equal(rootState(room.state), 'active');
    assert.equal(coordinator.getLock('library').guestId, 'u2');

    clock.advance(30000);
    assert.equal(rootState(room.state), 'active');
  });

  it('a non-holder leaving a still-occupied room changes nothing', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'resetAfter', graceMs: 5000 } });
    occupy(coordinator, room, 'u1');
    clock.advance(10);
    occupy(coordinator, room, 'u2');
    room.requestActivation('u1');
    clock.advance(1200);

    depart(coordinator, room, 'u2');
    assert.equal(rootState(room.state), 'active');
    assert.equal(coordinator.getLock('library').guestId, 'u1');
  });

  it('an authored DONE into settling also runs the grace timer', () => {
    const { room, coordinator, clock } = make({
      ...timedRoomDef,
      exit: { policy: 'resetAfter', graceMs: 3000 },
    });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    // Content ends while someone is still inside.
    clock.advance(5000);
    assert.equal(rootState(room.state), 'settling');
    clock.advance(3000);
    assert.equal(rootState(room.state), 'idle');
  });

  it('crossing between zones of one room does not touch the room', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'resetAfter', graceMs: 10000 } });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    assert.equal(rootState(room.state), 'active');

    moveZone(coordinator, room, 'u1', 'library-alcove');

    // No departure, no grace timer, lock untouched.
    assert.equal(rootState(room.state), 'active');
    assert.equal(coordinator.getLock('library').guestId, 'u1');
    assert.equal(room.snapshot().resetInMs, null);
    clock.advance(30000);
    assert.equal(rootState(room.state), 'active');
  });

  it('releases the lock when content ends with someone still inside', () => {
    // A room whose own `after` runs it to settling was never departed from, so
    // nothing would otherwise release the lock — leaving it idle but
    // unactivatable by anyone except the stale holder.
    const { room, coordinator, clock } = make({
      ...timedRoomDef,
      exit: { policy: 'resetAfter', graceMs: 2000 },
    });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    assert.equal(coordinator.getLock('library').guestId, 'u1');

    clock.advance(5000);                       // content ends; u1 never left
    assert.equal(rootState(room.state), 'settling');
    assert.equal(coordinator.getLock('library'), null);

    clock.advance(2000);
    assert.equal(rootState(room.state), 'idle');
    // And it is genuinely available again, to somebody else.
    assert.equal(room.requestActivation('u2').ok, true);
  });

  it('hold keeps its lock — leaving active is what drops it, not emptying', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'hold' } });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    depart(coordinator, room, 'u1');
    clock.advance(60000);
    assert.equal(rootState(room.state), 'active');
    assert.equal(coordinator.getLock('library').guestId, 'u1');
  });

  it('exposes the ticking grace window on the snapshot', () => {
    const { room, coordinator, clock } = make({ ...roomDef, exit: { policy: 'resetAfter', graceMs: 10000 } });
    occupy(coordinator, room, 'u1');
    room.requestActivation('u1');
    clock.advance(1200);
    assert.equal(room.snapshot().resetInMs, null);

    depart(coordinator, room, 'u1');
    assert.equal(room.snapshot().resetInMs, 10000);
    clock.advance(4000);
    assert.equal(room.snapshot().resetInMs, 6000);
  });

  it('emits stub roomOutput and log events on state change', () => {
    const { room, outputs, events, clock } = make();
    room.requestActivation('u1');
    clock.advance(1200);
    assert.ok(outputs.some((o) => o.roomId === 'library' && String(o.state).startsWith('active')));
    assert.ok(events.some((e) => e.type === 'room.activated' && e.guestId === 'u1'));
    assert.ok(events.some((e) => e.type === 'room.state'));
  });
});
