#!/usr/bin/env node
/**
 * The visit log, summed up per day (2026-10-06): how many came, how many
 * reached the end, how long they stayed, how much they did, and how long the
 * average visitor spent in each room.
 *
 *   npm run visits                 every day in data/
 *   npm run visits -- 2026-10-06   one day
 *
 * Reads data/visits-<day>.jsonl (or VISIT_LOG_DIR), written by the server.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.VISIT_LOG_DIR ? resolve(process.env.VISIT_LOG_DIR) : join(root, 'data');
const only = process.argv[2] ?? null;

let files = [];
try {
  files = readdirSync(dir).filter((f) => /^visits-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
} catch {
  console.log(`No visit log yet (${dir}).`);
  process.exit(0);
}
if (only) files = files.filter((f) => f === `visits-${only}.jsonl`);
if (!files.length) {
  console.log(only ? `No visits logged on ${only}.` : `No visits logged yet (${dir}).`);
  process.exit(0);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mins = (m) => `${Math.floor(m)}:${String(Math.round((m % 1) * 60)).padStart(2, '0')}`;

for (const file of files) {
  const visits = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  const day = file.slice('visits-'.length, -'.jsonl'.length);
  const finished = visits.filter((v) => v.finished);
  const minutes = finished.map((v) => v.minutes);
  const g = (k) => visits.map((v) => v.gestures?.[k] ?? 0);

  console.log(`\n${day}`);
  console.log(`  visitors        ${visits.length}  (${finished.length} reached the end, ${visits.length - finished.length} did not)`);
  if (finished.length) {
    console.log(`  time, finished  median ${mins(median(minutes))}  average ${mins(mean(minutes))}  longest ${mins(Math.max(...minutes))}  (min:sec)`);
  }
  console.log(`  per visitor     taps ${mean(g('taps')).toFixed(1)}  swipes ${mean(g('swipes')).toFixed(1)}  drags ${mean(g('drags')).toFixed(1)}  holds ${mean(g('holds')).toFixed(1)}`);
  console.log(`  whole day       taps ${g('taps').reduce((a, b) => a + b, 0)}  swipes ${g('swipes').reduce((a, b) => a + b, 0)}  drags ${g('drags').reduce((a, b) => a + b, 0)}`);
  console.log(`  receipts        ${visits.filter((v) => v.receipt).length}`);

  // Average time in each room, over the visitors who went in.
  const byRoom = new Map();
  for (const v of visits) {
    const spent = new Map();
    for (const r of v.rooms ?? []) {
      if (r.seconds == null) continue;
      spent.set(r.room, (spent.get(r.room) ?? 0) + r.seconds);
    }
    for (const [room, s] of spent) {
      if (!byRoom.has(room)) byRoom.set(room, []);
      byRoom.get(room).push(s);
    }
  }
  if (byRoom.size) {
    console.log('  rooms           average time  (visitors)');
    for (const [room, secs] of [...byRoom].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${room.padEnd(20)} ${mins(mean(secs) / 60).padStart(6)}   (${secs.length})`);
    }
  }
}
console.log('');
