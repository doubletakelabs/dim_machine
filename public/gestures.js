/**
 * What a finger on the glass means.
 *
 * Split out of client.js so it can be run without a handset. `hold` shipped
 * missing entirely — implemented in the test harness's driver page and never in
 * the client — and nothing could have failed, because nothing here was
 * reachable except by a person touching a screen. Two other faults in this file
 * had the same property.
 *
 * Everything below is a pure function of the events it is handed. No DOM, no
 * sockets, no audio, no `Date.now`: the clock and the timers come in through the
 * options so a test can hold a finger down for four hundred milliseconds without
 * waiting four hundred milliseconds. What to *do* with a recognised gesture —
 * which socket it goes down, what the readout says — stays in client.js, which
 * is the part that genuinely needs a browser.
 */

export const HOLD_MS = 400;          // a finger that stays put this long is holding, not tapping
export const SWIPE_MIN_PX = 60;      // shorter than this is a slip, not a swipe
export const SWIPE_MAX_MS = 900;     // slower than this is a drag
/**
 * A finger that stayed put is a tap, however long it rested there.
 *
 * There was a 400ms ceiling on this and it was wrong: told to TAP THE SCREEN,
 * people press deliberately, and a firm press is easily half a second. A guest
 * whose tap is rejected for being *too committed* has no way to know that, and
 * the only feedback available is a screen that refuses to move.
 */
export const TAP_MAX_PX = 20;        // a fingertip wobbles; this is not a mouse
/**
 * A finger moved around the glass, answered once when it lifts. Measured along
 * the path rather than start to end, because "drag your finger around" often
 * finishes where it began — which by distance alone would read as a tap.
 * Roughly one and a half widths of a phone screen.
 */
export const DRAG_MIN_PX = 500;
/** A travel this much longer than its start-to-end distance is not a straight swipe. */
const SWIPE_MAX_WANDER = 1.5;
export const GESTURE_MIN_GAP_MS = 400; // a nervous double-tap is one answer, not two

/**
 * @param {object} [opts]
 * @param {() => 'gestures'|'stream'} [opts.mode] — read at the moment of each event, not captured
 * @param {() => number} [opts.now]
 * @param {(fn: Function, ms: number) => any} [opts.setTimer]
 * @param {(id: any) => void} [opts.clearTimer]
 * @param {() => void} [opts.onTouch] — any contact at all, gesture or not
 * @param {(type: string, payload: object) => void} [opts.onGesture] — `tap` | `swipe` | `drag`
 * @param {(on: boolean) => void} [opts.onHold]
 * @param {(x: number, y: number) => void} [opts.onStreamBegin]
 * @param {(x: number, y: number) => void} [opts.onStreamMove]
 * @param {() => void} [opts.onStreamEnd]
 */
export function createGestureRecogniser(opts = {}) {
  const {
    mode = () => 'gestures',
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onTouch = () => {},
    onGesture = () => {},
    onHold = () => {},
    onStreamBegin = () => {},
    onStreamMove = () => {},
    onStreamEnd = () => {},
  } = opts;

  let start = null;
  // A press that stays put is a hold. Only ever streamed: a hold is a state a
  // finger is in rather than something that happened, which is why it is not an
  // input the statechart can bind — see INPUT_KINDS.
  let holding = false;
  let holdTimer = null;

  const cancelHold = () => {
    clearTimer(holdTimer);
    holdTimer = null;
    if (!holding) return;
    holding = false;
    onHold(false);
  };

  const begin = (x, y) => {
    // iOS will refuse to resume an AudioContext outside a user gesture, so every
    // touch is an opportunity worth taking whether or not it becomes a gesture.
    onTouch();
    start = { x, y, at: now(), lastX: x, lastY: y, path: 0 };
    if (mode() !== 'stream') return;
    onStreamBegin(x, y);
    holdTimer = setTimer(() => {
      holdTimer = null;
      holding = true;
      onHold(true);
    }, HOLD_MS);
  };

  const move = (x, y) => {
    if (start) {
      start.path += Math.hypot(x - start.lastX, y - start.lastY);
      start.lastX = x;
      start.lastY = y;
    }
    if (mode() !== 'stream') return;
    // Moved far enough to be a drag, so it was never a hold.
    if (start && Math.hypot(x - start.x, y - start.y) > TAP_MAX_PX) cancelHold();
    onStreamMove(x, y);
  };

  const end = (x, y) => {
    const wasHolding = holding;
    cancelHold();
    if (mode() === 'stream') onStreamEnd();
    if (!start) return;
    const { x: x0, y: y0, at, lastX, lastY } = start;
    const path = start.path + Math.hypot(x - lastX, y - lastY);
    start = null;
    // A hold that ended is not also a tap, however still the finger was.
    if (wasHolding) return;
    const dx = x - x0;
    const dy = y - y0;
    const dist = Math.hypot(dx, dy);
    const ms = now() - at;
    const straight = path <= dist * SWIPE_MAX_WANDER;
    if (dist >= SWIPE_MIN_PX && ms <= SWIPE_MAX_MS && straight) {
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      onGesture('swipe', {
        direction: horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'),
        dx: Math.round(dx),
        dy: Math.round(dy),
      });
    } else if (path >= DRAG_MIN_PX) {
      // Streamed already, move by move, to the room's experience.
      if (mode() !== 'stream') onGesture('drag', { path: Math.round(path), ms });
    } else if (dist <= TAP_MAX_PX) {
      onGesture('tap', { x: Math.round(x), y: Math.round(y) });
    }
    // Anything else — a slow short drag — is a finger changing its mind.
  };

  /**
   * The finger left the glass without an `end` — a touch cancelled by the OS, a
   * phone call, a notification pulled down. Whatever was held has to be let go,
   * or the room holds it forever.
   */
  const abort = () => {
    const wasStreaming = start && mode() === 'stream';
    cancelHold();
    start = null;
    if (wasStreaming) onStreamEnd();
  };

  return {
    begin,
    move,
    end,
    abort,
    get holding() { return holding; },
    get touching() { return start !== null; },
  };
}

/**
 * One answer per press.
 *
 * Only ever applied to the statechart: a nervous double-tap on a screen that
 * says TAP TO CONTINUE is one person answering once, and letting both through
 * skips a beat of the show. A room experience wants every tap it is given, so
 * the routing decides whether to consult this — it is not baked into the
 * recogniser.
 */
export function createRepeatGuard({ now = () => Date.now(), minGapMs = GESTURE_MIN_GAP_MS } = {}) {
  let last = -Infinity;
  return {
    allow() {
      const t = now();
      if (t - last < minGapMs) return false;
      last = t;
      return true;
    },
  };
}
