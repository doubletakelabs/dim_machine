/**
 * Slop and Consumption 2 hold a moment when their guest walks out (2026-10-13):
 * a beacon blip must not wipe a guest's game. The room settles for 5 s (its
 * piece keeps the game and its start screen stays down), and a guest back
 * inside that carries on as the same driver. Longer away, and the piece is
 * reset and goes back to its start screen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SpatialRuntime } from '../runtime.js';
import { ManualClock } from '../clock.js';
import { roomCentroid } from '../zone-math.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const museum = JSON.parse(readFileSync(join(root, 'shows/MAD-DIM.json'), 'utf8'));

function withPiece(roomId, mutate) {
  const show = structuredClone(museum);
  mutate?.(show);
  show.rooms[roomId].experience.endpoint = `ws://${roomId}.test:8080`;
  const sockets = [];
  const rt = new SpatialRuntime({
    enableTick: false,
    clock: new ManualClock(),
    openExperienceSocket: (url) => {
      const handlers = {};
      const socket = {
        url, sent: [], on: (e, fn) => { handlers[e] = fn; }, send: (raw) => socket.sent.push(JSON.parse(raw)), close: () => {},
        last: (t) => [...socket.sent].reverse().find((m) => m.t === t) ?? null,
        of: (t) => socket.sent.filter((m) => m.t === t),
      };
      sockets.push(socket);
      queueMicrotask(() => handlers.open?.());
      socket.open = () => handlers.open?.();
      return socket;
    },
  });
  assert.deepEqual(rt.load(show).errors, []);
  rt.start();
  sockets[0].open();
  return { rt, piece: sockets[0] };
}

const walkTo = (rt, guestId, roomId, ms = 3000) => {
  const [x, y] = roomCentroid(museum.rooms[roomId]);
  rt.setVirtualPosition(guestId, x, y);
  rt.testAdvanceTime(ms);
};

for (const roomId of ['slop', 'consumption2']) {
  describe(`${roomId}: a moment's grace when the guest walks out`, () => {
    it('back within 5 s: the same driver, the game carries on, no reset', () => {
      const { rt, piece } = withPiece(roomId);
      const g = rt.spawnGuest();
      walkTo(rt, g.guestId, 'museumHallway');
      walkTo(rt, g.guestId, roomId, 15_000);
      assert.equal(piece.last('lifecycle').state, 'live');
      const driver = piece.last('drivers').drivers[0].driverId;

      walkTo(rt, g.guestId, 'museumHallway', 3000);
      assert.equal(piece.last('lifecycle').state, 'settling', 'held, not attract: the start screen stays down');
      walkTo(rt, g.guestId, roomId, 2500);
      assert.equal(piece.last('lifecycle').state, 'live');
      assert.equal(piece.last('drivers').drivers[0]?.driverId, driver, 'the same driver');
      assert.equal(piece.of('reset').length, 0, 'never reset');
    });

    it('away longer: reset, back to the start screen', () => {
      const { rt, piece } = withPiece(roomId);
      const g = rt.spawnGuest();
      walkTo(rt, g.guestId, 'museumHallway');
      walkTo(rt, g.guestId, roomId, 15_000);
      walkTo(rt, g.guestId, 'museumHallway', 15_000);
      assert.equal(piece.last('lifecycle').state, 'attract');
      assert.equal(piece.of('reset').length, 1);
      assert.deepEqual(piece.last('drivers').drivers, []);
    });
  });
}

describe('slop: the song survives a step out', () => {
  it('back within 5 s: the room picks up on the song the guest had chosen', () => {
    // The song states the server makes from the track folder (track-folders.js).
    const { rt, piece } = withPiece('slop', (show) => {
      const active = show.rooms.slop.machine.states.active;
      for (const n of [1, 2]) { active.states[`track${n}`] = {}; active.on[`TRACK_${n}`] = `.track${n}`; }
    });
    const g = rt.spawnGuest();
    walkTo(rt, g.guestId, 'museumHallway');
    walkTo(rt, g.guestId, 'slop', 15_000);
    rt.roomEventFromExperience('slop', 'TRACK_2');
    assert.match(String(rt.rooms.get('slop').state), /track2/);
    walkTo(rt, g.guestId, 'museumHallway', 3000);
    assert.match(String(rt.rooms.get('slop').state), /settling/);
    walkTo(rt, g.guestId, 'slop', 2500);
    assert.match(String(rt.rooms.get('slop').state), /active\.track2/, 'not back to the base background');
    assert.equal(piece.of('reset').length, 0);
  });
});
