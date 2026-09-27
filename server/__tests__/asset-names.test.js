/**
 * Audio names matched to the disk: a clip named .mp3 in the show plays the
 * .m4a the sound team exported instead, and the other way round.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAudioName, resolveAudioNames } from '../asset-names.js';

const disk = (...files) => (path) => files.includes(path);

describe('matching an audio name to the disk', () => {
  it('uses the named file when it is there', () => {
    const exists = disk('audio/a.mp3', 'audio/a.m4a');
    assert.equal(resolveAudioName('audio/a.mp3', exists), 'audio/a.mp3');
    assert.equal(resolveAudioName('audio/a.m4a', exists), 'audio/a.m4a');
  });

  it('finds the same name with the other ending, either way round', () => {
    assert.equal(resolveAudioName('audio/a.mp3', disk('audio/a.m4a')), 'audio/a.m4a');
    assert.equal(resolveAudioName('audio/a.m4a', disk('audio/a.mp3')), 'audio/a.mp3');
  });

  it('prefers mp3, then m4a, when the named one is missing and several are there', () => {
    assert.equal(resolveAudioName('audio/a.wav', disk('audio/a.m4a', 'audio/a.mp3')), 'audio/a.mp3');
  });

  it('matches the ending however it is cased, and keeps the name as written', () => {
    assert.equal(resolveAudioName('audio/Take 1.MP3', disk('audio/Take 1.m4a')), 'audio/Take 1.m4a');
  });

  it('leaves a name with nothing on disk alone, to be reported missing', () => {
    assert.equal(resolveAudioName('audio/gone.mp3', disk()), 'audio/gone.mp3');
  });

  it('leaves anything that is not audio alone', () => {
    assert.equal(resolveAudioName('img/screen.png', disk('img/screen.jpg')), 'img/screen.png');
    assert.equal(resolveAudioName('maskRoom', disk()), 'maskRoom');
  });
});

describe('matching a whole show', () => {
  it('reaches every place a show names audio, and says what it swapped', () => {
    const show = {
      rooms: {
        kin: { bg: 'audio/bg/kin.mp3', cues: { active: { audio: 'audio/g/kin.mp3', image: 'img/kin.png' } } },
        hall: { thresholds: { 'hall-door': { cues: { guidance: { audio: 'audio/g/door.mp3' } } } } },
      },
      guest: { bed: { audio: 'audio/bg/bed.mp3', from: 'kin' } },
      museum: { stems: { inHallway: ['audio/m/h1.mp3', 'audio/m/h2.mp3'] } },
    };
    const exists = disk('audio/bg/kin.m4a', 'audio/g/kin.mp3', 'audio/g/door.m4a', 'audio/bg/bed.m4a',
      'audio/m/h1.m4a', 'audio/m/h2.mp3');
    const { def, swaps } = resolveAudioNames(show, exists);
    assert.equal(def.rooms.kin.bg, 'audio/bg/kin.m4a');
    assert.equal(def.rooms.kin.cues.active.audio, 'audio/g/kin.mp3', 'there as named');
    assert.equal(def.rooms.kin.cues.active.image, 'img/kin.png');
    assert.equal(def.rooms.hall.thresholds['hall-door'].cues.guidance.audio, 'audio/g/door.m4a');
    assert.equal(def.guest.bed.audio, 'audio/bg/bed.m4a');
    assert.deepEqual(def.museum.stems.inHallway, ['audio/m/h1.m4a', 'audio/m/h2.mp3']);
    assert.equal(swaps.length, 4);
    assert.equal(show.rooms.kin.bg, 'audio/bg/kin.mp3', 'the show as authored is untouched');
  });
});
