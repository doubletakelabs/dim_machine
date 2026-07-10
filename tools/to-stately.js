// Convert a contract-v1 show definition into XState code importable by the
// Stately editor (stately.ai → Import code). Custom action/guard objects are
// flattened into readable names so the visualization stays legible.
// Run: node tools/to-stately.js shows/example-haunting.json
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/to-stately.js <show.json>');
  process.exit(1);
}
const def = JSON.parse(readFileSync(file, 'utf8'));

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

function convertTransition(t) {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(convertTransition);
  const out = { ...t };
  if (out.actions)
    out.actions = (Array.isArray(out.actions) ? out.actions : [out.actions]).map(actionName);
  if (out.guard) out.guard = guardName(out.guard);
  return out;
}

function convertNode(node) {
  const out = { ...node };
  for (const kind of ['entry', 'exit'])
    if (out[kind])
      out[kind] = (Array.isArray(out[kind]) ? out[kind] : [out[kind]]).map(actionName);
  for (const key of ['on', 'after'])
    if (out[key])
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([ev, t]) => [ev, convertTransition(t)]));
  if (out.always) out.always = convertTransition(out.always);
  if (out.states)
    out.states = Object.fromEntries(
      Object.entries(out.states).map(([name, s]) => [name, convertNode(s)]));
  return out;
}

const machine = convertNode(def.machine);
if (!machine.id) machine.id = def.showId ?? 'show';

const code = `// Generated from ${file} — paste into stately.ai (Import code, XState v5)
import { createMachine } from "xstate";

export const machine = createMachine(${JSON.stringify(machine, null, 2)});
`;

const out = file.replace(/\.json$/, '.stately.js');
writeFileSync(out, code);
console.log('wrote', out);
