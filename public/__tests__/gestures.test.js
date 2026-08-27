/**
 * The gesture recogniser.
 *
 * These are the first tests any of `public/` has ever had, and the reason is
 * specific: `hold` shipped **missing entirely**. It was implemented in the test
 * harness's driver page, described in the contract, and never written in the
 * client — and no test could have failed, because nothing in this file was
 * reachable except by a person putting a finger on a handset. Two other faults
 * had the same property.
 *
 * The clock and the timers are injected, so a four-hundred-millisecond hold
 * takes no time at all and a swipe can be given an exact duration. Nothing here
 * touches a DOM, a socket, or an AudioContext.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGestureRecogniser, createRepeatGuard,
  HOLD_MS, SWIPE_MIN_PX, SWIPE_MAX_MS, TAP_MAX_PX,
} from '../gestures.js';

/**
 * A finger, with the clock in the test's hand.
 *
 * `tick(ms)` advances time and fires any timer that has come due — so the hold
 * timer fires because time passed, which is the thing being tested, rather than
 * because the test reached in and called it.
 */
function finger(mode = 'gestures') {
  const events = [];
  let t = 1_000;
  let timers = [];
  let nextId = 1;

  const r = createGestureRecogniser({
    mode: () => mode,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: t + ms, fn });
      return id;
    },
    clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
    onTouch: () => events.push(['touch']),
    onGesture: (type, payload) => events.push([type, payload]),
    onHold: (on) => events.push(['hold', on]),
    onStreamBegin: (x, y) => events.push(['stream.begin', x, y]),
    onStreamMove: (x, y) => events.push(['stream.move', x, y]),
    onStreamEnd: () => events.push(['stream.end']),
  });

  return {
    ...r,
    events,
    get holding() { return r.holding; },
    get touching() { return r.touching; },
    setMode(next) { mode = next; },
    tick(ms) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      for (const x of due) x.fn();
    },
    /** Just the event names, for asserting on shape rather than detail. */
    names: () => events.map((e) => e[0]),
    of: (name) => events.filter((e) => e[0] === name),
  };
}

describe('tap', () => {
  it('is a finger that lands and leaves in the same place', () => {
    const f = finger();
    f.begin(100, 200);
    f.tick(120);
    f.end(102, 199);
    assert.deepEqual(f.of('tap'), [['tap', { x: 102, y: 199 }]]);
  });

  it('is still a tap when the finger rested there', () => {
    const f = finger();
    f.begin(100, 200);
    // There was a 400ms ceiling on this and it was wrong. Told to TAP THE
    // SCREEN, people press deliberately; a firm press is easily half a second,
    // and a guest whose tap is refused for being too committed has no way to
    // learn that from a screen that simply does not move.
    f.tick(2_000);
    f.end(100, 200);
    assert.equal(f.of('tap').length, 1, 'a two-second press is a tap');
  });

  it('tolerates the wobble of a fingertip but not a drag', () => {
    const wobble = finger();
    wobble.begin(100, 100);
    wobble.tick(80);
    wobble.end(100 + TAP_MAX_PX, 100);
    assert.equal(wobble.of('tap').length, 1, `${TAP_MAX_PX}px is still a tap`);

    const slid = finger();
    slid.begin(100, 100);
    slid.tick(80);
    slid.end(100 + TAP_MAX_PX + 15, 100);
    // Too far to be a tap, too short to be a swipe: a finger that changed its
    // mind, and the show should do nothing rather than guess.
    assert.deepEqual(slid.names().filter((n) => n !== 'touch'), []);
  });

  it('reports where it landed, as whole pixels', () => {
    const f = finger();
    f.begin(10.4, 20.6);
    f.end(10.4, 20.6);
    assert.deepEqual(f.of('tap')[0][1], { x: 10, y: 21 });
  });
});

describe('swipe', () => {
  const swipeTo = (dx, dy, ms = 200) => {
    const f = finger();
    f.begin(200, 300);
    f.tick(ms);
    f.end(200 + dx, 300 + dy);
    return f;
  };

  it('names the direction the finger went', () => {
    const cases = [
      [SWIPE_MIN_PX + 20, 0, 'right'],
      [-(SWIPE_MIN_PX + 20), 0, 'left'],
      [0, SWIPE_MIN_PX + 20, 'down'],
      [0, -(SWIPE_MIN_PX + 20), 'up'],
    ];
    for (const [dx, dy, direction] of cases) {
      const [, payload] = swipeTo(dx, dy).of('swipe')[0];
      assert.equal(payload.direction, direction, `${dx},${dy}`);
      assert.equal(payload.dx, dx);
      assert.equal(payload.dy, dy);
    }
  });

  it('resolves a diagonal to whichever axis won', () => {
    assert.equal(swipeTo(80, 40).of('swipe')[0][1].direction, 'right');
    assert.equal(swipeTo(40, 80).of('swipe')[0][1].direction, 'down');
    // A perfect diagonal has to go somewhere; horizontal wins by the >= in the
    // comparison, and the point of the test is that it is decided, not random.
    assert.equal(swipeTo(80, 80).of('swipe')[0][1].direction, 'right');
  });

  it('needs distance', () => {
    const short = swipeTo(SWIPE_MIN_PX - 1, 0);
    assert.equal(short.of('swipe').length, 0, 'shorter than the threshold is a slip');
    assert.equal(swipeTo(SWIPE_MIN_PX, 0).of('swipe').length, 1);
  });

  it('needs to be quick — a slow one is a drag, not a swipe', () => {
    assert.equal(swipeTo(120, 0, SWIPE_MAX_MS).of('swipe').length, 1);
    const slow = swipeTo(120, 0, SWIPE_MAX_MS + 1);
    assert.deepEqual(slow.names().filter((n) => n !== 'touch'), [],
      'a slow travel is a finger moving, not an answer');
  });
});

describe('hold', () => {
  /**
   * The one that shipped missing. It is only ever streamed — a hold is a state
   * a finger is in rather than something that happened, which is why it is not
   * an input the statechart can bind.
   */
  it('starts once the finger has stayed put long enough', () => {
    const f = finger('stream');
    f.begin(50, 50);
    f.tick(HOLD_MS - 1);
    assert.deepEqual(f.of('hold'), [], 'not yet');
    assert.equal(f.holding, false);

    f.tick(1);
    assert.deepEqual(f.of('hold'), [['hold', true]]);
    assert.equal(f.holding, true);
  });

  it('ends when the finger leaves', () => {
    const f = finger('stream');
    f.begin(50, 50);
    f.tick(HOLD_MS);
    f.end(50, 50);
    assert.deepEqual(f.of('hold'), [['hold', true], ['hold', false]]);
    assert.equal(f.holding, false);
  });

  it('is cancelled by a drag, and never begins', () => {
    const f = finger('stream');
    f.begin(50, 50);
    f.tick(HOLD_MS - 50);
    f.move(50 + TAP_MAX_PX + 5, 50);
    f.tick(200);
    assert.deepEqual(f.of('hold'), [], 'moving away means it was never a hold');
  });

  it('survives a wobble that stays inside the tap radius', () => {
    const f = finger('stream');
    f.begin(50, 50);
    f.tick(100);
    f.move(50 + TAP_MAX_PX, 50);
    f.tick(HOLD_MS);
    assert.deepEqual(f.of('hold'), [['hold', true]], 'a resting finger is not perfectly still');
  });

  it('does not also count as a tap when it ends', () => {
    const f = finger('stream');
    f.begin(50, 50);
    f.tick(HOLD_MS + 500);
    f.end(50, 50);
    assert.equal(f.of('tap').length, 0, 'a hold that ended is one gesture, not two');
  });

  it('never fires outside stream mode', () => {
    // The statechart has no `hold` to bind. Sending one would be a message the
    // show has no way to interpret and no way to report as unhandled.
    const f = finger('gestures');
    f.begin(50, 50);
    f.tick(HOLD_MS * 3);
    f.end(50, 50);
    assert.deepEqual(f.of('hold'), []);
    assert.equal(f.of('tap').length, 1, 'it is simply a firm tap');
  });
});

describe('streaming to a room experience', () => {
  it('reports the whole of a drag, and its end', () => {
    const f = finger('stream');
    f.begin(10, 10);
    f.move(20, 20);
    f.move(30, 30);
    f.end(30, 30);
    assert.deepEqual(f.names(), [
      'touch', 'stream.begin', 'stream.move', 'stream.move', 'stream.end',
    ]);
    assert.deepEqual(f.of('stream.move'), [['stream.move', 20, 20], ['stream.move', 30, 30]]);
  });

  it('still recognises a gesture inside a stream', () => {
    // Both, deliberately. The continuous drag is what the piece animates; the
    // swipe is a discrete intent it may also act on — the contract lists tap and
    // swipe among the things an experience can be sent.
    const f = finger('stream');
    f.begin(10, 100);
    f.tick(150);
    f.move(60, 100);
    f.end(110, 100);
    assert.deepEqual(f.names(), [
      'touch', 'stream.begin', 'stream.move', 'stream.end', 'swipe',
    ]);
    assert.equal(f.of('swipe')[0][1].direction, 'right');
  });

  it('says nothing to the experience in gesture mode', () => {
    const f = finger('gestures');
    f.begin(10, 10);
    f.move(20, 20);
    f.end(20, 20);
    assert.deepEqual(f.names().filter((n) => n.startsWith('stream')), []);
  });

  it('lets go when the OS takes the touch away', () => {
    // A call arriving, or the notification shade pulled down, fires
    // `touchcancel` and never `touchend`. Without this the room holds the hold
    // for the rest of the guest's night.
    const f = finger('stream');
    f.begin(50, 50);
    f.tick(HOLD_MS);
    assert.equal(f.holding, true);

    f.abort();
    assert.deepEqual(f.of('hold'), [['hold', true], ['hold', false]]);
    assert.deepEqual(f.of('stream.end'), [['stream.end']]);
    assert.equal(f.touching, false);
  });

  it('does not end a stream that never began', () => {
    const f = finger('stream');
    f.abort();
    assert.deepEqual(f.names(), [], 'an abort with no finger down is nothing at all');
  });
});

describe('a finger that never landed', () => {
  it('is ignored on the way up', () => {
    // The recogniser sits on `document`, so it sees the second half of a
    // gesture that started on a button it declined to handle.
    const f = finger();
    f.end(100, 100);
    assert.deepEqual(f.names(), []);
  });

  it('does not carry a start across two ends', () => {
    const f = finger();
    f.begin(100, 100);
    f.end(100, 100);
    f.end(400, 100);
    assert.equal(f.of('tap').length, 1, 'the second end has nothing to measure from');
    assert.equal(f.of('swipe').length, 0);
  });
});

describe('mode changing under a finger', () => {
  it('does not leave a hold behind when the room hands input back', () => {
    // A guest can be holding when the show moves them out of a room. The mode
    // is read at each event rather than captured at `begin`, so the end still
    // releases what the begin started.
    const f = finger('stream');
    f.begin(50, 50);
    f.tick(HOLD_MS);
    assert.equal(f.holding, true);

    f.setMode('gestures');
    f.end(50, 50);
    assert.equal(f.holding, false, 'the hold is released whatever mode we are in now');
  });
});

describe('the repeat guard', () => {
  const guard = (minGapMs) => {
    let t = 0;
    const g = createRepeatGuard({ now: () => t, minGapMs });
    return { ...g, tick: (ms) => { t += ms; } };
  };

  it('lets the first answer through', () => {
    assert.equal(guard(400).allow(), true);
  });

  it('swallows a nervous double-tap', () => {
    const g = guard(400);
    assert.equal(g.allow(), true);
    g.tick(100);
    assert.equal(g.allow(), false, 'one person answering once');
  });

  it('opens again after the gap', () => {
    const g = guard(400);
    g.allow();
    g.tick(400);
    assert.equal(g.allow(), true);
  });

  it('does not start the show closed', () => {
    // A guard initialised to `now` would refuse the very first tap of the
    // night, which is the one on the join screen.
    const g = guard(400);
    g.tick(1);
    assert.equal(g.allow(), true);
  });
});
