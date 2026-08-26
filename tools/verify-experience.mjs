#!/usr/bin/env node
/**
 * Conformance check for a room experience (docs/ROOM-EXPERIENCE.md).
 *
 * Boots the piece's own server, connects as a broker exactly as the show does,
 * and drives it through the things that go wrong on a floor rather than on a
 * desk: a restart mid-show, a driver presenting a secret it was never given, a
 * `drivers` set that shrinks.
 *
 *   node tools/verify-experience.mjs ./02_influence
 *
 * Exit 0 means it will slot in. Exit 1 means it will not, and says why.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const dir = resolve(process.argv[2] ?? '.');
const PORT = Number(process.env.VERIFY_PORT || 8791);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (ok, label, detail) => results.push({ ok: !!ok, label, detail });

// --------------------------------------------------------------- the manifest

if (!existsSync(join(dir, 'experience.json'))) {
  console.error(`no experience.json in ${dir}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dir, 'experience.json'), 'utf8'));
} catch (err) {
  console.error(`experience.json does not parse: ${err.message}`);
  process.exit(1);
}

const INTENTS = ['drag', 'release', 'tap', 'hold', 'swipe'];
check(manifest.contract === 1, 'manifest declares contract 1', `got ${manifest.contract}`);
check(/^[a-z0-9-]+$/.test(manifest.experienceId ?? ''), 'experienceId is stable and kebab-case');
check(typeof manifest.version === 'string', 'version is declared');
check(typeof manifest.entry?.wall === 'string', 'entry.wall names the display page');
check(
  Array.isArray(manifest.inputs) && manifest.inputs.length
    && manifest.inputs.every((i) => INTENTS.includes(i)),
  'inputs are declared, and all are real intents',
  `got ${JSON.stringify(manifest.inputs)}`,
);
check(Number.isInteger(manifest.maxDrivers) && manifest.maxDrivers > 0, 'maxDrivers is a positive integer');

// A hardcoded address is the fault that only shows up once the piece is in a
// building that is not the one it was written in.
const sources = ['server.js', manifest.entry?.wall?.replace(/^\//, '')].filter(Boolean);
const hardcoded = [];
for (const file of sources) {
  const path = join(dir, file);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  for (const m of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (!/^(?:0\.0\.0\.0|127\.0\.0\.1|255\.|0\.)/.test(m[0])) hardcoded.push(`${file}: ${m[0]}`);
  }
}
check(!hardcoded.length, 'no hardcoded IP addresses', hardcoded.join(', '));

// ------------------------------------------------------------------- the server

const child = spawn('node', ['server.js'], {
  cwd: dir,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
child.stdout.on('data', (d) => { serverOutput += d; });
child.stderr.on('data', (d) => { serverOutput += d; });

const done = (code) => {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  report();
  process.exit(code);
};
process.on('uncaughtException', (err) => { console.error(err); done(1); });

await wait(1500);
check(child.exitCode === null, 'server starts with no arguments', serverOutput.slice(-300));
if (child.exitCode !== null) done(1);

// -------------------------------------------------------------------- http

async function get(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: err.message };
  }
}

const wall = await get(manifest.entry.wall);
check(wall.status === 200, `serves ${manifest.entry.wall}`, `HTTP ${wall.status}`);

// --------------------------------------------------------------- broker link

function broker() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const seen = [];
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw)); } catch { /* not ours */ } });
  return {
    ws,
    seen,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (m) => ws.send(JSON.stringify(m)),
    last: (t) => [...seen].reverse().find((m) => m.t === t) ?? null,
  };
}

let link;
try {
  link = broker();
  await link.open();
} catch (err) {
  check(false, 'accepts a broker connection', err.message);
  done(1);
}
check(true, 'accepts a broker connection');

link.send({ t: 'hello', role: 'broker', roomId: 'verify', experienceId: manifest.experienceId, contract: 1 });
await wait(600);
const ready = link.last('ready');
check(!!ready, 'answers `ready` to a broker hello');
check(ready?.experienceId === manifest.experienceId, '`ready` names the manifest experienceId');

// --------------------------------------------------------------- driver link

const driver = (driverId, secret) => ({ driverId, hue: 190, secret });
const A = driver('d-verify-a', 'secret-a');
const B = driver('d-verify-b', 'secret-b');

link.send({ t: 'lifecycle', state: 'live' });
link.send({ t: 'drivers', drivers: [A, B] });
await wait(400);

async function connectDriver({ driverId, secret }) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const seen = [];
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw)); } catch { /* not ours */ } });
  try {
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  } catch {
    return { ok: false, seen, ws };
  }
  ws.send(JSON.stringify({ t: 'hello', role: 'driver', driverId, secret }));
  await wait(400);
  return {
    claimed: seen.some((m) => m.t === 'claim'),
    denied: seen.some((m) => m.t === 'denied'),
    ws,
    send: (m) => { try { ws.send(JSON.stringify(m)); } catch { /* closed */ } },
  };
}

const good = await connectDriver(A);
check(good.claimed, 'claims a driver the broker authorised');

const bad = await connectDriver({ driverId: 'd-not-issued', secret: 'made-up' });
check(
  bad.denied || !bad.claimed,
  'refuses a driver the broker never authorised',
  'a piece that claims anyone is one anybody on the wifi can drive',
);

// Every declared intent, at the rate a thumb actually produces.
for (const intent of manifest.inputs) {
  const message = { drag: { dx: 0, dy: -0.03 }, release: { vx: 0, vy: -1.2 }, tap: {}, hold: { on: true }, swipe: { direction: 'left', dx: -0.4, dy: 0 } }[intent];
  for (let i = 0; i < 20; i++) good.send({ t: intent, ...message });
}
await wait(500);
check(child.exitCode === null, 'survives every declared intent at speed', serverOutput.slice(-300));

// `drivers` is a set: shrinking it must drop the one that left.
link.send({ t: 'drivers', drivers: [B] });
await wait(400);
check(child.exitCode === null, 'accepts a shrinking driver set');

// Exit grace, then rest. A piece that treats `settling` as a slower attract
// wipes a guest who only stepped into the corridor for a moment.
link.send({ t: 'lifecycle', state: 'settling' });
await wait(200);
link.send({ t: 'lifecycle', state: 'live' });
await wait(200);
check(child.exitCode === null, 'survives settling and a guest returning');
link.send({ t: 'lifecycle', state: 'settling' });
link.send({ t: 'reset' });
link.send({ t: 'lifecycle', state: 'attract' });
await wait(400);
check(child.exitCode === null, 'survives a reset');

// ------------------------------------------------------------- calibration

const before = await get('/calibration');
check(before.status === 200, 'GET /calibration answers', `HTTP ${before.status}`);
let wrote = { status: 0 };
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/calibration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verify: true, corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }),
  });
  wrote = { status: res.status };
} catch (err) {
  wrote = { status: 0, text: err.message };
}
check(wrote.status >= 200 && wrote.status < 300, 'POST /calibration is accepted', `HTTP ${wrote.status}`);
const after = await get('/calibration');
check(
  after.text.includes('"verify"'),
  'calibration round-trips',
  'localStorage is lost on a browser reset, and nobody finds out until load-in',
);
check(
  existsSync(join(dir, manifest.calibration?.file ?? 'calibration.json')),
  'calibration reached a file on disk',
);

// -------------------------------------------------------------- restartable

link.ws.close();
await wait(300);
const again = broker();
try {
  await again.open();
  again.send({ t: 'hello', role: 'broker', roomId: 'verify', experienceId: manifest.experienceId, contract: 1 });
  await wait(600);
  check(!!again.last('ready'), 'a reconnecting broker is answered as if new');
} catch (err) {
  check(false, 'a reconnecting broker is answered as if new', err.message);
}

done(results.every((r) => r.ok) ? 0 : 1);

// ------------------------------------------------------------------- output

function report() {
  console.log(`\n  ${manifest.name ?? manifest.experienceId} — ${manifest.version}\n`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}${!r.ok && r.detail ? `\n      ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed
    ? `\n  ${failed} of ${results.length} checks failed — see docs/ROOM-EXPERIENCE.md\n`
    : `\n  all ${results.length} checks passed\n`);
}
