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
    case 'experience': openExperience(cue); break;
    case 'endExperience': closeExperience(); break;
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
// ---------------------------------------------------------------------------
// Input modes
//
// `gestures` is the show: discrete, recognised here, sent as one event, routed
// through inputBindings into the guest statechart. A swipe advances a screen.
//
// `stream` hands the surface to a room's experience — a wall, a projection, a
// piece with its own physics running on a machine in that room. Movement is
// reported continuously to *that* server, and the statechart hears none of it.
// It must not: a drag feeding a statechart would transition it sixty times a
// second.
//
// One at a time, because a 200px flick is otherwise both a `drag` stream and a
// terminal `swipe left`, and something fires twice.
// ---------------------------------------------------------------------------
let inputMode = 'gestures';
let experience = null;   // { ws, endpoint, driverId, hue, accepts }

const SWIPE_MIN_PX = 60;      // shorter than this is a slip, not a swipe
const SWIPE_MAX_MS = 900;     // slower than this is a drag
/**
 * A finger that stayed put is a tap, however long it rested there.
 *
 * There was a 400ms ceiling on this and it was wrong: told to TAP THE SCREEN,
 * people press deliberately, and a firm press is easily half a second. A guest
 * whose tap is rejected for being *too committed* has no way to know that, and
 * the only feedback available is a screen that refuses to move.
 */
const TAP_MAX_PX = 20;        // a fingertip wobbles; this is not a mouse
const GESTURE_MIN_GAP_MS = 400; // a nervous double-tap is one answer, not two

let lastGesture = 0;
function emitGesture(type, payload) {
  if (!joined) return;
  // Shown on the phone itself. A gesture that never left the handset and one
  // the show ignored look identical from the floor without this.
  const el = $('gesture');
  if (el) el.textContent = type;

  if (inputMode === 'stream') return sendToExperience({ t: type, ...payload });
  // The gap guard is for the statechart only: a nervous double-tap is one
  // answer to a screen. An experience wants every tap it is given.
  if (Date.now() - lastGesture < GESTURE_MIN_GAP_MS) return;
  lastGesture = Date.now();
  window.DIM.emit(type, payload);
}

function enableGestures() {
  let start = null;
  let lastTouchAt = 0;
  const begin = (x, y) => {
    // iOS will refuse to resume an AudioContext outside a user gesture, so every
    // touch is an opportunity worth taking whether or not it becomes a gesture.
    resumeAudio();
    start = { x, y, at: Date.now() };
    if (inputMode === 'stream') streamBegin(x, y);
  };
  const move = (x, y) => { if (inputMode === 'stream') streamMove(x, y); };
  const end = (x, y) => {
    if (inputMode === 'stream') streamEnd();
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
    } else if (dist <= TAP_MAX_PX) {
      emitGesture('tap', { x: Math.round(x), y: Math.round(y) });
    }
    // Anything else — a slow short drag — is a finger changing its mind.
  };

  // On `document`, not on the stage. A screen cue covers the viewport with a
  // fixed overlay that is the stage's *sibling*, so a tap on it never bubbles
  // through the stage — which made the listener deaf at exactly the moment a
  // tap matters. Anything that fills the screen from now on has the same shape,
  // so the listener belongs above all of them.
  const control = (e) => e.target?.closest?.('button, a, input, select, textarea');

  document.addEventListener('touchstart', (e) => {
    if (control(e)) return;
    const t = e.changedTouches[0];
    begin(t.clientX, t.clientY);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.changedTouches[0];
    move(t.clientX, t.clientY);
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    lastTouchAt = Date.now();
    if (control(e)) return;
    const t = e.changedTouches[0];
    end(t.clientX, t.clientY);
  }, { passive: true });

  // Mouse as well, so the browser client stays a usable rehearsal tool. A touch
  // on iOS also fires a synthetic mouse pair a beat later; ignore those rather
  // than counting one finger twice.
  const afterTouch = () => Date.now() - lastTouchAt < 700;
  document.addEventListener('mousedown', (e) => {
    if (afterTouch() || control(e)) return;
    begin(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', (e) => {
    if (afterTouch() || !start) return;
    move(e.clientX, e.clientY);
  });
  document.addEventListener('mouseup', (e) => {
    if (afterTouch() || control(e)) return;
    end(e.clientX, e.clientY);
  });
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
// The link to a room's experience
//
// A second socket, straight to the machine in that room. Deliberately not
// through the show server: a finger reports around sixty times a second, and a
// detour would be jitter bought for nothing. What the show *does* own is who
// may drive — it tells the room server, and hands us the matching secret.
// ---------------------------------------------------------------------------
function openExperience(cue) {
  if (experience?.endpoint === cue.endpoint && experience?.driverId === cue.driverId) return;
  closeExperience();

  const accepts = cue.inputs ?? null;
  const ws = new WebSocket(cue.endpoint);
  experience = { ws, endpoint: cue.endpoint, driverId: cue.driverId, hue: cue.hue, accepts };

  ws.onopen = () => {
    ws.send(JSON.stringify({
      t: 'hello', role: 'driver', driverId: cue.driverId, secret: cue.secret,
    }));
    setExperienceStatus('linked');
  };
  // No reconnect loop here. If the room server drops us the show will notice
  // and re-cue, or the guest has walked out and should not be driving anyway —
  // a phone reconnecting on its own to a wall in a room it has left is the
  // fault this avoids.
  ws.onclose = () => { if (experience?.ws === ws) setExperienceStatus('dropped'); };
  ws.onerror = () => setExperienceStatus('unreachable');

  inputMode = cue.inputMode ?? 'stream';
}

function closeExperience() {
  const link = experience;
  experience = null;
  inputMode = 'gestures';
  setExperienceStatus('–');
  try { link?.ws?.close(); } catch { /* already gone */ }
}

function sendToExperience(message) {
  const link = experience;
  if (!link || link.ws.readyState !== 1) return;
  // A piece declares what it consumes; sending it a hold it never asked for is
  // noise on a socket that is carrying a thumb.
  if (link.accepts && !link.accepts.includes(message.t)) return;
  link.ws.send(JSON.stringify(message));
}

function setExperienceStatus(text) {
  const el = $('link');
  if (el) el.textContent = text;
}

/**
 * Continuous movement, normalised to this phone's own screen so device size
 * drops out, and rAF-throttled so a fast finger cannot outrun a frame.
 */
const stream = { down: false, x: 0, y: 0, dx: 0, dy: 0, at: 0, vx: 0, vy: 0, queued: false };

function streamBegin(x, y) {
  stream.down = true;
  stream.x = x; stream.y = y;
  stream.dx = 0; stream.dy = 0;
  stream.vx = 0; stream.vy = 0;
  stream.at = Date.now();
}

function streamMove(x, y) {
  if (!stream.down) return;
  const now = Date.now();
  const dt = Math.max(1, now - stream.at);
  const dx = x - stream.x;
  const dy = y - stream.y;
  // Velocity in screens per second, measured here rather than derived at the
  // other end from a jittered stream.
  stream.vx = (dx / innerWidth) / (dt / 1000);
  stream.vy = (dy / innerHeight) / (dt / 1000);
  stream.x = x; stream.y = y; stream.at = now;
  stream.dx += dx; stream.dy += dy;
  if (stream.queued) return;
  stream.queued = true;
  requestAnimationFrame(() => {
    stream.queued = false;
    if (!stream.dx && !stream.dy) return;
    sendToExperience({ t: 'drag', dx: stream.dx / innerWidth, dy: stream.dy / innerHeight });
    stream.dx = 0; stream.dy = 0;
  });
}

function streamEnd() {
  if (!stream.down) return;
  stream.down = false;
  // Stale velocity means a finger that stopped before lifting, which is a
  // deliberate halt rather than a fling.
  const still = Date.now() - stream.at > 120;
  sendToExperience({ t: 'release', vx: still ? 0 : stream.vx, vy: still ? 0 : stream.vy });
}

// ---------------------------------------------------------------------------
// Keeping the screen awake
//
// A phone that sleeps mid-show is not a small annoyance: the AudioContext is
// suspended, the socket drops, and the guest has to be woken and resynced before
// they hear anything again. Everything about that recovery works, and none of it
// should ever have to run.
//
// Two mechanisms, because the good one is not available where this actually runs.
//
// `navigator.wakeLock` is the real API, and it needs a **secure context** — so it
// exists on localhost and over https, and is simply undefined on the
// `http://192.168.x.x` a phone uses on the venue wifi. Where it does exist, the
// OS releases the lock whenever the page is hidden, so it has to be taken again
// on every return to visibility.
//
// The fallback is the old trick: a muted, inline, looping video. iOS will not
// sleep while one is playing, and a *muted* video does not claim the audio
// session, so it cannot interfere with the show. 64×64 black, 1.8KB.
//
// Neither is as reliable as Auto-Lock: Never on a handset you issue and control.
// This is for the phones you did not set up.
// ---------------------------------------------------------------------------
let wakeLock = null;
let keepAwakeMode = 'off';

async function keepAwake() {
  if (navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      // Released by the OS on every hide, so it is retaken rather than assumed.
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      setKeepAwake('wakeLock');
      return;
    } catch (e) {
      console.warn('wakeLock refused', e);
    }
  }
  playKeepAwakeVideo();
}

function playKeepAwakeVideo() {
  const video = $('keepAwake');
  if (!video) return setKeepAwake('unavailable');
  video.play().then(() => setKeepAwake('video')).catch((e) => {
    console.warn('keep-awake video refused', e);
    setKeepAwake('unavailable');
  });
}

function setKeepAwake(mode) {
  keepAwakeMode = mode;
  const el = $('awake');
  if (el) el.textContent = mode === 'wakeLock' ? 'lock' : mode;
}

// ---------------------------------------------------------------------------
// Self-reported room — browser test mode
//
// There are no beacons yet, so the handset says where it is. That makes a real
// walkthrough possible with one person and no operator: carry the phone through
// the building, tell it which room you just entered, and the show responds as it
// will when BLE is telling it the same thing.
//
// Deliberately the same path a dragged dot takes, entry and exit holds included
// — a test that skipped the confirmation would not be testing the show.
// ---------------------------------------------------------------------------
function fillRoomPicker(rooms) {
  const select = $('roomPick');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">outside</option>'
    + rooms.map((r) => `<option value="${r.roomId}">${r.name}</option>`).join('');
  select.value = current;
}

$('roomPick')?.addEventListener('change', (e) => {
  sendMsg({ type: 'setRoom', roomId: e.target.value || null });
});

// ---------------------------------------------------------------------------
// Waking up
//
// A phone that slept lost two things at once, and either alone is silence.
//
// The AudioContext is suspended by the OS and does not come back on its own;
// every buffer source that was playing is dead with it. And the server has been
// reconciling against what this phone was last *told*, so it sees no difference
// and sends nothing — the phone is correct as far as anyone knows, and silent.
//
// Both are the same fix: resume the context, forget what we thought was playing,
// and ask to be told again. That is the reconnect path, which already works,
// pointed at a phone that never disconnected.
// ---------------------------------------------------------------------------
async function resumeAudio() {
  if (ctx?.state !== 'suspended') return;
  try { await ctx.resume(); } catch (e) { console.warn('resume failed', e); }
}

let lastResync = 0;
async function resync() {
  // A single wake can fire visibilitychange, pageshow and focus together, and
  // three resyncs in a row would restart the audio three times.
  if (!joined || Date.now() - lastResync < 1000) return;
  lastResync = Date.now();
  // The OS drops a screen lock every time the page is hidden. Retaking it here
  // rather than on its own listener keeps one path for "we just came back".
  if (!wakeLock) keepAwake();
  await resumeAudio();
  // Sources that died with the context cannot be stopped or restarted, and the
  // director is about to re-send everything. Drop them rather than leak them.
  stopAudio('*', 0);
  // The screen deliberately stays up: it is still correct, and blanking it while
  // the network comes back would be a black screen for no reason.
  sendMsg({ type: 'ready' });
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
window.addEventListener('pageshow', () => resync());
window.addEventListener('focus', () => resync());

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
    // A reconnect, not a first connect: the server has been reconciling against
    // what this phone was last told, so it will send nothing — and what we were
    // told is long dead. Ask for the whole picture again.
    if (joined) resync();
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
        fillRoomPicker(msg.rooms ?? []);
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
      case 'state': {
        lastState = msg.state;
        $('stateName').textContent = msg.state ?? '';
        // Reflect where the show thinks we are, so the picker cannot drift from
        // the truth after a reconnect or an operator moving us.
        const select = $('roomPick');
        const roomId = msg.state === 'outside' ? '' : String(msg.state).split(' ')[0];
        if (select && document.activeElement !== select) select.value = roomId;
        break;
      }
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
  await keepAwake();
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
