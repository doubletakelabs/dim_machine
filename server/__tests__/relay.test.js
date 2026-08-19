import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as relay from '../relay.js';
import { SpatialRuntime } from '../spatial/runtime.js';
import { ManualClock } from '../spatial/clock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const demo = JSON.parse(readFileSync(join(root, 'shows/spatial-demo.json'), 'utf8'));

/**
 * The relay is a v0.2 surface talking to a v0.3 runtime, so it is exactly where
 * a rename goes unnoticed: none of it is reached until a phone connects, and
 * `participant` → `guest` left it calling a method that no longer existed.
 * These run it against a real runtime rather than a stub for that reason — a
 * stub would have been renamed alongside the runtime and caught nothing.
 */
describe('peer relay against the spatial runtime', () => {
  const makeRuntime = () => {
    const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock() });
    assert.deepEqual(rt.load(structuredClone(demo)).errors, []);
    rt.start();
    return rt;
  };

  it('scopes an audience to the room a guest is in', () => {
    const rt = makeRuntime();
    const a = rt.spawnGuest();
    const b = rt.spawnGuest();
    for (const g of [a, b]) {
      rt.setVirtualPosition(g.guestId, 320, 235);
      rt.testAdvanceTime(2600);
    }
    assert.equal(relay.audienceKey(rt, a.token), 'hallway');

    const users = new Map([[a.token, { ws: {} }], [b.token, { ws: {} }]]);
    assert.deepEqual(relay.audienceTokens(rt, users, a.token).sort(), [a.token, b.token].sort());
  });

  it('falls back to the whole show for a guest who is nowhere', () => {
    const rt = makeRuntime();
    const a = rt.spawnGuest();
    assert.equal(relay.audienceKey(rt, a.token), '__show__');
    const users = new Map([[a.token, { ws: {} }]]);
    assert.deepEqual(relay.audienceTokens(rt, users, a.token), [a.token]);
  });

  it('survives a token the runtime has never heard of', () => {
    const rt = makeRuntime();
    assert.equal(relay.audienceKey(rt, 'no-such-token'), '__show__');
  });
});
