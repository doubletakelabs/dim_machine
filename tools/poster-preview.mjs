#!/usr/bin/env node
/**
 * Poster preview: what a guest's receipt headline would say, from the rooms
 * they visited. A test bench for the word-selection rules before any of it
 * goes into the show (2026-09-27). The words and templates are
 * poster/words.json (see its "about"), restructured from Lance's
 * visual_refs/poster_words.json.
 *
 *   node tools/poster-preview.mjs                      sample journeys
 *   node tools/poster-preview.mjs cyclorama slop kin   one journey, rooms by show id
 *   node tools/poster-preview.mjs --all                every room with a word
 *   node tools/poster-preview.mjs --runs 3 --seed 7    three takes each, repeatable
 *
 * The rules, as far as the file states them:
 * - every room visited saves its word (a return saves nothing new);
 * - the poster uses every saved word, filling the gaps with words from the
 *   categories (which hold no room words, so none is ever filler);
 * - is/are follows the room word (`plural`).
 *
 * What the file leaves open, guessed here and easy to change:
 * - how many words to a line: each saved word gets its own template line,
 *   except that two nouns visited one after the other may share one of the
 *   `noun_pair` lines (poster.pairChance); the lines are then shuffled, so
 *   the fixed start is not always the top of the poster;
 * - a word with several roles (FOCUS: noun or verb) takes one at random;
 * - fewer than `poster.minWords` saved: printed anyway, marked.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadBank, rng, savedWords as saved, composePoster as compose } from '../poster/compose.js';

const bank = loadBank();

/** show room id → its word */
const WORD_FOR = Object.fromEntries(Object.entries(bank.rooms).map(([room, r]) => [room, r.word]));
const { minWords: MIN_WORDS } = bank.poster;
const savedWords = (journey) => saved(bank, journey);
const composePoster = (words, random) => compose(bank, words, random);

// ---------------------------------------------------------------- the bench

const SAMPLES = {
  'the fixed start only': ['calibration', 'entranceHallway', 'maskRoom', 'hallOfHeroes', 'cyclorama'],
  'a short museum visit': ['calibration', 'maskRoom', 'hallOfHeroes', 'cyclorama', 'museumHallway', 'slop', 'kin', 'museumHallway', 'slop', 'library'],
  'museum and the back rooms': ['calibration', 'maskRoom', 'hallOfHeroes', 'cyclorama', 'automation', 'saas', 'faerie', 'consumption2', 'southCorridor', 'dataCenter', 'controlRoom', 'library'],
  'everything': Object.keys(bank.rooms),
};

function main(argv) {
  const opt = { runs: 1, seed: null, rooms: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') opt.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--seed') opt.seed = Number(argv[++i]) || 0;
    else if (a === '--all') opt.all = true;
    else if (a === '--help' || a === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return; }
    else opt.rooms.push(a);
  }
  const unknown = opt.rooms.filter((r) => !WORD_FOR[r]);
  if (unknown.length) console.log(`(no word for: ${unknown.join(', ')} — rooms with words: ${Object.keys(WORD_FOR).join(', ')})\n`);

  const journeys = opt.all ? { everything: SAMPLES.everything }
    : opt.rooms.length ? { 'your journey': opt.rooms }
    : SAMPLES;
  const random = opt.seed == null ? Math.random : rng(opt.seed);

  for (const [name, journey] of Object.entries(journeys)) {
    const words = savedWords(journey);
    console.log(`── ${name}`);
    console.log(`   rooms: ${journey.join(' → ')}`);
    console.log(`   words: ${words.join(', ') || '(none)'}${words.length < MIN_WORDS ? `   ⚠ fewer than minWords (${MIN_WORDS})` : ''}`);
    for (let r = 0; r < opt.runs; r++) {
      if (opt.runs > 1) console.log(`   take ${r + 1}:`);
      for (const line of composePoster(words, random)) console.log(`      ${line}`);
    }
    console.log('');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
