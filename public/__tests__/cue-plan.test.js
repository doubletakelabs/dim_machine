/**
 * The audio-cue decision: play now, schedule ahead, seek in, or skip.
 *
 * Extracted from playAudio, where it branched against a live AudioContext and
 * could only be exercised by a person wearing headphones. Every case here is a
 * guest somewhere: arriving early, on time, late, or after it is all over.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planAudio } from '../cue-plan.js';

const NOW = 1_000_000;
const BUF = 30; // seconds of decoded audio

describe('a cue for the future', () => {
  it('schedules at its start time', () => {
    const p = planAudio({ startAt: NOW + 2000 }, BUF, NOW);
    assert.equal(p.action, 'schedule');
    assert.equal(p.at, NOW + 2000);
    assert.equal(p.startOffset, 0);
    assert.equal(p.startDuration, null);
  });
});

describe('a cue that just fired', () => {
  it('plays from the top inside the grace window', () => {
    const p = planAudio({ startAt: NOW - 499 }, BUF, NOW);
    assert.equal(p.action, 'start');
    assert.equal(p.startOffset, 0);
  });

  it('is stale past the grace window — a missed one-shot stays missed', () => {
    const p = planAudio({ startAt: NOW - 500 }, BUF, NOW);
    assert.deepEqual([p.action, p.reason], ['skip', 'stale']);
  });
});

describe('joining content already running', () => {
  it('seeks a one-shot to where it is', () => {
    const p = planAudio({ startAt: NOW - 10_000, seek: true }, BUF, NOW);
    assert.equal(p.action, 'start');
    assert.equal(p.startOffset, 10);
  });

  it('skips a one-shot that already ended', () => {
    const p = planAudio({ startAt: NOW - 31_000, seek: true }, BUF, NOW);
    assert.deepEqual([p.action, p.reason], ['skip', 'finished']);
  });

  it('wraps into a loop by however many laps have passed', () => {
    // 70 seconds into a 30-second loop is 10 seconds into its third lap.
    const p = planAudio({ startAt: NOW - 70_000, loop: true }, BUF, NOW, { seekIntoLoop: true });
    assert.equal(p.action, 'start');
    assert.ok(Math.abs(p.startOffset - 10) < 1e-9);
    assert.equal(p.loopStart, 0);
    assert.equal(p.loopEnd, 30);
  });

  it('does not seek a loop unless the resync asked it to', () => {
    // A freshly cued loop starts at its top; only a re-send after a wake or a
    // reconnect joins it mid-lap.
    const p = planAudio({ startAt: NOW - 70_000, loop: true }, BUF, NOW);
    assert.equal(p.action, 'skip');
  });
});

describe('a cue naming a slice of a longer file', () => {
  it('plays only its slice', () => {
    const p = planAudio({ startAt: NOW, offset: 5, duration: 10 }, BUF, NOW);
    assert.equal(p.startOffset, 5);
    assert.equal(p.startDuration, 10);
  });

  it('seeks within the slice, not within the file', () => {
    const p = planAudio({ startAt: NOW - 4000, seek: true, offset: 5, duration: 10 }, BUF, NOW);
    assert.equal(p.startOffset, 9, 'four seconds into a slice that begins at five');
    assert.equal(p.startDuration, 6, 'and only the rest of the slice remains');
  });

  it('cannot run past the end of the recording', () => {
    const p = planAudio({ startAt: NOW, offset: 25, duration: 60 }, BUF, NOW);
    assert.equal(p.startDuration, 5, 'the file ends before the declared duration');
  });

  it('skips a slice that starts beyond the file entirely', () => {
    const p = planAudio({ startAt: NOW, offset: 40 }, BUF, NOW);
    assert.deepEqual([p.action, p.reason], ['skip', 'empty']);
  });

  it('bounds a looping slice by loop points, never by a duration', () => {
    // A duration on start() would end a looping source rather than wrap it —
    // the difference between a texture and a texture that dies mid-show.
    const p = planAudio({ startAt: NOW, loop: true, offset: 5, duration: 10 }, BUF, NOW);
    assert.equal(p.startDuration, null);
    assert.equal(p.loopStart, 5);
    assert.equal(p.loopEnd, 15);
  });
});
