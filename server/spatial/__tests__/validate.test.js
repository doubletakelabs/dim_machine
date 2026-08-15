import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateShowDefinition } from '../validate.js';
import { CONTRACT_VERSION } from '../contract.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const spatialDemo = JSON.parse(
  readFileSync(join(root, 'shows/spatial-demo.json'), 'utf8'),
);

const minimalV3 = {
  contractVersion: CONTRACT_VERSION,
  showId: 'test',
  name: 'Test Show',
  rooms: {
    alpha: {
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
  },
  guest: {
    eligibility: { golden: { strategy: 'goldenPath' } },
  },
  phases: [{ id: 'roam', mode: 'freeRoam' }],
  paths: {
    assignment: { strategy: 'roundRobin' },
    definitions: {
      pathA: { rooms: ['alpha'], guidance: 'freeExplore' },
    },
  },
};

describe('validateShowDefinition', () => {
  it('accepts spatial-demo.json', () => {
    const { errors } = validateShowDefinition(spatialDemo);
    assert.equal(errors.length, 0);
  });

  it('accepts a minimal v3 definition', () => {
    const { errors } = validateShowDefinition(minimalV3);
    assert.equal(errors.length, 0);
  });

  it('rejects contract v1', () => {
    const { errors } = validateShowDefinition({ contractVersion: 1, showId: 'x', name: 'x' });
    assert.match(errors[0], /contractVersion must be 3/);
  });

  it('rejects contract v2', () => {
    const { errors } = validateShowDefinition({ contractVersion: 2, showId: 'x', name: 'x' });
    assert.match(errors[0], /v1\/v2 shows are not supported/);
  });

  it('rejects path referencing unknown room', () => {
    const bad = structuredClone(minimalV3);
    bad.paths.definitions.pathA.rooms = ['missing'];
    const { errors } = validateShowDefinition(bad);
    assert.ok(errors.some((e) => e.includes('unknown room')));
  });

  it('rejects a top-level zones map', () => {
    const def = structuredClone(minimalV3);
    def.zones = { alpha: {} };
    assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('declare zones inside each room')));
  });

  it('rejects the old "user" block', () => {
    const def = structuredClone(minimalV3);
    def.user = def.guest;
    delete def.guest;
    assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('renamed to "guest"')));
  });

  describe('zones', () => {
    it('accepts several zones in one room', () => {
      const def = structuredClone(minimalV3);
      def.rooms.alpha.zones.annex = { polygon: [[20, 0], [30, 0], [30, 10], [20, 10]] };
      assert.equal(validateShowDefinition(def).errors.length, 0);
    });

    it('rejects a zone id reused across rooms', () => {
      const def = structuredClone(minimalV3);
      def.rooms.beta = structuredClone(def.rooms.alpha);
      def.paths.definitions.pathA.rooms.push('beta');
      const { errors } = validateShowDefinition(def);
      assert.ok(errors.some((e) => e.includes('duplicates a zone id')));
    });

    it('rejects a polygon with too few points', () => {
      const def = structuredClone(minimalV3);
      def.rooms.alpha.zones.alpha.polygon = [[0, 0], [1, 1]];
      assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('at least 3 points')));
    });

    it('warns when a room has no zones at all', () => {
      const def = structuredClone(minimalV3);
      def.rooms.alpha.zones = {};
      assert.ok(validateShowDefinition(def).warnings.some((w) => w.includes('cannot be entered')));
    });
  });

  describe('room machine contract', () => {
    function withRoomStates(mutate) {
      const def = structuredClone(minimalV3);
      mutate(def.rooms.alpha.machine.states);
      return validateShowDefinition(def);
    }

    it('requires every canonical presentation state', () => {
      const { errors } = withRoomStates((states) => { delete states.settling; });
      assert.ok(errors.some((e) => e.includes('states.settling is required')));
    });

    it('requires ACTIVATE from idle', () => {
      const { errors } = withRoomStates((states) => { states.idle = {}; });
      assert.ok(errors.some((e) => e.includes('states.idle must handle "ACTIVATE"')));
    });

    it('requires RESET from settling so exit grace can complete', () => {
      const { errors } = withRoomStates((states) => { states.settling = {}; });
      assert.ok(errors.some((e) => e.includes('states.settling must handle "RESET"')));
    });

    it('requires RELEASE from active so an unlocked room cannot stay active', () => {
      const { errors } = withRoomStates((states) => { states.active = {}; });
      assert.ok(errors.some((e) => e.includes('states.active must handle "RELEASE"')));
    });

    it('requires idle to be the initial state', () => {
      const def = structuredClone(minimalV3);
      def.rooms.alpha.machine.initial = 'active';
      assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('initial must be "idle"')));
    });

    it('allows extra non-canonical states such as an intro', () => {
      const { errors } = withRoomStates((states) => {
        states.idle = { on: { ACTIVATE: 'activating' } };
        states.activating = { on: { RELEASE: 'settling' }, after: { 900: { target: 'active' } } };
      });
      assert.equal(errors.length, 0);
    });

    it('requires idle to handle the revisit event a room declares', () => {
      const def = structuredClone(minimalV3);
      def.rooms.alpha.revisit = { whenSeen: {} };
      const { errors } = validateShowDefinition(def);
      assert.ok(errors.some((e) => e.includes('must handle "ACTIVATE_SEEN"')));
    });

    it('accepts a revisit variant the machine handles', () => {
      const def = structuredClone(minimalV3);
      def.rooms.alpha.revisit = { whenSeen: {} };
      def.rooms.alpha.machine.states.idle.on.ACTIVATE_SEEN = 'active';
      assert.equal(validateShowDefinition(def).errors.length, 0);
    });
  });

  describe('policy enums', () => {
    function withRoom(mutate) {
      const def = structuredClone(minimalV3);
      mutate(def.rooms.alpha);
      return validateShowDefinition(def);
    }

    it('rejects a misspelled multiGuest policy', () => {
      const { errors } = withRoom((room) => {
        room.multiGuest = { policy: 'colaborative' };
      });
      assert.ok(errors.some((e) => e.includes('multiGuest.policy must be one of')));
    });

    it('rejects the dropped queue capacity policy', () => {
      const { errors } = withRoom((room) => {
        room.multiGuest = { policy: 'collaborative', maxOccupants: 2, atCapacity: 'queue' };
      });
      assert.ok(errors.some((e) => e.includes('atCapacity must be one of')));
    });

    it('rejects unknown ineligible, exit, and audio policies', () => {
      const { errors } = withRoom((room) => {
        room.ineligible = { policy: 'shrug' };
        room.exit = { policy: 'never' };
        room.audio = { timing: 'whenever', joinPolicy: 'sure' };
      });
      assert.ok(errors.some((e) => e.includes('ineligible.policy')));
      assert.ok(errors.some((e) => e.includes('exit.policy')));
      assert.ok(errors.some((e) => e.includes('audio.timing')));
      assert.ok(errors.some((e) => e.includes('audio.joinPolicy')));
    });

    it('requires settling to handle RESUME when resumeIfReturned is set', () => {
      const { errors } = withRoom((room) => {
        room.exit = { policy: 'resetAfter', graceMs: 5000, resumeIfReturned: true };
      });
      assert.ok(errors.some((e) => e.includes('settling must handle "RESUME"')));
    });

    it('accepts resumeIfReturned when settling declares RESUME', () => {
      const def = structuredClone(minimalV3);
      def.rooms.alpha.machine.states.settling = { on: { RESET: 'idle', RESUME: 'active' } };
      def.rooms.alpha.exit = { policy: 'resetAfter', graceMs: 5000, resumeIfReturned: true };
      assert.equal(validateShowDefinition(def).errors.length, 0);
    });

    it('rejects an unknown guidance policy', () => {
      const def = structuredClone(minimalV3);
      def.paths.definitions.pathA.guidance = 'nearestUnseen';
      assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('guidance must be one of')));
    });

    it('requires a scope on advanceWhen', () => {
      const def = structuredClone(minimalV3);
      def.phases = [{ id: 'roam', mode: 'freeRoam', advanceWhen: { seenCount: 2 } }, { id: 'done' }];
      assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('advanceWhen.scope is required')));
    });

    it('accepts both advanceWhen scopes', () => {
      const def = structuredClone(minimalV3);
      def.phases = [
        { id: 'roam', mode: 'freeRoam', advanceWhen: { scope: 'guest', seenCount: 1 } },
        { id: 'converge', mode: 'directed', target: 'alpha', advanceWhen: { scope: 'show', entered: 'alpha' } },
      ];
      assert.equal(validateShowDefinition(def).errors.length, 0);
    });

    it('rejects a negative grace window', () => {
      const { errors } = withRoom((room) => {
        room.exit = { policy: 'resetAfter', graceMs: -1 };
      });
      assert.ok(errors.some((e) => e.includes('graceMs must be a non-negative number')));
    });

    it('warns when resumeIfReturned is combined with hold', () => {
      const def = structuredClone(minimalV3);
      def.rooms.alpha.machine.states.settling = { on: { RESET: 'idle', RESUME: 'active' } };
      def.rooms.alpha.exit = { policy: 'hold', resumeIfReturned: true };
      const { warnings } = validateShowDefinition(def);
      assert.ok(warnings.some((w) => w.includes('no effect with policy "hold"')));
    });

  });

  describe('eligibility', () => {
    it('rejects a strategy the contract names but the build cannot evaluate', () => {
      const def = structuredClone(minimalV3);
      def.guest.eligibility.golden = { strategy: 'roleBased' };
      const { errors } = validateShowDefinition(def);
      assert.ok(errors.some((e) => e.includes('not implemented yet')));
    });

    it('rejects a strategy the contract does not name at all', () => {
      const def = structuredClone(minimalV3);
      def.guest.eligibility.golden = { strategy: 'vibes' };
      assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('must be one of')));
    });

    it('accepts the implemented strategies', () => {
      for (const strategy of ['goldenPath', 'all', 'none']) {
        const def = structuredClone(minimalV3);
        def.guest.eligibility.golden = { strategy };
        assert.equal(validateShowDefinition(def).errors.length, 0, strategy);
      }
    });

    it('warns when no golden eligibility is declared', () => {
      const def = structuredClone(minimalV3);
      def.guest.eligibility = {};
      assert.ok(validateShowDefinition(def).warnings.some((w) => w.includes('default to goldenPath')));
    });
  });

  describe('phases, paths, and adherence', () => {
    it('requires a target on directed phases', () => {
      const def = structuredClone(minimalV3);
      def.phases = [{ id: 'converge', mode: 'directed' }];
      const { errors } = validateShowDefinition(def);
      assert.ok(errors.some((e) => e.includes('target is required for directed phases')));
    });

    it('rejects duplicate phase ids', () => {
      const def = structuredClone(minimalV3);
      def.phases = [{ id: 'roam', mode: 'freeRoam' }, { id: 'roam', mode: 'freeRoam' }];
      assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('must be unique')));
    });

    it('rejects a drifting threshold at or above cursed', () => {
      const def = structuredClone(minimalV3);
      def.adherence = { thresholds: { drifting: 80, cursed: 75 } };
      assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('drifting must be below cursed')));
    });

    it('rejects compliance weights that are not negative', () => {
      const def = structuredClone(minimalV3);
      def.adherence = { compliance: { eligibleRoomSeen: { weight: 30 } } };
      assert.ok(validateShowDefinition(def).errors.some((e) => e.includes('must be a negative number')));
    });

    it('warns about a room on no path', () => {
      const def = structuredClone(minimalV3);
      def.rooms.beta = structuredClone(def.rooms.alpha);
      const { warnings } = validateShowDefinition(def);
      assert.ok(warnings.some((w) => w.includes('rooms.beta is on no path')));
    });
  });
});
