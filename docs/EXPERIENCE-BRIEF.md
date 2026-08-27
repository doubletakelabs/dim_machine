# Brief — building a room experience

`ROOM-EXPERIENCE.md` is the contract: every message, every field, exactly what is
promised and expected. This is the shorter thing — how to approach the work, what
almost every piece has to change, and what will be checked when it arrives.

Read this, then the contract, then run the reference.

---

## What you are building

A room in The Museum can hand its interaction to a **separate piece** running its
own server on a machine in that room. Guests carry phones. When one is in your
room and driving, their thumb reaches you directly; the show tells you separately
who is driving and what the room is doing.

Your piece owns everything about how it looks, moves and feels. It owns its own
display — a projection, a screen, a monitor wall, an LED panel, whatever the room
has. The show owns **who** and **when**, and nothing else.

The division that makes this work, and it is worth stating as a rule:

> **The phone sends intent. The piece owns physics.**

The phone says a thumb moved this far. How far anything travels, how it snaps,
how it decays, whether it has weight — yours. Network jitter must never be
visible in your motion.

---

## The shape of the work

Most of it is deletion. A standalone piece has to solve problems that the show
already solves, and solving them twice means two systems disagreeing.

### Delete anything that decides who may drive

If your piece assigns participant ids, picks colours, caps concurrent users,
queues people, or times idle ones out — remove all of it. The show decides,
because it is the only thing that knows who is in the room, whose room it is,
and whether they are a participant or a spectator.

You are given `driverId`, `hue` and `secret` for each driver. Use them. Do not
invent them, do not renumber them, do not hold a slot open for somebody who left.

### Take attract from the show, not from your sockets

Nearly every standalone piece decides it is idle because no controller is
connected. In a show that is wrong: a guest can be standing in your room as a
spectator, before the room has activated, or on somebody else's path. The show
knows; a socket count does not.

Drive your attract loop from `lifecycle`. **And keep it moving** — a still piece
reads as broken to anyone walking past.

### Hold state through `settling`, clear it on `reset`

A room in exit grace has two ways out and they are opposites: the guest walks
back in, or the grace expires. Someone stepping into the corridor for four
seconds and returning to a wiped piece is the fault this distinction exists to
prevent.

### Put installer settings in a file

Projection mapping, warp corners, grid size, tuning — anything set once at
install and never to be lost. **Not `localStorage`**: it is per-machine *and*
per-browser-profile, so a reset, a different browser, or a fresh user account
loses it, and nobody discovers that until the projector is already hung.

`GET`/`POST /calibration`, written to the file named in your manifest.

### Take the address from the environment

No hardcoded IPs, no hardcoded ports. `PORT` from the environment, a default in
your manifest. The machine you build on is not the machine you ship to.

---

## Two things that are easy to get subtly wrong

**`drivers` replaces, it never merges.** There are no "driver joined" or "driver
left" messages. Every `drivers` message is the complete set.

That is what makes your server restartable. If somebody power-cycles your machine
mid-show, the show reconnects and the *first* message you get is the whole
current state — no replay, no resync path to write, no special case for having
been switched on late. Do not accumulate; replace.

**`lifecycle` is conditions, `reset` is an event.** Conditions are re-sent on
every reconnect and are safe to act on repeatedly. `reset` fires once. If you
treat `reset` as a state you will wipe yourself every time the network hiccups;
if you treat `settling` as a reset you will wipe yourself every time somebody
steps out for a moment.

---

## The display

Whatever it is — projection, screen, monitor, LED wall — it connects to *your*
server as `role: "display"`, and you tell it whatever it needs. That link is
yours; the show has no opinion about it.

Two things worth designing for:

- **It must come up unattended.** Boot, fullscreen, no keypress. Somebody will
  power-cycle that machine at 6pm and nobody will have a keyboard.
- **It may connect late, or reconnect.** Tell it everything on connect for the
  same reason the show tells you everything: arriving in the middle must not be a
  special case.

**Assume the phone shows nothing of yours.** In a driving room the handset is a
blind surface — the guest looks at your display, not down at their hand. If a
piece needs something on the phone's screen, that is authored as a show cue on
our side. Ask; do not build it.

---

## What is checked, and what is not

```
npm run verify -- ./your-folder
```

That is the gate. It boots your server, connects as a broker, and drives it
through the things that go wrong in a building rather than on a desk: a restart
mid-show, a driver presenting a secret it was never given, a driver set that
shrinks, every declared intent at speed. Run it until it passes.

It checks the **protocol**. It cannot check **behaviour**, because it does not
know what "state" means inside your piece. These three are tested by hand in the
harness, and they are the three most likely to be wrong:

1. Drive the piece somewhere distinctive → `settling` → `live`. It must be
   exactly where it was left.
2. `settling` → `reset` → `attract`. It must be back to its starting state.
3. Two drivers driving, then remove one in the harness panel. That driver's
   influence must stop, and the other must be unaffected.

---

## Developing without the show

```
npm run harness -- ws://localhost:8080
```

The harness connects to your server **as a broker** — the same role, the same
messages, the same socket the show uses. Your server cannot tell them apart, so
there is no dev mode and no separate code path: what you exercise on every
refresh is what ships.

It gives you lifecycle buttons, driver slots, and a driver page to open on as
many phones as you like. Each phone connects straight to your server with a
driverId and secret the harness issued, exactly as a guest's handset will.

---

## Before you hand it over

- `npm run verify` passes every check
- the three behaviours above hold, with two phones on the harness
- your display comes up fullscreen from a cold boot with no keyboard
- large media is **not** in the repo — it ships separately, referenced by
  `media.dir` in the manifest
- calibration round-trips to a file and survives clearing the browser

If you are unsure whether something belongs to you or to the show, the test is:
*does it change when the show changes, or when the room changes?* Show-shaped
things are ours. Room-shaped things are yours.
