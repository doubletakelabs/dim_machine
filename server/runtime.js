// ShowRuntime — interprets contract-v1 show definitions (see CONTRACT.md).
// One XState actor per user; the runtime owns global variables (spec §3.4:
// single owner, serialized writes) and dispatches the three action targets.
import { setup, createActor } from 'xstate';

const SUPPORTED_CONTRACT = 1;

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

// Wrap every author action/guard so a generic implementation interprets it.
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

export function validateDefinition(def) {
  const errors = [];
  const warnings = [];
  if (def.contractVersion !== SUPPORTED_CONTRACT)
    errors.push(`contractVersion ${def.contractVersion} not supported (runtime supports ${SUPPORTED_CONTRACT})`);
  if (!def.machine || typeof def.machine !== 'object' || !def.machine.states)
    errors.push('missing machine.states');

  const checkAction = (a, path) => {
    if (!a || typeof a !== 'object') return warnings.push(`${path}: action is not an object`);
    if (!ACTION_TYPES.includes(a.type)) warnings.push(`${path}: unknown action type "${a.type}"`);
    if (a.type === 'output' && !OUTPUT_COMMANDS.includes(a.command))
      warnings.push(`${path}: unknown output command "${a.command}"`);
    if (a.type === 'assign' && !['context', 'global'].includes(a.scope))
      warnings.push(`${path}: assign scope must be context|global`);
    if (a.type === 'assign' && a.scope === 'global' && def.globals && !(a.key in def.globals))
      warnings.push(`${path}: global "${a.key}" not declared in globals`);
  };
  const checkGuard = (g, path) => {
    if (g.all) return g.all.forEach((x, i) => checkGuard(x, `${path}.all[${i}]`));
    if (g.any) return g.any.forEach((x, i) => checkGuard(x, `${path}.any[${i}]`));
    if (g.not) return checkGuard(g.not, `${path}.not`);
    if (typeof g.var !== 'string' || !/^(global|context)\./.test(g.var))
      warnings.push(`${path}: guard var must be "global.<key>" or "context.<key>"`);
    if (g.op && !OPS[g.op]) warnings.push(`${path}: unknown op "${g.op}"`);
  };
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const kind of ['entry', 'exit']) {
      if (node[kind]) (Array.isArray(node[kind]) ? node[kind] : [node[kind]])
        .forEach((a, i) => checkAction(a, `${path}.${kind}[${i}]`));
    }
    for (const key of ['on', 'after']) {
      for (const [ev, t] of Object.entries(node[key] ?? {})) {
        for (const tr of Array.isArray(t) ? t : [t]) {
          if (typeof tr === 'string') continue;
          if (tr.actions) (Array.isArray(tr.actions) ? tr.actions : [tr.actions])
            .forEach((a, i) => checkAction(a, `${path}.${key}.${ev}.actions[${i}]`));
          if (tr.guard) checkGuard(tr.guard, `${path}.${key}.${ev}.guard`);
        }
      }
    }
    for (const [name, s] of Object.entries(node.states ?? {})) walk(s, `${path}.${name}`);
  };
  if (def.machine) walk(def.machine, 'machine');
  return { errors, warnings };
}

// Collect event names for the operator's quick-push buttons (skip inputs the
// phones generate themselves and internal events).
export function collectOperatorEvents(machineNode, boundInputs = [], acc = new Set()) {
  for (const ev of Object.keys(machineNode.on ?? {})) {
    if (!/^(tap|button:|choice:|swipe\.|drag\.|shake|pageDismiss|video\.ended|global\.changed)/.test(ev)
        && !boundInputs.includes(ev))
      acc.add(ev);
  }
  for (const s of Object.values(machineNode.states ?? {})) collectOperatorEvents(s, boundInputs, acc);
  return [...acc];
}

export class ShowRuntime {
  /**
   * @param io.sendCue        (token, cue) → deliver a phone command
   * @param io.onUserState    (token, stateString) → roster/phone display
   * @param io.log            (line) → operator log
   */
  constructor(io) {
    this.io = io;
    this.def = null;
    this.running = false;
    this.globals = {};
    this.users = new Map(); // token → { actor, vars, role, page, displayVars, activeCues, stateString }
  }

  load(def) {
    const result = validateDefinition(def);
    if (result.errors.length) return result;
    this.stop();
    this.def = def;
    this.io.log(`show loaded: ${def.name ?? def.showId} (contract v${def.contractVersion})`);
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
    if (!this.running && this.users.size === 0) return;
    for (const [token, u] of this.users) {
      try { u.actor?.stop(); } catch {}
      this.io.sendCue(token, { kind: 'stopAudio', assetId: '*', fadeMs: 500, startAt: Date.now() });
      this.io.sendCue(token, this.mkCue({ kind: 'page', page: 'waiting', props: { title: 'Show ended' } }));
      this.io.onUserState(token, null);
    }
    this.users.clear();
    if (this.running) this.io.log('show stopped');
    this.running = false;
  }

  // Spawn (or respawn) an actor for a user; late joiners start at initial.
  attachUser(token, role = null) {
    if (!this.running) return;
    const existing = this.users.get(token);
    if (existing?.actor) return;
    const u = {
      actor: null, vars: {}, role: existing?.role ?? role,
      page: null, displayVars: {}, activeCues: [], stateString: null,
    };
    this.users.set(token, u);
    const rt = this;
    const machine = setup({
      actions: { __exec: ({ self }, params) => rt.execAction(token, params, self) },
      guards: { __cond: (_, params) => rt.evalGuard(token, params) },
    }).createMachine(transformMachine(this.def.machine));
    u.actor = createActor(machine);
    u.actor.subscribe((snap) => {
      u.stateString = stateToString(snap.value);
      this.io.onUserState(token, u.stateString);
    });
    u.actor.start();
    for (const [key, value] of Object.entries(this.globals))
      this.io.sendCue(token, this.mkCue({ kind: 'setVar', key: `global.${key}`, value }));
  }

  detachUser(token) {
    const u = this.users.get(token);
    if (u) { try { u.actor?.stop(); } catch {} }
    this.users.delete(token);
  }

  setRole(token, role) {
    const u = this.users.get(token);
    if (u) u.role = role || null;
  }

  // ---- events in -----------------------------------------------------------
  handleInput(token, type, payload) {
    const u = this.users.get(token);
    if (!u?.actor) return;
    const bound = this.def.inputBindings?.[type] ?? type;
    u.actor.send({ type: bound, payload: payload ?? {} });
    this.io.log(`input ${type}${bound !== type ? ` → ${bound}` : ''} from ${token.slice(0, 8)}`);
  }

  sendEvent(target, type, payload) {
    const send = (u) => u.actor?.send({ type, payload: payload ?? {} });
    if (target === 'all') for (const u of this.users.values()) send(u);
    else { const u = this.users.get(target); if (u) send(u); }
  }

  // ---- action interpreter --------------------------------------------------
  execAction(token, a, self) {
    try {
      switch (a?.type) {
        case 'output': return this.output(token, a);
        case 'raise': return self.send({ type: a.event, payload: a.payload ?? {} });
        case 'sendTo':
          // Phase 1: orchestrator = forward to every user machine (spec §12 Ph1)
          if (a.target === 'orchestrator')
            queueMicrotask(() => this.sendEvent('all', a.event, a.payload));
          else this.io.log(`sendTo target "${a.target}" not supported in Phase 1`);
          return;
        case 'broadcast':
          queueMicrotask(() => {
            for (const [t, u] of this.users) {
              if (a.role && u.role !== a.role) continue;
              u.actor?.send({ type: a.event, payload: a.payload ?? {} });
            }
          });
          return;
        case 'log':
          return this.io.log(`[author] ${a.message} (${token.slice(0, 8)})`);
        case 'assign': {
          if (a.scope === 'global') return this.setGlobal(a.key, a.value);
          const u = this.users.get(token);
          if (u) u.vars[a.key] = resolveValue(u.vars[a.key], a.value);
          return;
        }
        default:
          this.io.log(`unknown action type "${a?.type}" — skipped`);
      }
    } catch (err) {
      this.io.log(`action error (${a?.type}): ${err.message}`);
    }
  }

  // Serialized global writes (single owner — spec §3.4), then replicate:
  // setVar to every phone + global.changed into every machine.
  setGlobal(key, value) {
    this.globals[key] = resolveValue(this.globals[key], value);
    const committed = this.globals[key];
    this.io.log(`global ${key} = ${JSON.stringify(committed)}`);
    this.pushGlobalVar(key, committed);
    queueMicrotask(() => {
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

  evalGuard(token, g) {
    if (!g) return true;
    if (g.all) return g.all.every((x) => this.evalGuard(token, x));
    if (g.any) return g.any.some((x) => this.evalGuard(token, x));
    if (g.not) return !this.evalGuard(token, g.not);
    const [scope, ...rest] = String(g.var ?? '').split('.');
    const key = rest.join('.');
    const cur = scope === 'global' ? this.globals[key] : this.users.get(token)?.vars[key];
    return (OPS[g.op ?? '=='] ?? OPS['=='])(cur, g.value);
  }

  // ---- outputs (phone commands) --------------------------------------------
  mkCue(fields) {
    return { cueId: Math.random().toString(36).slice(2, 10), startAt: Date.now(), ...fields };
  }

  output(token, a) {
    const u = this.users.get(token);
    if (!u) return;
    const p = a.params ?? {};
    const lead = a.sync === 'scheduled' ? (p.leadTimeMs ?? 2000) : (p.leadTimeMs ?? 0);
    const startAt = Date.now() + lead;
    let cue = null;
    switch (a.command) {
      case 'playAudio':
        cue = this.mkCue({ kind: 'audio', assetId: p.assetId, gain: p.gain ?? 1, loop: !!p.loop, startAt });
        u.activeCues = u.activeCues.filter((c) => c.assetId !== p.assetId);
        u.activeCues.push(cue);
        break;
      case 'stopAudio':
        cue = this.mkCue({ kind: 'stopAudio', assetId: p.assetId ?? '*', fadeMs: p.fadeMs ?? 0, startAt });
        u.activeCues = u.activeCues.filter((c) =>
          (p.assetId ?? '*') === '*' ? c.kind !== 'audio' : c.assetId !== p.assetId);
        break;
      case 'playVideo':
        cue = this.mkCue({ kind: 'video', assetId: p.assetId, loop: !!p.loop, startAt });
        u.activeCues = u.activeCues.filter((c) => c.kind !== 'video');
        u.activeCues.push(cue);
        break;
      case 'showPage':
        u.page = { page: p.page, props: p.props ?? {} };
        u.activeCues = u.activeCues.filter((c) => c.kind !== 'video'); // page swap clears video
        cue = this.mkCue({ kind: 'page', ...u.page, startAt });
        break;
      case 'haptic':
        cue = this.mkCue({ kind: 'haptic', pattern: p.pattern ?? [200], startAt });
        break;
      case 'setVar':
        u.displayVars[p.key] = p.value;
        cue = this.mkCue({ kind: 'setVar', key: p.key, value: p.value, startAt });
        break;
      default:
        return this.io.log(`unknown output command "${a.command}"`);
    }
    this.io.sendCue(token, cue);
  }

  // ---- snapshot (reconnect resync — spec §7.2.3) ----------------------------
  getUserSnapshot(token) {
    const u = this.users.get(token);
    if (!u) return null;
    const now = Date.now();
    u.activeCues = u.activeCues.filter(
      (c) => c.loop || c.kind === 'video' || now - c.startAt < CUE_RETENTION_MS
    );
    return {
      state: u.stateString,
      page: u.page,
      displayVars: u.displayVars,
      cues: u.activeCues.filter((c) => c.loop || c.kind === 'video' || c.startAt > now),
    };
  }

  rosterInfo() {
    if (!this.def) return { loaded: false, running: false };
    return {
      loaded: true,
      running: this.running,
      name: this.def.name ?? this.def.showId,
      contractVersion: this.def.contractVersion,
      roles: this.def.roles ?? [],
      events: collectOperatorEvents(this.def.machine ?? {}, Object.values(this.def.inputBindings ?? {})),
      assets: this.def.assets ?? [],
    };
  }
}

function resolveValue(current, value) {
  if (typeof value === 'string' && /^[+-]\d+(\.\d+)?$/.test(value))
    return (Number(current) || 0) + Number(value);
  return value;
}
