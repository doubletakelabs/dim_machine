// ShowRuntime — contract v1 (flat user machine) and v2 (room actors + orchestrator).
// v2: one XState actor per room (source of truth for scene state); users sync on
// zone.enter. See CONTRACT.md and specs/Interactive Theater Platform Spec.md.
import { setup, createActor } from 'xstate';

const SUPPORTED_CONTRACT = [1, 2];

const OPS = {
  '==': (a, b) => a == b, '!=': (a, b) => a != b,
  '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '<': (a, b) => a < b, '<=': (a, b) => a <= b,
};
const OUTPUT_COMMANDS = ['playAudio', 'stopAudio', 'playVideo', 'showPage', 'haptic', 'setVar'];
const ACTION_TYPES = ['output', 'raise', 'sendTo', 'broadcast', 'log', 'assign'];
const CUE_RETENTION_MS = 30_000;

export function stateToString(v) {
  if (typeof v === 'string') return v;
  return Object.entries(v)
    .map(([k, sub]) => `${k}.${stateToString(sub)}`)
    .join(' ∥ ');
}

/** Dot-path state names for operator override (e.g. "lit", "foo.bar"). */
export function collectStateNames(machine, prefix = '') {
  const out = [];
  for (const [name, state] of Object.entries(machine?.states ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (state.states) out.push(...collectStateNames(state, path));
    else out.push(path);
  }
  return out;
}

export function getStateNodeByPath(machine, statePath) {
  let node = machine;
  for (const part of statePath.split('.')) {
    node = node?.states?.[part];
    if (!node) return null;
  }
  return node;
}

export function pathToStateValue(statePath) {
  const parts = statePath.split('.');
  let v = parts.pop();
  for (let i = parts.length - 1; i >= 0; i--) v = { [parts[i]]: v };
  return v;
}

function transformMachine(node) {
  const wrapActions = (a) =>
    (Array.isArray(a) ? a : [a]).map((action) => ({ type: '__exec', params: action }));
  const wrapTransition = (t) => {
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.map(wrapTransition);
    const out = { ...t };
    if (out.actions) out.actions = wrapActions(out.actions);
    if (out.guard) out.guard = { type: '__cond', params: out.guard };
    return out;
  };
  const out = { ...node };
  if (out.entry) out.entry = wrapActions(out.entry);
  if (out.exit) out.exit = wrapActions(out.exit);
  for (const key of ['on', 'after']) {
    if (!out[key]) continue;
    out[key] = Object.fromEntries(
      Object.entries(out[key]).map(([ev, t]) => [ev, wrapTransition(t)])
    );
  }
  if (out.always) out.always = wrapTransition(out.always);
  if (out.states) {
    out.states = Object.fromEntries(
      Object.entries(out.states).map(([name, s]) => [name, transformMachine(s)])
    );
  }
  return out;
}

function resolveBinding(bindings, type) {
  const raw = bindings?.[type];
  if (raw == null) return { event: type, scope: null };
  if (typeof raw === 'string') return { event: raw, scope: null };
  return { event: raw.event ?? type, scope: raw.scope ?? null };
}

function resolveValue(current, value) {
  if (typeof value === 'string' && /^[+-]\d+(\.\d+)?$/.test(value))
    return (Number(current) || 0) + Number(value);
  return value;
}

function checkAction(a, path, def, warnings) {
  if (!a || typeof a !== 'object') return warnings.push(`${path}: action is not an object`);
  if (!ACTION_TYPES.includes(a.type)) warnings.push(`${path}: unknown action type "${a.type}"`);
  if (a.type === 'output' && !OUTPUT_COMMANDS.includes(a.command))
    warnings.push(`${path}: unknown output command "${a.command}"`);
  if (a.type === 'assign' && !['context', 'global'].includes(a.scope))
    warnings.push(`${path}: assign scope must be context|global`);
  if (a.type === 'assign' && a.scope === 'global' && def.globals && !(a.key in def.globals))
    warnings.push(`${path}: global "${a.key}" not declared in globals`);
}

function checkGuard(g, path, warnings) {
  if (g.all) return g.all.forEach((x, i) => checkGuard(x, `${path}.all[${i}]`, warnings));
  if (g.any) return g.any.forEach((x, i) => checkGuard(x, `${path}.any[${i}]`, warnings));
  if (g.not) return checkGuard(g.not, `${path}.not`, warnings);
  if (typeof g.var !== 'string' || !/^(global|context)\./.test(g.var))
    warnings.push(`${path}: guard var must be "global.<key>" or "context.<key>"`);
  if (g.op && !OPS[g.op]) warnings.push(`${path}: unknown op "${g.op}"`);
}

function walkMachine(node, path, def, warnings) {
  if (!node || typeof node !== 'object') return;
  for (const kind of ['entry', 'exit']) {
    if (node[kind]) (Array.isArray(node[kind]) ? node[kind] : [node[kind]])
      .forEach((a, i) => checkAction(a, `${path}.${kind}[${i}]`, def, warnings));
  }
  for (const key of ['on', 'after']) {
    for (const [ev, t] of Object.entries(node[key] ?? {})) {
      for (const tr of Array.isArray(t) ? t : [t]) {
        if (typeof tr === 'string') continue;
        if (tr.actions) (Array.isArray(tr.actions) ? tr.actions : [tr.actions])
          .forEach((a, i) => checkAction(a, `${path}.${key}.${ev}.actions[${i}]`, def, warnings));
        if (tr.guard) checkGuard(tr.guard, `${path}.${key}.${ev}.guard`, warnings);
      }
    }
  }
  for (const [name, s] of Object.entries(node.states ?? {})) walkMachine(s, `${path}.${name}`, def, warnings);
}

export function validateDefinition(def) {
  const errors = [];
  const warnings = [];
  if (!SUPPORTED_CONTRACT.includes(def.contractVersion))
    errors.push(`contractVersion ${def.contractVersion} not supported (runtime supports ${SUPPORTED_CONTRACT.join(', ')})`);

  const roomMode = def.contractVersion >= 2 && def.rooms && typeof def.rooms === 'object';
  if (roomMode) {
    const roomIds = Object.keys(def.rooms);
    if (!roomIds.length) errors.push('rooms: at least one room required');
    for (const [id, room] of Object.entries(def.rooms)) {
      if (!room.machine?.states) errors.push(`rooms.${id}: missing machine.states`);
      else walkMachine(room.machine, `rooms.${id}.machine`, def, warnings);
    }
    if (def.defaultRoom && !def.rooms[def.defaultRoom])
      errors.push(`defaultRoom "${def.defaultRoom}" not found in rooms`);
  } else if (!def.machine || typeof def.machine !== 'object' || !def.machine.states) {
    errors.push('missing machine.states (contract v1) or rooms (contract v2)');
  } else {
    walkMachine(def.machine, 'machine', def, warnings);
  }
  if (def.defaultRole && def.roles?.length && !def.roles.includes(def.defaultRole))
    warnings.push(`defaultRole "${def.defaultRole}" not listed in roles`);
  return { errors, warnings, roomMode };
}

const INPUT_EVENT = /^(tap|button:|choice:|swipe\.|drag\.|shake|pageDismiss|video\.ended|global\.changed)/;

export function getStateNode(machine, stateValue) {
  if (!machine?.states || stateValue == null) return null;
  if (typeof stateValue === 'string') return machine.states[stateValue] ?? null;
  if (typeof stateValue === 'object') {
    for (const [key, val] of Object.entries(stateValue)) {
      const region = machine.states[key];
      if (!region) continue;
      if (typeof val === 'string') return region.states?.[val] ?? region;
      return getStateNode(region, val);
    }
  }
  return null;
}

/** Operator-pushable events valid from the machine's current state (plus root). */
export function collectEventsAtState(machine, stateValue, boundInputs = []) {
  const acc = new Set();
  const addFrom = (node) => {
    if (!node) return;
    for (const ev of Object.keys(node.on ?? {})) {
      if (!INPUT_EVENT.test(ev) && !boundInputs.includes(ev)) acc.add(ev);
    }
  };
  addFrom(machine);
  addFrom(getStateNode(machine, stateValue));
  return [...acc].sort();
}

export function collectOperatorEvents(machineNode, boundInputs = [], acc = new Set()) {
  for (const ev of Object.keys(machineNode.on ?? {})) {
    if (!INPUT_EVENT.test(ev) && !boundInputs.includes(ev))
      acc.add(ev);
  }
  for (const s of Object.values(machineNode.states ?? {})) collectOperatorEvents(s, boundInputs, acc);
  return [...acc];
}

export class ShowRuntime {
  constructor(io) {
    this.io = io;
    this.def = null;
    this.roomMode = false;
    this.running = false;
    this.globals = {};
    this.users = new Map(); // token → session
    this.rooms = new Map(); // roomId → room session
  }

  boundInputEvents() {
    return Object.values(this.def?.inputBindings ?? {})
      .flatMap((v) => (typeof v === 'string' ? [v] : [v?.event].filter(Boolean)));
  }

  eventsForMachine(machine, stateValue) {
    if (!machine) return [];
    return collectEventsAtState(machine, stateValue, this.boundInputEvents());
  }

  eventsForRoom(roomId) {
    const room = this.rooms.get(roomId);
    const machine = this.def?.rooms?.[roomId]?.machine;
    if (!room?.started || !machine) return [];
    return this.eventsForMachine(machine, room.stateValue);
  }

  eventsForUser(token) {
    if (!this.def) return [];
    const u = this.users.get(token);
    if (!u) return [];
    if (this.roomMode) {
      if (!u.zoneId) return [];
      return this.eventsForRoom(u.zoneId);
    }
    if (!u.actor) return [];
    return this.eventsForMachine(this.def.machine, u.actor.getSnapshot().value);
  }

  isRoomMode() { return this.roomMode; }

  load(def) {
    const result = validateDefinition(def);
    if (result.errors.length) return result;
    this.stop();
    this.def = def;
    this.roomMode = result.roomMode;
    this.io.log(`show loaded: ${def.name ?? def.showId} (contract v${def.contractVersion}${this.roomMode ? ', room mode' : ''})`);
    return result;
  }

  start(tokens) {
    if (!this.def) return false;
    this.stop();
    this.running = true;
    this.globals = Object.fromEntries(
      Object.entries(this.def.globals ?? {}).map(([k, g]) => [k, g.initial])
    );
    this.io.log(`show started: ${this.def.name ?? this.def.showId} (${tokens.length} phones)`);
    for (const token of tokens) this.attachUser(token);
    for (const [key, value] of Object.entries(this.globals)) this.pushGlobalVar(key, value);
    return true;
  }

  stop() {
    if (!this.running && this.users.size === 0 && this.rooms.size === 0) return;
    for (const room of this.rooms.values()) {
      try { room.actor?.stop(); } catch {}
    }
    this.rooms.clear();
    for (const [token] of this.users) {
      this.io.sendCue(token, { kind: 'stopAudio', assetId: '*', fadeMs: 500, startAt: Date.now() });
      this.io.sendCue(token, this.mkCue({ kind: 'page', page: 'waiting', props: { title: 'Show ended' } }));
      this.io.onUserState(token, null);
    }
    this.users.clear();
    if (this.running) this.io.log('show stopped');
    this.running = false;
  }

  attachUser(token, role = null) {
    if (!this.running) return;
    let u = this.users.get(token);
    if (u?._runtimeAttached) return;

    u = u ?? {
      actor: null, vars: {}, role: null,
      zoneId: null, page: null, displayVars: {}, activeCues: [], stateString: null,
    };
    if (!u.role) u.role = role ?? this.def.defaultRole ?? null;
    u._runtimeAttached = true;
    this.users.set(token, u);

    if (this.roomMode) {
      for (const [key, value] of Object.entries(this.globals))
        this.io.sendCue(token, this.mkCue({ kind: 'setVar', key: `global.${key}`, value }));
      const defaultRoom = this.def.defaultRoom;
      if (defaultRoom && this.def.rooms[defaultRoom]) {
        this.enterZone(token, defaultRoom);
      } else if (!u.zoneId) {
        this.io.sendCue(token, this.mkCue({
          kind: 'page', page: 'waiting',
          props: { title: 'Joined', subtitle: 'Waiting to enter a room…' },
        }));
        this.updateUserStateDisplay(token);
      }
      return;
    }

    if (u.actor) return;
    const rt = this;
    const machine = setup({
      actions: { __exec: ({ self }, params) => rt.execUserAction(token, params, self) },
      guards: { __cond: (_, params) => rt.evalGuard(token, params, u.vars) },
    }).createMachine(transformMachine(this.def.machine));
    u.actor = createActor(machine);
    u.actor.subscribe((snap) => {
      u.stateString = stateToString(snap.value);
      u.stateValue = snap.value;
      this.io.onUserState(token, u.stateString);
    });
    u.actor.start();
    for (const [key, value] of Object.entries(this.globals))
      this.io.sendCue(token, this.mkCue({ kind: 'setVar', key: `global.${key}`, value }));
  }

  setRole(token, role) {
    const u = this.users.get(token);
    if (u) u.role = role || null;
  }

  removeUser(token) {
    const u = this.users.get(token);
    if (!u) return;
    if (u.zoneId) this.leaveZone(token, { quiet: true });
    try { u.actor?.stop(); } catch {}
    this.users.delete(token);
  }

  // ---- zone / room (contract v2) -------------------------------------------

  enterZone(token, roomId, { quietLog = false } = {}) {
    if (!this.running || !this.roomMode) return;
    const def = this.def.rooms[roomId];
    if (!def) return this.io.log(`unknown room: ${roomId}`);

    let u = this.users.get(token);
    if (!u) {
      u = { actor: null, vars: {}, role: null, zoneId: null, page: null, displayVars: {}, activeCues: [], stateString: null };
      this.users.set(token, u);
    }

    if (u.zoneId && u.zoneId !== roomId) this.leaveZone(token, { quiet: true });

    const prevZone = u.zoneId;
    const room = this.ensureRoom(roomId);
    room.members.add(token);
    u.zoneId = roomId;

    if (!room.started) {
      if (def.startOn === 'operatorOnly') {
        this.io.log(`room ${roomId} waiting for operator start`);
        this.syncUserToRoom(token, roomId);
        this.updateUserStateDisplay(token);
        this.io.onUserZoneChange?.(token, roomId, prevZone);
        return;
      }
      this.startRoomActor(roomId);
    } else {
      this.syncUserToRoom(token, roomId);
    }
    this.updateUserStateDisplay(token);
    if (!quietLog) this.io.log(`${token.slice(0, 8)} → room ${roomId} (${room.stateString ?? 'starting'})`);
    this.io.onRoomsChanged?.();
    this.io.onUserZoneChange?.(token, roomId, prevZone);
  }

  /** Move every show user (optionally only those in fromRoomId) into roomId. */
  moveAllToRoom(roomId, tokens, { fromRoomId = null } = {}) {
    if (!this.running || !this.roomMode) return 0;
    if (!this.def.rooms[roomId]) {
      this.io.log(`unknown room: ${roomId}`);
      return 0;
    }
    const toMove = [];
    for (const token of tokens) {
      if (!this.users.has(token)) this.attachUser(token);
      const u = this.users.get(token);
      if (!u) continue;
      if (fromRoomId && u.zoneId !== fromRoomId) continue;
      toMove.push(token);
    }
    for (const token of toMove) this.enterZone(token, roomId, { quietLog: true });
    const fromLabel = fromRoomId ? ` from ${fromRoomId}` : '';
    this.io.log(`moved ${toMove.length} user(s)${fromLabel} → ${roomId}`);
    this.io.onRoomsChanged?.();
    return toMove.length;
  }

  leaveZone(token, { quiet = false } = {}) {
    const u = this.users.get(token);
    if (!u?.zoneId) return;
    const room = this.rooms.get(u.zoneId);
    room?.members.delete(token);
    const prev = u.zoneId;
    u.zoneId = null;
    u.page = null;
    u.activeCues = [];
    if (!quiet) {
      this.io.sendCue(token, this.mkCue({
        kind: 'page', page: 'waiting',
        props: { title: 'Between rooms', subtitle: 'Waiting for assignment…' },
      }));
      this.updateUserStateDisplay(token);
      this.io.log(`${token.slice(0, 8)} left room ${prev}`);
      this.io.onRoomsChanged?.();
    }
    this.io.onUserZoneChange?.(token, null, prev);
  }

  startRoom(roomId) {
    if (!this.running || !this.roomMode) return;
    const room = this.ensureRoom(roomId);
    if (room.started) return;
    this.startRoomActor(roomId);
    for (const token of room.members) this.syncUserToRoom(token, roomId);
    this.io.log(`room ${roomId} started by operator`);
    this.io.onRoomsChanged?.();
  }

  ensureRoom(roomId) {
    if (this.rooms.has(roomId)) return this.rooms.get(roomId);
    const def = this.def.rooms[roomId];
    const room = {
      id: roomId,
      name: def.name ?? roomId,
      actor: null,
      started: false,
      stateString: null,
      stateEnteredAt: null,
      page: null,
      activeCues: [],
      displayVars: {},
      vars: {},
      members: new Set(),
    };
    this.rooms.set(roomId, room);
    return room;
  }

  startRoomActor(roomId) {
    const room = this.ensureRoom(roomId);
    if (room.actor) return room;
    const machine = this.createRoomMachine(roomId);
    this.attachRoomActor(room, roomId, createActor(machine));
    room.actor.start();
    room.started = true;
    return room;
  }

  createRoomMachine(roomId) {
    const rt = this;
    const room = this.rooms.get(roomId) ?? { vars: {} };
    return setup({
      actions: { __exec: ({ self }, params) => rt.execRoomAction(roomId, params, self) },
      guards: { __cond: (_, params) => rt.evalGuard(null, params, room.vars, roomId) },
    }).createMachine(transformMachine(this.def.rooms[roomId].machine));
  }

  attachRoomActor(room, roomId, actor) {
    room.actor = actor;
    room.actor.subscribe((snap) => {
      room.stateString = stateToString(snap.value);
      room.stateValue = snap.value;
      room.stateEnteredAt = Date.now();
      for (const t of room.members) this.updateUserStateDisplay(t);
      this.io.onRoomsChanged?.();
    });
  }

  /** Stop all audio for everyone in a room (e.g. before operator state override). */
  stopRoomOutputs(roomId, { fadeMs = 0 } = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.activeCues = room.activeCues.filter((c) => c.kind !== 'audio');
    if (!room.members.size) return;
    const cue = this.mkCue({ kind: 'stopAudio', assetId: '*', fadeMs, startAt: Date.now() });
    for (const token of room.members) {
      const u = this.users.get(token);
      if (u) u.activeCues = u.activeCues.filter((c) => c.kind !== 'audio');
      this.io.sendCue(token, cue);
    }
  }

  /** Operator override — jump room to a state and replay entry outputs to all members. */
  forceRoomState(roomId, statePath) {
    if (!this.running || !this.roomMode) return false;
    const machineDef = this.def.rooms[roomId]?.machine;
    if (!machineDef) return this.io.log(`unknown room: ${roomId}`), false;

    const stateNode = getStateNodeByPath(machineDef, statePath);
    if (!stateNode) return this.io.log(`unknown state "${statePath}" in room ${roomId}`), false;

    const room = this.ensureRoom(roomId);
    const machine = this.createRoomMachine(roomId);
    let snapshot;
    try {
      snapshot = machine.resolveState({ value: pathToStateValue(statePath) });
    } catch (err) {
      return this.io.log(`invalid state "${statePath}": ${err.message}`), false;
    }

    if (room.actor) { try { room.actor.stop(); } catch {} }
    this.stopRoomOutputs(roomId);
    this.attachRoomActor(room, roomId, createActor(machine, { snapshot }));
    room.actor.start();
    room.started = true;

    // resolveState start skips entry actions — replay from show definition.
    room.activeCues = [];
    room.page = null;
    for (const action of [].concat(stateNode.entry ?? []))
      this.execRoomAction(roomId, action, room.actor);

    for (const token of room.members) this.syncUserToRoom(token, roomId, { skipActiveCues: true });
    this.io.log(`room ${roomId} forced → ${statePath}`);
    this.io.onRoomsChanged?.();
    return true;
  }

  syncUserToRoom(token, roomId, { skipActiveCues = false } = {}) {
    const room = this.rooms.get(roomId);
    const u = this.users.get(token);
    if (!room || !u) return;

    u.displayVars = {
      ...Object.fromEntries(Object.entries(this.globals).map(([k, v]) => [`global.${k}`, v])),
      ...room.displayVars,
    };
    for (const [key, value] of Object.entries(u.displayVars))
      this.io.sendCue(token, this.mkCue({ kind: 'setVar', key, value }));

    if (room.page) {
      u.page = { ...room.page };
      this.io.sendCue(token, this.mkCue({ kind: 'page', ...u.page, startAt: Date.now() }));
    }

    u.activeCues = [];
    if (!skipActiveCues) {
      const now = Date.now();
      for (const cue of room.activeCues) {
        if (!(cue.loop || cue.kind === 'video' || now - cue.startAt < CUE_RETENTION_MS)) continue;
        u.activeCues.push({ ...cue });
        this.io.sendCue(token, cue);
      }
    }
    u.synced = true;
  }

  updateUserStateDisplay(token) {
    const u = this.users.get(token);
    if (!u) return;
    let state;
    if (this.roomMode) {
      if (!u.zoneId) state = 'unassigned';
      else {
        const room = this.rooms.get(u.zoneId);
        state = `${u.zoneId}:${room?.stateString ?? '…'}`;
      }
    } else {
      state = u.stateString;
    }
    u.stateString = state;
    this.io.onUserState(token, state);
  }

  sendRoomEvent(roomId, type, payload) {
    const room = this.rooms.get(roomId);
    if (!room?.started || !room.actor) {
      return this.io.log(`room ${roomId} not started — event ${type} ignored`);
    }
    room.actor.send({ type, payload: payload ?? {} });
  }

  getRoomsRoster() {
    const defs = Object.entries(this.def?.rooms ?? {});
    return defs.map(([id, def]) => {
      const live = this.rooms.get(id);
      return {
        id,
        name: def.name ?? id,
        state: live?.stateString ?? (live?.started ? '…' : 'idle'),
        members: live?.members.size ?? 0,
        started: live?.started ?? false,
        startOn: def.startOn ?? 'firstEnter',
        availableEvents: live?.started ? this.eventsForRoom(id) : [],
        stateNames: collectStateNames(def.machine),
      };
    });
  }

  // ---- events in -----------------------------------------------------------

  handleInput(token, type, payload) {
    const { event, scope: bindingScope } = resolveBinding(this.def.inputBindings, type);
    const scope = bindingScope ?? (this.roomMode ? 'room' : 'user');

    if (scope === 'personal' && this.roomMode) {
      const u = this.users.get(token);
      if (!u) return;
      if (u.actor) {
        u.actor.send({ type: event, payload: payload ?? {} });
        this.io.log(`input ${type} (personal) from ${token.slice(0, 8)}`);
        return;
      }
      // No personal machine yet — log only; does not advance the room for others.
      this.io.log(`input ${type} (personal, local) from ${token.slice(0, 8)}`);
      return;
    }

    if (scope === 'room' && this.roomMode) {
      const u = this.users.get(token);
      if (!u?.zoneId) return this.io.log(`input ${type} ignored — not in a room`);
      this.io.log(`input ${type} → room ${u.zoneId} (${event})`);
      this.sendRoomEvent(u.zoneId, event, payload);
      return;
    }

    const u = this.users.get(token);
    if (!u?.actor) {
      if (this.roomMode && u?.zoneId) {
        this.io.log(`input ${type} → room ${u.zoneId} (personal fallback)`);
        this.sendRoomEvent(u.zoneId, event, payload);
      }
      return;
    }
    u.actor.send({ type: event, payload: payload ?? {} });
    this.io.log(`input ${type}${event !== type ? ` → ${event}` : ''} from ${token.slice(0, 8)}`);
  }

  sendEvent(target, type, payload) {
    if (this.roomMode && target.startsWith('room:')) {
      this.io.log(`operator → room ${target.slice(5)}: ${type}`);
      return this.sendRoomEvent(target.slice(5), type, payload);
    }
    if (this.roomMode && target === 'all') {
      this.io.log(`operator → all rooms: ${type}`);
      for (const id of Object.keys(this.def.rooms)) {
        const room = this.rooms.get(id);
        if (room?.started) this.sendRoomEvent(id, type, payload);
      }
      return;
    }
    const send = (u) => u.actor?.send({ type, payload: payload ?? {} });
    if (target === 'all') for (const u of this.users.values()) send(u);
    else { const u = this.users.get(target); if (u) send(u); }
  }

  // ---- action interpreters -------------------------------------------------

  execRoomAction(roomId, a, self) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    try {
      switch (a?.type) {
        case 'output':
          return this.applyOutput(a, {
            store: room,
            fanTokens: [...room.members],
          });
        case 'raise':
          return self.send({ type: a.event, payload: a.payload ?? {} });
        case 'sendTo':
          if (a.target === 'orchestrator')
            queueMicrotask(() => this.orchestratorEvent(a.event, a.payload));
          else this.io.log(`sendTo target "${a.target}" not supported`);
          return;
        case 'broadcast':
          queueMicrotask(() => {
            for (const [t, u] of this.users) {
              if (a.role && u.role !== a.role) continue;
              if (a.scope === 'room' && u.zoneId !== roomId) continue;
              if (u.zoneId === roomId) this.sendRoomEvent(roomId, a.event, a.payload);
              else if (u.actor) u.actor.send({ type: a.event, payload: a.payload ?? {} });
            }
          });
          return;
        case 'log':
          return this.io.log(`[${roomId}] ${a.message}`);
        case 'assign': {
          if (a.scope === 'global') return this.setGlobal(a.key, a.value);
          room.vars[a.key] = resolveValue(room.vars[a.key], a.value);
          return;
        }
        default:
          this.io.log(`unknown action type "${a?.type}" — skipped`);
      }
    } catch (err) {
      this.io.log(`room action error (${a?.type}): ${err.message}`);
    }
  }

  execUserAction(token, a, self) {
    const u = this.users.get(token);
    if (!u) return;
    try {
      switch (a?.type) {
        case 'output':
          return this.applyOutput(a, { store: u, fanTokens: [token] });
        case 'raise':
          return self.send({ type: a.event, payload: a.payload ?? {} });
        case 'sendTo':
          if (a.target === 'orchestrator')
            queueMicrotask(() => this.orchestratorEvent(a.event, a.payload));
          else this.io.log(`sendTo target "${a.target}" not supported`);
          return;
        case 'broadcast':
          queueMicrotask(() => {
            for (const [t, u2] of this.users) {
              if (a.role && u2.role !== a.role) continue;
              if (u2.actor) u2.actor.send({ type: a.event, payload: a.payload ?? {} });
            }
          });
          return;
        case 'log':
          return this.io.log(`[author] ${a.message} (${token.slice(0, 8)})`);
        case 'assign': {
          if (a.scope === 'global') return this.setGlobal(a.key, a.value);
          u.vars[a.key] = resolveValue(u.vars[a.key], a.value);
          return;
        }
        default:
          this.io.log(`unknown action type "${a?.type}" — skipped`);
      }
    } catch (err) {
      this.io.log(`action error (${a?.type}): ${err.message}`);
    }
  }

  orchestratorEvent(type, payload) {
    if (this.roomMode) {
      for (const id of Object.keys(this.def.rooms)) {
        const room = this.rooms.get(id);
        if (room?.started) this.sendRoomEvent(id, type, payload);
      }
    } else {
      for (const u of this.users.values()) u.actor?.send({ type, payload: payload ?? {} });
    }
  }

  setGlobal(key, value) {
    this.globals[key] = resolveValue(this.globals[key], value);
    const committed = this.globals[key];
    this.io.log(`global ${key} = ${JSON.stringify(committed)}`);
    this.pushGlobalVar(key, committed);
    queueMicrotask(() => {
      if (this.roomMode) {
        for (const room of this.rooms.values())
          room.actor?.send({ type: 'global.changed', payload: { key, value: committed } });
      }
      for (const u of this.users.values())
        u.actor?.send({ type: 'global.changed', payload: { key, value: committed } });
    });
  }

  pushGlobalVar(key, value) {
    for (const [token, u] of this.users) {
      u.displayVars[`global.${key}`] = value;
      this.io.sendCue(token, this.mkCue({ kind: 'setVar', key: `global.${key}`, value }));
    }
  }

  evalGuard(token, g, contextVars, roomId = null) {
    if (!g) return true;
    if (g.all) return g.all.every((x) => this.evalGuard(token, x, contextVars, roomId));
    if (g.any) return g.any.some((x) => this.evalGuard(token, x, contextVars, roomId));
    if (g.not) return !this.evalGuard(token, g.not, contextVars, roomId);
    const [scope, ...rest] = String(g.var ?? '').split('.');
    const key = rest.join('.');
    let cur;
    if (scope === 'global') cur = this.globals[key];
    else if (scope === 'context') cur = contextVars?.[key];
    return (OPS[g.op ?? '=='] ?? OPS['=='])(cur, g.value);
  }

  // ---- outputs -------------------------------------------------------------

  mkCue(fields) {
    return { cueId: Math.random().toString(36).slice(2, 10), startAt: Date.now(), ...fields };
  }

  applyOutput(a, { store, fanTokens }) {
    const p = a.params ?? {};
    const lead = a.sync === 'scheduled' ? (p.leadTimeMs ?? 2000) : (p.leadTimeMs ?? 0);
    const startAt = Date.now() + lead;
    let cue = null;

    switch (a.command) {
      case 'playAudio':
        cue = this.mkCue({ kind: 'audio', assetId: p.assetId, gain: p.gain ?? 1, loop: !!p.loop, startAt });
        store.activeCues = store.activeCues.filter((c) => c.assetId !== p.assetId);
        store.activeCues.push(cue);
        break;
      case 'stopAudio':
        cue = this.mkCue({ kind: 'stopAudio', assetId: p.assetId ?? '*', fadeMs: p.fadeMs ?? 0, startAt });
        store.activeCues = store.activeCues.filter((c) =>
          (p.assetId ?? '*') === '*' ? c.kind !== 'audio' : c.assetId !== p.assetId);
        break;
      case 'playVideo':
        cue = this.mkCue({ kind: 'video', assetId: p.assetId, loop: !!p.loop, startAt });
        store.activeCues = store.activeCues.filter((c) => c.kind !== 'video');
        store.activeCues.push(cue);
        break;
      case 'showPage':
        store.page = { page: p.page, props: p.props ?? {} };
        store.activeCues = store.activeCues.filter((c) => c.kind !== 'video');
        cue = this.mkCue({ kind: 'page', ...store.page, startAt });
        break;
      case 'haptic':
        cue = this.mkCue({ kind: 'haptic', pattern: p.pattern ?? [200], startAt });
        break;
      case 'setVar':
        store.displayVars[p.key] = p.value;
        cue = this.mkCue({ kind: 'setVar', key: p.key, value: p.value, startAt });
        break;
      default:
        return this.io.log(`unknown output command "${a.command}"`);
    }

    for (const token of fanTokens) {
      const u = this.users.get(token);
      if (u) {
        if (a.command === 'showPage') u.page = { ...store.page };
        if (['playAudio', 'playVideo'].includes(a.command))
          u.activeCues = [...store.activeCues];
        if (a.command === 'setVar') u.displayVars[p.key] = p.value;
      }
      this.io.sendCue(token, cue);
    }
  }

  // ---- snapshot ------------------------------------------------------------

  getUserSnapshot(token) {
    const u = this.users.get(token);
    if (!u) return null;
    const now = Date.now();
    u.activeCues = u.activeCues.filter(
      (c) => c.loop || c.kind === 'video' || now - c.startAt < CUE_RETENTION_MS
    );
    return {
      state: u.stateString,
      zoneId: u.zoneId,
      page: u.page,
      displayVars: u.displayVars,
      cues: u.activeCues.filter((c) => c.loop || c.kind === 'video' || c.startAt > now),
    };
  }

  rosterInfo() {
    if (!this.def) return { loaded: false, running: false, roomMode: false };
    return {
      loaded: true,
      running: this.running,
      roomMode: this.roomMode,
      name: this.def.name ?? this.def.showId,
      contractVersion: this.def.contractVersion,
      roles: this.def.roles ?? [],
      assets: this.def.assets ?? [],
      roomDefs: this.roomMode
        ? Object.entries(this.def.rooms).map(([id, r]) => ({ id, name: r.name ?? id, startOn: r.startOn ?? 'firstEnter' }))
        : [],
      rooms: this.roomMode ? this.getRoomsRoster() : [],
    };
  }
}
