#!/usr/bin/env node
/**
 * Print a sample receipt, to check the Library's printer and how it looks
 * (2026-10-01). The show prints the real ones itself (server/receipt.js).
 *
 *   node tools/receipt-print.mjs                          to the installation's receipt.printer
 *   node tools/receipt-print.mjs --printer 192.168.3.30   to a printer by address (port 9100)
 *   node tools/receipt-print.mjs --dry                    show it here instead
 *   node tools/receipt-print.mjs --seed 4 --dry           the same receipt each time
 *   node tools/receipt-print.mjs cyclorama slop kin       a visit through these rooms
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReceipt, sendToPrinter } from '../server/receipt.js';
import { rng } from '../poster/compose.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { dry: false, printer: null, seed: null, rooms: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry') opt.dry = true;
  else if (args[i] === '--printer') opt.printer = args[++i];
  else if (args[i] === '--seed') opt.seed = Number(args[++i]) || 0;
  else opt.rooms.push(args[i]);
}

function installationPrinter() {
  for (const file of ['installations/local.json', 'installations/mad.json']) {
    const path = join(ROOT, file);
    if (existsSync(path)) {
      const printer = JSON.parse(readFileSync(path, 'utf8')).receipt?.printer;
      if (printer) return printer;
    }
  }
  return null;
}

const rooms = opt.rooms.length ? opt.rooms
  : ['calibration', 'maskRoom', 'hallOfHeroes', 'cyclorama', 'slop', 'kin', 'saas', 'faerie', 'library'];
const receipt = buildReceipt({
  phone: '#TEST',
  visit: rooms.map((roomId) => ({ roomId })),
  counts: { taps: 41, swipes: 17, drags: 9, holds: 2, dragMs: 23400 },
  random: opt.seed == null ? Math.random : rng(opt.seed),
});

if (opt.dry) {
  console.log(receipt.text);
} else {
  const printer = opt.printer ?? installationPrinter();
  if (!printer) {
    console.error('no printer: pass --printer <host[:port]>, or set receipt.printer in the installation');
    process.exit(1);
  }
  await sendToPrinter(printer, receipt.bytes);
  console.log(`sent ${receipt.bytes.length} bytes to ${printer}: ${receipt.headline}`);
}
