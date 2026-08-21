// DIM Machine — Phase 1 phone cue player.
// Clock sync, asset preload (audio + video), scheduled cue execution,
// interactive pages (pages.js), input promotion, snapshot resume.
'use strict';

const $ = (id) => document.getElementById(id);

// Shared surface for pages.js: input emission + display-variable store + peer relay.
const relayHandlers = new Map(); // channel → Set<fn>
/** channel → userId → last relay msg */
const relayCache = new Map();

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
    try { fn(msg); } catch (err) { console.warn('relay handler error:', err); }
  }
}

function replayChannel(channel, fn) {
  for (const msg of relayCache.get(channel)?.values() ?? []) {
    try {
      fn({ ...msg, self: msg.from?.token === getToken() });
    } catch (err) { console.warn('relay handler error:', err); }
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
        self: entry.from?.token === getToken(),
      });
    }
  }
}

const pageLoaderApis = {
  registerPage: window.DIM?.registerPage,
  pageAsset: window.DIM?.pageAsset,
};

window.DIM = {
  vars: {},
  self: { userId: null, label: null, token: null },
  /** Promote an interaction to the show state machine (canonical input events). */
  emit(type, payload) {
    sendMsg({ type: 'input', event: { type, payload: payload ?? {} } });
  },
  /**
   * Peer relay — arbitrary channels + JSON payloads, room-scoped fan-out.
   * Does not touch the state machine. See custom-pages-kit/CUSTOM-PAGES.md.
   */
  relay: {
    send(channel, payload, opts = {}) {
      sendMsg({
        type: 'relay',
        channel,
        payload,
        persist: opts.persist !== false,
      });
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
  registerPage: pageLoaderApis.registerPage,
  pageAsset: pageLoaderApis.pageAsset,
};

// ---------------------------------------------------------------------------
// Session token (spec §7.1)
// ---------------------------------------------------------------------------
// `?u=<n>` namespaces the token so multiple tabs on one browser act as
// separate phones (local testing only; real devices don't need it).
const TOKEN_KEY = 'dim.token' + (new URLSearchParams(location.search).get('u') ?? '');
function getToken() {
  const ls = localStorage.getItem(TOKEN_KEY);
  if (ls) return ls;
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${TOKEN_KEY}=([^;]+)`));
  return m ? m[1] : null;
}
function storeToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
  document.cookie = `${TOKEN_KEY}=${t}; max-age=43200; path=/; samesite=lax`;
}

// ---------------------------------------------------------------------------
// Clock sync (NTP-style, lowest-RTT median, smoothed)
// ---------------------------------------------------------------------------
const clock = {
  samples: [], offset: 0, rtt: 0, jitter: 0, synced: false,
  addSample(t0, server, t3) {
    const rtt = t3 - t0;
    this.samples.push({ offset: server + rtt / 2 - t3, rtt });
    if (this.samples.length > 40) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt)
      .slice(0, Math.max(3, Math.floor(this.samples.length / 2)));
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
    const median = offsets[Math.floor(offsets.length / 2)];
    this.offset = this.synced ? this.offset + 0.3 * (median - this.offset) : median;
    this.rtt = Math.min(...best.map((s) => s.rtt));
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    this.jitter = Math.sqrt(offsets.reduce((a, o) => a + (o - mean) ** 2, 0) / offsets.length);
    this.synced = true;
  },
  serverNow() { return Date.now() + this.offset; },
  toLocal(serverTs) { return serverTs - this.offset; },
};

// ---------------------------------------------------------------------------
// Assets: audio decoded to buffers, video fetched to blob URLs
// ---------------------------------------------------------------------------
let ctx = null;
const audioBuffers = new Map();
const videoBlobs = new Map();
const imageUrls = new Map();
const playing = new Map(); // assetId → { source, gainNode, timer? }
const stopping = new Map(); // assetId → same, while fading out
let joined = false;
let assetList = [];

const isVideoAsset = (id) => /\.(mp4|webm|mov|m4v)$/i.test(id);
const isImageAsset = (id) => /\.(png|jpe?g|webp|gif|avif)$/i.test(id);

/** Where a loaded asset of each kind lands, so `preload` stays one loop. */
function assetStore(id) {
  if (isVideoAsset(id)) return videoBlobs;
  if (isImageAsset(id)) return imageUrls;
  return audioBuffers;
}

async function preload(assets) {
  const missing = assets.filter((id) => !assetStore(id).has(id));
  if (!missing.length) return;
  $('loading').style.display = 'block';
  await Promise.all(missing.map(async (id) => {
    try {
      const res = await fetch(`assets/${id}`);
      if (!res.ok) throw new Error(res.status);
      // Images and video become blob URLs so showing one is never a network
      // round trip — a screen that arrives a beat after its narration reads as
      // a fault, and in a dark room it is the only thing the guest can see.
      if (isVideoAsset(id) || isImageAsset(id)) {
        assetStore(id).set(id, URL.createObjectURL(await res.blob()));
      } else {
        audioBuffers.set(id, await ctx.decodeAudioData(await res.arrayBuffer()));
      }
    } catch (e) { console.warn('asset failed:', id, e); }
  }));
  $('loading').style.display = 'none';
}

function ctxTimeFor(serverTs) {
  return ctx.currentTime + (clock.toLocal(serverTs) - Date.now()) / 1000;
}

// ---------------------------------------------------------------------------
// Cue execution
// ---------------------------------------------------------------------------
function playAudio(cue, { seekIntoLoop = false } = {}) {
  const buffer = audioBuffers.get(cue.assetId);
  if (!buffer || !ctx) return;
  stopAudio(cue.assetId, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = !!cue.loop;
  const gainNode = ctx.createGain();
  gainNode.gain.value = cue.gain ?? 1;
  source.connect(gainNode).connect(ctx.destination);

  // A cue may name a slice of a longer file rather than the whole of it, so one
  // recording can carry a sequence the guest paces themselves through. Every
  // position below is relative to `base`, and `span` is the wall it stops at.
  const base = cue.offset ?? 0;
  const span = cue.duration != null
    ? Math.min(cue.duration, Math.max(0, buffer.duration - base))
    : Math.max(0, buffer.duration - base);
  if (span <= 0) return;
  if (source.loop) {
    // `duration` on start() would end the source rather than wrap it, so a
    // looping segment has to be bounded by the loop points instead.
    source.loopStart = base;
    source.loopEnd = base + span;
  }
  const play = (when, into = 0) => {
    if (source.loop) return source.start(when, base + into);
    if (cue.duration != null || base > 0) return source.start(when, base + into, span - into);
    return source.start(when, into);
  };

  const nowServer = clock.serverNow();
  if (cue.startAt > nowServer) {
    const when = ctxTimeFor(cue.startAt);
    play(Math.max(when, ctx.currentTime));
    reportCueAt(cue, when);
  } else if (cue.seek || (cue.loop && seekIntoLoop)) {
    // Walked in halfway through: join the content where it actually is rather
    // than starting it over. A one-shot that already finished is simply missed.
    const elapsed = (nowServer - cue.startAt) / 1000;
    if (!cue.loop && elapsed >= span) return;
    play(ctx.currentTime, cue.loop ? elapsed % span : Math.max(0, elapsed));
  } else if (nowServer - cue.startAt < 500) {
    play(ctx.currentTime);
  } else {
    return; // stale one-shot: skip
  }
  playing.set(cue.assetId, { source, gainNode });
}

function stopAudio(assetId, fadeMs = 0) {
  const targets = assetId === '*'
    ? [...new Set([...playing.keys(), ...stopping.keys()])]
    : [assetId];
  for (const id of targets) stopOneAudio(id, fadeMs);
}

function stopOneAudio(id, fadeMs) {
  const p = playing.get(id) || stopping.get(id);
  if (!p) return;
  playing.delete(id);
  if (p.timer) clearTimeout(p.timer);
  const finish = () => {
    try { p.source.stop(); } catch {}
    try { p.source.disconnect(); } catch {}
    try { p.gainNode.disconnect(); } catch {}
    stopping.delete(id);
  };
  if (fadeMs > 0 && ctx) {
    p.gainNode.gain.cancelScheduledValues(ctx.currentTime);
    p.gainNode.gain.setValueAtTime(p.gainNode.gain.value, ctx.currentTime);
    p.gainNode.gain.setTargetAtTime(0, ctx.currentTime, fadeMs / 3000);
    p.timer = setTimeout(finish, fadeMs + 100);
    stopping.set(id, p);
  } else {
    finish();
  }
}

function playVideo(cue, { joinInProgress = false } = {}) {
  const src = videoBlobs.get(cue.assetId);
  if (!src) return;
  const overlay = $('videoOverlay');
  const video = overlay.querySelector('video');
  video.src = src;
  video.loop = !!cue.loop;
  overlay.style.display = 'flex';
  const begin = () => {
    if (joinInProgress && video.duration) {
      const elapsed = (clock.serverNow() - cue.startAt) / 1000;
      video.currentTime = cue.loop ? elapsed % video.duration : Math.min(elapsed, video.duration);
    }
    video.play().catch((e) => console.warn('video play failed', e));
  };
  const delay = clock.toLocal(cue.startAt) - Date.now();
  if (delay > 20) setTimeout(begin, delay);
  else begin();
  video.onended = cue.loop ? null : () => {
    hideVideo();
    window.DIM.emit('video.ended', { assetId: cue.assetId });
  };
}

function hideVideo() {
  const overlay = $('videoOverlay');
  const video = overlay.querySelector('video');
  video.pause();
  video.removeAttribute('src');
  overlay.style.display = 'none';
}

/**
 * The screen slot. One image at a time, held until the director replaces or
 * clears it — a screen is a state the guest is in, not a thing that flashes.
 */
function showImage(cue) {
  const src = imageUrls.get(cue.assetId);
  if (!src) return;
  const overlay = $('imageOverlay');
  overlay.querySelector('img').src = src;
  overlay.style.display = 'block';
  shownImage = cue.assetId;
}

function clearImage(assetId) {
  // A stale clear for an image already replaced would blank the new one.
  if (assetId && shownImage && assetId !== shownImage) return;
  const overlay = $('imageOverlay');
  overlay.style.display = 'none';
  overlay.querySelector('img').removeAttribute('src');
  shownImage = null;
}
let shownImage = null;

function showPage(cue) {
  hideVideo();
  currentPage = { page: cue.page, props: cue.props ?? {} };
  return window.DIM_PAGES.render($('page'), currentPage.page, currentPage.props);
}
let currentPage = null;

function setVar(key, value) {
  window.DIM.vars[key] = value;
  if (currentPage) return window.DIM_PAGES.render($('page'), currentPage.page, currentPage.props);
}

function haptic(pattern) {
  try { navigator.vibrate?.(pattern); } catch {}
}

function reportCueAt(cue, ctxWhen) {
  const targetLocal = clock.toLocal(cue.startAt);
  setTimeout(() => {
    const actualLocal = Date.now() + (ctxWhen - ctx.currentTime) * 1000;
    const drift = actualLocal - targetLocal;
    $('drift').textContent = `${drift.toFixed(1)}ms`;
    sendMsg({ type: 'cueReport', cueId: cue.cueId, targetAt: cue.startAt, actualAt: cue.startAt + drift });
  }, Math.max(0, targetLocal - Date.now()) + 50);
}

function scheduleFlash(cue) {
  const el = $('flash');
  (function tick() {
    const remaining = clock.toLocal(cue.startAt) - Date.now();
    if (remaining > 0) return requestAnimationFrame(tick);
    if (remaining < -500) return;
    el.style.transition = 'none';
    el.style.opacity = '1';
    sendMsg({ type: 'cueReport', cueId: cue.cueId, targetAt: cue.startAt, actualAt: Date.now() + clock.offset });
    setTimeout(() => { el.style.transition = 'opacity 400ms'; el.style.opacity = '0'; }, 120);
  })();
}

function runCue(cue, opts = {}) {
  switch (cue.kind) {
    case 'audio': playAudio(cue, opts); break;
    case 'stopAudio': stopAudio(cue.assetId ?? '*', cue.fadeMs ?? 0); break;
    case 'video': playVideo(cue, { joinInProgress: !!opts.seekIntoLoop }); break;
    case 'image': showImage(cue); break;
    case 'clearImage': clearImage(cue.assetId); break;
    case 'page': showPage(cue); break;
    case 'haptic': haptic(cue.pattern ?? [200]); break;
    case 'setVar': setVar(cue.key, cue.value); break;
    case 'flash': scheduleFlash(cue); break;
    case 'synctest': scheduleFlash(cue); playAudio({ ...cue, kind: 'audio', assetId: 'click.wav' }); break;
  }
}

// ---------------------------------------------------------------------------
// Touch gestures
//
// Reported raw. The phone says what the finger did and nothing about what it
// means — `inputBindings` in the show turns a tap into an event, so the same
// gesture can advance calibration here and do something else three rooms later
// without this file knowing either.
// ---------------------------------------------------------------------------
const SWIPE_MIN_PX = 60;      // shorter than this is a slip, not a swipe
const SWIPE_MAX_MS = 800;     // slower than this is a drag
const TAP_MAX_PX = 12;
const TAP_MAX_MS = 400;
const GESTURE_MIN_GAP_MS = 400; // a nervous double-tap is one answer, not two

let lastGesture = 0;
function emitGesture(type, payload) {
  if (!joined || Date.now() - lastGesture < GESTURE_MIN_GAP_MS) return;
  lastGesture = Date.now();
  window.DIM.emit(type, payload);
}

function enableGestures() {
  const stage = $('stage');
  let start = null;
  const begin = (x, y) => { start = { x, y, at: Date.now() }; };
  const end = (x, y) => {
    if (!start) return;
    const { x: x0, y: y0, at } = start;
    start = null;
    const dx = x - x0;
    const dy = y - y0;
    const dist = Math.hypot(dx, dy);
    const ms = Date.now() - at;
    if (dist >= SWIPE_MIN_PX && ms <= SWIPE_MAX_MS) {
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      emitGesture('swipe', {
        direction: horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'),
        dx: Math.round(dx),
        dy: Math.round(dy),
      });
    } else if (dist <= TAP_MAX_PX && ms <= TAP_MAX_MS) {
      emitGesture('tap', { x: Math.round(x), y: Math.round(y) });
    }
  };

  stage.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    begin(t.clientX, t.clientY);
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    end(t.clientX, t.clientY);
  }, { passive: true });
  // Mouse as well, so the browser client stays a usable rehearsal tool.
  stage.addEventListener('mousedown', (e) => begin(e.clientX, e.clientY));
  stage.addEventListener('mouseup', (e) => end(e.clientX, e.clientY));
}

// ---------------------------------------------------------------------------
// Shake detection (throttled; iOS needs permission, requested on Join)
// ---------------------------------------------------------------------------
let lastShake = 0;
function enableShake() {
  window.addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
    if (mag > 25 && Date.now() - lastShake > 1000) {
      lastShake = Date.now();
      window.DIM.emit('shake');
    }
  });
}

// ---------------------------------------------------------------------------
// WebSocket + snapshot resync
// ---------------------------------------------------------------------------
let ws = null;
let reconnectDelay = 500;
let pingTimer = null;
let pendingSnapshot = null;
let lastState = null;

function sendMsg(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 500;
    setConn(true);
    sendMsg({ type: 'hello', token: getToken() });
    clearInterval(pingTimer);
    let burst = 8;
    const ping = () => sendMsg({ type: 'ping', t0: Date.now() });
    const burstTimer = setInterval(() => { ping(); if (--burst <= 0) clearInterval(burstTimer); }, 150);
    pingTimer = setInterval(ping, 4000);
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'welcome':
        storeToken(msg.token);
        window.DIM.self = {
          userId: msg.userId ?? msg.token?.slice(0, 8),
          label: msg.label,
          token: msg.token,
        };
        $('label').textContent = msg.label;
        assetList = msg.assets ?? [];
        applySnapshot(msg.snapshot);
        break;
      case 'assets':
        assetList = msg.assets ?? [];
        if (joined) await preload(assetList);
        break;
      case 'pong':
        clock.addSample(msg.t0, msg.server, Date.now());
        $('offset').textContent = `${clock.offset.toFixed(1)}ms`;
        $('rtt').textContent = `${clock.rtt.toFixed(0)}ms`;
        sendMsg({ type: 'telemetry', offset: Math.round(clock.offset * 10) / 10, rtt: Math.round(clock.rtt), jitter: Math.round(clock.jitter * 10) / 10 });
        break;
      case 'state':
        lastState = msg.state;
        $('stateName').textContent = msg.state ?? '';
        break;
      case 'cue':
        if (joined) runCue(msg.cue);
        break;
      case 'relay':
        dispatchRelay(msg);
        break;
      case 'relaySync':
        if (joined) applyRelaySync(msg.channels);
        break;
    }
  };

  ws.onclose = () => {
    setConn(false);
    clearInterval(pingTimer);
    setTimeout(connect, reconnectDelay + Math.random() * 300);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };
  ws.onerror = () => ws.close();
}

async function applySnapshot(snap) {
  lastState = snap.state;
  $('stateName').textContent = snap.state ?? '';
  if (!joined) { pendingSnapshot = snap; return; }
  await preload(assetList);
  await restoreFromSnapshot(snap);
}

function restoreFromSnapshot(snap) {
  Object.assign(window.DIM.vars, snap.displayVars ?? {});
  const pagePromise = snap.page
    ? showPage({ kind: 'page', ...snap.page })
    : Promise.resolve();
  return pagePromise.then(async () => {
    for (const cue of snap.cues ?? []) runCue(cue, { seekIntoLoop: true });
    applyRelaySync(snap.relay);
  });
}

function setConn(ok) {
  $('connDot').className = 'dot' + (ok ? ' ok' : '');
  $('connText').textContent = ok ? 'connected' : 'reconnecting';
}

// ---------------------------------------------------------------------------
// Join: user gesture unlocks audio + motion permission, then preload
// ---------------------------------------------------------------------------
$('join').addEventListener('click', async () => {
  $('join').disabled = true;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  try {
    if (typeof DeviceMotionEvent?.requestPermission === 'function')
      await DeviceMotionEvent.requestPermission();
  } catch {}
  enableShake();
  enableGestures();
  await preload(assetList);
  joined = true;
  // The server has been reconciling audio for this guest all along; until now we
  // had no AudioContext to play it. Ask for a resend rather than start deaf.
  sendMsg({ type: 'ready' });
  $('joinScreen').style.display = 'none';
  window.DIM_PAGES.render($('page'), 'waiting', { title: 'Waiting for the show…' });
  if (pendingSnapshot) {
    const snap = pendingSnapshot;
    pendingSnapshot = null;
    await restoreFromSnapshot(snap);
  }
});

connect();
