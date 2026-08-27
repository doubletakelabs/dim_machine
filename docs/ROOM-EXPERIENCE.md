# Building a room experience for DIM Machine

**Audience: whoever (or whatever) is adapting a standalone interactive piece so
it can run inside The Museum.** This is the whole contract. If your piece does
what is written here, it will slot in; if it does something else, it will not,
and `verify` will say so before anyone finds out on the floor.

---

## 1. What you are building, and what you are not

The Museum is a 23-space audio-guided show. Guests carry phones. Some rooms hand
their interaction to a **separate piece** — a wall, a projection, something with
its own physics — running **its own server on a machine in that room**. You are
building one of those.

Two connections reach your server, and they are completely different:

```
DIM Machine  ──(broker link: who is driving, what the room is doing)──▶  you ──▶ your wall
                                                                          ▲
guest's phone ─────────────(driver link: a thumb, ~60Hz)──────────────────┘
```

**The broker link** is low-rate and carries authority. DIM tells you who may
drive and what the room is doing. You never argue with it.

**The driver link** is the guest's finger, arriving straight from their handset
because a detour through the show server would be jitter bought for nothing.

### What you keep

- Serving your own files — wall page, scripts, media — from your own machine.
- All of your physics, rendering, timing, and feel.
- Relaying driver input to your wall however you like.

### What you must remove

**Anything that decides who is allowed to drive.** If your piece currently
assigns its own participant ids, picks colours, caps concurrent users, queues
people, or times them out — delete all of it. DIM decides, because DIM is the
only thing that knows who is standing in the room, whose room it is, and whether
they are a participant or a spectator. Two systems deciding this will disagree,
and the disagreement is invisible until somebody is holding a dead phone.

---

## 2. The manifest

`experience.json`, at the root of your folder:

```json
{
  "contract": 1,
  "experienceId": "influence-clickfarm",
  "name": "Click Farm",
  "version": "1.0.0",
  "entry": { "wall": "/wall.html" },
  "inputs": ["drag", "release", "tap", "hold"],
  "maxDrivers": 4,
  "media": { "dir": "media", "required": false },
  "calibration": { "file": "calibration.json" }
}
```

| Field | Meaning |
|---|---|
| `contract` | Always `1` today. Bump when this document does. |
| `experienceId` | Stable, kebab-case. The show names you by this. |
| `version` | Yours. Reported to the operator panel so we can see what is running. |
| `entry.wall` | Path the display machine opens. |
| `inputs` | Only the intents you consume. The phone will not send you others. |
| `maxDrivers` | The most simultaneous drivers your piece handles well. |
| `media.dir` | Where large media lives. **Ships separately** — never in a repo. |
| `calibration.file` | Where projection calibration is written. See §7. |

---

## 3. The broker link

DIM connects to your server as a **WebSocket client**. It will reconnect on a
backoff forever, so you never need to reach out.

### It says hello

```json
{ "t": "hello", "role": "broker", "roomId": "influence",
  "experienceId": "influence-clickfarm", "contract": 1 }
```

### You answer once

```json
{ "t": "ready", "experienceId": "influence-clickfarm", "version": "1.0.0",
  "maxDrivers": 4, "accepts": ["drag", "release", "tap", "hold"] }
```

`maxDrivers` here is honoured live — if you say 1, DIM sends one driver even
when four people are in the room. Use it to protect your piece.

### Then it tells you two things, repeatedly

**Lifecycle.** What is *true* of the room. Three conditions, re-sent whenever
they change and on every reconnect:

```json
{ "t": "lifecycle", "state": "attract" | "live" | "settling" }
```

| State | What it means | What your piece should do |
|---|---|---|
| `attract` | Nobody is driving | Run your attract loop. **A still piece reads as broken.** |
| `live` | Somebody is driving now | Respond to input |
| `settling` | They have stepped out; the room is holding its exit grace | Hold everything exactly as they left it |

> **This is the single most important thing to change.** Almost every standalone
> piece infers "nobody is here" from having no sockets connected. In a show that
> is wrong: a guest can be standing in your room as a spectator, before the room
> activates, or on someone else's path. **The show knows. The socket count does
> not.** Drive your attract loop from `lifecycle`, never from connection count.

**`settling` is not a slower `attract`.** A room in exit grace has two ways out,
and they are opposites:

- the guest walks back in → `live` again, and everything they built should still
  be there
- the grace expires → `attract`, preceded by a `reset`

So hold state through `settling`. Someone stepping into a corridor for four
seconds and returning to a wiped piece is the fault this distinction prevents.

**Reset.** What *happened* to the room. Sent once, never repeated:

```json
{ "t": "reset" }
```

The room has come back to rest and whatever the last guest built should not be
waiting for the next one. Clear your state; `attract` follows immediately.

> Deliberately not a lifecycle value. A state is re-sent on every reconnect, so
> a piece would wipe itself every time the link flapped — losing a guest's
> session to a network blip rather than to them leaving. Conditions are
> reconciled; events fire once.
>
> If you were disconnected when a reset fired, you missed it and that is fine:
> a piece that was down through a reset came back with nothing to clear.

**Drivers.** Who may drive:

```json
{ "t": "drivers", "drivers": [ { "driverId": "d-3f9a1c22", "hue": 190, "secret": "…" } ] }
```

> **This is always the complete set, never a change.** No "driver joined" or
> "driver left" messages exist. Every message is the whole truth.
>
> That is deliberate, and it is what makes your server restartable. If somebody
> power-cycles your machine mid-show, DIM reconnects and the *first* message you
> receive is the full current state — no replay, no resync, no special case. Do
> not accumulate; replace.

`hue` is a CSS hue angle (0–360). Use it wherever your piece tints what a driver
owns. It stays with a person for as long as they are in the room, so a colour
that shuffled when somebody else walked in would read as your piece glitching.

`secret` is what that driver's phone will present. It is **not** security — this
is a closed network. It stops your server taking orders from anything that finds
the port.

### Optional: tell us how you are

```json
{ "t": "status", "wall": 1, "drivers": 2, "note": "anything" }
```

Shown in the operator panel. Not required.

---

## 4. The driver link

The guest's phone connects **directly to you** and identifies itself:

```json
{ "t": "hello", "role": "driver", "driverId": "d-3f9a1c22", "secret": "…" }
```

Check both against your current driver set. Reply:

```json
{ "t": "claim", "driverId": "d-3f9a1c22", "hue": 190 }
```

or, if you do not recognise them:

```json
{ "t": "denied", "reason": "unknown driver" }
```

Then intents arrive, at up to ~60Hz for `drag`:

| Message | Fields | Notes |
|---|---|---|
| `drag` | `dx`, `dy` | **Fractions of the phone's own screen**, so device size drops out. Positive `dy` is downward. |
| `release` | `vx`, `vy` | Screens per second at the moment of lift. Zero if the finger stopped before lifting. |
| `tap` | — | |
| `hold` | `on` | `true` on press-and-hold, `false` when it ends |
| `swipe` | `direction`, `dx`, `dy` | `"left" \| "right" \| "up" \| "down"` |

**Everything is two-dimensional even if your piece reads one axis.** Ignore the
one you do not use. This exists so the next experience does not arrive with its
own dialect.

**Recognition happens on the phone, not here.** You will never receive raw
pointer coordinates. The handset knows the true timing of the finger; you would
only ever see a network-jittered copy of it.

### Physics stays yours

Send intent, own the outcome. The phone tells you a thumb moved; how far
anything travels, how it snaps, how it decays is your piece's business.
Network jitter must never stutter your motion.

---

## 5. Failure, from your side

**DIM may not be there.** Serve your wall, run attract, wait. Do not block, do
not crash, do not exit.

**A driver's socket may drop.** Stop honouring them; DIM will re-cue the phone
if the guest is still in the room. Do not hold their slot open on a timer, and
do not promote anyone yourself.

**You may be restarted at any moment.** The broker's first message is the whole
state, so simply obeying what arrives is correct. Do not persist driver state
across a restart — it is stale by definition.

**Your machine may be unplugged.** DIM carries on: the room still admits guests
and still plays its audio, because a dark wall is bad and a room that turns
people away because a projector machine is off takes the evening with it. You do
not need to handle this; just do not make it worse by holding a lock somewhere.

---

## 6. What the phone shows

**Assume the phone shows nothing of yours.** In `stream` mode the handset is a
blind surface — the guest looks at your wall, not down. If it showed a feed,
everyone looks down and your projection becomes wallpaper.

If your piece needs something on the phone's screen, it is authored as a show
cue on our side, not served by you. Ask, do not build it.

---

## 7. Calibration goes in a file

Projection mapping, warp corners, grid size, tuning — anything an installer sets
once and must not lose.

**Not `localStorage`.** It is per-machine *and* per-browser-profile, so a reset,
a different browser, or a fresh user account loses the mapping — and nobody
discovers that until the projector is already hung.

Write it through your own server to the file named in the manifest:

```
GET  /calibration        → the current JSON (or {} if unset)
POST /calibration        → replace it, write to disk, 200
```

A file can be backed up, copied to a spare machine, and diffed when somebody
says the mapping looks off.

---

## 8. Developing and testing without DIM

Run the harness from the DIM Machine repo:

```
node tools/experience-harness.mjs ws://localhost:8080
```

It connects to your server **as a broker** — the same role, the same messages —
and serves a control page at `http://<lan-ip>:7420/`:

- lifecycle buttons: attract / live / settling / reset
- add and remove drivers, up to your declared `maxDrivers`
- a QR and URL for a **driver page** that speaks the real intent protocol

Open the driver page on your phone, on several phones, or in several browser
tabs. Each becomes a driver with its own id, hue, and secret, exactly as the
show would issue them.

A device keeps its driver across a refresh — it remembers which one it is, the
same way a guest's handset keeps its identity — so "phone A is driver 1" stays
true for a session. New devices take the next free slot; once every slot is
spoken for they double up, which is a deliberate way to see what your piece does
when two people share a driver. Clearing the drivers in the panel releases them
all.

> **The point: there is no dev mode.** Your server does not know whether the
> broker is the harness or the show — same socket, same messages. The path you
> exercise on every refresh is the one that ships.

---

## 8a. When it does not work

| Symptom | Almost always |
|---|---|
| Driver page says **"could not reach the experience"** | The address is not reachable *from the phone*. `localhost` on a phone is the phone. The harness rewrites this for you; if you hardcoded an endpoint anywhere, that is why. |
| Driver page says **"denied: unknown driver"** | The `driverId`/`secret` did not match your current set. Check you replaced the set on the last `drivers` message rather than merging it. |
| Driver page says **"no free driver slot"** | Nobody has pressed *add driver* in the harness. |
| A phone becomes a different driver on refresh | Fixed — a device now remembers its driver. If it still happens, its storage is blocked (private browsing). |
| Harness says **"not connected"** | Your server is not running, or not on the endpoint the harness was given. |
| Harness says **"no `ready` yet"** | You accepted the broker socket but never answered its `hello`. |
| Wall does nothing while a phone drags | Check the intent is in your manifest `inputs` — anything undeclared is dropped on purpose, at both ends. |
| Piece wipes itself when somebody steps out | You are treating `settling` as a reset. Hold state; wait for the `reset` event. |
| Piece wipes itself when the network hiccups | You are treating `reset` as a lifecycle state. It is a one-shot event. |

---

## 9. Before you hand it over

```
node tools/verify-experience.mjs ./your-folder
```

It boots your server, connects as a broker, and checks the contract. All of it
must pass:

- [ ] `experience.json` present and valid
- [ ] server starts with no arguments and no `npm install`
- [ ] serves `entry.wall`
- [ ] accepts a broker connection and answers `ready`
- [ ] honours `drivers` as a **set**, replacing rather than accumulating
- [ ] never assigns its own driver ids, hues, or caps
- [ ] obeys `lifecycle`, and runs attract on command rather than on socket count
- [ ] **holds state through `settling`**, and clears it on `reset`
- [ ] accepts a driver presenting a valid `driverId` + `secret`
- [ ] **refuses** a driver presenting a wrong or unknown secret
- [ ] relays every intent in `inputs`, and ignores ones it did not declare
- [ ] calibration round-trips through `GET`/`POST /calibration` to a file
- [ ] no hardcoded IP addresses or ports — port from `PORT`, default in manifest
- [ ] media referenced from `media.dir`, not committed

---

## 10. Quick reference

```
BROKER LINK                            DRIVER LINK
DIM → you                              phone → you
  hello   {role:'broker', roomId,        hello   {role:'driver', driverId, secret}
           experienceId, contract}       drag    {dx, dy}        fractions of screen
  lifecycle {state}      ← condition    release {vx, vy}        screens/sec
  drivers {drivers:[{driverId,           tap     {}
           hue, secret}]}  ← full set    hold    {on}
  reset   {}             ← event         swipe   {direction, dx, dy}
you → DIM
  ready   {experienceId, version,      you → phone
           maxDrivers, accepts}          claim   {driverId, hue}
  status  {…}              optional      denied  {reason}
```

Two rules underneath all of it:

1. **Conditions are reconciled; events fire once.** `lifecycle` and `drivers`
   are the whole truth every time, so arriving late or restarting is never a
   special case. `reset` is the one thing that genuinely *happened*.
2. **The show owns who and when. You own what it looks and feels like.**
