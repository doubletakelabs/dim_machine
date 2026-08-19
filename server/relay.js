// Room-scoped peer relay — arbitrary channels + JSON payloads for custom pages.

const CHANNEL_RE = /^[a-zA-Z][a-zA-Z0-9._:-]{0,63}$/;
const MAX_PAYLOAD_BYTES = 8192;
const MIN_INTERVAL_MS = 1000 / 40;

/** roomKey → channel → guestId → { from, payload, at } */
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
  // Peers are scoped to a room, not a zone — a room may own several zones and
  // moving between them must not split the audience.
  const roomId = runtime.getGuestRoomId(token);
  return roomId ?? '__show__';
}

export function audienceTokens(runtime, users, token) {
  const roomId = runtime.getGuestRoomId(token);
  if (roomId) {
    const members = runtime.getRoomMemberTokens(roomId);
    if (members.length) return members;
  }
  return [...users.keys()].filter((t) => users.get(t)?.ws);
}

function roomStore(roomKey) {
  if (!persisted.has(roomKey)) persisted.set(roomKey, new Map());
  return persisted.get(roomKey);
}

export function persistEntry(roomKey, channel, guestId, entry) {
  const room = roomStore(roomKey);
  if (!room.has(channel)) room.set(channel, new Map());
  const peers = room.get(channel);
  if (!entry) peers.delete(guestId);
  else peers.set(guestId, entry);
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

export function clearPeer(roomKey, guestId) {
  const room = persisted.get(roomKey);
  if (!room) return [];
  const channels = [];
  for (const [channel, peers] of room) {
    if (peers.delete(guestId)) channels.push(channel);
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
    guestId: u?.guestId ?? 'unknown',
    label: labelFn(token),
    token,
  };
}
