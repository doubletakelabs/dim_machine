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

import {
  CUE_SLOTS, SCREEN_CUE_SLOT, EXPERIENCE_CUE_SLOT, cueAudienceMatches,
} from './contract.js';

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

      const screen = slot === SCREEN_CUE_SLOT;
      const experience = slot === EXPERIENCE_CUE_SLOT;

      // Stop first, and only when the outgoing asset is not the incoming one —
      // re-sending the same asset would otherwise cut itself off mid-word, or
      // blank a screen for a frame before redrawing the same image.
      if (have && have.assetId !== want?.assetId) {
        this.emitCue(guestId, experience
          ? { cueId: `cue-${++this._seq}`, kind: 'endExperience', assetId: have.assetId, slot }
          : screen
          ? { cueId: `cue-${++this._seq}`, kind: 'clearImage', assetId: have.assetId, slot }
          : {
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
      this.emitCue(guestId, experience
        ? {
          cueId: `cue-${++this._seq}`,
          kind: 'experience',
          slot,
          assetId: want.assetId,
          endpoint: want.endpoint,
          experienceId: want.experienceId,
          inputMode: want.inputMode,
          inputs: want.inputs,
          driverId: want.driverId,
          hue: want.hue,
          secret: want.secret,
        }
        : screen
        ? { cueId: `cue-${++this._seq}`, kind: 'image', assetId: want.assetId, startAt: want.startAt, slot }
        : {
          cueId: `cue-${++this._seq}`,
          kind: 'audio',
          assetId: want.assetId,
          startAt: want.startAt,
          loop: !!want.loop,
          gain: want.gain ?? 1,
          // Late arrivals hear the room where it actually is. A one-shot that
          // already finished is dropped by the client rather than restarted.
          seek: want.seek !== false,
          // A segment of a longer file. One recording can carry a whole
          // sequence, which matters when the sequence is self-paced and a
          // single timeline could not stay with it.
          ...(want.offset != null ? { offset: want.offset } : {}),
          ...(want.duration != null ? { duration: want.duration } : {}),
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
  const declared = pickDeclared(room?.cues, state);
  if (!declared) return null;
  const options = Array.isArray(declared) ? declared : [declared];
  for (const option of options) {
    if (!cueAudienceMatches(option.audience, standing, room.kind)) continue;
    // An explicit silence for this audience — and a blank screen with it.
    if (!option.audio && !option.image) return null;
    return { ...option, assetId: option.audio, startAt, key: `${state}:${startAt}` };
  }
  return null;
}

/**
 * A cue may name a state exactly, or name an ancestor of it. Rooms and guest
 * regions both nest, so both need the fallback — the calibration sequence lives
 * at `guidance.prologue.tapTest`, and a cue on `guidance.prologue` covering the
 * whole branch has to keep working.
 */
function pickDeclared(cues, state) {
  if (!cues || state == null) return null;
  const path = String(state).split('.');
  for (let i = path.length; i > 0; i--) {
    const declared = cues[path.slice(0, i).join('.')];
    if (declared) return declared;
  }
  return null;
}

/**
 * The sounding half of a resolved cue, or null if it declares only a screen.
 * Splitting here rather than in the resolvers is what lets one authored cue
 * put an image up and a voice over it without the director knowing they came
 * from the same line of show JSON.
 */
export function audioPart(cue) {
  if (!cue?.assetId) return null;
  return { ...cue, key: `${cue.key}:a:${cue.assetId}` };
}

/** The visible half of a resolved cue, or null if it is sound only. */
export function screenPart(cue) {
  if (!cue?.image) return null;
  return { assetId: cue.image, startAt: cue.startAt, key: `${cue.key}:i:${cue.image}` };
}

/**
 * Resolve a cue from one of the guest machine's authored regions.
 * Keys are region-qualified (`guidance.leadingToMuseum`) because two parallel
 * regions may reasonably name a state the same thing.
 */
export function guestCueFor(show, region, state, startAt) {
  if (!state) return null;
  const declared = pickDeclared(show?.guest?.cues, `${region}.${state}`);
  if (!declared || (!declared.audio && !declared.image)) return null;
  return {
    ...declared,
    assetId: declared.audio,
    startAt,
    key: `${region}.${state}:${startAt}`,
  };
}
