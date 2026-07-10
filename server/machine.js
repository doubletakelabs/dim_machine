// Phase 0: hardcoded show machine. One shared show-level machine — every phone
// mirrors the current state and receives that state's cues. (Per-user actors
// arrive in Phase 1/2.)
import { setup } from 'xstate';

// Cues fired on state entry. `leadTimeMs` is how far in the future the cue is
// scheduled (spec §6: "schedule, don't trigger" — default 2 s lead).
export const STATE_CUES = {
  act1: [
    { kind: 'audio', assetId: 'ambient.wav', loop: true, gain: 0.5, leadTimeMs: 2000 },
  ],
  act2: [
    { kind: 'audio', assetId: 'whisper.wav', gain: 0.9, leadTimeMs: 2000 },
  ],
  finale: [
    { kind: 'audio', assetId: 'chime.wav', gain: 0.9, leadTimeMs: 2000 },
    { kind: 'flash', leadTimeMs: 2000 },
  ],
};

export function createShowMachine({ onStateCues, onStopAll }) {
  return setup({
    actions: {
      enterCues: (_, params) => onStateCues(params.state, STATE_CUES[params.state] ?? []),
      stopAll: () => onStopAll(),
    },
  }).createMachine({
    id: 'show',
    initial: 'lobby',
    states: {
      lobby: {
        entry: { type: 'stopAll' },
        on: { START: 'act1' },
      },
      act1: {
        entry: { type: 'enterCues', params: { state: 'act1' } },
        on: { NEXT: 'act2', RESET: 'lobby' },
      },
      act2: {
        entry: { type: 'enterCues', params: { state: 'act2' } },
        on: { NEXT: 'finale', BACK: 'act1', RESET: 'lobby' },
      },
      finale: {
        entry: [{ type: 'stopAll' }, { type: 'enterCues', params: { state: 'finale' } }],
        on: { NEXT: 'ended', BACK: 'act2', RESET: 'lobby' },
      },
      ended: {
        entry: { type: 'stopAll' },
        on: { RESET: 'lobby' },
      },
    },
  });
}

// Events the operator panel may send into the machine.
export const OPERATOR_EVENTS = ['START', 'NEXT', 'BACK', 'RESET'];
