import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { GuestActor } from '../guest-actor.js';
import { Guest } from '../guest.js';
import { eligibilityStrategy, IMPLEMENTED_ELIGIBILITY_STRATEGIES } from '../eligibility.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const spatialDemo = JSON.parse(readFileSync(join(root, 'shows/spatial-demo.json'), 'utf8'));

/** Floor-plan points inside each demo room. */
const AT = {
  library: [200, 140],
  libraryAlcove: [300, 135],
  greenhouse: [440, 140],
  cellar: [300, 300],
  corridor: [10, 10],
};

function makeRuntime(io = {}) {
  const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock(), ...io });
  rt.load(spatialDemo);
  rt.start();
  return rt;
}

/** Spawn until we get a guest on the requested path. */
function spawnOnPath(rt, pathId) {
  for (let i = 0; i < 4; i++) {
    const g = rt.spawnGuest({ label: pathId });
    if (g.pathId === pathId) return g;
  }
  throw new Error(`no guest assigned to ${pathId}`);
}

function walkTo(rt, guestId, point, ms = 1500) {
  rt.setVirtualPosition(guestId, point[0], point[1]);
  rt.testAdvanceTime(ms);
}

const roomOf = (rt, roomId) => rt.getRoomsRoster().find((r) => r.roomId === roomId);
const guestOf = (rt, token) => rt.getGuestsRoster().find((g) => g.token === token);

describe('eligibility strategies', () => {
  const show = {
    paths: { definitions: { pathA: { rooms: ['library', 'greenhouse'] } } },
    rooms: { library: {}, greenhouse: {}, cellar: {} },
  };
  const guest = () => new Guest({
    guestId: 'g1', token: 't1', label: 'G', pathId: 'pathA', phaseId: 'roamA',
  });

  it('goldenPath admits rooms on the assigned path', () => {
    const strategy = eligibilityStrategy('goldenPath');
    assert.equal(strategy({ guest: guest(), roomId: 'library', show, params: {} }), true);
    assert.equal(strategy({ guest: guest(), roomId: 'cellar', show, params: {} }), false);
  });

  it('goldenPath lets guests back into a seen room by default', () => {
    const g = guest();
    g.history('library').seen = true;
    const strategy = eligibilityStrategy('goldenPath');
    assert.equal(strategy({ guest: g, roomId: 'library', show, params: {} }), true);
    assert.equal(
      strategy({ guest: g, roomId: 'library', show, params: { allowRevisit: false } }),
      false,
    );
  });

  it('all and none are absolute', () => {
    assert.equal(eligibilityStrategy('all')({ guest: guest(), roomId: 'cellar', show, params: {} }), true);
    assert.equal(eligibilityStrategy('none')({ guest: guest(), roomId: 'library', show, params: {} }), false);
  });

  it('exposes only the strategies this build can evaluate', () => {
    assert.deepEqual(IMPLEMENTED_ELIGIBILITY_STRATEGIES.sort(), ['all', 'goldenPath', 'none']);
    assert.equal(eligibilityStrategy('roleBased'), null);
  });
});

describe('GuestActor', () => {
  it('reports which rooms are open to a guest', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const actor = rt.guestActors.get(a.guestId);
    assert.deepEqual(actor.eligibleRoomIds().sort(), ['greenhouse', 'library']);
    assert.equal(actor.isEligible('cellar'), false);
  });

  it('resolves the room-declared response for an ineligible entry', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const actor = rt.guestActors.get(a.guestId);
    assert.deepEqual(actor.ineligibleResponse('cellar'), {
      policy: 'lockedMessage', audio: 'cellar-locked',
    });
  });

  it('falls back to ignore when a room declares nothing', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const actor = new GuestActor({
      guest: rt.guests.get(a.guestId),
      show: { rooms: { bare: {} }, paths: spatialDemo.paths, guest: spatialDemo.guest },
      requestActivation: () => ({ ok: false, reason: 'unknown' }),
    });
    assert.deepEqual(actor.ineligibleResponse('bare'), { policy: 'ignore', audio: null });
  });
});

describe('A3 — walking into rooms', () => {
  it('an eligible entry activates the room and takes the lock', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    walkTo(rt, a.guestId, AT.library);

    assert.equal(roomOf(rt, 'library').lockHolder, a.guestId);
    assert.equal(guestOf(rt, a.token).lastEntry.outcome, 'activated');
    assert.ok(rt.eventLog.some((e) => e.type === 'guest.activatedRoom' && e.roomId === 'library'));
    assert.equal(guestOf(rt, a.token).visitHistory.library.activatedByMe, true);
  });

  it('an ineligible entry leaves the room completely untouched', () => {
    // The signature asymmetry of the whole model: one spatial event, the guest
    // reacts, the room does not (§1.1, §3.4).
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');   // cellar is not on pathA
    walkTo(rt, a.guestId, AT.cellar);

    const cellar = roomOf(rt, 'cellar');
    assert.equal(cellar.state, 'idle');
    assert.equal(cellar.lockHolder, null);
    assert.equal(cellar.lastRefuse, null);   // it never even heard a request
    assert.ok(cellar.occupants.includes(a.guestId));

    const entry = guestOf(rt, a.token).lastEntry;
    assert.equal(entry.outcome, 'ineligible');
    assert.equal(entry.policy, 'lockedMessage');
    assert.equal(entry.audio, 'cellar-locked');
  });

  it('records an ineligible entry for adherence to consume later', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    walkTo(rt, a.guestId, AT.cellar);
    const event = rt.eventLog.find((e) => e.type === 'guest.ineligibleEntry');
    assert.equal(event.roomId, 'cellar');
    assert.equal(event.policy, 'lockedMessage');
  });

  it('an ineligible entry does not count as a visit the guest activated', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    walkTo(rt, a.guestId, AT.cellar);
    const history = guestOf(rt, a.token).visitHistory.cellar;
    assert.equal(history.visits, 1);            // they were physically there
    assert.equal(history.activatedByMe, false); // but it was never theirs
  });

  it('two guests on different paths get opposite outcomes in the same room', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');   // library + greenhouse
    const b = spawnOnPath(rt, 'pathB');   // library + cellar

    walkTo(rt, b.guestId, AT.cellar);
    assert.equal(roomOf(rt, 'cellar').lockHolder, b.guestId);

    walkTo(rt, a.guestId, AT.greenhouse);
    assert.equal(roomOf(rt, 'greenhouse').lockHolder, a.guestId);
    assert.equal(guestOf(rt, a.token).lastEntry.outcome, 'activated');
  });

  it('a second eligible guest is refused while the first holds the room', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const b = spawnOnPath(rt, 'pathB');   // library is on both paths

    walkTo(rt, a.guestId, AT.library);
    assert.equal(roomOf(rt, 'library').lockHolder, a.guestId);

    walkTo(rt, b.guestId, AT.library);
    const entry = guestOf(rt, b.token).lastEntry;
    assert.equal(entry.outcome, 'refused');
    assert.equal(entry.reason, 'locked');
    // A5 turns this policy into behavior; A3 only has to surface the decision.
    assert.equal(entry.multiGuestPolicy, 'collaborative');
    assert.equal(roomOf(rt, 'library').lockHolder, a.guestId);
  });

  it('crossing between zones of one room does not re-trigger activation', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    walkTo(rt, a.guestId, AT.library);
    const before = rt.eventLog.filter((e) => e.type === 'guest.activatedRoom').length;

    walkTo(rt, a.guestId, AT.libraryAlcove, 100);

    assert.equal(rt.eventLog.filter((e) => e.type === 'guest.activatedRoom').length, before);
    assert.equal(roomOf(rt, 'library').lockHolder, a.guestId);
  });

  it('leaving clears the recorded entry outcome', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    walkTo(rt, a.guestId, AT.cellar);
    assert.equal(guestOf(rt, a.token).lastEntry.outcome, 'ineligible');
    walkTo(rt, a.guestId, AT.corridor, 800);
    assert.equal(guestOf(rt, a.token).lastEntry, null);
  });

  it('the lock transfers to a remaining guest the room is running for', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const b = spawnOnPath(rt, 'pathB');   // library is on both paths

    walkTo(rt, a.guestId, AT.library);
    rt.testAdvanceTime(50);
    walkTo(rt, b.guestId, AT.library);
    assert.equal(roomOf(rt, 'library').lockHolder, a.guestId);

    walkTo(rt, a.guestId, AT.corridor, 900);
    assert.equal(roomOf(rt, 'library').lockHolder, b.guestId);
    assert.match(roomOf(rt, 'library').state, /^active/);
    // And it stays theirs — no reset under the person still standing in it.
    rt.testAdvanceTime(30000);
    assert.match(roomOf(rt, 'library').state, /^active/);
  });

  it('the guest who inherits the room stops saying they were refused', () => {
    // Their record is written when they walk in; the transfer happens later, so
    // without a nudge the room names them as holder while their own row still
    // reads "refused (locked)".
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const b = spawnOnPath(rt, 'pathB');

    walkTo(rt, a.guestId, AT.library);
    rt.testAdvanceTime(50);
    walkTo(rt, b.guestId, AT.library);
    assert.equal(guestOf(rt, b.token).lastEntry.outcome, 'refused');

    walkTo(rt, a.guestId, AT.corridor, 900);

    assert.equal(roomOf(rt, 'library').lockHolder, b.guestId);
    assert.equal(guestOf(rt, b.token).lastEntry.outcome, 'inherited');
    assert.equal(guestOf(rt, b.token).lastEntry.roomId, 'library');
    // The room is running for them now, which is what this flag asks.
    assert.equal(guestOf(rt, b.token).visitHistory.library.activatedByMe, true);
    assert.ok(rt.eventLog.some((e) => e.type === 'guest.inheritedRoom' && e.guestId === b.guestId));
  });

  it('the departing holder is left with no stale entry of their own', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const b = spawnOnPath(rt, 'pathB');
    walkTo(rt, a.guestId, AT.library);
    rt.testAdvanceTime(50);
    walkTo(rt, b.guestId, AT.library);
    walkTo(rt, a.guestId, AT.corridor, 900);
    assert.equal(guestOf(rt, a.token).lastEntry, null);
  });

  it('the lock never transfers to a guest the room is not for', () => {
    // Someone standing in a room that is not theirs is physically present but
    // got its ineligible response and the room never changed for them. Handing
    // them the lock would make them owner of a room it is not playing to.
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathB');   // cellar is on pathB
    const b = spawnOnPath(rt, 'pathA');   // cellar is not

    walkTo(rt, a.guestId, AT.cellar);
    rt.testAdvanceTime(50);
    walkTo(rt, b.guestId, AT.cellar);
    assert.equal(roomOf(rt, 'cellar').lockHolder, a.guestId);
    assert.equal(roomOf(rt, 'cellar').occupantCount, 2);
    assert.deepEqual(roomOf(rt, 'cellar').eligibleOccupants, [a.guestId]);

    walkTo(rt, a.guestId, AT.corridor, 900);
    const cellar = roomOf(rt, 'cellar');
    assert.equal(cellar.lockHolder, null);
    assert.notEqual(cellar.lockHolder, b.guestId);
    // Running for nobody, so it takes its exit policy even though a body remains.
    assert.equal(cellar.state, 'settling');
    assert.equal(cellar.occupantCount, 1);
    assert.deepEqual(cellar.eligibleOccupants, []);
  });

  describe('a room freeing up with someone still inside', () => {
    /** Put a guest in a room, refused, then let the room end on its own. */
    function refusedInsideGreenhouse(rt, whenAvailable) {
      rt.def.rooms.greenhouse.whenAvailable = whenAvailable;
      const holder = spawnOnPath(rt, 'pathA');
      const waiting = spawnOnPath(rt, 'pathA');
      walkTo(rt, holder.guestId, AT.greenhouse);
      rt.testAdvanceTime(50);
      walkTo(rt, waiting.guestId, AT.greenhouse);
      assert.equal(guestOf(rt, waiting.token).lastEntry.outcome, 'refused');
      return { holder, waiting };
    }

    it('by default the room sits idle and nobody is offered it', () => {
      const rt = makeRuntime();
      const { waiting } = refusedInsideGreenhouse(rt, { policy: 'wait' });
      rt.testAdvanceTime(5000);    // content ends
      rt.testAdvanceTime(11000);   // grace expires
      assert.equal(roomOf(rt, 'greenhouse').state, 'idle');
      // Accurate, if unsatisfying — which is why this is a choice, not a default.
      assert.equal(guestOf(rt, waiting.token).lastEntry.outcome, 'refused');
      assert.equal(roomOf(rt, 'greenhouse').lockHolder, null);
    });

    it('with "activate" it plays again for whoever is still standing there', () => {
      const rt = makeRuntime();
      const { holder } = refusedInsideGreenhouse(rt, { policy: 'activate' });
      rt.testAdvanceTime(5000);
      rt.testAdvanceTime(11000);
      assert.match(roomOf(rt, 'greenhouse').state, /^active/);
      assert.equal(roomOf(rt, 'greenhouse').lockHolder, holder.guestId);
      assert.equal(guestOf(rt, holder.token).lastEntry.outcome, 'activated');
    });

    it('offers it to the longest-present occupant, as lock succession does', () => {
      // Everyone here is eligible and nobody left, so the room comes back to
      // whoever arrived first — the same ordering the lock transfer uses.
      const rt = makeRuntime();
      rt.def.rooms.greenhouse.whenAvailable = { policy: 'activate' };
      const first = spawnOnPath(rt, 'pathA');
      const second = spawnOnPath(rt, 'pathA');
      walkTo(rt, first.guestId, AT.greenhouse);
      rt.testAdvanceTime(50);
      walkTo(rt, second.guestId, AT.greenhouse);

      rt.testAdvanceTime(5000);
      rt.testAdvanceTime(11000);
      assert.equal(roomOf(rt, 'greenhouse').lockHolder, first.guestId);
      // The second guest is still an unsatisfied secondary occupant — that is
      // A5's multiGuest problem, not this one's.
      assert.equal(guestOf(rt, second.token).lastEntry.outcome, 'refused');
    });

    it('does not offer the room to an ineligible occupant', () => {
      const rt = makeRuntime();
      rt.def.rooms.cellar.whenAvailable = { policy: 'activate' };
      const owner = spawnOnPath(rt, 'pathB');    // cellar is on pathB
      const other = spawnOnPath(rt, 'pathA');    // cellar is not
      walkTo(rt, owner.guestId, AT.cellar);
      rt.testAdvanceTime(50);
      walkTo(rt, other.guestId, AT.cellar);
      walkTo(rt, owner.guestId, AT.corridor, 900);

      rt.testAdvanceTime(5000);
      assert.equal(roomOf(rt, 'cellar').lockHolder, null);
      assert.equal(guestOf(rt, other.token).lastEntry.outcome, 'ineligible');
    });

    it('activating from inside the state change does not re-enter or double-fire', () => {
      // The offer is made from the room's own state subscriber, so a re-entrant
      // send here would either loop or fire twice.
      const rt = makeRuntime();
      const { holder } = refusedInsideGreenhouse(rt, { policy: 'activate' });
      const before = rt.eventLog.filter((e) => e.type === 'room.activated' && e.roomId === 'greenhouse').length;
      rt.testAdvanceTime(5000);
      rt.testAdvanceTime(11000);
      const after = rt.eventLog.filter((e) => e.type === 'room.activated' && e.roomId === 'greenhouse');
      assert.equal(after.length - before, 1, 'exactly one replay');
      assert.equal(after.at(-1).guestId, holder.guestId);
    });

    it('keeps replaying while somebody stays, and stops when they go', () => {
      // A single occupant, so "somebody stays" and "they go" are unambiguous.
      const rt = makeRuntime();
      rt.def.rooms.greenhouse.whenAvailable = { policy: 'activate' };
      const alone = spawnOnPath(rt, 'pathA');
      walkTo(rt, alone.guestId, AT.greenhouse);
      assert.equal(guestOf(rt, alone.token).lastEntry.outcome, 'activated');

      for (let i = 0; i < 3; i++) rt.testAdvanceTime(16000);   // content + grace
      const replays = rt.eventLog.filter(
        (e) => e.type === 'room.activated' && e.roomId === 'greenhouse',
      ).length;
      assert.ok(replays >= 3, `expected repeated replays, got ${replays}`);

      walkTo(rt, alone.guestId, AT.corridor, 900);
      const quiet = rt.eventLog.filter(
        (e) => e.type === 'room.activated' && e.roomId === 'greenhouse',
      ).length;
      rt.testAdvanceTime(60000);
      const settled = roomOf(rt, 'greenhouse');
      assert.equal(settled.lockHolder, null);
      assert.equal(settled.eligibleOccupants.length, 0);
      // And it genuinely stops — an empty room must not replay to nobody.
      assert.equal(
        rt.eventLog.filter((e) => e.type === 'room.activated' && e.roomId === 'greenhouse').length,
        quiet,
      );
    });
  });

  it('the guest who left resumes; a different guest activates fresh', () => {
    // Both interrupt the settle — nobody waits out a timer they cannot see —
    // but they get there by different routes. RESUME hands the room back to
    // whoever stepped out; anyone else gets a normal activation, because they
    // have seen none of it.
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const b = spawnOnPath(rt, 'pathB');

    walkTo(rt, a.guestId, AT.library);
    rt.testAdvanceTime(1200);
    walkTo(rt, a.guestId, AT.corridor, 800);
    assert.equal(roomOf(rt, 'library').state, 'settling');

    walkTo(rt, b.guestId, AT.library);
    assert.equal(roomOf(rt, 'library').state, 'active.main');
    assert.equal(roomOf(rt, 'library').lockHolder, b.guestId);
    const activated = rt.eventLog.filter((e) => e.type === 'room.activated').at(-1);
    assert.equal(activated.guestId, b.guestId);
    assert.equal(activated.interruptedSettling, true);
    // Not a resume — no RESUME was involved.
    assert.ok(!rt.eventLog.some((e) => e.type === 'room.resumed'));
  });

  it('the previous holder returning resumes rather than restarting', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');

    walkTo(rt, a.guestId, AT.library);
    rt.testAdvanceTime(1200);
    walkTo(rt, a.guestId, AT.corridor, 800);
    assert.equal(roomOf(rt, 'library').state, 'settling');

    walkTo(rt, a.guestId, AT.library);
    assert.match(roomOf(rt, 'library').state, /^active/);
    assert.equal(roomOf(rt, 'library').lockHolder, a.guestId);
    assert.ok(rt.eventLog.some((e) => e.type === 'room.resumed'));
  });

  it('an arrival during grace cancels the reset', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    const b = spawnOnPath(rt, 'pathB');

    walkTo(rt, a.guestId, AT.library);
    rt.testAdvanceTime(1200);
    walkTo(rt, a.guestId, AT.corridor, 800);
    assert.equal(roomOf(rt, 'library').resetInMs, 10000);

    walkTo(rt, b.guestId, AT.library);
    assert.equal(roomOf(rt, 'library').resetInMs, null);
    // The cancelled timer must not fire later and reset an occupied room.
    rt.testAdvanceTime(30000);
    assert.match(roomOf(rt, 'library').state, /^active/);
  });

  it('a room whose settling declares no activation still refuses, without stranding a lock', () => {
    const rt = makeRuntime();
    // Strip the interrupt transition back out of the greenhouse.
    rt.def.rooms.greenhouse.machine.states.settling = { on: { RESET: 'idle' } };
    rt.rooms.get('greenhouse').def = rt.def.rooms.greenhouse;
    rt.rooms.get('greenhouse').start();

    const a = spawnOnPath(rt, 'pathA');
    rt.sendRoomEvent('greenhouse', 'ACTIVATE');
    rt.sendRoomEvent('greenhouse', 'RELEASE');
    assert.equal(roomOf(rt, 'greenhouse').state, 'settling');

    walkTo(rt, a.guestId, AT.greenhouse);
    assert.equal(roomOf(rt, 'greenhouse').state, 'settling');
    assert.equal(roomOf(rt, 'greenhouse').lockHolder, null);
    assert.equal(guestOf(rt, a.token).lastEntry.outcome, 'refused');
  });

  it('the operator roster shows eligibility and the last decision', () => {
    const rt = makeRuntime();
    const a = spawnOnPath(rt, 'pathA');
    walkTo(rt, a.guestId, AT.cellar);

    const snap = rt.getOperatorSnapshot().guests.find((g) => g.guestId === a.guestId);
    assert.deepEqual(snap.eligibleRooms.sort(), ['greenhouse', 'library']);
    assert.equal(snap.lastEntry.outcome, 'ineligible');
    assert.equal(snap.lastEntry.policy, 'lockedMessage');
  });
});
