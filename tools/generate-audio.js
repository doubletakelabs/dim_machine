// Generates the Phase 0 test audio assets as 16-bit mono WAV files in public/assets.
// Run: node tools/generate-audio.js
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SR = 44100;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

function render(seconds, fn) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / SR);
  return out;
}

// click.wav — sharp 5 ms burst for sync-skew testing
const click = render(0.05, (t) =>
  t < 0.005 ? Math.sin(2 * Math.PI * 2000 * t) * (1 - t / 0.005) : 0
);

// ambient.wav — 8 s loopable pad (detuned sines, slow swell)
const ambient = render(8, (t) => {
  const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * t / 8); // period = loop length → seamless
  return (
    0.30 * Math.sin(2 * Math.PI * 110 * t) +
    0.22 * Math.sin(2 * Math.PI * 110.7 * t) +
    0.18 * Math.sin(2 * Math.PI * 165 * t) * lfo
  ) * 0.6;
});

// whisper.wav — 3 s of band-ish filtered noise with an envelope
let lp = 0;
const whisper = render(3, (t) => {
  const noise = Math.random() * 2 - 1;
  lp += 0.08 * (noise - lp); // crude low-pass
  const env = Math.sin(Math.PI * t / 3) ** 2;
  return lp * env * 1.4;
});

// chime.wav — 2.5 s bell-like decay
const chime = render(2.5, (t) => {
  const env = Math.exp(-2.2 * t);
  return (
    0.5 * Math.sin(2 * Math.PI * 660 * t) +
    0.3 * Math.sin(2 * Math.PI * 990 * t) +
    0.2 * Math.sin(2 * Math.PI * 1320 * t)
  ) * env;
});

for (const [name, samples] of [
  ['click.wav', click],
  ['ambient.wav', ambient],
  ['whisper.wav', whisper],
  ['chime.wav', chime],
]) {
  writeFileSync(join(outDir, name), wav(samples));
  console.log('wrote', name);
}
