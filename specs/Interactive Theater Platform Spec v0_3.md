# Interactive Theater Show-Control Platform — Technical Specification

**Version:** 0.3 (Rebuild — spatial model)
**Date:** August 2026
**Revised:** August 2026, twice.
(1) Binary occupancy — the passing-by glitch effect and the `approach` tier are
removed; room presentation states reduced to `idle` / `active` / `settling`;
revisit driven by the activating guest's history rather than room-side memory
(§17).
(2) The journey — `phases` replaced by an authored per-guest statechart; paths
become a library assigned mid-show; spaces typed as destinations or hallways
with declared adjacency; off-path reduced to a one-way boolean (§18).
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
- An authored journey per guest: a statechart whose regions are location, guidance, and adherence
- Golden paths: per-guest room eligibility, with a pluggable eligibility predicate
- Paths assigned when a guest reaches the part of the show that has them, not at the door
- Off-path detection, one-way, scoped to the rooms paths actually route through
- Binary occupancy (inside / outside a room) with asymmetric entry and exit confirmation
- Spaces typed as destinations or hallways, with adjacency declared as truth about the building
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

Rooms may add states beyond these three — an intro before the content, a coda after. Every such state is the room *running for somebody*, and the runtime treats it that way: a room needs a holder unless it is `idle` or `settling`. The runtime never advances a room on its own; every state declares how it is left, by an authored `after` delay, an `always`, or an event.

**Kind.** A room is a `destination` or a `hallway`. A hallway is somewhere you pass through to reach somewhere else — always eligible, because you cannot deviate by using the only route between rooms; never counted toward `seen`; never a deviation; and exempt from the activation contract it could never satisfy. Guests still occupy it, and it is where guidance speaks.

**Adjacency.** Each room declares the spaces it physically connects to, from both sides. This does *not* gate movement — a guest can turn up anywhere, whether from a misread beacon or an operator dragging a dot, and the guest machine always has somewhere to put them (§4.1). What adjacency buys is the ability to *notice*: a move between spaces that do not connect is either a test or a location fault, and in Phase C it is the BLE misread signal.

### 3.2 Guest actors

One per guest, spawned on join, alive until the guest is terminated — when their phone is returned to the charger, or by the operator. There is always some method to terminate.

**Owns:** the journey statechart (§4.1); the assigned path, once the journey hands them one; visit history and per-room dwell accumulation; eligibility evaluation; the guidance target; phone audio layer state (tour / room / ambient); phone page state.

**Does not own** where they are. That is the coordinator's, and the guest machine mirrors it.

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
2. Guest actor evaluates eligibility. Eligible → send `ACTIVATE{guestId, seen, completed, activatedByMe}` to the room. Not eligible → the room's declared ineligible response, which is usually nothing at all.
3. Room actor evaluates its own state. `idle` and unlocked → accept: acquire lock for `guestId`, enter `active` (or the revisit variant the request's history selects). Already `active` (locked by another) → refuse with reason `locked`.
4. On acceptance the room drives its outputs and emits state to the output adapter; the guest actor shifts phone audio to the room's content per the room's audio policy (§3.7).

Note what the activation request carries and what it does not: enough of the guest's history for a revisit variant, and nothing about their identity, path, or role. That asymmetry is what keeps rooms reusable.

**Ineligible entry is per-room policy.** This is the *only* place the show distinguishes "this room is yours" from "this room is not," so it carries real weight. A guest entering a room they were not sent to gets that room's declared response:

```jsonc
"ineligible": {
  "policy": "ignore",          // ignore | ambientOnly | lockedMessage | tease | activateVariant
  "audio": "library-locked"    // for message/tease policies
}
```

| Policy | Behavior |
|---|---|
| `ignore` | Nothing. Room unchanged, no audio change. What most rooms use |
| `ambientOnly` | Subtle presence bed — signals "something is here, but not for you" without narration |
| `lockedMessage` | Explicit narration that this room is not on their path |
| `tease` | A distinct enticement variant — useful where the room is on *another* path and the show wants to seed curiosity |
| `activateVariant` | The room **does** react: it activates in its own variant state, and the guest holds the lock |

The first four leave the room actor untouched — no lock, no activation, no room history — and the entire response is on the phone. That asymmetry is what §1.1 justifies the architecture with.

`activateVariant` is the deliberate exception, and it changes what eligibility *is*: rather than gating activation, eligibility **selects which activation a room gets**. The runtime sends `ACTIVATE_OFFPATH` instead of `ACTIVATE`, and because the room is now running for that guest, they hold it. A room claiming the policy without declaring the transition fails to load.

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

None of this block is implemented. The thin layer behaves as `perGuest`-with-seek: content is timed from room state entry, and a late arrival joins where the room actually is. That is `masterTimeline`'s join behaviour without the timeline, which is indistinguishable until projection has to stay aligned to it — so §3.7 lands with the output adapters, not before. A one-shot that finished before a guest arrived is skipped rather than replayed, which is `minRemainingMs` at its crudest setting: the tail is dropped, but there is no late-arrival variant to route to.

---

## 4. The Journey

### 4.1 The guest statechart

A guest's journey is an authored statechart, one actor each, alongside one per
room. It replaces the earlier `phases` array, which could not express this show:
a guest used to get one path at the door for the whole show, and this show has a
shared prologue, a museum where paths apply, and a free-roam area after — with
guests moving freely between them.

Three parallel regions, because the facts are independent. A timer can move
guidance to `converge` while a guest stands in the Data Center, and a guest can
wander back into the museum without guidance changing its mind.

```
location                    guidance                   adherence
├─ outside                  ├─ prologue                ├─ onPath
├─ frontDesk                ├─ museum                  └─ offPath
├─ maskRoom                 ├─ converge
├─ … one per room           └─ ending
└─ library
```

| Region | Source | What it is |
|---|---|---|
| `location` | **generated** from room adjacency | One state per room, plus `outside`. The map. |
| `guidance` | **authored** | The journey. The small, readable chart an author reasons about. |
| `adherence` | **authored** | Whether they are still following what guidance asked. |

**The location region is generated, not authored.** Adjacency is already declared
on the rooms; writing it a second time as machine transitions would let the two
drift. What an author draws is the *intended journey* — the guidance region —
and that is what the diagram is for.

**The machine always matches the coordinator.** The coordinator is authoritative
about where a guest is; the location region mirrors it, without exception. The
generated region carries a transition for every room at its root, so a guest who
turns up somewhere they could not have walked to still has somewhere to be. The
adjacency transitions on each state take precedence where both apply, so the
plausible route is used whenever the move was plausible, and the recovery only
fires for the moves that should not have happened.

That is the trade this makes explicit: an authored chart shows intent, and the
running machine also handles the impossible. The recovery transitions are not
drawn, because they are error correction rather than journey — but they are one
uniform rule, stated here, rather than per-room surprises.

**Rooms are heard as `entered.<roomId>`**, dotted so `entered.*` works as a
wildcard. `exited` fires when a guest is in no room at all.

**Entry actions are declared data**, executed by the runtime — the same shape as
room output actions. `assignPath` is the one that exists today.

### 4.2 Timers the statechart cannot express

XState's own `after` measures time since a state was *last* entered. A guest who
steps out of the museum and back has left and re-entered that state, which
restarts it — so anything that must survive leaving cannot be an `after`.

```jsonc
"timers": {
  "museumTime": { "sinceEntering": "guidance.museum", "afterMs": 1800000, "event": "MUSEUM_TIME_UP" }
}
```

Total elapsed since the state was first entered, running through anything, with
the runtime delivering the event. The machine then holds a plain transition.

This is the same division as everywhere else in the model: the machine owns
simple delays, the runtime owns conditions. A cumulative variant — time actually
spent inside, pausing when they leave — would sit beside it as `whileIn`, and
does not exist yet because nothing needs it.

### 4.3 Paths

A library of named routes, referenced by `assignPath`.

```jsonc
"paths": {
  "pathA": { "rooms": ["automation", "slop", "consumption1"], "guidance": "goldenPath" },
  "pathB": { "rooms": ["saas", "kin", "consumption2"], "guidance": "goldenPath" }
}
```

**Paths are data, never structure.** That is what lets a route be assigned when a
guest reaches the part of the show that has paths rather than at the door — which
is also when there is real occupancy to spread them against — and what lets one
authored machine serve every guest, with no per-guest expansion.

| Guidance | Behavior |
|---|---|
| `goldenPath` | An ordered route the audio leads them along. "Next" is the next unvisited room in the list — no distance metric, no adjacency graph, and no wayfinding promise the geometry cannot keep |
| `guestDirectedPath` | The audio follows the guest rather than leading |
| `freeExplore` | No guidance |

A path may not route through a hallway: a route is a list of places to send
someone, not the corridors between. Paths may overlap; shared rooms are expected,
and are where the multi-guest policies (§3.4) matter.

### 4.4 Eligibility

A pluggable predicate owned by the guest actor, and the single most important
seam in the design — it is what a roles-based show replaces (§17.5).

```jsonc
"eligibility": { "golden": { "strategy": "goldenPath", "params": { "allowRevisit": true } } }
```

`goldenPath` returns true when the room is on the guest's assigned path — **but
only among the rooms paths actually route through**. That qualifier is load-
bearing. A show is rarely paths end to end: this one has a shared prologue, a
museum where paths apply, and free-roam after, and only the museum rooms appear
in any path. Treating an unrouted room as "not yours" would make the entrance
sequence ineligible for everybody, and would lock every guest — none of whom has
a path yet — out of the whole prologue.

Hallways are always eligible. A strategy the contract names but the runtime
cannot evaluate is rejected at load, because a predicate silently returning the
wrong answer locks guests out of every room and presents as a location fault.

### 4.5 Going off-path

Guidance holds two values per guest: the **target** — the next unvisited room on
their assigned path — and whether they are **following** it. The second is the
adherence region, and it is deliberately a boolean rather than a score.

An earlier draft specified weighted drift signals, thresholds at 30 and 75, a
redemption policy and hysteresis. That machinery answered a question the show
does not ask. What the show needs is whether the guest is following the path set
for them, so:

```
onPath ──(entered a routed room that is not theirs)──▶ offPath
```

**One way.** The tour goes off the rails and stays off; walking back onto the
path does not restore it.

**Scoped to routed rooms.** Going off-path only means anything among the rooms
paths route through — the part of the show where a path is being led. Backtracking
to an earlier room, or walking down a corridor, is not a deviation, because there
is no path there to deviate from.

If a pattern rather than a single wrong turn later proves to be the right model,
the scoring goes back on top of the same event stream. Nothing is foreclosed —
but building it speculatively would ship a calibration burden for a distinction
the show does not currently make.

**Operator controls.** Live standing and journey state per guest, with manual
override, remain in scope for tuning.

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

**Built, thinly.** A guest hears at most one cue from each of three fixed slots — `room`, `guidance`, `adherence` — with a later cue in a slot replacing what was there. That is enough for guidance to speak over an ambient room without either cutting the other, and it is not yet a mixer: the duck amounts, crossfades and priorities below are still show-level configuration nobody reads. Authoring lives in CONTRACT.md §8.1.

The layer that carries the design weight is `room`, because which cue a guest gets is chosen from their **standing** — the derived relation between a guest and the room they are in. One room, one state, a participant and a spectator standing in it, two different pieces of audio. This is where `multiGuest` policies stop being labels in the operator panel.

The director **reconciles rather than fires**: it computes what each guest should be hearing and sends only the difference. An event-driven director leaves a guest who walked in mid-scene hearing nothing forever, because the event they needed was dispatched before they arrived. Under reconciliation, arriving late, being promoted from spectator to participant, and reconnecting a dropped phone are one operation.

Audio is layered rather than a single stream, because tour guidance, room content, and transit beds coexist:

| Layer | Content | Behavior |
|---|---|---|
| `tour` | Golden-path guidance narration | Ducks under the room layer *(slot `guidance`; ducking not implemented)* |
| `room` | Active room content | Slot `room`; §3.7 policies not implemented — content starts on state entry and late arrivals seek |
| `ambient` | Transit beds | Authored today as hallway `cues`, which every guest passing through hears |

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
  "showId": "the-museum",
  "contractVersion": 3,
  "floorplan": { "image": "plan.png", "width": 1400, "height": 760 },

  "rooms": {
    "museumHallway": {
      "kind": "hallway",                       // never activated; no machine required
      "adjacent": ["cyclorama", "slop", "southCorridor"],
      "zones": { "museumHallway": { "polygon": [[x,y], ...] } }
    },
    "slop": {
      "kind": "destination",
      "adjacent": ["museumHallway"],
      "zones":      { "slop": { "polygon": [[x,y], ...] } },
      "machine":    { /* idle / active / settling, plus any states of its own */ },
      "multiGuest": { "policy": "collaborative", "maxOccupants": 6, "atCapacity": "spectator" },
      "ineligible": { "policy": "activateVariant" },   // this one reacts; most do not
      "exit":       { "policy": "resetAfter", "graceMs": 10000, "resumeIfReturned": true },
      "whenAvailable": { "policy": "wait" },
      "audio":      { "timing": "masterTimeline", "joinPolicy": "inProgress" },
      "seen":       { "dwellMs": 20000, "accumulate": true },
      "revisit":    { "whenSeen": {} },
      "location":   { "entryConfirmMs": 1500, "exitConfirmMs": 800 },
      "outputs":    { "cues": { /* projection, lighting, in-room audio */ } }
    }
  },

  "paths": {                                   // §4.3 — a library of routes, not an assignment
    "pathA": { "rooms": ["automation", "slop", "consumption1"], "guidance": "goldenPath" }
  },

  "guest": {
    "eligibility": { "golden": { "strategy": "goldenPath", "params": { "allowRevisit": true } } },
    "timers": {                                // §4.2 — what `after` cannot express
      "museumTime": { "sinceEntering": "guidance.museum", "afterMs": 1800000, "event": "MUSEUM_TIME_UP" }
    },
    "machine": {                               // §4.1 — `location` is generated, not authored
      "guidance": {
        "initial": "prologue",
        "states": {
          "prologue": { "on": { "entered.museumHallway": "museum" } },
          "museum": {
            "entry": [{ "type": "assignPath", "from": ["pathA", "pathB"], "strategy": "roundRobin" }],
            "on": { "MUSEUM_TIME_UP": "converge" }
          },
          "converge": { "on": { "entered.library": "ending" } },
          "ending": {}
        }
      },
      "adherence": {
        "initial": "onPath",
        "states": { "onPath": { "on": { "wentOffPath": "offPath" } }, "offPath": {} }
      }
    },
    "audioLayers": { /* §6.2 mixing rules */ }
  },

  "globals":       { /* orchestrator-owned */ },
  "inputBindings": { /* §6.4 */ },
  "location":      { "entryConfirmMs": 1500, "exitConfirmMs": 800, "contactLossMs": 5000 }
}
```

Gone from earlier drafts: the top-level `zones` map (zones live in the room they
belong to), `phases` (replaced by the guidance region), `paths.assignment` (the
journey assigns), and the weighted `adherence` block (§4.5).

---

## 10. Operator GUI

Two surfaces, deliberately separated. What exists today is a **test panel**; the
production operator GUI is a later, larger piece, and the panel's job is partly
to establish what that actually needs.

### 10.1 Test panel — built

Vanilla JavaScript and inline SVG, no build step and no framework. That is a
choice, not a shortcut: its whole state is one snapshot pushed over WebSocket and
re-rendered, which is the case where a framework earns least, and a no-build loop
matters on a machine that is not a dev box during venue tuning.

- **Floor plan.** Zones drawn per room and coloured by room state; hallways
  rendered differently; lock holder and exit-grace countdown on each. Drag a
  guest to move them; click a room or guest to inspect. Guest dots are coloured
  by their **standing** — what the room they are in is to them (§3.4).
- **Auto-walk.** Simulated guests walk themselves toward eligible unseen rooms,
  dwell for that room's own `seen` threshold, and move on. Server-side, emitting
  the same virtual position events a drag would, so the runtime cannot tell them
  apart. This exists because the behavioural matrix cannot be tested by hand:
  capacity needs several guests in one room and one mouse cannot drag several
  dots.
- **Time.** Elapsed show time, and a scalable clock — 5× or 20× to watch a
  20-second dwell threshold resolve in one, or paused outright. **Test mode
  only**, per §14 Phase B.
- **Overrides.** Activate for an occupant (through the arrival path), release a
  lock, and raw statechart events, kept visually separate because a raw
  `ACTIVATE` leaves a room running for nobody.

### 10.2 Production operator GUI — later

Floor plan as primary view with live state and drag-to-place; guest inspector
with journey, path progress, visit history, dwell, audio layers and device
telemetry; room inspector with manual state override; statechart views for both
room and guest machines, sharing a renderer with the authoring tool; scripted
walkthrough playback and mixed real/simulated guests.

React is the presumption there (§2.1), and React Flow for the statechart views —
the one place a framework clearly earns its place, and the reason to keep the
test panel small rather than let it grow into a first draft of this.

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
Room actors + guest actors + occupancy coordinator running concurrently. Activation, locking (incl. transfer and release), capacity, exit grace, dwell/seen tracking, per-room ineligible policies, the journey statechart, off-path detection. Virtual walkthrough as the only location source. Stub output adapter. **Exit criteria:** the full behavioural matrix (eligible entry, ineligible entry, off-path entry and variants, second entrant, capacity, exit/reset, revisit) demonstrable by dragging dots on a floor plan, with no phones and no hardware.

Built so far: the coordinator, room actors, guest actors and eligibility, exit
and reset, the journey, and a floor-plan test panel with auto-walking simulated
guests and a scalable clock. Outstanding: **capacity and the multi-guest
policies**, which are declared and validated but not yet acted on — in a show
whose first six rooms are shared, that is the most visible gap, since only the
first arrival can hold a room and everyone behind them is refused.

### Phase B — Phones and audio
Layered phone audio; room timeline join-in-progress; the guidance/tour layer and its off-path variant; per-room ineligible-entry audio; browser test mode with self-reported zones. **Exit criteria:** a walkthrough with real phones on browser test-mode zones produces correct audio behaviour end to end, including a deliberate divergence run that takes a guest off-path.

Note the constraint this phase introduces: the scaled show clock is a test-mode
tool only. Once audio is scheduled against a shared clock, running the server at
anything but 1× desynchronises every device.

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
| Path completion / journey shape | Superseded — see the journey row below. This install: a shared prologue, a museum with assigned paths, then free-roam and the Library |
| Contention at scale | ~20 guests across many rooms; contention not expected. `balanced` assignment available but unnecessary here |
| Room capacity vs. lock | **Per room** — `maxOccupants` + `atCapacity` (`spectator` \| `refuse` \| `queue` \| `personalVariant`), separate from the lock |
| Lock on holder departure | **Released on exit.** Boundary-hovering is handled by location hysteresis (§5.2), not lock stickiness. Transfers to longest-present occupant if others remain |
| Path divergence | **On-path / off-path**, one way (§4.5). The weighted score model was dropped: the show asks whether a guest is following the path, which is a boolean |
| The journey | **An authored statechart per guest** (§4.1), replacing `phases`. Three parallel regions: location (generated from adjacency), guidance (authored), adherence |
| When paths are assigned | **On reaching the part of the show that has them**, not at the door — which is also when there is occupancy to spread against |
| Kinds of space | **`destination` / `hallway`** (§3.1). A hallway is always eligible, never seen, never a deviation, exempt from the activation contract |
| Rooms reacting to an off-path guest | **Per room** — `ineligible.policy: "activateVariant"` (§3.4). Eligibility selects which activation a room gets rather than gating it. Most rooms stay dark |
| Impossible movement | **Followed, and flagged.** The guest machine always matches the coordinator; adjacency makes an implausible move noticeable rather than blocking it |
| Passing-by behavior | **Removed** (§17). The show distinguishes eligible from ineligible entry, and nothing else spatial |
| Proximity tiers | **Binary** — `outside` / `inside` (§5.2) |
| Room memory of prior activation | **None.** Revisit variants come from the activating guest's history (§3.6) |

### 15.2 Open

1. **Accessibility.** Still pending internal team discussion, and it matters more here than in v0.2: the show is audio-guided, so a guest who cannot hear the tour has no wayfinding at all. Options range from a visual guidance layer on the phone (next-room prompts, directional cues) to captioned room content. The cheap insurance remains adding an optional `alternatives` field to every cue now (`{ "text": "...", "haptic": "pattern-id" }`) so a later decision does not require reworking the cue library.
2. **What ends free-roam.** A guest released into the Admin Office / Data Center / Warehouse / Control Room area needs something to move them on toward the Library. Pending the narrative team; the runtime currently advances on entering the Library, with the trigger before it left as an operator action.
3. **Cursed as a role.** The golden/cursed framing is parked. If it returns it is likely a *role* rather than a fall from grace, which the eligibility seam already accommodates — `roleBased` is a declared strategy and rooms never encode who is allowed in. See §17.5.
4. **Does the audience know?** Whether going off-path is legible to a guest (they realise the tour has changed) or purely felt (it simply gets stranger) is a directorial choice, with implications for how explicit the audio around the transition needs to be.
5. **Multi-guest semantics before phones.** `spectator` and `personalVariant` are phone-side responses, so until Phase B, capacity work can only select and display them. Worth agreeing that is the bar for A5.

---

## 16. Migration from `dim_machine`

### 16.1 Carries over largely intact
Clock sync and `startAt` scheduling; Web Audio cue player and join-in-progress; session token + snapshot resync; WebSocket server and operator command plumbing; built-in declarative pages; custom-page loader and kit (`DIM.registerPage`, `DIM.pageAsset`); peer relay (still valuable for in-room collaborative pages, now naturally scoped to room occupancy); operator panel patterns; show-JSON loading and inspection.

### 16.2 Replaced
The v1/v2 dual-mode runtime (`runtime.js`) — replaced by always-concurrent room + guest actors with a coordinator; contract v1/v2 → **v3**, a breaking change (v3 shows are not v2 shows); the ad-hoc room-assignment operator commands (`assignZone`, `moveAllToRoom`) → location-source events, with operator placement becoming one source among several; `sendTo: orchestrator` broadcast stub → a real orchestrator.

The v0.2 operator panel went with it. It was still sending seven message types the v0.3 runtime does not have, and was rebuilt as a deliberately lightweight test panel (§10) — vanilla, no build step — whose job is to establish what the real operator surface needs before that is committed to a framework.

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
| `advanceOn` | `advanceWhen` + required `scope` | Read as a condition; who evaluates it was never stated. *Both removed in turn by §18 — room-entry transitions and declared timers cover it* |
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

## 18. Revision — the journey

The second substantial revision, and it came from mapping the real building.

### 18.1 Why phases could not stay

A guest used to be handed one path at the door, for the whole show. The actual
journey has three route regimes — a shared prologue everyone walks, a museum
where assigned paths apply, and a free-roam area after — and guests move between
them freely, including back into the museum from the far side.

So routes belong to the journey rather than to the show, and what progresses is
not *where a guest may go* but *what the audio is telling them to do*. That is
the guidance region (§4.1). `phases`, `mode`, `target`, `rooms` and `advanceWhen`
all disappear: a "directed" phase is simply a region whose guidance points at one
room, and there is no invalid combination left to author.

### 18.2 What replaced it

| Was | Now |
|---|---|
| `phases[]` with `mode`, `target`, `rooms` | The `guidance` region of the guest statechart (§4.1) |
| `advanceWhen` | Room-entry transitions, plus declared timers for what `after` cannot express (§4.2) |
| `paths.assignment` at join | `assignPath` as a journey entry action, when the guest reaches the museum (§4.3) |
| Weighted adherence, thresholds, redemption | `onPath` / `offPath`, one way (§4.5) |
| Rooms as one undifferentiated kind | `destination` / `hallway`, and declared adjacency (§3.1) |
| Ineligible entry always leaving the room untouched | Still the default, with `activateVariant` as the declared exception (§3.4) |

### 18.3 Decisions worth recording

**The location region is generated.** Adjacency is already on the rooms;
authoring it again as transitions would let the two drift. An author draws
intent; the runtime adds recovery.

**Eligibility only gates rooms that paths route through.** Without that
qualifier a shared prologue is ineligible for everybody, because no guest has a
path yet. It also makes backtracking out of the museum a non-event, which is
what the show wants.

**A guest's standing in a room is derived, not recorded.** An earlier field
stored the outcome of an entry and went stale whenever a room changed under
somebody who never moved. It is neither the guest's state nor the room's — one
room in one state holds its holder and two who were refused — so it is computed
from the relation each snapshot (§3.4).

**Off-path is a boolean because the show asks a boolean.** The weighted model
would have shipped a calibration burden for a distinction nobody makes. It can be
layered back onto the same event stream if a pattern rather than a single wrong
turn turns out to be the right model.

---

*End of specification.*