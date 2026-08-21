// DIM Machine — v0.3 spatial runtime (Phase A).
// WebSocket bridge for operator panel, simulated guests, and phones (Phase B+).
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { SpatialRuntime, validateShowDefinition, ScaledClock } from './spatial/index.js';
import * as relay from './relay.js';

const PORT = process.env.PORT || 4000;
const BASE_ASSETS = ['click.wav', 'ambient.wav', 'whisper.wav', 'chime.wav'];
const OFFLINE_HIDE_MS = 60_000;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const showsDir = join(root, 'shows');
const assetsDir = join(root, 'public', 'assets');
const customPagesDir = join(root, 'public', 'custom-pages');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(root, 'public')));
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function showPath(file) {
  return join(showsDir, basename(file));
}

function listShows() {
  try {
    return readdirSync(showsDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

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
  res.json(validateShowDefinition(req.body ?? {}));
});

app.post('/api/shows/:file', (req, res) => {
  const file = basename(req.params.file);
  if (!file.endsWith('.json')) return res.status(400).json({ error: 'invalid file name' });
  const def = req.body;
  if (!def || typeof def !== 'object') return res.status(400).json({ error: 'body must be JSON object' });
  const result = validateShowDefinition(def);
  if (result.errors.length) return res.status(400).json(result);
  try {
    writeFileSync(showPath(file), `${JSON.stringify(def, null, 2)}\n`);
    res.json({ ok: true, warnings: result.warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Virtual walkthrough — set guest floor-plan position (Phase A1). */
app.post('/api/spatial/position', (req, res) => {
  const { guestId, token, x, y } = req.body ?? {};
  const id = guestId ?? token;
  if (!id || typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).json({ error: 'guestId|token, x, y required' });
  }
  const ok = runtime.setVirtualPosition(id, x, y);
  if (!ok) return res.status(400).json({ error: 'show not running or unknown guest' });
  res.json({ ok: true, spatial: runtime.getOperatorSnapshot() });
});

app.post('/api/spatial/tier', (req, res) => {
  const { guestId, token, roomId, occupancy } = req.body ?? {};
  const id = guestId ?? token;
  if (!id || !occupancy) {
    return res.status(400).json({ error: 'guestId|token and occupancy required' });
  }
  const ok = runtime.setVirtualOccupancy(id, roomId ?? null, occupancy);
  if (!ok) return res.status(400).json({ error: 'show not running or unknown guest' });
  res.json({ ok: true, spatial: runtime.getOperatorSnapshot() });
});

app.post('/api/spatial/activate', (req, res) => {
  const { guestId, token, roomId } = req.body ?? {};
  const id = guestId ?? token;
  if (!id || !roomId) {
    return res.status(400).json({ error: 'guestId|token and roomId required' });
  }
  const result = runtime.requestActivation(id, roomId);
  res.status(result.ok ? 200 : 409).json({ ...result, spatial: runtime.getOperatorSnapshot() });
});

// ---------------------------------------------------------------------------
// Sessions — token → { guestId, label, ws, telemetry, ... }
// ---------------------------------------------------------------------------
const users = new Map();
const operators = new Set();
let loadedShowFile = null;

// Test-mode clock: lets the panel run the show at 10x or pause it outright.
// Must be left at 1x once Phase B schedules real audio against a shared clock.
const showClock = new ScaledClock(1);

const runtime = new SpatialRuntime({
  clock: showClock,
  log: opLog,
  onStateChange: scheduleRoster,
  onPositionChange: schedulePositions,
  // The only path from show state to a phone. Everything upstream of this is
  // reconciliation; this just addresses the envelope.
  onCue: (guestId, cue) => {
    const token = runtime.guests.get(guestId)?.token;
    if (token) sendToUser(token, { type: 'cue', cue });
  },
  onOccupancy: (ev) => {
    const who = runtime.guests.get(ev.guestId)?.label ?? ev.guestId;
    opLog(`${who} → ${ev.roomId ?? '∅'} (${ev.occupancy})`);
  },
});

/**
 * Everything a phone must hold before the show starts.
 *
 * Gathered from the loaded show rather than listed by hand: a cue naming an
 * asset nobody preloaded is silence or a blank screen on the night, and the
 * failure looks like a cue that never fired. `BASE_ASSETS` stays because the
 * sync-test tones are used with no show loaded.
 */
function currentAssets() {
  const found = new Set(BASE_ASSETS);
  const collect = (cues) => {
    for (const declared of Object.values(cues ?? {})) {
      for (const option of [].concat(declared)) {
        if (option?.audio) found.add(option.audio);
        if (option?.image) found.add(option.image);
      }
    }
  };
  collect(runtime.def?.guest?.cues);
  for (const room of Object.values(runtime.def?.rooms ?? {})) collect(room.cues);
  return [...found];
}

function loadShow(file) {
  const path = showPath(file);
  let def;
  try {
    def = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    opLog(`load failed: ${err.message}`);
    return;
  }
  const result = runtime.load(def);
  for (const w of result.warnings ?? []) opLog(`⚠ ${w}`);
  if (!result.ok) {
    for (const e of result.errors) opLog(`✗ ${e}`);
    return;
  }
  loadedShowFile = basename(file);
  broadcast({ type: 'assets', assets: currentAssets() }, 'phones');
  sendRoster();
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendToUser(token, obj) {
  send(users.get(token)?.ws, obj);
}

function broadcast(obj, who) {
  if (who === 'phones' || who === 'all') {
    for (const u of users.values()) send(u.ws, obj);
  }
  if (who === 'operators' || who === 'all') {
    for (const ws of operators) send(ws, obj);
  }
}

function opLog(line) {
  broadcast({ type: 'log', line, at: Date.now() }, 'operators');
  console.log('[show]', line);
}

/**
 * Motion updates are pushed on their own channel, throttled to ~60ms. They
 * carry only what moves a dot; the full roster stays on its slower cadence
 * because it includes every guest's visit history and the recent event log.
 */
let positionsTimer = null;
function schedulePositions() {
  if (positionsTimer || rosterTimer) return;
  positionsTimer = setTimeout(() => {
    positionsTimer = null;
    broadcast({ type: 'positions', guests: runtime.getPositionsSnapshot() }, 'operators');
  }, 60);
}

let rosterTimer = null;
function scheduleRoster() {
  if (rosterTimer) return;
  rosterTimer = setTimeout(() => {
    rosterTimer = null;
    sendRoster();
  }, 60);
}

function sendRoster() {
  pushPhoneStates();
  const now = Date.now();
  const rosterUsers = [];
  for (const [token, u] of users.entries()) {
    const offlineMs = u.ws ? 0 : now - (u.disconnectedAt ?? now);
    if (!u.ws && offlineMs > OFFLINE_HIDE_MS) continue;
    const guest = runtime.getGuestByToken(token);
    rosterUsers.push({
      token,
      guestId: u.guestId,
      label: u.label,
      connected: !!u.ws,
      disconnectedForMs: offlineMs,
      telemetry: u.telemetry ?? null,
      pathId: guest?.pathId ?? null,
      regions: guest?.regions ?? null,
      adherence: guest?.adherence ?? null,
      roomId: guest?.roomId ?? null,
      occupancy: guest?.occupancy ?? null,
    });
  }

  broadcast({
    type: 'roster',
    users: rosterUsers,
    spatial: runtime.getOperatorSnapshot(),
    show: { ...runtime.rosterInfo(), file: loadedShowFile },
    shows: listShows(),
  }, 'operators');
}

setInterval(sendRoster, 2000);

function label(token) {
  return users.get(token)?.label ?? '?';
}

/**
 * Where the runtime thinks this guest is, as one line.
 *
 * A phone in a pocket during a walkthrough is hard to read; naming its guest's
 * room and standing turns the handset into its own probe.
 */
function phoneState(token) {
  const guest = runtime.getGuestByToken(token);
  const here = guest ? runtime.guestActors.get(guest.guestId)?.currentRoom() : null;
  return here ? `${here.roomId} · ${here.standing}` : 'outside';
}

/**
 * Push that line whenever it changes. The client has always handled a `state`
 * message; nothing ever sent one, so the readout was fixed at whatever was true
 * when the phone connected and only moved on refresh.
 */
const lastPhoneState = new Map();
function pushPhoneStates() {
  for (const [token, u] of users.entries()) {
    if (!u.ws) continue;
    const next = phoneState(token);
    if (lastPhoneState.get(token) === next) continue;
    lastPhoneState.set(token, next);
    sendToUser(token, { type: 'state', state: next });
  }
  for (const token of lastPhoneState.keys()) {
    if (!users.has(token)) lastPhoneState.delete(token);
  }
}

function phoneSnapshot(token) {
  const guest = runtime.getGuestByToken(token);
  return {
    serverTime: Date.now(),
    state: phoneState(token),
    spatial: guest
      ? {
          pathId: guest.pathId,
          regions: guest.regions,
          adherence: guest.adherence,
          roomId: guest.roomId,
          occupancy: guest.occupancy,
        }
      : null,
    relay: relay.syncForRoom(relay.audienceKey(runtime, token)),
    displayVars: Object.fromEntries(
      Object.entries(runtime.globals).map(([k, v]) => [`global.${k}`, v]),
    ),
  };
}

function ensurePhoneSession(token) {
  if (token && runtime.getGuestByToken(token)) {
    const u = users.get(token);
    if (u) return { token, ...u };
  }
  const spawned = runtime.spawnGuest();
  if (!spawned) return null;
  users.set(spawned.token, {
    guestId: spawned.guestId,
    label: spawned.label,
    ws: null,
    telemetry: null,
    connectedAt: Date.now(),
    disconnectedAt: null,
  });
  return { token: spawned.token, ...users.get(spawned.token) };
}

function sendRelaySync(token) {
  sendToUser(token, {
    type: 'relaySync',
    channels: relay.syncForRoom(relay.audienceKey(runtime, token)),
  });
}

function broadcastRelay(fromToken, envelope, audience) {
  for (const t of audience) {
    sendToUser(t, { ...envelope, self: t === fromToken });
  }
}

function notifyRelayPeerLeft(token) {
  const u = users.get(token);
  if (!u) return;
  const from = relay.senderFrom(users, token, label);
  const roomKey = relay.audienceKey(runtime, token);
  const channels = relay.clearPeer(roomKey, u.guestId);
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
    relay.persistEntry(roomKey, channel, from.guestId, { from, payload, at });
  } else if (payload === null) {
    relay.persistEntry(roomKey, channel, from.guestId, null);
  }

  broadcastRelay(token, envelope, relay.audienceTokens(runtime, users, token));
}

function clearOfflinePhones() {
  const removed = [];
  for (const [token, u] of users.entries()) {
    if (u.ws) continue;
    const offlineMs = Date.now() - (u.disconnectedAt ?? Date.now());
    if (offlineMs <= OFFLINE_HIDE_MS) continue;
    const guest = runtime.getGuestByToken(token);
    if (guest) runtime.removeGuest(guest.guestId);
    notifyRelayPeerLeft(token);
    users.delete(token);
    removed.push(u.label);
  }
  if (removed.length) opLog(`cleared offline: ${removed.join(', ')}`);
  sendRoster();
  return removed.length;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  let token = null;
  let isOperator = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello': {
        if (msg.role === 'operator') {
          isOperator = true;
          operators.add(ws);
          sendRoster();
          opLog('operator connected');
          return;
        }

        if (msg.token && runtime.getGuestByToken(msg.token)) {
          token = msg.token;
          let u = users.get(token);
          if (!u) {
            const p = runtime.getGuestByToken(token);
            u = {
              guestId: p.guestId,
              label: p.label,
              ws: null,
              telemetry: null,
              connectedAt: Date.now(),
              disconnectedAt: null,
            };
            users.set(token, u);
          }
          if (u.ws && u.ws !== ws) {
            try { u.ws.close(); } catch {}
          }
          u.ws = ws;
          u.disconnectedAt = null;
          const p = runtime.getGuestByToken(token);
          if (p) {
            p.connected = true;
            runtime.coordinator?.setConnected(p.guestId, true);
            runtime.coordinator?.touchLocation(p.guestId);
          }
        } else {
          const session = ensurePhoneSession(null);
          if (!session) return;
          token = session.token;
          const u = users.get(token);
          u.ws = ws;
        }

        send(ws, {
          type: 'welcome',
          token,
          guestId: users.get(token).guestId,
          label: label(token),
          serverTime: Date.now(),
          assets: currentAssets(),
          snapshot: phoneSnapshot(token),
        });
        sendRelaySync(token);
        sendRoster();
        return;
      }

      case 'ready': {
        // Phone has an unlocked AudioContext and preloaded assets. Replay
        // whatever it should already be hearing.
        const guest = runtime.getGuestByToken(token);
        if (guest) runtime.resyncCues(guest.guestId);
        return;
      }

      case 'input': {
        // A gesture on a phone. The show decides what it means; an unbound one
        // is not an error — most of the show asks for nothing.
        const guest = runtime.getGuestByToken(token);
        const kind = msg.event?.type;
        if (guest && kind) runtime.guestInput(guest.guestId, kind);
        return;
      }

      case 'ping':
        send(ws, { type: 'pong', t0: msg.t0, server: Date.now() });
        return;

      case 'telemetry': {
        const u = users.get(token);
        if (u) {
          u.telemetry = {
            offset: msg.offset,
            rtt: msg.rtt,
            jitter: msg.jitter,
            at: Date.now(),
          };
        }
        return;
      }

      case 'relay':
        if (!token) return;
        handleRelay(token, msg);
        return;

      case 'loadShow':
        if (isOperator) loadShow(msg.file);
        return;

      case 'startShow':
        if (!isOperator) return;
        runtime.start();
        sendRoster();
        return;

      case 'stopShow':
        if (!isOperator) return;
        runtime.stop();
        sendRoster();
        return;

      case 'setTimeScale': {
        if (!isOperator) return;
        const rate = runtime.setTimeScale(Number(msg.rate));
        if (rate != null) opLog(rate === 0 ? 'time paused' : `time scale ${rate}x`);
        sendRoster();
        return;
      }

      case 'configureWalkthrough': {
        if (!isOperator) return;
        runtime.walkthrough?.configure(msg.config ?? {});
        opLog(`walk settings: ${JSON.stringify(msg.config ?? {})}`);
        sendRoster();
        return;
      }

      case 'startWalkthrough': {
        if (!isOperator) return;
        runtime.walkthrough?.configure(msg.config ?? {});
        runtime.walkthrough?.start(msg.guestIds);
        opLog('walkthrough started');
        sendRoster();
        return;
      }

      case 'stopWalkthrough': {
        if (!isOperator) return;
        runtime.walkthrough?.stop(msg.guestIds);
        opLog('walkthrough stopped');
        sendRoster();
        return;
      }

      case 'activateForOccupant': {
        if (!isOperator) return;
        const result = runtime.activateForOccupant(msg.roomId);
        opLog(result.ok
          ? `${msg.roomId}: activated for ${runtime.guests.get(result.guestId)?.label ?? result.guestId}`
          : `${msg.roomId}: cannot activate — ${result.reason}`);
        sendRoster();
        return;
      }

      case 'sendRoomEvent': {
        if (!isOperator) return;
        if (runtime.sendRoomEvent(msg.roomId, msg.event)) {
          opLog(`${msg.roomId} ← ${msg.event}`);
          sendRoster();
        }
        return;
      }

      case 'removeGuest': {
        if (!isOperator) return;
        if (runtime.removeGuest(msg.guestId)) sendRoster();
        return;
      }

      case 'spawnGuest': {
        if (!isOperator) return;
        const count = Math.min(Math.max(1, Number(msg.count) || 1), 60);
        const spawnedIds = [];
        for (let i = 0; i < count; i++) {
          const spawned = runtime.spawnGuest({ label: count === 1 ? msg.label : undefined });
          if (!spawned) break;
          users.set(spawned.token, {
            guestId: spawned.guestId,
            label: spawned.label,
            ws: null,
            telemetry: null,
            connectedAt: Date.now(),
            disconnectedAt: null,
          });
          spawnedIds.push(spawned.guestId);
        }
        if (!spawnedIds.length) return;
        opLog(spawnedIds.length === 1
          ? `spawned 1 guest`
          : `spawned ${spawnedIds.length} guests`);
        if (msg.walk) runtime.walkthrough?.start(spawnedIds);
        sendRoster();
        return;
      }

      case 'setVirtualPosition': {
        if (!isOperator) return;
        const id = msg.guestId ?? msg.token;
        if (!id || typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
        if (runtime.setVirtualPosition(id, msg.x, msg.y)) sendRoster();
        return;
      }

      case 'setVirtualOccupancy': {
        if (!isOperator) return;
        const id = msg.guestId ?? msg.token;
        if (!id || !msg.occupancy) return;
        if (runtime.setVirtualOccupancy(id, msg.roomId ?? null, msg.occupancy)) sendRoster();
        return;
      }

      case 'requestActivation': {
        if (!isOperator) return;
        const id = msg.guestId ?? msg.token;
        if (!id || !msg.roomId) return;
        const result = runtime.requestActivation(id, msg.roomId);
        opLog(`activate ${msg.roomId} ← ${id}: ${result.ok ? result.state : result.reason}`);
        sendRoster();
        return;
      }

      case 'releaseRoomLock': {
        if (!isOperator || !msg.roomId) return;
        runtime.releaseRoomLock(msg.roomId, msg.guestId ?? null);
        sendRoster();
        return;
      }

      case 'clearOfflinePhones':
        if (isOperator) clearOfflinePhones();
        return;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (isOperator) {
      operators.delete(ws);
      return;
    }
    if (token && users.get(token)?.ws === ws) {
      const u = users.get(token);
      u.ws = null;
      u.disconnectedAt = Date.now();
      const p = runtime.getGuestByToken(token);
      if (p) {
        p.connected = false;
        runtime.coordinator?.setConnected(p.guestId, false);
      }
      notifyRelayPeerLeft(token);
      sendRoster();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log('DIM Machine — spatial runtime (v0.3 Phase A)');
  console.log(`  phone client:   http://localhost:${PORT}/`);
  console.log(`  operator panel: http://localhost:${PORT}/operator.html`);
  console.log(`  shows dir:      ${showsDir} (${listShows().join(', ') || 'empty'})`);
});
