/**
 * The receipt, printed in the Library (2026-10-01).
 *
 * When a guest's phone arrives in the Library, the show prints their receipt
 * on the thermal printer there: the phone's number, when, what they did with
 * it (taps, swipes, drags — the phone's own count), and the poster the words
 * they collected make (poster/compose.js, the same rules as
 * tools/poster-preview.mjs). Then a QR code to the museum's site, and a cut.
 *
 * Plain ESC/POS over a raw socket (port 9100), which every network receipt
 * printer speaks: no driver, no image rendering. 80 mm paper is 48 characters
 * of font A, 24 at double width.
 *
 * The address comes from the installation (`receipt.printer`), like the room
 * machines' — the venue's, not the show's.
 */
import net from 'node:net';
import { loadBank, savedWords, composePoster } from '../poster/compose.js';

const WIDTH = 48;          // font A, 80 mm
const BIG = 24;            // double width
const SITE = 'https://www.deadinternetmuseum.com/';

const ESC = 0x1b;
const GS = 0x1d;
const cmd = {
  init: [ESC, 0x40],
  center: [ESC, 0x61, 1],
  left: [ESC, 0x61, 0],
  bold: (on) => [ESC, 0x45, on ? 1 : 0],
  // GS ! n: width multiplier in the high nibble, height in the low, minus one.
  size: (w, h) => [GS, 0x21, ((w - 1) << 4) | (h - 1)],
  feed: (n) => [ESC, 0x64, n],
  invert: (on) => [GS, 0x42, on ? 1 : 0],     // white on black
  underline: (n) => [ESC, 0x2d, n],          // 0 off, 1 thin, 2 thick
  upsideDown: (on) => [ESC, 0x7b, on ? 1 : 0],
  cut: [GS, 0x56, 66, 3],  // feed a little, then a partial cut
};

/** Thermal printers take 8-bit codepages; keep to ASCII so nothing prints as junk. */
function ascii(text) {
  return String(text)
    .replace(/[—–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·/g, '-')
    .normalize('NFD')
    .replace(/[^\x20-\x7e\n]/g, '');
}

/** Word-wrap to `width` columns. */
export function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of ascii(text).split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
    while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
  }
  if (line) out.push(line);
  return out;
}

/** "LABEL ........ value", right-aligned to the width. */
function dotted(label, value, width = WIDTH) {
  const v = String(value);
  return `${label} ${'.'.repeat(Math.max(1, width - label.length - v.length - 2))} ${v}`;
}

function mmss(ms) {
  const s = Math.round((ms ?? 0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function when(date) {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const h = date.getHours();
  const time = `${(h % 12) || 12}:${String(date.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return `${months[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')} ${date.getFullYear()}  ${time}`;
}

// ---------------------------------------------------------------- wonky
// The poster is slop, so it prints like slop (2026-10-01): every word its own
// size, some inverted or underlined, a letter that stutters or swaps for a
// look-alike, lines shoved sideways, the odd one upside down, and noise and
// half-printed ghosts of lines in between. Still plain printer text.

const LOOKALIKE = { O: '0', I: '1', E: '3', A: '4', S: '5', B: '8', G: '6' };
const NOISE = '#=/\\|_-:.+*';

function mangle(word, random) {
  const r = random();
  const letters = [...word].map((c, i) => (/[A-Z]/.test(c) ? i : -1)).filter((i) => i >= 0);
  if (!letters.length) return word;
  const at = letters[Math.floor(random() * letters.length)];
  if (r < 0.1) return word.slice(0, at + 1) + word[at] + word.slice(at + 1);              // stutter
  if (r < 0.2 && LOOKALIKE[word[at]]) return word.slice(0, at) + LOOKALIKE[word[at]] + word.slice(at + 1); // swap
  return word;
}

/** One word's look: size, inverted, underlined. */
function wordStyle(random, big) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const style = big
    ? { w: pick([2, 2, 3]), h: pick([2, 3, 3, 4]) }
    : { w: random() < 0.2 ? 2 : 1, h: pick([1, 2, 2, 3]) };
  style.inv = random() < (big ? 0.15 : 0.1);
  style.ul = !style.inv && random() < 0.08 ? (random() < 0.5 ? 1 : 2) : 0;
  return style;
}

/**
 * A line of words, each styled, broken to the paper's width, each printed
 * line shoved a few spaces sideways. Returns bytes and a text approximation.
 */
function wonkyLine(text, random, { big = false } = {}) {
  const words = ascii(text).split(/\s+/).filter(Boolean).map((w) => ({ text: mangle(w, random), ...wordStyle(random, big) }));
  const rows = [];
  let row = [];
  let used = 0;
  for (const w of words) {
    const cost = (w.text.length + 1) * w.w;
    if (row.length && used + cost > WIDTH) { rows.push(row); row = []; used = 0; }
    row.push(w);
    used += cost;
  }
  if (row.length) rows.push(row);

  const bytes = [];
  const textOut = [];
  const flip = !big && random() < 0.08;
  for (const r of rows) {
    const width = r.reduce((n, w) => n + (w.text.length + 1) * w.w, 0);
    const room = Math.max(0, WIDTH - width);
    const indent = Math.floor(random() * Math.min(room + 1, 10));
    bytes.push(Buffer.from([...cmd.left, ...cmd.size(1, 1), ...(flip ? cmd.upsideDown(true) : [])]), Buffer.from(' '.repeat(indent)));
    let shown = ' '.repeat(indent);
    for (const w of r) {
      bytes.push(Buffer.from([...cmd.size(w.w, w.h), ...cmd.invert(w.inv), ...cmd.underline(w.ul)]));
      bytes.push(Buffer.from(w.text, 'ascii'));
      bytes.push(Buffer.from([...cmd.invert(false), ...cmd.underline(0)]), Buffer.from(' '));
      const look = w.w > 1 ? w.text.split('').join(' ') : w.text;
      shown += (w.inv ? `[${look}]` : w.ul ? `_${look}_` : look) + ' ';
    }
    bytes.push(Buffer.from([...cmd.size(1, 1), ...(flip ? cmd.upsideDown(false) : [])]), Buffer.from('\n'));
    textOut.push((flip ? '(upside down) ' : '') + shown.trimEnd());
  }
  return { bytes: Buffer.concat(bytes), text: textOut };
}

/** Something between lines, now and then: a noise bar, or a ghost of the last line. */
function glitchBetween(random, previous) {
  const r = random();
  if (r < 0.15) {
    const n = 12 + Math.floor(random() * (WIDTH - 12));
    const bar = Array.from({ length: n }, () => NOISE[Math.floor(random() * NOISE.length)]).join('');
    const pad = ' '.repeat(Math.floor(random() * (WIDTH - n + 1)));
    return { bytes: Buffer.from(`${pad}${bar}\n`, 'ascii'), text: [pad + bar] };
  }
  if (r < 0.27 && previous) {
    const cut = ascii(previous).slice(0, 6 + Math.floor(random() * Math.max(1, previous.length - 6)));
    const pad = ' '.repeat(Math.floor(random() * 12));
    return { bytes: Buffer.from(`${pad}${cut}\n`, 'ascii'), text: [pad + cut] };
  }
  return null;
}

/** ESC/POS QR code (model 2), printed centred. */
function qr(data, moduleSize = 6) {
  const bytes = Buffer.from(data, 'ascii');
  const len = bytes.length + 3;
  return [
    GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00,              // model 2
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, moduleSize,               // module size
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31,                     // error correction M
    GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...bytes, // store
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30,                     // print
  ];
}

/**
 * The receipt, as the printer's bytes and as plain text (for the log and a
 * dry run).
 *
 * @param {object} r
 * @param {string} r.phone — the handset's number, as the operator panel shows it
 * @param {Array<{roomId: string, word: string}>} r.visit — words in the order shown
 * @param {{taps?: number, swipes?: number, drags?: number, holds?: number, dragMs?: number}} [r.counts]
 * @param {Date} [r.at]
 * @param {() => number} [r.random]
 */
export function buildReceipt({ phone, visit, counts = {}, at = new Date(), random = Math.random, bank = loadBank() }) {
  const words = savedWords(bank, visit.map((v) => v.roomId));
  const rooms = new Set(visit.map((v) => v.roomId)).size;
  const lines = composePoster(bank, words, random);
  // The poster's biggest line leads, as its headline; the rest follow it.
  const headline = lines[0] ?? 'YOU WERE HERE. PROBABLY.';
  const rest = lines.slice(1);

  const out = [];
  const text = [];
  const push = (...bytes) => out.push(Buffer.from(bytes.flat()));
  const say = (str, { big = false } = {}) => {
    for (const l of (big ? wrap(str, BIG) : wrap(str, WIDTH))) {
      out.push(Buffer.from(`${l}\n`, 'ascii'));
      text.push(big ? `  ${l.split('').join(' ')}` : l);
    }
  };
  const rule = (ch = '-') => { out.push(Buffer.from(`${ch.repeat(WIDTH)}\n`)); text.push(ch.repeat(WIDTH)); };
  const blank = () => { out.push(Buffer.from('\n')); text.push(''); };

  push(cmd.init, cmd.center);
  push(cmd.bold(true), cmd.size(2, 2));
  say('DEAD INTERNET', { big: true });
  say('MUSEUM', { big: true });
  push(cmd.size(1, 1), cmd.bold(false));
  say('- RECEIPT OF YOUR ATTENTION -');
  rule('=');
  push(cmd.bold(true), cmd.size(2, 2));
  say(`PHONE ${String(phone ?? '?').replace(/^#/, '').toUpperCase()}`, { big: true });
  push(cmd.size(1, 1), cmd.bold(false));
  say(when(at));
  rule();

  push(cmd.left);
  say(dotted('TAPS', String(counts.taps ?? 0).padStart(3, '0')));
  say(dotted('SWIPES', String(counts.swipes ?? 0).padStart(3, '0')));
  say(dotted('DRAGS', String(counts.drags ?? 0).padStart(3, '0')));
  say(dotted('TIME SPENT DRAGGING', mmss(counts.dragMs)));
  say(dotted('ROOMS VISITED', rooms));
  say(dotted('WORDS COLLECTED', words.length));
  say(dotted('ATTENTION HARVESTED', '100%'));
  rule();

  const wonky = (line, opts) => { const w = wonkyLine(line, random, opts); out.push(w.bytes); text.push(...w.text); };
  blank();
  push(cmd.bold(true));
  wonky(headline, { big: true });
  push(cmd.bold(false));
  let previous = headline;
  for (const line of rest) {
    const g = glitchBetween(random, previous);
    if (g) { out.push(g.bytes); text.push(...g.text); } else blank();
    wonky(line);
    previous = line;
  }
  push(cmd.size(1, 1), cmd.invert(false), cmd.underline(0), cmd.upsideDown(false), cmd.center);
  blank();
  rule();
  if (words.length) say(words.join('  '));
  blank();
  say('- A DIM PRODUCTION -');
  blank();
  push(qr(SITE));
  text.push('[QR: deadinternetmuseum.com]');
  say('deadinternetmuseum.com');
  push(cmd.feed(4), cmd.cut);

  return { bytes: Buffer.concat(out), text: text.join('\n'), headline, words };
}

/**
 * Send bytes to a raw-socket printer ("host:port", port 9100 by default).
 * Resolves once they are written; rejects on no answer within `timeoutMs`.
 */
export function sendToPrinter(address, bytes, timeoutMs = 5000) {
  const [host, port = '9100'] = String(address).split(':');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(timeoutMs, () => fail(new Error(`printer ${address} did not answer`)));
    socket.on('error', fail);
    socket.on('connect', () => socket.end(bytes, () => resolve()));
  });
}
