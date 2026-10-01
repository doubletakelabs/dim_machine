// How long an audio clip runs, read from the file itself (2026-10-01).
//
// For `playThrough` sequence steps, which wait for their clip to end before a
// gesture moves the guest on. WAV from its header; MP3 from its VBR header
// (Xing/Info, VBRI) when it has one, else from size and bitrate (constant
// bitrate, as the guidance clips are). Anything else, or a file that cannot
// be read, is null — the caller decides what not knowing means.

import { readFileSync, statSync } from 'node:fs';

const cache = new Map(); // path -> { mtimeMs, size, seconds }

export function clipSeconds(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.seconds;
  let seconds = null;
  try {
    const buf = readFileSync(path);
    if (/\.wav$/i.test(path)) seconds = wavSeconds(buf);
    else if (/\.mp3$/i.test(path)) seconds = mp3Seconds(buf);
  } catch {
    seconds = null;
  }
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, seconds });
  return seconds;
}

export function wavSeconds(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  const byteRate = buf.readUInt32LE(28);
  const dataSize = buf.readUInt32LE(40);
  return byteRate > 0 ? dataSize / byteRate : null;
}

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** MPEG audio layer III only. */
export function mp3Seconds(buf) {
  let p = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3' && buf.length > 10) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    p = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  while (p + 4 <= buf.length && !(buf[p] === 0xff && (buf[p + 1] & 0xe0) === 0xe0)) p++;
  if (p + 4 > buf.length) return null;

  const h = buf.readUInt32BE(p);
  const version = (h >>> 19) & 3;     // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5
  const layer = (h >>> 17) & 3;       // 1 = layer III
  const bitrateIndex = (h >>> 12) & 15;
  const rateIndex = (h >>> 10) & 3;
  const mono = ((h >>> 6) & 3) === 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const samplesPerFrame = mpeg1 ? 1152 : 576;

  // A VBR file says how many frames it has; size / bitrate would be a guess.
  const x = p + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  const tag = buf.toString('latin1', x, x + 4);
  if ((tag === 'Xing' || tag === 'Info') && x + 12 <= buf.length && (buf.readUInt32BE(x + 4) & 1)) {
    return (buf.readUInt32BE(x + 8) * samplesPerFrame) / sampleRate;
  }
  if (buf.toString('latin1', p + 36, p + 40) === 'VBRI' && p + 54 <= buf.length) {
    return (buf.readUInt32BE(p + 50) * samplesPerFrame) / sampleRate;
  }

  let end = buf.length;
  if (end >= 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
  const bitrate = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] * 1000;
  return ((end - p) * 8) / bitrate;
}
