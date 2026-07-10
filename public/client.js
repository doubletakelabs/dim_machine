// DIM Machine — Phase 0 phone cue player.
// Responsibilities (spec §5.3): clock sync, asset preload, scheduled cue
// execution via Web Audio, telemetry, snapshot-based resume on reconnect.
'use strict';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Session token: localStorage + cookie (spec §7.1 belt-and-suspenders)
// ---------------------------------------------------------------------------
function getToken() {
  const ls = localStorage.getItem('dim.token');
  if (ls) return ls;
  const m = document.cookie.match(/(?:^|;\s*)dim\.token=([^;]+)/);
  return m ? m[1] : null;
}
function storeToken(t) {
  localStorage.setItem('dim.token', t);
  document.cookie = `dim.token=${t}; max-age=43200; path=/; samesite=lax`;
}

// ---------------------------------------------------------------------------
// Clock sync: NTP-style over the WebSocket. Keep the lowest-RTT samples,
// take the median offset, smooth changes.
// ---------------------------------------------------------------------------
const clock = {
  samples: [],      // { offset, rtt }
  offset: 0,        // serverTime ≈ Date.now() + offset
  rtt: 0,
  jitter: 0,
  synced: false,
  addSample(t0, server, t3) {
    const rtt = t3 - t0;
    const offset = server + rtt / 2 - t3;
    this.samples.push({ offset, rtt });
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
// Audio: preload + decode all assets; schedule against the AudioContext clock.
// ---------------------------------------------------------------------------
let ctx = null;
const buffers = new Map();   // assetId → AudioBuffer
const playing = new Map();   // assetId → { source, gainNode }
let joined = false;

async function preload(assets) {
  $('loading').style.display = 'block';
  await Promise.all(assets.map(async (id) => {
    if (buffers.has(id)) return;
    const res = await fetch(`assets/${id}`);
    buffers.set(id, await ctx.decodeAudioData(await res.arrayBuffer()));
  }));
  $('loading').style.display = 'none';
}

// Map a server timestamp to an AudioContext time.
function ctxTimeFor(serverTs) {
  const deltaMs = clock.toLocal(serverTs) - Date.now();
  return ctx.currentTime + deltaMs / 1000;
}

function playAudio(cue, { seekIntoLoop = false } = {}) {
  const buffer = buffers.get(cue.assetId);
  if (!buffer || !ctx) return;
  stopAudio(cue.assetId, 0); // one source per asset
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = !!cue.loop;
  const gainNode = ctx.createGain();
  gainNode.gain.value = cue.gain ?? 1;
  source.connect(gainNode).connect(ctx.destination);

  const nowServer = clock.serverNow();
  if (cue.startAt > nowServer) {
    const when = ctxTimeFor(cue.startAt);
    source.start(Math.max(when, ctx.currentTime));
    reportCueAt(cue, when);
  } else if (cue.loop && seekIntoLoop) {
    // Join-in-progress (spec §7.2.4): land where every other device is.
    const elapsed = ((nowServer - cue.startAt) / 1000) % buffer.duration;
    source.start(ctx.currentTime, elapsed);
  } else if (!cue.loop && nowServer - cue.startAt < 500) {
    source.start(); // marginally late one-shot: play immediately
  } else {
    return; // stale — skip (fallback: skip)
  }
  playing.set(cue.assetId, { source, gainNode });
}

function stopAudio(assetId, fadeMs = 0) {
  const targets = assetId === '*' ? [...playing.keys()] : [assetId];
  for (const id of targets) {
    const p = playing.get(id);
    if (!p) continue;
    playing.delete(id);
    if (fadeMs > 0) {
      p.gainNode.gain.setTargetAtTime(0, ctx.currentTime, fadeMs / 3000);
      setTimeout(() => { try { p.source.stop(); } catch {} }, fadeMs + 100);
    } else {
      try { p.source.stop(); } catch {}
    }
  }
}

// Report actual-vs-scheduled start so the operator can see drift (spec §6.6).
// For Web Audio the schedule is sample-accurate; the meaningful residual is
// how far the AudioContext-mapped start landed from the target wall time.
function reportCueAt(cue, ctxWhen) {
  const targetLocal = clock.toLocal(cue.startAt);
  const checkDelay = Math.max(0, targetLocal - Date.now());
  setTimeout(() => {
    const actualLocal = Date.now() + (ctxWhen - ctx.currentTime) * 1000;
    const drift = actualLocal - targetLocal;
    $('drift').textContent = `${drift.toFixed(1)}ms`;
    sendMsg({ type: 'cueReport', cueId: cue.cueId, targetAt: cue.startAt, actualAt: cue.startAt + drift });
  }, checkDelay + 50);
}

// Visual flash at startAt, driven by a rAF loop on the corrected clock.
function scheduleFlash(cue) {
  const el = $('flash');
  function tick() {
    const remaining = clock.toLocal(cue.startAt) - Date.now();
    if (remaining > 0) { requestAnimationFrame(tick); return; }
    if (remaining < -500) return; // stale
    el.style.transition = 'none';
    el.style.opacity = '1';
    const actual = Date.now();
    sendMsg({ type: 'cueReport', cueId: cue.cueId, targetAt: cue.startAt, actualAt: actual + clock.offset });
    setTimeout(() => {
      el.style.transition = 'opacity 400ms';
      el.style.opacity = '0';
    }, 120);
  }
  requestAnimationFrame(tick);
}

function runCue(cue, opts = {}) {
  switch (cue.kind) {
    case 'audio': playAudio(cue, opts); break;
    case 'stopAudio': stopAudio(cue.assetId ?? '*', cue.fadeMs ?? 0); break;
    case 'flash': scheduleFlash(cue); break;
    case 'synctest': scheduleFlash(cue); playAudio({ ...cue, kind: 'audio', assetId: 'click.wav' }); break;
  }
}

// ---------------------------------------------------------------------------
// WebSocket with reconnect + snapshot resync
// ---------------------------------------------------------------------------
let ws = null;
let reconnectDelay = 500;
let pingTimer = null;

function sendMsg(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 500;
    setConn(true);
    sendMsg({ type: 'hello', token: getToken() });
    // Clock sync: burst of 8 pings, then one every 4 s.
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
        $('label').textContent = msg.label;
        window.dimAssets = msg.assets;
        applySnapshot(msg.snapshot);
        break;
      case 'pong':
        clock.addSample(msg.t0, msg.server, Date.now());
        $('offset').textContent = `${clock.offset.toFixed(1)}ms`;
        $('rtt').textContent = `${clock.rtt.toFixed(0)}ms`;
        $('jitter').textContent = `${clock.jitter.toFixed(1)}ms`;
        sendMsg({ type: 'telemetry', offset: Math.round(clock.offset * 10) / 10, rtt: Math.round(clock.rtt), jitter: Math.round(clock.jitter * 10) / 10 });
        break;
      case 'state':
        setStateName(msg.state);
        break;
      case 'cue':
        if (joined) runCue(msg.cue);
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

let pendingSnapshot = null;
async function applySnapshot(snap) {
  setStateName(snap.state);
  if (!joined) { pendingSnapshot = snap; return; }
  await preload(window.dimAssets ?? []);
  for (const cue of snap.cues) runCue(cue, { seekIntoLoop: true });
}

let lastState = null;
function setStateName(state) {
  lastState = state;
  $('stateName').textContent = joined ? state : 'DIM MACHINE';
}

function setConn(ok) {
  $('connDot').className = 'dot' + (ok ? ' ok' : '');
  $('connText').textContent = ok ? 'connected' : 'reconnecting';
}

// ---------------------------------------------------------------------------
// Join: the user gesture that unlocks audio (iOS requirement) + preload
// ---------------------------------------------------------------------------
$('join').addEventListener('click', async () => {
  $('join').disabled = true;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  await preload(window.dimAssets ?? []);
  joined = true;
  $('join').style.display = 'none';
  if (lastState) setStateName(lastState);
  if (pendingSnapshot) {
    const snap = pendingSnapshot;
    pendingSnapshot = null;
    for (const cue of snap.cues) runCue(cue, { seekIntoLoop: true });
  }
});

connect();
