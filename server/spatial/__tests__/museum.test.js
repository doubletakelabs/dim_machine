/**
 * The museum layer, integrated: real coordinator, real rooms, real cues.
 *
 * The rules were prototyped in /sim/ and are implemented in museum.js; these
 * tests drive them through the actual runtime — entry confirmation and all —
 * because the sim proved the rules and this proves the wiring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { roomCentroid } from '../zone-math.js';
import { validateShowDefinition } from '../validate.js';
import { applyInstallation } from '../installation.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const museum = JSON.parse(readFileSync(join(root, 'shows/MAD-DIM.json'), 'utf8'));

const ENTRANCE_SECONDS = 3;

function makeRuntime() {
  const rt = new SpatialRuntime({
    enableTick: false,
    clock: new ManualClock(),
    // The entrance clip is three seconds long as far as scheduling cares.
    assetSeconds: () => ENTRANCE_SECONDS,
  });
  assert.deepEqual(rt.load(museum).errors, []);
  rt.start();
  return rt;
}

function walk(rt, guestId, roomId, ms = 3000) {
  const [x, y] = roomCentroid(museum.rooms[roomId]);
  rt.setVirtualPosition(guestId, x, y);
  rt.testAdvanceTime(ms);
}

/** Straight to the museum hallway — the prologue is not under test here. */
function arrive(rt) {
  const g = rt.spawnGuest();
  walk(rt, g.guestId, 'museumHallway');
  return g;
}

const roomState = (rt, roomId) => String(rt.rooms.get(roomId).state).split('.')[0];
const voice = (rt, guestId) => rt.desiredCues(guestId).get('guidance')?.assetId ?? null;
const bed = (rt, guestId) => rt.desiredCues(guestId).get('room');
const snap = (rt, guestId) => rt.museum.snapshot(guestId);

describe('choosing a room', () => {
  it('walking in engages it: room active, slot burned, entrance speaking', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    walk(rt, g.guestId, 'kin');
    assert.equal(roomState(rt, 'kin'), 'active');
    assert.equal(snap(rt, g.guestId).seen, 1);
    assert.equal(voice(rt, g.guestId), 'audio/museum/entrance.wav');
  });

  it('schedules the in_room bed to start exactly when the entrance clip ends', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    const before = rt.now();
    walk(rt, g.guestId, 'kin');
    const cue = bed(rt, g.guestId);
    assert.equal(cue.assetId, 'audio/museum/in_room.wav');
    assert.equal(cue.loop, true);
    const engagedAt = rt.museum.guests.get(g.guestId).engagedAt;
    assert.ok(engagedAt >= before, 'engaged after the walk began');
    assert.equal(cue.startAt, engagedAt + ENTRANCE_SECONDS * 1000);
  });

  it('the room completes on its own, and the guest hears it', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    walk(rt, g.guestId, 'kin');
    rt.testAdvanceTime(46000); // the placeholder room runs 45s
    assert.equal(roomState(rt, 'kin'), 'idle');
    assert.equal(snap(rt, g.guestId).rooms.kin, 'completed');
    assert.equal(voice(rt, g.guestId), 'audio/museum/complete.wav');
    assert.equal(bed(rt, g.guestId), null, 'the bed dies with the room');
  });

  it('stepping out afterwards is in_hallway, the track for one room done', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    walk(rt, g.guestId, 'kin');
    rt.testAdvanceTime(46000);
    walk(rt, g.guestId, 'museumHallway');
    assert.equal(voice(rt, g.guestId), 'audio/museum/in_hallway_1.wav');
  });

  it('the second room speaks the second hallway track', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    for (const roomId of ['kin', 'slop']) {
      walk(rt, g.guestId, roomId);
      rt.testAdvanceTime(46000);
      walk(rt, g.guestId, 'museumHallway');
    }
    assert.equal(voice(rt, g.guestId), 'audio/museum/in_hallway_2.wav');
    assert.equal(snap(rt, g.guestId).seen, 2);
  });
});

describe('abandonment', () => {
  it('keeps the slot, stands the room down, and the hallway still speaks', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    walk(rt, g.guestId, 'faerie');
    assert.equal(roomState(rt, 'faerie'), 'active');
    walk(rt, g.guestId, 'museumHallway'); // out before the room finishes
    assert.equal(roomState(rt, 'faerie'), 'idle', 'a room must not run for nobody');
    assert.equal(snap(rt, g.guestId).seen, 1, 'the slot does not come back');
    assert.equal(snap(rt, g.guestId).rooms.faerie, 'visited', 'not completed');
    assert.equal(voice(rt, g.guestId), 'audio/museum/in_hallway_1.wav');
  });

  it('a return to an abandoned room is a dead room with the return clip', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    walk(rt, g.guestId, 'faerie');
    walk(rt, g.guestId, 'museumHallway');
    walk(rt, g.guestId, 'faerie');
    assert.equal(voice(rt, g.guestId), 'audio/museum/return_visited.wav');
    assert.equal(roomState(rt, 'faerie'), 'idle', 'no resume — it does not wake');
    assert.equal(snap(rt, g.guestId).seen, 1);
  });
});

describe('the four', () => {
  function spend(rt, g, rooms) {
    for (const roomId of rooms) {
      walk(rt, g.guestId, roomId);
      rt.testAdvanceTime(46000);
      walk(rt, g.guestId, 'museumHallway');
    }
  }

  it('a fifth room will not run — no state once, then return, no state', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    spend(rt, g, ['automation', 'saas', 'slop', 'kin']);
    walk(rt, g.guestId, 'faerie');
    assert.equal(roomState(rt, 'faerie'), 'idle', 'the room does not wake');
    assert.equal(voice(rt, g.guestId), 'audio/museum/in_room_disabled.wav');
    walk(rt, g.guestId, 'museumHallway');
    assert.equal(voice(rt, g.guestId), 'audio/museum/in_hallway_4.wav', 'the count is unchanged');
    walk(rt, g.guestId, 'faerie');
    assert.equal(voice(rt, g.guestId), 'audio/museum/return_disabled.wav');
  });

  it('a completed room greets a return with return_visited', () => {
    const rt = makeRuntime();
    const g = arrive(rt);
    spend(rt, g, ['automation']);
    walk(rt, g.guestId, 'automation');
    assert.equal(voice(rt, g.guestId), 'audio/museum/return_visited.wav');
    assert.equal(snap(rt, g.guestId).seen, 1);
  });
});

describe('two guests, one room', () => {
  it('a joiner gets their own entrance, and the shared complete', () => {
    const rt = makeRuntime();
    const a = arrive(rt);
    walk(rt, a.guestId, 'kin');
    rt.testAdvanceTime(10000); // a is mid-experience
    const b = arrive(rt);
    walk(rt, b.guestId, 'kin');
    assert.equal(voice(rt, b.guestId), 'audio/museum/entrance.wav', 'their own welcome');
    assert.equal(snap(rt, b.guestId).seen, 1, 'their own slot burns');
    assert.equal(roomState(rt, 'kin'), 'active', 'one room, running once');

    rt.testAdvanceTime(46000); // the room finishes for everyone at once
    assert.equal(snap(rt, a.guestId).rooms.kin, 'completed');
    assert.equal(snap(rt, b.guestId).rooms.kin, 'completed');
    assert.equal(voice(rt, a.guestId), 'audio/museum/complete.wav');
    assert.equal(voice(rt, b.guestId), 'audio/museum/complete.wav');
  });

  it('one guest leaving does not stand the room down under the other', () => {
    const rt = makeRuntime();
    const a = arrive(rt);
    const b = arrive(rt);
    walk(rt, a.guestId, 'kin');
    walk(rt, b.guestId, 'kin');
    walk(rt, a.guestId, 'museumHallway'); // a abandons
    assert.equal(roomState(rt, 'kin'), 'active', 'b is still inside their room');
    assert.equal(snap(rt, a.guestId).rooms.kin, 'visited');
    rt.testAdvanceTime(46000);
    assert.equal(snap(rt, b.guestId).rooms.kin, 'completed', 'b finishes alone');
    assert.equal(snap(rt, a.guestId).rooms.kin, 'visited', 'a does not — they left');
  });
});

describe('full rooms', () => {
  it('refused by capacity: nothing burns, nothing is remembered, exit is silent', () => {
    const rt = makeRuntime();
    // kin holds six (multiGuest.maxOccupants); fill it.
    const inside = Array.from({ length: 6 }, () => arrive(rt));
    for (const g of inside) walk(rt, g.guestId, 'kin');
    const late = arrive(rt);
    const voiceBefore = voice(rt, late.guestId);
    walk(rt, late.guestId, 'kin');
    assert.equal(snap(rt, late.guestId).seen, 0);
    assert.equal(snap(rt, late.guestId).rooms.kin, undefined);
    assert.equal(voice(rt, late.guestId), voiceBefore, 'the room says nothing to them');
    walk(rt, late.guestId, 'museumHallway');
    assert.equal(voice(rt, late.guestId), voiceBefore, 'and neither does the hallway');
  });
});

describe('the museum block validates', () => {
  it('refuses a room the show does not have', () => {
    const def = structuredClone(museum);
    def.museum.rooms.push('giftShop');
    assert.match(validateShowDefinition(def).errors.join('\n'), /giftShop/);
  });

  it('warns when a stem is silent', () => {
    const def = structuredClone(museum);
    delete def.museum.stems.complete;
    assert.match(validateShowDefinition(def).warnings.join('\n'), /museum\.stems\.complete/);
  });
});

describe('a room completed by its own software', () => {
  // Influence has no timer: its room server is the experience, and the
  // experience says when the run is over. This is the whole chain — the
  // broker `complete` message in, the room home, everyone engaged completed.
  it('the experience complete signal completes everyone engaged', () => {
    const sockets = [];
    const open = (url) => {
      const handlers = {};
      const socket = {
        url,
        on: (event, fn) => { handlers[event] = fn; },
        send: () => {},
        close: () => {},
        accept: () => handlers.open?.(),
        reply: (m) => handlers.message?.(JSON.stringify(m)),
      };
      sockets.push(socket);
      return socket;
    };
    const rt = new SpatialRuntime({
      enableTick: false,
      clock: new ManualClock(),
      assetSeconds: () => ENTRANCE_SECONDS,
      openExperienceSocket: open,
    });
    const installed = applyInstallation(structuredClone(museum), {
      installation: 'test',
      experiences: { influence: 'ws://room.test:8080' },
    }).def;
    assert.deepEqual(rt.load(installed).errors, []);
    rt.start();
    sockets[0].accept();

    const a = arrive(rt);
    const b = arrive(rt);
    walk(rt, a.guestId, 'influence');
    walk(rt, b.guestId, 'influence');
    assert.equal(roomState(rt, 'influence'), 'active');

    sockets[0].reply({ t: 'complete' });
    assert.equal(roomState(rt, 'influence'), 'idle', 'the room came home');
    for (const g of [a, b]) {
      assert.equal(snap(rt, g.guestId).rooms.influence, 'completed');
      assert.equal(voice(rt, g.guestId), 'audio/museum/complete.wav');
    }
  });
});

describe('a room with its own clips', () => {
  // museum.roomStems: a room's own take on any shared stem; everything it does
  // not declare falls back to museum.stems.
  function withOwnClips() {
    const def = JSON.parse(JSON.stringify(museum));
    def.museum.roomStems = { kin: { entrance: 'whisper.wav', inRoom: 'ambient.wav', returnVisited: 'click.wav' } };
    const rt = new SpatialRuntime({ enableTick: false, clock: new ManualClock(), assetSeconds: () => ENTRANCE_SECONDS });
    assert.deepEqual(rt.load(def).errors, []);
    rt.start();
    return rt;
  }

  it('plays its own entrance, bed and return; other rooms keep the shared ones', () => {
    const rt = withOwnClips();
    const g = arrive(rt);
    walk(rt, g.guestId, 'kin');
    assert.equal(voice(rt, g.guestId), 'whisper.wav');
    assert.equal(bed(rt, g.guestId).assetId, 'ambient.wav');

    walk(rt, g.guestId, 'museumHallway');
    walk(rt, g.guestId, 'faerie');
    assert.equal(voice(rt, g.guestId), 'audio/museum/entrance.wav', 'faerie has none of its own');
    assert.equal(bed(rt, g.guestId).assetId, 'audio/museum/in_room.wav');

    walk(rt, g.guestId, 'museumHallway');
    walk(rt, g.guestId, 'kin');
    assert.equal(voice(rt, g.guestId), 'click.wav', 'its own return');
  });

  it('validates what a room can override', () => {
    const errorsFor = (roomStems) => {
      const def = JSON.parse(JSON.stringify(museum));
      def.museum.roomStems = roomStems;
      return validateShowDefinition(def).errors.join('\n');
    };
    assert.match(errorsFor({ kin: { inHallway: 'x.wav' } }), /roomStems\.kin\.inHallway is not a room stem/);
    assert.match(errorsFor({ library: { entrance: 'x.wav' } }), /"library" is not one of museum\.rooms/);
    assert.match(errorsFor({ kin: { entrance: 7 } }), /roomStems\.kin\.entrance must be an asset name/);
    assert.equal(errorsFor({ kin: { complete: 'chime.wav' } }), '');
  });
});
