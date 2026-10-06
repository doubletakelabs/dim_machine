import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VisitLog, visitRecord, dayOf } from '../visit-log.js';

const at = (hh, mm, ss = 0) => new Date(2026, 9, 6, hh, mm, ss).getTime();

describe('a visit, as a line of the log', () => {
  it('runs from START to the end, with each room\'s time until the next', () => {
    const r = visitRecord({
      visitId: 'v-1', phone: '#mad0010', startedAt: at(14, 0), finishedAt: at(14, 40),
      trail: [
        { roomId: 'frontDesk', at: at(14, 0) },
        { roomId: 'calibration', at: at(14, 1) },
        { roomId: 'maskRoom', at: at(14, 6, 30) },
        { roomId: 'library', at: at(14, 40) },
      ],
      counts: { taps: 12, swipes: 3, drags: 4, holds: 1, dragMs: 9400 },
      words: 5, receipt: true, reason: 'finished', now: at(14, 40),
    });
    assert.equal(r.day, '2026-10-06');
    assert.equal(r.phone, 'mad0010');
    assert.equal(r.finished, true);
    assert.equal(r.minutes, 40);
    assert.deepEqual(r.rooms.map((x) => [x.room, x.seconds]),
      [['frontDesk', 60], ['calibration', 330], ['maskRoom', 2010], ['library', null]]);
    assert.deepEqual(r.gestures, { taps: 12, swipes: 3, drags: 4, holds: 1, dragSeconds: 9 });
    assert.equal(r.receipt, true);
  });

  it('ends a visit that never reached the end at the last room walked into, not when the phone came back', () => {
    const r = visitRecord({
      visitId: 'v-2', phone: 'mad0002', startedAt: at(15, 0),
      trail: [{ roomId: 'frontDesk', at: at(15, 0) }, { roomId: 'calibration', at: at(15, 2) }],
      reason: 'handedOn', now: at(16, 30),
    });
    assert.equal(r.finished, false);
    assert.equal(r.minutes, 2, 'not the hour and a half on the charger');
    assert.deepEqual(r.gestures, { taps: 0, swipes: 0, drags: 0, holds: 0, dragSeconds: 0 });
  });

  it('files a visit under the day it started', () => {
    assert.equal(dayOf(at(23, 59)), '2026-10-06');
  });
});

describe('the files', () => {
  it('appends one line per visit, and the receipts, to the day\'s files', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'visits-')), 'data');
    const log = new VisitLog(dir);
    for (const id of ['v-1', 'v-2']) {
      log.writeVisit(visitRecord({ visitId: id, phone: 'mad0001', startedAt: at(10, 0), reason: 'finished', finishedAt: at(10, 30), now: at(10, 30) }));
    }
    log.writeReceipt({ at: at(10, 30), startedAt: at(10, 0), phone: '#mad0001', visitId: 'v-1', printed: true, text: 'DEAD INTERNET\nTAPS ..... 012' });
    log.writeReceipt({ at: at(10, 31), startedAt: at(10, 0), phone: '#mad0002', visitId: 'v-2', printed: false, text: 'DEAD INTERNET' });
    assert.deepEqual(readdirSync(dir).sort(), ['receipts-2026-10-06.txt', 'visits-2026-10-06.jsonl']);
    const lines = readFileSync(join(dir, 'visits-2026-10-06.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.visitId), ['v-1', 'v-2']);
    const receipts = readFileSync(join(dir, 'receipts-2026-10-06.txt'), 'utf8');
    assert.match(receipts, /phone mad0001 {2}visit v-1 {2}printed\nDEAD INTERNET\nTAPS \.\.\.\.\. 012/);
    assert.match(receipts, /phone mad0002 {2}visit v-2 {2}NOT PRINTED/);
  });

  it('never throws when it cannot write — the show goes on', () => {
    const said = [];
    const log = new VisitLog('/dev/null/cannot', (l) => said.push(l));
    assert.equal(log.writeVisit(visitRecord({ visitId: 'v', phone: 'x', startedAt: at(9, 0), reason: 'finished', now: at(9, 1) })), false);
    assert.match(said[0], /could not write/);
  });
});
