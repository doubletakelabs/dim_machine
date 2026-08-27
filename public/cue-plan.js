/**
 * What to do with an audio cue, decided where a test can reach it.
 *
 * client.js owns the AudioContext; this owns the choice — play now, schedule
 * ahead, seek into the middle, or skip. The choice is where the show lives:
 * a guest who walks in halfway through must join the audio where it is, a
 * one-shot that already finished must stay finished, and a cue named for a
 * slice of a longer recording must stay inside its slice. All of that was
 * branching inside a function that needed a phone in a hand to run, which is
 * how three faults hid in this file before it. Phase B rewrites exactly this
 * logic; now it can rewrite it against tests.
 *
 * @param {object} cue — { startAt, loop?, seek?, offset?, duration? }
 * @param {number} bufferDuration — seconds of decoded audio
 * @param {number} serverNow — the show clock, ms
 * @param {{ seekIntoLoop?: boolean }} [opts] — set on resync: a loop being
 *   re-sent should be joined where it is, not restarted
 * @returns {{ action: 'skip'|'schedule'|'start', reason?: string,
 *   at?: number, startOffset?: number, startDuration?: number|null,
 *   loopStart?: number|null, loopEnd?: number|null, span?: number }}
 */
export function planAudio(cue, bufferDuration, serverNow, { seekIntoLoop = false } = {}) {
  // A cue may name a slice of a longer file rather than the whole of it, so
  // one recording can carry a sequence the guest paces themselves through.
  // Every position below is relative to `base`, and `span` is the wall it
  // stops at.
  const base = cue.offset ?? 0;
  const span = cue.duration != null
    ? Math.min(cue.duration, Math.max(0, bufferDuration - base))
    : Math.max(0, bufferDuration - base);
  if (span <= 0) return { action: 'skip', reason: 'empty' };

  const loop = !!cue.loop;
  const bounds = loop ? { loopStart: base, loopEnd: base + span } : { loopStart: null, loopEnd: null };
  // `duration` on start() would end a looping source rather than wrap it, so a
  // looping segment is bounded by its loop points and never by a duration arg.
  const args = (into) => ({
    startOffset: base + into,
    startDuration: !loop && (cue.duration != null || base > 0) ? span - into : null,
  });

  if (cue.startAt > serverNow) {
    return { action: 'schedule', at: cue.startAt, ...args(0), ...bounds, span };
  }
  if (cue.seek || (loop && seekIntoLoop)) {
    // Walked in halfway through: join the content where it actually is rather
    // than starting it over. A one-shot that already finished is simply missed.
    const elapsed = (serverNow - cue.startAt) / 1000;
    if (!loop && elapsed >= span) return { action: 'skip', reason: 'finished' };
    return { action: 'start', ...args(loop ? elapsed % span : Math.max(0, elapsed)), ...bounds, span };
  }
  if (serverNow - cue.startAt < 500) {
    return { action: 'start', ...args(0), ...bounds, span };
  }
  return { action: 'skip', reason: 'stale' };
}
