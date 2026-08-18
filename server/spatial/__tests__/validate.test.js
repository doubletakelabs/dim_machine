import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateShowDefinition } from '../validate.js';
import { CONTRACT_VERSION } from '../contract.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (f) => JSON.parse(readFileSync(join(root, 'shows', f), 'utf8'));

const minimal = () => ({
  contractVersion: CONTRACT_VERSION,
  showId: 'test',
  name: 'Test Show',
  rooms: {
    alpha: {
      kind: 'destination',
      adjacent: ['corridor'],
      zones: { alpha: { polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] } },
      machine: {
        initial: 'idle',
        states: {
          idle: { on: { ACTIVATE: 'active' } },
          active: { on: { RELEASE: 'settling' } },
          settling: { on: { RESET: 'idle' } },
        },
      },
    },
    corridor: {
      kind: 'hallway',
      adjacent: ['alpha'],
      zones: { corridor: { polygon: [[20, 0], [30, 0], [30, 10], [20, 10]] } },
    },
  },
  paths: { pathA: { rooms: ['alpha'], guidance: 'goldenPath' } },
  guest: {
    eligibility: { golden: { strategy: 'goldenPath' } },
    machine: {
      guidance: {
        initial: 'start',
        states: {
          start: { on: { 'entered.corridor': 'roaming' } },
          roaming: { entry: [{ type: 'assignPath', from: ['pathA'], strategy: 'roundRobin' }] },
        },
      },
      adherence: { initial: 'onPath', states: { onPath: { on: { wentOffPath: 'offPath' } }, offPath: {} } },
    },
  },
});

const errorsFor = (mutate) => {
  const def = minimal();
  mutate(def);
  return validateShowDefinition(def).errors;
};
const warningsFor = (mutate) => {
  const def = minimal();
  mutate(def);
  return validateShowDefinition(def).warnings;
};

describe('validateShowDefinition', () => {
  it('accepts the shipped shows', () => {
    for (const file of ['spatial-demo.json', 'the-museum.json']) {
      const { errors, warnings } = validateShowDefinition(load(file));
      assert.deepEqual(errors, [], file);
      assert.deepEqual(warnings, [], file);
    }
  });

  it('accepts a minimal definition', () => {
    assert.deepEqual(validateShowDefinition(minimal()).errors, []);
  });

  it('rejects v1 and v2', () => {
    for (const v of [1, 2]) {
      const { errors } = validateShowDefinition({ contractVersion: v, showId: 'x', name: 'x' });
      assert.match(errors[0], /contractVersion must be 3/);
    }
  });

  it('rejects the vocabularies this contract replaced', () => {
    assert.ok(errorsFor((d) => { d.zones = {}; }).some((e) => e.includes('declare zones inside each room')));
    assert.ok(errorsFor((d) => { d.user = {}; }).some((e) => e.includes('renamed to "guest"')));
    assert.ok(errorsFor((d) => { d.phases = []; }).some((e) => e.includes('guidance region')));
  });

  describe('room kind', () => {
    it('rejects an unknown kind', () => {
      assert.ok(errorsFor((d) => { d.rooms.alpha.kind = 'annex'; }).some((e) => e.includes('kind must be one of')));
    });

    it('does not require the activation contract of a hallway', () => {
      // A hallway is never activated, so demanding states it could never enter
      // would be ceremony.
      assert.deepEqual(errorsFor((d) => { delete d.rooms.corridor.machine; }), []);
    });

    it('warns when a hallway carries settings that cannot apply', () => {
      const warnings = warningsFor((d) => { d.rooms.corridor.exit = { policy: 'hold' }; });
      assert.ok(warnings.some((w) => w.includes('do not apply')));
    });

    it('rejects a path routing through a hallway', () => {
      const errors = errorsFor((d) => { d.paths.pathA.rooms = ['alpha', 'corridor']; });
      assert.ok(errors.some((e) => e.includes('which is a hallway')));
    });
  });

  describe('adjacency', () => {
    it('rejects a door declared from only one side', () => {
      const errors = errorsFor((d) => { d.rooms.corridor.adjacent = []; });
      assert.ok(errors.some((e) => e.includes('omits')));
    });

    it('rejects an unknown neighbour and self-adjacency', () => {
      assert.ok(errorsFor((d) => { d.rooms.alpha.adjacent.push('nowhere'); }).some((e) => e.includes('unknown room')));
      assert.ok(errorsFor((d) => { d.rooms.alpha.adjacent.push('alpha'); }).some((e) => e.includes('lists itself')));
    });

    it('warns when a room declares none', () => {
      const warnings = warningsFor((d) => { delete d.rooms.alpha.adjacent; delete d.rooms.corridor.adjacent; });
      assert.ok(warnings.some((w) => w.includes('cannot be checked')));
    });
  });

  describe('off-path variants', () => {
    it('requires a room promising a variant to be able to hear it', () => {
      const errors = errorsFor((d) => { d.rooms.alpha.ineligible = { policy: 'activateVariant' }; });
      assert.ok(errors.some((e) => e.includes('ACTIVATE_OFFPATH')));
    });

    it('accepts one that declares the transition', () => {
      assert.deepEqual(errorsFor((d) => {
        d.rooms.alpha.ineligible = { policy: 'activateVariant' };
        d.rooms.alpha.machine.states.idle.on.ACTIVATE_OFFPATH = 'active';
      }), []);
    });
  });

  describe('the guest machine', () => {
    it('refuses an authored location region', () => {
      const errors = errorsFor((d) => { d.guest.machine.location = { initial: 'a', states: { a: {} } }; });
      assert.ok(errors.some((e) => e.includes('generated from room adjacency')));
    });

    it('rejects a region that is not authorable', () => {
      const errors = errorsFor((d) => { d.guest.machine.audio = { initial: 'a', states: { a: {} } }; });
      assert.ok(errors.some((e) => e.includes('not an authorable region')));
    });

    it('rejects an initial state that is not its own', () => {
      const errors = errorsFor((d) => { d.guest.machine.guidance.initial = 'elsewhere'; });
      assert.ok(errors.some((e) => e.includes('must name one of its own states')));
    });

    it('rejects a room-entry transition naming an unknown room', () => {
      const errors = errorsFor((d) => { d.guest.machine.guidance.states.start.on = { 'entered.attic': 'roaming' }; });
      assert.ok(errors.some((e) => e.includes('unknown room "attic"')));
    });

    it('rejects an assignPath with no options', () => {
      const errors = errorsFor((d) => { d.guest.machine.guidance.states.roaming.entry = [{ type: 'assignPath', from: [] }]; });
      assert.ok(errors.some((e) => e.includes('non-empty "from"')));
    });
  });

  describe('declared timers', () => {
    it('accepts one naming a real state', () => {
      assert.deepEqual(errorsFor((d) => {
        d.guest.timers = { t: { sinceEntering: 'guidance.roaming', afterMs: 1000, event: 'UP' } };
      }), []);
    });

    it('rejects one naming a state that does not exist', () => {
      const errors = errorsFor((d) => {
        d.guest.timers = { t: { sinceEntering: 'guidance.nowhere', afterMs: 1000, event: 'UP' } };
      });
      assert.ok(errors.some((e) => e.includes('unknown state')));
    });

    it('rejects a timer with no duration or no event', () => {
      assert.ok(errorsFor((d) => { d.guest.timers = { t: { sinceEntering: 'guidance.roaming', event: 'UP' } }; })
        .some((e) => e.includes('afterMs')));
      assert.ok(errorsFor((d) => { d.guest.timers = { t: { sinceEntering: 'guidance.roaming', afterMs: 5 } }; })
        .some((e) => e.includes('event')));
    });
  });

  describe('eligibility', () => {
    it('rejects a strategy the build cannot evaluate', () => {
      assert.ok(errorsFor((d) => { d.guest.eligibility.golden = { strategy: 'roleBased' }; })
        .some((e) => e.includes('not implemented yet')));
    });

    it('rejects one the contract does not name', () => {
      assert.ok(errorsFor((d) => { d.guest.eligibility.golden = { strategy: 'vibes' }; })
        .some((e) => e.includes('must be one of')));
    });
  });

  describe('room policy enums', () => {
    it('rejects misspellings rather than loading them silently', () => {
      const errors = errorsFor((d) => {
        d.rooms.alpha.multiGuest = { policy: 'colaborative', maxOccupants: 2, atCapacity: 'queue' };
        d.rooms.alpha.exit = { policy: 'never' };
        d.rooms.alpha.whenAvailable = { policy: 'maybe' };
      });
      assert.ok(errors.some((e) => e.includes('multiGuest.policy')));
      assert.ok(errors.some((e) => e.includes('atCapacity')));
      assert.ok(errors.some((e) => e.includes('exit.policy')));
      assert.ok(errors.some((e) => e.includes('whenAvailable.policy')));
    });

    it('requires settling to handle RESUME when the room promises it', () => {
      const errors = errorsFor((d) => {
        d.rooms.alpha.exit = { policy: 'resetAfter', graceMs: 5000, resumeIfReturned: true };
      });
      assert.ok(errors.some((e) => e.includes('RESUME')));
    });
  });

  describe('zones', () => {
    it('rejects a zone id reused across rooms', () => {
      const errors = errorsFor((d) => { d.rooms.corridor.zones = { alpha: { polygon: [[0, 0], [1, 0], [1, 1]] } }; });
      assert.ok(errors.some((e) => e.includes('duplicates a zone id')));
    });

    it('rejects a polygon with too few points', () => {
      const errors = errorsFor((d) => { d.rooms.alpha.zones.alpha.polygon = [[0, 0], [1, 1]]; });
      assert.ok(errors.some((e) => e.includes('at least 3 points')));
    });
  });
});
