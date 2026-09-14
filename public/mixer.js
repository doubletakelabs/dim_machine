/**
 * The mixer's decisions, made where a test can reach them.
 *
 * client.js owns the AudioContext and the gain nodes; this owns the choices —
 * how far the room bed ducks while a voice speaks, when the duck releases,
 * and how long a handover fades. The lesson behind the split is the standing
 * one from cue-plan.js: every decision that lived only inside a function
 * needing a phone in a hand has eventually hidden a fault.
 *
 * The semantics are fixed; the show only tunes the numbers. A spoken line in
 * `guidance` or `adherence` ducks the `room` bed under it (decided 2026-09-13:
 * duck, not pause — the room stays alive under the narration), and a room-bed
 * handover crossfades rather than cutting (walking through a doorway, not a
 * channel change).
 */

/** What a show gets when it declares nothing: sensible, audible, gentle. */
export const AUDIO_LAYER_DEFAULTS = { duckTo: 0.25, duckMs: 300, crossfadeMs: 1000 };

/**
 * The show's `guest.audioLayers`, with defaults filled and nonsense clamped.
 * `duckTo: 1` is the authored way to switch ducking off.
 *
 * @param {object|null|undefined} raw
 * @returns {{ duckTo: number, duckMs: number, crossfadeMs: number }}
 */
export function mixerConfig(raw) {
  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return {
    duckTo: Math.min(1, Math.max(0, num(raw?.duckTo, AUDIO_LAYER_DEFAULTS.duckTo))),
    duckMs: Math.max(0, num(raw?.duckMs, AUDIO_LAYER_DEFAULTS.duckMs)),
    crossfadeMs: Math.max(0, num(raw?.crossfadeMs, AUDIO_LAYER_DEFAULTS.crossfadeMs)),
  };
}

/**
 * Should the room bed be ducked right now, and when could that answer change
 * on its own?
 *
 * `voices` is every currently-sounding cue in a voice slot, each with the
 * server-clock time its audio runs out — or `null` for a voice that loops,
 * which holds the duck until it is stopped. `nextCheckAt` is the earliest
 * moment a voice ends by itself; the caller re-asks then. It is null when no
 * re-check would change anything — silence, or only loops — because a timer
 * that fires to discover nothing changed is how clocks drift into bugs.
 *
 * @param {Array<{ endsAt: number|null }>} voices
 * @param {number} now — server clock, ms
 * @returns {{ ducked: boolean, nextCheckAt: number|null }}
 */
export function duckDecision(voices, now) {
  let ducked = false;
  let nextCheckAt = null;
  for (const voice of voices) {
    if (voice.endsAt == null) {
      ducked = true;
      continue;
    }
    if (voice.endsAt <= now) continue; // ran out; the caller just hasn't swept it yet
    ducked = true;
    if (nextCheckAt == null || voice.endsAt < nextCheckAt) nextCheckAt = voice.endsAt;
  }
  return { ducked, nextCheckAt };
}

/**
 * When a voice cue starts, when does its sound run out?
 *
 * Computed from the plan cue-plan.js already made, so the two can never
 * disagree about how much audio is left: `span` is the playable length and
 * `startOffset - base` is how far in it joined. A loop never runs out.
 *
 * @param {object} cue — { startAt, loop?, offset? }
 * @param {{ span?: number, startOffset?: number, at?: number }} plan
 * @param {number} serverNow — ms
 * @returns {number|null} server-clock ms, or null for a loop
 */
export function voiceEndsAt(cue, plan, serverNow) {
  if (cue.loop) return null;
  const into = (plan.startOffset ?? 0) - (cue.offset ?? 0);
  const remaining = Math.max(0, (plan.span ?? 0) - into) * 1000;
  // A scheduled cue runs out `span` after it starts; one already playing runs
  // out `span - into` from now.
  const begins = plan.at != null ? plan.at : serverNow;
  return begins + remaining;
}
