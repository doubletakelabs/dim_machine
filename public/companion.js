/**
 * The companion screen: what a guest's phone shows (2026-09-27; the look is
 * visual_refs/DIM-APP-SPEC.md and Lance's mockup).
 *
 * The phone hangs upside down on a lanyard, screen facing out. So:
 *
 * - **Hanging** (gravity says the top points down): the whole page is drawn
 *   turned 180°, so the people in front of the wearer read it right way up —
 *   and it shows only the word. The idle screen cycles word and colour every
 *   4.2 s.
 * - **Held** (the wearer lifts it to look): the page turns back, the colour
 *   stops cycling where it is, and the telemetry, help and volume fade in.
 *   Which way up comes from the app's own sensor (`DIM.onGravity`); a browser
 *   with none is always held (`?hanging=1` to try the other).
 *
 * Phases, from the show (`guest.companion`, sent as `phase`): `intro` — the
 * pulsing DIM, through calibration until the Entrance Hallway; `show` — idle
 * and words; `closing` — DONE, from the Library on.
 *
 * Words arrive as the guest walks into a room (`{ type: 'word' }`), every time
 * including returns: 2.2 s full screen on the next colour, then idle shows it.
 *
 * A finger held for 3 s in the top-left corner (as the screen reads) brings up
 * the debug readouts and Reset for two minutes; the same again hides them.
 */

const PALETTE = [
  { bg: '#000000', ink: '#ffffff' },
  { bg: '#1652f0', ink: '#ffffff' },
  { bg: '#e8241a', ink: '#ffffff' },
  { bg: '#ffd400', ink: '#000000' },
  { bg: '#159447', ink: '#ffffff' },
];
const AMBIENT_WORDS = ['LISTEN', 'STILL', 'HERE', 'DRIFT', 'WAIT'];
const IDLE_CYCLE_MS = 4200;
const WORD_HOLD_MS = 2200;
/** How long a new way up must hold before the screen turns: walking swings it. */
const TURN_SETTLE_MS = 500;
/** m/s² of gravity along the phone's length that counts as clearly up or down. */
const TURN_GRAVITY = 4;
const DEBUG_HOLD_MS = 3000;
const DEBUG_FOR_MS = 120000;
/** Movement past this, before the finger lifts, is a swipe rather than a tap. */
const SWIPE_PX = 12;

const ICONS = {
  help: 'M11 18h2v-2h-2v2zm1-12c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  volumeUp: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  volumeDown: 'M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}" fill="currentColor"/></svg>`;

const MARKUP = `
  <div class="cmp-view cmp-intro"><div class="cmp-big cmp-mark">DIM</div></div>
  <div class="cmp-view cmp-idle"><div class="cmp-big cmp-idle-word"></div></div>
  <div class="cmp-view cmp-word"><div class="cmp-big cmp-word-text"></div></div>
  <div class="cmp-view cmp-close">
    <div class="cmp-big cmp-close-mark">DONE</div>
    <div class="cmp-close-sub">Your receipt is printing in the library.<br>Go find it.</div>
    <div class="cmp-spinner"></div>
  </div>
  <div class="cmp-view cmp-help">
    <div class="cmp-help-inner">
      <h2>How this works</h2>
      <p>This phone travels with you through DIM. It doesn't ask anything of you &mdash; just carry it.</p>
      <div class="cmp-step"><b>1</b><span>As you move through the rooms, a word may appear on this screen. It's being collected, not explained.</span></div>
      <div class="cmp-step"><b>2</b><span>You don't need to do anything when a word appears. Keep walking.</span></div>
      <div class="cmp-step"><b>3</b><span>Use the slider on the right to adjust the volume of whatever this phone is playing for you.</span></div>
      <div class="cmp-step"><b>4</b><span>At the end, everything you collected is sent ahead. Your receipt will be waiting in the library.</span></div>
      <p class="cmp-help-foot">Lost, or something not working? Find anyone wearing a DIM badge.</p>
    </div>
  </div>
  <div class="cmp-chrome cmp-top">
    <div class="cmp-sys">
      <div><span class="cmp-dot"></span><span class="cmp-conn">SYNCING</span></div>
      <div>TAPS &nbsp;<span class="cmp-taps">000</span></div>
      <div>SWIPES <span class="cmp-swipes">000</span></div>
      <div>DRAG &nbsp;<span class="cmp-drag">00:00</span></div>
    </div>
    <button class="cmp-icon-btn cmp-help-btn cmp-control" aria-label="Help">${icon('help')}</button>
  </div>
  <div class="cmp-chrome cmp-vol cmp-control">
    <span class="cmp-vol-icon">${icon('volumeUp')}</span>
    <input type="range" class="cmp-vol-slider" min="0" max="100" step="1" aria-label="Volume">
    <span class="cmp-vol-icon">${icon('volumeDown')}</span>
  </div>
  <div class="cmp-hotspot cmp-control" aria-hidden="true"></div>
`;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root — the element to fill
 * @param {() => number} opts.readVolume — 0..1
 * @param {(v: number) => void} opts.setVolume
 * @param {(on: boolean) => void} [opts.onDebug] — show or hide the debug readouts
 */
export function createCompanion({ root, readVolume, setVolume, onDebug }) {
  root.innerHTML = MARKUP;
  const q = (sel) => root.querySelector(sel);
  const html = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let phase = 'show';
  let view = null;
  let colour = 0;
  let lastWord = null;
  let wordTimer = null;
  let hanging = new URLSearchParams(location.search).get('hanging') === '1';

  // ------------------------------------------------------------- colour + views

  function paint(swatch) {
    root.style.backgroundColor = swatch.bg;
    root.style.color = swatch.ink;
  }
  const nextSwatch = () => PALETTE[(colour = (colour + 1) % PALETTE.length)];

  function show(name) {
    view = name;
    for (const el of root.querySelectorAll('.cmp-view')) el.classList.toggle('active', el.classList.contains(`cmp-${name}`));
    // The help button closes help, as an X.
    const btn = q('.cmp-help-btn');
    btn.innerHTML = icon(name === 'help' ? 'close' : 'help');
    btn.setAttribute('aria-label', name === 'help' ? 'Close' : 'Help');
  }

  /** Where the screen rests when nothing is happening, for this phase. */
  function rest() {
    if (phase === 'intro') { paint(PALETTE[0]); show('intro'); return; }
    if (phase === 'closing') { show('close'); return; }
    q('.cmp-idle-word').textContent = lastWord ?? AMBIENT_WORDS[Math.floor(Math.random() * AMBIENT_WORDS.length)];
    paint(PALETTE[colour]);
    show('idle');
  }

  // The idle screen breathes on: a new colour (and, before any word, a new
  // ambient word) every 4.2 s — paused while the phone is held up.
  setInterval(() => {
    if (view !== 'idle' || !hanging) return;
    const el = q('.cmp-idle-word');
    el.style.opacity = '0';
    setTimeout(() => {
      el.textContent = lastWord ?? AMBIENT_WORDS[Math.floor(Math.random() * AMBIENT_WORDS.length)];
      paint(nextSwatch());
      el.style.opacity = '';
    }, 300);
  }, IDLE_CYCLE_MS);

  function showWord(word) {
    if (!word) return;
    lastWord = String(word).toUpperCase();
    const el = q('.cmp-word-text');
    el.textContent = lastWord;
    // Restart the entrance animation for a second word in a row.
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    paint(nextSwatch());
    show('word');
    clearTimeout(wordTimer);
    wordTimer = setTimeout(() => { wordTimer = null; rest(); }, WORD_HOLD_MS);
  }

  function setPhase(next) {
    const p = next === 'intro' || next === 'closing' ? next : 'show';
    if (p === phase) return;
    phase = p;
    if (p === 'closing') paint(nextSwatch());
    if (!wordTimer && view !== 'help') rest();
  }

  // ------------------------------------------------------------- held / hanging

  function setHanging(next) {
    if (next === hanging) return;
    // A short fade across the turn, rather than the page flipping under you.
    html.classList.add('cmp-turning');
    setTimeout(() => {
      hanging = next;
      html.classList.toggle('cmp-hanging', hanging);
      if (hanging && view === 'help') rest();
      if (!hanging) syncVolume();
      html.classList.remove('cmp-turning');
    }, reducedMotion ? 0 : 180);
  }

  let candidate = null;
  let candidateSince = 0;
  /**
   * Gravity along the phone's length, m/s²: upright it is about +9.8, hanging
   * top down about −9.8. From the app (`DIM.onGravity`), because Chrome gives a
   * page on plain http no motion sensor; from `devicemotion` where it does.
   */
  function gravity(y) {
    if (typeof y !== 'number' || !Number.isFinite(y)) return;
    const want = y < -TURN_GRAVITY ? true : y > TURN_GRAVITY ? false : null;
    if (want === null || want === hanging) { candidate = null; return; }
    const now = performance.now();
    if (candidate !== want) { candidate = want; candidateSince = now; return; }
    if (now - candidateSince >= TURN_SETTLE_MS) { candidate = null; setHanging(want); }
  }
  addEventListener('devicemotion', (e) => gravity(e.accelerationIncludingGravity?.y));
  html.classList.toggle('cmp-hanging', hanging);

  // ------------------------------------------------------------- help

  q('.cmp-help-btn').addEventListener('click', () => {
    if (view === 'help') rest(); else { clearTimeout(wordTimer); wordTimer = null; show('help'); }
  });

  // ------------------------------------------------------------- volume

  const slider = q('.cmp-vol-slider');
  const fill = () => slider.style.setProperty('--fill', `${slider.value}%`);
  function syncVolume() {
    const v = Number(readVolume());
    if (Number.isFinite(v)) slider.value = String(Math.round(v * 100));
    fill();
  }
  slider.addEventListener('input', () => { fill(); setVolume(Number(slider.value) / 100); });
  syncVolume();

  // ------------------------------------------------------------- telemetry

  const tele = { taps: 0, swipes: 0, dragMs: 0 };
  const pad2 = (n) => String(n).padStart(2, '0');
  function renderTelemetry() {
    q('.cmp-taps').textContent = String(tele.taps).padStart(3, '0');
    q('.cmp-swipes').textContent = String(tele.swipes).padStart(3, '0');
    const s = Math.floor(tele.dragMs / 1000);
    q('.cmp-drag').textContent = `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
  }
  let down = null;
  addEventListener('pointerdown', (e) => {
    if (e.target?.closest?.('.cmp-control')) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  }, { passive: true });
  addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > SWIPE_PX) down.moved = true;
  }, { passive: true });
  addEventListener('pointerup', () => {
    if (!down) return;
    if (down.moved) { tele.swipes++; tele.dragMs += performance.now() - down.t; } else tele.taps++;
    down = null;
    renderTelemetry();
  }, { passive: true });
  addEventListener('pointercancel', () => { down = null; }, { passive: true });
  renderTelemetry();

  function setConnected(ok) {
    q('.cmp-conn').textContent = ok ? 'LINKED' : 'SYNCING';
  }

  // ------------------------------------------------------------- hidden debug

  let debugOn = false;
  let debugOff = null;
  function setDebug(on) {
    debugOn = on;
    clearTimeout(debugOff);
    if (on) debugOff = setTimeout(() => setDebug(false), DEBUG_FOR_MS);
    onDebug?.(on);
  }
  const hotspot = q('.cmp-hotspot');
  let holdTimer = null;
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  hotspot.addEventListener('pointerdown', () => {
    cancelHold();
    holdTimer = setTimeout(() => { holdTimer = null; setDebug(!debugOn); }, DEBUG_HOLD_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) hotspot.addEventListener(type, cancelHold);

  rest();

  return {
    showWord,
    setPhase,
    setConnected,
    /** The last word, from a reconnect's snapshot: idle shows it, nothing pops. */
    setLastWord(word) { if (word) { lastWord = String(word).toUpperCase(); if (view === 'idle') rest(); } },
    get hanging() { return hanging; },
    gravity,
    /** Out of debug, whatever it was: the phone is back on the charger. */
    hideDebug() { cancelHold(); if (debugOn) setDebug(false); },
  };
}
