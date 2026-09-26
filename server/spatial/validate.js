import {
  CONTRACT_VERSION,
  REQUIRED_ROOM_STATES,
  SETTLING_TRANSITIONS,
  REQUIRED_ROOM_TRANSITIONS,
  ELIGIBILITY_STRATEGIES,
  PATH_ASSIGNMENT_STRATEGIES,
  INELIGIBLE_POLICIES,
  MULTI_GUEST_POLICIES,
  AT_CAPACITY_POLICIES,
  EXIT_POLICIES,
  WHEN_AVAILABLE_POLICIES,
  AUDIO_TIMINGS,
  AUDIO_JOIN_POLICIES,
  AUDIO_ON_EXIT,
  GUIDANCE_POLICIES,
  REVISIT_EVENTS,
  ROOM_KINDS,
  OFF_PATH_ACTIVATION_EVENT,
  AUTHORED_GUEST_REGIONS,
  enteredEvent,
} from './contract.js';
import { IMPLEMENTED_ELIGIBILITY_STRATEGIES } from './eligibility.js';
import { expandSequences } from './sequence.js';
import {
  CUE_AUDIENCES, CUE_SLOTS, INPUT_KINDS, INPUT_MODES, EXPERIENCE_INTENTS, defaultCueAudience,
} from './contract.js';
import { polygonsOverlap } from './zone-math.js';
import { checkMuseum } from './museum.js';

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function requireString(obj, key, path, errors) {
  if (typeof obj[key] !== 'string' || !obj[key].trim()) {
    errors.push(`${path}.${key} must be a non-empty string`);
    return false;
  }
  return true;
}

/**
 * Show definitions are the program (principle #1, "logic as data"), so the
 * schema is the only type system this project has. A misspelled policy that
 * loads clean and silently does nothing is the failure mode worth spending
 * validation on.
 */
function checkEnum(value, allowed, path, errors) {
  if (value == null) return;
  if (!allowed.includes(value)) {
    errors.push(`${path} must be one of: ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
}

/** Does state `node` handle `event` — via `on` or a wildcard? */
function handlesEvent(node, event) {
  if (!isObject(node)) return false;
  return isObject(node.on) && (event in node.on || '*' in node.on);
}

function checkRoomMachine(machine, path, errors) {
  if (!isObject(machine)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof machine.initial !== 'string') {
    errors.push(`${path}.initial must be a string`);
  }
  if (!isObject(machine.states) || !Object.keys(machine.states).length) {
    errors.push(`${path}.states must be a non-empty object`);
    return;
  }

  const states = machine.states;
  for (const required of REQUIRED_ROOM_STATES) {
    if (!isObject(states[required])) {
      errors.push(`${path}.states.${required} is required by the room contract`);
    }
  }
  if (machine.initial !== 'idle' && states.idle) {
    errors.push(`${path}.initial must be "idle"`);
  }

  for (const { state, event, why } of REQUIRED_ROOM_TRANSITIONS) {
    if (!isObject(states[state])) continue;
    if (!handlesEvent(states[state], event)) {
      errors.push(`${path}.states.${state} must handle "${event}" — ${why}`);
    }
  }
  // Settling is optional since 2026-09-11 — but a machine that authors one
  // still owes it a way out, or the exit grace strands the room there.
  if (isObject(states.settling)) {
    for (const { state, event, why } of SETTLING_TRANSITIONS) {
      if (!handlesEvent(states[state], event)) {
        errors.push(`${path}.states.${state} must handle "${event}" — ${why}`);
      }
    }
  }
}

/**
 * Zones are the geometry a room occupies. A room may own several — a gallery
 * split by a wall, an alcove — and occupancy is reported for the room, not the
 * zone, so moving between them is not an exit.
 */
function checkZones(roomId, room, errors, warnings, seenZoneIds) {
  const path = `rooms.${roomId}.zones`;
  if (!isObject(room.zones) || !Object.keys(room.zones).length) {
    warnings.push(`${path} is empty — the room cannot be entered on the floor plan`);
    return;
  }
  for (const [zoneId, zone] of Object.entries(room.zones)) {
    if (!isObject(zone)) {
      errors.push(`${path}.${zoneId} must be an object`);
      continue;
    }
    if (seenZoneIds.has(zoneId)) {
      errors.push(`${path}.${zoneId} duplicates a zone id in rooms.${seenZoneIds.get(zoneId)}`);
    } else {
      seenZoneIds.set(zoneId, roomId);
    }
    if (!Array.isArray(zone.polygon) || zone.polygon.length < 3) {
      errors.push(`${path}.${zoneId}.polygon must have at least 3 points`);
    }
    checkZoneBle(`${path}.${zoneId}.ble`, zone.ble, roomId, errors, warnings);
  }
}

/**
 * `ble` on a zone was the first place beacons were declared (2026-09-25,
 * morning). The top-level `beacons` map replaced it the same day; the phone
 * ignores it, so say so rather than let it look like it does something.
 */
function checkZoneBle(at, ble, roomId, errors, warnings) {
  if (ble == null) return;
  warnings.push(`${at} is no longer used — beacons live in the top-level beacons map`);
}

function checkRssi(value, at, errors) {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value >= 0) {
    errors.push(`${at} must be a negative number (dBm, e.g. -62)`);
  }
}

/**
 * Beacons on the floor plan (plan: "Beacons instead of zones"), keyed by their
 * iBeacon major number. Each is inside one room — several in one room act as
 * a group — or marks one of a room's doors (a threshold). Placed in the zone
 * editor while the beacons go up.
 */
const BEACON_KEYS = ['at', 'room', 'door', 'rssi', 'txPower'];
function checkBeacons(def, errors, warnings) {
  const beacons = def.beacons;
  if (beacons == null) return;
  if (!isObject(beacons)) {
    errors.push('beacons must be an object keyed by beacon id');
    return;
  }
  const doors = new Set(Object.values(def.rooms ?? {}).flatMap((r) => Object.keys(r?.thresholds ?? {})));
  for (const [id, b] of Object.entries(beacons)) {
    const at = `beacons.${id}`;
    if (!/^\d+$/.test(id) || Number(id) > 65535) {
      errors.push(`${at}: a beacon is keyed by its major number, a whole number 0–65535`);
    }
    if (!isObject(b)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    for (const key of Object.keys(b)) {
      if (!BEACON_KEYS.includes(key)) warnings.push(`${at}.${key} is not a beacon setting (${BEACON_KEYS.join(', ')})`);
    }
    if (!Array.isArray(b.at) || b.at.length !== 2 || !b.at.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      errors.push(`${at}.at must be [x, y] on the floor plan`);
    }
    if (b.room != null && b.door != null) errors.push(`${at} is inside a room or at a door, not both`);
    else if (b.room != null && !def.rooms?.[b.room]) errors.push(`${at}.room names "${b.room}", which the show does not have`);
    else if (b.door != null && !doors.has(b.door)) errors.push(`${at}.door names "${b.door}", which no room's thresholds declare`);
    else if (b.room == null && b.door == null) warnings.push(`${at} belongs to no room or door yet`);
    checkRssi(b.rssi, `${at}.rssi`, errors);
    checkRssi(b.txPower, `${at}.txPower`, errors);
  }
}

/**
 * Thresholds (§4.2c): a room's doorways. A guest at one hears its clips, and
 * that is all it does — it never enters the room, so it cannot activate it or
 * spend one of the guest's rooms. Checked after every zone, because a
 * threshold's beacons must not also mean "inside this very room".
 */
const THRESHOLD_KEYS = ['cues'];
const THRESHOLD_CUE_SLOTS = ['guidance', 'room'];
function checkThresholds(roomId, room, errors, warnings, seenThresholdIds, doorBeacons) {
  if (room.thresholds == null) return;
  const path = `rooms.${roomId}.thresholds`;
  if (!isObject(room.thresholds)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [thresholdId, threshold] of Object.entries(room.thresholds)) {
    const at = `${path}.${thresholdId}`;
    if (!isObject(threshold)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (seenThresholdIds.has(thresholdId)) {
      errors.push(`${at} duplicates a threshold id in rooms.${seenThresholdIds.get(thresholdId)}`);
    } else {
      seenThresholdIds.set(thresholdId, roomId);
    }
    for (const key of Object.keys(threshold)) {
      if (key === 'beacons' || key === 'rssi') {
        warnings.push(`${at}.${key} is no longer used — a door's beacons are entries in the top-level beacons map with "door": "${thresholdId}"`);
      } else if (!THRESHOLD_KEYS.includes(key)) {
        warnings.push(`${at}.${key} is not a threshold setting (${THRESHOLD_KEYS.join(', ')})`);
      }
    }
    if (!doorBeacons.has(thresholdId)) {
      warnings.push(`${at}: no beacon in beacons is at this door yet — only the operator panel can put a guest there`);
    }

    const cues = threshold.cues;
    if (cues != null && !isObject(cues)) {
      errors.push(`${at}.cues must be an object`);
      continue;
    }
    let sounds = false;
    for (const [slot, cue] of Object.entries(cues ?? {})) {
      if (!THRESHOLD_CUE_SLOTS.includes(slot)) {
        errors.push(`${at}.cues.${slot}: a threshold plays on ${THRESHOLD_CUE_SLOTS.join(' or ')}`);
        continue;
      }
      if (!isObject(cue)) {
        errors.push(`${at}.cues.${slot} must be a cue object`);
        continue;
      }
      if (cue.audience != null) errors.push(`${at}.cues.${slot}.audience does not apply — a threshold cue has one listener`);
      checkCueMedia(cue, `${at}.cues.${slot}`, errors);
      if (cue.audio || cue.image) sounds = true;
    }
    if (!sounds) warnings.push(`${at} declares no cues — standing there does nothing`);
  }
}

/**
 * No point on the plan may belong to two rooms.
 *
 * A guest standing on an overlap enters whichever room iterates first — a show
 * that behaves differently after a JSON key reorders, with no symptom beyond
 * the wrong audio. Zones are hand-edited polygons now that they are traced
 * over the venue plan, and a hand that nudges one vertex can silently create
 * this. A warning, not an error: rehearsal should not be blocked by a corner
 * clipping a corner, but it must be said.
 *
 * Zones of the *same* room may overlap freely — the claim is the room's.
 */
function checkZoneOverlaps(rooms, warnings) {
  const zones = [];
  for (const [roomId, room] of Object.entries(rooms)) {
    if (!isObject(room) || !isObject(room.zones)) continue;
    for (const [zoneId, zone] of Object.entries(room.zones)) {
      if (Array.isArray(zone?.polygon) && zone.polygon.length >= 3) {
        zones.push({ roomId, zoneId, polygon: zone.polygon });
      }
    }
  }
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i];
      const b = zones[j];
      if (a.roomId === b.roomId) continue;
      if (polygonsOverlap(a.polygon, b.polygon)) {
        warnings.push(`rooms.${a.roomId}.zones.${a.zoneId} overlaps rooms.${b.roomId}.zones.${b.zoneId}`
          + ' — a guest there lands in whichever room loads first');
      }
    }
  }
}

function checkRoom(roomId, room, errors, warnings) {
  const path = `rooms.${roomId}`;
  if (!isObject(room)) {
    errors.push(`${path} must be an object`);
    return;
  }

  checkEnum(room.kind, ROOM_KINDS, `${path}.kind`, errors);
  const kind = room.kind ?? 'destination';

  // A shared room runs for the space, so there is no one guest whose history
  // could pick a variant, and no holder for company to be company to. Declaring
  // either would be a promise it cannot keep — and the revisit case is the
  // damaging one: it would let whoever walked in first decide what everybody
  // else sees.
  if (kind === 'shared') {
    if (room.revisit != null) {
      errors.push(`${path}.revisit cannot apply to a shared room — no single guest's history chooses its content`);
    }
    if (room.multiGuest != null) {
      errors.push(`${path}.multiGuest cannot apply to a shared room — it has no holder for company to join`);
    }
    if (room.ineligible?.policy === 'activateVariant') {
      errors.push(`${path}.ineligible "activateVariant" cannot apply to a shared room`);
    }
  }

  // A hallway is never activated, so requiring the presentation contract of it
  // would be ceremony — a machine with states that can never be entered.
  if (kind === 'hallway') {
    if (room.machine != null) {
      warnings.push(`${path} is a hallway; its machine will never be activated`);
    }
    if (room.multiGuest || room.exit || room.ineligible) {
      warnings.push(`${path} is a hallway; multiGuest/exit/ineligible do not apply`);
    }
    return;
  }

  checkRoomMachine(room.machine, `${path}.machine`, errors);

  const multiGuest = room.multiGuest;
  if (isObject(multiGuest)) {
    checkEnum(multiGuest.policy, MULTI_GUEST_POLICIES, `${path}.multiGuest.policy`, errors);
    checkEnum(multiGuest.atCapacity, AT_CAPACITY_POLICIES, `${path}.multiGuest.atCapacity`, errors);
    if (multiGuest.maxOccupants != null
      && (!Number.isInteger(multiGuest.maxOccupants) || multiGuest.maxOccupants < 1)) {
      errors.push(`${path}.multiGuest.maxOccupants must be a positive integer`);
    }
    if (multiGuest.maxOccupants != null && multiGuest.atCapacity == null) {
      warnings.push(`${path}.multiGuest sets maxOccupants without atCapacity — arrivals at capacity are undefined`);
    }
    // Capacity only bites where guests participate. Under `spectator` or
    // `personalVariant` company is already not participating, and under
    // `refuse` none arrives, so a cap there reads as a limit that never applies.
    if (multiGuest.maxOccupants != null && multiGuest.policy && multiGuest.policy !== 'collaborative') {
      warnings.push(
        `${path}.multiGuest.maxOccupants has no effect with policy "${multiGuest.policy}" `
        + '— capacity caps participation, and this policy admits no participants',
      );
    }
  }

  checkEnum(room.ineligible?.policy, INELIGIBLE_POLICIES, `${path}.ineligible.policy`, errors);
  if (['lockedMessage', 'tease'].includes(room.ineligible?.policy) && !room.ineligible.audio) {
    warnings.push(`${path}.ineligible.policy "${room.ineligible.policy}" has no audio asset`);
  }
  // A room that promises to react to an off-path guest must be able to hear it.
  if (room.ineligible?.policy === 'activateVariant'
    && isObject(room.machine?.states?.idle)
    && !handlesEvent(room.machine.states.idle, OFF_PATH_ACTIVATION_EVENT)) {
    errors.push(
      `${path}.machine.states.idle must handle "${OFF_PATH_ACTIVATION_EVENT}" — `
      + 'ineligible.policy is "activateVariant"',
    );
  }

  if (isObject(room.exit)) {
    checkEnum(room.exit.policy, EXIT_POLICIES, `${path}.exit.policy`, errors);
    checkEnum(room.exit.audioOnExit, AUDIO_ON_EXIT, `${path}.exit.audioOnExit`, errors);
    if (room.exit.policy === 'resetAfter' && room.exit.graceMs == null) {
      warnings.push(`${path}.exit uses resetAfter without graceMs — defaulting to 10000`);
    }
    if (room.exit.graceMs != null
      && (typeof room.exit.graceMs !== 'number' || room.exit.graceMs < 0)) {
      errors.push(`${path}.exit.graceMs must be a non-negative number`);
    }
    // A resume promise with nowhere to resume from. Nineteen rooms carried
    // exactly this after settling left their machines — a dead block nobody
    // noticed until the handover doc was audited against it.
    if (room.exit.resumeIfReturned === true && !isObject(room.machine?.states?.settling)) {
      warnings.push(
        `${path}.exit.resumeIfReturned is true but the machine has no settling state — `
        + 'nothing to resume from, so a returning guest gets an ordinary arrival',
      );
    }
    if (room.exit.resumeIfReturned === true
      && isObject(room.machine?.states?.settling)
      && !handlesEvent(room.machine.states.settling, 'RESUME')) {
      errors.push(
        `${path}.machine.states.settling must handle "RESUME" — exit.resumeIfReturned is true`,
      );
    }
  }

  if (isObject(room.whenAvailable)) {
    checkEnum(room.whenAvailable.policy, WHEN_AVAILABLE_POLICIES,
      `${path}.whenAvailable.policy`, errors);
  }

  if (isObject(room.audio)) {
    checkEnum(room.audio.timing, AUDIO_TIMINGS, `${path}.audio.timing`, errors);
    checkEnum(room.audio.joinPolicy, AUDIO_JOIN_POLICIES, `${path}.audio.joinPolicy`, errors);
  }

  if (isObject(room.seen) && room.seen.dwellMs != null
    && (typeof room.seen.dwellMs !== 'number' || room.seen.dwellMs <= 0)) {
    errors.push(`${path}.seen.dwellMs must be a positive number`);
  }

  checkRevisitVariants(roomId, room, errors);
  checkRoomCues(roomId, room, path, errors, warnings);
  checkRoomExperience(roomId, room, path, errors, warnings);
}

/**
 * Room cues (§8, thin audio layer).
 *
 * The failure this catches is silence: a room that declares audio for its
 * participants and a policy that puts people in some other standing, so a guest
 * stands in a running room hearing nothing and it looks like a routing bug.
 */
/**
 * Shape checks shared by room and guest cues.
 *
 * `offset`/`duration` carve a segment out of a longer recording, which is how
 * one file can carry a sequence the guest paces themselves through. Getting
 * them wrong is silence, and silence is the hardest fault to diagnose on the
 * night — so the arithmetic is checked here rather than discovered in a room.
 */
function checkCueMedia(cue, at, errors) {
  if (cue.audio != null && typeof cue.audio !== 'string') {
    errors.push(`${at}.audio must be an asset filename`);
  }
  if (cue.image != null && typeof cue.image !== 'string') {
    errors.push(`${at}.image must be an asset filename`);
  }
  for (const field of ['offset', 'duration']) {
    if (cue[field] == null) continue;
    if (typeof cue[field] !== 'number' || cue[field] < 0 || !Number.isFinite(cue[field])) {
      errors.push(`${at}.${field} must be a non-negative number of seconds`);
    }
    if (cue.audio == null) {
      errors.push(`${at}.${field} applies to audio, but no audio is declared`);
    }
  }
  if (cue.duration === 0) errors.push(`${at}.duration is zero — the cue would be silent`);
}

/**
 * A room that hands its interaction to a separate piece.
 *
 * The endpoint is the one piece of a show that is genuinely about *this
 * building* rather than about the work — a machine's address on a network. It
 * still lives in the show rather than in code, because the alternative is an
 * install detail hiding in a source file where nobody looks for it.
 */
function checkRoomExperience(roomId, room, path, errors, warnings) {
  const experience = room.experience;
  if (experience == null) return;
  const at = `${path}.experience`;
  if (!isObject(experience)) {
    errors.push(`${at} must be an object`);
    return;
  }
  requireString(experience, 'experienceId', at, errors);
  // The address is an install fact and belongs in an installation file, not
  // here — see installation.js. A show may still carry one for the simple case
  // of running without an installation at all, so it is optional rather than
  // forbidden; an installation that was given wins over it either way.
  for (const field of ['endpoint', 'phoneEndpoint']) {
    if (experience[field] != null && !/^wss?:\/\//.test(experience[field])) {
      errors.push(`${at}.${field} must be a ws:// or wss:// URL`);
    }
  }
  // A phone cannot reach `localhost` — on a phone, localhost is the phone. The
  // symptom is a socket that never opens, reported as "disconnected", which
  // reads as the room server being down rather than unreachable from there.
  const phoneFacing = experience.phoneEndpoint ?? experience.endpoint;
  if (typeof phoneFacing === 'string' && /^wss?:\/\/(localhost|127\.|\[?::1)/.test(phoneFacing)) {
    warnings.push(
      `${at}${experience.phoneEndpoint ? '.phoneEndpoint' : '.endpoint'} points at localhost, `
      + 'which no phone can reach — set phoneEndpoint to an address on the guest network',
    );
  }
  checkEnum(experience.inputMode, INPUT_MODES, `${at}.inputMode`, errors);
  for (const intent of experience.inputs ?? []) {
    checkEnum(intent, EXPERIENCE_INTENTS, `${at}.inputs`, errors);
  }
  if (experience.maxDrivers != null
    && (!Number.isInteger(experience.maxDrivers) || experience.maxDrivers < 1)) {
    errors.push(`${at}.maxDrivers must be a positive integer`);
  }
  // A hallway is passed through; a shared room runs for the space. Neither has
  // the holder an experience needs in order to know whose hand it is following.
  if (room.kind === 'hallway') {
    warnings.push(`${at} is on a hallway — guests pass through and will barely hold a driver slot`);
  }
  if (experience.inputMode === 'gestures') {
    warnings.push(
      `${at}.inputMode is "gestures", so nothing streams to the experience — `
      + 'it will be told who is driving and hear no input',
    );
  }
}

function checkRoomCues(roomId, room, path, errors, warnings) {
  if (room.cues == null) return;
  if (!isObject(room.cues)) {
    errors.push(`${path}.cues must be an object keyed by room state`);
    return;
  }
  const declaredStates = new Set(Object.keys(room.machine?.states ?? {}));
  const audiences = new Set();

  for (const [state, declared] of Object.entries(room.cues)) {
    const options = Array.isArray(declared) ? declared : [declared];
    const root = String(state).split('.')[0];
    if (declaredStates.size && !declaredStates.has(root)) {
      warnings.push(`${path}.cues["${state}"] names a state the machine never enters`);
    }
    options.forEach((cue, i) => {
      const at = `${path}.cues["${state}"]${Array.isArray(declared) ? `[${i}]` : ''}`;
      if (!isObject(cue)) {
        errors.push(`${at} must be an object`);
        return;
      }
      checkCueMedia(cue, at, errors);
      checkEnum(cue.audience, CUE_AUDIENCES, `${at}.audience`, errors);
      audiences.add(cue.audience ?? defaultCueAudience(room.kind));
    });
  }

  // A standing the room can put a guest in, with nothing declared for it, is
  // silence for that guest. Worth a warning at load rather than a puzzled
  // operator at runtime.
  const heard = (a) => audiences.has(a) || audiences.has('occupants');
  const policies = [room.multiGuest?.policy, room.multiGuest?.atCapacity];
  if (policies.includes('spectator') && !heard('spectators')) {
    warnings.push(`${path} makes spectators but declares no cue for them — they hear nothing`);
  }
  if (policies.includes('personalVariant') && !heard('personalVariant')) {
    warnings.push(`${path} makes personalVariant guests but declares no cue for them`);
  }
}

/**
 * Adjacency is truth about the building: which spaces physically connect.
 *
 * It does not gate movement — a guest can turn up anywhere, whether from a bad
 * beacon read or an operator dragging a dot, and the guest machine always has
 * somewhere to put them. What adjacency buys is the ability to *notice*: a move
 * between rooms that do not connect is either a test or a location fault, and
 * either way is worth flagging.
 */
function checkAdjacency(rooms, errors, warnings) {
  const ids = Object.keys(rooms);
  for (const [roomId, room] of Object.entries(rooms)) {
    const path = `rooms.${roomId}.adjacent`;
    if (room.adjacent == null) {
      warnings.push(`${path} is not declared — movement to and from it cannot be checked`);
      continue;
    }
    if (!Array.isArray(room.adjacent)) {
      errors.push(`${path} must be an array of room ids`);
      continue;
    }
    for (const other of room.adjacent) {
      if (!ids.includes(other)) {
        errors.push(`${path} references unknown room "${other}"`);
      } else if (other === roomId) {
        errors.push(`${path} lists itself`);
      } else if (!rooms[other]?.adjacent?.includes(roomId)) {
        // A door leads both ways. A one-sided declaration is a typo.
        errors.push(`${path} lists "${other}", but rooms.${other}.adjacent omits "${roomId}"`);
      }
    }
  }
}

/**
 * A revisit variant is delivered as its own activation event, so the room's
 * `idle` state must actually handle it. Declaring a variant the machine cannot
 * receive would silently fall back to the standard activation, which is exactly
 * the class of quiet failure this validator exists to catch.
 */
function checkRevisitVariants(roomId, room, errors) {
  const idle = room.machine?.states?.idle;
  if (!isObject(idle)) return;
  for (const [key, event] of Object.entries(REVISIT_EVENTS)) {
    if (!isObject(room.revisit?.[key])) continue;
    if (!handlesEvent(idle, event)) {
      errors.push(
        `rooms.${roomId}.machine.states.idle must handle "${event}" — revisit.${key} is declared`,
      );
    }
  }
}

/**
 * Optional show-level floor plan. Without it the operator view computes its
 * extent from the zone polygons; with it, zones are drawn over a traced
 * architectural plan, which is how zones get authored for a real venue.
 */
function checkFloorPlan(floorplan, errors, warnings) {
  if (floorplan == null) return;
  if (!isObject(floorplan)) {
    errors.push('floorplan must be an object');
    return;
  }
  for (const key of ['width', 'height']) {
    if (floorplan[key] != null && (typeof floorplan[key] !== 'number' || floorplan[key] <= 0)) {
      errors.push(`floorplan.${key} must be a positive number`);
    }
  }
  if (floorplan.image != null && typeof floorplan.image !== 'string') {
    errors.push('floorplan.image must be a string (asset filename)');
  }
  if (floorplan.image && (floorplan.width == null || floorplan.height == null)) {
    warnings.push('floorplan.image without width/height — zones may not line up with the plan');
  }
}

/**
 * Paths are a library of named routes, referenced by the guest machine when it
 * assigns one. They are data, never structure — which is what lets a route be
 * assigned at the moment a guest reaches the museum rather than at the door,
 * and lets one authored machine serve every guest.
 */
function checkPaths(paths, rooms, errors, warnings) {
  if (paths == null) return;
  if (!isObject(paths)) {
    errors.push('paths must be an object of named routes');
    return;
  }
  for (const [pathId, def] of Object.entries(paths)) {
    const path = `paths.${pathId}`;
    if (!isObject(def)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (!Array.isArray(def.rooms) || !def.rooms.length) {
      errors.push(`${path}.rooms must be a non-empty array`);
      continue;
    }
    for (const roomId of def.rooms) {
      if (!(roomId in rooms)) {
        errors.push(`${path} references unknown room "${roomId}"`);
      } else if ((rooms[roomId].kind ?? 'destination') === 'hallway') {
        // A route is a list of places to send someone, not the corridors between.
        errors.push(`${path} includes "${roomId}", which is a hallway`);
      }
    }
    checkEnum(def.guidance, GUIDANCE_POLICIES, `${path}.guidance`, errors);
  }
}

/**
 * The guest block.
 *
 * The author writes the *journey* — `guidance`, and `adherence` if they want to
 * change it. The `location` region is generated from room adjacency rather than
 * authored, because it is a map of the building and writing it twice would let
 * the two drift.
 */
function checkGuest(guest, rooms, errors, warnings) {
  if (!isObject(guest)) {
    errors.push('guest must be an object');
    return;
  }

  if (isObject(guest.eligibility)) {
    for (const [key, cfg] of Object.entries(guest.eligibility)) {
      const path = `guest.eligibility.${key}.strategy`;
      checkEnum(cfg?.strategy, ELIGIBILITY_STRATEGIES, path, errors);
      if (cfg?.strategy
        && ELIGIBILITY_STRATEGIES.includes(cfg.strategy)
        && !IMPLEMENTED_ELIGIBILITY_STRATEGIES.includes(cfg.strategy)) {
        errors.push(
          `${path} "${cfg.strategy}" is declared by the contract but not implemented yet `
          + `(available: ${IMPLEMENTED_ELIGIBILITY_STRATEGIES.join(', ')})`,
        );
      }
    }
    if (!guest.eligibility.golden) {
      warnings.push('guest.eligibility.golden is not defined — guests default to goldenPath');
    }
  }

  if (guest.audioLayers !== undefined) {
    if (!isObject(guest.audioLayers)) {
      errors.push('guest.audioLayers must be an object');
    } else {
      const { duckTo, duckMs, crossfadeMs } = guest.audioLayers;
      if (duckTo !== undefined && !(typeof duckTo === 'number' && duckTo >= 0 && duckTo <= 1)) {
        errors.push('guest.audioLayers.duckTo must be a number between 0 and 1 (1 turns ducking off)');
      }
      for (const [key, value] of Object.entries({ duckMs, crossfadeMs })) {
        if (value !== undefined && !(typeof value === 'number' && value >= 0)) {
          errors.push(`guest.audioLayers.${key} must be a non-negative number of milliseconds`);
        }
      }
      const known = ['duckTo', 'duckMs', 'crossfadeMs'];
      for (const key of Object.keys(guest.audioLayers)) {
        if (!known.includes(key)) {
          warnings.push(`guest.audioLayers.${key} is not a mixer setting (known: ${known.join(', ')})`);
        }
      }
    }
  }

  checkGuestMachine(guest.machine, rooms, errors, warnings);
  checkGuestTimers(guest.timers, guest.machine, errors, warnings);
  checkGuestCues(guest, errors, warnings);
  checkStepTiming(guest, errors, warnings);
}

/**
 * Guest cues — audio addressed to one person rather than to a space.
 *
 * Keys are region-qualified (`guidance.leadingToMuseum`) because the parallel
 * regions may reasonably name a state the same thing, and a bare state name
 * would silently pick whichever matched first.
 */
function checkGuestCues(guest, errors, warnings) {
  if (guest.cues == null) return;
  if (!isObject(guest.cues)) {
    errors.push('guest.cues must be an object keyed by "<region>.<state>"');
    return;
  }
  for (const [key, cue] of Object.entries(guest.cues)) {
    const [region, ...rest] = key.split('.');
    const state = rest.join('.');
    if (!AUTHORED_GUEST_REGIONS.includes(region) || !state) {
      errors.push(
        `guest.cues["${key}"] must be "<region>.<state>" `
        + `where region is one of ${AUTHORED_GUEST_REGIONS.join(', ')}`,
      );
      continue;
    }
    if (!isObject(cue)) {
      errors.push(`guest.cues["${key}"] must be an object`);
      continue;
    }
    checkCueMedia(cue, `guest.cues["${key}"]`, errors);
    if (cue.audience != null) {
      errors.push(`guest.cues["${key}"].audience does not apply — a guest cue has one listener`);
    }
    const declared = guest.machine?.[region]?.states ?? {};
    if (Object.keys(declared).length && !resolveStatePath(declared, state)) {
      warnings.push(`guest.cues["${key}"] names a state ${region} never enters`);
    }
  }
}

/**
 * Walk a dotted state path (`prologue.tapTest`) through nested `states` blocks.
 * Regions nest now that a sequence can live inside one, so a cue naming a step
 * has to be resolvable past the first segment.
 */
function resolveStatePath(states, path) {
  let node = states?.[String(path).split('.')[0]];
  for (const segment of String(path).split('.').slice(1)) {
    node = node?.states?.[segment];
  }
  return node ?? null;
}

/**
 * A self-advancing step and the audio it plays over must agree on how long they
 * last, and nothing makes them — the `after` is in the machine and the duration
 * is in the cue. This is precisely the drift this codebase keeps rediscovering:
 * two places holding one fact. Warned rather than errored, because a deliberate
 * hold past the end of the voice is a legitimate directorial choice.
 */
function checkStepTiming(guest, errors, warnings) {
  for (const [key, cue] of Object.entries(guest.cues ?? {})) {
    if (!isObject(cue) || cue.duration == null) continue;
    const [region, ...rest] = key.split('.');
    const node = resolveStatePath(guest.machine?.[region]?.states ?? {}, rest.join('.'));
    const after = Object.keys(node?.after ?? {})[0];
    if (after == null) continue;
    const drift = Number(after) - cue.duration * 1000;
    if (drift < 0) {
      warnings.push(
        `guest.cues["${key}"] runs ${cue.duration}s but ${key} advances after ${after}ms `
        + '— the audio will be cut off',
      );
    } else if (drift > 3000) {
      warnings.push(
        `${key} holds ${Math.round(drift)}ms after its audio ends — intended, or a stale duration?`,
      );
    }
  }
}

/**
 * `inputBindings` turns a gesture into a guest-machine event. It is the only
 * place the show says what a tap means, which is what keeps the client ignorant
 * of the narrative and the runtime ignorant of the gesture.
 */
function checkInputBindings(def, errors, warnings) {
  const bindings = def.inputBindings;
  if (bindings == null) return;
  if (!isObject(bindings)) {
    errors.push('inputBindings must be an object keyed by input kind');
    return;
  }
  const machine = def.guest?.machine ?? {};
  for (const [input, event] of Object.entries(bindings)) {
    checkEnum(input, INPUT_KINDS, `inputBindings["${input}"]`, errors);
    if (typeof event !== 'string' || !event) {
      errors.push(`inputBindings["${input}"] must be the name of a guest-machine event`);
      continue;
    }
    // An input bound to an event nothing listens for is a gesture that does
    // nothing — and looks exactly like a broken touch handler.
    if (!handlesEventAnywhere(machine, event)) {
      warnings.push(`inputBindings["${input}"] sends "${event}", which no guest state handles`);
    }
  }
}

function handlesEventAnywhere(machine, event) {
  const walk = (states) => Object.values(states ?? {}).some(
    (state) => isObject(state?.on) && event in state.on || walk(state?.states),
  );
  return Object.values(machine).some((region) => walk(region?.states));
}

function checkGuestMachine(machine, rooms, errors, warnings) {
  if (machine == null) {
    warnings.push('guest.machine is not declared — guests will have a location region only');
    return;
  }
  if (!isObject(machine)) {
    errors.push('guest.machine must be an object');
    return;
  }
  if (machine.location != null) {
    errors.push('guest.machine.location is generated from room adjacency — remove it');
  }
  for (const region of Object.keys(machine)) {
    if (!AUTHORED_GUEST_REGIONS.includes(region)) {
      errors.push(
        `guest.machine.${region} is not an authorable region `
        + `(${AUTHORED_GUEST_REGIONS.join(', ')})`,
      );
    }
  }
  for (const region of AUTHORED_GUEST_REGIONS) {
    const node = machine[region];
    if (node == null) continue;
    if (!isObject(node?.states) || !Object.keys(node.states).length) {
      errors.push(`guest.machine.${region}.states must be a non-empty object`);
      continue;
    }
    if (typeof node.initial !== 'string' || !isObject(node.states[node.initial])) {
      errors.push(`guest.machine.${region}.initial must name one of its own states`);
    }
    checkRegionRefs(region, node, rooms, errors, warnings);
  }
}

/** Room-entry transitions and path assignments must name things that exist. */
function checkRegionRefs(region, node, rooms, errors, warnings) {
  const roomIds = Object.keys(rooms);
  for (const [stateId, state] of Object.entries(node.states)) {
    const path = `guest.machine.${region}.states.${stateId}`;
    for (const event of Object.keys(state?.on ?? {})) {
      if (!event.startsWith('entered.')) continue;
      const roomId = event.slice('entered.'.length);
      if (roomId !== '*' && !roomIds.includes(roomId)) {
        errors.push(`${path}.on["${event}"] names unknown room "${roomId}"`);
      }
    }
    for (const action of [].concat(state?.entry ?? [])) {
      if (action?.type !== 'assignPath') continue;
      if (!Array.isArray(action.from) || !action.from.length) {
        errors.push(`${path} assignPath needs a non-empty "from" list of path ids`);
      }
      checkEnum(action.strategy, PATH_ASSIGNMENT_STRATEGIES, `${path} assignPath.strategy`, errors);
    }
  }
}

/**
 * Declared timers, for conditions XState's own `after` cannot express.
 *
 * `after` measures time since a state was last entered, so a guest who steps
 * out of the museum and back would restart it. "Thirty minutes in the museum"
 * has to survive leaving, so the runtime tracks it and delivers an event.
 */
function checkGuestTimers(timers, machine, errors, warnings) {
  if (timers == null) return;
  if (!isObject(timers)) {
    errors.push('guest.timers must be an object');
    return;
  }
  for (const [timerId, timer] of Object.entries(timers)) {
    const path = `guest.timers.${timerId}`;
    if (!isObject(timer)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (typeof timer.afterMs !== 'number' || timer.afterMs <= 0) {
      errors.push(`${path}.afterMs must be a positive number`);
    }
    if (typeof timer.event !== 'string' || !timer.event.trim()) {
      errors.push(`${path}.event must name the event to send`);
    }
    if (typeof timer.sinceEntering !== 'string') {
      errors.push(`${path}.sinceEntering must name a state, as "region.state"`);
      continue;
    }
    const [region, stateId] = timer.sinceEntering.split('.');
    if (!isObject(machine?.[region]?.states?.[stateId])) {
      errors.push(`${path}.sinceEntering names unknown state "${timer.sinceEntering}"`);
    }
  }
}

function checkAdherence(adherence, errors, warnings) {
  if (adherence == null) return;
  if (!isObject(adherence)) {
    errors.push('adherence must be an object');
    return;
  }
  const thresholds = adherence.thresholds;
  if (isObject(thresholds)) {
    const { drifting, cursed } = thresholds;
    if (typeof drifting === 'number' && typeof cursed === 'number' && drifting >= cursed) {
      errors.push('adherence.thresholds.drifting must be below cursed');
    }
  }
  for (const [name, sig] of Object.entries(adherence.signals ?? {})) {
    if (typeof sig?.weight !== 'number' || sig.weight <= 0) {
      errors.push(`adherence.signals.${name}.weight must be a positive number`);
    }
  }
  for (const [name, sig] of Object.entries(adherence.compliance ?? {})) {
    if (typeof sig?.weight !== 'number' || sig.weight >= 0) {
      errors.push(`adherence.compliance.${name}.weight must be a negative number`);
    }
  }
}

/**
 * Validate a contract v3 show definition.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateShowDefinition(raw) {
  if (!isObject(raw)) {
    return { errors: ['definition must be a JSON object'], warnings: [] };
  }

  // Validate the show as the runtime will see it, not as it was typed. A
  // sequence is a shorthand for states and cues that do not exist until it is
  // expanded, and checking the shorthand would report every one of them missing.
  const expansion = expandSequences(raw);
  const def = expansion.def;
  const errors = [...expansion.errors];
  const warnings = [...expansion.warnings];

  if (def.contractVersion !== CONTRACT_VERSION) {
    errors.push(
      `contractVersion must be ${CONTRACT_VERSION} (got ${def.contractVersion ?? 'missing'}); v1/v2 shows are not supported`,
    );
    return { errors, warnings };
  }

  requireString(def, 'showId', 'show', errors);
  requireString(def, 'name', 'show', errors);

  if (!isObject(def.rooms) || !Object.keys(def.rooms).length) {
    errors.push('rooms must be a non-empty object');
  }

  const roomIds = Object.keys(def.rooms ?? {});
  const seenZoneIds = new Map();
  for (const roomId of roomIds) {
    checkRoom(roomId, def.rooms[roomId], errors, warnings);
    if (isObject(def.rooms[roomId])) {
      checkZones(roomId, def.rooms[roomId], errors, warnings, seenZoneIds);
      // An earlier draft (spec v0.3 §5.2) hung BLE on the room. A room may own
      // several zones, and a beacon sits in one of them.
      if (def.rooms[roomId].ble != null) {
        errors.push(`rooms.${roomId}.ble — beacons live in the top-level beacons map, keyed by major`);
      }
    }
  }
  const seenThresholdIds = new Map();
  const doorBeacons = new Set(isObject(def.beacons) ? Object.values(def.beacons).map((b) => b?.door).filter(Boolean) : []);
  for (const roomId of roomIds) {
    if (isObject(def.rooms[roomId])) {
      checkThresholds(roomId, def.rooms[roomId], errors, warnings, seenThresholdIds, doorBeacons);
    }
  }

  checkZoneOverlaps(def.rooms ?? {}, warnings);
  checkBeacons(def, errors, warnings);
  // How long a beacon report that jumps between unconnected spaces is held.
  for (const key of ['jumpTwoStepsMs', 'jumpFartherMs']) {
    const v = def.location?.[key];
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      errors.push(`location.${key} must be a non-negative number of milliseconds`);
    }
  }

  if (def.zones != null) {
    errors.push('top-level "zones" was removed — declare zones inside each room (rooms.<id>.zones)');
  }
  if (def.user != null) {
    errors.push('"user" was renamed to "guest"');
  }

  checkFloorPlan(def.floorplan, errors, warnings);
  checkMuseum(def.museum, def.rooms, errors, warnings);

  checkAdjacency(def.rooms ?? {}, errors, warnings);
  checkGuest(def.guest, def.rooms ?? {}, errors, warnings);
  checkInputBindings(def, errors, warnings);
  checkPaths(def.paths, def.rooms ?? {}, errors, warnings);
  if (def.phases != null) {
    errors.push('"phases" was replaced by the guidance region of guest.machine');
  }
  checkAdherence(def.adherence, errors, warnings);

  return { errors, warnings };
}
