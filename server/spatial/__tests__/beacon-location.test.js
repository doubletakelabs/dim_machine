/**
 * The Android app locating a phone (dim_android_app): it sends the major of the
 * strongest room group it hears, and of a door beacon it is at. The phone
 * smooths and holds, so the server commits at once.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** MAD-DIM with a known beacon list, whatever the install currently says. */
function show() {
  const def = JSON.parse(readFileSync(join(root, 'shows/MAD-DIM.json'), 'utf8'));
  def.rooms.influence.thresholds = {
    'influence-front': {},
  };
  def.beacons = {
    901: { at: [10, 10], room: 'museumHallway', rssi: -70 },
    902: { at: [20, 20], room: 'kin', rssi: -70 },
    903: { at: [30, 30], room: 'kin', rssi: -70 },
    904: { at: [60, 60], room: 'hallOfHeroes', rssi: -70 },
    905: { at: [70, 70], room: 'cyclorama', rssi: -70 },
    931: { at: [40, 40], door: 'influence-front', rssi: -70 },
    999: { at: [50, 50], rssi: -70 },
  };
  return def;
}

function running() {
  const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock(), assetSeconds: () => 3 });
  assert.deepEqual(rt.load(show()).errors, []);
  rt.start();
  const g = rt.spawnGuest();
  return { rt, guestId: g.guestId };
}

const roomOf = (rt, guestId) => rt.guests.get(guestId).roomId;

describe('locating a phone by beacon', () => {
  it('a room beacon places the guest at once — no entry hold', () => {
    const { rt, guestId } = running();
    assert.deepEqual(rt.setGuestBeacon(guestId, 902), { ok: true, roomId: 'kin' });
    assert.equal(roomOf(rt, guestId), 'kin', 'committed without advancing the clock');
    assert.equal(rt.rooms.get('kin').state, 'active', 'and the room reacts as to any entry');
  });

  it('beacons in one group are one room; a move between rooms is one step', () => {
    const { rt, guestId } = running();
    rt.setGuestBeacon(guestId, 902);
    rt.setGuestBeacon(guestId, 903);
    assert.equal(roomOf(rt, guestId), 'kin');
    rt.setGuestBeacon(guestId, 901);
    assert.equal(roomOf(rt, guestId), 'museumHallway');
    assert.equal(rt.rooms.get('kin').state, 'idle', 'leaving ended it');
  });

  it('a door, unassigned or unknown major places nobody', () => {
    const { rt, guestId } = running();
    rt.setGuestBeacon(guestId, 901);
    for (const major of [931, 999, 12345]) {
      assert.equal(rt.setGuestBeacon(guestId, major).ok, false);
      assert.equal(roomOf(rt, guestId), 'museumHallway', `major ${major} moved nobody`);
    }
  });

  it('a door beacon marks the door, and null leaves it', () => {
    const { rt, guestId } = running();
    rt.setGuestBeacon(guestId, 901);
    assert.equal(rt.setGuestDoorBeacon(guestId, 931), true);
    assert.equal(rt.atThreshold.get(guestId)?.thresholdId, 'influence-front');
    assert.equal(roomOf(rt, guestId), 'museumHallway', 'not in until the door has been heard for the dwell');
    assert.equal(rt.setGuestDoorBeacon(guestId, null), true);
    assert.equal(rt.atThreshold.has(guestId), false);
    assert.equal(rt.setGuestDoorBeacon(guestId, 902), false, 'a room beacon is not a door');
  });

  it('a quiet phone keeps its room while contact is kept; silence past the hold drops it', () => {
    const { rt, guestId } = running();
    rt.setGuestBeacon(guestId, 902);
    // The phone reports only on change; its socket's pings are the contact.
    for (let i = 0; i < 5; i++) {
      rt.testAdvanceTime(4000);
      rt.coordinator.touchLocation(guestId);
    }
    assert.equal(roomOf(rt, guestId), 'kin', '20s standing still, still in kin');
    rt.testAdvanceTime(6000);
    assert.equal(roomOf(rt, guestId), null, 'no contact past contactLossMs — outside');
  });
});

describe('unlikely jumps between beacons', () => {
  // MAD-DIM's connections: Hall of Heroes – Cyclorama – Museum Hallway – Kin.
  it('next door moves at once', () => {
    const { rt, guestId } = running();
    rt.setGuestBeacon(guestId, 904);
    assert.equal(rt.setGuestBeacon(guestId, 905).heldMs, undefined);
    assert.equal(roomOf(rt, guestId), 'cyclorama');
  });

  it('one space skipped is held briefly, then believed', () => {
    const { rt, guestId } = running();
    rt.setGuestBeacon(guestId, 904);
    assert.equal(rt.setGuestBeacon(guestId, 901).heldMs, 1500, 'hall of heroes → museum hallway skips cyclorama');
    assert.equal(roomOf(rt, guestId), 'hallOfHeroes');
    rt.testAdvanceTime(1600);
    assert.equal(roomOf(rt, guestId), 'museumHallway');
  });

  it('further is held longer, and a flicker the phone takes back never lands', () => {
    const { rt, guestId } = running();
    rt.setGuestBeacon(guestId, 904);
    assert.equal(rt.setGuestBeacon(guestId, 902).heldMs, 5000, 'hall of heroes → kin, three steps');
    rt.testAdvanceTime(2000);
    rt.setGuestBeacon(guestId, 904); // back again: it was a misread
    for (let i = 0; i < 3; i++) { rt.testAdvanceTime(2000); rt.coordinator.touchLocation(guestId); } // the page's pings
    assert.equal(roomOf(rt, guestId), 'hallOfHeroes');
    assert.equal(rt.rooms.get('kin').state, 'idle', 'kin never woke for a misread');
    const logged = rt.eventLog.filter((e) => e.type === 'guest.unlikelyJump');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].steps, 3);
  });

  it('a real far move lands after the hold; saying it again does not restart it', () => {
    const { rt, guestId } = running();
    rt.setGuestBeacon(guestId, 904);
    rt.setGuestBeacon(guestId, 902);
    rt.testAdvanceTime(3000);
    rt.setGuestBeacon(guestId, 903); // kin again, another beacon of the same room
    rt.testAdvanceTime(2100);
    assert.equal(roomOf(rt, guestId), 'kin', 'five seconds from the first report');
  });

  it('coming back from nowhere is believed at once', () => {
    const { rt, guestId } = running();
    assert.equal(rt.setGuestBeacon(guestId, 902).heldMs, undefined, 'first fix');
    assert.equal(roomOf(rt, guestId), 'kin');
  });

  it('the holds are show settings', () => {
    const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock(), assetSeconds: () => 3 });
    const def = show();
    def.location = { ...(def.location ?? {}), jumpTwoStepsMs: 0, jumpFartherMs: 800 };
    assert.deepEqual(rt.load(def).errors, []);
    rt.start();
    const g = rt.spawnGuest();
    rt.setGuestBeacon(g.guestId, 904);
    assert.equal(rt.setGuestBeacon(g.guestId, 901).heldMs, undefined, 'two steps: no hold');
    assert.equal(rt.setGuestBeacon(g.guestId, 904).heldMs, undefined, 'and back, two steps');
    assert.equal(rt.setGuestBeacon(g.guestId, 902).heldMs, 800);
    const bad = show();
    bad.location = { jumpFartherMs: -1 };
    assert.match(rt.load(bad).errors.join('\n'), /location\.jumpFartherMs must be a non-negative number/);
  });
});
