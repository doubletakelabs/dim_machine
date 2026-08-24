# DIM Machine — Input/Output Contract v3

The integration seam between the **authoring tool**, the **runtime**, and the
**phone client**, for the spatial model in
`specs/Interactive Theater Platform Spec v0_3.md`.

Contract v3 is **not frozen** — it will keep evolving through Phases A–E. What
is stable is the *shape*: shows are JSON, spatial input arrives as one canonical
event, and rooms never encode who is allowed in them. Expect fields to be added
and, while Phase A–B are in flight, occasionally renamed. Shows declare
`"contractVersion": 3`; v1 and v2 definitions are rejected at load.

Each section is marked with what the runtime does with it **today**:

- **live** — implemented and exercised by tests
- **declared** — validated on load, consumed in a later phase
- **carried** — inherited from v0.2 and still working

---

## 1. Show definition — live

```jsonc
{
  "contractVersion": 3,
  "showId": "the-house",
  "name": "The House",
  "rooms":   { /* §2 — one entry per space, geometry and adjacency included */ },
  "floorplan": { "image": "plan.png", "width": 640, "height": 420 },
  "guest":   { /* §5 — the journey statechart, eligibility, timers */ },
  "paths":   { /* §6 — a library of named routes */ },
  "globals":       { "showStartedAt": { "type": "number", "initial": 0 } },
  "inputBindings": { /* §10 */ },
  "location":      { /* §4.3 — show-wide hysteresis defaults */ }
}
```

`rooms` and `guest` are required. Validation runs on
every load (`POST /api/shows/validate`, or `SpatialRuntime.load()`), and returns
`errors` (refuse to load) and `warnings` (load, but say so).

Because shows are the program, the validator is the only type system this
project has — it checks enum spelling, cross-references, and the room machine
contract below, rather than letting a typo load clean and silently do nothing.

---

## 2. Room block

One entry per physical room. Rooms own **presentation**; they never encode who
is allowed in — that keeps them portable across shows (spec §3.1).

```jsonc
"library": {
  "name": "Library",
  "kind":       "destination",          // destination | hallway
  "adjacent":   ["museumHallway"],      // which spaces physically connect
  "zones":      { /* §4.2 — one or more polygons this room occupies */ },
  "machine":    { /* §3 — required */ },
  "multiGuest":  { "policy": "collaborative", "maxOccupants": 6, "atCapacity": "spectator" },
  "ineligible": { "policy": "ambientOnly", "audio": "library-locked" },
  "exit":       { "policy": "resetAfter", "graceMs": 10000,
                  "audioOnExit": "fadeOut", "resumeIfReturned": true },
  "audio":      { "timing": "masterTimeline", "joinPolicy": "inProgress",
                  "minRemainingMs": 20000 },
  "seen":       { "dwellMs": 20000, "accumulate": true },
  "revisit":    { "whenSeen": {}, "whenCompleted": {} },
  "location":   { "entryConfirmMs": 1500, "exitConfirmMs": 800 },
  "outputs":    { "cues": { /* §9 */ } }
}
```

| Block | Values | Status |
|---|---|---|
| `machine` | §3 | **live** |
| `multiGuest.policy` | `collaborative` \| `spectator` \| `personalVariant` \| `refuse` | **live** |
| `multiGuest.maxOccupants` | positive integer; caps participation. Only bites under `collaborative` | **live** |
| `multiGuest.atCapacity` | `spectator` \| `refuse` \| `personalVariant` | **live** |
| `kind` | `destination` (default) \| `shared` \| `hallway` — see below | **live** |
| `adjacent` | room ids this one physically connects to; must be declared from both sides | **live** |
| `ineligible.policy` | `ignore` \| `ambientOnly` \| `lockedMessage` \| `tease` \| `activateVariant` | `activateVariant` **live**, rest declared |
| `exit.policy` | `resetAfter` (default, `graceMs` 10000) \| `finish` \| `hold` \| `resetImmediate` | **live** |
| `exit.graceMs` | non-negative; how long `settling` waits before `RESET`. Ignored by `resetImmediate` | **live** |
| `exit.resumeIfReturned` | re-entry during grace cancels the reset and sends `RESUME`; requires `settling` to handle it | **live** |
| `exit.audioOnExit` | `fadeOut` \| `continue` \| `cut` — governs the *departing phone*, independently of the room | declared |
| `whenAvailable.policy` | `wait` (default) \| `activate` — what the room does when it frees up with eligible guests still inside | **live** |
| `audio.timing` | `masterTimeline` \| `perGuest` | declared |
| `audio.joinPolicy` | `inProgress` \| `waitForNext` \| `restart` | declared |
| `seen.dwellMs` / `accumulate` | dwell inside before the room counts as seen; `accumulate` sums separate visits | **live** |
| `revisit.whenSeen` / `whenCompleted` | declaring one makes the runtime send `ACTIVATE_SEEN` / `ACTIVATE_COMPLETED` instead of `ACTIVATE`; `idle` must handle it (validated) | **live** |
| `zones` | one or more polygons; occupancy is reported for the **room**, not the zone | **live** |
| `location` | per-room `entryConfirmMs` / `exitConfirmMs` overrides | **live** |

Unknown keys are preserved and ignored, so authoring can run ahead of the runtime.

---

## 3. Room machine contract — live

A room machine is standard XState v5 statechart JSON (`initial`, `states`,
nested `states`, `on`, `after`, `always`, `guard`). On top of that the runtime
requires the canonical presentation vocabulary, because room actors send these
events and read these states by name. A machine that omits any of it produces a
room that silently never moves, so **it is a load error, not a runtime
surprise.**

### Kinds — who the room runs for

| Kind | Runs for | Holder | Company | Revisit variant |
|---|---|---|---|---|
| `destination` | a person | yes | `multiGuest` policy | keyed on the holder |
| `shared` | the space | **none** | everyone is `present` | **not allowed** |
| `hallway` | nobody | none | n/a | n/a |

A **`shared`** room plays when the first eligible guest arrives, and everyone
inside gets the same thing. Nobody holds it, because there is nothing to
arbitrate. That is also why it can have no revisit variant: with a holder, a
veteran arriving a second before a newcomer would choose the abbreviated version
for a room the newcomer has never seen — the same argument that rejected
room-side memory of having run before. The validator rejects `revisit`,
`multiGuest` and `activateVariant` on a shared room rather than letting a show
promise something it cannot keep.

Exit policy still applies: a shared room winds down when it is running for
nobody, which never required it to have had a holder.

### Hallways

A `hallway` is a space you pass through to reach somewhere else. It is **always
eligible** — you cannot deviate by using the only route between rooms — never
counts toward `seen`, is never a deviation, and is **exempt from the activation
contract** below, because a room that can never be activated should not have to
declare states it can never enter. Guests still occupy it, it still appears on
the floor plan, and it is where guidance speaks.

### Adjacency

`adjacent` is truth about the building, declared from both sides. It does **not**
gate movement: a guest can turn up anywhere — a misread beacon, an operator
dragging a dot — and the guest machine always has somewhere to put them. What it
buys is the ability to *notice*, which in Phase C is the BLE misread signal.

### Rooms reacting to a guest they were not sent

`ineligible.policy: "activateVariant"` makes the runtime send
`ACTIVATE_OFFPATH` instead of `ACTIVATE`, and the guest holds the resulting
lock — the room is running for them. Eligibility therefore selects *which*
activation a room gets rather than gating activation outright. Most rooms keep
`ignore` and stay dark. A room claiming the policy without handling the event
fails to load.

### Required states

| State | Meaning |
|---|---|
| `idle` | Available. Idle/ambient. Must be `initial`. |
| `active` | Content running. Sub-states carry the room's beats and any intro. |
| `settling` | Occupancy dropped to zero; exit grace running. |

That is the whole vocabulary. Rooms may declare any additional states they like
and nest freely — an intro is `active.intro`, or a top-level `activating` if you
prefer, and the validator does not object. What it does require is that these
three exist and handle the events below.

**Rooms have no memory of having run before.** There is no `dormantSeen`
equivalent, deliberately: after a room resets, a guest walking in for the
first time must get the full version, regardless of who was in there earlier.
Revisit variants come from the activating guest's history instead (§3.6 of
the spec), carried on `ACTIVATE`.

### Required transitions

| State | Event | Sent when |
|---|---|---|
| `idle` | `ACTIVATE` | an eligible guest activates the room |
| `settling` | `RESET` | exit grace completed |
| `active` | `RELEASE` | lock released with nobody left in the room |
| `settling` | `RESUME` | the guest who left returned during grace — **only required when `exit.resumeIfReturned` is true** |
| `settling` | `ACTIVATE` | a *different* eligible guest arrived during grace — **optional; declaring it makes the room interruptible** |

`RELEASE` is required because an `active` room with no lock holder is
incoherent: the lock is what says a room is somebody's. When the holder leaves
and others remain, the lock **transfers** to the longest-present remaining
occupant and no `RELEASE` is sent — the room does not reset under the people
standing in it.

Transfer only considers occupants the room is **running for**. A guest inside a
room not on their path is physically present but received its `ineligible`
response and the room never changed for them; handing them the lock would make
them owner of a room it is not playing to. If the departing holder was the last
eligible occupant, the room takes its exit policy even though a body remains —
it is running for nobody. Room snapshots carry both `occupants` (everyone
inside) and `eligibleOccupants` (the subset that counts).

### Activation events and revisit variants

```jsonc
{ "type": "ACTIVATE", "guestId": "g-123",
  "seen": true,            // this guest has seen this room before
  "completed": false,      // they reached its completion state
  "activatedByMe": true }  // they were the one who activated it last time
```

Facts about the guest's history with *this room*, and nothing else — no
identity, no path, no role. That boundary is what keeps rooms portable across
shows, and it is the same boundary that lets paths be swapped for roles later
without touching a single room definition.

**Branching lives outside the statechart.** Show JSON has no condition language
and no guards. Instead the runtime resolves which variant applies and sends a
correspondingly named event, so the chart holds only plain transitions — which
is also what makes it readable as a diagram.

| Room declares | Runtime sends | Precedence |
|---|---|---|
| `revisit.whenCompleted` | `ACTIVATE_COMPLETED` | highest |
| `revisit.whenSeen` | `ACTIVATE_SEEN` | |
| — | `ACTIVATE` | fallback |

```jsonc
"idle": { "on": { "ACTIVATE": "activating", "ACTIVATE_SEEN": "active.abbreviated" } }
```

A room that declares a variant its `idle` state cannot receive fails to load, so
there is no silent fallback. Conditions the runtime cannot compute belong to the
orchestrator, which delivers them as events too.

### Exit and reset

The grace timer hangs off the `settling` state, not off the departure. Every
route into `settling` starts it — occupancy reaching zero, an authored
transition at the end of the room's content, or an operator forcing the state —
so a room can never sit in `settling` with nothing scheduled to move it.

```jsonc
"settling": {
  "on": {
    "RESET": "idle",
    "RESUME": "active.main",          // the guest who left, coming back
    "ACTIVATE": "active.main",        // somebody new, interrupting the settle
    "ACTIVATE_SEEN": "active.abbreviated"
  }
}
```

**A settling room is interruptible.** It has not reset yet, so an arriving guest
takes it rather than waiting out a grace timer they cannot see — standing in a
room where nothing happens is the worst reading of that window. The timer is
cancelled and the lock passes to them.

The two routes back into `active` are deliberately distinct:

| Arriving guest | Event | Because |
|---|---|---|
| the one who just left | `RESUME` | it is still their session; hand it back where it was |
| anyone else | `ACTIVATE` / `ACTIVATE_SEEN` | they have seen none of it, so they get a normal activation for their own history |

Both target whatever the author wants, so "resume from the same point" versus
"start again" is a statechart decision rather than runtime magic. A room that
declares no `ACTIVATE` on `settling` is simply not interruptible — the request
is refused and no lock is stranded.

Adapters can tell the two apart: the output intent carries `previousState`, so
`settling → active` is where a crossfade belongs rather than a hard cut.

### Freeing up with somebody still inside

A room whose content ends under its own steam resets at the feet of anyone still
standing in it. They never left, so no arrival fires and nothing offers them the
room — they hold a stale refusal in an idle room indefinitely.

```jsonc
"whenAvailable": { "policy": "activate" }
```

| Policy | Behavior |
|---|---|
| `wait` *(default)* | The room sits idle until somebody walks in. Right for a narrative room that should not replay itself |
| `activate` | The room plays again for the longest-present eligible occupant — the same ordering lock succession uses. Right for an ambient space |

`activate` will keep cycling for as long as someone stays, which is the point;
it stops when the last eligible occupant leaves. Combined with
`exit.resetImmediate` and self-ending content it becomes a tight loop, so the
validator warns about that pairing.

### No implicit advancement

The runtime never moves a room on its own. Every state declares how it is left —
an `after` delay, an `always`, or an event. An earlier version auto-advanced
rooms whose intro state left its exit unspecified; it now does not guess.

### Timers

Authored `after` transitions run on the **show clock**, along with coordinator
hysteresis and dwell. Nothing in the runtime reads wall-clock directly, so
scripted walkthroughs replay room timing at speed exactly as it runs in the
venue. Timers inside `active` keep running in an empty room unless the state
declares `pauseWhenEmpty: true` *(declared)*.

---

## 4. Zones, occupancy, and location

### 4.1 The canonical spatial event — live

Every location source produces only this. **Nothing downstream inspects
`source`** — that is what makes testing without hardware free.

```jsonc
{ "type": "zone.occupancy",
  "guestId": "g-123",
  "zoneId": "library",         // null when outside every zone
  "tier": "inside",            // outside | inside
  "previousOccupancy": "outside",
  "previousRoomId": null,
  "source": "virtual",         // ble | rtls | qr | operator | virtual | nfc
  "timestamp": 1723000000000 }
```

Two tiers: you are in a room or you are not. Moving between rooms commits an
exit from the first before an entry to the second, so a guest is never
recorded in two rooms at once.

### 4.2 Zones — live

Zones are the geometry a room occupies, declared **inside the room**. A room may
own several — a gallery split by a structural wall, an alcove — and occupancy is
reported for the *room*, so crossing between them is not an exit.

```jsonc
"library": {
  "zones": {
    "library-main":   { "polygon": [[120,80],[280,80],[280,200],[120,200]], "label": [200,140] },
    "library-alcove": { "polygon": [[280,100],[330,100],[330,170],[280,170]] }
  }
}
```

Zone ids are unique across the whole show, not just within a room — validated,
because a duplicate would make an event ambiguous. There is no top-level `zones`
map; that split existed in an earlier draft and only created two things to keep
in sync.

BLE thresholds will hang off the same zone entries when Phase C lands
(`beacons`, `rssiEnter`, `rssiExit`) — *declared*, not yet consumed.

### 4.2b Show floor plan — live

```jsonc
"floorplan": { "image": "plan.png", "width": 640, "height": 420 }
```

All optional. `image` is served from `/assets/` and drawn beneath the zones, so
zones can be traced over a real architectural plan — which is how they will be
authored for a venue. Without it the operator view computes its extent from the
zone polygons.

### 4.3 Confirmation and contact loss — live

Show-wide defaults, overridable per room under `rooms.<id>.location`:

```jsonc
"location": { "entryConfirmMs": 1500, "exitConfirmMs": 800, "contactLossMs": 5000 }
```

Entry and exit are both confirmed, on deliberately different holds. Entry is held
longer because its consequences are expensive — locking a room and committing the
physical layer, with no human in the loop, since activation is automatic on
entry. `exitConfirmMs` is what stops someone hovering in a doorway from dropping
the room; lock stickiness deliberately does not exist (spec §3.4).

A **zone change within one room commits immediately** — occupancy has not
changed, so there is nothing to confirm.

`contactLossMs` is one timeout covering every way of losing track of a guest: a
silent beacon, a dead phone, a dropped socket. When it expires they are outside,
which starts the room's exit grace on top — so a dying phone takes
`contactLossMs + exit.graceMs` to reset a room. Choose the two together.

A connected virtual or operator placement never expires: it is an explicit
statement with no stream to go silent. A **disconnect applies to every source**,
however the guest was located.

---

## 5. Guest block — live

The guest is a statechart, one actor each, alongside one per room. Three
parallel regions, from two sources.

```jsonc
"guest": {
  "eligibility": { "golden": { "strategy": "goldenPath", "params": { "allowRevisit": true } } },
  "timers": {
    "museumTime": { "sinceEntering": "guidance.museum", "afterMs": 1800000, "event": "MUSEUM_TIME_UP" }
  },
  "machine": {
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
  }
}
```

| Region | Source | What it is |
|---|---|---|
| `location` | **generated** from room adjacency | One state per room plus `outside`. The map. Never authored — writing the same adjacency twice would let the two drift. |
| `guidance` | **authored** | The journey. The small, readable chart an author reasons about. |
| `adherence` | **authored** | Whether the guest is still following what guidance asked. |

The regions are parallel because the facts are independent: a timer can move
guidance to `converge` while the guest stands in the Data Center, and a guest can
wander back without guidance changing its mind.

**The machine always matches the coordinator.** The generated location region
carries a transition for every room at the region root, so a guest who turns up
somewhere they could not have walked to still has somewhere to be. The adjacency
transitions on each state win where both apply, so the plausible move is used
whenever the move was plausible.

**Rooms are heard as `entered.<roomId>`.** Dotted, so `entered.*` works as a
wildcard. `exited` fires when a guest is in no room at all.

**Actions are declared data**, executed by the runtime — the same shape as room
output actions. `assignPath` is the one that exists today.

### Timers

XState's `after` measures time since a state was *last* entered, so a guest who
left the museum and came back would restart it. A condition that has to survive
leaving is declared instead, and the runtime delivers an event:

```jsonc
"museumTime": { "sinceEntering": "guidance.museum", "afterMs": 1800000, "event": "MUSEUM_TIME_UP" }
```

Total elapsed since the state was *first* entered, running through anything.

### Eligibility

| `strategy` | Status | Meaning |
|---|---|---|
| `goldenPath` | **live** | The room is on the guest's assigned path — but only among rooms paths actually route through |
| `all` · `none` | **live** | Absolute |
| `roleBased` · `progressGated` · `inverted` · `custom` | declared | For shows not yet written; naming one is a load error |

The qualifier matters. A show is rarely paths end to end — this one has a shared
prologue, a museum where paths apply, and free-roam after. **A room no path
routes through is open to everyone**, so the entrance sequence works for a guest
who has not been assigned a path yet, which every guest is for the whole
prologue.

Per-guest state the runtime maintains:

```jsonc
{ "guestId": "g-123", "label": "Guest 1", "pathId": "pathA",
  "regions": { "location": "library", "guidance": "museum", "adherence": "onPath" },
  "roomId": "library", "zoneId": "library-main", "occupancy": "inside",
  "currentRoom": { "roomId": "library", "standing": "holder" },
  "visitHistory": { "library": { "visits": 2, "seen": true, "activatedByMe": true } } }
```

### `currentRoom` — what the room they are in is *to them*

Neither the guest's state nor the room's: one room in one state can hold three
guests reading differently — its holder and two who were refused. It is the
relation between them, and the coordinator already owns the other one (who is
where).

| `standing` | Means |
|---|---|
| `holder` | The room is running for them — however they came by it |
| `present` | In a `shared` room, which runs for the space and has no holder |
| `participant` | A `collaborative` room took them in alongside its holder |
| `spectator` | In, but watching: the room's company policy, or the overflow past capacity |
| `personalVariant` | The room is unchanged for them; their phone differs |
| `available` | Eligible, unheld, and the room would take them |
| `refused` | Eligible, but it will not — the room refuses company, or is full, or winding down |
| `notTheirs` | Not eligible for this room |
| `passingThrough` | A hallway |

`reason` accompanies the standing where it is not obvious: `refuse` for a room
that admits no company at all, `atCapacity` for one that is simply full.

### Company and capacity

What an eligible guest gets when a room is already running for somebody is the
room's own business:

| `policy` | Company gets |
|---|---|
| `collaborative` | `participant`, up to `maxOccupants`; beyond that, `atCapacity` |
| `spectator` | `spectator` — in, but not participating |
| `personalVariant` | `personalVariant` — the room is untouched, their phone differs |
| `refuse` | `refused` |

**Capacity counts the guests a room is running for, not the bodies in it.**
Somebody standing in a room that is not theirs got its ineligible response and
the room never changed for them, so they occupy no slot.

**It only bites under `collaborative`.** The other policies admit no
participants, so a cap there would be a limit that never applies — the validator
warns about it.

Standing is **derived from arrival order**, not from a membership list. So when
a participant leaves, whoever was waiting past the cap is promoted with nothing
tracking it — and the ordering is the same one lock succession and
`whenAvailable` use.

### Telling a room how many it is running for

```jsonc
"active": {
  "on": { "occupants.2": ".together", "occupants.1": ".main" }
}
```

A room may want a beat that only exists with company (spec §3.4). The count
arrives as `occupants.<n>`, dotted like `entered.*`, so a room declares
transitions for the counts it cares about rather than needing a guard to compare
a number — which show JSON has no way to express. Sent only when the count
changes, and only to a room that is running.

**Derived, not recorded.** An earlier version stored the outcome at entry and
went stale whenever the room changed underneath somebody — reading `refused` for
a guest the room had since passed to, or `activated` for one standing in a room
that had reset at their feet. What *happened* is an event and lives in the event
log; what *is* is computed each snapshot, so it cannot drift.

---

## 6. Paths — live

A library of named routes, referenced by `assignPath`. **Data, never
structure** — which is what lets a route be assigned when a guest reaches the
part of the show that has paths rather than at the door, and lets one authored
machine serve every guest.

```jsonc
"paths": {
  "pathA": { "rooms": ["automation", "slop", "consumption1"], "guidance": "goldenPath" },
  "pathB": { "rooms": ["saas", "kin", "consumption2"], "guidance": "goldenPath" }
}
```

`guidance`: `goldenPath` (ordered; the audio leads) · `guestDirectedPath` (the
audio follows) · `freeExplore` (no guidance). A path may not route through a
hallway. Paths may overlap.

## 7. Going off-path — live

Guidance holds two values per guest: the **target** (next unvisited room on the
assigned path) and whether they are **following** it.

Off-path arms only among the rooms paths route through. Wandering back to an
earlier part of the show, or down a corridor, is not a deviation — there is no
path being led there to deviate from. It is **one-way**: the tour goes off the
rails and stays off.

## 8. Outputs

### 8.1 Guest audio — live (thin layer)

The only path from show state to sound. Everything else in §8 is still an
adapter stub or a carried v0.2 surface.

**Rooms declare cues by state.** A `cues` block sits beside `machine`, keyed by
the state the room is in. A key naming a root (`active`) covers its whole nested
branch; a key naming the full dotted path (`active.together`) wins over it.

```jsonc
"library": {
  "kind": "destination",
  "multiGuest": { "policy": "collaborative", "maxOccupants": 2, "atCapacity": "spectator" },
  "cues": {
    "activating": { "audio": "chime.wav" },
    "active": [
      { "audio": "whisper.wav", "audience": "participants", "loop": true },
      { "audio": "ambient.wav", "audience": "spectators", "gain": 0.25, "loop": true },
      { "audio": null,          "audience": "ineligible" }
    ],
    "settling": { "audio": "chime.wav", "audience": "occupants" }
  }
}
```

An array is a list of alternatives for the same state; the **first whose
audience matches the guest's standing** applies, and an entry with `audio: null`
is an explicit silence for that audience. This is where `multiGuest` policies
stop being labels: a spectator and a participant stand in one room, in one
state, and hear different things.

| `audience` | Standings it covers |
|---|---|
| `participants` | `holder`, `participant`, `present` |
| `spectators` | `spectator` |
| `personalVariant` | `personalVariant` |
| `ineligible` | `notTheirs`, `refused` |
| `occupants` | everyone inside, whatever their standing |

The default is `participants` for a `destination` and `occupants` for a `shared`
room or a `hallway` — which is the distinction between the kinds carried into
audio: a destination runs for the people it admitted, a shared space runs for
everyone in it. A room that puts guests in a standing it declares nothing for
leaves them in silence, so validation warns at load.

**Guests declare cues by region and state**, region-qualified because the
parallel regions may reasonably name a state the same thing:

```jsonc
"guest": {
  "cues": {
    "guidance.museum":     { "audio": "chime.wav" },
    "adherence.offPath":   { "audio": "click.wav", "loop": true, "gain": 0.2 }
  }
}
```

Keys may name a nested state (`guidance.prologue.tapTest`) or any ancestor of
one.

`audience` is an error here — a guest cue has exactly one listener.

**Slots.** A guest hears at most one cue from each of `room`, `guidance`, and
`adherence` at a time; a new cue in a slot replaces what was there. Three fixed
audio slots is not the mixer `guest.audioLayers` describes, but it is enough for
guidance to speak over an ambient room without either cutting the other.

A fourth slot, `screen`, holds an image rather than a sound — a phone has one
screen, so the sources compete for it instead of mixing. Guidance takes it first,
then adherence, then the room: when the show is addressing a guest directly, the
space they happen to be standing in should not talk over it.

**Cue fields:** `audio` (asset filename, or `null` for silence), `image` (shown
in the `screen` slot; a cue may declare either or both), `loop`, `gain`,
`fadeMs` (applied when the slot is vacated), `audience` (room cues only),
`seek` (default true — see below), and `offset`/`duration` (below).

**Segments.** `offset` and `duration`, in seconds, play a slice of a longer file
rather than all of it:

```jsonc
"guidance.someStep": { "audio": "long-take.mp3", "offset": 11.38, "duration": 6.47 }
```

One recording can then carry several beats. Segments seek and loop within their
own bounds, so a late-joining phone lands inside the segment rather than inside
the file. Nothing in the current shows uses this — the calibration clips are
discrete files — but a long take that has not been cut up is a normal thing to
be handed.

#### Input: a gesture becomes an event

A phone reports what the finger did — `tap`, `swipe`, `shake` — and nothing about
what it means. `inputBindings`, at the top level of a show, maps each to a
guest-machine event:

```jsonc
"inputBindings": { "tap": "TAP", "swipe": "SWIPE" }
```

That single indirection keeps the client ignorant of the narrative and the
runtime ignorant of the gesture: a state that wants a tap declares `on: { TAP:
… }` and nothing else in the stack needs to know why. An unbound gesture is
ignored rather than an error — most of the show asks for nothing. An input bound
to an event no state handles is a load-time warning, because a gesture that does
nothing looks exactly like a broken touch handler.

**Sequences live on the guest, not in the room.** A room machine has one state
for the whole space. Two guests standing in the calibration room tap at different
moments, so the steps are nested inside the `guidance` region — which is already
per-guest — and the room simply holds. Region values are dotted when nested
(`prologue.calibration.step3`), and cue lookup falls back through the ancestors,
so a cue on `guidance.prologue` still covers every step inside it.

#### Sequences

A run of screens is declared as a list rather than a state per screen. A guidance
state carrying `sequence` is expanded at load into exactly the states and cues
somebody would otherwise have written by hand:

```jsonc
"calibration": {
  "sequence": [
    { "image": "img/calibration_01_ontap.png",   "audio": "audio/calibrationsteps_01.mp3" },
    { "image": "img/calibration_06_onswipe.png", "audio": "audio/calibrationsteps_06.mp3" }
  ],
  "onComplete": "done"
}
```

becomes `step1`, `step2`, … each waiting for its own gesture, with a generated
cue per step. Nothing downstream knows a sequence existed — validation, the
machine builder and the cue director all see an ordinary show. `onComplete` names
a sibling of the sequence state; without one, the last screen stays up and the
show warns at load.

**What ends a step comes from the image filename.**

| Suffix | Step ends on |
|---|---|
| `_ontap` | a tap |
| `_onswipe` | a swipe |
| `_onshake` | a shake |
| `_ondelay2500` | 2500ms, no input |

The rule travels with the artwork, so re-cutting the deck is dropping files in
and listing them rather than editing a state machine to match. This is a
deliberate exception to logic-as-data: the rule is a property of the screen
itself — that one *says* TAP THE SCREEN — and holding it anywhere else means two
places that can disagree. `"advance": "swipe"` or `"advance": 2500` on the step
overrides the filename where a filename cannot carry the truth.

Both failure modes are load errors rather than runtime surprises: a filename with
no readable rule, and a step waiting on a gesture `inputBindings` never binds —
which would strand a guest in a room and look exactly like a broken touch
handler.

Pairing one screen to one clip is this sequence's shape, not the mechanism's. A
step may carry an image with no audio, audio with no image, or a slice of a
longer recording via `offset`/`duration`.

`node tools/audition.mjs <show> [sequence]` prints what each step shows, plays
and waits for — and plays the clips in order when given a sequence name.

#### Reconciliation, not events

The director does not send a cue when something happens. It computes what each
guest should be hearing, compares that against what their phone was last told,
and sends the difference.

This is load-bearing rather than stylistic. Under an event-driven director, a
guest who walks into a room thirty seconds after it activated missed the event
and hears nothing for the rest of the scene. Under reconciliation, walking into
running content, being promoted from spectator to participant when a slot frees,
and reconnecting a phone that dropped are the same operation, and none of them
is special-cased.

A cue's `startAt` is **when its source state was entered**, not when the cue was
sent. That is what lets a late arrival seek into content already in progress
rather than restarting it, and it is why `startAt` must stay stable across
reconciles. With `seek` (default), a phone joining late starts the asset at the
matching offset; a one-shot that already finished is skipped rather than
replayed.

A phone announces `{ "type": "ready" }` once its AudioContext is unlocked and
assets are preloaded. The server forgets what that phone was playing and
reconciles from scratch, because a reconnected phone came back silent with no
memory of its own.

#### Not in this layer

`audio.timing`, `audio.joinPolicy`, `audio.minRemainingMs`, `guest.audioLayers`,
and `ineligible.policy` selecting a response automatically are all still Phase B
(TECH-DEBT.md §2). `outputs.cues` — lighting, projection, DMX — is Phase D.

### 8.2 Room output intents — live (stub adapter)

Room actors emit intents, never device commands. Adapters translate.

```jsonc
{ "type": "roomOutput", "roomId": "library",
  "state": "active.beat2", "previousState": "activating",
  "lockHolder": "u-123",
  "cues": [ { "id": "proj-lib-2", "medium": "projection" },
            { "id": "lights-warm", "medium": "lighting", "params": { "fadeMs": 1200 } } ],
  "timelineStartAt": 1723000000000 }
```

Today the stub adapter appends to the operator output log. TouchDesigner (OSC),
DMX, and in-room audio are Phase D — the abstraction is not deferred even though
the adapters are.

### 8.3 Phone commands — carried

Unchanged from v0.2. Actions of the form
`{ "type": "output", "command": …, "params": …, "sync": "immediate" | "scheduled" }`.
`scheduled` cues carry a future `startAt` against the synced clock
(`params.leadTimeMs`, default 2000) for moments that must land together.

| `command` | `params` |
|---|---|
| `playAudio` | `assetId`, `gain?` (0–1), `loop?`, `leadTimeMs?` |
| `stopAudio` | `assetId?` (default `"*"`), `fadeMs?` |
| `playVideo` | `assetId`, `loop?`, `leadTimeMs?` |
| `showPage` | `page`, `props` |
| `haptic` | `pattern` (ms array) |
| `setVar` | `key`, `value` |

Built-in pages (props interpolate display vars with `${key}`, live-updated on
`setVar`): `waiting`, `blank`, `text`, `prompt`, `gestureSurface`,
`audioPlayer`, `videoPlayer`. New page types are additive.

Phone audio layers (§6.2 of the spec) are **declared**: `tour`, `room`,
`ambient`, with mixing rules at show level. Phase B.

### 8.4 Cue ownership — declared

A looping cue started on entry to state S is owned by S and auto-stopped on
exit, unless declared `persistent`. This makes orphaned audio a runtime
invariant rather than authoring discipline.

---

## 9. Inputs — declared

Page-local interaction never reaches the backend; only committed interactions
are promoted, now carrying a **scope**:

```jsonc
"inputBindings": {
  "shake":           { "event": "torch.shake",    "scope": "guest" },
  "button:activate": { "event": "mechanism.pull", "scope": "room" }
}
```

`scope: "room"` routes to the room actor the guest currently occupies — ignored
if they occupy none, or if the room's `multiGuest.policy` made them a spectator.
`scope: "guest"` routes to their own actor. In-room physical devices (buttons,
sensors) emit room-scoped inputs directly over MQTT with no phone involved; they
are peers of phone inputs, not a separate mechanism.

Canonical input events carried from v0.2: `tap` `{x,y}`, `button:<id>`,
`choice:<id>`, `swipe.left/right/up/down` `{velocity}`, `drag.end` `{x,y}`,
`shake`, `pageDismiss`, `video.ended` `{assetId}`.

---

## 10. Event log — live

Every state mutation goes through one append path. The sink is an in-memory ring
buffer today and an append-only Postgres table in Phase E (spec §12); routing
mutations through it now is what keeps that a sink change and nothing more.
Entries carry `at`, stamped on the show clock so a replayed log carries replayed
time.

| `type` | Emitted when |
|---|---|
| `show.loaded` / `show.started` / `show.stopped` | orchestrator lifecycle |
| `guest.joined` / `guest.left` | guest lifecycle |
| `guest.activatedRoom` | an eligible guest walked in and the room accepted |
| `guest.ineligibleEntry` | a guest entered a room not open to them (carries the room's `policy`) |
| `guest.activationRefused` | eligible, but the room would not take them (carries `reason` and `multiGuestPolicy`) |
| `guest.inheritedRoom` | the holder left and the room passed to them without their asking |
| `guest.wentOffPath` | entered a routed room that was not theirs (carries the abandoned `target`) |
| `guest.pathAssigned` | the journey handed them a route |
| `guest.timer` | a declared timer fired |
| `room.operatorEvent` | an event forced into a room machine from the panel |
| `show.timeScale` | test-mode clock rate changed |
| `zone.occupancy` | an entry or exit commits (§4.1) |
| `room.seen` | dwell threshold crossed |
| `room.state` | a room machine transitions |
| `room.activated` / `room.activationRefused` | activation accepted (with `revisit`) / refused (with `reason`) |
| `room.emptied` | occupancy reached zero while running (carries the applied `policy`) |
| `room.reset` | exit grace expired and the room returned to `idle` |
| `room.resumed` | someone re-entered during grace and the room resumed |
| `room.lockReleased` / `room.lockTransferred` | lock lifecycle |

---

## 11. Operator and test surfaces — live

HTTP:

| Endpoint | Purpose |
|---|---|
| `GET /api/shows`, `GET /api/shows/:file` | list / fetch definitions |
| `POST /api/shows/validate` | validate without loading |
| `POST /api/spatial/position` `{ guestId\|token, x, y }` | virtual walkthrough placement |
| `POST /api/spatial/tier` `{ guestId\|token, zoneId, tier }` | direct placement (`inside` / `outside`) |
| `POST /api/spatial/activate` `{ guestId\|token, roomId }` | manual activation request — for testing; the show does this automatically |
| `GET /api/custom-pages` | installed custom pages |

Operator WebSocket: `loadShow`, `startShow`, `stopShow`, `spawnGuest`
(`count`, `walk`), `removeGuest`, `setVirtualPosition`, `setVirtualOccupancy`,
`requestActivation`, `releaseRoomLock`, `sendRoomEvent`, `startWalkthrough`,
`stopWalkthrough`, `setTimeScale`, `clearOfflinePhones`.

The snapshot pushed to operators adds `floorPlan` (declared geometry plus a
computed extent), `timeScale`, `walkthrough` status, and a `position` per guest —
their floor-plan point if they have one, otherwise the centroid of the room they
are in, which is how a BLE-located guest will appear.

**`setTimeScale` is test-mode only.** Scaling the show clock costs nothing while
room output is a stub logger, but Phase B schedules real phone audio against a
shared clock, and running the server at anything but 1× would desync every
device.

**Entering an eligible room activates it.** There is nothing for a guest to
press: the confirmed entry is the trigger. Which is exactly why entry is
confirmed rather than immediate — a false positive from the location layer
commits the physical layer with no human in the loop.

The request still comes from the guest actor rather than the room, because
eligibility is not the room's business. A room only ever hears from guests it
can accept, which is what keeps rooms reusable across shows.

---

## 12. Peer relay and custom pages — carried

Unchanged from v0.2, and still valuable: relay channels are now naturally scoped
to room occupancy.

- Phone → server: `{ type: "relay", channel, payload, persist? }`
- Server → phone: `{ type: "relay", channel, from: { guestId, label, token }, payload, at, self }`
- On join: `{ type: "relaySync", channels: { [channel]: [{ from, payload, at }] } }`

Client API: `DIM.relay.send(channel, payload, opts?)`, `DIM.relay.on(channel, fn)`,
plus `DIM.registerPage`, `DIM.emit`, `DIM.vars`, `DIM.pageAsset`.

Custom pages ship as `public/custom-pages/<pageName>/page.js` (+ optional
`styles.css` and assets); the folder name is `showPage`'s `params.page`. Preview
locally with `custom-pages-kit/` (`npm start` → `page-preview.html`). Authoring
guide: `custom-pages-kit/CUSTOM-PAGES.md`.

Two hardening items are folded into Phase B: an error boundary around page
render, and a teardown hook on page swap.

---

## 13. Versioning

The runtime rejects definitions whose `contractVersion` it does not support and
reports the mismatch to the operator. v3 is the only supported version; v1 and
v2 workshop shows were removed with the runtime that ran them.

Additive changes — new policies, page types, event types, cue commands — do not
bump the version. Renames and semantic changes will, and until Phase B closes,
both remain possible.
