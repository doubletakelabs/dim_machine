# Interactive Theater Show-Control Platform — Technical Specification

**Version:** 0.3 (Rebuild — spatial model)
**Date:** August 2026
**Revised:** August 2026 — binary occupancy. The passing-by glitch effect and the
`approach` tier are removed; room presentation states are reduced to
`idle` / `active` / `settling`; revisit variants are driven by the activating
guest's history rather than by room-side memory. See §17.
**Supersedes:** v0.2 (Phase 1 workshop platform, repo `dim_machine`)
**Status:** Design draft for rebuild. See §16 for what carries over from `dim_machine` and what is replaced.

---

## 1. Overview

A distributed show-control platform for interactive, room-based theater. Audience members move through a physical space carrying a phone. Each guest is assigned a **golden path** — a personalized route through a subset of rooms — and their phone delivers an audio tour that guides them along it. Rooms contain projection, lighting, screens, audio, and practical effects. When an eligible guest enters a room, they activate it: the room's physical presentation runs, their phone audio shifts to that room's content, and in-room interactivity becomes available. A guest who enters a room that is *not* on their path gets that room's declared ineligible response, and the room itself does not change. The system tracks what each guest has seen, so returning to a space behaves differently the second time.

The platform is designed to run this specific installation while remaining general enough for other flow shapes — different eligibility rules, different room behaviors, different location technologies.

### 1.1 What changed from v0.2 and why

v0.2 offered two mutually exclusive runtime modes: one actor per guest (v1) *or* one actor per room (v2). Neither can express this show. The defining behavior — a guest entering a room that is not on their path receives a response on their phone, **while the room's own state does not change** — requires a guest and a room to react differently to the same spatial event, at the same time. The multi-guest cases are the same shape: a second entrant to a running room may get a distinct phone experience while the room holds. v0.3 therefore runs **room actors and guest actors concurrently and always**, with occupancy modeled explicitly as the relation between them.

This is a rebuild of the runtime core. Transport, clock sync, cue player, session resilience, custom pages, and the operator panel largely carry over (§16).

### 1.2 Core capabilities

- Concurrent per-room and per-guest statecharts, with an explicit occupancy relation between them
- Golden paths: per-guest room eligibility, with a pluggable eligibility predicate
- Show phases (free roam → directed convergence → exit), scoping eligibility and guidance
- Path adherence tracking: golden / drifting / cursed, with divergence detected from movement
- Binary occupancy (inside / outside a room) with asymmetric entry and exit confirmation
- Per-room policy for eligible and ineligible entry, driving distinct behaviors from one spatial event stream
- Room activation locking, with defined behavior for subsequent entrants including multi-guest collaborative states
- Per-room policy for audio timing, exit/reset, and revisit behavior
- Per-guest visit history with dwell-based "seen" semantics
- Location-source abstraction: BLE beacons, future BLE RTLS, QR, operator push, and virtual walkthrough all produce identical events
- Output adapter layer for room presentation (TouchDesigner, DMX, or stub)
- Synchronized phone audio/video/haptics with join-in-progress
- Operator GUI with live control and a floor-plan virtual walkthrough for testing without hardware

### 1.3 Guiding principles

1. **Logic as data.** Shows are serializable JSON interpreted at runtime — never hardcoded.
2. **Everything is an event.** All inputs normalize to one canonical format before reaching show logic.
3. **Location technology is a deployment detail.** Nothing above the adapter layer knows whether a zone event came from a beacon, an RTLS solve, a QR scan, or an operator dragging a dot on a floor plan.
4. **Rooms own presentation; guests own eligibility and history.** Rooms stay reusable across shows because they never encode who is allowed in.
5. **Thin clients.** Devices sync a clock, preload assets, render cues, report inputs.
6. **Schedule, don't trigger.** Cross-device sync uses timestamped future cues against a shared clock.
7. **The physical layer cannot fork.** One room has one set of lights. Per-guest differences are expressed on the phone.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      OPERATOR / DIRECTOR                        │
│   Live control · floor plan · virtual walkthrough · authoring   │
└──────────────▲──────────────────────────────────▲───────────────┘
               │ WebSocket (control)              │
┌──────────────┴──────────────────────────────────┴───────────────┐
│                    BACKEND (Node.js / JavaScript)               │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │            Occupancy Coordinator                          │  │
│  │  who is where · dwell timers · locks · grace timers       │  │
│  └────────────▲──────────────────────────────▲───────────────┘  │
│               │                              │                  │
│  ┌────────────┴──────────────┐  ┌────────────┴───────────────┐  │
│  │  GUEST ACTORS (1/person)  │  │  ROOM ACTORS (1/room)      │  │
│  │  • golden path            │◀▶│  • presentation state      │  │
│  │  • visit history          │  │  • activation lock         │  │
│  │  • guidance + phone audio │  │  • room timeline/cues      │  │
│  │  • eligibility predicate  │  │  • in-room interactivity   │  │
│  └───────────────────────────┘  └────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Show Orchestrator — globals, show clock, cross-cutting    │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Event Bus (canonical events in / cue + output commands)   │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌───────────┐  │
│  │ LOCATION ││ LOCATION ││ LOCATION ││ OUTPUT   ││ OUTPUT    │  │
│  │ BLE      ││ QR /     ││ Virtual  ││ TD       ││ stub /    │  │
│  │ beacon / ││ manual   ││ walk-    ││ (OSC/WS) ││ DMX /     │  │
│  │ RTLS     ││ operator ││ through  ││ [later]  ││ local     │  │
│  └──────────┘└──────────┘└──────────┘└──────────┘└───────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Persistence: event log + snapshots                       │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────▲────────────────────────────────────▲─────────────────────┘
       │ WebSocket                          │ OSC / WS / DMX
┌──────┴─────────────────┐        ┌─────────┴────────────────────┐
│ Phones                 │        │ Room hardware                │
│ Android app (show)     │        │ projection, lights, screens, │
│ web browser (testing)  │        │ in-room audio, practicals,   │
│ audio · UI · inputs    │        │ in-room input devices        │
└────────────────────────┘        └──────────────────────────────┘
```

### 2.1 Technology stack

| Layer | Choice | Notes |
|---|---|---|
| Backend runtime | Node.js + JavaScript | Carried over from v0.2 |
| State machine engine | XState v5 | Room actors and guest actors are both XState actors |
| Phone transport | WebSocket (native `ws`) | Carried over |
| Location sources | BLE beacons (this install); BLE RTLS later; QR / operator / virtual for testing | All behind the location adapter (§5) |
| Room output | Adapter interface; **stub logger first**, TouchDesigner (OSC) later, DMX optional | TD deferred; abstraction is not (§8) |
| Operator GUI | React (+ React Flow for statechart views) | Floor plan is a first-class view |
| Persistence | In-memory for development; PostgreSQL event log + snapshots for production | §12 |
| Clock sync | NTP-style over WebSocket | Carried over |

---

## 3. Core Model

Three entity types run concurrently. Every spatial event is delivered to the coordinator, which updates occupancy and fans the event to the affected guest actor and room actor independently.

### 3.1 Room actors

One per physical room, spawned at show start, alive for the whole show regardless of occupancy.

**Owns:** presentation state; the activation lock; the room's audio/visual timeline; in-room interactivity.

**Does not own:** who is allowed to activate it. Rooms receive activation requests and accept or refuse based on their own state (locked, cooling down, disabled) — never based on a guest's path. This keeps room definitions portable across shows.

**Also does not own: memory of having run before.** Rooms are stateless between activations by design. What matters when someone walks in is whether *they* have seen the room, not whether anyone has — a room that reset after A's visit must still play in full for B, who has never been inside. Revisit variants are therefore driven by the activating guest's history (§3.6), carried on the activation request.

**Canonical presentation states** (rooms may add their own, and nest freely):

| State | Meaning |
|---|---|
| `idle` | Available. Idle/ambient presentation. The initial state. |
| `active` | Content running. Sub-states carry the room's beats, any intro, and any collaborative interaction. |
| `settling` | Occupancy dropped to zero; exit grace timer running (§3.5). Returns to `idle` on `RESET`. |

Rooms that want an intro or transition before their main content express it as a sub-state of `active` (`active.intro`) rather than as a separate top-level state. The runtime never advances a room on its own: every state declares how it is left, whether by an authored `after` delay, an `always`, or an event.

### 3.2 User actors

One per guest, spawned on join, alive for the whole show.

**Owns:** golden path (the ordered room set they are guided along); visit history and per-room dwell accumulation; eligibility evaluation; guidance state (which room they're being pushed toward); phone audio layer state (tour / room / ambient); phone page state; personal context.

**Eligibility** is a pluggable predicate evaluated by the guest actor, and the single most important seam in the design — it is what a future roles-based show replaces, without touching a room, the coordinator, or the location layer:

```jsonc
"eligibility": {
  "strategy": "goldenPath",     // goldenPath | all | roleBased | progressGated | custom
  "params": { "allowRevisit": true }
}
```

For this install, `goldenPath` returns true when the room is in the guest's assigned path; `params.allowRevisit: false` closes rooms already seen. `all` and `none` exist for rehearsal. Future mechanisms (earned access, role-gated, progress-gated) are new strategies here and require no changes elsewhere.

Which config applies is looked up by the guest's adherence state, falling back to `golden`, so a strayed guest can be given an entirely different predicate without special-casing at the call site.

A strategy the contract names but the runtime cannot yet evaluate is **rejected at load** rather than warned about. A predicate silently returning the wrong answer locks guests out of every room and presents as a location fault, which is an expensive thing to debug on site.

### 3.3 Occupancy Coordinator

Not a statechart — a service holding the authoritative occupancy relation and the derived facts both actor types need.

**Responsibilities:** maintain `{userId → {roomId, tier, sinceTs}}` and its inverse; apply hysteresis and debounce to raw location input (§5.2); run dwell timers for "seen" determination (§3.6); hold and release activation locks (§3.4); run exit grace timers (§3.5); fan spatial events to the relevant user and room actors.

It does **not** hold guest history, eligibility, or guidance — those belong to the guest actor. The coordinator is the natural god object in this design, and keeping it to the occupancy relation is deliberate.

Because Node is single-threaded, coordinator mutations are naturally serialized — no locking primitives are required, and lock acquisition is race-free by construction.

### 3.4 Activation and locking

**First eligible entrant locks the room.** Sequence on entry:

1. Coordinator records occupancy, notifies both actors.
2. User actor evaluates eligibility. Not eligible → no activation request; the user gets the room's ineligible response, and the room is unchanged. Eligible → send `activate{userId, seen, completed, activatedByMe}` to the room.
3. Room actor evaluates its own state. `idle` and unlocked → accept: acquire lock for `guestId`, enter `active` (or the revisit variant the request's history selects). Already `active` (locked by another) → refuse with reason `locked`.
4. On acceptance the room drives its outputs and emits state to the output adapter; the guest actor shifts phone audio to the room's content per the room's audio policy (§3.7).

Note what the activation request carries and what it does not: enough of the guest's history for a revisit variant, and nothing about their identity, path, or role. That asymmetry is what keeps rooms reusable.

**Ineligible entry is per-room policy.** This is now the *only* place the show distinguishes "this room is yours" from "this room is not," so it carries real weight. A guest entering a room not on their path (and not cursed into eligibility) gets that room's declared response:

```jsonc
"ineligible": {
  "policy": "ignore",          // ignore | ambientOnly | lockedMessage | tease
  "audio": "library-locked"    // for message/tease policies
}
```

| Policy | Behavior |
|---|---|
| `ignore` | Nothing. Room unchanged, no audio change. Simplest, but can read as a broken beacon |
| `ambientOnly` | Subtle presence bed — signals "something is here, but not for you" without narration |
| `lockedMessage` | Explicit narration that this room is not on their path |
| `tease` | A distinct enticement variant — useful where the room is on *another* path and the show wants to seed curiosity |

In every case the room actor's state is untouched: no lock, no activation, no room history. The response is entirely on the phone.

Rooms may declare different policies by adherence state (a cursed guest may find `lockedMessage` rooms suddenly open — see §4.3).

**Subsequent entrants** while a room is locked and `active` are governed by per-room policy:

```jsonc
"multiGuest": {
  "policy": "collaborative",     // collaborative | spectator | personalVariant | refuse
  "maxOccupants": 6,
  "atCapacity": "spectator"      // spectator | refuse | queue | personalVariant
}
```

Capacity is separate from the lock and also per room: `maxOccupants` caps active participation, and `atCapacity` declares what an eligible arrival gets once it is reached. A collaborative puzzle room may cap participation at four and make further arrivals spectators; a tight physical space may `refuse` outright.

| Policy | Behavior |
|---|---|
| `collaborative` | Entrant joins the room's current state as a guest. Room may transition to a collaborative sub-state on second occupant. In-room interactivity accepts input from all occupants. |
| `spectator` | Entrant joins in progress: phone audio syncs to the room's running timeline (§3.7), but their inputs are ignored by the room. |
| `personalVariant` | Room presentation unchanged; entrant's phone plays a variant track (e.g., "you arrived late / someone else is inside"). |
| `refuse` | Entrant is told the room is occupied and guided onward. |

The lock holder is tracked so that lock release is distinguishable from other occupants leaving.

**Lock release on exit.** When the lock holder leaves, the lock releases — it is not retained for a step-out window. Protection against a guest hovering at a boundary and repeatedly dropping the room comes from **location hysteresis** (§5.2), not from lock stickiness: an exit only registers once the exit threshold and hold time are satisfied, so brief signal noise or a step toward the doorway does not count as leaving. If the room still has other occupants when the holder departs, the lock transfers to the longest-present remaining occupant rather than the room resetting under them.

**Only eligible occupants count.** A guest standing in a room that is not theirs is physically present but received the room's `ineligible` response, and the room never changed for them (§3.4) — so they are not a candidate to inherit the lock, and their presence does not keep the room running. If the departing holder was the last *eligible* occupant, the room applies its exit policy even though a body remains. This is the same distinction `maxOccupants` uses: capacity counts participation, not bodies.

A room in `active` with no lock holder is incoherent — the lock is what says a room is somebody's. So when the last occupant leaves, the room receives `RELEASE` and must leave its activated states. This is a load-time requirement on every room machine, not a convention.

### 3.5 Exit and reset

Exit behavior is **per room**, defaulting to a **10-second reset grace**:

```jsonc
"exit": {
  "policy": "resetAfter",      // resetAfter | finish | hold | resetImmediate
  "graceMs": 10000,
  "audioOnExit": "fadeOut",    // fadeOut | continue | cut
  "resumeIfReturned": true
}
```

| Policy | Behavior when occupancy → 0 |
|---|---|
| `resetAfter` *(default)* | Release the lock and enter `settling`, running the `graceMs` timer. Timer completes → `RESET` → `idle`. Occupant returns before it fires → cancel the timer and `RESUME` (see below). |
| `finish` | Release the lock but leave the machine running, so the content plays out to its own end in an empty room. When it reaches `settling` by itself, the grace timer runs as usual. For rooms whose visuals should complete. |
| `hold` | Freeze in place indefinitely until someone returns or the operator intervenes. **The lock is retained** for the departed holder — the one documented exception to release-on-exit (§3.4), because a room frozen mid-content is still theirs and must not be activatable by someone else. |
| `resetImmediate` | As `resetAfter` with `graceMs: 0`. |

**The grace timer belongs to `settling`, not to the departure.** Any route into
`settling` starts it: occupancy dropping to zero, an authored transition at the
end of the room's content, or an operator forcing the state. This is what makes
`finish` fall out of the model rather than needing its own timer, and it means a
room can never be left sitting in `settling` with nothing scheduled to move it.

**Arrival during grace interrupts the settle.** A settling room has not reset,
so an arriving eligible guest takes it rather than waiting out a timer they
cannot see. The reset is cancelled and the lock passes to them. Two distinct
routes back into `active`:

- **The guest who just left** gets `RESUME` (when `resumeIfReturned` is set) — it
  is still their session, handed back where it was.
- **Anyone else** gets an ordinary `ACTIVATE`, because they have seen none of it;
  the same revisit resolution applies as for any activation (§3.6).

A room is interruptible exactly when its `settling` state declares a transition
for the activation event. One that does not is refused, and stays winding down.
Presentationally this is where a crossfade belongs rather than a cut — the
output intent carries `previousState` so an adapter can tell. The machine declares where `RESUME` goes, so "resume from
the same point" is the author's decision — validated at load, because a room
that promises resumption without declaring `RESUME` would silently reset
instead. Restoring the *audio* position within the room's timeline is a separate
concern, handled on the phone (§3.7) in Phase B.

**Freeing up with somebody still inside** is a separate, per-room question. A room whose content ends under its own steam resets at the feet of anyone still standing in it — they never left, so no arrival fires and nothing offers it to them.

```jsonc
"whenAvailable": { "policy": "wait" }    // wait | activate
```

`wait` leaves the room idle until somebody walks in; `activate` plays it again for the longest-present eligible occupant, the same ordering lock succession uses. This is per room rather than global because replaying for whoever is present is right for an ambient space and wrong for a narrative one.

`audioOnExit` governs the departing guest's phone independently of the room, so a guest can walk out with the audio fading behind them while the room itself holds.

**Timers in empty rooms:** `settling` and `finish` timers run regardless of occupancy, and authored `after` transitions inside `active` keep running in an empty room. There is no pause flag: XState cannot pause a delayed transition, and the honest alternative is a room-authoring pattern — a room whose content must hold for an absent guest drives its beats from runtime events rather than `after`, and those the runtime can pause.

### 3.6 Visit history and "seen"

A room counts as **seen** when a guest accumulates **dwell inside past a per-room threshold**:

```jsonc
"seen": { "dwellMs": 20000, "accumulate": true }
```

`accumulate: true` sums separate visits toward the threshold; `false` requires one continuous stay. The coordinator runs dwell timers and emits `room.seen{guestId, roomId}` when crossed; the guest actor records it.

Per-user, per-room history record:

```jsonc
{ "roomId": "library", "firstEnteredAt": 1723...,
  "totalDwellMs": 34500, "visits": 2,
  "seen": true, "completed": false,      // completed = room signaled a completion state
  "activatedByMe": true }
```

**Revisit behavior** is driven from this record, and only from this record. The relevant flags ride on the activation request, and a room may declare variants keyed to them:

```jsonc
"revisit": {
  "whenSeen":      { "enterState": "active.abbreviated" },
  "whenCompleted": { "enterState": "active.epilogue" }
}
```

Two distinct histories matter, both per-guest: **this guest has seen this room**, and **this guest activated it themselves**. A third — *the room has been activated before, by anyone* — was considered and deliberately rejected. It produces the wrong result in the common case: after A visits the library and it resets, B walking in for the first time would get the already-seen variant of a room they have never been inside. The room has no memory of its own.

This does mean that when two guests with different histories are in a room together, the room can only present one way. The physical layer cannot fork (principle #7), so the tiebreak is defined: the **activating guest** — the lock holder — selects the variant. Differences between the two guests beyond that live on their phones.

`enterState` targets are validated at load against the room's own machine, so a variant that names a state which does not exist fails to load rather than silently doing nothing.

### 3.7 Audio timing policy

Per room, because the right answer differs by room:

```jsonc
"audio": {
  "timing": "masterTimeline",   // masterTimeline | perGuest
  "joinPolicy": "inProgress",   // inProgress | waitForNext | restart
  "minRemainingMs": 20000       // below this, use lateArrival variant instead
}
```

- **`masterTimeline`** — a single timeline starts on room activation; all occupants' phone audio is scheduled against it (`startAt` + offset), so projection cues stay aligned to audio for everyone. Late entrants join in progress by seeking to `now − startAt`. Use for rooms with synchronized visuals.
- **`perGuest`** — each guest's audio starts when they enter. Occupants are out of phase; visuals must not be audio-locked. Use for narration-led rooms without tight visual sync.
- `minRemainingMs` guards the "arrives at 2:50 of a 3:00 piece" case by routing to a late-arrival variant instead of ten seconds of tail.

---

## 4. Paths, Phases, and Adherence

### 4.1 Show phases

The guest journey is structured into **phases**, which scope both eligibility and guidance. Phases are a property of the guest actor (guests may progress independently), and may also be advanced show-wide by the orchestrator.

```jsonc
"phases": [
  { "id": "roamA",   "mode": "freeRoam", "rooms": "pathAssigned",
    "advanceWhen": { "scope": "guest", "seenCount": 3 } },
  { "id": "roamB",   "mode": "freeRoam", "rooms": "pathAssigned",
    "advanceWhen": { "scope": "guest", "seenCount": 3 } },
  { "id": "converge","mode": "directed", "target": "controlRoom",
    "advanceWhen": { "scope": "show", "entered": "controlRoom" } },
  { "id": "exit",    "mode": "directed", "target": "egress" }
]
```

`advanceWhen.scope` is required and says **who evaluates the condition**:
`guest` advances each guest at their own pace; `show` has the orchestrator move
everyone together. It is declared rather than inferred because the right answer
changes per show and per rehearsal — a test run often wants everyone pushed
forward at once where the real show does not.

For this installation: two free-roam phases where guests explore their assigned rooms at will, then a `directed` phase where the tour audio pushes them toward the control room, then exit. `mode` distinguishes free exploration (guidance suggests, guest chooses) from directed movement (guidance insists on one target). Other installations may use a single phase, or fully ordered sequences.

### 4.2 Golden path assignment

```jsonc
"paths": {
  "assignment": { "strategy": "roundRobin", "at": "onJoin" },
  "definitions": {
    "pathA": { "rooms": ["library", "greenhouse", "cellar"],
               "guidance": "goldenPath" },
    "pathB": { "rooms": ["parlor", "greenhouse", "attic"],
               "guidance": "goldenPath" }
  }
}
```

- **Assignment** at join: `roundRobin`, `random`, `manual` (operator), or `balanced` — which staggers starting rooms to spread occupancy and reduce lock contention. At ~20 guests across many rooms, contention is not expected and `balanced` is unnecessary; it remains available for denser installations.
- **Guidance** declares what the tour audio does, and is a guest-actor concern — pushing someone toward a room is phone audio driven by guidance state. Rooms are not involved.

| Guidance | Behavior |
|---|---|
| `goldenPath` | An ordered route the audio leads them along. "Next" is simply the next unvisited room in the list — no distance metric, no adjacency graph, and no wayfinding promise the geometry cannot keep |
| `guestDirectedPath` | The audio follows the guest rather than leading. Both authorable from the start and where a guest who ignores a golden path lands |
| `freeExplore` | No guidance |

Because `goldenPath` is ordered by definition, a separate `ordered` flag is unnecessary and was removed. Note that `goldenPath` and `guestDirectedPath` are also the two ends of the adherence model (§4.3): guidance mode is what an adherence state *does*.
- Paths may overlap arbitrarily; shared rooms are expected and are where the multi-guest policies (§3.4) matter.

### 4.3 Path adherence: golden and cursed

Guests who ignore the audio guide are not errors to be corrected — the divergence is itself a designed experience. The guest actor therefore tracks an **adherence state** alongside the path.

```
   ┌─────────┐  drift signals accumulate   ┌──────────┐   threshold   ┌────────┐
   │ golden  │ ─────────────────────────▶  │ drifting │ ────────────▶ │ cursed │
   └─────────┘ ◀───────────────────────── └──────────┘ ◀───────────── └────────┘
                    compliance signals              (per redemption policy)
```

**Drift signals** are evidence the guest is not following guidance. Each contributes a weighted score; the show defines thresholds:

```jsonc
"adherence": {
  "signals": {
    "ineligibleRoomEntered":   { "weight": 25 },   // entered a room not on their path
    "guidanceIgnoredMs":       { "weight": 10, "per": 60000 },
    "guidedRoomBypassed":      { "weight": 20 },   // entered a different room while directed to one
    "roomExitedEarly":         { "weight": 5 }
  },
  "compliance": {
    "eligibleRoomSeen":        { "weight": -30 },
    "guidedRoomEntered":       { "weight": -40 }
  },
  "thresholds": { "drifting": 30, "cursed": 75 },
  "redemption": { "policy": "reversible", "hysteresisMs": 30000 },
  "cursedIsSticky": false
}
```

Signals are deliberately weighted and cumulative rather than a single trigger, because one wrong turn is not a decision — a pattern is. Hysteresis on the return path prevents flapping between states.

**What changes when cursed.** Adherence state is available to eligibility, guidance, room behavior, and audio:

| Dimension | Golden | Cursed |
|---|---|---|
| Eligibility | `goldenPath` — assigned rooms | Per show: `inverted` (previously ineligible rooms become active), `all`, or `none` |
| Guidance audio | Tour narration toward next room | Cursed variant — different voice, different intent, may misdirect |
| Room presentation | Standard states | Rooms may declare `cursedVariant` entry states |
| Ineligible entry | Room's declared policy | May be inverted — rooms that were closed become open, and vice versa |
| Phase advance | Normal `advanceWhen` | May use separate criteria, or route to a different phase |

```jsonc
// Per-room cursed handling
"library": {
  "cursed": { "enterState": "active.inverted", "audio": "library-cursed",
              "allowActivation": true }
}
```

Because eligibility is already a pluggable predicate (§3.2), the cursed path costs no structural change — it swaps the strategy and consults adherence state. `cursedIsSticky: true` makes the transition one-way for shows where the fall should be permanent; `reversible` lets compliance earn a return to golden.

**Operator controls.** Live adherence score and state per guest, with manual force to golden/cursed/drifting and score reset — essential during tuning, since the weights above will need calibration against real audience behavior.

**Detection caveat.** Adherence inference is only as good as the location data feeding it, and binary occupancy constrains what can be inferred. There is no heading and no proximity, so any signal of the form "moved the wrong way" or "came close and turned back" is unavailable — `wrongDirectionSustained` was removed for exactly this reason.

What survives is stronger anyway, because all of it is founded on room entry, which is the one thing the location layer reports unambiguously. `guidedRoomBypassed` is re-founded on entry rather than proximity: *directed to the library, entered the cellar instead*. That is a decision, not a near-miss, and it needs no approach detection to observe.

Start with `ineligibleRoomEntered` and `guidanceIgnoredMs`, which are the least ambiguous of all, and add the others once real audience behavior is available to calibrate against.

---

## 5. Location Layer

### 5.1 Canonical spatial events

Every location source produces only these:

```jsonc
{ "type": "zone.occupancy",            // the single spatial event type
  "userId": "u-123",
  "zoneId": "library",
  "tier": "inside",               // outside | inside
  "previousOccupancy": "outside",
  "previousRoomId": null,
  "confidence": 0.86,
  "source": "ble",                // ble | rtls | qr | operator | virtual | nfc
  "timestamp": 1723000000000 }
```

Nothing downstream inspects `source`. This is what makes manual testing free.

A guest is never recorded as being in two rooms at once: moving between rooms commits an exit from the first before an entry to the second.

### 5.2 Occupancy, hysteresis, and debounce

Two tiers — `outside` and `inside`. The show asks exactly one spatial question: is this person in this room? An earlier three-tier model (`far` / `approach` / `core`) existed to support a passing-by audio effect, and was removed with it (§17).

BLE RSSI is noisy, so entry and exit are both confirmed, and deliberately **asymmetrically**:

- **Threshold gap.** Separate enter and exit RSSI thresholds, so a guest standing at a boundary does not oscillate between states.
- **Different hold times.** Entry is held longer than exit is, because entry's consequences are expensive — locking a room and committing the physical layer — while a confirmed exit only starts a grace timer that a returning guest cancels (§3.5).

Zones are declared **inside the room they belong to**, and a room may own more
than one — a gallery split by a structural wall, an alcove off the main space.
Occupancy is reported for the *room*, so crossing between a room's own zones is
not an exit and does not disturb it.

```jsonc
"rooms": {
  "library": {
    "zones": {
      "library-main":   { "polygon": [[x,y], ...] },
      "library-alcove": { "polygon": [[x,y], ...] }
    },
    "location": { "entryConfirmMs": 1500, "exitConfirmMs": 800 },
    "ble": { "beacons": ["b-14"], "rssiEnter": -62, "rssiExit": -70 }
  }
}
```

Zone ids are unique show-wide, not merely within a room, so an event is never
ambiguous about which room it concerns.

All tuning lives in the show definition, editable per venue without code changes. Expect these numbers to be re-tuned on site; that is normal and the reason they are data.

Dropping the middle tier removes the hardest part of on-site BLE calibration: distinguishing "near" from "medium" over RSSI was always going to be the least reliable boundary, and no behavior depends on it any more.

### 5.3 Sources

| Source | Use | Notes |
|---|---|---|
| **BLE beacons** | This install | Android app scans, reports RSSI per beacon; adapter applies §5.2 and emits tier events |
| **BLE RTLS** | Future | Emits positions; adapter runs point-in-polygon against floor-plan zones. Drop-in replacement — no show changes |
| **QR** | Testing / fallback | A scan emits `inside` directly, with a synthetic exit after a timeout or a "leave" tap |
| **Operator** | Testing / rehearsal / recovery | Manual placement of any guest in any room |
| **Virtual walkthrough** | Testing / design | Drag user dots on the floor plan; the coordinator generates real tier events (§5.4) |
| **Phone-tap self-report** | Testing on personal devices | Test-mode UI: "I'm in the Library" / "I'm leaving" |

### 5.4 Testing without hardware

Explicit requirement, and it comes free from §5.1 — the runtime cannot tell these apart from BLE.

- **Virtual walkthrough** (operator GUI): a floor plan with draggable dots per guest. Dragging generates `zone.occupancy` events with correct hysteresis, so it exercises the real code path. Doubles as rehearsal tool and design-time simulation.
- **Browser test mode**: guests on their own phones in a browser get a zone-selection UI instead of BLE. Same events, same show, no app install.
- **Scripted walkthroughs**: recorded or authored movement sequences replayed at speed for regression testing (e.g., "two users, overlapping paths, both enter Library within 2s" — the arbitration case that's hard to stage by hand).
- **Mixed mode**: BLE devices and virtual users in the same running show, so you can test a full room with three real phones and twelve simulated ones.

---

## 6. Client Layer

### 6.1 Clients

| Client | Role | Location capability |
|---|---|---|
| **Android app (show device)** | Provided to guests | BLE scanning (and RTLS later), background audio, foreground service |
| **Web browser (testing)** | Development, rehearsal, guest-owned phones | No BLE — uses test-mode zone selection, QR, or virtual placement |

Both speak the identical protocol and render the identical cue/page vocabulary. The app is a shell around the same cue player plus a BLE scanning service.

### 6.2 Phone audio layers

Audio is layered rather than a single stream, because tour guidance, room content, and transit beds coexist:

| Layer | Content | Behavior |
|---|---|---|
| `tour` | Golden-path guidance narration | Ducks under the room layer |
| `room` | Active room content | Scheduled per the room's audio policy (§3.7) |
| `ambient` | Transit beds | Lowest priority |

Mixing rules (duck amounts, crossfades, priority) are show-level configuration.

### 6.3 Cue player

Carried over from v0.2: clock sync, `startAt` scheduling, Web Audio scheduling, join-in-progress seek, preload, capability manifest, session token + snapshot resync. Adds: layered audio bus and room-timeline join.

### 6.4 Inputs

Two tiers as in v0.2 — page-local versus promoted to events — with promoted inputs now carrying a **scope** determined by the input binding:

```jsonc
"inputBindings": {
  "shake":            { "event": "torch.shake", "scope": "user" },
  "button:activate":  { "event": "mechanism.pull", "scope": "room" }
}
```

`scope: "room"` routes to the room actor the user currently occupies (ignored if they occupy none, or if `multiGuest.policy` is `spectator`). `scope: "user"` routes to their own actor. In-room physical devices (buttons, sensors) emit room-scoped inputs directly via MQTT/adapter without a phone involved.

### 6.5 Pages and custom pages

Built-in declarative pages plus the drop-in custom-page mechanism carry over from v0.2 unchanged (`DIM.registerPage`, `DIM.emit`, `DIM.relay`, `DIM.vars`, `DIM.pageAsset`). Two hardening items are folded in (§16.3): error isolation around page render, and a teardown hook on page swap.

---

## 7. Show Orchestrator and Global State

The orchestrator owns the show clock, global variables, and cross-cutting concerns (show start/stop, hold, global cues). Global variables are **server-owned maps**, read synchronously and written serially — Node's single thread makes this race-free without the replica/re-validation machinery described in v0.2 §3.4, which is dropped.

Aggregate conditions ("all users have seen ≥ 3 rooms", "no room active for 60s") are computed by the orchestrator over coordinator state and may drive show-level transitions such as moving to a finale.

---

## 8. Output Layer

### 8.1 Adapter interface

Room actors emit **output intents**, not device commands:

```jsonc
{ "type": "roomOutput", "roomId": "library",
  "state": "active.beat2",
  "cues": [ { "id": "proj-lib-2", "medium": "projection" },
            { "id": "lights-warm", "medium": "lighting", "params": { "fadeMs": 1200 } } ],
  "timelineStartAt": 1723000000000 }
```

Adapters translate intents to their transport. Multiple adapters may run simultaneously.

| Adapter | Status | Transport |
|---|---|---|
| **Stub logger** | Build first | Console/GUI display of what *would* fire — full development without any room hardware |
| **TouchDesigner** | Later | OSC out (`/room/<id>/state`, `/room/<id>/cue/<cueId>`), OSC/WS in for room sensors |
| **DMX / lighting** | Optional | Direct, if bypassing TD is preferable for lights |
| **In-room audio** | Later | Local playback or via TD |

Because rooms model presentation state regardless of adapter, deferring TouchDesigner costs nothing structurally — but the **abstraction is not deferred**, or the entire room layer would need retrofitting.

### 8.2 In-room input devices

Physical devices in rooms (buttons, sensors, props) connect over MQTT or via TD, and their events enter the bus as room-scoped inputs (§6.4). They are peers of phone inputs, not a separate mechanism.

---

## 9. Show Definition Schema (sketch)

```jsonc
{
  "showId": "the-house",
  "contractVersion": 3,
  "rooms": {
    "library": {
      "machine":    { /* XState statechart: idle / active / settling */ },
      "multiGuest":  { "policy": "collaborative", "maxOccupants": 6, "atCapacity": "spectator" },
      "ineligible": { "policy": "ambientOnly" },
      "exit":       { "policy": "resetAfter", "graceMs": 10000, "audioOnExit": "fadeOut" },
      "audio":      { "timing": "masterTimeline", "joinPolicy": "inProgress", "minRemainingMs": 20000 },
      "seen":       { "dwellMs": 20000, "accumulate": true },
      "revisit":    { "whenSeen": { "enterState": "active.abbreviated" } },
      "cursed":     { "enterState": "active.inverted", "allowActivation": true },
      "outputs":    { "cues": { /* projection, lighting, in-room audio */ } }
    }
  },
  "zones":   { /* §5.2 — per-source entry/exit thresholds + floorplan polygons */ },
  "user":    {
    "machine": { /* guidance, transit, personal side paths */ },
    "eligibility": { "golden": { "strategy": "goldenPath" },
                     "cursed": { "strategy": "inverted" } },
    "audioLayers": { /* §6.2 mixing rules */ }
  },
  "phases":    { /* §4.1 — roamA, roamB, converge, exit */ },
  "paths":     { /* §4.2 */ },
  "adherence": { /* §4.3 — drift/compliance signals, thresholds, redemption */ },
  "globals":   { /* orchestrator-owned */ },
  "inputBindings": { /* §6.4 */ }
}
```

---

## 10. Operator GUI

**Floor plan (primary view).** Rooms rendered with live presentation state and lock holder; guest dots with tier and current room; drag-to-move for virtual walkthrough (§5.4); click a room to force state, release lock, or disable it.

**Guest inspector.** Golden path with progress, visit history and dwell, current audio layers, device telemetry (battery, RSSI, sync quality, connection).

**Room inspector.** Current state, occupants, lock holder, elapsed timeline, pending output cues, manual state override with output hygiene (§16.3).

**Statechart views.** Room and user machines rendered as graphs with live state highlighting (React Flow), shared with the authoring tool.

**Test controls.** Virtual walkthrough, scripted walkthrough playback, mixed real/simulated guests, spawn N simulated users on paths.

---

## 11. Connection Resilience

Carried over from v0.2 §7 (session token in cookie + `localStorage`, actor lifecycle independent of socket, snapshot resync as authoritative backstop, heartbeats, scheduled cues self-healing on rejoin). Additions for the spatial model:

- Snapshot includes occupancy, current room state and timeline offset, audio layer state, and visit history — a reconnecting guest resumes mid-room correctly.
- **Location loss ≠ presence loss.** A phone that stays connected but stops reporting beacons is *unlocated*, not *departed*. Configurable per show: hold last known zone for N seconds, then treat as `outside` (which starts exit grace) or flag for the operator. Getting this wrong would drop rooms out from under stationary guests.
- Disconnect while holding a room lock: lock is held for a grace period, then released so the room isn't stranded.

---

## 12. Persistence

- **Event sourcing** — all canonical events, transitions, activations, and occupancy changes appended to a log. Enables crash recovery, replay, and post-show analytics (path completion, dwell distributions, room utilization, activation contention).
- **Snapshots** of orchestrator, all room actors, all guest actors, and coordinator occupancy, at intervals and at significant transitions.
- **Development** may run in-memory; production targets PostgreSQL with < 10s recovery.

---

## 13. Non-Functional Requirements

| Concern | Target |
|---|---|
| Scale | ~50 guests, ~10–15 rooms, single show at a time |
| Deployment | Fully local to venue; single on-site machine; no cloud dependency at show time |
| Audio sync (same room, master timeline) | ≤ 50 ms skew |
| Zone event → room output | ≤ 200 ms for confirmed room entry (after the entry hold) |
| Recovery after backend restart | ≤ 10 s |
| Network | Dedicated venue WiFi; BLE scanning on the app is independent of WiFi |

---

## 14. Implementation Phases

### Phase A — Spatial core
Room actors + guest actors + occupancy coordinator running concurrently. Activation, locking (incl. transfer and release), capacity, exit grace, dwell/seen tracking, per-room ineligible policies. Phase progression. Adherence scoring with the two strongest signals. Virtual walkthrough as the only location source. Stub output adapter. **Exit criteria:** the full behavioral matrix (eligible entry, ineligible entry, second entrant, capacity, exit/reset, revisit, drift into cursed) demonstrable by dragging dots on a floor plan, with no phones and no hardware.

### Phase B — Phones and audio
Layered phone audio; room timeline join-in-progress; guidance/tour layer including cursed guidance variant; per-room ineligible-entry audio; golden path assignment; browser test mode with self-reported zones. **Exit criteria:** a walkthrough with real phones on browser test-mode zones produces correct audio behavior end to end, including a deliberate divergence run that lands the guest on the cursed path.

### Phase C — BLE and the Android app
Android app with beacon scanning; RSSI → tier adapter with tunable hysteresis; on-site threshold tuning; mixed real/virtual guests. **Exit criteria:** a guest walking the space triggers rooms reliably, with false-activation and missed-activation rates measured and tuned.

### Phase D — Room outputs
TouchDesigner adapter (OSC bidirectional); in-room devices over MQTT; room sensors as room-scoped inputs. **Exit criteria:** a room's presentation runs end to end from guest entry.

### Phase E — Production hardening
Event sourcing + PostgreSQL; operator auth; full authoring GUI; scripted walkthrough regression suite; load test at 50 guests; BLE RTLS adapter if adopted; venue runbook.

---

## 15. Resolved Decisions and Open Items

### 15.1 Resolved

| Question | Decision |
|---|---|
| Ineligible entry | **Per room** (§3.4) — `ignore` \| `ambientOnly` \| `lockedMessage` \| `tease`, and may vary by adherence state |
| Path completion / journey shape | **Phases** (§4.1). This install: two free-roam phases → directed convergence on the control room → exit. Other installs configure differently |
| Contention at scale | ~20 guests across many rooms; contention not expected. `balanced` assignment available but unnecessary here |
| Room capacity vs. lock | **Per room** — `maxOccupants` + `atCapacity` (`spectator` \| `refuse` \| `queue` \| `personalVariant`), separate from the lock |
| Lock on holder departure | **Released on exit.** Boundary-hovering is handled by location hysteresis (§5.2), not lock stickiness. Transfers to longest-present occupant if others remain |
| Path divergence | **Golden / drifting / cursed** adherence model (§4.3), reversible by default with hysteresis |
| Passing-by behavior | **Removed** (§17). The show distinguishes eligible from ineligible entry, and nothing else spatial |
| Proximity tiers | **Binary** — `outside` / `inside` (§5.2) |
| Room memory of prior activation | **None.** Revisit variants come from the activating guest's history (§3.6) |

### 15.2 Open

1. **Accessibility.** Still pending internal team discussion. This matters more in v0.3 than it did in v0.2: the show is audio-guided, so a guest who cannot hear the tour has no wayfinding at all. Options range from a visual guidance layer on the phone (next-room prompts, directional cues) to captioned room content. The cheap insurance remains adding an optional `alternatives` field to every cue now (`{ "text": "...", "haptic": "pattern-id" }`) so a later decision does not require reworking the cue library.
2. **Adherence weight calibration.** The §4.3 weights are a starting point, not a tuned model. They need real-audience calibration — the risk in both directions is real: too sensitive and curious-but-compliant guests get cursed unfairly; too lax and the cursed path never triggers. Operator override plus a live adherence readout are in scope partly to support this tuning.
3. **Cursed path scope.** How much distinct content does the cursed path warrant? Full per-room `cursedVariant` states across every room is a large content burden. A cheaper first version is a distinct guidance voice plus inverted eligibility, with only a few rooms authored with true cursed variants.
4. **Does the audience know?** Whether the golden/cursed distinction is legible to guests (they realize they've fallen) or purely felt (the show just gets stranger) is a directorial choice with implications for how explicit the audio cues around the transition need to be.

---

## 16. Migration from `dim_machine`

### 16.1 Carries over largely intact
Clock sync and `startAt` scheduling; Web Audio cue player and join-in-progress; session token + snapshot resync; WebSocket server and operator command plumbing; built-in declarative pages; custom-page loader and kit (`DIM.registerPage`, `DIM.pageAsset`); peer relay (still valuable for in-room collaborative pages, now naturally scoped to room occupancy); operator panel patterns; show-JSON loading and inspection.

### 16.2 Replaced
The v1/v2 dual-mode runtime (`runtime.js`) — replaced by always-concurrent room + guest actors with a coordinator; contract v1/v2 → **v3**, a breaking change (v3 shows are not v2 shows); the ad-hoc room-assignment operator commands (`assignZone`, `moveAllToRoom`) → location-source events, with operator placement becoming one source among several; `sendTo: orchestrator` broadcast stub → a real orchestrator.

### 16.3 Fixes to fold in from v0.2 review
- **Cue ownership:** a looping cue started on entry to state S is owned by S and auto-stopped on exit unless declared `persistent`. This makes the orphaned-audio class of bug a runtime invariant rather than authoring discipline (the `stopRoomOutputs` / `skipActiveCues` workaround becomes unnecessary).
- **Custom page isolation:** error boundary around render, teardown hook on swap, and preserve the `DIM` hooks on merge.
- **Explicit empty-room timer semantics** (§3.5), rather than emergent behavior.

---

## 17. Revision — binary occupancy

Following a production meeting, the show's spatial vocabulary was reduced to a
single question: **is this guest in this room, and is it theirs?**

### 17.1 Removed

| Removed | Why |
|---|---|
| **Glitch-by** (former §3.8) and the `glitchBy` room block | The passing-by effect is out of the show |
| **The `approach` tier** | Its only consumer was glitch-by. Tiers are now `outside` / `inside` |
| `glitch` as an ineligible policy | Defined in terms of the passing-by bleed, which no longer exists |
| The `glitch` phone audio layer | As above |
| `wrongDirectionSustained` adherence signal | Requires heading, which binary occupancy cannot infer |
| Room states `dormant`, `activating`, `resetting`, `dormantSeen` | Replaced by `idle` / `active` / `settling`; intros become `active` sub-states |
| Room-side memory of prior activation | Produces the wrong result for a first-time visitor to a previously-run room (§3.6) |

### 17.2 What did not change, and why

**Concurrent room and guest actors remain necessary.** §1.1 originally justified
them with glitch-by. The justification is unchanged in substance: ineligible
entry has the identical structure — one spatial event, the user reacts, the room
does not — as do the multi-guest policies. The architecture was never specific to
the glitch effect; §1.1 has been rewritten to cite the case that survives.

**Hysteresis does not depend on the middle tier.** Anti-flapping comes from the
enter/exit threshold gap and asymmetric hold times, both of which work
identically with two tiers (§5.2).

**Phase C gets easier.** Reliable `approach` detection over BLE RSSI was the
least certain part of the on-site calibration, and it is now unnecessary.

### 17.3 Vocabulary pass

Names were reviewed together rather than piecemeal, on the grounds that renaming
is cheap now and expensive once the Android app and the operator UI both speak
them. Two terms had already failed in conversation (`advanceOn`,
`pauseWhenEmpty`), and one was a leftover from a deleted model.

| Was | Now | Why |
|---|---|---|
| `user` / `participant` / guest | **`guest`** everywhere | Three words for one person, across code, spec, and conversation |
| `zone.tier`, `tier` | `zone.occupancy`, `occupancy` | "Tier" implied rungs on a ladder that no longer exists |
| `insideHoldMs` / `outsideHoldMs` | `entryConfirmMs` / `exitConfirmMs` | Says what it does rather than what it produces |
| `lossHoldMs` | `contactLossMs` | Now covers a dropped socket as well as a silent beacon |
| top-level `zones` map | `rooms.<id>.zones` | Two maps with identical keys had to be hand-synced; rooms may now own several zones |
| `guidance: nearestUnseen \| operatorDirected \| free` | `goldenPath \| guestDirectedPath \| freeExplore` | Names the show's own concepts, and removes the need for a distance metric |
| `paths.*.ordered` | *removed* | Implied by `goldenPath` |
| `advanceOn` | `advanceWhen` + required `scope` | Read as a condition; who evaluates it was never stated |
| `atCapacity: queue` | *removed* | Needs "wait here" and "you're up" audio, and manufactures a hallway queue |
| `pauseWhenEmpty` | *removed* | See §3.5 — a room-authoring pattern, not a runtime flag |
| `multiUser` | `multiGuest` | Follows the guest rename |

Deliberately kept: `idle` / `active` / `settling`, `ACTIVATE` / `RELEASE` /
`RESET` / `RESUME`, the activation lock, `seen` / `completed`, and
`eligible` / `ineligible`.

### 17.4 Conditions are events, not guards

Show JSON has no guard or condition language, and will not grow one for now.
Where a room needs to behave differently, the **runtime resolves which case
applies and sends a correspondingly named event** (§3.4), leaving the statechart
holding only plain transitions.

The reasoning: the orchestrator and guest actor already own every condition
worth branching on — history, phase, adherence, aggregates over occupancy (§7).
A guard language would put conditions in a second place, and the charts read
worse for it. The cost is that authors can only branch on cases the runtime
knows how to compute; a guard evaluator remains addable later without
invalidating any show written against this rule.

### 17.5 Forward note — roles instead of paths

For future installations, golden paths may be replaced by **roles**: a
guest's role, rather than an assigned route, determines how they may
interact with a given room.

This is already accommodated and should stay that way. Eligibility is a
pluggable predicate owned by the guest actor (§3.2), and `roleBased` is an
existing strategy. A role-driven show swaps the strategy and touches no room, no
coordinator, and no location code — provided the constraints that make this
possible are preserved:

- **Rooms never encode who may enter them.** They accept or refuse on their own
  state alone. An activation request may carry facts about the guest's
  history, but never their identity, path, or role.
- **Rooms keep their own state**, independent of any guest.
- **The orchestrator stays**, owning globals, the show clock, and aggregate
  conditions across guests.

---

*End of specification.*