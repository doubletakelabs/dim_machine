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
  "rooms":   { /* §2 — one entry per physical room, geometry included */ },
  "floorplan": { "image": "plan.png", "width": 640, "height": 420 },
  "guest":   { /* §5 — eligibility strategies (machine optional) */ },
  "phases":  [ /* §6 */ ],
  "paths":   { /* §7 */ },
  "adherence":     { /* §8 */ },
  "globals":       { "showStartedAt": { "type": "number", "initial": 0 } },
  "inputBindings": { /* §10 */ },
  "location":      { /* §4.3 — show-wide hysteresis defaults */ }
}
```

`rooms`, `guest`, `phases`, and `paths` are required. Validation runs on
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
| `multiGuest.policy` | `collaborative` \| `spectator` \| `personalVariant` \| `refuse` | declared |
| `multiGuest.maxOccupants` | positive integer; caps active participation, separate from the lock | declared |
| `multiGuest.atCapacity` | `spectator` \| `refuse` \| `personalVariant` | declared |
| `ineligible.policy` | `ignore` \| `ambientOnly` \| `lockedMessage` \| `tease` | declared |
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

```jsonc
"guest": {
  "eligibility": {
    "golden": { "strategy": "goldenPath", "params": { "allowRevisit": true } }
  }
}
```

Eligibility is evaluated by the guest actor and never by the room — adding a new
access mechanism is a new strategy here and touches nothing else. This is the
seam that lets paths become **roles** in a later show without changing a room,
the coordinator, or the location layer.

| `strategy` | Status | Meaning |
|---|---|---|
| `goldenPath` | **live** | The room is on the guest's assigned path. `params.allowRevisit: false` closes rooms they have already seen; the default leaves them open |
| `all` | **live** | Every room is open — rehearsal, and single-path shows |
| `none` | **live** | Nothing is open |
| `roleBased` · `progressGated` · `inverted` · `custom` | declared | Named by the contract for shows not yet written |

Naming a declared-but-unimplemented strategy is a **load error**, not a warning.
An eligibility predicate quietly returning the wrong answer would lock guests out
of every room, and would read as a location bug rather than a config one.

Which config applies is looked up by the guest's adherence state
(`eligibility[adherence]`, falling back to `golden`), so a strayed guest can be
given a different predicate once adherence lands.

**`guest.machine` is optional and currently unused.** A statechart earns its
place when there are modes that reinterpret the same input; where a guest *is*
is a variable, not a state. The two genuinely mode-shaped things — phase and
adherence — arrive as parallel regions later.

Per-guest state the runtime maintains (`guest.js`):

```jsonc
{ "guestId": "g-123", "label": "P1", "pathId": "pathA", "phaseId": "roamA",
  "adherence": "golden", "adherenceScore": 0,
  "roomId": "library", "zoneId": "library-main", "occupancy": "inside",
  "visitHistory": {
    "library": { "roomId": "library", "firstEnteredAt": 1723…, "totalDwellMs": 34500,
                 "visits": 2, "seen": true, "completed": false, "activatedByMe": true }
  } }
```

`roomId` / `zoneId` / `occupancy` are a read-model of the coordinator, never the
source of truth. Two histories are tracked, both per-guest: **this guest has seen
the room**, and **this guest activated it themselves**. There is deliberately no
room-side "has been activated before" — it gives the wrong answer for a
first-time visitor to a room someone else already ran.

---

## 6. Phases — declared

```jsonc
"phases": [
  { "id": "roamA", "mode": "freeRoam", "rooms": "pathAssigned",
    "advanceWhen": { "scope": "guest", "seenCount": 3 } },
  { "id": "converge", "mode": "directed", "target": "controlRoom",
    "advanceWhen": { "scope": "show", "entered": "controlRoom" } },
  { "id": "exit", "mode": "directed", "target": "egress" }
]
```

`mode`: `freeRoam` (guidance suggests) | `directed` (guidance insists on one
target; `target` is then required). Phase ids must be unique.

`advanceWhen.scope` is **required** and says who evaluates the condition:

| Scope | Meaning |
|---|---|
| `guest` | each guest advances at their own pace, evaluated by their guest actor |
| `show` | the orchestrator advances everyone together |

It is declared rather than inferred because the right answer changes per show
and per test. A phase with no `advanceWhen` warns — only the operator can move
guests on from it.

## 7. Paths — assignment live, guidance declared

```jsonc
"paths": {
  "assignment": { "strategy": "roundRobin", "at": "onJoin" },
  "definitions": {
    "pathA": { "rooms": ["library", "greenhouse"], "guidance": "goldenPath" }
  }
}
```

`strategy`: `roundRobin` | `random` | `manual` | `balanced`.

`guidance` is what the tour audio does:

| Value | Behavior |
|---|---|
| `goldenPath` | An ordered route the audio leads them along, room by room |
| `guestDirectedPath` | The audio follows the guest instead of leading — where a guest who ignores the golden path lands, and authorable from the start |
| `freeExplore` | No guidance; they wander |

`goldenPath` is ordered by definition, so "which room next" is just the next
unvisited room in the list — there is no distance metric and no adjacency graph
to author. (An earlier `nearestUnseen` would have needed one, and would have
promised wayfinding the geometry could not deliver through walls.)

Paths may overlap; shared rooms are expected, and are exactly where the
`multiGuest` policies matter. A room on no path warns.

## 8. Adherence — declared

```jsonc
"adherence": {
  "signals":    { "ineligibleRoomEntered": { "weight": 25 },
                  "guidanceIgnoredMs": { "weight": 10, "per": 60000 } },
  "compliance": { "eligibleRoomSeen": { "weight": -30 },
                  "guidedRoomEntered": { "weight": -40 } },
  "thresholds": { "drifting": 30, "cursed": 75 },
  "redemption": { "policy": "reversible", "hysteresisMs": 30000 },
  "cursedIsSticky": false
}
```

Signal weights must be positive, compliance weights negative, and `drifting`
below `cursed` — all validated, because a sign error here is invisible until an
audience is in the building. These weights are a starting point awaiting
real-audience calibration, which is why the operator panel exposes live score
and manual override.

---

## 9. Outputs

### 9.1 Room output intents — live (stub adapter)

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

### 9.2 Phone commands — carried

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

### 9.3 Cue ownership — declared

A looping cue started on entry to state S is owned by S and auto-stopped on
exit, unless declared `persistent`. This makes orphaned audio a runtime
invariant rather than authoring discipline.

---

## 10. Inputs — declared

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

## 11. Event log — live

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

## 12. Operator and test surfaces — live

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

## 13. Peer relay and custom pages — carried

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

## 14. Versioning

The runtime rejects definitions whose `contractVersion` it does not support and
reports the mismatch to the operator. v3 is the only supported version; v1 and
v2 workshop shows were removed with the runtime that ran them.

Additive changes — new policies, page types, event types, cue commands — do not
bump the version. Renames and semantic changes will, and until Phase B closes,
both remain possible.
