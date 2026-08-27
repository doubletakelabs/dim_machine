/**
 * Where a show's rooms physically are.
 *
 * A show describes the work: rooms, paths, cues, what a guest hears, and that a
 * room hands its interaction to a piece called `influence-clickfarm`. It should
 * not describe a machine's address on a particular network — that is an install
 * fact, and putting it in the show means rehearsing somewhere else is an edit to
 * the artistic document, a re-addressed router is a change to it, and twelve IP
 * addresses end up scattered through two thousand lines of JSON with nothing
 * collecting them into one view.
 *
 * So addresses live here instead:
 *
 *   {
 *     "installation": "The Museum — Main Venue",
 *     "requireAll": true,
 *     "experiences": {
 *       "influence": "ws://10.0.0.11:8080",
 *       "kin": { "endpoint": "ws://10.0.0.12:8080", "phoneEndpoint": "ws://10.0.0.12:8080" }
 *     }
 *   }
 *
 * ## Partial on purpose
 *
 * A rehearsal happens on a laptop with one or two pieces actually running. A
 * room whose experience has no address here is simply **not installed** in this
 * installation: it runs as an ordinary room, admits guests, plays its audio, and
 * cues nobody to drive anything. That is the right answer for a laptop and the
 * wrong answer for a venue, so the file says which it is. `requireAll: true`
 * turns a missing address into a load error — the check that catches a room
 * somebody forgot, at load, rather than when a guest walks into it.
 */

/**
 * @param {object} def — the show
 * @param {object|null} installation
 * @returns {{ def: object, errors: string[], warnings: string[], notInstalled: string[] }}
 */
export function applyInstallation(def, installation) {
  const errors = [];
  const warnings = [];
  const notInstalled = [];
  const out = structuredClone(def ?? {});
  const rooms = out.rooms ?? {};

  if (installation != null && typeof installation !== 'object') {
    return { def: out, errors: ['installation must be a JSON object'], warnings, notInstalled };
  }

  const addresses = installation?.experiences ?? {};
  if (installation && !isObject(installation.experiences)) {
    errors.push('installation.experiences must be an object keyed by room id');
  }

  // An address for a room that has no experience is a typo, and a silent one:
  // the room it was meant for goes uninstalled while this looks configured.
  for (const roomId of Object.keys(addresses)) {
    if (!rooms[roomId]) {
      errors.push(`installation.experiences["${roomId}"] names a room the show does not have`);
    } else if (!rooms[roomId].experience) {
      errors.push(`installation.experiences["${roomId}"] has an address, but that room declares no experience`);
    }
  }

  for (const [roomId, room] of Object.entries(rooms)) {
    if (!room.experience) continue;
    const declared = addresses[roomId];
    const resolved = normalise(declared);

    if (resolved) {
      room.experience.endpoint = resolved.endpoint;
      room.experience.phoneEndpoint = resolved.phoneEndpoint ?? resolved.endpoint;
      continue;
    }
    if (declared != null) {
      errors.push(`installation.experiences["${roomId}"] must be a ws:// URL or { endpoint, phoneEndpoint }`);
      continue;
    }
    // A show may still carry its own endpoint — useful with no installation file
    // at all — but an installation that was given wins over it.
    if (installation && room.experience.endpoint) {
      delete room.experience.endpoint;
      delete room.experience.phoneEndpoint;
    }
    if (!room.experience.endpoint) {
      notInstalled.push(roomId);
      const message = `rooms.${roomId} declares an experience with no address in this installation`;
      if (installation?.requireAll) errors.push(message);
      else warnings.push(`${message} — it will run as an ordinary room`);
    }
  }

  return { def: out, errors, warnings, notInstalled };
}

function normalise(value) {
  if (typeof value === 'string') {
    return /^wss?:\/\//.test(value) ? { endpoint: value } : null;
  }
  if (!isObject(value) || typeof value.endpoint !== 'string') return null;
  if (!/^wss?:\/\//.test(value.endpoint)) return null;
  if (value.phoneEndpoint != null && !/^wss?:\/\//.test(value.phoneEndpoint)) return null;
  return { endpoint: value.endpoint, phoneEndpoint: value.phoneEndpoint };
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Rewrite every address to one host. The laptop shortcut, kept separate from
 * installations because it means something different: not "this is where the
 * rooms are" but "ignore where the rooms are, everything is here".
 */
export function overrideHost(def, hostPort) {
  if (!hostPort) return def;
  const [host, port] = String(hostPort).split(':');
  for (const room of Object.values(def.rooms ?? {})) {
    for (const field of ['endpoint', 'phoneEndpoint']) {
      if (!room.experience?.[field]) continue;
      const url = new URL(room.experience[field]);
      url.hostname = host;
      if (port) url.port = port;
      room.experience[field] = url.toString().replace(/\/$/, '');
    }
  }
  return def;
}
