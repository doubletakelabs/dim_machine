// Convert a contract show definition into XState code importable by the
// Stately editor (stately.ai → Import code). Custom action/guard objects are
// flattened into readable names; phone-input scope is set on transition.description.
//
// Run: node tools/to-stately.js shows/room-demo.json
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/to-stately.js <show.json>');
  process.exit(1);
}
const def = JSON.parse(readFileSync(file, 'utf8'));
const roomMode = def.contractVersion >= 2 && def.rooms;
const INPUT_EVENT = /^(tap|button:|choice:|swipe\.|drag\.|shake|pageDismiss|video\.ended)/;

function buildEventScopeMap(bindings) {
  const map = {};
  for (const [canonical, raw] of Object.entries(bindings ?? {})) {
    const event = typeof raw === 'string' ? raw : (raw.event ?? canonical);
    const scope = typeof raw === 'object' ? raw.scope : null;
    if (scope) {
      map[event] = scope;
      if (canonical !== event) map[canonical] = scope;
    }
  }
  return map;
}

function scopeDescription(ev, scopeMap) {
  if (!INPUT_EVENT.test(ev)) return null;
  return `scope: ${scopeMap[ev] ?? (roomMode ? 'room' : 'user')}`;
}

function actionName(a) {
  switch (a?.type) {
    case 'output': {
      const p = a.params ?? {};
      const arg = p.assetId ?? p.page ?? p.key ?? '';
      const sched = a.sync === 'scheduled' ? ' (scheduled)' : '';
      return `${a.command}(${arg})${sched}`;
    }
    case 'raise': return `raise(${a.event})`;
    case 'sendTo': return `sendTo ${a.target}: ${a.event}`;
    case 'broadcast': return `broadcast${a.role ? ` [${a.role}]` : ''}: ${a.event}`;
    case 'assign': return `${a.scope}.${a.key} ${/^[+-]/.test(String(a.value)) ? a.value : '= ' + JSON.stringify(a.value)}`;
    case 'log': return `log: ${a.message}`;
    default: return `unknown(${a?.type})`;
  }
}

function guardName(g) {
  if (g.all) return g.all.map(guardName).join(' && ');
  if (g.any) return g.any.map(guardName).join(' || ');
  if (g.not) return `!(${guardName(g.not)})`;
  return `${g.var} ${g.op ?? '=='} ${JSON.stringify(g.value)}`;
}

function convertTransition(t, ev, scopeMap) {
  const desc = scopeDescription(ev, scopeMap);

  if (typeof t === 'string') {
    if (!desc) return t;
    return { target: t, description: desc };
  }
  if (Array.isArray(t)) return t.map((x) => convertTransition(x, ev, scopeMap));

  const out = { ...t };
  if (desc && !out.description) out.description = desc;
  if (out.actions)
    out.actions = (Array.isArray(out.actions) ? out.actions : [out.actions]).map(actionName);
  if (out.guard) out.guard = guardName(out.guard);
  return out;
}

function convertNode(node, scopeMap) {
  const out = { ...node };
  for (const kind of ['entry', 'exit']) {
    if (out[kind])
      out[kind] = (Array.isArray(out[kind]) ? out[kind] : [out[kind]]).map(actionName);
  }
  if (out.on)
    out.on = Object.fromEntries(
      Object.entries(out.on).map(([ev, t]) => [ev, convertTransition(t, ev, scopeMap)]));
  if (out.after)
    out.after = Object.fromEntries(
      Object.entries(out.after).map(([ev, t]) => [ev, convertTransition(t, ev, scopeMap)]));
  if (out.always) out.always = convertTransition(out.always, '__always', scopeMap);
  if (out.states)
    out.states = Object.fromEntries(
      Object.entries(out.states).map(([name, s]) => [name, convertNode(s, scopeMap)]));
  return out;
}

function emitStately(machine, label, outPath, scopeMap) {
  if (!machine.id) machine.id = label;
  const code = `// Generated from ${file} — paste into stately.ai (Import code, XState v5)
// Phone-input transitions include description: "scope: room|personal" (see inputBindings in show JSON).
import { createMachine } from "xstate";

export const machine = createMachine(${JSON.stringify(convertNode(machine, scopeMap), null, 2)});
`;
  writeFileSync(outPath, code);
  console.log('wrote', outPath);
}

const base = file.replace(/\.json$/, '');
const scopeMap = buildEventScopeMap(def.inputBindings);

if (roomMode) {
  for (const [roomId, room] of Object.entries(def.rooms)) {
    const label = room.name ? `${def.showId ?? 'show'}.${roomId} (${room.name})` : `${def.showId ?? 'show'}.${roomId}`;
    emitStately(room.machine, label, `${base}.${roomId}.stately.js`, scopeMap);
  }
} else if (def.machine) {
  emitStately(def.machine, def.showId ?? 'show', `${base}.stately.js`, scopeMap);
} else {
  console.error('no machine (v1) or rooms (v2) found in', file);
  process.exit(1);
}
