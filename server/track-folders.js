/**
 * A room's tracks, read from a folder rather than written out.
 *
 * Slop plays whatever songs are in its folder, one per selection in turn. The
 * show says only where they live:
 *
 *   "tracks": { "folder": "audio/bg/slop", "in": "active", "crossfadeMs": 0 }
 *
 * and this builds, at load, what used to be written by hand for each song:
 * a state `<in>.trackN`, the event `TRACK_N` that moves the room there, and a
 * cue whose `bg` is that song. Songs go in file-name order, numbers compared
 * as numbers, so `2` comes before `10` whether or not it is padded. A song
 * dropped in the folder is in the rotation the next time the show loads.
 *
 * The list, with each song's length, stays on the room (`tracks.list`) so the
 * room's piece can be told it: it runs the rotation and the player's clock.
 *
 * Pure: the folder listing and the lengths are handed in, so this runs
 * without a disk.
 */

const AUDIO = /\.(mp3|m4a|wav|aac|ogg)$/i;
const TRACK_STATE = /^track\d+$/;
const TRACK_EVENT = /^TRACK_\d+$/;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * @param {object} def
 * @param {{ list: (folder: string) => string[]|null, seconds?: (asset: string) => number|null }} disk
 *   `list` gives a folder's file names (null if it is not there); `seconds`
 *   a file's length, or null if it cannot be read
 * @returns {{ def: object, notes: string[], problems: string[] }} a new
 *   definition (the input is untouched), what was built, and what was not
 */
export function expandTrackFolders(def, { list, seconds = () => null }) {
  const out = structuredClone(def ?? {});
  const notes = [];
  const problems = [];
  for (const [roomId, room] of Object.entries(out.rooms ?? {})) {
    const spec = room?.tracks;
    if (spec == null) continue;
    const at = `rooms.${roomId}.tracks`;
    if (typeof spec !== 'object' || typeof spec.folder !== 'string' || !spec.folder) {
      problems.push(`${at} needs "folder": where the songs are, under public/assets`);
      continue;
    }
    const folder = spec.folder.replace(/\/+$/, '');
    const inState = spec.in ?? 'active';
    const parent = room.machine?.states?.[inState];
    if (!parent) {
      problems.push(`${at}.in names "${inState}", which is not a state of ${roomId}'s machine`);
      continue;
    }
    const names = list(folder);
    if (names == null) {
      problems.push(`${at}: no folder ${folder}`);
      continue;
    }
    const songs = names.filter((n) => AUDIO.test(n) && !n.startsWith('.')).sort(byName.compare);
    if (!songs.length) problems.push(`${at}: ${folder} has no songs in it`);

    // What was written by hand before is replaced, not added to.
    parent.states = Object.fromEntries(Object.entries(parent.states ?? {}).filter(([id]) => !TRACK_STATE.test(id)));
    parent.on = Object.fromEntries(Object.entries(parent.on ?? {}).filter(([event]) => !TRACK_EVENT.test(event)));
    const prefix = `${inState}.`;
    room.cues = Object.fromEntries(Object.entries(room.cues ?? {})
      .filter(([key]) => !(key.startsWith(prefix) && TRACK_STATE.test(key.slice(prefix.length)))));

    const tracks = songs.map((name, i) => {
      const n = i + 1;
      const audio = `${folder}/${name}`;
      parent.states[`track${n}`] = {};
      parent.on[`TRACK_${n}`] = `.track${n}`;
      room.cues[`${prefix}track${n}`] = {
        bg: { audio, ...(spec.crossfadeMs != null ? { crossfadeMs: spec.crossfadeMs } : {}) },
      };
      return { n, audio, seconds: seconds(audio) };
    });
    if (!Object.keys(room.cues).length) delete room.cues;
    room.tracks = { ...spec, list: tracks };
    if (songs.length) notes.push(`${roomId}: ${songs.length} tracks from ${folder}`);
  }
  return { def: out, notes, problems };
}
