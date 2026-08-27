/**
 * The clock estimator every cue's timing rests on.
 *
 * Carried from v0.2 inside client.js and never tested — an error here is not a
 * wrong number in a status bar, it is every phone in the building out of step
 * with every other. The clock takes its idea of "now" injected, so a test can
 * hold time still and reason about pure arithmetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../clock-sync.js';

const clock = () => createClock({ now: () => 1_000_000 });

describe('one sample', () => {
  it('estimates the offset assuming a symmetric trip', () => {
    const c = clock();
    // Sent at 100, server stamped 5000, reply landed at 140: 40ms round trip,
    // so the server's stamp is read as of the midpoint.
    c.addSample(100, 5000, 140);
    assert.equal(c.offset, 5000 + 20 - 140);
    assert.equal(c.rtt, 40);
    assert.equal(c.synced, true);
  });

  it('moves serverNow and toLocal by exactly the offset, in opposite directions', () => {
    const c = clock();
    c.addSample(100, 5000, 140);
    assert.equal(c.serverNow(), 1_000_000 + c.offset);
    assert.equal(c.toLocal(c.serverNow()), 1_000_000);
  });
});

describe('many samples', () => {
  it('trusts the quick trips and ignores a slow outlier', () => {
    const c = clock();
    // Nine clean 40ms trips agreeing on one offset…
    for (let i = 0; i < 9; i++) c.addSample(100, 5000, 140);
    // …then one 2-second stall whose midpoint guess is wildly wrong. The
    // asymmetry of a congested trip is unknowable, which is why RTT is the
    // trust signal: the stall never makes the best-half cut.
    c.addSample(100, 9000, 2100);
    const clean = 5000 + 20 - 140;
    assert.ok(Math.abs(c.offset - clean) < 1, `offset ${c.offset} should stay near ${clean}`);
  });

  it('bends toward a genuinely changed offset rather than yanking', () => {
    const c = clock();
    c.addSample(100, 5000, 140);
    const before = c.offset;
    // The next sample says the clock is 1000ms further ahead. One sample is
    // an anecdote: chase it by 0.3, not all the way.
    c.addSample(100, 6000, 140);
    const target = 6000 + 20 - 140;
    assert.ok(c.offset > before && c.offset < target,
      `offset ${c.offset} should sit between ${before} and ${target}`);
  });

  it('keeps a bounded memory', () => {
    const c = clock();
    for (let i = 0; i < 100; i++) c.addSample(100, 5000, 140);
    assert.ok(c.samples.length <= 40, 'a phone that pings all night must not grow forever');
  });

  it('reports agreement as low jitter and disagreement as high', () => {
    const steady = clock();
    for (let i = 0; i < 8; i++) steady.addSample(100, 5000, 140);
    const wobbly = clock();
    for (let i = 0; i < 8; i++) wobbly.addSample(100, 5000 + (i % 2) * 200, 140);
    assert.ok(steady.jitter < wobbly.jitter);
  });
});
