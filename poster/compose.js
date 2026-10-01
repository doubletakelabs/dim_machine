/**
 * The receipt poster's lines, from the words a visit collected (2026-10-01).
 * Shared by the show (server/receipt.js, printed in the Library) and the test
 * bench (tools/poster-preview.mjs), so what the bench shows is what prints.
 * The words, templates and filler are poster/words.json — see its "about".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadBank(path = join(HERE, 'words.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------- randomness

export function rng(seed) {
  // mulberry32: small, repeatable, good enough for choosing words.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the poster

/** The words a journey saves: one per room with a word, first visit only. */
export function savedWords(bank, journey) {
  const out = [];
  for (const room of journey) {
    const word = bank.rooms[room]?.word;
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

export function composePoster(bank, words, random = Math.random) {
  const ROLES = Object.fromEntries(Object.values(bank.rooms).map((r) => [r.word, r]));
  const { templates, slots: SLOT_CATEGORY, pairChance: PAIR_CHANCE } = bank.poster;
  const pick = (list) => list[Math.floor(random() * list.length)];
  const usedFiller = new Set();
  const usedTemplates = new Set();

  const filler = (slot) => {
    const pool = bank.categories[SLOT_CATEGORY[slot]];
    const fresh = pool.filter((w) => !usedFiller.has(w));
    const word = pick(fresh.length ? fresh : pool);
    usedFiller.add(word);
    return word;
  };
  const is = (word) => (ROLES[word]?.plural ? 'are' : 'is');
  const template = (kind) => {
    const list = templates[kind];
    const fresh = list.filter((t) => !usedTemplates.has(t));
    const t = pick(fresh.length ? fresh : list);
    usedTemplates.add(t);
    return t;
  };
  const fill = (t, w1, w2) => t.replace(/\{(\w+)\}/g, (_, slot) => {
    if (slot === 'W' || slot === 'W1') return w1;
    if (slot === 'W2') return w2;
    if (slot === 'IS' || slot === 'IS1') return is(w1);
    if (slot === 'IS2') return is(w2);
    if (SLOT_CATEGORY[slot]) return filler(slot);
    throw new Error(`no filler for {${slot}}`);
  });

  const lines = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];
    const role = pick(ROLES[word]?.roles ?? ['noun']);
    if (role === 'noun' && next && ROLES[next]?.roles.includes('noun') && random() < PAIR_CHANCE) {
      lines.push(fill(template('noun_pair'), word, next));
      i++;
      continue;
    }
    lines.push(fill(template(role), word));
  }
  // Shuffled, so the fixed start (FOCUS, MASK, HERO, COOL) is not always on top.
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  return lines.map((l) => l.toUpperCase());
}

