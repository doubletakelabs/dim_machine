import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateShowDefinition } from '../validate.js';
import { CONTRACT_VERSION } from '../contract.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));

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
    // The real show and the fixture every other test file is written against.
    // A fixture that stops validating is a suite full of tests passing against
    // a show the server would refuse to load.
    // MAD-DIM is also where the beacon install is recorded as it happens, so
    // it may warn about exactly that: beacons not yet assigned, a door not yet
    // given a beacon, a new room not yet traced, museum clips not yet cut.
    // Anything else is a real problem.
    const installing = /belongs to no room or door yet|no beacon in beacons is at this door yet|zones is empty|museum\.stems\.\w+ is not set/;
    for (const file of ['shows/MAD-DIM.json', 'fixtures/small-show.json']) {
      const { errors, warnings } = validateShowDefinition(load(file));
      assert.deepEqual(errors, [], file);
      const other = file.startsWith('shows/') ? warnings.filter((w) => !installing.test(w)) : warnings;
      assert.deepEqual(other, [], file);
    }
  });

  it('warns when two rooms claim the same ground', () => {
    // A guest on the overlap enters whichever room iterates first — a show
    // that changes behaviour when a JSON key reorders. Hand-nudged vertices
    // create this silently, which is the whole reason it is checked at load.
    const warnings = warningsFor((def) => {
      def.rooms.alpha.zones.alpha.polygon = [[0, 0], [100, 0], [100, 100], [0, 100]];
      def.rooms.corridor.zones.corridor.polygon = [[90, 90], [200, 90], [200, 200], [90, 200]];
    });
    assert.match(warnings.join('\n'), /rooms\.alpha\.zones\.alpha overlaps rooms\.corridor\.zones\.corridor/);
  });

  it('does not mind rooms that share a wall', () => {
    // Touching is a boundary, not a claim — two rooms with a common wall are
    // the normal case in a building, not an authoring mistake.
    const warnings = warningsFor((def) => {
      def.rooms.alpha.zones.alpha.polygon = [[0, 0], [100, 0], [100, 100], [0, 100]];
      def.rooms.corridor.zones.corridor.polygon = [[100, 0], [200, 0], [200, 100], [100, 100]];
    });
    assert.deepEqual(warnings.filter((w) => /overlaps/.test(w)), []);
  });

  it('catches an overlap that leaves no vertex inside either polygon', () => {
    // Two rectangles crossed like a plus sign: every vertex of each is outside
    // the other, so a containment-only check would miss it entirely.
    const warnings = warningsFor((def) => {
      def.rooms.alpha.zones.alpha.polygon = [[40, 0], [60, 0], [60, 100], [40, 100]];
      def.rooms.corridor.zones.corridor.polygon = [[0, 40], [100, 40], [100, 60], [0, 60]];
    });
    assert.match(warnings.join('\n'), /overlaps/);
  });

  it('lets one room\'s own zones overlap freely', () => {
    // An L-shaped room drawn as two boxes that share a corner region is a
    // perfectly good way to author it — the claim is the room's either way.
    const warnings = warningsFor((def) => {
      // Overlaps alpha's own zone and stays clear of the corridor's.
      def.rooms.alpha.zones.alpha2 = { polygon: [[5, 5], [15, 5], [15, 15], [5, 15]] };
    });
    assert.deepEqual(warnings.filter((w) => /overlaps/.test(w)), []);
  });

  it('refuses a path strategy the runtime does not implement', () => {
    // `balanced` died when assignment moved to museum arrival; `manual` is an
    // operator's act, not a show's strategy. A name that validates and then
    // does nothing is a promise the show cannot keep — refuse it loudly.
    for (const strategy of ['balanced', 'manual']) {
      const errors = errorsFor((def) => {
        def.guest.machine.guidance.states.roaming.entry = [
          { type: 'assignPath', from: ['pathA'], strategy },
        ];
      });
      assert.match(errors.join('\n'), /assignPath\.strategy/, strategy);
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

describe('guest.audioLayers', () => {
  const withLayers = (audioLayers) => {
    const def = minimal();
    def.guest.audioLayers = audioLayers;
    return validateShowDefinition(def);
  };

  it('accepts the tuned mixer', () => {
    assert.deepEqual(withLayers({ duckTo: 0.25, duckMs: 300, crossfadeMs: 1000 }).errors, []);
  });

  it('refuses a duck depth that is not a gain', () => {
    assert.match(withLayers({ duckTo: 3 }).errors.join('\n'), /duckTo/);
    assert.match(withLayers({ duckTo: 'quiet' }).errors.join('\n'), /duckTo/);
  });

  it('refuses negative fade times', () => {
    assert.match(withLayers({ crossfadeMs: -5 }).errors.join('\n'), /crossfadeMs/);
  });

  it('warns about a setting the mixer does not have', () => {
    const result = withLayers({ duckAmountDb: -12 });
    assert.deepEqual(result.errors, []);
    assert.match(result.warnings.join('\n'), /duckAmountDb/);
  });
});

describe('a resume promise with nowhere to resume from', () => {
  it('warns when resumeIfReturned is declared on a machine without settling', () => {
    const def = minimal();
    const room = Object.values(def.rooms)[0];
    // The shape every MAD-DIM room ended up in: settling stripped from the
    // machine, the exit block's promise left behind.
    room.machine = {
      initial: 'idle',
      states: { idle: { on: { ACTIVATE: 'active' } }, active: { on: { RELEASE: 'idle' } } },
    };
    room.exit = { policy: 'resetAfter', graceMs: 10000, resumeIfReturned: true };
    const result = validateShowDefinition(def);
    assert.deepEqual(result.errors, []);
    assert.match(result.warnings.join('\n'), /resumeIfReturned.*no settling/);
  });
});
