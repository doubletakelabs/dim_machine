// DIM Machine — Phase 1 server (+ contract v2 room actors).
// Loads contract-v1 show definitions (shows/*.json) into per-user XState
// actors (ShowRuntime) and bridges phones/operator over WebSocket.
//
// Protocol:
//   phone → server:  hello{token?}, ping{t0}, telemetry{...},
//                    cueReport{cueId,targetAt,actualAt}, input{event:{type,payload}},
//                    relay{channel,payload,persist?}
//   server → phone:  welcome{token,label,serverTime,assets,snapshot},
//                    pong{t0,server}, cue{cue}, state{state}, assets{assets},
//                    relay{channel,from,payload,at,self}, relaySync{channels}
//   operator → server: hello{role:'operator'}, loadShow{file}, startShow, stopShow,
//                      sendEvent{event,target}, setRole{token,role}, pushCue{cue,target},
//                      moveAllToRoom{roomId,fromRoomId?}, forceRoomState{roomId,state}, startRoom{roomId}, clearOfflinePhones
//   server → operator: roster{users,show,shows}, log{line,at}
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { ShowRuntime, validateDefinition } from './runtime.js';
import * as relay from './relay.js';

const PORT = process.env.PORT || 4000;
const BASE_ASSETS = ['click.wav', 'ambient.wav', 'whisper.wav', 'chime.wav'];
const CUE_RETENTION_MS = 30_000;
const OFFLINE_HIDE_MS = 60_000;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const showsDir = join(root, 'shows');
const assetsDir = join(root, 'public', 'assets');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(root, 'public')));
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function showPath(file) {
  return join(showsDir, basename(file));
}

const customPagesDir = join(root, 'public', 'custom-pages');

function listCustomPages() {
  try {
    return readdirSync(customPagesDir)
      .filter((name) => !name.startsWith('_'))
      .filter((name) => existsSync(join(customPagesDir, name, 'page.js')))
      .sort();
  } catch {
    return [];
  }
}

app.get('/api/custom-pages', (_req, res) => res.json(listCustomPages()));

app.get('/api/shows', (_req, res) => res.json(listShows()));

app.get('/api/shows/:file', (req, res) => {
  const file = basename(req.params.file);
  if (!file.endsWith('.json')) return res.status(400).json({ error: 'invalid file name' });
  try {
    res.json(JSON.parse(readFileSync(showPath(file), 'utf8')));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/shows/validate', (req, res) => {
  const result = validateDefinition(req.body ?? {});
  res.json(result);
});

app.post('/api/shows/:file', (req, res) => {
  const file = basename(req.params.file);
  if (!file.endsWith('.json')) return res.status(400).json({ error: 'invalid file name' });
  const def = req.body;
  if (!def || typeof def !== 'object') return res.status(400).json({ error: 'body must be JSON object' });
  const result = validateDefinition(def);
  if (result.errors.length) return res.status(400).json(result);
  try {
    writeFileSync(showPath(file), `${JSON.stringify(def, null, 2)}\n`);
    res.json({ ok: true, warnings: result.warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const users = new Map(); // token → { userId, num, ws, connectedAt, disconnectedAt, telemetry }
const operators = new Set();
let userCounter = 0;
let loadedShowFile = null;

// Operator-pushed broadcast cues (sync test etc.) kept for late resync.
let globalCues = [];
function pruneGlobalCues() {
  const now = Date.now();
  globalCues = globalCues.filter((a) => a.cue.loop || now - a.cue.startAt < CUE_RETENTION_MS);
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------
const runtime = new ShowRuntime({
  sendCue: (token, cue) => sendToUser(token, { type: 'cue', cue }),
  onUserState: (token, stateString) => {
    sendToUser(token, { type: 'state', state: stateString });
    scheduleRoster();
  },
  onRoomsChanged: () => scheduleRoster(),
  onUserZoneChange: (token, newZone, prevZone) => {
    if (prevZone) notifyRelayPeerLeft(token, prevZone);
    if (newZone) sendRelaySync(token, newZone);
  },
  log: opLog,
});

function listShows() {
  try {
    return readdirSync(showsDir).filter((f) => f.endsWith('.json')).sort();
  } catch { return []; }
}

function currentAssets() {
  const showAssets = runtime.def?.assets ?? [];
  return [...new Set([...BASE_ASSETS, ...showAssets])];
}

function loadShow(file) {
  const path = join(showsDir, basename(file)); // basename: no path escape
  let def;
  try {
    def = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    opLog(`load failed: ${err.message}`);
    return;
  }
  const { errors, warnings } = runtime.load(def);
  for (const w of warnings) opLog(`⚠ ${w}`);
  if (errors.length) {
    for (const e of errors) opLog(`✗ ${e}`);
    return;
  }
  loadedShowFile = basename(file);
  for (const a of def.assets ?? [])
    if (!existsSync(join(assetsDir, a))) opLog(`⚠ asset missing on disk: ${a}`);
  broadcast({ type: 'assets', assets: currentAssets() }, 'phones');
  sendRoster();
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendToUser(token, obj) { send(users.get(token)?.ws, obj); }
function broadcast(obj, who) {
  if (who === 'phones' || who === 'all') for (const u of users.values()) send(u.ws, obj);
  if (who === 'operators' || who === 'all') for (const ws of operators) send(ws, obj);
}
function opLog(line) {
  broadcast({ type: 'log', line, at: Date.now() }, 'operators');
  console.log('[show]', line);
}

let rosterTimer = null;
function scheduleRoster() { // debounce bursts of state changes
  if (rosterTimer) return;
  rosterTimer = setTimeout(() => { rosterTimer = null; sendRoster(); }, 60);
}
function sendRoster() {
  const now = Date.now();
  let hiddenOfflineCount = 0;
  const roster = [];
  for (const [token, u] of users.entries()) {
    const offlineMs = u.ws ? 0 : now - (u.disconnectedAt ?? now);
    if (!u.ws && offlineMs > OFFLINE_HIDE_MS) {
      hiddenOfflineCount++;
      continue;
    }
    const ru = runtime.users.get(token);
    roster.push({
      token,
      label: `Phone ${u.num}`,
      connected: !!u.ws,
      disconnectedForMs: offlineMs,
      telemetry: u.telemetry ?? null,
      state: ru?.stateString ?? null,
      zoneId: ru?.zoneId ?? null,
      page: ru?.page?.page ?? null,
      role: ru?.role ?? null,
      availableEvents: runtime.eventsForUser(token),
    });
  }
  broadcast({
    type: 'roster',
    users: roster,
    hiddenOfflineCount,
    show: { ...runtime.rosterInfo(), file: loadedShowFile, globals: runtime.globals },
    shows: listShows(),
  }, 'operators');
}
setInterval(sendRoster, 2000);

function snapshotFor(token) {
  pruneGlobalCues();
  const now = Date.now();
  const rs = runtime.getUserSnapshot(token);
  return {
    state: rs?.state ?? null,
    page: rs?.page ?? null,
    displayVars: rs?.displayVars ?? {},
    serverTime: now,
    relay: relay.syncForRoom(relay.audienceKey(runtime, token)),
    cues: [
      ...globalCues.map((a) => a.cue).filter((c) => c.loop || c.startAt > now),
      ...(rs?.cues ?? []),
    ],
  };
}

// Operator ad-hoc cues (sync test / test tones) — Phase 0 feature, kept.
function pushCue(spec, target = 'all') {
  const cue = {
    cueId: randomUUID().slice(0, 8),
    kind: spec.kind,
    assetId: spec.assetId,
    gain: spec.gain ?? 1,
    loop: spec.loop ?? false,
    fadeMs: spec.fadeMs ?? 0,
    startAt: Date.now() + (spec.leadTimeMs ?? 2000),
  };
  if (cue.kind === 'stopAudio') {
    globalCues = globalCues.filter((a) => cue.assetId !== '*' && a.cue.assetId !== cue.assetId);
  } else if (target === 'all') {
    pruneGlobalCues();
    globalCues.push({ cue });
  }
  const msg = { type: 'cue', cue };
  if (target === 'all') broadcast(msg, 'phones');
  else sendToUser(target, msg);
  opLog(`operator cue ${cue.kind}${cue.assetId ? ' ' + cue.assetId : ''} → ${target === 'all' ? 'all' : label(target)}`);
}

const label = (token) => `Phone ${users.get(token)?.num ?? '?'}`;

function sendRelaySync(token, roomKey) {
  sendToUser(token, { type: 'relaySync', channels: relay.syncForRoom(roomKey) });
}

function broadcastRelay(fromToken, envelope, audience) {
  for (const t of audience) {
    sendToUser(t, { ...envelope, self: t === fromToken });
  }
}

function notifyRelayPeerLeft(token, roomKey) {
  const u = users.get(token);
  if (!u) return;
  const from = relay.senderFrom(users, token, label);
  const channels = relay.clearPeer(roomKey, u.userId);
  if (!channels.length) return;
  const at = Date.now();
  const audience = relay.audienceTokens(runtime, users, token).filter((t) => t !== token);
  for (const channel of channels) {
    for (const t of audience) {
      sendToUser(t, { type: 'relay', channel, from, payload: null, at, self: false });
    }
  }
}

function handleRelay(token, msg) {
  if (!users.get(token)?.ws) return;
  const { channel, payload, persist } = msg;
  if (!relay.validateChannel(channel) || !relay.validatePayload(payload)) return;
  if (!relay.checkRateLimit(token, channel)) return;

  const roomKey = relay.audienceKey(runtime, token);
  const from = relay.senderFrom(users, token, label);
  const at = Date.now();
  const envelope = { type: 'relay', channel, from, payload, at };

  if (persist !== false && payload != null) {
    relay.persistEntry(roomKey, channel, from.userId, { from, payload, at });
  } else if (payload === null) {
    relay.persistEntry(roomKey, channel, from.userId, null);
  }

  broadcastRelay(token, envelope, relay.audienceTokens(runtime, users, token));
}

function disconnectedForMs(u) {
  return u.ws ? 0 : Date.now() - (u.disconnectedAt ?? Date.now());
}

function clearOfflinePhones() {
  const removed = [];
  for (const [token, u] of users.entries()) {
    if (!u.ws && disconnectedForMs(u) > OFFLINE_HIDE_MS) {
      runtime.removeUser(token);
      notifyRelayPeerLeft(token, relay.audienceKey(runtime, token));
      users.delete(token);
      removed.push(label(token));
    }
  }
  if (removed.length) opLog(`cleared offline: ${removed.join(', ')}`);
  sendRoster();
  return removed.length;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  let token = null;
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
        if (msg.token && users.has(msg.token)) {
          token = msg.token;
          const u = users.get(token);
          if (u.ws && u.ws !== ws) { try { u.ws.close(); } catch {} }
          u.ws = ws;
          u.disconnectedAt = null;
        } else {
          token = randomUUID();
          users.set(token, {
            userId: `u-${++userCounter}`, num: userCounter,
            ws, connectedAt: Date.now(), telemetry: null,
          });
          runtime.attachUser(token); // late joiner enters at initial state
        }
        send(ws, {
          type: 'welcome',
          token,
          userId: users.get(token).userId,
          label: label(token),
          serverTime: Date.now(),
          assets: currentAssets(),
          snapshot: snapshotFor(token),
        });
        sendRoster();
        return;
      }

      case 'ping':
        send(ws, { type: 'pong', t0: msg.t0, server: Date.now() });
        return;

      case 'telemetry': {
        const u = users.get(token);
        if (u) u.telemetry = { offset: msg.offset, rtt: msg.rtt, jitter: msg.jitter, at: Date.now() };
        return;
      }

      case 'cueReport': {
        const u = users.get(token);
        const drift = msg.actualAt - msg.targetAt;
        if (u?.telemetry) u.telemetry.lastCueDriftMs = Math.round(drift * 10) / 10;
        return;
      }

      case 'input': {
        if (!token || !msg.event?.type) return;
        runtime.handleInput(token, msg.event.type, msg.event.payload);
        return;
      }
      case 'relay':
        if (!token) return;
        handleRelay(token, msg);
        return;

      // --- operator commands ---
      case 'loadShow': if (isOperator) loadShow(msg.file); return;
      case 'startShow':
        if (!isOperator) return;
        runtime.start([...users.keys()]);
        sendRoster();
        return;
      case 'stopShow':
        if (!isOperator) return;
        runtime.stop();
        globalCues = [];
        sendRoster();
        return;
      case 'sendEvent':
        if (!isOperator || !msg.event) return;
        opLog(`operator event: ${msg.event} → ${msg.target === 'all' || !msg.target ? 'all' : label(msg.target)}`);
        runtime.sendEvent(msg.target ?? 'all', msg.event, msg.payload);
        return;
      case 'setRole':
        if (!isOperator) return;
        runtime.setRole(msg.token, msg.role);
        opLog(`${label(msg.token)} role → ${msg.role || '(none)'}`);
        sendRoster();
        return;
      case 'assignZone':
        if (!isOperator) return;
        if (msg.roomId) {
          runtime.enterZone(msg.token, msg.roomId);
          opLog(`${label(msg.token)} → room ${msg.roomId}`);
        } else {
          runtime.leaveZone(msg.token);
        }
        sendRoster();
        return;
      case 'moveAllToRoom':
        if (!isOperator || !msg.roomId) return;
        runtime.moveAllToRoom(msg.roomId, [...users.keys()], { fromRoomId: msg.fromRoomId || null });
        sendRoster();
        return;
      case 'forceRoomState':
        if (!isOperator || !msg.roomId || !msg.state) return;
        runtime.forceRoomState(msg.roomId, msg.state);
        sendRoster();
        return;
      case 'startRoom':
        if (!isOperator || !msg.roomId) return;
        runtime.startRoom(msg.roomId);
        sendRoster();
        return;
      case 'clearOfflinePhones':
        if (isOperator) clearOfflinePhones();
        return;
      case 'pushCue':
        if (isOperator) pushCue(msg.cue, msg.target ?? 'all');
        return;
    }
  });

  ws.on('close', () => {
    if (isOperator) { operators.delete(ws); return; }
    if (token && users.get(token)?.ws === ws) {
      const u = users.get(token);
      const roomKey = relay.audienceKey(runtime, token);
      u.ws = null;
      u.disconnectedAt = Date.now();
      notifyRelayPeerLeft(token, roomKey);
      sendRoster();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log('DIM Machine Phase 1');
  console.log(`  phone client:   http://localhost:${PORT}/`);
  console.log(`  operator panel: http://localhost:${PORT}/operator.html`);
  console.log(`  author:         http://localhost:${PORT}/author.html`);
  console.log(`  shows dir:      ${showsDir} (${listShows().join(', ') || 'empty'})`);
});
