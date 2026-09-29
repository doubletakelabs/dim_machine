// DIM Machine — v0.3 spatial runtime (Phase A).
// WebSocket bridge for operator panel, simulated guests, and phones (Phase B+).
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve, sep } from 'node:path';
import { SpatialRuntime, validateShowDefinition, ScaledClock } from './spatial/index.js';
import { applyInstallation } from './spatial/installation.js';
import { resolveAudioNames } from './asset-names.js';
import { expandTrackFolders } from './track-folders.js';
import { execFileSync } from 'node:child_process';
import * as relay from './relay.js';

// Not 4000: dim_central (the deploy dashboard) runs there on the same machine.
const PORT = process.env.PORT || 4100;
const BASE_ASSETS = ['click.wav', 'chime.wav'];
const OFFLINE_HIDE_MS = 60_000;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where this show's rooms physically are. A show describes the work; an
 * installation says which machines run its pieces — so rehearsing on a laptop
 * is a different file rather than an edit to the artistic document.
 */
const argv = process.argv.slice(2);
const flagIndex = argv.indexOf('--installation');
const LOCAL_INSTALLATION = 'installations/local.json';
/** The venue, used when nothing else is named (2026-09-26: no flag to forget). */
const DEFAULT_INSTALLATION = 'installations/mad.json';

/**
 * Named on the command line, or in INSTALLATION, or this machine's own
 * `installations/local.json` if it has one, or — failing all three — the
 * venue's, `installations/mad.json`.
 *
 * local.json is the answer to an address that belongs to one laptop and
 * changes: it is git-ignored, so a LAN IP never lands in a file everybody
 * shares. The venue default means the show server needs no flag at all. Which
 * installation was used is printed at boot and shown in the panel, so the
 * convenience is never a silent difference between rehearsal and the night.
 */
const installationPath = flagIndex >= 0 && argv[flagIndex + 1]
  ? argv[flagIndex + 1]
  : process.env.INSTALLATION
    ?? (existsSync(join(root, LOCAL_INSTALLATION)) ? LOCAL_INSTALLATION
      : existsSync(join(root, DEFAULT_INSTALLATION)) ? DEFAULT_INSTALLATION : null);

let installation = null;
if (installationPath) {
  try {
    installation = JSON.parse(readFileSync(join(root, installationPath), 'utf8'));
  } catch (err) {
    console.error(`installation ${installationPath}: ${err.message}`);
    process.exit(1);
  }
}
// SHOWS_DIR points a test (or an installation) at its own copy of the
// shows, the same way MEDIA_DIR and CALIBRATION_FILE work for a room
// experience. Unset means the repo's shows/, exactly as before.
const showsDir = process.env.SHOWS_DIR ? resolve(process.env.SHOWS_DIR) : join(root, 'shows');
const assetsDir = join(root, 'public', 'assets');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(root, 'public')));

// The zone tracer judges overlaps in the browser with the same functions the
// show judges occupancy with — served from the source, so there is no browser
// copy to drift. It is the only server module a page may import.
app.get('/lib/zone-math.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(join(root, 'server', 'spatial', 'zone-math.js'));
});
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function showPath(file) {
  return join(showsDir, basename(file));
}

function listShows() {
  try {
    return readdirSync(showsDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

app.get('/api/shows', (_req, res) => res.json(listShows()));

app.get('/api/shows/:file', (req, res) => {
  const file = basename(req.params.file);
  if (!file.endsWith('.json')) return res.status(400).json({ error: 'invalid file name' });
  try {
    res.json(JSON.parse(readFileSync(showPath(file), 'utf8')));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/shows/validate', (req, res) => {
  res.json(validateShowDefinition(req.body ?? {}));
});

app.post('/api/shows/:file', (req, res) => {
  const file = basename(req.params.file);
  if (!file.endsWith('.json')) return res.status(400).json({ error: 'invalid file name' });
  const def = req.body;
  if (!def || typeof def !== 'object') return res.status(400).json({ error: 'body must be JSON object' });
  const result = validateShowDefinition(def);
  if (result.errors.length) return res.status(400).json(result);
  try {
    writeFileSync(showPath(file), `${JSON.stringify(def, null, 2)}\n`);
    res.json({ ok: true, warnings: result.warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Audio files the editor can assign — every sound under public/assets, as the
 * path a cue names (`audio/museum/entrance.wav`).
 */
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|opus|flac)$/i;
app.get('/api/assets/audio', (_req, res) => {
  try {
    const files = readdirSync(assetsDir, { recursive: true })
      .map((f) => String(f).split(sep).join('/'))
      .filter((f) => AUDIO_EXT.test(f) && !f.split('/').some((part) => part.startsWith('.')))
      .sort();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Everything a show handset needs to run without streaming — the content the
 * Android app (dim_android_app) syncs when it is put on charge, then serves to
 * the page from its own copy: the phone page's files, the assets the loaded
 * show names (the same list `welcome` sends), and the show's beacons. Only
 * those: a file that is merely in public/assets — a 195MB master mix, a take
 * the show no longer uses — never goes to a phone (2026-09-26). `version` changes when any of it
 * does; each file carries its size and sha256 so only what changed is fetched
 * (from the same URL the page uses) and a download can be checked.
 */
const PHONE_PAGE_FILES = ['index.html', 'client.js', 'companion.js', 'gestures.js', 'clock-sync.js', 'cue-plan.js', 'mixer.js'];
/** Assets the page itself loads, whatever the show: the keep-awake video, the companion's fonts. */
const PHONE_PAGE_ASSETS = ['keepawake.mp4', 'fonts/raleway-latin.woff2', 'fonts/jetbrains-mono-latin.woff2'];
/** absolute path → { size, mtimeMs, sha256 }: a hash is recomputed only when the file changed. */
const hashCache = new Map();

async function contentEntry(rel) {
  const abs = join(root, 'public', rel);
  let st;
  try { st = statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = hashCache.get(abs);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { path: rel, size: st.size, sha256: hit.sha256 };
  const sha256 = await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(abs).on('data', (d) => hash.update(d)).on('end', () => resolveHash(hash.digest('hex'))).on('error', reject);
  });
  hashCache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
  return { path: rel, size: st.size, sha256 };
}

app.get('/api/content', async (_req, res) => {
  try {
    const assets = [...new Set([...PHONE_PAGE_ASSETS, ...currentAssets()])]
      .filter((f) => !f.split('/').some((part) => part.startsWith('.') || part === '..'))
      .map((f) => `assets/${f}`);
    const files = (await Promise.all([...PHONE_PAGE_FILES, ...assets].map(contentEntry)))
      .filter(Boolean)
      .sort((a, b) => a.path.localeCompare(b.path));
    const beacons = runtime.def?.beacons ?? null;
    const version = createHash('sha256')
      .update(JSON.stringify({ files: files.map((f) => [f.path, f.sha256]), beacons }))
      .digest('hex').slice(0, 16);
    res.json({ version, showId: runtime.def?.showId ?? null, beacons, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The zone editor's save: what the editor owns, merged into the file on disk.
 *
 * The editor used to send the whole show back, which made every save an
 * assertion that the editor's copy of the *entire* document was still true —
 * and a tab opened before a commit and saved after silently reverted that
 * commit (TECH-DEBT §5, 2026-09-13: a tracing pass undid the shared rooms).
 * Now the disk copy is the base truth for everything the editor does not own,
 * and the patch cannot say anything else. The editor owns, per room: `zones`
 * (polygons), `cues` (the room's own audio), `thresholds` (its doors) and its
 * own museum clips (`museum.roomStems.<roomId>`); the show's `beacons`; and
 * `location.phone`, how phones choose a room. Each named block is replaced
 * wholesale — that
 * is what carries a deletion; `null` or `{}` removes it — and the merged show
 * must validate before anything lands.
 */
app.post('/api/shows/:file/zones', (req, res) => {
  const file = basename(req.params.file);
  if (!file.endsWith('.json')) return res.status(400).json({ error: 'invalid file name' });
  const zones = req.body?.zones;
  const hasBeacons = req.body != null && Object.prototype.hasOwnProperty.call(req.body, 'beacons');
  const beacons = req.body?.beacons ?? null;
  const thresholds = req.body?.thresholds ?? {};
  const cues = req.body?.cues ?? {};
  const roomStems = req.body?.roomStems ?? {};
  // A room's background (rooms.<id>.bg), for the rooms the editor names:
  // a file name, { audio, … }, or null to remove it.
  const bg = req.body?.bg ?? {};
  const hasPhone = req.body != null && Object.prototype.hasOwnProperty.call(req.body, 'phone');
  const phone = req.body?.phone ?? null;
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isMap(zones) || !isMap(thresholds) || !isMap(cues) || !isMap(roomStems) || !isMap(bg) || (beacons != null && !isMap(beacons)) || (phone != null && !isMap(phone))) {
    return res.status(400).json({
      error: 'body must be { zones: { roomId: { zoneId: { polygon, ble? } } }, thresholds?: { roomId: {…} }, roomStems?: { roomId: {…} } }',
    });
  }
  let def;
  try {
    def = JSON.parse(readFileSync(showPath(file), 'utf8'));
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  // A room the disk copy does not have is a stale editor talking about a world
  // that moved — exactly the situation this route exists to refuse loudly.
  const named = new Set([...Object.keys(zones), ...Object.keys(thresholds), ...Object.keys(cues), ...Object.keys(roomStems), ...Object.keys(bg)]);
  const unknown = [...named].filter((roomId) => !def.rooms?.[roomId]);
  if (unknown.length) {
    return res.status(400).json({ error: `rooms not in the show on disk: ${unknown.join(', ')} — reload the editor` });
  }
  for (const [roomId, roomZones] of Object.entries(zones)) {
    def.rooms[roomId].zones = roomZones;
  }
  const empty = (v) => v == null || (isMap(v) && !Object.keys(v).length);
  // Beacons are the editor's whole map when it sends them at all.
  if (hasBeacons) {
    if (empty(beacons)) delete def.beacons;
    else def.beacons = beacons;
  }
  // How phones choose a room (`location.phone`), as a whole when sent.
  if (hasPhone) {
    def.location ??= {};
    if (empty(phone)) delete def.location.phone;
    else def.location.phone = phone;
    if (!Object.keys(def.location).length) delete def.location;
  }
  for (const [roomId, doors] of Object.entries(thresholds)) {
    if (empty(doors)) delete def.rooms[roomId].thresholds;
    else def.rooms[roomId].thresholds = doors;
  }
  for (const [roomId, layer] of Object.entries(bg)) {
    if (layer == null || layer === '') delete def.rooms[roomId].bg;
    else def.rooms[roomId].bg = layer;
  }
  // A room's own audio, by state (§8.1), for the rooms the editor names.
  for (const [roomId, roomCues] of Object.entries(cues)) {
    if (empty(roomCues)) delete def.rooms[roomId].cues;
    else def.rooms[roomId].cues = roomCues;
  }
  if (Object.keys(roomStems).length) {
    if (!isMap(def.museum)) return res.status(400).json({ error: 'this show has no museum block to hold room clips' });
    const all = { ...(def.museum.roomStems ?? {}) };
    for (const [roomId, own] of Object.entries(roomStems)) {
      if (empty(own)) delete all[roomId];
      else all[roomId] = own;
    }
    if (Object.keys(all).length) def.museum.roomStems = all;
    else delete def.museum.roomStems;
  }
  const result = validateShowDefinition(def);
  if (result.errors.length) return res.status(400).json(result);
  try {
    writeFileSync(showPath(file), `${JSON.stringify(def, null, 2)}\n`);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  // Beacons and doors take effect at once in the show that is running, and
  // reach every connected phone: a threshold tuned on site must not wait for
  // a reload that sends every guest back to the start (2026-09-26). The rest
  // of an edit — geometry, clips — still applies on the next load.
  let live = false;
  if (file === loadedShowFile && runtime.def && (hasBeacons || hasPhone || Object.keys(thresholds).length)) {
    const doors = resolveAudioNames(
      Object.fromEntries(Object.keys(thresholds).map((roomId) => [roomId, def.rooms[roomId]?.thresholds ?? null])),
      assetOnDisk,
    ).def;
    live = runtime.applyLocationEdits(
      hasBeacons ? (def.beacons ?? null) : undefined,
      doors,
      hasPhone ? (def.location?.phone ?? null) : undefined,
    );
    if (live) sendAssetsToPhones();
  }
  res.json({ ok: true, warnings: result.warnings, live });
});

/** Virtual walkthrough — set guest floor-plan position (Phase A1). */
app.post('/api/spatial/position', (req, res) => {
  const { guestId, token, x, y } = req.body ?? {};
  const id = guestId ?? token;
  if (!id || typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).json({ error: 'guestId|token, x, y required' });
  }
  const ok = runtime.setVirtualPosition(id, x, y);
  if (!ok) return res.status(400).json({ error: 'show not running or unknown guest' });
  res.json({ ok: true, spatial: runtime.getOperatorSnapshot() });
});

app.post('/api/spatial/tier', (req, res) => {
  const { guestId, token, roomId, occupancy } = req.body ?? {};
  const id = guestId ?? token;
  if (!id || !occupancy) {
    return res.status(400).json({ error: 'guestId|token and occupancy required' });
  }
  const ok = runtime.setVirtualOccupancy(id, roomId ?? null, occupancy);
  if (!ok) return res.status(400).json({ error: 'show not running or unknown guest' });
  res.json({ ok: true, spatial: runtime.getOperatorSnapshot() });
});

/**
 * A guest at a room's doorway, or leaving it (thresholdId null) — §4.2c.
 * The operator panel uses it today; the beacon tracking side will once BLE lands.
 */
app.post('/api/spatial/threshold', (req, res) => {
  const { guestId, token, thresholdId } = req.body ?? {};
  const id = guestId ?? token;
  if (!id) return res.status(400).json({ error: 'guestId|token required' });
  const ok = runtime.setGuestThreshold(id, thresholdId ?? null);
  if (!ok) return res.status(400).json({ error: 'show not running, unknown guest, or unknown threshold' });
  res.json({ ok: true, spatial: runtime.getOperatorSnapshot() });
});

app.post('/api/spatial/activate', (req, res) => {
  const { guestId, token, roomId } = req.body ?? {};
  const id = guestId ?? token;
  if (!id || !roomId) {
    return res.status(400).json({ error: 'guestId|token and roomId required' });
  }
  const result = runtime.requestActivation(id, roomId);
  res.status(result.ok ? 200 : 409).json({ ...result, spatial: runtime.getOperatorSnapshot() });
});

// ---------------------------------------------------------------------------
// Sessions — token → { guestId, label, ws, telemetry, ... }
// ---------------------------------------------------------------------------
const users = new Map();
const operators = new Set();
let loadedShowFile = null;

// Test-mode clock: lets the panel run the show at 10x or pause it outright.
// Must be left at 1x once Phase B schedules real audio against a shared clock.
const showClock = new ScaledClock(1);

const runtime = new SpatialRuntime({
  // How the show reaches a room's own server. Injected rather than imported by
  // the runtime so tests drive the protocol without a network.
  openExperienceSocket: (url) => new WebSocket(url),
  // The museum layer schedules the in_room bed to start exactly when the
  // entrance clip ends, which needs the clip's real length.
  assetSeconds: (asset) => wavSeconds(asset),
  clock: showClock,
  log: opLog,
  onStateChange: scheduleRoster,
  onPositionChange: schedulePositions,
  // The only path from show state to a phone. Everything upstream of this is
  // reconciliation; this just addresses the envelope.
  onCue: (guestId, cue) => {
    const token = runtime.guests.get(guestId)?.token;
    if (token) sendToUser(token, { type: 'cue', cue });
  },
  onOccupancy: (ev) => {
    const who = runtime.guests.get(ev.guestId)?.label ?? ev.guestId;
    opLog(`${who} → ${ev.roomId ?? '∅'} (${ev.occupancy})`);
  },
});

/**
 * Everything a phone must hold before the show starts.
 *
 * Gathered from the loaded show rather than listed by hand: a cue naming an
 * asset nobody preloaded is silence or a blank screen on the night, and the
 * failure looks like a cue that never fired. `BASE_ASSETS` stays because the
 * sync-test tones are used with no show loaded.
 */
function currentAssets() {
  const found = new Set(BASE_ASSETS);
  const collect = (cues) => {
    for (const declared of Object.values(cues ?? {})) {
      for (const option of [].concat(declared)) {
        if (option?.audio) found.add(option.audio);
        if (option?.image) found.add(option.image);
      }
    }
  };
  collect(runtime.def?.guest?.cues);
  for (const cue of Object.values(runtime.def?.guest?.cues ?? {})) {
    collect({ bg: typeof cue?.bg === 'string' ? { audio: cue.bg } : cue?.bg });
  }
  for (const room of Object.values(runtime.def?.rooms ?? {})) {
    collect(room.cues);
    // A room state's own bg (Slop's tracks).
    for (const declared of Object.values(room.cues ?? {})) {
      for (const option of [].concat(declared)) {
        collect({ bg: typeof option?.bg === 'string' ? { audio: option.bg } : option?.bg });
      }
    }
    // A room's bg and the show's bed are layers rather than cues, but a phone
    // plays them all the same.
    collect({ bg: typeof room.bg === 'string' ? { audio: room.bg } : room.bg });
  }
  collect({ bed: runtime.def?.guest?.bed });
  // The museum's stems are cues by another road, and a phone that has not
  // preloaded one plays silence at the exact moment it mattered.
  for (const value of Object.values(runtime.def?.museum?.stems ?? {})) {
    for (const asset of [].concat(value)) if (typeof asset === 'string') found.add(asset);
  }
  // …and so are a room's own takes on them (museum.roomStems).
  for (const own of Object.values(runtime.def?.museum?.roomStems ?? {})) {
    for (const asset of Object.values(own ?? {})) if (typeof asset === 'string') found.add(asset);
  }
  return [...found];
}

/**
 * Cue assets the show names that are not on disk.
 *
 * A missing asset is silence or a blank screen, and both are invisible until a
 * guest is standing in the room staring at one. Nothing checked this and a
 * renamed screen shipped straight through — so this is deliberately reported at
 * load, where a name is still a thing somebody just typed.
 */
const assetOnDisk = (asset) => existsSync(join(assetsDir, asset));

/** A folder's file names, under public/assets; null if there is no such folder. */
function listAssetFolder(folder) {
  const dir = join(assetsDir, folder);
  if (!dir.startsWith(assetsDir + sep)) return null; // stays inside the assets
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return null;
  }
}

/**
 * An audio file's length in seconds, by ffprobe, or null without it. Kept per
 * file and size, so reloading a show does not measure every song again.
 */
const measured = new Map();
function audioSeconds(asset) {
  const path = join(assetsDir, asset);
  let key;
  try {
    const st = statSync(path);
    key = `${path}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
  if (!measured.has(key)) {
    let seconds = null;
    try {
      const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/opt/homebrew/bin` },
      });
      const n = Number.parseFloat(out);
      seconds = Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
    } catch { /* no ffprobe here: the piece falls back to its own lengths */ }
    measured.set(key, seconds);
  }
  return measured.get(key);
}

function missingAssets() {
  return currentAssets().filter((asset) => !assetOnDisk(asset));
}
let assetProblems = [];

/**
 * Seconds of a WAV, read straight from its header. No decoder, no dependency,
 * and `null` for anything else — this exists for one check and does not need to
 * understand audio.
 */
function wavSeconds(asset) {
  if (!/\.wav$/i.test(asset)) return null;
  try {
    const head = readFileSync(join(assetsDir, asset)).subarray(0, 64);
    if (head.toString('ascii', 0, 4) !== 'RIFF') return null;
    const byteRate = head.readUInt32LE(28);
    const dataSize = head.readUInt32LE(40);
    return byteRate > 0 ? dataSize / byteRate : null;
  } catch {
    return null;
  }
}

/**
 * A very short sound set to loop.
 *
 * This is not a style note. `click.wav` is a five-millisecond transient in a
 * fifty-millisecond file, made for measuring sync skew, and a show declared it
 * `loop: true` — which is a tick twenty times a second in a guest's ears for as
 * long as they are off-path, which is forever. It went unnoticed until somebody
 * wore the headphones.
 */
function badLoops(def) {
  const found = [];
  const check = (cues, where) => {
    for (const [key, declared] of Object.entries(cues ?? {})) {
      for (const cue of [].concat(declared)) {
        if (!cue?.loop || !cue.audio) continue;
        const seconds = wavSeconds(cue.audio);
        if (seconds != null && seconds < 1) {
          found.push(`${where}.${key} loops ${cue.audio}, which is ${Math.round(seconds * 1000)}ms long`);
        }
      }
    }
  };
  check(def.guest?.cues, 'guest.cues');
  for (const [roomId, room] of Object.entries(def.rooms ?? {})) check(room.cues, `rooms.${roomId}.cues`);
  return found;
}
let notInstalled = [];

function loadShow(file) {
  const path = showPath(file);
  let def;
  try {
    def = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    opLog(`load failed: ${err.message}`);
    return;
  }
  const placed = applyInstallation(def, installation);
  def = placed.def;
  for (const e of placed.errors) opLog(`✗ ${e}`);
  for (const w of placed.warnings) opLog(`⚠ ${w}`);
  if (placed.errors.length) return;
  notInstalled = placed.notInstalled;

  // A room's songs, read from its folder (rooms.<id>.tracks): whatever is in
  // it now is in the rotation.
  const tracks = expandTrackFolders(def, { list: listAssetFolder, seconds: audioSeconds });
  def = tracks.def;
  for (const note of tracks.notes) opLog(note);
  for (const problem of tracks.problems) opLog(`⚠ ${problem}`);

  // A clip named .mp3 plays the .m4a on disk, and the other way round.
  const audio = resolveAudioNames(def, assetOnDisk);
  def = audio.def;
  for (const { from, to } of audio.swaps) opLog(`audio: ${from} → ${to}`);

  const result = runtime.load(def);
  for (const w of result.warnings ?? []) opLog(`⚠ ${w}`);
  if (!result.ok) {
    for (const e of result.errors) opLog(`✗ ${e}`);
    return;
  }
  loadedShowFile = basename(file);
  // Every guest went with the old show, but a phone still connected does not
  // know: its socket stayed up, so it never says hello again and sits outside
  // the show — no room, no audio, "Waiting for the show…" (#14, 2026-09-28).
  // Close those sockets; the page reconnects at once, and its hello starts a
  // fresh visit (on the same guestId, for a handset that names itself).
  for (const [t, u] of [...users]) {
    if (runtime.getGuestByToken(t)) continue;
    users.delete(t);
    if (u.ws) {
      try { u.ws.close(1012, 'show loaded'); } catch { /* already gone */ }
    }
  }
  assetProblems = missingAssets();
  for (const asset of assetProblems) opLog(`✗ missing asset: ${asset}`);
  for (const loop of badLoops(def)) opLog(`⚠ ${loop} — that is a tick, not a texture`);
  sendAssetsToPhones();
  sendRoster();
}

/** What every connected phone holds from the show: assets, mixer, input, beacons. */
function sendAssetsToPhones() {
  broadcast({
    type: 'assets',
    assets: currentAssets(),
    audioLayers: runtime.def?.guest?.audioLayers ?? null,
    input: runtime.def?.guest?.input ?? null,
    beacons: runtime.def?.beacons ?? null,
    hallways: runtime.impliedHallways(),
    adjacent: runtime.roomAdjacency(),
    locator: runtime.def?.location?.phone ?? null,
  }, 'phones');
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendToUser(token, obj) {
  send(users.get(token)?.ws, obj);
}

function broadcast(obj, who) {
  if (who === 'phones' || who === 'all') {
    for (const u of users.values()) send(u.ws, obj);
  }
  if (who === 'operators' || who === 'all') {
    for (const ws of operators) send(ws, obj);
  }
}

function opLog(line) {
  broadcast({ type: 'log', line, at: Date.now() }, 'operators');
  console.log('[show]', line);
}

/**
 * Motion updates are pushed on their own channel, throttled to ~60ms. They
 * carry only what moves a dot; the full roster stays on its slower cadence
 * because it includes every guest's visit history and the recent event log.
 */
let positionsTimer = null;
function schedulePositions() {
  if (positionsTimer || rosterTimer) return;
  positionsTimer = setTimeout(() => {
    positionsTimer = null;
    broadcast({ type: 'positions', guests: runtime.getPositionsSnapshot() }, 'operators');
  }, 60);
}

let rosterTimer = null;
function scheduleRoster() {
  if (rosterTimer) return;
  rosterTimer = setTimeout(() => {
    rosterTimer = null;
    sendRoster();
  }, 60);
}

function sendRoster() {
  pushPhoneStates();
  const now = Date.now();
  const rosterUsers = [];
  for (const [token, u] of users.entries()) {
    const offlineMs = u.ws ? 0 : now - (u.disconnectedAt ?? now);
    if (!u.ws && offlineMs > OFFLINE_HIDE_MS) continue;
    const guest = runtime.getGuestByToken(token);
    rosterUsers.push({
      token,
      guestId: u.guestId,
      visitId: guest?.visitId ?? null,
      label: u.label,
      device: u.device ?? null,
      connected: !!u.ws,
      disconnectedForMs: offlineMs,
      telemetry: u.telemetry ?? null,
      pathId: guest?.pathId ?? null,
      regions: guest?.regions ?? null,
      adherence: guest?.adherence ?? null,
      roomId: guest?.roomId ?? null,
      occupancy: guest?.occupancy ?? null,
    });
  }

  broadcast({
    type: 'roster',
    users: rosterUsers,
    spatial: runtime.getOperatorSnapshot(),
    show: {
      ...runtime.rosterInfo(),
      file: loadedShowFile,
      missingAssets: assetProblems,
      installation: installation?.installation ?? (installationPath ? basename(installationPath) : null),
      notInstalled,
    },
    shows: listShows(),
  }, 'operators');
}

setInterval(sendRoster, 2000);

function label(token) {
  return users.get(token)?.label ?? '?';
}

/**
 * A show handset's number (Headwind's device number, sent by the Android app in
 * `hello`). It becomes the guest's label — "#23" is the phone with 23 on its case.
 */
function cleanDevice(value) {
  const s = value == null ? '' : String(value).trim();
  return /^[A-Za-z0-9-]{1,16}$/.test(s) ? s : null;
}

function applyDevice(token, device) {
  const u = users.get(token);
  if (!u || !device) return;
  u.device = device;
  u.label = `#${device}`;
  const guest = runtime.guests.get(u.guestId);
  if (guest) guest.label = u.label;
}

/**
 * What the Android app says about the handset, riding the page's telemetry:
 * battery, Wi-Fi, beacons heard, the content it holds. Only known fields, and
 * only of the right type — it is shown on the operator panel as-is.
 */
function cleanPhoneStatus(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  const num = (k, lo, hi) => { if (typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= lo && p[k] <= hi) out[k] = p[k]; };
  const str = (k, max) => { if (typeof p[k] === 'string' && p[k].length <= max) out[k] = p[k]; };
  const bool = (k) => { if (typeof p[k] === 'boolean') out[k] = p[k]; };
  num('battery', 0, 100); bool('charging'); num('wifiRssi', -127, 0); num('blePerSec', 0, 10000);
  str('content', 32); num('contentSyncedAt', 0, 1e14); bool('syncing'); str('syncError', 160);
  str('map', 16); num('mapSize', 0, 100000);
  str('room', 64); num('roomMajor', 0, 65535); bool('estimated'); str('door', 64);
  str('app', 32);
  return out;
}

/**
 * Where the runtime thinks this guest is, as one line.
 *
 * A phone in a pocket during a walkthrough is hard to read; naming its guest's
 * room and standing turns the handset into its own probe.
 */
function phoneState(token) {
  const guest = runtime.getGuestByToken(token);
  const here = guest ? runtime.guestActors.get(guest.guestId)?.currentRoom() : null;
  return here ? `${here.roomId} · ${here.standing}` : 'outside';
}

// ---------------------------------------------------------------------------
// Room words (2026-09-27)
//
// Each room with a word (poster/words.json) shows it on a guest's phone the
// moment they are in that room — every time, a return included. The words a
// visit collects are kept for the receipt poster.
// ---------------------------------------------------------------------------
function loadRoomWords() {
  try {
    const bank = JSON.parse(readFileSync(join(root, 'poster', 'words.json'), 'utf8'));
    return Object.fromEntries(Object.entries(bank.rooms ?? {}).map(([roomId, r]) => [roomId, r?.word]).filter(([, w]) => w));
  } catch (err) {
    console.warn(`room words: ${err.message}`);
    return {};
  }
}
const ROOM_WORDS = loadRoomWords();
/** visitId → [{ roomId, word, at }], in the order shown. */
const visitWords = new Map();
/** token → the room its phone was last told about, so a word pops only on arrival. */
const lastPhoneRoom = new Map();

function phoneRoom(token) {
  const guest = runtime.getGuestByToken(token);
  return guest ? runtime.guestActors.get(guest.guestId)?.currentRoom()?.roomId ?? null : null;
}

function companionPhase(token) {
  const guest = runtime.getGuestByToken(token);
  return guest ? runtime.companionPhase(guest.guestId) : null;
}

function lastWordOf(token) {
  const visitId = runtime.getGuestByToken(token)?.visitId;
  const words = visitId ? visitWords.get(visitId) : null;
  return words?.length ? words[words.length - 1].word : null;
}

/** The guest has just arrived in `roomId`: its word, if it has one. */
function showRoomWord(token, roomId) {
  const word = ROOM_WORDS[roomId];
  if (!word) return;
  const visitId = runtime.getGuestByToken(token)?.visitId;
  if (visitId) {
    if (!visitWords.has(visitId)) visitWords.set(visitId, []);
    visitWords.get(visitId).push({ roomId, word, at: Date.now() });
  }
  sendToUser(token, { type: 'word', word, roomId, at: Date.now() });
}

/**
 * Push that line whenever it changes. The client has always handled a `state`
 * message; nothing ever sent one, so the readout was fixed at whatever was true
 * when the phone connected and only moved on refresh.
 */
const lastPhoneState = new Map();
function pushPhoneStates() {
  for (const [token, u] of users.entries()) {
    if (!u.ws) continue;
    const room = phoneRoom(token);
    if (room && lastPhoneRoom.get(token) !== room) showRoomWord(token, room);
    if (room) lastPhoneRoom.set(token, room);
    const phase = companionPhase(token);
    const next = `${phoneState(token)}|${phase}`;
    if (lastPhoneState.get(token) === next) continue;
    lastPhoneState.set(token, next);
    sendToUser(token, { type: 'state', state: phoneState(token), phase });
  }
  for (const token of lastPhoneState.keys()) {
    if (!users.has(token)) lastPhoneState.delete(token);
  }
  for (const token of lastPhoneRoom.keys()) {
    if (!users.has(token)) lastPhoneRoom.delete(token);
  }
}

function phoneSnapshot(token) {
  const guest = runtime.getGuestByToken(token);
  return {
    serverTime: Date.now(),
    state: phoneState(token),
    // The companion screen: which phase, and the last word shown (for idle).
    phase: companionPhase(token),
    lastWord: lastWordOf(token),
    spatial: guest
      ? {
          pathId: guest.pathId,
          regions: guest.regions,
          adherence: guest.adherence,
          roomId: guest.roomId,
          occupancy: guest.occupancy,
        }
      : null,
    relay: relay.syncForRoom(relay.audienceKey(runtime, token)),
  };
}

/**
 * @param {string|null} token
 * @param {string|null} [device] — the handset's own number, which becomes its
 *   guestId: the same phone is the same guest for good, visit after visit.
 */
function ensurePhoneSession(token, device = null) {
  if (token && runtime.getGuestByToken(token)) {
    const u = users.get(token);
    if (u) return { token, ...u };
  }
  // A handset is being issued. This guest is a person from here on.
  const spawned = runtime.spawnGuest({
    kind: 'phone',
    ...(device ? { guestId: device, label: `#${device}` } : {}),
  });
  if (!spawned) return null;
  users.set(spawned.token, {
    guestId: spawned.guestId,
    visitId: spawned.visitId,
    label: spawned.label,
    ws: null,
    telemetry: null,
    connectedAt: Date.now(),
    disconnectedAt: null,
  });
  return { token: spawned.token, ...users.get(spawned.token) };
}

/**
 * Retire whatever visit a guest is on: the phone has been handed to someone
 * new. The guest goes from the show — its rooms see a departure, the same as
 * any walk-out — and its session is forgotten, so the next spawn under the
 * same guestId starts the show from the top. A socket still open on the old
 * visit (a second tab) is told it was displaced rather than left to flap.
 */
function endVisit(guestId, except) {
  for (const [t, u] of users.entries()) {
    if (u.guestId !== guestId) continue;
    if (u.ws && u.ws !== except) {
      try {
        send(u.ws, { type: 'displaced' });
        u.ws.close(4001, 'displaced');
      } catch { /* already gone */ }
    }
    notifyRelayPeerLeft(t);
    users.delete(t);
  }
  runtime.removeGuest(guestId);
}

function sendRelaySync(token) {
  sendToUser(token, {
    type: 'relaySync',
    channels: relay.syncForRoom(relay.audienceKey(runtime, token)),
  });
}

function broadcastRelay(fromToken, envelope, audience) {
  for (const t of audience) {
    sendToUser(t, { ...envelope, self: t === fromToken });
  }
}

function notifyRelayPeerLeft(token) {
  const u = users.get(token);
  if (!u) return;
  const from = relay.senderFrom(users, token, label);
  const roomKey = relay.audienceKey(runtime, token);
  const channels = relay.clearPeer(roomKey, u.guestId);
  if (!channels.length) return;
  const at = Date.now();
  const audience = relay.audienceTokens(runtime, users, token).filter((t) => t !== token);
  for (const channel of channels) {
    for (const t of audience) {
      sendToUser(t, { type: 'relay', channel, from, payload: null, at, self: false });
    }
  }
}

function handleRelay(token, msg) {
  if (!users.get(token)?.ws) return;
  const { channel, payload, persist } = msg;
  if (!relay.validateChannel(channel) || !relay.validatePayload(payload)) return;
  if (!relay.checkRateLimit(token, channel)) return;

  const roomKey = relay.audienceKey(runtime, token);
  const from = relay.senderFrom(users, token, label);
  const at = Date.now();
  const envelope = { type: 'relay', channel, from, payload, at };

  if (persist !== false && payload != null) {
    relay.persistEntry(roomKey, channel, from.guestId, { from, payload, at });
  } else if (payload === null) {
    relay.persistEntry(roomKey, channel, from.guestId, null);
  }

  broadcastRelay(token, envelope, relay.audienceTokens(runtime, users, token));
}

function clearOfflinePhones() {
  const removed = [];
  for (const [token, u] of users.entries()) {
    if (u.ws) continue;
    const offlineMs = Date.now() - (u.disconnectedAt ?? Date.now());
    if (offlineMs <= OFFLINE_HIDE_MS) continue;
    const guest = runtime.getGuestByToken(token);
    if (guest) runtime.removeGuest(guest.guestId);
    notifyRelayPeerLeft(token);
    users.delete(token);
    removed.push(u.label);
  }
  if (removed.length) opLog(`cleared offline: ${removed.join(', ')}`);
  sendRoster();
  return removed.length;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  let token = null;
  let isOperator = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello': {
        if (msg.role === 'operator') {
          isOperator = true;
          operators.add(ws);
          sendRoster();
          opLog('operator connected');
          return;
        }

        // A handset that names itself (the Android app's Headwind number) is
        // always the same guest. Its token is the visit: kept across refreshes
        // and reconnects, wiped by the app when the phone is handed on — so a
        // phone with no token, or one the server no longer knows, is a new
        // person on the same phone. A browser names nothing, and its token is
        // the whole identity, as before.
        const device = cleanDevice(msg.device);
        const known = msg.token ? runtime.getGuestByToken(msg.token) : null;
        const sameVisit = known && (!device || known.guestId === device);
        if (device && !sameVisit) {
          if (known) endVisit(known.guestId, ws);
          endVisit(device, ws);
        }

        if (sameVisit) {
          token = msg.token;
          let u = users.get(token);
          if (!u) {
            const p = runtime.getGuestByToken(token);
            u = {
              guestId: p.guestId,
              label: p.label,
              ws: null,
              telemetry: null,
              connectedAt: Date.now(),
              disconnectedAt: null,
            };
            users.set(token, u);
          }
          if (u.ws && u.ws !== ws) {
            // One guest, one handset — the newest connection wins. But it has to
            // be told *why*, or it simply reconnects, displaces this one in turn,
            // and the two flap against each other for as long as both pages are
            // open. A second tab on the same phone is enough to start it.
            try {
              send(u.ws, { type: 'displaced' });
              u.ws.close(4001, 'displaced');
            } catch { /* already gone */ }
          }
          u.ws = ws;
          u.disconnectedAt = null;
          const p = runtime.getGuestByToken(token);
          if (p) {
            p.connected = true;
            runtime.coordinator?.setConnected(p.guestId, true);
            runtime.coordinator?.touchLocation(p.guestId);
          }
        } else {
          const session = ensurePhoneSession(null, device);
          if (!session) return;
          token = session.token;
          const u = users.get(token);
          u.ws = ws;
          if (device) opLog(`#${device}: new visit ${session.visitId}`);
        }

        // The Android app names the handset; a browser sends no device.
        applyDevice(token, device);

        send(ws, {
          type: 'welcome',
          token,
          guestId: users.get(token).guestId,
          visitId: runtime.getGuestByToken(token)?.visitId ?? null,
          label: label(token),
          serverTime: Date.now(),
          assets: currentAssets(),
          // How this show mixes: duck depth and crossfade length (CONTRACT §8.1).
          audioLayers: runtime.def?.guest?.audioLayers ?? null,
          // How the handset is worn: mirrorY flips up and down (§8.1).
          input: runtime.def?.guest?.input ?? null,
          // For the handset's own room picker; see `setRoom`.
          rooms: runtime.roomChoices(),
          // What each beacon means, for the Android app's locator (keyed by major).
          beacons: runtime.def?.beacons ?? null,
          // Hallways without beacons, and the rooms around them (the app infers them).
          hallways: runtime.impliedHallways(),
          // Which rooms connect, so the app only moves a guest next door.
          adjacent: runtime.roomAdjacency(),
          // How the app chooses a room: margins in dB, tuned live (§4.2b).
          locator: runtime.def?.location?.phone ?? null,
          snapshot: phoneSnapshot(token),
        });
        sendRelaySync(token);
        sendRoster();
        return;
      }

      case 'ready': {
        // Phone has an unlocked AudioContext and preloaded assets. Replay
        // whatever it should already be hearing.
        const guest = runtime.getGuestByToken(token);
        if (guest) runtime.resyncCues(guest.guestId);
        return;
      }

      case 'setGuestPath': {
        if (!isOperator) return;
        if (runtime.setGuestPath(msg.guestId, msg.pathId ?? null)) {
          opLog(`${runtime.guests.get(msg.guestId)?.label ?? msg.guestId} → ${msg.pathId ?? 'no path'}`);
          sendRoster();
        }
        return;
      }

      case 'sendGuestToRoom': {
        if (!isOperator) return;
        if (runtime.sendGuestToRoom(msg.guestId, msg.roomId ?? null)) {
          opLog(`sent ${runtime.guests.get(msg.guestId)?.label ?? msg.guestId} to ${msg.roomId ?? 'outside'}`);
          sendRoster();
        }
        return;
      }

      case 'setRoom': {
        // The handset reporting where it is. Stands in for BLE until there are
        // beacons — one person can then walk the real building with the real
        // phone and the show follows them, with nobody at the panel.
        const guest = runtime.getGuestByToken(token);
        if (!guest) return;
        if (runtime.sendGuestToRoom(guest.guestId, msg.roomId ?? null)) sendRoster();
        return;
      }

      case 'input': {
        // A gesture on a phone. The show decides what it means; an unbound one
        // is not an error — most of the show asks for nothing.
        const guest = runtime.getGuestByToken(token);
        const kind = msg.event?.type;
        if (guest && kind) runtime.guestInput(guest.guestId, kind);
        return;
      }

      case 'ping': {
        send(ws, { type: 'pong', t0: msg.t0, server: Date.now() });
        // A phone the app locates reports only when its room changes, so its
        // pings are what say it is still there (contact loss, CONTRACT §4.3).
        const pinged = runtime.getGuestByToken(token);
        if (pinged) runtime.coordinator?.touchLocation(pinged.guestId);
        return;
      }

      case 'location': {
        // The Android app's beacon reading, through this page's socket:
        // { major } of the strongest room group it hears.
        // Or { room } — a hallway with no beacons, inferred by the phone from
        // the rooms it hears around it (runtime.impliedHallways).
        const guest = runtime.getGuestByToken(token);
        if (!guest) return;
        if (typeof msg.room === 'string') {
          if (runtime.setGuestHallway(guest.guestId, msg.room).ok) sendRoster();
          return;
        }
        if (msg.major == null) return;
        if (runtime.setGuestBeacon(guest.guestId, msg.major).ok) sendRoster();
        return;
      }

      case 'playing': {
        // The page began playing a clip: { assetId, slot, at } (server time).
        const guest = runtime.getGuestByToken(token);
        if (guest) runtime.clipPlaying(guest.guestId, msg.assetId, msg.at);
        return;
      }

      case 'door': {
        // Arriving at a door beacon ({ major }), or leaving it ({ major: null }).
        const guest = runtime.getGuestByToken(token);
        if (!guest) return;
        if (runtime.setGuestDoorBeacon(guest.guestId, msg.major ?? null)) sendRoster();
        return;
      }

      case 'telemetry': {
        const u = users.get(token);
        if (u) {
          u.telemetry = {
            phone: cleanPhoneStatus(msg.phone),
            at: Date.now(),
          };
        }
        return;
      }

      case 'relay':
        if (!token) return;
        handleRelay(token, msg);
        return;

      case 'loadShow':
        if (isOperator) loadShow(msg.file);
        return;

      case 'startShow':
        if (!isOperator) return;
        runtime.start();
        sendRoster();
        return;

      case 'stopShow':
        if (!isOperator) return;
        runtime.stop();
        sendRoster();
        return;

      case 'setTimeScale': {
        if (!isOperator) return;
        const rate = runtime.setTimeScale(Number(msg.rate));
        if (rate != null) opLog(rate === 0 ? 'time paused' : `time scale ${rate}x`);
        sendRoster();
        return;
      }

      case 'configureWalkthrough': {
        if (!isOperator) return;
        runtime.walkthrough?.configure(msg.config ?? {});
        opLog(`walk settings: ${JSON.stringify(msg.config ?? {})}`);
        sendRoster();
        return;
      }

      case 'startWalkthrough': {
        if (!isOperator) return;
        runtime.walkthrough?.configure(msg.config ?? {});
        runtime.walkthrough?.start(msg.guestIds);
        opLog('walkthrough started');
        sendRoster();
        return;
      }

      case 'stopWalkthrough': {
        if (!isOperator) return;
        runtime.walkthrough?.stop(msg.guestIds);
        opLog('walkthrough stopped');
        sendRoster();
        return;
      }

      case 'activateForOccupant': {
        if (!isOperator) return;
        const result = runtime.activateForOccupant(msg.roomId);
        opLog(result.ok
          ? `${msg.roomId}: activated for ${runtime.guests.get(result.guestId)?.label ?? result.guestId}`
          : `${msg.roomId}: cannot activate — ${result.reason}`);
        sendRoster();
        return;
      }

      case 'sendRoomEvent': {
        if (!isOperator) return;
        if (runtime.sendRoomEvent(msg.roomId, msg.event)) {
          opLog(`${msg.roomId} ← ${msg.event}`);
          sendRoster();
        }
        return;
      }

      case 'refreshExperience': {
        if (!isOperator) return;
        if (runtime.refreshExperience(msg.roomId)) opLog(`${msg.roomId} ← refresh experience`);
        return;
      }

      case 'removeGuest': {
        if (!isOperator) return;
        if (runtime.removeGuest(msg.guestId)) sendRoster();
        return;
      }

      case 'spawnGuest': {
        if (!isOperator) return;
        const count = Math.min(Math.max(1, Number(msg.count) || 1), 60);
        const spawnedIds = [];
        for (let i = 0; i < count; i++) {
          const spawned = runtime.spawnGuest({ label: count === 1 ? msg.label : undefined });
          if (!spawned) break;
          users.set(spawned.token, {
            guestId: spawned.guestId,
            label: spawned.label,
            ws: null,
            telemetry: null,
            connectedAt: Date.now(),
            disconnectedAt: null,
          });
          spawnedIds.push(spawned.guestId);
        }
        if (!spawnedIds.length) return;
        opLog(spawnedIds.length === 1
          ? `spawned 1 guest`
          : `spawned ${spawnedIds.length} guests`);
        if (msg.walk) runtime.walkthrough?.start(spawnedIds);
        sendRoster();
        return;
      }

      case 'setVirtualPosition': {
        if (!isOperator) return;
        const id = msg.guestId ?? msg.token;
        if (!id || typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
        if (runtime.setVirtualPosition(id, msg.x, msg.y)) sendRoster();
        return;
      }

      case 'setVirtualOccupancy': {
        if (!isOperator) return;
        const id = msg.guestId ?? msg.token;
        if (!id || !msg.occupancy) return;
        if (runtime.setVirtualOccupancy(id, msg.roomId ?? null, msg.occupancy)) sendRoster();
        return;
      }

      case 'setGuestThreshold': {
        if (!isOperator) return;
        const id = msg.guestId ?? msg.token;
        if (!id) return;
        if (runtime.setGuestThreshold(id, msg.thresholdId ?? null)) sendRoster();
        return;
      }

      case 'requestActivation': {
        if (!isOperator) return;
        const id = msg.guestId ?? msg.token;
        if (!id || !msg.roomId) return;
        const result = runtime.requestActivation(id, msg.roomId);
        opLog(`activate ${msg.roomId} ← ${id}: ${result.ok ? result.state : result.reason}`);
        sendRoster();
        return;
      }

      case 'releaseRoomLock': {
        if (!isOperator || !msg.roomId) return;
        runtime.releaseRoomLock(msg.roomId, msg.guestId ?? null);
        sendRoster();
        return;
      }

      case 'clearOfflinePhones':
        if (isOperator) clearOfflinePhones();
        return;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (isOperator) {
      operators.delete(ws);
      return;
    }
    if (token && users.get(token)?.ws === ws) {
      const u = users.get(token);
      u.ws = null;
      u.disconnectedAt = Date.now();
      const p = runtime.getGuestByToken(token);
      if (p) {
        p.connected = false;
        runtime.coordinator?.setConnected(p.guestId, false);
      }
      notifyRelayPeerLeft(token);
      sendRoster();
    }
  });
});

/**
 * The show this server runs from boot, started at once (2026-09-26): a
 * restarted server is back in the show before the phones have reconnected.
 * `--show <file>` or SHOW names another; SHOW='' boots with none, which is how
 * the test harness starts every server empty.
 */
const DEFAULT_SHOW = 'MAD-DIM.json';
const showFlag = argv.indexOf('--show');
const bootShow = showFlag >= 0 && argv[showFlag + 1] ? argv[showFlag + 1] : process.env.SHOW ?? DEFAULT_SHOW;
if (bootShow) {
  loadShow(bootShow);
  if (loadedShowFile === basename(bootShow)) {
    runtime.start();
    opLog(`${loadedShowFile} loaded and started at boot`);
  } else {
    opLog(`✗ ${bootShow} did not load at boot — load it from the panel`);
  }
}

httpServer.listen(PORT, () => {
  // The bound port, not the asked-for one. `PORT=0` means "any free port",
  // which is how the test harness boots a server without fighting whatever is
  // already on 4100 — and it also makes the banner honest in that case.
  const port = httpServer.address().port;
  console.log('DIM Machine — spatial runtime (v0.3 Phase A)');
  console.log(`  phone client:   http://localhost:${port}/`);
  console.log(`  operator panel: http://localhost:${port}/operator.html`);
  console.log(`  shows dir:      ${showsDir} (${listShows().join(', ') || 'empty'})`);
  console.log(`  installation:   ${installation?.installation ?? (installationPath || 'none — the show carries its own addresses')}`);
  console.log(`  show:           ${loadedShowFile ? `${loadedShowFile}${runtime.running ? ', running' : ''}` : 'none'}`);
  // Only ever set when started with `fork()`, which nothing but the tests does.
  // Parsing the banner would work until somebody reworded it.
  process.send?.({ type: 'listening', port });
});
