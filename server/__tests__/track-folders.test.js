/**
 * A room's tracks built from the songs in its folder: drop a file in, and it
 * is in the rotation the next time the show loads.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandTrackFolders } from '../track-folders.js';

const slop = () => ({
  rooms: {
    slop: {
      bg: 'audio/bg/0901_SLOP.mp3',
      tracks: { folder: 'audio/bg/slop/', in: 'active', crossfadeMs: 0 },
      machine: {
        id: 'slop',
        initial: 'idle',
        states: {
          idle: { on: { ACTIVATE: 'active' } },
          active: {
            initial: 'base',
            on: { RELEASE: 'idle', TRACK_STOP: '.base' },
            states: { base: {} },
          },
        },
      },
    },
  },
});
const folder = (...names) => ({ list: (f) => (f === 'audio/bg/slop' ? names : null) });

describe('tracks from a folder', () => {
  it('gives each song a state, the event to it, and its bg', () => {
    const { def, notes } = expandTrackFolders(slop(), folder('01slop_song.mp3', '02slop_song.m4a'));
    const active = def.rooms.slop.machine.states.active;
    assert.deepEqual(Object.keys(active.states), ['base', 'track1', 'track2']);
    assert.equal(active.on.TRACK_1, '.track1');
    assert.equal(active.on.TRACK_2, '.track2');
    assert.equal(active.on.TRACK_STOP, '.base', 'what the show wrote itself stays');
    assert.deepEqual(def.rooms.slop.cues['active.track2'], { bg: { audio: 'audio/bg/slop/02slop_song.m4a', crossfadeMs: 0 } });
    assert.deepEqual(notes, ['slop: 2 tracks from audio/bg/slop']);
  });

  it('orders by name, numbers as numbers, and ignores anything that is not a song', () => {
    const { def } = expandTrackFolders(slop(), folder('10.mp3', '.DS_Store', '2.mp3', 'cover.png', '1.mp3'));
    assert.deepEqual(def.rooms.slop.tracks.list.map((t) => t.audio), [
      'audio/bg/slop/1.mp3', 'audio/bg/slop/2.mp3', 'audio/bg/slop/10.mp3',
    ]);
  });

  it('keeps the list, with each length, for the room\'s piece', () => {
    const lengths = { 'audio/bg/slop/a.mp3': 29.39, 'audio/bg/slop/b.mp3': 65.62 };
    const { def } = expandTrackFolders(slop(), { ...folder('a.mp3', 'b.mp3'), seconds: (a) => lengths[a] ?? null });
    assert.deepEqual(def.rooms.slop.tracks.list, [
      { n: 1, audio: 'audio/bg/slop/a.mp3', seconds: 29.39 },
      { n: 2, audio: 'audio/bg/slop/b.mp3', seconds: 65.62 },
    ]);
  });

  it('replaces tracks written by hand rather than adding to them', () => {
    const show = slop();
    const active = show.rooms.slop.machine.states.active;
    Object.assign(active.states, { track1: {}, track2: {}, track3: {} });
    Object.assign(active.on, { TRACK_1: '.track1', TRACK_2: '.track2', TRACK_3: '.track3' });
    show.rooms.slop.cues = { 'active.track3': { bg: 'old.mp3' }, 'active.base': { audio: 'kept.mp3' } };
    const { def } = expandTrackFolders(show, folder('only.mp3'));
    assert.deepEqual(Object.keys(def.rooms.slop.machine.states.active.states), ['base', 'track1']);
    assert.equal(def.rooms.slop.machine.states.active.on.TRACK_3, undefined);
    assert.deepEqual(Object.keys(def.rooms.slop.cues), ['active.base', 'active.track1']);
  });

  it('says so, rather than guessing, when the folder or the state is not there', () => {
    assert.match(expandTrackFolders(slop(), { list: () => null }).problems[0], /no folder audio\/bg\/slop/);
    assert.match(expandTrackFolders(slop(), folder()).problems[0], /has no songs/);
    const show = slop();
    show.rooms.slop.tracks.in = 'playing';
    assert.match(expandTrackFolders(show, folder('a.mp3')).problems[0], /"playing", which is not a state/);
  });

  it('leaves the show as authored untouched', () => {
    const show = slop();
    expandTrackFolders(show, folder('a.mp3'));
    assert.deepEqual(Object.keys(show.rooms.slop.machine.states.active.states), ['base']);
    assert.equal(show.rooms.slop.tracks.list, undefined);
  });
});
