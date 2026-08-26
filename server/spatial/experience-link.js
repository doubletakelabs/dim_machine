/**
 * The link between the show and one room's experience.
 *
 * A room may hand its interaction to a separate piece — a wall, a projection, a
 * thing with its own physics — running its own server on a machine in that room.
 * This is the show's end of that link. It connects as a **broker**: it tells the
 * experience who is driving and what the room is doing, and it never carries a
 * guest's finger. That goes straight from the phone to the room server, because
 * at sixty messages a second a detour through here would be jitter for nothing.
 *
 * ## Two rules this is built on
 *
 * **Drivers are sent as a set, never as changes.** `{drivers: [...]}` is the
 * whole truth every time. An experience that reconnects, or restarts, or was
 * launched an hour late is correct on the first message it receives — the same
 * reason the cue director reconciles rather than fires, applied across a
 * network where the other end is a separate program that can be restarted by
 * someone standing next to it.
 *
 * **The show says when the piece is live, not the socket count.** Left alone, a
 * piece infers "nobody is here" from having no controllers connected. In a show
 * that is wrong: a guest can be standing in the room as a spectator, before the
 * room activates, or on somebody else's path. `lifecycle` is the show telling it
 * what is true.
 *
 * ## When the room server is not there
 *
 * The show carries on. A dark wall is bad; a room that will not admit anyone
 * because a projector machine is unplugged is worse, and it takes the rest of
 * the night with it. So this reconnects quietly on a backoff, reports its state
 * for the operator panel, and never blocks anything.
 */

import { EXPERIENCE_LIFECYCLE } from './contract.js';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export class ExperienceLink {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {object} opts.config — the room's `experience` block
   * @param {object} [opts.clock]
   * @param {(url: string) => object} [opts.openSocket] — injected for tests
   * @param {(roomId: string) => void} [opts.onChange]
   */
  constructor(opts) {
    this.roomId = opts.roomId;
    this.config = opts.config;
    this.clock = opts.clock ?? { now: () => Date.now(), setTimeout, clearTimeout };
    this.openSocket = opts.openSocket ?? null;
    this.onChange = opts.onChange ?? (() => {});

    this.socket = null;
    this.state = 'idle';           // idle | connecting | ready | unreachable
    this.remote = null;            // what the experience said about itself
    this.lastError = null;
    this._attempt = 0;
    this._retry = null;
    /** Last payload sent per kind, so a reconnect resends and a repeat does not. */
    this._sent = new Map();
    this._desired = { lifecycle: 'attract', drivers: [] };
  }

  /** Begin trying. Safe to call repeatedly. */
  start() {
    if (this.state === 'connecting' || this.state === 'ready') return;
    this._connect();
  }

  stop() {
    this._clearRetry();
    this._sent.clear();
    const socket = this.socket;
    this.socket = null;
    this.state = 'idle';
    try { socket?.close(); } catch { /* already gone */ }
  }

  /**
   * What the experience should believe right now. Idempotent: sending the same
   * thing twice puts nothing on the wire.
   *
   * @param {{ lifecycle: string, drivers: Array<object> }} desired
   */
  reconcile(desired) {
    this._desired = {
      lifecycle: EXPERIENCE_LIFECYCLE.includes(desired.lifecycle) ? desired.lifecycle : 'attract',
      drivers: desired.drivers ?? [],
    };
    this._flush();
  }

  _flush() {
    if (this.state !== 'ready') return;
    this._sendIfChanged('lifecycle', { t: 'lifecycle', state: this._desired.lifecycle });
    this._sendIfChanged('drivers', { t: 'drivers', drivers: this._desired.drivers });
  }

  _sendIfChanged(key, message) {
    const encoded = JSON.stringify(message);
    if (this._sent.get(key) === encoded) return;
    this._sent.set(key, encoded);
    try {
      this.socket.send(encoded);
    } catch (err) {
      // The socket died between the readyState check and the write. Let the
      // close handler deal with it rather than guessing here.
      this._sent.delete(key);
      this.lastError = err.message;
    }
  }

  _connect() {
    if (!this.openSocket || !this.config?.endpoint) {
      this.state = 'idle';
      return;
    }
    this.state = 'connecting';
    this._sent.clear();
    let socket;
    try {
      socket = this.openSocket(this.config.endpoint);
    } catch (err) {
      return this._failed(err.message);
    }
    this.socket = socket;

    socket.on('open', () => {
      this._attempt = 0;
      this.state = 'ready';
      this.lastError = null;
      socket.send(JSON.stringify({
        t: 'hello',
        role: 'broker',
        experienceId: this.config.experienceId ?? null,
        roomId: this.roomId,
        contract: 1,
      }));
      // Everything true about the room, on a link that has just been made. The
      // experience may have been running for an hour or started a second ago;
      // neither needs handling because the first message is the whole state.
      this._flush();
      this.onChange(this.roomId);
    });

    socket.on('message', (raw) => this._receive(raw));
    socket.on('error', (err) => { this.lastError = err?.message ?? 'socket error'; });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this._failed(this.lastError ?? 'closed');
    });
  }

  _receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.t === 'ready') {
      this.remote = {
        experienceId: message.experienceId ?? null,
        version: message.version ?? null,
        accepts: message.accepts ?? [],
        maxDrivers: message.maxDrivers ?? null,
      };
      this.onChange(this.roomId);
    }
  }

  _failed(reason) {
    this.state = 'unreachable';
    this.lastError = reason;
    this._sent.clear();
    this.onChange(this.roomId);
    this._scheduleRetry();
  }

  _scheduleRetry() {
    this._clearRetry();
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** this._attempt++, RECONNECT_MAX_MS);
    this._retry = this.clock.setTimeout(() => {
      this._retry = null;
      this._connect();
    }, delay);
  }

  _clearRetry() {
    if (this._retry == null) return;
    this.clock.clearTimeout(this._retry);
    this._retry = null;
  }

  /** For the operator panel: is the room's wall actually there. */
  snapshot() {
    return {
      roomId: this.roomId,
      experienceId: this.config?.experienceId ?? null,
      endpoint: this.config?.endpoint ?? null,
      state: this.state,
      lastError: this.lastError,
      remote: this.remote,
      lifecycle: this._desired.lifecycle,
      drivers: this._desired.drivers.length,
    };
  }
}
