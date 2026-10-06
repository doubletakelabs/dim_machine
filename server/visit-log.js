/**
 * The visit log and the saved receipts (2026-10-06): what is left of each
 * visit once the phone is handed on — how many came, how long they stayed,
 * where they went, what they did with their hands, and the receipt they got.
 *
 * One file per day (the venue's local date of the START press) in `dir`:
 *
 *   visits-2026-10-06.jsonl    one JSON line per visit (visitRecord below)
 *   receipts-2026-10-06.txt    every receipt of the day, as printed
 *
 * Appends only, so a crash loses at most the visit in hand, and the files can
 * be read or copied while the show runs. Nothing here may stop the show: a
 * write that fails is reported to `log` and forgotten.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The local calendar day of `ms`, as YYYY-MM-DD. */
export function dayOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * One visit, as a line of the log.
 *
 * Its length runs from START DIM to reaching the end (the receipt room), or
 * for a visit that never got there, to the last room they walked into — not
 * to when the phone was handed on, which may be an hour on the charger later.
 *
 * @param {object} v
 * @param {string} v.visitId
 * @param {string} v.phone — the handset's label (`#mad0010`)
 * @param {number} v.startedAt — START DIM pressed
 * @param {number|null} v.finishedAt — reached the end, if they did
 * @param {{ roomId: string, at: number }[]} v.trail — rooms in the order walked into
 * @param {object} [v.counts] — the phone's gesture counts
 * @param {number} [v.words] — room words collected
 * @param {boolean} [v.receipt] — whether a receipt was made for them
 * @param {string} v.reason — why the line was written: finished, handedOn, cleared, serverStopped
 * @param {number} v.now
 */
export function visitRecord({ visitId, phone, startedAt, finishedAt = null, trail = [], counts = {}, words = 0, receipt = false, reason, now }) {
  const endAt = finishedAt ?? trail.at(-1)?.at ?? now;
  // Time in a room is until the next one; the last has no end the log knows.
  const rooms = trail.map((step, i) => {
    const next = trail[i + 1]?.at;
    return { room: step.roomId, at: iso(step.at), seconds: next == null ? null : Math.max(0, Math.round((next - step.at) / 1000)) };
  });
  return {
    day: dayOf(startedAt),
    visitId,
    phone: String(phone ?? '').replace(/^#/, ''),
    startedAt: iso(startedAt),
    finishedAt: iso(finishedAt),
    finished: finishedAt != null,
    minutes: Math.round(((endAt - startedAt) / 60000) * 10) / 10,
    rooms,
    gestures: {
      taps: counts.taps ?? 0,
      swipes: counts.swipes ?? 0,
      drags: counts.drags ?? 0,
      holds: counts.holds ?? 0,
      dragSeconds: Math.round((counts.dragMs ?? 0) / 1000),
    },
    words,
    receipt,
    reason,
    writtenAt: iso(now),
  };
}

export class VisitLog {
  /**
   * @param {string} dir — created on first write
   * @param {(line: string) => void} [log]
   */
  constructor(dir, log = () => {}) {
    this.dir = dir;
    this.log = log;
  }

  append(file, text) {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, file), text);
      return true;
    } catch (err) {
      this.log(`visit log: could not write ${file}: ${err.message}`);
      return false;
    }
  }

  /** @param {ReturnType<typeof visitRecord>} record */
  writeVisit(record) {
    return this.append(`visits-${record.day}.jsonl`, `${JSON.stringify(record)}\n`);
  }

  /**
   * A receipt as it came out of the printer (or would have), under a line
   * saying whose it was and whether it printed.
   */
  writeReceipt({ at, startedAt, phone, visitId, printed, text }) {
    const head = `### ${iso(at)}  phone ${String(phone ?? '?').replace(/^#/, '')}  visit ${visitId}  ${printed ? 'printed' : 'NOT PRINTED'}`;
    return this.append(`receipts-${dayOf(startedAt ?? at)}.txt`, `${head}\n${text}\n\n`);
  }
}
