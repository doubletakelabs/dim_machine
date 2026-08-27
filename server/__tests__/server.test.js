/**
 * The WebSocket and HTTP surface, against a running server.
 *
 * This is the file the four faults listed in the harness needed and did not
 * have. They share a shape: each is about the *edge* — a socket arriving, a
 * socket leaving, two sockets claiming one person — rather than about show
 * logic, and none of them is reachable without a real connection. The spatial
 * runtime beneath has hundreds of tests and has produced roughly one bug; this
 * file has produced four.
 *
 * A server per `describe`, because booting one is a few hundred milliseconds and
 * a shared runtime across unrelated cases is how a test suite starts depending
 * on the order it runs in.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, connect, openOperator, openPhone, runShow, rosterFor,
} from './helpers/server-harness.js';

describe('a handset arriving', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('issues a guest to a phone that has never been here', async () => {
    const op = await openOperator(server);
    await runShow(op);

    const phone = await openPhone(server);
    assert.ok(phone.welcome.token, 'a phone with no token is given one');
    assert.ok(phone.welcome.guestId);
    assert.ok(Array.isArray(phone.welcome.assets), 'and told what to preload');
    assert.ok(typeof phone.welcome.serverTime === 'number', 'and the server clock');
    // The handset's own room picker stands in for BLE — without this a phone
    // cannot report where it is and the show cannot follow anybody.
    assert.ok(phone.welcome.rooms.length > 0);
    phone.close();
    op.close();
  });

  it('gives the returning token the same guest, not a new one', async () => {
    const op = await openOperator(server);
    await runShow(op);

    const first = await openPhone(server);
    const { token, guestId } = first.welcome;
    first.close();
    await first.waitForClose();

    const again = await openPhone(server, token);
    assert.equal(again.welcome.guestId, guestId, 'a refresh is the same person');
    assert.equal(again.welcome.token, token);
    again.close();
    op.close();
  });

  it('does not mistake an unknown token for a session', async () => {
    const op = await openOperator(server);
    await runShow(op);
    // A token from a previous show, or a mangled one. Issuing a fresh guest is
    // right; trusting the string is not.
    const phone = await openPhone(server, 'not-a-real-token');
    assert.notEqual(phone.welcome.token, 'not-a-real-token');
    assert.ok(phone.welcome.guestId);
    phone.close();
    op.close();
  });
});

describe('two sockets, one guest', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  /**
   * The flapping bug, both halves.
   *
   * A guest's token lives in the phone's storage, so a second tab is a second
   * socket claiming the same person. Closing the older one is correct and was
   * always done; not *telling* it was the bug, because a client that is closed
   * without explanation reconnects, displaces the newcomer in turn, and the two
   * trade places for as long as both pages are open.
   */
  it('evicts the older socket and tells it why', async () => {
    const op = await openOperator(server);
    await runShow(op);

    const firstTab = await openPhone(server);
    const { token } = firstTab.welcome;

    const secondTab = await openPhone(server, token);
    assert.equal(secondTab.welcome.token, token, 'the newcomer keeps the identity');

    await firstTab.waitFor('displaced', { describe: 'the loser being told it lost' });
    const closed = await firstTab.waitForClose();
    assert.equal(closed.code, 4001, 'a code the client can distinguish from a network drop');

    secondTab.close();
    op.close();
  });

  it('leaves the winner connected', async () => {
    const op = await openOperator(server);
    await runShow(op);

    const firstTab = await openPhone(server);
    const secondTab = await openPhone(server, firstTab.welcome.token);
    await firstTab.waitForClose();

    // The half that makes it not a flap: nothing evicts the survivor in turn.
    await secondTab.expectNothing('displaced', 500);
    assert.equal(secondTab.closed, null);

    // And it is still the live socket — the server talks to it, not the corpse.
    secondTab.send({ type: 'ping', t0: 99 });
    const pong = await secondTab.waitFor('pong');
    assert.equal(pong.t0, 99);

    secondTab.close();
    op.close();
  });
});

describe('telling a phone where it is', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  /**
   * The client has always handled a `state` message. Nothing ever sent one, so
   * the handset's readout was fixed at whatever was true when it connected and
   * moved only on refresh — which reads as the show being broken rather than
   * the readout being stale, and cost a rehearsal to find.
   */
  /** Wait for the readout to reach a given value, ignoring any on the way. */
  const stateBecomes = (phone, pattern) => phone.waitFor(
    (m) => m.type === 'state' && pattern.test(m.state),
    { describe: `state matching ${pattern}` },
  );

  it('tells a phone where it stands as soon as it connects', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const phone = await openPhone(server);

    // A handset that joins before the show reaches it is outside, and has to be
    // told so — the readout is the only thing on the screen saying the socket is
    // live and the server knows about this guest.
    await stateBecomes(phone, /^outside$/);

    phone.close();
    op.close();
  });

  it('pushes the line when the guest moves', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const phone = await openPhone(server);
    await stateBecomes(phone, /^outside$/);

    op.send({ type: 'sendGuestToRoom', guestId: phone.welcome.guestId, roomId: 'library' });

    const state = await stateBecomes(phone, /^library · /);
    assert.match(state.state, /^library · \w+$/, 'names the room and the standing');

    phone.close();
    op.close();
  });

  it('says nothing when nothing about it changed', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const phone = await openPhone(server);

    op.send({ type: 'sendGuestToRoom', guestId: phone.welcome.guestId, roomId: 'library' });
    await stateBecomes(phone, /^library · /);

    // The roster broadcast is on a two-second interval and pushes phone state
    // every time. Without the dedupe this is a message per phone per tick,
    // forever, saying the same thing — and the window here spans more than one
    // tick precisely so a missing dedupe cannot slip between them.
    await phone.expectNothing('state', 2500);

    phone.close();
    op.close();
  });

  it('follows the handset reporting its own room', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const phone = await openPhone(server);
    await stateBecomes(phone, /^outside$/);

    // The room picker stands in for BLE: one person can walk the real building
    // with the real phone and the show follows, with nobody at the panel.
    phone.send({ type: 'setRoom', roomId: 'cyclorama' });
    await stateBecomes(phone, /^cyclorama · /);

    phone.close();
    op.close();
  });
});

describe('who is allowed to drive the show', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  /**
   * Every operator command is guarded by the same one-line check, and nothing
   * has ever tested one of them. A guest's handset is an ordinary browser on the
   * venue wifi with the console open.
   */
  it('ignores show control from a phone', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const phone = await openPhone(server);

    const before = await op.waitFor('roster', { since: op.mark() });
    const guestCountBefore = before.show.guestCount;

    for (const msg of [
      { type: 'stopShow' },
      // The show already loaded, deliberately. `runtime.load` stops the show
      // and clears every guest, so if the guard ever went, this one line would
      // wipe the roster mid-performance — which makes it a better probe than a
      // filename the server would have refused anyway.
      { type: 'loadShow', file: 'MAD-DIM.json' },
      { type: 'spawnGuest', count: 20 },
      { type: 'removeGuest', guestId: phone.welcome.guestId },
      { type: 'setTimeScale', rate: 10 },
      { type: 'startWalkthrough' },
      { type: 'sendRoomEvent', roomId: 'library', event: 'RELEASE' },
      { type: 'setVirtualPosition', guestId: phone.welcome.guestId, x: 10, y: 10 },
    ]) phone.send(msg);

    await new Promise((r) => setTimeout(r, 500));
    const after = await op.waitFor('roster', { since: op.mark() });

    assert.equal(after.show.running, true, 'the show is still running');
    assert.equal(after.show.file, 'MAD-DIM.json', 'and is still the show that was loaded');
    assert.equal(after.show.guestCount, guestCountBefore, 'and nobody was conjured or removed');
    assert.equal(after.timeScale ?? after.spatial?.timeScale, 1, 'and time still runs at 1x');

    phone.close();
    op.close();
  });

  it('lets a phone do the things that are its own', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const phone = await openPhone(server);

    // Reporting its room, answering with a gesture, keeping the clock: these
    // are the phone's own business and must not be caught by the same guard.
    phone.send({ type: 'setRoom', roomId: 'library' });
    await phone.waitFor((m) => m.type === 'state' && /^library · /.test(m.state), {
      describe: 'the phone being allowed to report its own room',
    });

    phone.send({ type: 'input', event: { type: 'tap' } });
    phone.send({ type: 'ready' });
    phone.send({ type: 'telemetry', offset: 4, rtt: 20, jitter: 1 });

    const roster = await op.waitFor(
      (m) => m.type === 'roster' && m.users.some((u) => u.guestId === phone.welcome.guestId && u.telemetry),
      { since: op.mark(), describe: 'the roster carrying this phone\'s telemetry' },
    );
    const mine = roster.users.find((u) => u.guestId === phone.welcome.guestId);
    assert.equal(mine.telemetry.rtt, 20);

    phone.close();
    op.close();
  });
});

describe('a phone leaving and coming back', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('shows as offline, then online again, without losing the guest', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const phone = await openPhone(server);
    const { token, guestId } = phone.welcome;

    assert.equal((await rosterFor(op, guestId, op.mark())).connected, true);

    phone.close();
    await phone.waitForClose();

    const gone = await op.waitFor(
      (m) => m.type === 'roster' && m.users.some((u) => u.guestId === guestId && !u.connected),
      { since: op.mark(), describe: 'the roster showing this phone offline' },
    );
    // Offline, not gone. A phone in a pocket for a minute is the normal case and
    // the guest has to still be theirs when it comes out.
    assert.ok(gone.users.some((u) => u.guestId === guestId));

    const back = await openPhone(server, token);
    assert.equal(back.welcome.guestId, guestId);
    assert.equal((await rosterFor(op, guestId, op.mark())).connected, true);

    back.close();
    op.close();
  });
});

describe('nonsense over the socket', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  /**
   * The server is on an open wifi with guests' phones on it. None of this
   * should be interesting; the test is that none of it is fatal, because a
   * throw in the message handler takes the show down for everybody.
   */
  it('survives it and keeps serving', async () => {
    const op = await openOperator(server);
    await runShow(op);

    const noise = await connect(server).open();
    noise.ws.send('not json at all');
    noise.ws.send('{"unterminated": ');
    for (const msg of [
      {},
      { type: 'hello', role: 'operator', extra: 'x'.repeat(1000) },
      { type: 'nonexistent' },
      { type: 'input' },
      { type: 'setRoom', roomId: 'no-such-room' },
      { type: 'sendGuestToRoom', guestId: null, roomId: null },
      { type: 'relay', channel: null, payload: undefined },
      { type: 'ping' },
      { type: 'setTimeScale', rate: 'fast' },
      { type: 'requestActivation' },
    ]) noise.send(msg);
    noise.close();

    // Still alive and still answering.
    const phone = await openPhone(server);
    assert.ok(phone.welcome.guestId);
    const roster = await op.waitFor('roster', { since: op.mark() });
    assert.equal(roster.show.running, true);

    phone.close();
    op.close();
  });

  it('answers a ping with the stamp it was given', async () => {
    // Carried from v0.2 and load-bearing: every cue's `startAt` is read against
    // an offset the phone computes from these round trips.
    const phone = await openPhone(server);
    phone.send({ type: 'ping', t0: 123456 });
    const pong = await phone.waitFor('pong');
    assert.equal(pong.t0, 123456, 'the phone matches the reply to its own send');
    assert.ok(typeof pong.server === 'number');
    phone.close();
  });
});

describe('the HTTP surface', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('lists the shows on disk', async () => {
    const res = await fetch(`${server.url}/api/shows`);
    assert.equal(res.status, 200);
    const shows = await res.json();
    assert.ok(shows.includes('MAD-DIM.json'));
    assert.ok(shows.every((f) => f.endsWith('.json')));
  });

  it('will not read outside the shows directory', async () => {
    // `basename` is the guard. It is one call, in three routes, and nothing has
    // ever checked that it is still there.
    for (const attempt of ['..%2f..%2fpackage.json', '..%2F..%2Fserver%2Findex.js']) {
      const res = await fetch(`${server.url}/api/shows/${attempt}`);
      assert.ok(res.status >= 400, `${attempt} should be refused, got ${res.status}`);
    }
    const notJson = await fetch(`${server.url}/api/shows/passwd`);
    assert.equal(notJson.status, 400);
  });

  it('validates a show without saving it', async () => {
    const res = await fetch(`${server.url}/api/shows/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rooms: { broken: { kind: 'nonsense' } } }),
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.ok(result.errors.length > 0, 'a bad show reports errors rather than throwing');
  });

  it('refuses to write a show that does not validate', async () => {
    const res = await fetch(`${server.url}/api/shows/scratch.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rooms: { broken: { kind: 'nonsense' } } }),
    });
    assert.equal(res.status, 400);
    const list = await (await fetch(`${server.url}/api/shows`)).json();
    assert.ok(!list.includes('scratch.json'), 'and nothing lands on disk');
  });

  it('serves the phone client, the panel, and the zone tracer', async () => {
    for (const path of ['/', '/operator.html', '/client.js', '/zones.html']) {
      const res = await fetch(`${server.url}${path}`);
      assert.equal(res.status, 200, `${path} should be served`);
    }
  });

  it('serves the real zone geometry to the tracer, not a copy', async () => {
    const res = await fetch(`${server.url}/lib/zone-math.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const src = await res.text();
    // The functions the tool needs, from the module the show actually runs —
    // a drifted browser copy of overlap logic would approve zones the
    // validator then rejects.
    assert.match(src, /export function polygonsOverlap/);
    assert.match(src, /export function pointInPolygon/);
  });
});

describe('booting', () => {
  it('uses no installation when none is named', async () => {
    const server = await startServer();
    try {
      const op = await openOperator(server);
      await runShow(op);
      const roster = await op.waitFor('roster', { since: op.mark() });
      // This is not only about the default. The harness clears INSTALLATION to
      // keep the suite off this machine's git-ignored `installations/local.json`
      // — someone's LAN addresses — and that isolation rests on an empty string
      // being treated as a value rather than as absent. If that ever changes,
      // the tests quietly start reaching for a venue that is not there.
      assert.equal(roster.show.installation, null);
      op.close();
    } finally {
      await server.stop();
    }
  });

  it('refuses to start on an installation file it cannot read', async () => {
    // Better than starting with no addresses and looking fine: a typo'd path is
    // twelve rooms that silently run as ordinary rooms.
    await assert.rejects(
      () => startServer({ installation: 'installations/does-not-exist.json' }),
      /exited with 1|did not start/,
    );
  });

  it('places rooms from the installation it is given', async () => {
    const server = await startServer({ installation: 'installations/local.example.json' });
    try {
      const op = await openOperator(server);
      const roster = await op.waitFor('roster');
      assert.ok(roster.show.installation, 'the panel says which installation is in use');
      op.close();
    } finally {
      await server.stop();
    }
  });
});
