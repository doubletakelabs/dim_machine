import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPoint, pointInPolygon, zoneIndex } from '../zone-math.js';

const libraryMain = [[120, 80], [280, 80], [280, 200], [120, 200]];
const libraryAlcove = [[280, 100], [330, 100], [330, 170], [280, 170]];

const rooms = {
  library: {
    zones: {
      'library-main': { polygon: libraryMain },
      'library-alcove': { polygon: libraryAlcove },
    },
  },
  greenhouse: {
    zones: { greenhouse: { polygon: [[360, 80], [520, 80], [520, 200], [360, 200]] } },
  },
};

describe('zone-math', () => {
  it('pointInPolygon detects interior', () => {
    assert.equal(pointInPolygon([200, 140], libraryMain), true);
    assert.equal(pointInPolygon([50, 50], libraryMain), false);
  });

  it('classifyPoint returns the room and the zone within it', () => {
    const r = classifyPoint(rooms, 200, 140);
    assert.equal(r.roomId, 'library');
    assert.equal(r.zoneId, 'library-main');
    assert.equal(r.occupancy, 'inside');
  });

  it('a second zone reports the same room', () => {
    const r = classifyPoint(rooms, 300, 135);
    assert.equal(r.roomId, 'library');
    assert.equal(r.zoneId, 'library-alcove');
    assert.equal(r.occupancy, 'inside');
  });

  it('classifyPoint returns outside just beyond the edge', () => {
    // There is no buffer zone — you are in a room or you are not.
    const r = classifyPoint(rooms, 110, 140);
    assert.equal(r.roomId, null);
    assert.equal(r.occupancy, 'outside');
  });

  it('classifyPoint returns outside when distant', () => {
    const r = classifyPoint(rooms, 10, 10);
    assert.equal(r.roomId, null);
    assert.equal(r.zoneId, null);
    assert.equal(r.occupancy, 'outside');
  });

  it('classifyPoint picks the containing room among several', () => {
    assert.equal(classifyPoint(rooms, 440, 140).roomId, 'greenhouse');
  });

  it('zoneIndex maps every zone to its owning room', () => {
    const index = zoneIndex(rooms);
    assert.equal(index.get('library-alcove'), 'library');
    assert.equal(index.get('greenhouse'), 'greenhouse');
    assert.equal(index.size, 3);
  });
});
