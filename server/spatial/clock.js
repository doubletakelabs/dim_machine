/**
 * The show clock (spec v0.3 §5.4, §12).
 *
 * Every time-dependent part of the runtime reads `now()` from one Clock and
 * schedules timers through it — the coordinator's hysteresis and dwell holds,
 * the runtime's event stamps, and the XState `after` transitions inside room
 * machines (XState accepts a clock with exactly the `setTimeout`/`clearTimeout`
 * shape below).
 *
 * This exists so scripted walkthroughs can replay movement at speed and the
 * event log can be replayed deterministically. Anything calling `Date.now()`
 * directly is outside the clock and breaks both.
 */

/** Wall-clock. Production default. */
export class SystemClock {
  now() {
    return Date.now();
  }

  setTimeout(fn, ms) {
    return setTimeout(fn, ms);
  }

  clearTimeout(handle) {
    clearTimeout(handle);
  }
}

/**
 * Manually advanced clock for tests, scripted walkthroughs, and replay.
 * Timers fire in due order as time is advanced, and timers scheduled by a
 * firing timer are honoured within the same `advance()` call.
 */
export class ManualClock {
  /** @param {number} [startMs] */
  constructor(startMs = 0) {
    this.t = startMs;
    this._seq = 0;
    /** @type {Map<number, { at: number, fn: Function, seq: number }>} */
    this._timers = new Map();
  }

  now() {
    return this.t;
  }

  setTimeout(fn, ms) {
    const id = ++this._seq;
    this._timers.set(id, { at: this.t + Math.max(0, ms || 0), fn, seq: id });
    return id;
  }

  clearTimeout(handle) {
    this._timers.delete(handle);
  }

  /**
   * Advance to `t + ms`, firing every timer due along the way in due order.
   * Time is set to each timer's due point before it fires, so a timer that
   * schedules another timer measures from the correct instant.
   * @param {number} ms
   */
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this._timers.values()]
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this._timers.delete(due.seq);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }

  /** @param {number} ms */
  set(ms) {
    if (ms < this.t) throw new Error('ManualClock cannot move backwards');
    this.advance(ms - this.t);
  }
}

/**
 * Wall-clock running at a multiple of real time, changeable while the show runs.
 *
 * This is what makes the test panel usable: a 20-second dwell threshold is
 * tedious to sit through when you are checking whether "seen" fires, and
 * unbearable when you are checking it for twelve guests. At 10× it is two
 * seconds. Rate 0 pauses the show outright — timers stop and `now()` stops
 * advancing — which is the other thing you want when something looks wrong.
 *
 * **Test mode only.** While room output is a stub logger, scaling time costs
 * nothing. Once Phase B schedules real phone audio against a shared clock,
 * running the server at anything but 1× would desync every device.
 */
export class ScaledClock {
  /** @param {number} [rate] */
  constructor(rate = 1) {
    this._rate = rate;
    this._virtualBase = Date.now();
    this._realBase = Date.now();
    this._seq = 0;
    /** @type {Map<number, { dueVirtual: number, fn: Function, real: any }>} */
    this._timers = new Map();
  }

  get rate() {
    return this._rate;
  }

  now() {
    if (this._rate <= 0) return this._virtualBase;
    return this._virtualBase + (Date.now() - this._realBase) * this._rate;
  }

  /**
   * Change speed without discontinuity: virtual time is re-based at the current
   * instant, then every pending timer is re-armed against the new rate. Without
   * the re-arm, a timer scheduled at 1× would still fire at 1× after a switch
   * to 10×, and the room would sit there looking broken.
   *
   * @param {number} rate — 0 pauses; 1 is real time
   */
  setRate(rate) {
    this._virtualBase = this.now();
    this._realBase = Date.now();
    this._rate = Math.max(0, rate);
    for (const [id, timer] of this._timers) {
      if (timer.real != null) clearTimeout(timer.real);
      timer.real = null;
      this._arm(id, timer);
    }
  }

  setTimeout(fn, ms) {
    const id = ++this._seq;
    const timer = { dueVirtual: this.now() + Math.max(0, ms || 0), fn, real: null };
    this._timers.set(id, timer);
    this._arm(id, timer);
    return id;
  }

  _arm(id, timer) {
    // Paused: hold the timer, do not drop it. It re-arms when the rate returns.
    if (this._rate <= 0) return;
    const realDelay = Math.max(0, (timer.dueVirtual - this.now()) / this._rate);
    timer.real = setTimeout(() => {
      this._timers.delete(id);
      timer.fn();
    }, realDelay);
  }

  clearTimeout(handle) {
    const timer = this._timers.get(handle);
    if (!timer) return;
    if (timer.real != null) clearTimeout(timer.real);
    this._timers.delete(handle);
  }
}

export const systemClock = new SystemClock();
