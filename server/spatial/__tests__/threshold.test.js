import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { validateShowDefinition } from '../validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = () => JSON.parse(readFileSync(join(root, 'fixtures/small-show.json'), 'utf8'));

/** The small fixture with a doorway into the greenhouse (§4.2c). */
function showWithDoor() {
  const def = fixture();
  def.rooms.greenhouse.thresholds = { 'greenhouse-door': {} };
  // Beacons live in the top-level map, keyed by their major.
  def.beacons = {
    14: { at: [320, 235], room: 'hallway' },
    15: { at: [520, 205], room: 'greenhouse' },
    31: { at: [440, 205], door: 'greenhouse-door', rssi: -60 },
  };
  return def;
}

const HALLWAY = 14;
const GREENHOUSE = 15;
const DOOR = 31;

function running(mutate = () => {}) {
  const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock() });
  const def = showWithDoor();
  mutate(def);
  assert.equal(rt.load(def).ok, true);
  rt.start();
  const g = rt.spawnGuest();
  // A phone in the hallway, where the door is.
  rt.setGuestBeacon(g.guestId, HALLWAY);
  rt.testAdvanceTime(100);
  assert.equal(rt.guests.get(g.guestId).roomId, 'hallway');
  return { rt, guestId: g.guestId };
}

const roomOf = (rt, guestId) => rt.guests.get(guestId).roomId;

describe('thresholds', () => {
  it('three seconds at a door is entering its room', () => {
    const { rt, guestId } = running();
    assert.equal(rt.setGuestDoorBeacon(guestId, DOOR), true);
    rt.testAdvanceTime(2900);
    assert.equal(roomOf(rt, guestId), 'hallway', 'not yet');
    rt.testAdvanceTime(200);
    assert.equal(roomOf(rt, guestId), 'greenhouse');
    assert.ok(rt.eventLog.some((e) => e.type === 'guest.doorEntered' && e.roomId === 'greenhouse'));
  });

  it('walking past a door does nothing', () => {
    const { rt, guestId } = running();
    const before = [...rt.desiredCues(guestId).entries()].map(([k, v]) => [k, v?.assetId ?? null]);
    rt.setGuestDoorBeacon(guestId, DOOR);
    rt.testAdvanceTime(2000);
    // A door plays nothing of its own.
    assert.deepEqual([...rt.desiredCues(guestId).entries()].map(([k, v]) => [k, v?.assetId ?? null]), before);
    rt.setGuestDoorBeacon(guestId, null);
    rt.testAdvanceTime(2000);
    assert.equal(roomOf(rt, guestId), 'hallway');
    assert.equal(rt.guests.get(guestId).visitHistory.greenhouse, undefined);
  });

  it('a door heard again starts the three seconds over', () => {
    const { rt, guestId } = running();
    rt.setGuestDoorBeacon(guestId, DOOR);
    rt.testAdvanceTime(2000);
    rt.setGuestDoorBeacon(guestId, null);
    rt.setGuestDoorBeacon(guestId, DOOR);
    rt.testAdvanceTime(2000);
    assert.equal(roomOf(rt, guestId), 'hallway');
    rt.testAdvanceTime(1100);
    assert.equal(roomOf(rt, guestId), 'greenhouse');
  });

  it('the door holds them in its room while it is heard', () => {
    const { rt, guestId } = running();
    rt.setGuestDoorBeacon(guestId, DOOR);
    rt.testAdvanceTime(3100);
    // Standing in the doorway, the hallway's beacon is the strongest room.
    const r = rt.setGuestBeacon(guestId, HALLWAY);
    assert.equal(r.heldByDoor, 'greenhouse-door');
    rt.testAdvanceTime(2000);
    assert.equal(roomOf(rt, guestId), 'greenhouse');
  });

  it('when the door goes, the latest room reading says where they are', () => {
    const { rt, guestId } = running();
    rt.setGuestDoorBeacon(guestId, DOOR);
    rt.testAdvanceTime(3100);
    rt.setGuestBeacon(guestId, HALLWAY);
    rt.setGuestDoorBeacon(guestId, null);
    rt.testAdvanceTime(100);
    assert.equal(roomOf(rt, guestId), 'hallway', 'backed out');

    rt.setGuestDoorBeacon(guestId, DOOR);
    rt.testAdvanceTime(3100);
    rt.setGuestBeacon(guestId, GREENHOUSE);
    rt.setGuestDoorBeacon(guestId, null);
    rt.testAdvanceTime(100);
    assert.equal(roomOf(rt, guestId), 'greenhouse', 'walked on in');
  });

  it('the dwell is a show setting', () => {
    const { rt, guestId } = running((d) => { d.location = { ...(d.location ?? {}), doorDwellMs: 0 }; });
    rt.setGuestDoorBeacon(guestId, DOOR);
    rt.testAdvanceTime(100);
    assert.equal(roomOf(rt, guestId), 'greenhouse');
  });

  it('refuses an unknown threshold, and shows known ones to the panel', () => {
    const { rt, guestId } = running();
    assert.equal(rt.setGuestThreshold(guestId, 'no-such-door'), false);
    assert.deepEqual(rt.rosterInfo().thresholds,
      [{ thresholdId: 'greenhouse-door', roomId: 'greenhouse', roomName: rt.rooms.get('greenhouse').name }]);
    rt.setGuestThreshold(guestId, 'greenhouse-door');
    assert.equal(rt.getGuestsRoster().find((g) => g.guestId === guestId).threshold, 'greenhouse-door');
  });

  it('leaving the show clears it', () => {
    const { rt, guestId } = running();
    rt.setGuestThreshold(guestId, 'greenhouse-door');
    rt.removeGuest(guestId);
    assert.equal(rt.atThreshold.size, 0);
    assert.equal(rt.lastRoomBeacon.size, 0);
  });
});

describe('BLE and threshold validation', () => {
  const errorsFor = (mutate) => {
    const def = showWithDoor();
    mutate(def);
    return validateShowDefinition(def).errors.join('\n');
  };
  const warningsFor = (mutate) => {
    const def = showWithDoor();
    mutate(def);
    return validateShowDefinition(def).warnings.join('\n');
  };

  it('accepts a door and its beacon as authored', () => {
    assert.deepEqual(validateShowDefinition(showWithDoor()).errors, []);
    assert.deepEqual(validateShowDefinition(showWithDoor()).warnings, []);
  });

  it('puts BLE on the beacons map, not rooms', () => {
    assert.match(errorsFor((d) => { d.rooms.greenhouse.ble = { beacons: ['b-14'] }; }),
      /rooms\.greenhouse\.ble — beacons live in the top-level beacons map/);
  });

  it('says the retired zone and door beacon fields do nothing', () => {
    const w = warningsFor((d) => {
      d.rooms.greenhouse.zones.greenhouse.ble = { beacons: ['14'] };
      d.rooms.greenhouse.thresholds['greenhouse-door'].beacons = ['31'];
    });
    assert.match(w, /zones\.greenhouse\.ble is no longer used/);
    assert.match(w, /greenhouse-door\.beacons is no longer used/);
  });

  it('checks beacons: major keys, a real room or door, not both', () => {
    assert.match(errorsFor((d) => { d.beacons['b-3'] = { at: [1, 1], room: 'cellar' }; }), /keyed by its major number/);
    assert.match(errorsFor((d) => { d.beacons[40] = { at: [1, 1], room: 'nowhere' }; }), /beacons\.40\.room names "nowhere"/);
    assert.match(errorsFor((d) => { d.beacons[41] = { at: [1, 1], door: 'no-door' }; }), /beacons\.41\.door names "no-door"/);
    assert.match(errorsFor((d) => { d.beacons[42] = { at: [1, 1], room: 'cellar', door: 'greenhouse-door' }; }), /not both/);
    assert.match(errorsFor((d) => { d.beacons[43] = { at: [1, 1], room: 'cellar', rssi: 60 }; }), /rssi must be a negative number/);
  });

  it('says door clips are retired, and refuses duplicate door ids', () => {
    assert.match(warningsFor((d) => {
      d.rooms.greenhouse.thresholds['greenhouse-door'].cues = { guidance: { audio: 'chime.wav' } };
    }), /greenhouse-door\.cues is no longer used — a door plays nothing/);
    assert.match(errorsFor((d) => {
      d.rooms.cellar.thresholds = { 'greenhouse-door': {} };
    }), /duplicates a threshold id in rooms\.greenhouse/);
  });

  it('warns about a door no beacon is at', () => {
    const w = warningsFor((d) => { d.rooms.cellar.thresholds = { 'cellar-door': {} }; });
    assert.match(w, /cellar-door: no beacon in beacons is at this door yet/);
  });
});
