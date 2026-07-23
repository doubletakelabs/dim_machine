// Mock DIM APIs for page-preview — relay via WebSocket (/preview-relay).
'use strict';

(() => {
  const params = new URLSearchParams(location.search);
  const phoneId = params.get('u') ?? '1';
  const TOKEN = `preview-${phoneId}`;
  const USER_ID = `preview-u-${phoneId}`;
  const LABEL = `Phone ${phoneId}`;

  const relayHandlers = new Map();
  const relayCache = new Map();
  const pendingSends = [];

  function rememberRelay(msg) {
    if (!msg.channel || !msg.from) return;
    if (!relayCache.has(msg.channel)) relayCache.set(msg.channel, new Map());
    const peers = relayCache.get(msg.channel);
    if (msg.payload == null) peers.delete(msg.from.userId);
    else peers.set(msg.from.userId, msg);
  }

  function dispatchRelay(msg) {
    rememberRelay(msg);
    const handlers = relayHandlers.get(msg.channel);
    if (!handlers?.size) return;
    for (const fn of [...handlers]) {
      try { fn(msg); } catch (err) { console.warn(err); }
    }
  }

  function applyRelaySync(channels) {
    for (const [channel, entries] of Object.entries(channels ?? {})) {
      for (const entry of entries) {
        dispatchRelay({
          type: 'relay',
          channel,
          from: entry.from,
          payload: entry.payload,
          at: entry.at,
          self: entry.from?.token === TOKEN,
        });
      }
    }
  }

  function replayChannel(channel, fn) {
    for (const msg of relayCache.get(channel)?.values() ?? []) {
      try {
        fn({ ...msg, self: msg.from?.token === TOKEN });
      } catch (err) { console.warn(err); }
    }
  }

  const { registerPage, pageAsset } = window.DIM;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/preview-relay`);

  window.DIM = {
    vars: {},
    self: { userId: USER_ID, label: LABEL, token: TOKEN },
    emit(type, payload) {
      console.log('[preview emit]', type, payload ?? {});
    },
    relay: {
      send(channel, payload, opts = {}) {
        const raw = JSON.stringify({
          type: 'relay',
          channel,
          payload,
          persist: opts.persist !== false,
        });
        if (ws.readyState === 1) ws.send(raw);
        else pendingSends.push(raw);
      },
      on(channel, fn) {
        if (!relayHandlers.has(channel)) relayHandlers.set(channel, new Set());
        relayHandlers.get(channel).add(fn);
        replayChannel(channel, fn);
        return () => relayHandlers.get(channel)?.delete(fn);
      },
      off(channel, fn) {
        relayHandlers.get(channel)?.delete(fn);
      },
    },
    registerPage,
    pageAsset,
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', u: phoneId }));
    for (const raw of pendingSends) ws.send(raw);
    pendingSends.length = 0;
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'relay') dispatchRelay(msg);
    if (msg.type === 'relaySync') applyRelaySync(msg.channels);
  };

  ws.onclose = () => {
    const banner = document.getElementById('banner');
    if (banner) {
      const note = document.createElement('span');
      note.style.color = '#e74c3c';
      note.textContent = 'relay disconnected — refresh';
      banner.appendChild(note);
    }
  };
})();
