// DIM Machine — Phase 0 server.
// Express serves the phone client + operator panel; ws carries the show protocol.
//
// Protocol (JSON messages):
//   client → server: hello{token?}, ping{t0}, cueReport{cueId,targetAt,actualAt}
//   server → client: welcome{token,userId,serverTime,assets,snapshot},
//                    pong{t0,server}, cue{cue}, state{state}, snapshot{...}
//   operator → server: hello{role:'operator'}, send{event}, pushCue{cue,target}
//   server → operator: roster{users,state}, log{line}
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createActor } from 'xstate';
import { createShowMachine, STATE_CUES, OPERATOR_EVENTS } from './machine.js';

const PORT = process.env.PORT || 4000;
const ASSETS = ['click.wav', 'ambient.wav', 'whisper.wav', 'chime.wav'];
const CUE_RETENTION_MS = 30_000; // non-loop cues stay "active" this long for late joiners

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.static(join(root, 'public')));
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ---------------------------------------------------------------------------
// Sessions (Phase 0 resilience: token → user survives disconnect/refresh)
// ---------------------------------------------------------------------------
const users = new Map(); // token → { userId, num, ws|null, connectedAt, disconnectedAt, telemetry }
const operators = new Set(); // ws
let userCounter = 0;

// Active cues, kept for snapshot-on-reconnect. Loop cues stay until stopped;
// one-shots are pruned after CUE_RETENTION_MS past startAt.
let activeCues = []; // [{ cue, target }]

function pruneCues() {
  const now = Date.now();
  activeCues = activeCues.filter(
    (a) => a.cue.loop || now - a.cue.startAt < CUE_RETENTION_MS
  );
}

// ---------------------------------------------------------------------------
// Show machine
// ---------------------------------------------------------------------------
const machine = createShowMachine({
  onStateCues: (state, cues) => {
    for (const c of cues) pushCue(c, 'all');
  },
  onStopAll: () => {
    activeCues = [];
    pushCue({ kind: 'stopAudio', assetId: '*', fadeMs: 800, leadTimeMs: 0 }, 'all', { track: false });
  },
});
const show = createActor(machine);
let currentState = 'lobby';
show.subscribe((snap) => {
  currentState = snap.value;
  broadcast({ type: 'state', state: currentState }, 'phones');
  sendRoster();
  opLog(`state → ${currentState}`);
});
show.start();

// ---------------------------------------------------------------------------
// Cue dispatch
// ---------------------------------------------------------------------------
function pushCue(spec, target = 'all', { track = true } = {}) {
  const cue = {
    cueId: spec.cueId ?? randomUUID().slice(0, 8),
    kind: spec.kind, // audio | flash | stopAudio | synctest
    assetId: spec.assetId,
    gain: spec.gain ?? 1,
    loop: spec.loop ?? false,
    fadeMs: spec.fadeMs ?? 0,
    startAt: Date.now() + (spec.leadTimeMs ?? 2000),
  };
  if (cue.kind === 'stopAudio' && track) {
    activeCues = activeCues.filter((a) => cue.assetId === '*' ? false : a.cue.assetId !== cue.assetId);
  } else if (track && cue.kind !== 'stopAudio') {
    pruneCues();
    activeCues.push({ cue, target });
  }
  const msg = { type: 'cue', cue };
  if (target === 'all') broadcast(msg, 'phones');
  else sendToUser(target, msg);
  opLog(`cue ${cue.kind}${cue.assetId ? ' ' + cue.assetId : ''} → ${target} @ +${spec.leadTimeMs ?? 2000}ms`);
  return cue;
}

function snapshotFor(token) {
  pruneCues();
  const now = Date.now();
  return {
    state: currentState,
    serverTime: now,
    cues: activeCues
      .filter((a) => a.target === 'all' || a.target === token)
      .map((a) => a.cue)
      .filter((c) => c.loop || c.startAt > now), // future one-shots + running loops
  };
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj, who) {
  if (who === 'phones' || who === 'all')
    for (const u of users.values()) send(u.ws, obj);
  if (who === 'operators' || who === 'all')
    for (const ws of operators) send(ws, obj);
}
function sendToUser(token, obj) {
  const u = users.get(token);
  if (u) send(u.ws, obj);
}
function opLog(line) {
  broadcast({ type: 'log', line, at: Date.now() }, 'operators');
  console.log('[show]', line);
}

function sendRoster() {
  const roster = [...users.entries()].map(([token, u]) => ({
    token,
    userId: u.userId,
    label: `Phone ${u.num}`,
    connected: !!u.ws,
    disconnectedForMs: u.ws ? 0 : Date.now() - (u.disconnectedAt ?? Date.now()),
    telemetry: u.telemetry ?? null,
  }));
  broadcast({ type: 'roster', users: roster, state: currentState, events: OPERATOR_EVENTS, assets: ASSETS }, 'operators');
}
setInterval(sendRoster, 2000);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  let token = null; // set for phones
  let isOperator = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'hello': {
        if (msg.role === 'operator') {
          isOperator = true;
          operators.add(ws);
          sendRoster();
          opLog('operator connected');
          return;
        }
        // Phone: rebind existing session or create one
        if (msg.token && users.has(msg.token)) {
          token = msg.token;
          const u = users.get(token);
          if (u.ws && u.ws !== ws) { try { u.ws.close(); } catch {} }
          u.ws = ws;
          u.disconnectedAt = null;
        } else {
          token = randomUUID();
          users.set(token, {
            userId: `u-${++userCounter}`,
            num: userCounter,
            ws,
            connectedAt: Date.now(),
            telemetry: null,
          });
        }
        const u = users.get(token);
        send(ws, {
          type: 'welcome',
          token,
          userId: u.userId,
          label: `Phone ${u.num}`,
          serverTime: Date.now(),
          assets: ASSETS,
          snapshot: snapshotFor(token),
        });
        sendRoster();
        return;
      }

      case 'ping':
        // Clock sync: echo t0, attach server receive time.
        send(ws, { type: 'pong', t0: msg.t0, server: Date.now() });
        return;

      case 'telemetry': {
        if (!token) return;
        const u = users.get(token);
        if (u) u.telemetry = { offset: msg.offset, rtt: msg.rtt, jitter: msg.jitter, at: Date.now() };
        return;
      }

      case 'cueReport': {
        if (!token) return;
        const u = users.get(token);
        const drift = msg.actualAt - msg.targetAt;
        if (u?.telemetry) u.telemetry.lastCueDriftMs = Math.round(drift * 10) / 10;
        opLog(`Phone ${u?.num ?? '?'} cue ${msg.cueId}: drift ${drift.toFixed(1)}ms`);
        return;
      }

      // --- operator commands ---
      case 'send': {
        if (!isOperator) return;
        if (OPERATOR_EVENTS.includes(msg.event)) {
          opLog(`operator event: ${msg.event}`);
          show.send({ type: msg.event });
        }
        return;
      }
      case 'pushCue': {
        if (!isOperator) return;
        pushCue(msg.cue, msg.target ?? 'all');
        return;
      }
    }
  });

  ws.on('close', () => {
    if (isOperator) { operators.delete(ws); return; }
    if (token && users.get(token)?.ws === ws) {
      const u = users.get(token);
      u.ws = null;
      u.disconnectedAt = Date.now();
      sendRoster();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`DIM Machine Phase 0`);
  console.log(`  phone client:   http://localhost:${PORT}/`);
  console.log(`  operator panel: http://localhost:${PORT}/operator.html`);
});
