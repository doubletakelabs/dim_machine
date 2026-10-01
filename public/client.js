// DIM Machine — Phase 1 phone cue player.
// Clock sync, asset preload (audio + video), scheduled cue execution,
// input promotion, snapshot resume.
'use strict';

import { createGestureRecogniser, createRepeatGuard } from './gestures.js';
import { createCompanion } from './companion.js';
import { createClock } from './clock-sync.js';
import { planAudio } from './cue-plan.js';
import {
  mixerConfig, duckDecision, voiceEndsAt, crossfadeLoop, VOICE_SLOTS as VOICES, LAYER_SLOTS as LAYERS,
} from './mixer.js';

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
  self: { guestId: null, visitId: null, label: null, token: null },
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
// The guest's gestures, counted for their receipt (2026-10-01)
// ---------------------------------------------------------------------------
// Every tap, swipe, drag and hold the phone recognises, wherever it went —
// the show, a room's piece, or nowhere. Kept with the visit's token, so a page
// reload keeps counting and a new guest (a new token) starts from nothing.
// Sent with the phone's telemetry; the Library prints them.
const COUNTS_KEY = 'dim.counts' + (new URLSearchParams(location.search).get('u') ?? '');
function loadCounts() {
  try {
    const c = JSON.parse(localStorage.getItem(COUNTS_KEY));
    if (c && c.token && c.token === getToken()) return c;
  } catch { /* none yet */ }
  return { token: getToken(), taps: 0, swipes: 0, drags: 0, holds: 0, dragMs: 0 };
}
let gestureCounts = loadCounts();
function countGesture(type, payload) {
  if (gestureCounts.token !== getToken()) gestureCounts = loadCounts();
  if (type === 'tap') gestureCounts.taps++;
  else if (type === 'swipe') gestureCounts.swipes++;
  else if (type === 'drag') { gestureCounts.drags++; gestureCounts.dragMs += Math.max(0, payload?.ms ?? 0); }
  else if (type === 'hold') gestureCounts.holds++;
  try { localStorage.setItem(COUNTS_KEY, JSON.stringify(gestureCounts)); } catch { /* private mode */ }
}
function countsForShow() {
  if (gestureCounts.token !== getToken()) gestureCounts = loadCounts();
  const { taps, swipes, drags, holds, dragMs } = gestureCounts;
  return { taps, swipes, drags, holds, dragMs: Math.round(dragMs) };
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
const playing = new Map(); // assetId → { sources, gainNode, timer?, loopTimer? }
const stopping = new Map(); // assetId → same, while fading out

// ---------------------------------------------------------------------------
// The mixer. Decisions live in mixer.js, where they have tests; this block
// owns only the gain nodes the decisions are carried out with. The layers —
// `bg` and `bed` — route through one shared bus so a voice can duck them
// without touching either's own cue gain, and release them to exactly where
// they were.
// ---------------------------------------------------------------------------
let mixer = mixerConfig(null); // retuned by the show on welcome
let layerBus = null;           // GainNode the `bg` and `bed` slots play through
const voices = new Map();      // assetId → endsAt (server ms, null = loop)
let duckTimer = null;
const VOICE_SLOTS = new Set(VOICES);
const LAYER_SLOTS = new Set(LAYERS);

/** Debug readout for the harness and a person with a console. */
window.DIM.mixerState = () => ({
  bus: layerBus ? Math.round(layerBus.gain.value * 1000) / 1000 : null,
  voices: voices.size,
  playing: [...playing.keys()],
  config: mixer,
});

function busFor(slot) {
  if (!ctx) return null;
  if (!LAYER_SLOTS.has(slot)) return masterOut();
  if (!layerBus) {
    layerBus = ctx.createGain();
    layerBus.connect(masterOut());
  }
  return layerBus;
}

// ---------------------------------------------------------------------------
// Volume — the slider on the companion screen (companion.js)
//
// In the app the slider is the phone's own media volume, through the bridge:
// the only way a guest can turn it *up*. In a browser, or an app without the
// bridge call, it is a master gain every sound goes through, which can only
// turn it down.
// ---------------------------------------------------------------------------
let master = null;             // GainNode between everything and the speakers
let pageVolume = 1;            // the master gain's level, 0..1, without the app

const nativeVolume = typeof nativeApp?.getVolume === 'function';

function masterOut() {
  if (!master) {
    master = ctx.createGain();
    master.gain.value = pageVolume;
    master.connect(ctx.destination);
  }
  return master;
}

function readVolume() {
  if (nativeVolume) {
    try { return Number(nativeApp.getVolume()); } catch { /* fall through */ }
  }
  return pageVolume;
}

function setVolume(level) {
  const v = Math.min(1, Math.max(0, level));
  if (nativeVolume) {
    try { nativeApp.setVolume(v); return; } catch (e) { console.warn('native volume', e); }
  }
  pageVolume = v;
  if (master && ctx) master.gain.setTargetAtTime(v, ctx.currentTime, 0.03);
  const video = document.querySelector('#videoOverlay video');
  if (video) video.volume = v;
}

// ---------------------------------------------------------------------------
// The companion screen: word, colour, and — held up — telemetry, help and
// volume (companion.js). The debug readouts (the status bar here, the app's
// own strip and Reset) hide in the app until a 3 s hold in the corner.
// ---------------------------------------------------------------------------
if (nativeApp) document.documentElement.classList.add('native');
const companion = createCompanion({
  root: $('companion'),
  readVolume,
  setVolume,
  onDebug: (on) => {
    document.documentElement.classList.toggle('debug', on);
    tellNative('setDebugVisible', on);
  },
});
window.DIM.companion = companion; // for the console and the harness
// The app's accelerometer, a few times a second: which way up the phone is.
window.DIM.onGravity = (y) => companion.gravity(Number(y));
// The app, on going back on the charger: no debug for the next guest.
window.DIM.onCharger = () => companion.hideDebug();

/** Bring the layer bus in line with who is speaking. Safe to call anytime. */
function applyDuck() {
  clearTimeout(duckTimer);
  duckTimer = null;
  const now = clock.serverNow();
  for (const [id, endsAt] of voices) if (endsAt != null && endsAt <= now) voices.delete(id);
  const { ducked, nextCheckAt } = duckDecision([...voices.values()].map((endsAt) => ({ endsAt })), now);
  if (layerBus && ctx) {
    const target = ducked ? mixer.duckTo : 1;
    layerBus.gain.cancelScheduledValues(ctx.currentTime);
    layerBus.gain.setValueAtTime(layerBus.gain.value, ctx.currentTime);
    // setTargetAtTime reaches ~95% of the way in 3 time-constants, so /3000
    // makes duckMs the audible length of the move — same idiom as the fades.
    layerBus.gain.setTargetAtTime(target, ctx.currentTime, Math.max(0.001, mixer.duckMs / 3000));
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

/**
 * Images and video, fetched ahead. Audio is not: decoded, the show's clips are
 * far bigger than their files (MAD-DIM's 29 minutes are ~600MB of samples),
 * and decoding them all at once had Android kill the page on a 4GB phone —
 * which the app answers with a reload, which decoded them all again
 * (2026-09-26). Audio is decoded when a cue asks for it; see `loadAudio`.
 */
async function preload(assets) {
  const missing = assets.filter((id) => (isVideoAsset(id) || isImageAsset(id)) && !assetStore(id).has(id));
  if (!missing.length) return;
  $('loading').style.display = 'block';
  await Promise.all(missing.map(async (id) => {
    try {
      const res = await fetch(`assets/${id}`);
      if (!res.ok) throw new Error(res.status);
      // Images and video become blob URLs so showing one is never a network
      // round trip — a screen that arrives a beat after its narration reads as
      // a fault, and in a dark room it is the only thing the guest can see.
      assetStore(id).set(id, URL.createObjectURL(await res.blob()));
    } catch (e) { console.warn('asset failed:', id, e); }
  }));
  $('loading').style.display = 'none';
}

/**
 * Decoded audio kept for reuse, up to this many bytes of samples. What is
 * playing, fading, or waiting to play is never let go, whatever the total; the
 * rest goes oldest-used first. Two 5-minute layers are ~230MB on their own.
 */
const AUDIO_BUDGET_BYTES = 320e6;
const AUDIO_FETCH_TIMEOUT_MS = 30000;
/** A voice cue arriving within this of its start is fresh, not a reconnect mid-line. */
const VOICE_FRESH_MS = 3000;
const audioUsedAt = new Map(); // assetId → last asked for
const audioLoading = new Map(); // assetId → Promise<AudioBuffer|null>
/** assetId → the latest cue waiting for its audio, so a stop before it decodes wins. */
const awaitingAudio = new Map();
const bufferBytes = (b) => b.length * b.numberOfChannels * 4;

/**
 * What decodes first when several clips are waiting: speech, then a room's
 * bg, then the bed. The bed is five minutes of samples; a guest walking into
 * calibration must not wait out its decode to hear the first line (2026-09-26).
 */
const DECODE_PRIORITY = { bg: 1, bed: 2 };
const decodePriority = (slot) => (VOICE_SLOTS.has(slot) ? 0 : DECODE_PRIORITY[slot] ?? 1);
const decodeQueue = []; // { id, priority, seq, resolve }
let decodeSeq = 0;
let decoding = false;

/**
 * One clip's audio, decoded once and kept. Decodes run one at a time, most
 * urgent first, so the page never holds more than one clip's worth of
 * compressed and half-decoded data on top of what it keeps.
 */
function loadAudio(id, priority = 1) {
  audioUsedAt.set(id, performance.now());
  if (audioBuffers.has(id)) return Promise.resolve(audioBuffers.get(id));
  const queued = decodeQueue.find((job) => job.id === id);
  if (queued) queued.priority = Math.min(queued.priority, priority);
  if (audioLoading.has(id)) return audioLoading.get(id);
  const loading = new Promise((resolve) => {
    decodeQueue.push({ id, priority, seq: ++decodeSeq, resolve });
  });
  audioLoading.set(id, loading);
  pumpDecodes();
  return loading;
}

async function pumpDecodes() {
  if (decoding) return;
  decoding = true;
  while (decodeQueue.length) {
    decodeQueue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const job = decodeQueue.shift();
    job.resolve(await decodeOne(job.id));
  }
  decoding = false;
}

async function decodeOne(id) {
  try {
    // One at a time means one stuck fetch would hold up every clip after it.
    const res = await fetch(`assets/${id}`, { signal: AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(res.status);
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    audioBuffers.set(id, buffer);
    trimAudio();
    return buffer;
  } catch (e) {
    console.warn('asset failed:', id, e);
    return null;
  } finally {
    audioLoading.delete(id);
  }
}

/** Let go of the least recently used clips nothing needs, down to the budget. */
function trimAudio() {
  let total = 0;
  for (const b of audioBuffers.values()) total += bufferBytes(b);
  if (total <= AUDIO_BUDGET_BYTES) return;
  const idle = [...audioBuffers.keys()]
    .filter((id) => !playing.has(id) && !stopping.has(id) && !awaitingAudio.has(id))
    .sort((a, b) => (audioUsedAt.get(a) ?? 0) - (audioUsedAt.get(b) ?? 0));
  for (const id of idle) {
    if (total <= AUDIO_BUDGET_BYTES) break;
    total -= bufferBytes(audioBuffers.get(id));
    audioBuffers.delete(id);
  }
}

function ctxTimeFor(serverTs) {
  return ctx.currentTime + (clock.toLocal(serverTs) - Date.now()) / 1000;
}

// ---------------------------------------------------------------------------
// Cue execution
// ---------------------------------------------------------------------------
function playAudio(cue, { seekIntoLoop = false } = {}) {
  if (!ctx) return;
  const buffer = audioBuffers.get(cue.assetId);
  if (!buffer) {
    // Decoded on first use. The plan below is made against the show clock when
    // it lands, so a clip that took a moment to decode starts where it should
    // be by then rather than from its top.
    awaitingAudio.set(cue.assetId, cue);
    const arrivedAt = clock.serverNow();
    loadAudio(cue.assetId, decodePriority(cue.slot)).then((loaded) => {
      if (awaitingAudio.get(cue.assetId) !== cue) return; // replaced or stopped meanwhile
      awaitingAudio.delete(cue.assetId);
      if (!loaded) return;
      // A spoken line that reached us fresh and is late only because we were
      // decoding starts from its top: the guest hears its opening words, a
      // beat later. One already well under way when it arrived — a phone
      // reconnecting mid-line — joins where the line has got to.
      const now = clock.serverNow();
      const fresh = cue.startAt == null || arrivedAt - cue.startAt < VOICE_FRESH_MS;
      const late = cue.startAt != null && now > cue.startAt;
      playAudio(VOICE_SLOTS.has(cue.slot) && fresh && late && cue.offset == null
        ? { ...cue, startAt: now }
        : cue, { seekIntoLoop });
    });
    return;
  }
  audioUsedAt.set(cue.assetId, performance.now());
  // The decision lives in cue-plan.js, where it has tests. This function only
  // owns the WebAudio wiring the decision is carried out with.
  const plan = planAudio(cue, buffer.duration, clock.serverNow(), { seekIntoLoop });
  if (plan.action === 'skip') return;

  stopAudio(cue.assetId, 0);
  const gainNode = ctx.createGain();
  gainNode.gain.value = cue.gain ?? 1;
  gainNode.connect(busFor(cue.slot));

  let beginsAt = ctx.currentTime;
  if (plan.action === 'schedule') {
    const when = ctxTimeFor(plan.at);
    beginsAt = Math.max(when, ctx.currentTime);
  }

  const entry = { sources: new Set(), gainNode };
  // A layer that loops overlaps each pass with the next, rather than jumping
  // from its last sample to its first. Whole files only: a slice has its own
  // edges, and is looped plainly.
  const overlap = LAYER_SLOTS.has(cue.slot) && cue.loop && cue.offset == null && cue.duration == null
    ? crossfadeLoop(0, buffer.duration, mixer.loopCrossfadeMs / 1000)
    : null;
  if (overlap) {
    const elapsed = plan.action === 'start' ? Math.max(0, (clock.serverNow() - cue.startAt) / 1000) : 0;
    loopPass(entry, buffer, beginsAt, crossfadeLoop(elapsed, buffer.duration, mixer.loopCrossfadeMs / 1000).into);
  } else {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = !!cue.loop;
    if (plan.loopStart != null) {
      source.loopStart = plan.loopStart;
      source.loopEnd = plan.loopEnd;
    }
    source.connect(gainNode);
    if (plan.startDuration != null) source.start(beginsAt, plan.startOffset, plan.startDuration);
    else source.start(beginsAt, plan.startOffset);
    entry.sources.add(source);
  }

  // A layer fades in over the crossfade window — walking into a room is a
  // doorway, not a channel change. Paired with the director's fade-out on the
  // slot it vacated, the handover is a crossfade without either end knowing.
  const fadeInMs = cue.fadeInMs ?? mixer.crossfadeMs;
  if (LAYER_SLOTS.has(cue.slot) && fadeInMs > 0) {
    const target = cue.gain ?? 1;
    gainNode.gain.setValueAtTime(0.001, beginsAt);
    gainNode.gain.linearRampToValueAtTime(target, beginsAt + fadeInMs / 1000);
  }

  // Tell the show a voice has begun — the museum counts a room as heard from
  // here (museum.doneAfterMs), not from when the cue was sent.
  if (VOICE_SLOTS.has(cue.slot)) {
    sendMsg({ type: 'playing', assetId: cue.assetId, slot: cue.slot, at: plan.action === 'schedule' ? plan.at : clock.serverNow() });
  }

  // A spoken line ducks the layers under it for exactly as long as it sounds.
  if (VOICE_SLOTS.has(cue.slot)) {
    voices.set(cue.assetId, voiceEndsAt(cue, plan, clock.serverNow()));
    applyDuck();
  }

  playing.set(cue.assetId, entry);
}

/** An equal-power curve, so two passes blending never dip in the middle. */
const FADE_STEPS = 64;
const fadeInCurve = Float32Array.from({ length: FADE_STEPS }, (_, i) => Math.sin((i / (FADE_STEPS - 1)) * Math.PI / 2));
const fadeOutCurve = Float32Array.from(fadeInCurve).reverse();

/**
 * One pass of a crossfaded loop, starting `into` seconds through the file at
 * ctx time `when`, and the next pass booked to begin as this one starts to
 * fade. Only the first pass of a loop can start partway through — a phone
 * joining late — and it gets no fade in of its own: the layer's handover fade
 * already covers it.
 */
function loopPass(entry, buffer, when, into) {
  const xfade = mixer.loopCrossfadeMs / 1000;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const pass = ctx.createGain();
  source.connect(pass).connect(entry.gainNode);
  if (into === 0 && entry.sources.size) pass.gain.setValueCurveAtTime(fadeInCurve, when, xfade);
  const endsAt = when + buffer.duration - into;
  const fadeFrom = endsAt - xfade;
  pass.gain.setValueCurveAtTime(fadeOutCurve, Math.max(when, fadeFrom), Math.min(xfade, endsAt - when));
  source.start(when, into);
  source.onended = () => {
    entry.sources.delete(source);
    try { pass.disconnect(); } catch {}
  };
  entry.sources.add(source);
  // Booked a little ahead, so a busy main thread cannot make the next pass late.
  const leadMs = 1500;
  entry.loopTimer = setTimeout(
    () => loopPass(entry, buffer, fadeFrom, 0),
    Math.max(0, (fadeFrom - ctx.currentTime) * 1000 - leadMs),
  );
}

function stopAudio(assetId, fadeMs = 0) {
  if (assetId === '*') awaitingAudio.clear();
  else awaitingAudio.delete(assetId);
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
  // A crossfaded loop books its next pass ahead; a stopped one books no more.
  clearTimeout(p.loopTimer);
  const finish = () => {
    for (const source of p.sources) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
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

/**
 * Named vibrations. In the app each is a waveform the app holds, with
 * strength (`DIMNative.haptic`); elsewhere, the same rhythm on and off.
 * `purr` is the faerie room's flash (2026-09-27): a rough, uneven second.
 */
const HAPTIC_EFFECTS = {
  purr: Array.from({ length: 20 }, () => 50),
};

function haptic(pattern, effect = null) {
  if (effect) {
    try { if (nativeApp?.haptic?.(effect)) return; } catch { /* fall back */ }
    pattern = HAPTIC_EFFECTS[effect] ?? pattern;
  }
  try { navigator.vibrate?.(pattern); } catch {}
}

function scheduleFlash(cue) {
  const el = $('flash');
  (function tick() {
    const remaining = clock.toLocal(cue.startAt) - Date.now();
    if (remaining > 0) return requestAnimationFrame(tick);
    if (remaining < -500) return;
    el.style.transition = 'none';
    el.style.opacity = '1';
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
    case 'haptic': haptic(cue.pattern ?? [200], cue.effect ?? null); break;
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
/**
 * The show's `guest.input.mirrorY`: the handset hangs upside down on a lanyard,
 * so the glass's top is the guest's bottom. Each touch is flipped top-to-bottom
 * as it arrives, before anything reads it — swipe directions, drag and release
 * all come out in the guest's own up and down, and no room has to know how the
 * phone is worn. Left and right are unchanged.
 */
let mirrorY = false;
// Only while it hangs: held up to read, the screen is the right way round.
const touchY = (y) => (mirrorY && companion.hanging ? innerHeight - y : y);
let experience = null;   // { ws, endpoint, driverId, hue, accepts }

const repeatGuard = createRepeatGuard();

function emitGesture(type, payload) {
  if (!joined) return;
  countGesture(type, payload);
  // Shown on the phone itself. A gesture that never left the handset and one
  // the show ignored look identical from the floor without this.
  const el = $('gesture');
  if (el) el.textContent = type;

  if (inputMode === 'stream') {
    // A drag went to the piece move by move already; taps and swipes go whole.
    if (!payload?.streamed && experienceAllows(type)) sendToExperience({ t: type, ...payload });
    // A piece showing what the show is teaching (the lobby, during
    // calibration) leaves the show its gestures too (gesturesToShow).
    if (!experience?.gesturesToShow) return;
  }
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
    onHold: (on) => {
      if (on && joined) countGesture('hold');
      if (experienceAllows('hold')) sendToExperience({ t: 'hold', on });
    },
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
  const control = (e) => e.target?.closest?.('button, a, input, select, textarea, .cmp-control');

  document.addEventListener('touchstart', (e) => {
    if (control(e)) return;
    const t = e.changedTouches[0];
    begin(t.clientX, touchY(t.clientY));
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.changedTouches[0];
    move(t.clientX, touchY(t.clientY));
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    lastTouchAt = Date.now();
    if (control(e)) return;
    const t = e.changedTouches[0];
    end(t.clientX, touchY(t.clientY));
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
    begin(e.clientX, touchY(e.clientY));
  });
  document.addEventListener('mousemove', (e) => {
    if (afterTouch() || !touch.touching) return;
    move(e.clientX, touchY(e.clientY));
  });
  document.addEventListener('mouseup', (e) => {
    if (afterTouch() || control(e)) return;
    end(e.clientX, touchY(e.clientY));
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
/** How long to wait before trying a room's software again. */
const EXPERIENCE_RETRY_MS = 2000;

function openExperience(cue) {
  if (experience?.endpoint === cue.endpoint && experience?.driverId === cue.driverId) {
    // The same link, re-cued: another gesture unlocked, or a new step to
    // sample the guest's side in.
    experience.allow = cue.allow ?? null;
    if (cue.sideKey && cue.sideKey !== experience.sideKey) {
      experience.sideKey = cue.sideKey;
      sampleSide(experience, cue.sides, cue.sideAfterMs ?? 3000);
    }
    return;
  }
  closeExperience();

  const link = {
    ws: null, endpoint: cue.endpoint, driverId: cue.driverId, hue: cue.hue,
    accepts: cue.inputs ?? null, gesturesToShow: cue.gesturesToShow === true,
    allow: cue.allow ?? null, retry: null,
  };
  experience = link;
  inputMode = cue.inputMode ?? 'stream';
  dialExperience(link, cue.secret);
  link.sideKey = cue.sideKey ?? null;
  if (link.sideKey) sampleSide(link, cue.sides, cue.sideAfterMs ?? 3000);
}

/**
 * Which of the room's beacons this phone hears strongest, averaged over the
 * first few seconds of a step (each calibration clip), told to the show once
 * per step: it decides which half of the screen is this guest's for that clip
 * (the lobby, from calibration's two beacons, 2026-10-01). Needs the app's
 * `heard`; without it, nothing is sent and the piece places the guest
 * anywhere. Nothing heard yet: keep listening. A new step: this one stops.
 */
const SIDE_SAMPLE_EVERY_MS = 250;
const SIDE_GIVE_UP_MS = 30000;
function sampleSide(link, majors, forMs) {
  if (!nativeApp?.status || !Array.isArray(majors) || !majors.length) return;
  const key = link.sideKey;
  const sums = new Map();
  const started = Date.now();
  const timer = setInterval(() => {
    if (experience !== link || link.sideKey !== key) return clearInterval(timer);
    const heard = nativeStatus()?.heard ?? {};
    for (const major of majors) {
      const rssi = heard[String(major)];
      if (typeof rssi !== 'number') continue;
      const s = sums.get(major) ?? { total: 0, n: 0 };
      s.total += rssi; s.n += 1;
      sums.set(major, s);
    }
    const elapsed = Date.now() - started;
    if (elapsed < forMs) return;
    if (!sums.size) {
      if (elapsed > SIDE_GIVE_UP_MS) clearInterval(timer);
      return;
    }
    clearInterval(timer);
    const [best] = [...sums.entries()].sort((a, b) => b[1].total / b[1].n - a[1].total / a[1].n)[0];
    sendMsg({ type: 'side', major: best, key });
  }, SIDE_SAMPLE_EVERY_MS);
}

/**
 * One attempt to reach the room's software, and another after a pause if it
 * fails or drops — for as long as this is still the guest's link. The show
 * ends the link (endExperience) when they walk out, or replaces it with a
 * new one, and either stops the retrying: a phone must never go back to
 * driving a room it has left. Until then a single failed attempt must not
 * leave them unable to drive the room they are standing in (Slop, #42,
 * 2026-09-30): the room turning them away because the show's word that they
 * may drive had not reached it yet, a Wi-Fi blip, the room's server
 * restarting.
 */
function dialExperience(link, secret) {
  if (experience !== link) return;
  let ws;
  try {
    ws = new WebSocket(link.endpoint);
  } catch {
    setExperienceStatus('unreachable');
    link.retry = setTimeout(() => dialExperience(link, secret), EXPERIENCE_RETRY_MS);
    return;
  }
  link.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', role: 'driver', driverId: link.driverId, secret }));
    setExperienceStatus('linked');
  };
  ws.onclose = () => {
    if (experience !== link || link.ws !== ws) return; // ended or replaced: stay closed
    setExperienceStatus('reconnecting');
    clearTimeout(link.retry);
    link.retry = setTimeout(() => dialExperience(link, secret), EXPERIENCE_RETRY_MS);
  };
  // An error is always followed by a close, which does the retrying.
  ws.onerror = () => setExperienceStatus('unreachable');
}

function closeExperience() {
  const link = experience;
  experience = null;
  inputMode = 'gestures';
  setExperienceStatus('–');
  clearTimeout(link?.retry);
  try { link?.ws?.close(); } catch { /* already gone */ }
}

function sendToExperience(message) {
  const link = experience;
  if (!link?.ws || link.ws.readyState !== 1) return;
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

/**
 * Whether the piece may hear this gesture yet. A piece driven while the show
 * teaches its gestures (the lobby, in calibration) is given only those taught
 * so far (`allow`, 2026-10-01); a drag's moves and release go with `drag`.
 */
function experienceAllows(type) {
  const allow = experience?.allow;
  return !Array.isArray(allow) || allow.includes(type === 'release' ? 'drag' : type);
}

function streamBegin(x, y) {
  if (!experienceAllows('drag')) return;
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
    // Pings keep the clock in step (timed and shared audio) and are how the
    // server knows this phone is still here (contactLossMs), so they stay.
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
          visitId: msg.visitId ?? null,
          label: msg.label,
          token: msg.token,
        };
        $('label').textContent = msg.label;
        showBattery();
        fillRoomPicker(msg.rooms ?? []);
        assetList = msg.assets ?? [];
        mixer = mixerConfig(msg.audioLayers);
        mirrorY = msg.input?.mirrorY === true;
        applySnapshot(msg.snapshot);
        // The app re-sends location on this; beacons is forwarded if the server
        // provides the show's map (not yet — the app falls back to its own copy).
        tellNative('onWelcome', msg.guestId ?? '', msg.label ?? '');
        if ('beacons' in msg) tellNative('onBeacons', JSON.stringify(msg.beacons ?? null));
        if ('hallways' in msg) tellNative('onHallways', JSON.stringify(msg.hallways ?? {}));
        if ('adjacent' in msg) tellNative('onAdjacent', JSON.stringify(msg.adjacent ?? {}));
        if ('locator' in msg) tellNative('onLocator', JSON.stringify(msg.locator ?? null));
        // Nobody joins by themselves any more — not even in the app, which used
        // to join the moment it was welcomed (2026-09-30). START DIM, pressed by
        // the guest after unplugging, is the only way in, so a handset on the
        // charger or in a pocket plays nothing. Pressable from here, once
        // `ready` would go out on an open socket with the asset list known.
        if (!joined) {
          startReady = true;
          $('join').textContent = 'START DIM';
          updateStart();
        }
        break;
      case 'assets':
        assetList = msg.assets ?? [];
        // A show reload may retune the mixer along with the asset list.
        mixer = mixerConfig(msg.audioLayers);
        mirrorY = msg.input?.mirrorY === true;
        if ('beacons' in msg) tellNative('onBeacons', JSON.stringify(msg.beacons ?? null));
        if ('hallways' in msg) tellNative('onHallways', JSON.stringify(msg.hallways ?? {}));
        if ('adjacent' in msg) tellNative('onAdjacent', JSON.stringify(msg.adjacent ?? {}));
        if ('locator' in msg) tellNative('onLocator', JSON.stringify(msg.locator ?? null));
        applyDuck();
        if (joined) await preload(assetList);
        break;
      case 'pong':
        clock.addSample(msg.t0, msg.server, Date.now());
        // The app's view of the handset — battery, Wi-Fi, beacons, content —
        // for the operator panel. A browser has none to send.
        // And the guest's gesture counts, for their receipt — a browser too.
        sendMsg({ type: 'telemetry', phone: nativeApp?.status ? nativeStatus() : null, counts: countsForShow() });
        break;
      case 'state': {
        lastState = msg.state;
        $('stateName').textContent = msg.state ?? '';
        // Reflect where the show thinks we are, so the picker cannot drift from
        // the truth after a reconnect or an operator moving us.
        const select = $('roomPick');
        const roomId = msg.state === 'outside' ? '' : String(msg.state).split(' ')[0];
        if (select && document.activeElement !== select) select.value = roomId;
        if ('phase' in msg) companion.setPhase(msg.phase);
        break;
      }
      case 'word':
        // Walked into a room with a word: every time, a return included.
        companion.showWord(msg.word);
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
      case 'faerieFlash':
        // The faerie room's flash, felt: the purr. The server side that sends
        // it is still to come (2026-09-27); `{ type: 'faerieFlash' }`.
        if (joined) haptic([200], 'purr');
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
  companion.setPhase(snap.phase);
  companion.setLastWord(snap.lastWord);
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
  companion.setConnected(ok);
  $('connDot').className = 'dot' + (ok ? ' ok' : '');
  $('connText').textContent = ok ? 'connected' : 'reconnecting';
  tellNative('onConnection', ok);
}

// ---------------------------------------------------------------------------
// Join: user gesture unlocks audio + motion permission, then preload
// ---------------------------------------------------------------------------
async function join() {
  if (joined || $('join').disabled) return;
  startReady = false;           // pressed: never pressable again while joining
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

// START DIM in red and not pressable, with the progress small below, while
// this handset's copy of the show is not the server's current one
// (2026-09-30): a phone handed over half-synced streams — or goes silent —
// mid-show.
let serverContent = null;
let startReady = false;       // welcomed: `ready` would go out on an open socket
let unsynced = false;
function updateStart() {
  $('join').disabled = !startReady || unsynced;
  $('join').classList.toggle('unsynced', unsynced && startReady);
}
// The server's current version, every 15 s: a whole manifest is too much to
// ask for every few seconds from every phone waiting at the door.
async function fetchServerContent() {
  if (joined || !nativeApp) return;
  try {
    const res = await fetch('/api/content', { cache: 'no-store' });
    if (res.ok) serverContent = (await res.json()).version ?? serverContent;
  } catch {}
  showSync();
}
function showSync() {
  if (joined || !nativeApp) return;
  const s = nativeStatus() ?? {};
  let note = '';
  if (s.syncing) {
    if (typeof s.syncTotal === 'number' && s.syncTotal > 0) {
      const left = Math.max(0, s.syncTotal - (s.syncDone ?? 0));
      note = `${left} file${left === 1 ? '' : 's'} left to sync`;
    } else {
      note = 'syncing…';
    }
  } else if (s.syncError) {
    note = `sync failed: ${s.syncError}`;
  } else if (!s.content) {
    note = 'no content — put on charge to sync';
  } else if (serverContent && s.content !== serverContent) {
    note = 'content out of date — put on charge to sync';
  }
  unsynced = !!note;
  $('syncNote').textContent = note;
  updateStart();
}

// The battery, small under the phone's number on START DIM: whoever hands the
// phone over can see it is charged. From the app; a browser's own if it has one.
async function showBattery() {
  showSync();
  if (joined) return;
  let pct = nativeStatus()?.battery;
  if (typeof pct !== 'number' && navigator.getBattery) {
    try { pct = Math.round((await navigator.getBattery()).level * 100); } catch {}
  }
  $('battery').textContent = typeof pct === 'number' ? `battery ${pct}%` : '';
}
showBattery();
setInterval(showBattery, 20000);
setInterval(showSync, 3000);
fetchServerContent();
setInterval(fetchServerContent, 15000);

connect();
