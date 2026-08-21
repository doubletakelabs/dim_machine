#!/usr/bin/env node
/**
 * Audition the audio segments a show declares.
 *
 * Segment boundaries are the one part of a self-paced sequence that cannot be
 * derived — only heard. This plays each one in turn so they can be tuned by ear
 * against the show JSON, rather than by counting silences in a waveform.
 *
 *   node tools/audition.mjs the-museum                 # list every segment
 *   node tools/audition.mjs the-museum tapTest         # play one
 *   node tools/audition.mjs the-museum --all           # play them in order
 *
 * Needs ffplay (brew install ffmpeg).
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [showName, target] = process.argv.slice(2);

if (!showName) {
  console.error('usage: node tools/audition.mjs <show> [stepName|--all]');
  process.exit(1);
}

const show = JSON.parse(readFileSync(join(root, 'shows', `${showName}.json`), 'utf8'));

const segments = Object.entries(show.guest?.cues ?? {})
  .filter(([, cue]) => cue?.duration != null)
  .map(([key, cue]) => ({
    key,
    step: key.split('.').pop(),
    asset: cue.audio,
    image: cue.image,
    offset: cue.offset ?? 0,
    duration: cue.duration,
  }));

if (!segments.length) {
  console.log(`${showName} declares no segmented audio.`);
  process.exit(0);
}

const play = ({ asset, offset, duration }) => spawnSync(
  'ffplay',
  ['-nodisp', '-autoexit', '-loglevel', 'error', '-ss', String(offset), '-t', String(duration),
    join(root, 'public', 'assets', asset)],
  { stdio: 'inherit' },
);

const chosen = target && target !== '--all'
  ? segments.filter((s) => s.step === target || s.key === target)
  : segments;

if (!chosen.length) {
  console.error(`no segment named "${target}". Known: ${segments.map((s) => s.step).join(', ')}`);
  process.exit(1);
}

for (const seg of chosen) {
  const end = (seg.offset + seg.duration).toFixed(2);
  console.log(
    `${seg.step.padEnd(12)} ${String(seg.offset.toFixed(2)).padStart(6)}s → ${end.padStart(6)}s`
    + `  (${seg.duration.toFixed(2)}s)  ${seg.image ?? ''}`,
  );
  if (target) play(seg);
}

if (!target) console.log('\nPass a step name to hear one, or --all to hear them in order.');
