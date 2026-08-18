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
  GUIDANCE_POLICIES,
  REVISIT_EVENTS,
  ROOM_KINDS,
  OFF_PATH_ACTIVATION_EVENT,
  AUTHORED_GUEST_REGIONS,
  enteredEvent,
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

  checkEnum(room.kind, ROOM_KINDS, `${path}.kind`, errors);
  const kind = room.kind ?? 'destination';

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

  checkGuestMachine(guest.machine, rooms, errors, warnings);
  checkGuestTimers(guest.timers, guest.machine, errors, warnings);
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

  checkAdjacency(def.rooms ?? {}, errors, warnings);
  checkGuest(def.guest, def.rooms ?? {}, errors, warnings);
  checkPaths(def.paths, def.rooms ?? {}, errors, warnings);
  if (def.phases != null) {
    errors.push('"phases" was replaced by the guidance region of guest.machine');
  }
  checkAdherence(def.adherence, errors, warnings);

  return { errors, warnings };
}
