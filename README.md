# DIM Machine — v0.3 spatial runtime

Show-control platform for interactive, room-based theater (spec:
`specs/Interactive Theater Platform Spec v0_3.md`).

**Phase A (in progress):** spatial core — A0 scaffold, **A1 occupancy coordinator**
(virtual location, entry/exit hysteresis, dwell/seen, contact loss), **A2 room
actors** (activation, lock acquire/transfer/release, stub output), **A3 guest
actors** (eligibility, automatic activation on entry, ineligible-entry policy),
**A4 exit and reset** (per-room exit policy, grace timer, resume-on-return), and
**A8 test panel** (floor plan, auto-walk, time scaling) — pulled ahead of A5–A7
because it is the instrument for testing all of them.

Next: capacity/multi-guest (A5), phases and guidance (A6), adherence scoring
(A7), then zone drawing and scripted-walkthrough replay.

Everything runs on one injectable **show clock** (`server/spatial/clock.js`) —
coordinator holds, dwell timers, and authored XState `after` transitions alike —
so scripted walkthroughs can replay movement at speed. Nothing reads wall-clock
directly.

## Run

```sh
npm install
npm start          # → http://localhost:4000
npm test           # unit tests (server/spatial)
```

- **Test panel:** `http://localhost:4000/operator.html` → load **spatial-demo.json** → Start
- **Phones:** `http://localhost:4000/` — cue player retained for Phase B; spatial audio layers not wired yet

### Test panel (A8)

Deliberately lightweight and vanilla — no build step, no framework. It exists to
exercise the runtime and to find out what the real operator panel needs before
committing to React for it.

- **Floor plan** — zones drawn per room and coloured by room state, with the lock
  holder and exit-grace countdown on each. Drag a guest to move them; click a room
  or guest to inspect it. Guest dots are coloured by what happened when they last
  walked in: green activated, amber not-their-room, red refused. Until Phase B
  audio exists, that colour *is* the observable result.
- **Walk** — simulated guests walk themselves toward eligible unseen rooms, dwell,
  and move on. One mouse cannot drag five dots at once, so this is what makes
  capacity, phases, and adherence testable at all. The **Doing** column shows
  each walker's intent — `→ greenhouse` while travelling, `dwelling · moves in
  12s` while inside — so a stationary guest is never a mystery.
  - **Dwell is per room**, not one flat number: a guest lingers for that room's
    own `seen.dwellMs` plus a pad, so the cellar (10s) does not wait as long as
    the library (20s). Tune `speed` and `dwell pad` live from the panel.
- **Show clock** — elapsed show time in the header, with the current rate. It is
  extrapolated locally between roster pushes (which arrive every ~2s), so it ticks
  smoothly instead of stuttering.

#### Responsiveness

Movement rides its own lightweight `positions` channel at ~6/s, separate from the
full roster: moving inside a room commits nothing, so it would otherwise reach
the panel only on the 2-second roster and dots would teleport. The panel then
eases each dot toward its last reported point on `requestAnimationFrame`, so
motion looks smooth at any push rate; jumps over 120 units snap instead, because
easing an operator's drag looks like a bug.

Guests in the same room are spread rather than stacked, on a phyllotaxis spiral
— golden angle, radius growing as sqrt(n) — which keeps every dot roughly
equidistant from its neighbours instead of merely distinct. Random per-guest
offsets look fine in a printout and still overlap on screen. Slots are numbered
across all guests, not per room, so nobody's dot shifts when someone else
arrives or leaves.

One layout serves both cases: simulated guests walk to their own spot, and a
guest located without coordinates (how a BLE guest will appear) is drawn at
theirs. A dragged guest is never moved from where the operator put them.

A **confirmation ring** fills around a dot while an entry or exit is being
confirmed, and the Doing column reads `entering cellar…`. Without it the 1.5s
between the dot being inside and the room reacting looks like a frozen panel.

Guests are named the same way everywhere. Rooms and locks only carry ids, so the
panel resolves them back to the guest's label — a room's lock holder reads
`🔒 Guest 3`, not `aba3d3` — with a colour dot matching their marker on the
plan. The full id is still shown under the name in the guest list and in the
inspector, because the event log speaks ids.

What is *not* lag: entry and exit are confirmed before they commit
(`entryConfirmMs` 1500, `exitConfirmMs` 800), so walking into a room takes about
1.6s to show up and moving between two rooms takes ~2.4s — you leave one before
you enter the next. That hold is a safety mechanism, not overhead: activation is
automatic, so a false reading commits the physical layer with nobody in the loop.

To make testing feel immediate, raise the **time scale** rather than lowering the
hold — at 5× the same confirmation lands in 300ms and everything else scales with
it. If you do want the demo itself snappier, `location.entryConfirmMs` in
`shows/spatial-demo.json` is the knob; keep it high for anything BLE-driven.
- **Time scale** — run the show at 5× or 20× to watch a 20-second dwell threshold
  resolve in one, or pause it outright. **Test mode only:** leave it at 1× once
  Phase B schedules real audio against a shared clock.
- **Room overrides** — force `ACTIVATE` / `RELEASE` / `RESET` / `DONE`, release a lock.

Open decisions, declared-but-unused config, and known warts are tracked in
[`TECH-DEBT.md`](TECH-DEBT.md).

## Show definitions

Contract **v3 only** (`contractVersion: 3`) — see `CONTRACT.md`. v1/v2 workshop
shows are removed.

Rooms declare their **kind**, **adjacency**, and **zones**. The kind says who the
room runs *for*: a `destination` runs for a person, who holds it; a `shared` room
runs for the space, with no holder, so everyone inside gets the same thing; a
`hallway` is somewhere you pass through. A destination has a machine with three canonical states — `idle`,
`active`, `settling` — handling `ACTIVATE`, `RESET`, and `RELEASE`. A hallway is
somewhere you pass through: always eligible, never counted as seen, never a
deviation, and exempt from the activation contract it could never satisfy.

Occupancy is per room, so crossing between a room's zones is not an exit. Rooms
have no memory of having run before — revisit variants come from the activating
guest's history. A room may also declare `ineligible.policy: "activateVariant"`
to react to a guest it was not sent, in its own variant state.

**The guest is a statechart too.** Three parallel regions: `location` (generated
from adjacency — the map), `guidance` (authored — the journey), and `adherence`
(whether they are still following it). Paths are a library of named routes,
assigned by the journey when a guest reaches the part of the show that has them,
not at the door. See `CONTRACT.md`.

| File | Purpose |
|---|---|
| `shows/the-museum.json` | The real show: 23 spaces, two hallway hubs, 10 museum rooms, 4 paths |
| `shows/spatial-demo.json` | Small fixture — three rooms and a hallway — for focused tests |

Validate via `POST /api/shows/validate` or `SpatialRuntime.load()`.

**Virtual location (A1):** `POST /api/spatial/position` with `{ guestId, x, y }` or operator WebSocket `{ type: "setVirtualPosition", guestId, x, y }`. Occupancy is binary — `outside` / `inside` — with entry confirmed over `entryConfirmMs` (default 1500) and exit over `exitConfirmMs` (default 800).

**Activation (A2/A3):** walking into a room you are eligible for activates it —
there is nothing to press. `POST /api/spatial/activate` with `{ guestId, roomId }`
forces it manually for testing.

**Eligibility (A3):** the guest actor evaluates `guest.eligibility` before any
request reaches a room. A room no path routes through is open to everyone, so a
shared prologue works for guests who have not been assigned a path yet. An
ineligible entry normally leaves the room **completely untouched** — unless the
room declares `activateVariant`, in which case it runs its variant and the guest
holds it.

**Company and capacity (A5):** what an eligible guest gets when a room is already
running for someone is the room's `multiGuest.policy` — `collaborative` takes
them in as a participant up to `maxOccupants`, `spectator` and `personalVariant`
admit them without participation, `refuse` turns them away. Capacity counts the
guests a room is *running for*, not the bodies in it, and standing is derived
from arrival order — so a participant leaving promotes whoever was waiting, with
nothing tracking it. Rooms hear `occupants.<n>` when the count changes.

**Journey (A6):** `location` follows the coordinator exactly, including moves
that could not physically have happened; `guidance` advances on room entry and
on declared timers; `adherence` flips one-way when a guest enters a routed room
that is not theirs. Declared timers exist because XState's `after` restarts on
re-entry, and "thirty minutes in the museum" has to survive leaving.

**Exit and reset (A4):** walking out drives the room's `exit.policy` —
`resetAfter` (default, `graceMs` 10000) · `finish` · `hold` · `resetImmediate`.
The grace timer lives on the `settling` state, so it also covers a room whose
content ends on its own. Re-entering during grace resumes the room when
`exit.resumeIfReturned` is set. Room snapshots carry `resetInMs` so the operator
can watch the window tick down.

## Architecture

```
server/
  index.js              WebSocket + HTTP (operator, phones)
  relay.js              Room-scoped peer relay (custom pages, Phase B+)
  spatial/
    contract.js         v3 constants + required room states/transitions
    validate.js         Show definition validator
    clock.js            System / Manual / Scaled clocks — the one show clock
    runtime.js            SpatialRuntime — load/start, fan-out, spawn, event log
    room-actor.js          XState room actors (activate / release / exit policy)
    guest.js               Per-guest state + visit history
    guest-actor.js         Eligibility + what happens when a guest walks in
    eligibility.js         Pluggable eligibility strategies
    walkthrough.js         Auto-walking simulated guests (server-side)
    coordinator.js        OccupancyCoordinator — room occupancy, hysteresis, dwell, locks, contact loss
    virtual-location.js   Floor-plan → desired occupancy
    zone-math.js          Point-in-polygon, centroids, floor-plan extent
    __tests__/          Unit tests
public/                 Phone client + custom-pages kit (Phase B+)
custom-pages-kit/       Standalone custom page dev (unchanged)
```

## Phase A exit criteria

The full behavioural matrix — eligible entry, ineligible entry, second entrant,
capacity, exit/reset, revisit, drift into cursed — demonstrable by dragging dots
on the floor plan, with no phones and no hardware. Everything except capacity
(A5) and drift (A7) is demonstrable today.

## Carried over from v0.2

Clock sync, WebSocket transport, session tokens, custom-pages kit, peer relay,
built-in phone pages (Phase B).

## Removed

v1/v2 `ShowRuntime`, workshop show JSON, room-assignment operator commands
(`assignZone`, `forceRoomState`, …) — replaced by spatial model in v0.3.
