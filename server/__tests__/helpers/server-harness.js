/**
 * Boot the real server and talk to it over a real socket.
 *
 * `server/index.js` is the least-tested file in this repo and has hidden four
 * faults — a renamed runtime method, a `state` message nothing ever sent, two
 * tabs flapping over one identity, and a relay reaching a method that had gone.
 * Every one of them needed a socket to surface, and every one of them shipped.
 *
 * ## Why a child process rather than an import
 *
 * The module is a script: it resolves an installation, binds a port, and starts
 * an interval, all at import. Importing it once per test file would share a
 * single runtime and a single `users` map across every test in it, and importing
 * it twice is not possible at all.
 *
 * So the tests do what an operator does — start the program and connect to it.
 * That costs a few hundred milliseconds per server and buys the boot path
 * itself: argument handling, installation resolution, and the express routes are
 * all covered by the act of getting a socket open.
 *
 * `PORT=0` asks the OS for a free port. That is not only for isolation: 4100 is
 * usually somebody's running rehearsal, and a test suite that kills it, or that
 * quietly passes against it, is worse than no test suite. The server reports the
 * port it actually bound over the fork IPC channel.
 */
import { fork } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const entry = join(root, 'server/index.js');

const BOOT_TIMEOUT_MS = 10_000;
const WAIT_TIMEOUT_MS = 5_000;

/**
 * Start a server and wait until it is listening.
 *
 * @param {object} [opts]
 * @param {string} [opts.installation] — path to an installation file, repo-relative
 * @param {object} [opts.env] — extra environment for the child (e.g. SHOWS_DIR)
 * @returns {Promise<{ port: number, url: string, logs: string[], stop: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const child = fork(entry, opts.installation ? ['--installation', opts.installation] : [], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PORT: '0',
      // Empty rather than absent, and the difference matters. Absent falls back
      // to this machine's own `installations/local.json` — a git-ignored file
      // holding somebody's LAN addresses — which would make a test suite behave
      // differently on every laptop it runs on. Covered by a test, because it
      // rests on `??` treating '' as a value.
      ...(opts.installation ? {} : { INSTALLATION: '' }),
      ...(opts.env ?? {}),
    },
  });

  const logs = [];
  const capture = (stream) => stream.setEncoding('utf8').on('data', (chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) logs.push(line);
  });
  capture(child.stdout);
  capture(child.stderr);

  const stop = () => new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // The output is the whole diagnosis when a server fails to boot — a bad
      // installation file exits(1) and says why on stderr.
      reject(new Error(`server did not start within ${BOOT_TIMEOUT_MS}ms\n${logs.join('\n')}`));
    }, BOOT_TIMEOUT_MS);
    child.on('message', (msg) => {
      if (msg?.type !== 'listening') return;
      clearTimeout(timer);
      resolve(msg.port);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code} before listening\n${logs.join('\n')}`));
    });
  });

  return { port, url: `http://127.0.0.1:${port}`, logs, stop, child };
}

/**
 * A socket that remembers what it was sent.
 *
 * Everything that arrives goes in a list, and `waitFor` searches that list
 * before it waits. Without it, a test that asserts on a message the server sent
 * *while the test was still setting up* passes or fails depending on the
 * scheduler, which is the worst kind of test to own — it fails on the night and
 * passes when you look at it.
 */
export function connect(server) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const received = [];
  const waiters = new Set();
  let closed = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    received.push(msg);
    for (const w of [...waiters]) {
      if (!w.match(msg)) continue;
      waiters.delete(w);
      w.resolve(msg);
    }
  });
  ws.on('close', (code, reason) => {
    closed = { code, reason: String(reason) };
    for (const w of [...waiters]) {
      waiters.delete(w);
      w.reject(new Error(`socket closed (${code} ${closed.reason}) while waiting for ${w.describe}`));
    }
  });

  const toMatch = (want) => (typeof want === 'function' ? want : (msg) => msg.type === want);

  const client = {
    ws,
    received,
    get closed() { return closed; },

    open: () => new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve(client);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    }),

    send(obj) {
      ws.send(JSON.stringify(obj));
      return client;
    },

    /**
     * How many messages have arrived so far.
     *
     * Take one before an action and pass it as `since` to assert about what the
     * server does *next*. The roster is broadcast every two seconds regardless,
     * so without a cursor an assertion about the state after an action is
     * routinely satisfied by a roster from before it — and the test then passes
     * whether or not the action did anything.
     */
    mark: () => received.length,

    /**
     * Resolve with the first message matching `want` — a type string, or a
     * predicate. Searches what has already arrived first, from `since` on.
     */
    waitFor(want, { timeout = WAIT_TIMEOUT_MS, describe = String(want), since = 0 } = {}) {
      const match = toMatch(want);
      const already = received.slice(since).find(match);
      if (already) return Promise.resolve(already);
      if (closed) {
        return Promise.reject(new Error(`socket already closed (${closed.code}) waiting for ${describe}`));
      }
      return new Promise((resolve, reject) => {
        const waiter = { match, describe, resolve, reject };
        waiters.add(waiter);
        setTimeout(() => {
          if (!waiters.delete(waiter)) return;
          const seen = received.map((m) => m.type).join(', ') || 'nothing';
          reject(new Error(`timed out after ${timeout}ms waiting for ${describe}; received: ${seen}`));
        }, timeout).unref?.();
      });
    },

    /** Wait for the socket to close, and report how. */
    waitForClose(timeout = WAIT_TIMEOUT_MS) {
      if (closed) return Promise.resolve(closed);
      return new Promise((resolve, reject) => {
        ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
        setTimeout(() => reject(new Error(`socket still open after ${timeout}ms`)), timeout).unref?.();
      });
    },

    /**
     * Give the server a beat, then assert nothing matching turned up.
     *
     * For the half of a rule that is about what must *not* happen — an operator
     * command honoured from a phone, a `state` re-sent when nothing changed.
     */
    async expectNothing(want, ms = 300) {
      const match = toMatch(want);
      const from = received.length;
      await new Promise((r) => setTimeout(r, ms));
      const found = received.slice(from).find(match);
      if (found) throw new Error(`expected nothing, got ${JSON.stringify(found).slice(0, 200)}`);
    },

    close() {
      ws.close();
    },
  };

  return client;
}

/** A connected operator, with its first roster already in hand. */
export async function openOperator(server) {
  const op = await connect(server).open();
  op.send({ type: 'hello', role: 'operator' });
  await op.waitFor('roster');
  return op;
}

/**
 * A connected phone. Passing a token resumes that guest; passing none has the
 * server issue one, which is what a handset opening the page for the first time
 * does.
 */
export async function openPhone(server, token) {
  const phone = await connect(server).open();
  phone.send({ type: 'hello', ...(token ? { token } : {}) });
  phone.welcome = await phone.waitFor('welcome');
  return phone;
}

/** Load a show and start it, the way the panel's two buttons do. */
export async function runShow(op, file = 'MAD-DIM.json') {
  let since = op.mark();
  op.send({ type: 'loadShow', file });
  await op.waitFor((m) => m.type === 'roster' && m.show?.file === file, {
    since, describe: `roster reporting ${file} loaded`,
  });
  since = op.mark();
  op.send({ type: 'startShow' });
  await op.waitFor((m) => m.type === 'roster' && m.show?.running, {
    since, describe: 'roster reporting the show running',
  });
}

/** The roster's view of one guest, from the next roster to arrive. */
export async function rosterFor(op, guestId, since = 0) {
  const roster = await op.waitFor(
    (m) => m.type === 'roster' && m.users.some((u) => u.guestId === guestId),
    { since, describe: `roster containing ${guestId}` },
  );
  return roster.users.find((u) => u.guestId === guestId);
}
