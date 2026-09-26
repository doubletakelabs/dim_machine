// DIM Machine — Phase 1 phone cue player.
// Clock sync, asset preload (audio + video), scheduled cue execution,
// input promotion, snapshot resume.
'use strict';

import { createGestureRecogniser, createRepeatGuard } from './gestures.js';
import { createClock } from './clock-sync.js';
import { planAudio } from './cue-plan.js';
import { mixerConfig, duckDecision, voiceEndsAt } from './mixer.js';

const $ = (id) => document.getElementById(id);

// Shared surface for anything running on the phone: input emission + peer relay.
const relayHandlers = new Map(); // channel → Set<fn>
/** channel → guestId → last relay msg */
const relayCache = new Map();

function rememberRelay(msg) {
  if (!msg.channel || !msg.from) return;
  if (!relayCache.has(msg.channel)) relayCache.set(msg.channel, new Map());
  const peers = relayCache.get(msg.channel);
  // Keyed by guestId — the participant→guest rename reached here late, and
  // while it read `from.userId` every peer collapsed onto one undefined key.
  if (msg.payload == null) peers.delete(msg.from.guestId);
  else peers.set(msg.from.guestId, msg);
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

window.DIM = {
  self: { guestId: null, label: null, token: null },
  /** Promote an interaction to the show state machine (canonical input events). */
  emit(type, payload) {
    sendMsg({ type: 'input', event: { type, payload: payload ?? {} } });
  },
  /**
   * Peer relay — arbitrary channels + JSON payloads, room-scoped fan-out.
   * Does not touch the state machine.
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
};

// ---------------------------------------------------------------------------
// The Android app (dim_android_app)
//
// On the show handsets this page runs inside a WebView, and the app's beacon
// scanner has to speak for the same guest this page joined as. It cannot open a
// socket of its own: a second connection with this token would displace this
// one, and the two would flap. So the app sends through ours, and this page
// tells it each time it (re)joins — the app answers by re-sending where it is,
// because a fresh socket means the server knows nothing.
//
// `window.DIMNative` is injected by the app before any script runs; in a
// browser it is undefined and none of this does anything.
// ---------------------------------------------------------------------------
const nativeApp = window.DIMNative ?? null;

/** Message types the app may send on this guest's behalf. */
const NATIVE_TYPES = new Set(['location', 'door']);

window.DIM.native = {
  present: !!nativeApp,
  /** Called by the app with a JSON-serialisable message. */
  send(msg) {
    if (!msg || !NATIVE_TYPES.has(msg.type)) return false;
    sendMsg(msg);
    return ws?.readyState === 1;
  },
};

function nativeStatus() {
  try { return JSON.parse(nativeApp.status()); } catch { return undefined; }
}

function tellNative(method, ...args) {
  try { nativeApp?.[method]?.(...args); } catch (e) { console.warn('native bridge', method, e); }
}

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
// Clock sync — the estimator lives in clock-sync.js, where it has tests.
// ---------------------------------------------------------------------------
const clock = createClock();

// ---------------------------------------------------------------------------
// Assets: audio decoded to buffers, video fetched to blob URLs
// ---------------------------------------------------------------------------
let ctx = null;
const audioBuffers = new Map();
const videoBlobs = new Map();
const imageUrls = new Map();
const playing = new Map(); // assetId → { source, gainNode, timer? }
const stopping = new Map(); // assetId → same, while fading out

// ---------------------------------------------------------------------------
// The mixer. Decisions live in mixer.js, where they have tests; this block
// owns only the gain nodes the decisions are carried out with. The room bed
// routes through one shared bus so a spoken line in `guidance`/`adherence`
// can duck it without touching the bed's own cue gain, and release it to
// exactly where it was.
// ---------------------------------------------------------------------------
let mixer = mixerConfig(null); // retuned by the show on welcome
let roomBus = null;            // GainNode the `room` slot plays through
const voices = new Map();      // assetId → endsAt (server ms, null = loop)
let duckTimer = null;
const VOICE_SLOTS = new Set(['guidance', 'adherence']);

/** Debug readout for the harness and a person with a console. */
window.DIM.mixerState = () => ({
  bus: roomBus ? Math.round(roomBus.gain.value * 1000) / 1000 : null,
  voices: voices.size,
  playing: [...playing.keys()],
  config: mixer,
});

function busFor(slot) {
  if (slot !== 'room' || !ctx) return ctx?.destination ?? null;
  if (!roomBus) {
    roomBus = ctx.createGain();
    roomBus.connect(ctx.destination);
  }
  return roomBus;
}

/** Bring the room bus in line with who is speaking. Safe to call anytime. */
function applyDuck() {
  clearTimeout(duckTimer);
  duckTimer = null;
  const now = clock.serverNow();
  for (const [id, endsAt] of voices) if (endsAt != null && endsAt <= now) voices.delete(id);
  const { ducked, nextCheckAt } = duckDecision([...voices.values()].map((endsAt) => ({ endsAt })), now);
  if (roomBus && ctx) {
    const target = ducked ? mixer.duckTo : 1;
    roomBus.gain.cancelScheduledValues(ctx.currentTime);
    roomBus.gain.setValueAtTime(roomBus.gain.value, ctx.currentTime);
    // setTargetAtTime reaches ~95% of the way in 3 time-constants, so /3000
    // makes duckMs the audible length of the move — same idiom as the fades.
    roomBus.gain.setTargetAtTime(target, ctx.currentTime, Math.max(0.001, mixer.duckMs / 3000));
  }
  if (nextCheckAt != null) {
    duckTimer = setTimeout(applyDuck, Math.max(50, clock.toLocal(nextCheckAt) - Date.now()));
  }
}
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
  // The decision lives in cue-plan.js, where it has tests. This function only
  // owns the WebAudio wiring the decision is carried out with.
  const plan = planAudio(cue, buffer.duration, clock.serverNow(), { seekIntoLoop });
  if (plan.action === 'skip') return;

  stopAudio(cue.assetId, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = !!cue.loop;
  if (plan.loopStart != null) {
    source.loopStart = plan.loopStart;
    source.loopEnd = plan.loopEnd;
  }
  const gainNode = ctx.createGain();
  gainNode.gain.value = cue.gain ?? 1;
  source.connect(gainNode).connect(busFor(cue.slot));

  const start = (when) => (plan.startDuration != null
    ? source.start(when, plan.startOffset, plan.startDuration)
    : source.start(when, plan.startOffset));

  let beginsAt = ctx.currentTime;
  if (plan.action === 'schedule') {
    const when = ctxTimeFor(plan.at);
    beginsAt = Math.max(when, ctx.currentTime);
    start(beginsAt);
    reportCueAt(cue, when);
  } else {
    start(beginsAt);
  }

  // A room bed fades in over the crossfade window — walking into a room is a
  // doorway, not a channel change. Paired with the director's fade-out on the
  // slot it vacated, the handover is a crossfade without either end knowing.
  if (cue.slot === 'room' && mixer.crossfadeMs > 0) {
    const target = cue.gain ?? 1;
    gainNode.gain.setValueAtTime(0.001, beginsAt);
    gainNode.gain.linearRampToValueAtTime(target, beginsAt + mixer.crossfadeMs / 1000);
  }

  // A spoken line ducks the bed under it for exactly as long as it sounds.
  if (VOICE_SLOTS.has(cue.slot)) {
    voices.set(cue.assetId, voiceEndsAt(cue, plan, clock.serverNow()));
    applyDuck();
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
  if (voices.delete(id)) applyDuck(); // a stopped voice releases its duck
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
    case 'haptic': haptic(cue.pattern ?? [200]); break;
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

const repeatGuard = createRepeatGuard();

function emitGesture(type, payload) {
  if (!joined) return;
  // Shown on the phone itself. A gesture that never left the handset and one
  // the show ignored look identical from the floor without this.
  const el = $('gesture');
  if (el) el.textContent = type;

  if (inputMode === 'stream') return sendToExperience({ t: type, ...payload });
  // The guard is for the statechart only: a nervous double-tap is one answer to
  // a screen. An experience wants every tap it is given.
  if (!repeatGuard.allow()) return;
  window.DIM.emit(type, payload);
}

/**
 * The recogniser lives in gestures.js and knows nothing about this file. What
 * is wired in here is only the outside world it needs: the clock, the current
 * input mode, and where each recognised thing goes.
 */
function enableGestures() {
  let lastTouchAt = 0;
  // Kept whole, then the methods pulled off it. `touching` is a getter, and a
  // rest-spread would have copied its value once and read false forever after.
  const touch = createGestureRecogniser({
    mode: () => inputMode,
    onTouch: resumeAudio,
    onGesture: emitGesture,
    onHold: (on) => sendToExperience({ t: 'hold', on }),
    onStreamBegin: streamBegin,
    onStreamMove: streamMove,
    onStreamEnd: streamEnd,
  });
  const { begin, move, end, abort } = touch;

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
  // The OS taking the touch away — an incoming call, a notification pulled down
  // — never fires `touchend`. Without this the room holds a hold forever.
  document.addEventListener('touchcancel', () => {
    lastTouchAt = Date.now();
    abort();
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
    if (afterTouch() || !touch.touching) return;
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
/** Set when this guest was picked up on another page; stops the reconnect war. */
let displaced = false;
let lastState = null;

function sendMsg(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 500;
    setConn(true);
    // In the Android app, the handset's number (Headwind), so the panel says
    // "#23" — the phone with 23 on its case.
    const device = nativeApp?.deviceId?.();
    sendMsg({ type: 'hello', token: getToken(), ...(device && device !== '—' ? { device } : {}) });
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
          guestId: msg.guestId,
          label: msg.label,
          token: msg.token,
        };
        $('label').textContent = msg.label;
        fillRoomPicker(msg.rooms ?? []);
        assetList = msg.assets ?? [];
        mixer = mixerConfig(msg.audioLayers);
        applySnapshot(msg.snapshot);
        // The app re-sends location on this; beacons is forwarded if the server
        // provides the show's map (not yet — the app falls back to its own copy).
        tellNative('onWelcome', msg.guestId ?? '', msg.label ?? '');
        if ('beacons' in msg) tellNative('onBeacons', JSON.stringify(msg.beacons ?? null));
        // Inside the app there is nobody to press Join: a handset on a lanyard
        // is in the show the moment it is unplugged. The app lets media play
        // without a gesture, so the AudioContext unlocks on its own. Joined
        // here, after welcome, so `ready` goes out on an open socket with the
        // asset list already known — the same moment a person would tap.
        if (nativeApp && !joined) join();
        break;
      case 'assets':
        assetList = msg.assets ?? [];
        // A show reload may retune the mixer along with the asset list.
        mixer = mixerConfig(msg.audioLayers);
        if ('beacons' in msg) tellNative('onBeacons', JSON.stringify(msg.beacons ?? null));
        applyDuck();
        if (joined) await preload(assetList);
        break;
      case 'pong':
        clock.addSample(msg.t0, msg.server, Date.now());
        $('offset').textContent = `${clock.offset.toFixed(1)}ms`;
        $('rtt').textContent = `${clock.rtt.toFixed(0)}ms`;
        sendMsg({
          type: 'telemetry',
          offset: Math.round(clock.offset * 10) / 10,
          rtt: Math.round(clock.rtt),
          jitter: Math.round(clock.jitter * 10) / 10,
          // The app's view of the handset: battery, Wi-Fi, beacons, content.
          ...(nativeApp?.status ? { phone: nativeStatus() } : {}),
        });
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
      case 'displaced':
        // This guest was picked up somewhere else — another tab, another
        // handset. Stand down rather than reconnecting into a fight neither
        // side can win.
        displaced = true;
        break;
    }
  };

  ws.onclose = () => {
    setConn(false);
    clearInterval(pingTimer);
    if (displaced) {
      $('connText').textContent = 'opened elsewhere';
      return;
    }
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
  // Audio deliberately not restored from here: the snapshot has never carried
  // cues. Joining sends `ready`, and the director re-sends everything the
  // phone should be hearing — one restoration path, not two disagreeing ones.
  applyRelaySync(snap.relay);
}

function setConn(ok) {
  $('connDot').className = 'dot' + (ok ? ' ok' : '');
  $('connText').textContent = ok ? 'connected' : 'reconnecting';
  tellNative('onConnection', ok);
}

// ---------------------------------------------------------------------------
// Join: user gesture unlocks audio + motion permission, then preload
// ---------------------------------------------------------------------------
async function join() {
  if (joined || $('join').disabled) return;
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
  $('page').textContent = 'Waiting for the show…';
  if (pendingSnapshot) {
    const snap = pendingSnapshot;
    pendingSnapshot = null;
    await restoreFromSnapshot(snap);
  }
}

$('join').addEventListener('click', join);

connect();
