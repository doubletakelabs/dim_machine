/**
 * Cue director — the thin audio layer (spec §8, partial).
 *
 * Turns show state into sound on a phone. Everything Phase B needs beyond this
 * (master timelines, join policies, layer mixing) is deliberately absent; see
 * TECH-DEBT.md §2.
 *
 * ## Why this reconciles rather than fires
 *
 * The obvious build is event-driven: a room enters `active`, send everyone
 * inside a play cue. It is also wrong, and wrong in the way this codebase has
 * been wrong three times already — it stores what happened and then describes a
 * moment that has passed. A guest who walks in thirty seconds after the room
 * activated missed the event and hears nothing, forever.
 *
 * So the director computes, for a guest, the cues they *should* be hearing right
 * now, diffs that against what they were last told, and sends only the
 * difference. Walking into a running room, being promoted from spectator to
 * participant, and reconnecting a dropped phone are then all the same operation,
 * and none of them is special-cased below.
 *
 * A cue's `startAt` is when its source state was entered, not when the cue was
 * sent — which is what lets a phone joining late seek into the audio instead of
 * starting it over. That only works while `startAt` is stable across reconciles,
 * so it comes from the room or region timestamp and never from `now`.
 */

import { CUE_SLOTS, cueAudienceMatches } from './contract.js';

export class CueDirector {
  /**
   * @param {object} opts
   * @param {(guestId: string, cue: object) => void} opts.emitCue
   * @param {object} [opts.clock]
   */
  constructor(opts) {
    this.emitCue = opts.emitCue;
    this.clock = opts.clock ?? { now: () => Date.now() };
    /** guestId → slot → { key, assetId, fadeMs } */
    this.playing = new Map();
    this._seq = 0;
    this.show = null;
  }

  load(show) {
    this.show = show;
    this.playing.clear();
  }

  /**
   * Forget what a phone was told. Its next reconcile re-sends every slot from
   * scratch, which is exactly what a phone that just reconnected needs — it came
   * back with silence and no memory.
   */
  resetGuest(guestId) {
    this.playing.delete(guestId);
  }

  dropGuest(guestId) {
    this.playing.delete(guestId);
  }

  /**
   * Bring every guest's audio in line with the world. Cheap enough to call on
   * any state change: a handful of map lookups per guest, and it sends nothing
   * when nothing differs.
   *
   * @param {Iterable<{ guestId: string, desired: Map<string, object> }>} guests
   */
  reconcileAll(guests) {
    for (const { guestId, desired } of guests) this.reconcile(guestId, desired);
  }

  /**
   * @param {string} guestId
   * @param {Map<string, object|null>} desired — slot → cue spec, or null for silence
   */
  reconcile(guestId, desired) {
    let current = this.playing.get(guestId);
    if (!current) {
      current = new Map();
      this.playing.set(guestId, current);
    }
    for (const slot of CUE_SLOTS) {
      const want = desired.get(slot) ?? null;
      const have = current.get(slot) ?? null;
      if ((want?.key ?? null) === (have?.key ?? null)) continue;

      // Stop first, and only when the outgoing asset is not the incoming one —
      // re-sending the same asset would otherwise cut itself off mid-word.
      if (have && have.assetId !== want?.assetId) {
        this.emitCue(guestId, {
          cueId: `cue-${++this._seq}`,
          kind: 'stopAudio',
          assetId: have.assetId,
          fadeMs: have.fadeMs ?? 400,
        });
      }
      if (!want) {
        current.delete(slot);
        continue;
      }
      this.emitCue(guestId, {
        cueId: `cue-${++this._seq}`,
        kind: 'audio',
        assetId: want.assetId,
        startAt: want.startAt,
        loop: !!want.loop,
        gain: want.gain ?? 1,
        // Late arrivals hear the room where it actually is. A one-shot that
        // already finished is dropped by the client rather than restarted.
        seek: want.seek !== false,
        slot,
      });
      current.set(slot, { key: want.key, assetId: want.assetId, fadeMs: want.fadeMs });
    }
  }

  /** What is this guest hearing, for the operator panel. */
  snapshot(guestId) {
    const current = this.playing.get(guestId);
    if (!current) return {};
    return Object.fromEntries([...current.entries()].map(([slot, c]) => [slot, c.assetId]));
  }
}

/**
 * Resolve the cue a guest gets from a room, given where they stand in it.
 *
 * Standing is the whole point. A room declares its `active` audio once and
 * separately declares what a spectator hears; which of those a given guest gets
 * is decided here, from the standing the guest actor derived. That is why
 * `multiGuest: "spectator"` finally does something audible.
 *
 * @param {object} room — room definition
 * @param {string} state — the room's current presentation state
 * @param {string} standing
 * @param {number} startAt
 */
export function roomCueFor(room, state, standing, startAt) {
  // Rooms may sit in a nested state (`active.main`). A cue keyed on the root
  // covers the whole branch; a cue keyed on the full dotted path wins over it.
  // Reading only the dotted string here is the bug that ate `REQUIRES_LOCK`.
  const declared = room?.cues?.[state] ?? room?.cues?.[String(state).split('.')[0]];
  if (!declared) return null;
  const options = Array.isArray(declared) ? declared : [declared];
  for (const option of options) {
    if (!cueAudienceMatches(option.audience, standing, room.kind)) continue;
    if (!option.audio) return null; // an explicit silence for this audience
    return { ...option, assetId: option.audio, startAt, key: `${state}:${option.audio}:${startAt}` };
  }
  return null;
}

/**
 * Resolve a cue from one of the guest machine's authored regions.
 * Keys are region-qualified (`guidance.leadingToMuseum`) because two parallel
 * regions may reasonably name a state the same thing.
 */
export function guestCueFor(show, region, state, startAt) {
  if (!state) return null;
  const declared = show?.guest?.cues?.[`${region}.${state}`];
  if (!declared?.audio) return null;
  return {
    ...declared,
    assetId: declared.audio,
    startAt,
    key: `${region}.${state}:${declared.audio}:${startAt}`,
  };
}
