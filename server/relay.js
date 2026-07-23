// Room-scoped peer relay — arbitrary channels + JSON payloads for custom pages.

const CHANNEL_RE = /^[a-zA-Z][a-zA-Z0-9._:-]{0,63}$/;
const MAX_PAYLOAD_BYTES = 8192;
const MIN_INTERVAL_MS = 1000 / 40; // ~40 msgs/sec per token per channel

/** roomKey → channel → userId → { from, payload, at } */
const persisted = new Map();
const rateLimits = new Map();

export function validateChannel(channel) {
  return typeof channel === 'string' && CHANNEL_RE.test(channel);
}

export function validatePayload(payload) {
  if (payload === null || payload === undefined) return true;
  try {
    return JSON.stringify(payload).length <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

export function audienceKey(runtime, token) {
  const zoneId = runtime.users.get(token)?.zoneId;
  return zoneId ?? '__show__';
}

export function audienceTokens(runtime, users, token) {
  const zoneId = runtime.users.get(token)?.zoneId;
  if (zoneId) {
    const members = runtime.rooms.get(zoneId)?.members;
    if (members?.size) return [...members];
  }
  return [...users.keys()].filter((t) => users.get(t)?.ws);
}

function roomStore(roomKey) {
  if (!persisted.has(roomKey)) persisted.set(roomKey, new Map());
  return persisted.get(roomKey);
}

export function persistEntry(roomKey, channel, userId, entry) {
  const room = roomStore(roomKey);
  if (!room.has(channel)) room.set(channel, new Map());
  const peers = room.get(channel);
  if (!entry) peers.delete(userId);
  else peers.set(userId, entry);
}

export function syncForRoom(roomKey) {
  const room = persisted.get(roomKey);
  if (!room) return {};
  const out = {};
  for (const [channel, peers] of room) {
    const list = [...peers.values()];
    if (list.length) out[channel] = list;
  }
  return out;
}

export function clearPeer(roomKey, userId) {
  const room = persisted.get(roomKey);
  if (!room) return [];
  const channels = [];
  for (const [channel, peers] of room) {
    if (peers.delete(userId)) channels.push(channel);
  }
  return channels;
}

export function checkRateLimit(token, channel) {
  const key = `${token}:${channel}`;
  const now = Date.now();
  const last = rateLimits.get(key) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return false;
  rateLimits.set(key, now);
  return true;
}

export function senderFrom(users, token, labelFn) {
  const u = users.get(token);
  return {
    userId: u?.userId ?? token.slice(0, 8),
    label: labelFn(token),
    token,
  };
}
