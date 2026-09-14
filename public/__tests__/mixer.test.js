/**
 * The mixer's decisions — ducking and its release, config defaults and
 * clamping, and when a voice's sound runs out.
 *
 * These rules run on a phone in a dark room; here they run against a clock
 * the test holds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mixerConfig, duckDecision, voiceEndsAt, AUDIO_LAYER_DEFAULTS } from '../mixer.js';

describe('mixerConfig', () => {
  it('an undeclared show gets the defaults', () => {
    assert.deepEqual(mixerConfig(undefined), AUDIO_LAYER_DEFAULTS);
    assert.deepEqual(mixerConfig(null), AUDIO_LAYER_DEFAULTS);
    assert.deepEqual(mixerConfig({}), AUDIO_LAYER_DEFAULTS);
  });

  it('authored numbers win', () => {
    assert.deepEqual(
      mixerConfig({ duckTo: 0.5, duckMs: 120, crossfadeMs: 2000 }),
      { duckTo: 0.5, duckMs: 120, crossfadeMs: 2000 },
    );
  });

  it('duckTo: 1 is how a show turns ducking off', () => {
    assert.equal(mixerConfig({ duckTo: 1 }).duckTo, 1);
  });

  it('clamps nonsense rather than letting it reach a gain node', () => {
    const c = mixerConfig({ duckTo: -3, duckMs: -100, crossfadeMs: 'loud' });
    assert.equal(c.duckTo, 0);
    assert.equal(c.duckMs, 0);
    assert.equal(c.crossfadeMs, AUDIO_LAYER_DEFAULTS.crossfadeMs);
    assert.equal(mixerConfig({ duckTo: 7 }).duckTo, 1);
  });
});

describe('duckDecision', () => {
  it('silence: no duck, no timer', () => {
    assert.deepEqual(duckDecision([], 1000), { ducked: false, nextCheckAt: null });
  });

  it('a speaking voice ducks the bed until it runs out', () => {
    const d = duckDecision([{ endsAt: 5000 }], 1000);
    assert.equal(d.ducked, true);
    assert.equal(d.nextCheckAt, 5000, 're-ask exactly when the voice ends');
  });

  it('a voice that already ran out does not hold the duck', () => {
    assert.deepEqual(duckDecision([{ endsAt: 900 }], 1000), { ducked: false, nextCheckAt: null });
  });

  it('two voices: the duck holds until the LAST one ends, checked at the first', () => {
    // Re-evaluating at the earlier end finds the later voice still speaking
    // and schedules the next check — the duck never releases mid-sentence.
    const first = duckDecision([{ endsAt: 3000 }, { endsAt: 8000 }], 1000);
    assert.equal(first.ducked, true);
    assert.equal(first.nextCheckAt, 3000);
    const second = duckDecision([{ endsAt: 3000 }, { endsAt: 8000 }], 3000);
    assert.equal(second.ducked, true);
    assert.equal(second.nextCheckAt, 8000);
  });

  it('a looping voice holds the duck with no timer — only stopping it releases', () => {
    assert.deepEqual(duckDecision([{ endsAt: null }], 1000), { ducked: true, nextCheckAt: null });
  });

  it('a loop plus a one-shot: ducked, and no pointless timer for the one-shot', () => {
    // When the one-shot ends the answer is still "ducked" — a timer that
    // fires to change nothing is drift waiting to happen. The re-check when
    // the one-shot is swept out will still say ducked.
    const d = duckDecision([{ endsAt: null }, { endsAt: 4000 }], 1000);
    assert.equal(d.ducked, true);
    assert.equal(d.nextCheckAt, 4000, 'still checked, so the sweep happens');
  });
});

describe('voiceEndsAt', () => {
  it('a loop never runs out', () => {
    assert.equal(voiceEndsAt({ loop: true, startAt: 0 }, { span: 3 }, 1000), null);
  });

  it('a fresh one-shot runs out span after now', () => {
    assert.equal(voiceEndsAt({ startAt: 900 }, { span: 3, startOffset: 0 }, 1000), 4000);
  });

  it('a scheduled one-shot runs out span after its start time', () => {
    assert.equal(voiceEndsAt({ startAt: 5000 }, { span: 3, startOffset: 0, at: 5000 }, 1000), 8000);
  });

  it('joining halfway leaves half the sound', () => {
    // planAudio joined 2s into a 5s span; 3s remain from now.
    assert.equal(voiceEndsAt({ startAt: 0 }, { span: 5, startOffset: 2 }, 10000), 13000);
  });

  it('a sliced cue measures from its own offset, not the file start', () => {
    // offset 10 in the file, joined at startOffset 12 — 2s into a 6s span.
    assert.equal(voiceEndsAt({ startAt: 0, offset: 10 }, { span: 6, startOffset: 12 }, 1000), 5000);
  });
});
