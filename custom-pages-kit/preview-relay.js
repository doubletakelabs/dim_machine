// WebSocket relay for page-preview.html (multi-tab / multi-device dev testing).
import { WebSocketServer } from 'ws';

const PREVIEW_ROOM = '__preview__';
const CHANNEL_RE = /^[a-zA-Z][a-zA-Z0-9._:-]{0,63}$/;
const MAX_PAYLOAD_BYTES = 8192;
const MIN_INTERVAL_MS = 1000 / 40;

/** roomKey → channel → userId → entry */
const persisted = new Map();
const rateLimits = new Map();

function validateChannel(channel) {
  return typeof channel === 'string' && CHANNEL_RE.test(channel);
}

function validatePayload(payload) {
  if (payload === null || payload === undefined) return true;
  try {
    return JSON.stringify(payload).length <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function roomStore(roomKey) {
  if (!persisted.has(roomKey)) persisted.set(roomKey, new Map());
  return persisted.get(roomKey);
}

function persistEntry(roomKey, channel, userId, entry) {
  const room = roomStore(roomKey);
  if (!room.has(channel)) room.set(channel, new Map());
  const peers = room.get(channel);
  if (!entry) peers.delete(userId);
  else peers.set(userId, entry);
}

function syncForRoom(roomKey) {
  const room = persisted.get(roomKey);
  if (!room) return {};
  const out = {};
  for (const [channel, peers] of room) {
    const list = [...peers.values()];
    if (list.length) out[channel] = list;
  }
  return out;
}

function clearPeer(roomKey, userId) {
  const room = persisted.get(roomKey);
  if (!room) return [];
  const channels = [];
  for (const [channel, peers] of room) {
    if (peers.delete(userId)) channels.push(channel);
  }
  return channels;
}

function checkRateLimit(token, channel) {
  const key = `${token}:${channel}`;
  const now = Date.now();
  const last = rateLimits.get(key) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return false;
  rateLimits.set(key, now);
  return true;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/** @param {import('node:http').Server} httpServer */
export function attachPreviewRelay(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/preview-relay' });
  /** @type {Map<import('ws').WebSocket, { userId: string, label: string, token: string }>} */
  const clients = new Map();

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.type === 'hello') {
        const u = String(msg.u ?? '1');
        const client = {
          userId: `preview-u-${u}`,
          label: `Phone ${u}`,
          token: `preview-${u}`,
        };
        clients.set(ws, client);
        send(ws, { type: 'relaySync', channels: syncForRoom(PREVIEW_ROOM) });
        return;
      }

      if (msg.type !== 'relay') return;
      const client = clients.get(ws);
      if (!client) return;

      const { channel, payload, persist } = msg;
      if (!validateChannel(channel) || !validatePayload(payload)) return;
      if (!checkRateLimit(client.token, channel)) return;

      const from = { userId: client.userId, label: client.label, token: client.token };
      const at = Date.now();
      const envelope = { type: 'relay', channel, from, payload, at };

      if (persist !== false && payload != null) {
        persistEntry(PREVIEW_ROOM, channel, from.userId, { from, payload, at });
      } else if (payload === null) {
        persistEntry(PREVIEW_ROOM, channel, from.userId, null);
      }

      for (const [peerWs, peer] of clients) {
        send(peerWs, { ...envelope, self: peer.token === client.token });
      }
    });

    ws.on('close', () => {
      const client = clients.get(ws);
      if (!client) return;
      clients.delete(ws);
      const channels = clearPeer(PREVIEW_ROOM, client.userId);
      if (!channels.length) return;
      const at = Date.now();
      const from = { userId: client.userId, label: client.label, token: client.token };
      for (const channel of channels) {
        for (const [peerWs] of clients) {
          send(peerWs, { type: 'relay', channel, from, payload: null, at, self: false });
        }
      }
    });
  });

  return wss;
}
