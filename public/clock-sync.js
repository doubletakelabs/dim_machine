/**
 * NTP-style clock sync — lowest-RTT median, smoothed.
 *
 * Carried from v0.2 and load-bearing ever since: every cue's `startAt` is read
 * against the offset this computes, so an error here is not a wrong number in
 * a status bar, it is every phone in the building out of step. It had never
 * been tested, because it lived inside client.js where nothing could reach it.
 *
 * The estimator: each ping gives offset = server + rtt/2 − t3, an estimate
 * whose error is bounded by the trip's asymmetry — so the samples with the
 * lowest RTT are the trustworthy ones. Keep the best half, take their median
 * (a stray doesn't move a median), then chase it gently (0.3 per sample) so a
 * wifi hiccup bends the clock rather than yanking it.
 */
export function createClock({ now = () => Date.now() } = {}) {
  return {
    samples: [],
    offset: 0,
    rtt: 0,
    jitter: 0,
    synced: false,
    addSample(t0, server, t3) {
      const rtt = t3 - t0;
      this.samples.push({ offset: server + rtt / 2 - t3, rtt });
      if (this.samples.length > 40) this.samples.shift();
      const best = [...this.samples].sort((a, b) => a.rtt - b.rtt)
        .slice(0, Math.max(3, Math.floor(this.samples.length / 2)));
      const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
      const median = offsets[Math.floor(offsets.length / 2)];
      this.offset = this.synced ? this.offset + 0.3 * (median - this.offset) : median;
      this.rtt = Math.min(...best.map((s) => s.rtt));
      const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
      this.jitter = Math.sqrt(offsets.reduce((a, o) => a + (o - mean) ** 2, 0) / offsets.length);
      this.synced = true;
    },
    serverNow() { return now() + this.offset; },
    toLocal(serverTs) { return serverTs - this.offset; },
  };
}
