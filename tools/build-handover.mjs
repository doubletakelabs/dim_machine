#!/usr/bin/env node
/**
 * Assemble everything an outside developer needs into one folder.
 *
 *   npm run handover            → ./handover
 *   npm run handover -- ../out  → somewhere else
 *
 * Generated rather than kept, deliberately. A copied folder drifts from what it
 * was copied from — this contract has already had a harness offering a message
 * the protocol no longer has, and a document describing a lifecycle value
 * nothing sent. Both were caught by review rather than by anything structural.
 * A kit built from source on demand cannot go stale; the worst case is somebody
 * holding an old zip, which is at least obvious.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'handover'));

/**
 * Paths as they read in this repo → as they read in the kit.
 *
 * The kit is flatter than the repo, and a command in a document that does not
 * work where the reader is standing is worse than no command at all.
 */
const REWRITES = [
  ['docs/experience-template', 'reference'],
  ['docs/ROOM-EXPERIENCE.md', 'ROOM-EXPERIENCE.md'],
];

const rewrite = (text) => REWRITES.reduce((acc, [from, to]) => acc.split(from).join(to), text);

const copyText = (from, to) => {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  writeFileSync(join(out, to), rewrite(readFileSync(join(root, from), 'utf8')));
};

const README = `# DIM Machine — room experience kit

Everything needed to build an interactive piece that runs inside The Museum —
a projection, a screen, a monitor wall, whatever the room has.

\`\`\`
npm install          # one dependency: ws
\`\`\`

## Read

| | |
|---|---|
| **ROOM-EXPERIENCE.md** | The contract. Everything the show promises and expects, and the only document there is. |
| **reference/** | A working example that passes every check. ~150 lines. |

## Run the reference first

Seeing a conforming piece run is the fastest way to understand the protocol.

\`\`\`
npm run reference                        # a conforming piece on :8080
npm run harness -- ws://localhost:8080   # stand in for the show
\`\`\`

Then open:

- the display — <http://localhost:8080/display.html>
- the control panel — <http://localhost:7420/>
- the driver page — \`http://<your-lan-ip>:7420/drive\` on a phone, or several

Press the lifecycle buttons and watch the display. Add drivers. Open the driver page
on two phones. This is exactly how the show will drive your piece — the harness
connects as a **broker**, the same role and the same messages the show uses, so
your server cannot tell them apart. There is no dev mode.

## Check your own

\`\`\`
npm run verify -- ./your-folder
\`\`\`

Every check must pass. It boots your server, connects as a broker, and drives it
through the things that go wrong in a building rather than on a desk: a restart
mid-show, a driver presenting a secret it was never given, a driver set that
shrinks.

It checks the **protocol**, not the **behaviour** — see *What verify cannot
check* at the end of the contract for the three things that will be tested by
hand, and which are the three most likely to be wrong.

## The two rules underneath all of it

1. **Conditions are reconciled; events fire once.** Everything the show tells you
   about who is driving and what the room is doing is the whole truth, every
   time — so restarting, or being switched on an hour late, is never a special
   case.
2. **The show owns who and when. You own what it looks and feels like.**
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

copyText('docs/ROOM-EXPERIENCE.md', 'ROOM-EXPERIENCE.md');
copyText('tools/verify-experience.mjs', 'tools/verify-experience.mjs');
copyText('tools/experience-harness.mjs', 'tools/experience-harness.mjs');
for (const file of ['experience.json', 'server.js', 'display.html']) {
  copyText(`docs/experience-template/${file}`, `reference/${file}`);
}

// `ws` is the only dependency any of this has, and the reference server needs
// the same one — so a single install at the root covers all of it.
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name: 'dim-machine-experience-kit',
  private: true,
  type: 'commonjs',
  scripts: {
    verify: 'node tools/verify-experience.mjs',
    harness: 'node tools/experience-harness.mjs',
    reference: 'node reference/server.js',
  },
  dependencies: { ws: '^8.21.0' },
}, null, 2)}\n`);

writeFileSync(join(out, 'README.md'), README);

// A repo path that survived the rewrite is a command that will not work where
// the reader is standing. Cheaper to fail here than to be found by them.
const stale = [];
for (const file of ['ROOM-EXPERIENCE.md', 'reference/server.js', 'README.md']) {
  const text = readFileSync(join(out, file), 'utf8');
  for (const [from] of REWRITES) if (text.includes(from)) stale.push(`${file} mentions ${from}`);
}
if (stale.length) {
  console.error(`\n  stale paths survived the rewrite:\n    ${stale.join('\n    ')}\n`);
  process.exit(1);
}

console.log(`\n  handover kit → ${out}`);
console.log('  Everything in it is generated from this repo — re-run after any');
console.log('  change to the contract, the tools, or the reference.\n');
