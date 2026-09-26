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
  def.rooms.greenhouse.thresholds = {
    'greenhouse-door': {
      cues: {
        guidance: { audio: 'whisper.wav' },
        room: { audio: 'ambient.wav', loop: true },
      },
    },
  };
  // The door's beacon lives in the top-level map, keyed by its major.
  def.beacons = { 31: { at: [440, 205], door: 'greenhouse-door', rssi: -60 } };
  return def;
}

function running() {
  const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock() });
  assert.equal(rt.load(showWithDoor()).ok, true);
  rt.start();
  const g = rt.spawnGuest();
  // Into the hallway, where the door is.
  rt.setVirtualPosition(g.guestId, 320, 235);
  rt.testAdvanceTime(1700);
  assert.equal(rt.guests.get(g.guestId).roomId, 'hallway');
  return { rt, guestId: g.guestId };
}

const heard = (rt, guestId) => {
  const desired = rt.desiredCues(guestId);
  return { guidance: desired.get('guidance')?.assetId ?? null, room: desired.get('room')?.assetId ?? null };
};

describe('thresholds', () => {
  it('a guest at a door hears its clips, and is still in the hallway', () => {
    const { rt, guestId } = running();
    const before = heard(rt, guestId);
    assert.equal(rt.setGuestThreshold(guestId, 'greenhouse-door'), true);
    assert.deepEqual(heard(rt, guestId), { guidance: 'whisper.wav', room: 'ambient.wav' });

    // Nothing entered: no occupancy change, no activation, no visit counted.
    rt.testAdvanceTime(5000);
    assert.equal(rt.guests.get(guestId).roomId, 'hallway');
    assert.equal(rt.rooms.get('greenhouse').state, 'idle');
    assert.equal(rt.guests.get(guestId).visitHistory.greenhouse, undefined);

    assert.equal(rt.setGuestThreshold(guestId, null), true);
    assert.deepEqual(heard(rt, guestId), before);
  });

  it('every approach restarts the clip; standing still does not', () => {
    const { rt, guestId } = running();
    rt.setGuestThreshold(guestId, 'greenhouse-door');
    const first = rt.desiredCues(guestId).get('guidance').startAt;

    rt.testAdvanceTime(2000);
    rt.setGuestThreshold(guestId, 'greenhouse-door');
    assert.equal(rt.desiredCues(guestId).get('guidance').startAt, first, 'still there — no restart');

    rt.setGuestThreshold(guestId, null);
    rt.testAdvanceTime(2000);
    rt.setGuestThreshold(guestId, 'greenhouse-door');
    assert.ok(rt.desiredCues(guestId).get('guidance').startAt > first, 'a new approach starts from the top');
  });

  it('walking into the room puts the door behind them', () => {
    const { rt, guestId } = running();
    rt.setGuestThreshold(guestId, 'greenhouse-door');
    rt.setVirtualOccupancy(guestId, 'greenhouse', 'inside');
    rt.testAdvanceTime(5000);
    assert.equal(rt.guests.get(guestId).roomId, 'greenhouse');
    assert.equal(rt.atThreshold.has(guestId), false);
    assert.notEqual(heard(rt, guestId).guidance, 'whisper.wav');
    assert.equal(rt.getGuestsRoster().find((g) => g.guestId === guestId).threshold, null);
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

  it('checks slots and duplicate door ids', () => {
    assert.match(errorsFor((d) => {
      d.rooms.greenhouse.thresholds['greenhouse-door'].cues.adherence = { audio: 'click.wav' };
    }), /cues\.adherence: a threshold plays on guidance or room/);
    assert.match(errorsFor((d) => {
      d.rooms.cellar.thresholds = { 'greenhouse-door': { cues: { guidance: { audio: 'chime.wav' } } } };
    }), /duplicates a threshold id in rooms\.greenhouse/);
  });

  it('warns about a door no beacon is at, or that does nothing', () => {
    const w = warningsFor((d) => { d.rooms.cellar.thresholds = { 'cellar-door': {} }; });
    assert.match(w, /cellar-door: no beacon in beacons is at this door yet/);
    assert.match(w, /cellar-door declares no cues/);
  });
});
