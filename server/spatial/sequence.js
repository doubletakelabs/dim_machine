/**
 * Sequences — a run of screens a guest steps through one at a time.
 *
 * A guidance state may declare `sequence` instead of hand-authoring a child
 * state per screen:
 *
 *   "calibration": {
 *     "sequence": [
 *       { "image": "img/calibration_01_ontap.png", "audio": "audio/calibrationsteps_01.mp3" },
 *       ...
 *     ],
 *     "onComplete": "done"
 *   }
 *
 * This expands, at load, into exactly the nested states and cues someone would
 * otherwise have written by hand. Nothing downstream knows a sequence existed —
 * validation, the machine builder and the cue director all see an ordinary show,
 * which is why none of them needed changing to support this.
 *
 * ## Why the advance rule comes from the filename
 *
 * `calibration_06_onswipe.png` waits for a swipe. The rule travels with the
 * artwork, so re-cutting the deck is a matter of dropping files in and listing
 * them — the thing a designer does twenty times before opening — rather than
 * editing a state machine to match. The show still says which screens run and in
 * what order; the file says only what ends each one.
 *
 * That is a deliberate exception to logic-as-data, and worth naming as one. It
 * earns its place because the rule is a property of the screen itself — this one
 * *says* TAP THE SCREEN — and holding that fact anywhere else means two places
 * that can disagree about it. `advance` on the step overrides the filename for
 * the cases a filename cannot carry.
 *
 * The pairing of one screen to one clip is this sequence's shape, not the
 * mechanism's: a step may declare an image with no audio, audio with no image,
 * or a slice of a longer recording via `offset`/`duration`.
 */

import { INPUT_KINDS } from './contract.js';

/** `..._ontap.png` → tap, `..._ondelay2500.png` → a 2500ms hold. */
const ADVANCE_PATTERN = /_on([a-z]+?)(\d+)?(?=\.[^.]*$)/i;

/**
 * @param {string} filename
 * @returns {{ kind: 'input', input: string } | { kind: 'delay', ms: number } | null}
 */
export function advanceFromFilename(filename) {
  const match = ADVANCE_PATTERN.exec(String(filename ?? ''));
  if (!match) return null;
  const [, word, digits] = match;
  const kind = word.toLowerCase();
  if (kind === 'delay') {
    const ms = Number(digits);
    return Number.isFinite(ms) && digits != null && ms >= 0 ? { kind: 'delay', ms } : null;
  }
  return INPUT_KINDS.includes(kind) ? { kind: 'input', input: kind } : null;
}

/** How a step advances: its own `advance`, else whatever its image says. */
export function advanceForStep(step) {
  const { advance } = step ?? {};
  if (advance == null) return advanceFromFilename(step?.image);
  if (typeof advance === 'number') {
    return Number.isFinite(advance) && advance >= 0 ? { kind: 'delay', ms: advance } : null;
  }
  return INPUT_KINDS.includes(advance) ? { kind: 'input', input: advance } : null;
}

/**
 * Expand every `sequence` in a show into plain states and cues.
 *
 * Returns a new definition; the input is untouched. Problems are collected
 * rather than thrown, so a bad sequence reports alongside every other load error
 * instead of hiding them behind a stack trace.
 *
 * @param {object} def
 * @returns {{ def: object, errors: string[], warnings: string[] }}
 */
export function expandSequences(def) {
  const errors = [];
  const warnings = [];
  const expanded = structuredClone(def ?? {});
  const machine = expanded.guest?.machine;
  if (!machine || typeof machine !== 'object') return { def: expanded, errors, warnings };

  if (!expanded.guest.cues) expanded.guest.cues = {};
  const ctx = {
    cues: expanded.guest.cues,
    bindings: expanded.inputBindings ?? {},
    errors,
    warnings,
  };

  for (const [region, block] of Object.entries(machine)) {
    if (region === 'location' || !block?.states) continue;
    walk(block.states, [region], ctx);
  }
  return { def: expanded, errors, warnings };
}

function walk(states, path, ctx) {
  for (const [stateId, state] of Object.entries(states ?? {})) {
    if (!state || typeof state !== 'object') continue;
    if (Array.isArray(state.sequence)) expandOne(state, [...path, stateId], ctx);
    if (state.states) walk(state.states, [...path, stateId], ctx);
  }
}

const stepId = (i) => `step${i + 1}`;

function expandOne(state, path, { cues, bindings, errors, warnings }) {
  const at = path.join('.');
  const steps = state.sequence;
  if (!steps.length) {
    errors.push(`guest.machine.${at}.sequence is empty`);
    return;
  }
  if (state.states) {
    errors.push(`guest.machine.${at} declares both sequence and states — pick one`);
    return;
  }

  const generated = {};
  const done = completionTarget(state, path, warnings, at);

  steps.forEach((step, i) => {
    const stepAt = `${at}.sequence[${i}]`;
    if (!step || typeof step !== 'object') {
      errors.push(`${stepAt} must be an object`);
      return;
    }
    if (!step.image && !step.audio) {
      errors.push(`${stepAt} declares neither image nor audio`);
      return;
    }

    const target = i === steps.length - 1 ? done : stepId(i + 1);
    generated[stepId(i)] = advanceNode(advanceForStep(step), target, stepAt, bindings, errors);
    cues[`${at}.${stepId(i)}`] = cueFor(step);
  });

  delete state.sequence;
  delete state.onComplete;
  state.initial = stepId(0);
  state.states = generated;
}

/** The `on`/`after` a step needs to leave itself, or nothing if it is the last. */
function advanceNode(advance, target, stepAt, bindings, errors) {
  if (!advance) {
    errors.push(
      `${stepAt} has no advance rule — name the file "..._ontap.png", "..._onswipe.png" `
      + 'or "..._ondelay2000.png", or set "advance" on the step',
    );
    return {};
  }
  if (!target) return {};
  if (advance.kind === 'delay') return { after: { [advance.ms]: target } };

  const event = bindings[advance.input];
  if (!event) {
    // A step waiting on a gesture the show never binds strands the guest, and
    // it looks from the floor exactly like a broken touch handler.
    errors.push(
      `${stepAt} waits for a ${advance.input}, but inputBindings does not bind "${advance.input}"`,
    );
    return {};
  }
  return { on: { [event]: target } };
}

function cueFor(step) {
  const cue = {};
  if (step.audio) cue.audio = step.audio;
  if (step.image) cue.image = step.image;
  for (const field of ['loop', 'gain', 'fadeMs', 'offset', 'duration']) {
    if (step[field] != null) cue[field] = step[field];
  }
  return cue;
}

/**
 * Where the last step goes. A bare name means a sibling of the sequence state —
 * the one that owns the steps — so it has to be resolved absolutely: XState
 * would otherwise look for it among the steps themselves and find nothing.
 */
function completionTarget(state, path, warnings, at) {
  const target = state.onComplete;
  if (!target) {
    warnings.push(`guest.machine.${at} has no onComplete — the last screen stays up`);
    return null;
  }
  if (String(target).startsWith('#')) return target;
  const [region, ...rest] = path;
  return `#guest.${[region, ...rest.slice(0, -1), target].join('.')}`;
}
