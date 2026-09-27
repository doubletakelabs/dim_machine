/**
 * Audio named in a show, matched to what is actually on disk.
 *
 * Clips arrive from the sound team as .mp3 or .m4a, and a re-export changes
 * the ending without anyone touching the show. So a show's audio name is read
 * as "this clip": the exact file if it is there, otherwise the same name with
 * another audio ending. The show file itself is never rewritten; the running
 * show, and everything built from it — the phones' preload and content sync,
 * the missing-asset report — sees the file that exists.
 *
 * Pure: `exists` is handed in, so this runs without a disk.
 */

/** Tried in this order when the named file is not there. */
export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.aac', '.ogg'];

const AUDIO_NAME = new RegExp(`(${AUDIO_EXTENSIONS.map((e) => e.replace('.', '\\.')).join('|')})$`, 'i');

/**
 * The file to play for `name`: itself if it exists, else the first sibling
 * with another audio ending that does, else `name` unchanged (and reported
 * missing downstream, as before).
 *
 * @param {string} name — as authored, relative to public/assets
 * @param {(path: string) => boolean} exists
 * @returns {string}
 */
export function resolveAudioName(name, exists) {
  const match = AUDIO_NAME.exec(name);
  if (!match || exists(name)) return name;
  const stem = name.slice(0, match.index);
  const authored = match[1].toLowerCase();
  for (const ext of AUDIO_EXTENSIONS) {
    if (ext === authored) continue;
    if (exists(stem + ext)) return stem + ext;
  }
  return name;
}

/**
 * Every audio name in a show — cues, bg, the bed, museum stems, doors —
 * resolved against the disk.
 *
 * @param {object} def
 * @param {(path: string) => boolean} exists
 * @returns {{ def: object, swaps: Array<{ from: string, to: string }> }}
 *   a new definition (the input is untouched), and each name that changed
 */
export function resolveAudioNames(def, exists) {
  const swaps = new Map();
  const walk = (value) => {
    if (typeof value === 'string') {
      const to = resolveAudioName(value, exists);
      if (to !== value) swaps.set(value, to);
      return to;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  const resolved = walk(def);
  return { def: resolved, swaps: [...swaps].map(([from, to]) => ({ from, to })) };
}
