#!/usr/bin/env node
/**
 * Walk a show's screen sequences on the desk: what each step shows, what it
 * plays, and what ends it.
 *
 * The advance rule lives in the image filename, so the deck and the machine
 * cannot drift — but that also means nothing in the show JSON states it plainly.
 * This prints it.
 *
 *   node tools/audition.mjs the-museum                # every sequence
 *   node tools/audition.mjs the-museum calibration    # play one, in order
 *
 * Playing needs ffplay (brew install ffmpeg).
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { advanceForStep } from '../server/spatial/sequence.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'public', 'assets');
const [showName, target] = process.argv.slice(2);

if (!showName) {
  console.error('usage: node tools/audition.mjs <show> [sequenceName]');
  process.exit(1);
}

const show = JSON.parse(readFileSync(join(root, 'shows', `${showName}.json`), 'utf8'));

/** Every `sequence` in the guest machine, with the path that names it. */
function findSequences(states, path = []) {
  const found = [];
  for (const [id, state] of Object.entries(states ?? {})) {
    if (!state || typeof state !== 'object') continue;
    if (Array.isArray(state.sequence)) {
      found.push({ name: id, path: [...path, id].join('.'), state });
    }
    if (state.states) found.push(...findSequences(state.states, [...path, id]));
  }
  return found;
}

const sequences = Object.entries(show.guest?.machine ?? {})
  .filter(([region]) => region !== 'location')
  .flatMap(([region, block]) => findSequences(block?.states, [region]));

if (!sequences.length) {
  console.log(`${showName} declares no sequences.`);
  process.exit(0);
}

const describe = (advance) => {
  if (!advance) return '?? no rule';
  return advance.kind === 'delay' ? `after ${advance.ms}ms` : `on ${advance.input}`;
};

const duration = (asset) => {
  if (!asset) return '';
  const path = join(assetsDir, asset);
  if (!existsSync(path)) return '  MISSING';
  const out = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of',
    'default=noprint_wrappers=1:nokey=1', path,
  ], { encoding: 'utf8' });
  const secs = Number(out.stdout);
  return Number.isFinite(secs) ? `${secs.toFixed(2)}s` : '';
};

const play = (asset) => spawnSync(
  'ffplay',
  ['-nodisp', '-autoexit', '-loglevel', 'error', join(assetsDir, asset)],
  { stdio: 'inherit' },
);

const chosen = target
  ? sequences.filter((s) => s.name === target || s.path === target)
  : sequences;

if (!chosen.length) {
  console.error(`no sequence named "${target}". Known: ${sequences.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

const warnings = [];

for (const seq of chosen) {
  console.log(`\n${seq.path}  →  ${seq.state.onComplete ?? '(nothing follows)'}`);
  seq.state.sequence.forEach((step, i) => {
    const advance = advanceForStep(step);
    const secs = duration(step.audio);
    console.log(
      `  ${String(i + 1).padStart(2)}. ${describe(advance).padEnd(14)}`
      + `${(step.image ?? '—').padEnd(34)}${(step.audio ?? '—').padEnd(34)}${secs}`,
    );

    // A delay shorter than its own narration cuts the voice off mid-sentence.
    // Only checkable here, because it needs the file rather than the show.
    const audioMs = parseFloat(secs) * 1000;
    if (advance?.kind === 'delay' && Number.isFinite(audioMs) && advance.ms < audioMs - 250) {
      warnings.push(
        `  step ${i + 1} leaves after ${advance.ms}ms but its audio runs ${secs}`
        + ` — ${((audioMs - advance.ms) / 1000).toFixed(1)}s will be cut off`,
      );
    }
    if (target && step.audio) play(step.audio);
  });
}

if (warnings.length) console.log(`\n⚠ ${warnings.length} timing problem(s):\n${warnings.join('\n')}`);

if (!target) console.log('\nPass a sequence name to hear it in order.');
