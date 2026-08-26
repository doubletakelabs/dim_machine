/**
 * Room experiences — the show's end of a link to a piece running its own server
 * in a room.
 *
 * The socket is faked rather than opened. What matters here is the protocol and
 * what survives a room server that is missing, late, or restarted mid-show —
 * none of which needs a real network to provoke, and all of which is hard to
 * provoke deliberately with one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const museum = JSON.parse(readFileSync(join(root, 'shows/the-museum.json'), 'utf8'));

/** A room server that never was. Records what the show said to it. */
function fakeRoomServer() {
  const sockets = [];
  const open = (url) => {
    const handlers = {};
    const socket = {
      url,
      sent: [],
      closed: false,
      on: (event, fn) => { handlers[event] = fn; },
      send: (raw) => socket.sent.push(JSON.parse(raw)),
      close: () => { socket.closed = true; handlers.close?.(); },
      /** Let the show believe the connection came up. */
      accept: () => handlers.open?.(),
      reply: (message) => handlers.message?.(JSON.stringify(message)),
      drop: () => { socket.closed = true; handlers.close?.(); },
      of: (t) => socket.sent.filter((m) => m.t === t),
      last: (t) => [...socket.sent].reverse().find((m) => m.t === t) ?? null,
    };
    sockets.push(socket);
    return socket;
  };
  return { open, sockets, latest: () => sockets[sockets.length - 1] };
}

function makeRuntime({ connect = true } = {}) {
  const server = fakeRoomServer();
  const cues = [];
  const rt = new SpatialRuntime({
    enableTick: false,
    clock: new ManualClock(),
    openExperienceSocket: server.open,
    onCue: (guestId, cue) => cues.push({ guestId, ...cue }),
  });
  assert.deepEqual(rt.load(structuredClone(museum)).errors, []);
  rt.start();
  if (connect) server.latest()?.accept();
  return { rt, server, cues, link: rt.experiences.get('influence') };
}

function centreOf(roomId) {
  const points = Object.values(museum.rooms[roomId].zones)[0].polygon;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** Put a guest in the Influence room, on the path that makes it theirs. */
function driverIn(rt, roomId = 'influence') {
  for (let i = 0; i < 12; i++) {
    const g = rt.spawnGuest({ kind: 'phone' });
    // Reaching the museum hallway is what assigns a path.
    const [hx, hy] = centreOf('museumHallway');
    rt.setVirtualPosition(g.guestId, hx, hy);
    rt.testAdvanceTime(2600);
    if (!museum.paths[rt.guests.get(g.guestId).pathId]?.rooms?.includes(roomId)) {
      rt.removeGuest(g.guestId);
      continue;
    }
    const [x, y] = centreOf(roomId);
    rt.setVirtualPosition(g.guestId, x, y);
    rt.testAdvanceTime(3000);
    return g;
  }
  assert.fail(`no path routes through ${roomId}`);
}

describe('the link to a room experience', () => {
  it('introduces itself and states the whole world at once', () => {
    const { server } = makeRuntime();
    const socket = server.latest();
    const hello = socket.last('hello');
    assert.equal(hello.role, 'broker');
    assert.equal(hello.experienceId, 'influence-clickfarm');
    assert.equal(hello.roomId, 'influence');
    // Not "nothing has happened yet" — the state of the room, whether or not
    // anything has changed since the piece was switched on.
    assert.equal(socket.last('lifecycle').state, 'attract');
    assert.deepEqual(socket.last('drivers').drivers, []);
  });

  it('says nothing when nothing differs', () => {
    const { rt, server } = makeRuntime();
    const before = server.latest().sent.length;
    for (let i = 0; i < 5; i++) rt.notifyChange();
    assert.equal(server.latest().sent.length, before, 'a quiet show is a quiet link');
  });

  it('goes live with a driver when somebody is actually driving', () => {
    const { rt, server } = makeRuntime();
    const g = driverIn(rt);

    const socket = server.latest();
    assert.equal(socket.last('lifecycle').state, 'live');
    const drivers = socket.last('drivers').drivers;
    assert.equal(drivers.length, 1);
    assert.match(drivers[0].driverId, /^d-/);
    assert.equal(typeof drivers[0].hue, 'number');
    assert.ok(drivers[0].secret, 'the room server is told what to accept');
    assert.equal(drivers[0].guestId, undefined, 'and nothing about who the person is');

    rt.removeGuest(g.guestId);
    // Not straight to attract — the room holds its exit grace, and the piece is
    // told so. That distinction is why `settling` is in the vocabulary: a wall
    // that snaps to its attract loop the instant somebody steps out reads as
    // the show forgetting them.
    assert.equal(socket.last('lifecycle').state, 'settling');
    assert.deepEqual(socket.last('drivers').drivers, []);

    rt.testAdvanceTime(30_000);
    assert.equal(socket.last('lifecycle').state, 'attract');
  });

  it('keeps a driver their colour while others come and go', () => {
    const { rt, server } = makeRuntime();
    driverIn(rt);
    const first = server.latest().last('drivers').drivers[0];

    driverIn(rt);
    const drivers = server.latest().last('drivers').drivers;
    assert.equal(drivers.length, 2);
    // A hue that shuffled when somebody else walked in would read from the
    // floor as the piece glitching.
    assert.deepEqual(drivers.find((d) => d.driverId === first.driverId), first);
    assert.notEqual(drivers[0].hue, drivers[1].hue);
  });

  it('states everything again to a room server that restarted', () => {
    const { rt, server } = makeRuntime();
    driverIn(rt);
    const before = server.latest().last('drivers').drivers;

    server.latest().drop();
    rt.testAdvanceTime(2000);           // reconnect backoff
    const fresh = server.latest();
    assert.notEqual(fresh, undefined);
    fresh.accept();

    // A piece somebody power-cycled mid-show is correct on its first message.
    assert.equal(fresh.last('lifecycle').state, 'live');
    assert.deepEqual(fresh.last('drivers').drivers, before);
  });

  it('lets the show run when the room server is not there at all', () => {
    const { rt, link } = makeRuntime({ connect: false });
    link.socket.drop();
    assert.equal(link.state, 'unreachable');

    // The room still admits people, still activates, still plays its audio. A
    // dark wall is bad; a room that turns guests away because a projector
    // machine is unplugged takes the evening with it.
    const g = driverIn(rt);
    assert.equal(rt.guests.get(g.guestId).roomId, 'influence');
    assert.equal(rt.experienceLifecycle('influence'), 'live');
    // Still trying, and never ready — it reconnects on a backoff for as long as
    // the show runs, because somebody may well plug the machine back in.
    assert.notEqual(link.state, 'ready');
    assert.ok(link._attempt > 0, 'and keeps reaching for it');
  });

  it('fires reset once, when the room actually comes back to rest', () => {
    const { rt, server } = makeRuntime();
    const g = driverIn(rt);
    const socket = server.latest();
    assert.equal(socket.of('reset').length, 0, 'not while somebody is in there');

    rt.sendGuestToRoom(g.guestId, 'museumHallway');
    rt.testAdvanceTime(3000);
    assert.equal(socket.last('lifecycle').state, 'settling');
    assert.equal(socket.of('reset').length, 0, 'nor during grace — they may walk back in');

    rt.testAdvanceTime(30_000);
    assert.equal(socket.last('lifecycle').state, 'attract');
    assert.equal(socket.of('reset').length, 1, 'once the grace has actually expired');

    // And not again on every subsequent reconcile. A piece that wiped itself
    // repeatedly would be indistinguishable from one that never held state.
    for (let i = 0; i < 5; i++) rt.notifyChange();
    assert.equal(socket.of('reset').length, 1);
  });

  it('does not reset a guest who came back inside the grace', () => {
    const { rt, server } = makeRuntime();
    const g = driverIn(rt);
    const socket = server.latest();

    rt.sendGuestToRoom(g.guestId, 'museumHallway');
    rt.testAdvanceTime(3000);
    assert.equal(socket.last('lifecycle').state, 'settling');

    rt.sendGuestToRoom(g.guestId, 'influence');
    rt.testAdvanceTime(3000);
    // Walking back into your own session and finding it wiped is the whole
    // reason `reset` is an event and not the end of `settling`.
    assert.equal(socket.of('reset').length, 0);
    assert.equal(socket.last('lifecycle').state, 'live');
  });

  it('never sends a lifecycle that is a command rather than a condition', () => {
    const { rt, server } = makeRuntime();
    driverIn(rt);
    rt.testAdvanceTime(60_000);
    const states = new Set(server.latest().of('lifecycle').map((m) => m.state));
    for (const state of states) {
      assert.ok(['attract', 'live', 'settling'].includes(state), `lifecycle "${state}"`);
    }
  });

  it('respects a cap the experience itself declares', () => {
    const { rt, server } = makeRuntime();
    server.latest().reply({ t: 'ready', experienceId: 'influence-clickfarm', version: '1.0.0', maxDrivers: 1 });
    driverIn(rt);
    driverIn(rt);
    assert.equal(server.latest().last('drivers').drivers.length, 1, 'the piece knows its own limit');
  });
});

describe('handing a phone to an experience', () => {
  const experienceCues = (cues) => cues.filter((c) => c.kind === 'experience');

  it('sends the phone where to connect, as whom', () => {
    const { rt, cues } = makeRuntime();
    const g = driverIn(rt);
    const cue = experienceCues(cues).find((c) => c.guestId === g.guestId);

    assert.equal(cue.endpoint, 'ws://10.0.0.5:8080');
    assert.equal(cue.inputMode, 'stream');
    assert.deepEqual(cue.inputs, ['drag', 'release', 'tap', 'hold']);
    assert.ok(cue.driverId && cue.secret);
    // The same secret the room server was told to accept, and nothing else.
    const drivers = rt.experienceDrivers('influence');
    assert.equal(cue.secret, drivers.find((d) => d.guestId === g.guestId).secret);
  });

  it('takes it back when they leave the room', () => {
    const { rt, cues } = makeRuntime();
    const g = driverIn(rt);
    cues.length = 0;

    rt.sendGuestToRoom(g.guestId, 'museumHallway');
    rt.testAdvanceTime(3000);
    assert.ok(
      cues.some((c) => c.kind === 'endExperience' && c.guestId === g.guestId),
      'a phone still talking to a wall it has walked away from is the fault here',
    );
  });

  it('hands a reconnecting phone straight back to the experience', () => {
    const { rt, cues } = makeRuntime();
    const g = driverIn(rt);
    cues.length = 0;

    rt.resyncCues(g.guestId);
    const cue = experienceCues(cues).find((c) => c.guestId === g.guestId);
    assert.ok(cue, 'being connected is a state, not an event that happened once');
    assert.ok(cue.driverId);
  });

  it('gives nothing to a guest in a room with no experience', () => {
    const { rt, cues } = makeRuntime();
    const g = rt.spawnGuest({ kind: 'phone' });
    rt.sendGuestToRoom(g.guestId, 'calibration');
    rt.testAdvanceTime(3000);
    assert.deepEqual(experienceCues(cues), []);
  });
});
