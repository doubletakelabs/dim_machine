import {
  CONTRACT_VERSION,
  REQUIRED_ROOM_STATES,
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
  PHASE_MODES,
  GUIDANCE_POLICIES,
  ADVANCE_SCOPES,
  REVISIT_EVENTS,
} from './contract.js';
import { IMPLEMENTED_ELIGIBILITY_STRATEGIES } from './eligibility.js';

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
  }
}

function checkRoom(roomId, room, errors, warnings) {
  const path = `rooms.${roomId}`;
  if (!isObject(room)) {
    errors.push(`${path} must be an object`);
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
  }

  checkEnum(room.ineligible?.policy, INELIGIBLE_POLICIES, `${path}.ineligible.policy`, errors);
  if (['lockedMessage', 'tease'].includes(room.ineligible?.policy) && !room.ineligible.audio) {
    warnings.push(`${path}.ineligible.policy "${room.ineligible.policy}" has no audio asset`);
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
    if (room.exit.graceMs != null && room.exit.policy === 'resetImmediate') {
      warnings.push(`${path}.exit.graceMs is ignored when policy is resetImmediate`);
    }
    // A room can only be resumed if its machine says how, and a room that
    // promises resumption but cannot deliver it would silently reset instead.
    if (room.exit.resumeIfReturned === true
      && isObject(room.machine?.states?.settling)
      && !handlesEvent(room.machine.states.settling, 'RESUME')) {
      errors.push(
        `${path}.machine.states.settling must handle "RESUME" — exit.resumeIfReturned is true`,
      );
    }
    if (room.exit.policy === 'hold' && room.exit.resumeIfReturned === true) {
      warnings.push(`${path}.exit.resumeIfReturned has no effect with policy "hold" — a held room never enters settling`);
    }
  }

  if (isObject(room.whenAvailable)) {
    checkEnum(room.whenAvailable.policy, WHEN_AVAILABLE_POLICIES,
      `${path}.whenAvailable.policy`, errors);
    // A room that replays for whoever is inside, whose content ends by itself,
    // and which resets with no grace, will cycle for as long as anyone stands
    // in it. That is a legitimate ambient room — but it should be on purpose.
    if (room.whenAvailable.policy === 'activate' && room.exit?.policy === 'resetImmediate') {
      warnings.push(`${path}.whenAvailable "activate" with exit "resetImmediate" will replay continuously while occupied`);
    }
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

function checkPaths(paths, roomIds, errors, warnings) {
  if (!isObject(paths)) {
    errors.push('paths must be an object');
    return;
  }
  const assignment = paths.assignment;
  if (!isObject(assignment)) {
    errors.push('paths.assignment must be an object');
  } else if (!PATH_ASSIGNMENT_STRATEGIES.includes(assignment.strategy)) {
    errors.push(`paths.assignment.strategy must be one of: ${PATH_ASSIGNMENT_STRATEGIES.join(', ')}`);
  }
  const definitions = paths.definitions;
  if (!isObject(definitions) || !Object.keys(definitions).length) {
    errors.push('paths.definitions must be a non-empty object');
    return;
  }
  for (const [pathId, def] of Object.entries(definitions)) {
    if (!Array.isArray(def.rooms) || !def.rooms.length) {
      errors.push(`paths.definitions.${pathId}.rooms must be a non-empty array`);
      continue;
    }
    for (const rid of def.rooms) {
      if (!roomIds.includes(rid)) {
        errors.push(`paths.definitions.${pathId} references unknown room "${rid}"`);
      }
    }
    checkEnum(def.guidance, GUIDANCE_POLICIES, `paths.definitions.${pathId}.guidance`, errors);
    if (def.guidance === 'goldenPath' && def.rooms.length < 2) {
      warnings.push(`paths.definitions.${pathId} uses goldenPath with fewer than two rooms — order is moot`);
    }
  }

  const covered = new Set(Object.values(definitions).flatMap((d) => d.rooms ?? []));
  for (const roomId of roomIds) {
    if (!covered.has(roomId)) {
      warnings.push(`rooms.${roomId} is on no path — only reachable while cursed or by operator`);
    }
  }
}

function checkPhases(phases, roomIds, errors, warnings) {
  if (!Array.isArray(phases) || !phases.length) {
    errors.push('phases must be a non-empty array');
    return;
  }
  for (const [i, phase] of phases.entries()) {
    const path = `phases[${i}]`;
    if (!isObject(phase)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    requireString(phase, 'id', path, errors);
    checkEnum(phase.mode, PHASE_MODES, `${path}.mode`, errors);
    if (phase.mode === 'directed' && !phase.target) {
      errors.push(`${path}.target is required for directed phases`);
    }
    if (phase.target && !roomIds.includes(phase.target)) {
      warnings.push(`${path}.target "${phase.target}" is not a room`);
    }
    // Whether a phase advances per guest or for the whole show is a per-show,
    // per-test decision, so it is declared rather than inferred.
    if (phase.advanceWhen != null) {
      if (!isObject(phase.advanceWhen)) {
        errors.push(`${path}.advanceWhen must be an object`);
      } else {
        checkEnum(phase.advanceWhen.scope, ADVANCE_SCOPES, `${path}.advanceWhen.scope`, errors);
        if (phase.advanceWhen.scope == null) {
          errors.push(`${path}.advanceWhen.scope is required (${ADVANCE_SCOPES.join(' | ')})`);
        }
        if (phase.advanceWhen.entered && !roomIds.includes(phase.advanceWhen.entered)) {
          warnings.push(`${path}.advanceWhen.entered "${phase.advanceWhen.entered}" is not a room`);
        }
      }
    } else if (i < phases.length - 1) {
      warnings.push(`${path} has no advanceWhen — only the operator can move guests on`);
    }
  }
  const ids = phases.map((p) => p?.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.push('phases[].id must be unique');
}

/**
 * The guest block.
 *
 * `machine` is deliberately optional. A statechart earns its place when there
 * are modes that reinterpret the same input — phases and adherence, which
 * arrive later. Where a guest *is* is a variable, not a state, and lives on the
 * Guest record instead.
 */
function checkGuest(guest, errors, warnings) {
  if (!isObject(guest)) {
    errors.push('guest must be an object');
    return;
  }
  if (guest.machine != null) {
    if (!isObject(guest.machine)) {
      errors.push('guest.machine must be an object');
    } else if (typeof guest.machine.initial !== 'string'
      || !isObject(guest.machine.states)
      || !Object.keys(guest.machine.states).length) {
      errors.push('guest.machine needs an initial state and a non-empty states map');
    }
  }
  if (isObject(guest.eligibility)) {
    for (const [key, cfg] of Object.entries(guest.eligibility)) {
      const path = `guest.eligibility.${key}.strategy`;
      checkEnum(cfg?.strategy, ELIGIBILITY_STRATEGIES, path, errors);
      // A strategy the contract names but this build cannot evaluate is a load
      // error, not a warning: an eligibility predicate quietly returning the
      // wrong answer locks guests out of every room, and reads as a location bug.
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
export function validateShowDefinition(def) {
  const errors = [];
  const warnings = [];

  if (!isObject(def)) {
    return { errors: ['definition must be a JSON object'], warnings: [] };
  }

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
    }
  }

  if (def.zones != null) {
    errors.push('top-level "zones" was removed — declare zones inside each room (rooms.<id>.zones)');
  }
  if (def.user != null) {
    errors.push('"user" was renamed to "guest"');
  }

  checkFloorPlan(def.floorplan, errors, warnings);

  checkGuest(def.guest, errors, warnings);
  checkPaths(def.paths, roomIds, errors, warnings);
  checkPhases(def.phases, roomIds, errors, warnings);
  checkAdherence(def.adherence, errors, warnings);

  return { errors, warnings };
}
