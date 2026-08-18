# Interactive Theater Show-Control Platform — Technical Specification

**Version:** 0.2 (Implementation draft)
**Date:** July 2026
**Status:** Phase 0 complete; Phase 1 workshop platform implemented in-repo (`dim_machine`). Contract v2 room mode and custom pages shipped ahead of original phasing. See §15.

---

## 1. Overview

This document specifies a distributed show-control platform for interactive, location-aware theater experiences. The system tracks many concurrent audience members through a show's narrative logic, reacts in real time to their location and actions, delivers synchronized audio/video/haptic cues to their devices, and drives room-scale outputs (projection, audio, practical effects) through TouchDesigner.

### 1.1 Core capabilities

- Hierarchical, parallel state machines ("statecharts") modeling per-user and show-wide state
- Role-based flows, including dynamically assigned "super-roles"
- Transitions driven by time, location (UWB / QR / NFC / BLE), user input, or manual operator push
- Real-time bidirectional communication with heterogeneous client devices (web app, native app, IoT hardware)
- Tight cross-device synchronization of audio/video/haptic playback
- Bidirectional TouchDesigner integration for room outputs and sensor inputs
- A web-based GUI with two modes: **Design** (authoring by non-technical directors) and **Live** (visualization + manual cueing during shows/rehearsals)
- Floor-plan-based zone authoring for location triggers
- Full event sourcing for crash recovery, replay, and analytics

### 1.2 Guiding principles

1. **Logic as data.** Show flows are serializable JSON statechart definitions, interpreted at runtime — never hardcoded. This is what makes the authoring GUI, simulation, and live visualization possible from a single source of truth.
2. **Everything is an event.** All inputs, regardless of hardware origin, are normalized into one canonical event format before reaching show logic.
3. **Thin clients.** Client devices sync a clock, preload assets, execute scheduled cues, and report inputs. All decisions live in the backend.
4. **Hardware is a deployment detail.** An adapter layer isolates show logic from sensing technology, so productions can mix and swap UWB, QR, NFC, BLE, and custom hardware without changing show definitions.
5. **Schedule, don't trigger.** Synchronization is achieved by sending timestamped future cues against a shared clock, never "play now" commands.

---

## 2. System Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        OPERATOR / DIRECTOR                     │
│              Web GUI  (Design mode ⇄ Live mode)                │
└───────────────▲────────────────────────────────▲───────────────┘
                │ WebSocket (control channel)    │
┌───────────────┴────────────────────────────────┴───────────────┐
│                       BACKEND (Node.js / JavaScript)           │
│                                                                │
│  ┌──────────────┐  ┌───────────────────────────────────────┐   │
│  │ Show          │  │ XState Runtime                        │   │
│  │ Orchestrator  │  │  • 1 actor per user (spawned)         │   │
│  │ (show-level   │──▶  • role machines composed at runtime  │   │
│  │  statechart)  │  │  • interprets JSON machine defs       │   │
│  └──────────────┘  └───────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Event Bus (canonical events in / cue commands out)        │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌───────────┐ ┌──────────┐ ┌─────────┐ ┌──────────────────┐  │
│  │ Adapter:  │ │ Adapter: │ │ Adapter:│ │ Adapter:          │  │
│  │ UWB RTLS  │ │ QR/NFC/  │ │ MQTT    │ │ TouchDesigner     │  │
│  │ (zones)   │ │ BLE      │ │ (IoT)   │ │ (OSC / WebSocket) │  │
│  └───────────┘ └──────────┘ └─────────┘ └──────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Persistence: event log (append-only) + state snapshots    │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────▲──────────────────▲──────────────────▲──────────────────┘
        │ WebSocket        │ MQTT             │ OSC / WebSocket
┌───────┴────────┐ ┌───────┴────────┐ ┌───────┴────────────────┐
│ Phone clients  │ │ IoT devices    │ │ TouchDesigner           │
│ (web / native) │ │ (flashlights,  │ │ (projection, audio,     │
│                │ │  props, etc.)  │ │  DMX/practicals,        │
│                │ │                │ │  room sensors)          │
└────────────────┘ └────────────────┘ └────────────────────────┘
```

### 2.1 Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend runtime | Node.js + **JavaScript** | Ecosystem alignment with XState, web clients, and GUI tooling; team is fluent in JS. (Optional JSDoc type hints available without adopting TypeScript or a build step) |
| State machine engine | **XState v5** | SCXML-style statecharts: hierarchy, parallel regions, actors, serializable definitions; a plain-JavaScript library (TypeScript optional), proven in prior prototypes |
| Phone transport | WebSocket (native **`ws`** in reference implementation; Socket.IO or custom reconnect layer also viable) | Works identically in web and native clients |
| IoT transport | MQTT (Mosquitto or EMQX broker) | Lightweight, designed for constrained devices, QoS levels |
| TouchDesigner transport | OSC (primary) + WebSocket DAT (for structured/bulk data) | Native TD support, low latency |
| GUI | React + React Flow | Standard node-graph editing; renders the same JSON definitions in both modes |
| Persistence | PostgreSQL (event log + snapshots + show definitions); Redis optional for hot state/pub-sub at scale | Simple, reliable, queryable for analytics. **Reference implementation: in-memory only (Phase 2).** |
| Clock sync | NTP-style offset estimation over WebSocket (e.g., timesync-style algorithm) | ~10–30 ms accuracy on decent WiFi |

---

## 3. State Machine Layer

### 3.1 Structure

- **Show Orchestrator (singleton actor).** A show-level statechart owning the global timeline: acts, scenes, global cues, show start/hold/stop. It broadcasts events to user actors and receives aggregate events (e.g., "80% of users have reached Zone 3").
- **User Session Actors (one per participant).** Each user is an XState actor interpreting a composed machine:
  - **Base machine** — states shared by all participants (onboarding, preshow lobby, acts, intermission, finale, exit).
  - **Role machine(s)** — parallel regions or invoked child machines attached at role-assignment time, containing role-specific flows.
  - Users are naturally in multiple states at once via parallel regions (e.g., `act2.chase` ∥ `audio.playing` ∥ `role.detective.hasClue`).
- **Role assignment service.** Assigns roles at defined points, either randomly, by rule ("first user to enter Zone 3," "has not held a lead role in a prior show," weighted draw), or manually by the operator. Super-roles swap in or overlay an additional machine on the user's session actor.

**Room actors (contract v2 — implemented).** For experiences where everyone in a physical room should share one narrative cursor (gallery lighting, group briefing, collaborative phone pages), the runtime spawns **one XState actor per room** instead of per user. Users are assigned to rooms via operator `assignZone` or a `defaultRoom` on join; the room actor's state is authoritative. Late entrants sync to the room's current cursor (entry outputs replayed to that user only). The room cursor **holds when empty** — leaving does not rewind. Inputs default to `scope: "room"` (fan to the room actor, outputs to all members); `scope: "personal"` is reserved for per-user side paths. v1 shows (top-level `machine` per user) continue to work unchanged. See `CONTRACT.md` §8 and `shows/room-demo.json`.

### 3.2 Machine definitions as data

All machines are stored as JSON documents (versioned, per show) and interpreted at runtime. Definition schema (simplified):

```jsonc
{
  "showId": "midnight-library-v3",
  "version": 12,
  "base": { /* XState-compatible statechart JSON */ },
  "roles": {
    "detective": { "machine": { /* ... */ }, "maxCount": 8 },
    "ghost":     { "machine": { /* ... */ }, "maxCount": 1,
                   "assignment": { "strategy": "random", "at": "act1.sceneEnd" } }
  },
  "globals": {                            // orchestrator-owned; see §3.4
    "votesForExit":  { "type": "number",  "initial": 0 },
    "ritualComplete":{ "type": "boolean", "initial": false }
  },
  "zones": [
    { "id": "library", "floorplanId": "fp-1",
      "polygon": [[x, y], ...], "sources": ["uwb", "qr:LIB-01"] }
  ],
  "cues": {
    "whisper-01": { "type": "audio", "asset": "whisper01.mp3",
                    "sync": "scheduled", "leadTimeMs": 2000 }
  }
}
```

Transitions in the statechart reference **abstract triggers** (`zone.enter:library`, `input.shake`, `timer:120s`, `manual:cue-14`), never hardware specifics.

### 3.3 Transition trigger types

| Trigger | Source | Example |
|---|---|---|
| Time | Orchestrator timers, per-state `after` delays | Auto-advance scene after 3 min |
| Location | Zone adapter (UWB / QR / NFC / BLE) | `zone.enter:library` |
| User input | Client input events | `input.shake`, `input.button:flashlight-A` |
| Manual push | Operator via Live GUI | `manual:cue-14`, targeted per user / role / all |
| Aggregate | Orchestrator computed conditions | "≥ 80% of users in finale zone" |
| External | TouchDesigner sensors | `sensor.pressure-plate:stage-left` |

### 3.4 Global State & Concurrency

Per-user machines each own their private `context`, which is naturally race-free (a single actor processes its events one at a time). **Global show variables** — shared counters, flags, and tallies visible across users (e.g., `votesForExit`, `doorsUnlocked`, `ritualComplete`) — are different: many user machines may read and write them concurrently, so ownership and ordering must be defined.

**The orchestrator is the sole owner of all global variables.** No user machine mutates global state directly. This gives a single authoritative sequence and eliminates races by construction:

- **Writes** are messages to the orchestrator, not direct assignments. A user machine's global-variable action (`assign scope:global`) is compiled into a `sendTo: orchestrator` event; the orchestrator applies mutations serially in receipt order. Concurrent `votesForExit +1` from two users therefore become two ordered increments, never a lost update.
- **Reads in guards** evaluate against the orchestrator's authoritative value. To keep guard evaluation synchronous and fast, the orchestrator pushes a read-only replica of global variables to each user actor on every change; user-machine guards read the replica, while all writes still route through the orchestrator. (Because writes are serialized and the replica is updated on each committed write, a guard never reads a value the orchestrator hasn't already committed — but a guard is advisory, so the orchestrator re-validates any transition whose correctness depends on a global value before committing side effects, closing the small replication window.)
- **Aggregate triggers** (§3.3) and cross-user broadcasts are computed by the orchestrator over this owned state, since it already holds the authoritative view.
- **Display** of a global value on phones goes out via `setVar` (§5.5) when the orchestrator commits a change, so all devices reflect the same committed value.
- **Persistence.** Global state is part of the orchestrator snapshot and the event log (§10); on recovery it is restored authoritatively and re-replicated to user actors.

Net effect for authors: they can freely read and increment shared variables from any machine without thinking about concurrency — the "single owner, serialized writes" model makes it safe, and the authoring tool simply exposes global variables as a named list distinct from per-user context.

---

## 4. Event Bus & Hardware Abstraction

### 4.1 Canonical event format

Every input from every source is normalized before entering show logic:

```jsonc
{
  "eventId": "uuid",
  "userId": "u-123",          // or null for show-level / room events
  "type": "zone.enter",       // dot-namespaced
  "payload": { "zoneId": "library" },
  "source": "uwb",            // uwb | qr | nfc | ble | client | mqtt | td | operator | timer
  "timestamp": 1720000000000, // server-corrected ms epoch
  "showId": "midnight-library-v3"
}
```

### 4.2 Adapters (inbound)

| Adapter | Responsibility |
|---|---|
| UWB RTLS | Consume vendor position stream; run point-in-polygon against floor-plan zones with hysteresis/debounce; emit `zone.enter` / `zone.exit` |
| QR | Treat a scan as an instantaneous zone event (`zone.enter` with `source: qr`) |
| NFC / BLE | Native app reports taps/proximity; adapter maps beacon/tag IDs → zones |
| Client input | WebSocket messages (`shake`, `button`, gesture start/stop) → input events |
| MQTT / IoT | Topic messages from custom hardware → input events |
| TouchDesigner | Inbound OSC/WebSocket from room sensors → sensor events |
| Operator | Live GUI manual pushes → manual events (fully audited) |

### 4.3 Continuous-input bypass

High-frequency continuous streams (e.g., finger-drag cursor control) **bypass the state machine** and stream directly to TouchDesigner (throttled, ~30–60 Hz over WebSocket/OSC). The state machine handles only the discrete envelope: `input.cursorControl.start` / `.stop`.

**Peer relay (implemented — phone-to-phone).** Custom interactive pages may also bypass the state machine for real-time, room-scoped fan-out between phones: arbitrary named channels carry JSON payloads over the existing WebSocket (`relay` messages). This is for collaborative UI (shared cursors, drawing, voting tallies displayed live) where flooding XState with 40 Hz events would be wrong. Relay is **room-scoped** by default (same audience as room outputs), rate-limited (~40 msg/s per device per channel), optionally persisted per channel so late joiners receive the last value from each peer. It does **not** replace promoted inputs — story branches still use canonical `input` events. See `CONTRACT.md` §6b and `custom-pages-kit/CUSTOM-PAGES.md`.

---

## 5. Client Layer

### 5.1 Client tiers & platform constraints

| Tier | Tech | Location capability | Notes |
|---|---|---|---|
| Web app (BYOD phones) | PWA, WebSocket | QR scan only, or none | **iOS Safari does not support Web Bluetooth / Web NFC / UWB access** — this constraint drives the tiering |
| Native app | **Android only** (for now), WebSocket | Adds BLE beacons + NFC | Reuse the same protocol; app is a shell around the same cue player. iOS users fall back to the web-app tier (QR / no location), which the iOS platform constraints below make the practical choice anyway |
| UWB RTLS tags | Vendor hardware (Eliko used previously; vendor-agnostic adapter) | Continuous positioning | **Deprioritized — no current plans to deploy.** The zone-adapter abstraction keeps this a drop-in addition later; no core architecture depends on it |
| Custom IoT devices | ESP32-class, MQTT | N/A (or fixed) | Flashlights, props; inputs + simple outputs (LED, vibration) |

### 5.2 Capability manifest

On connect, every client declares what it can do; the server only sends cues the device can render:

```jsonc
{ "clientId": "c-88", "userId": "u-123",
  "capabilities": { "audio": true, "video": true, "haptics": true,
                    "inputs": ["shake", "touchDrag"], "location": ["qr"] } }
```

### 5.3 Cue player responsibilities

1. Maintain clock sync (see §6)
2. Preload and cache all assets during the preshow/lobby state (also captures the user gesture required to unlock audio on iOS)
3. Execute scheduled cues: audio (Web Audio API scheduler), video, haptics (Vibration API / native haptics)
4. Report inputs and heartbeat/telemetry (battery, latency, sync quality) for the operator dashboard
5. Reconnect gracefully per the resilience protocol (§7): present session token, receive snapshot, resume seamlessly

### 5.4 Cue command format

```jsonc
{ "cueId": "whisper-01", "type": "audio",
  "assetId": "whisper01.mp3",
  "startAt": 1720000123456,     // server-time; client converts via offset
  "params": { "gain": 0.8, "loop": false },
  "fallback": "skip"            // skip | playImmediate | holdForOperator
}
```

### 5.5 Input/Output Contract (authoring-tool integration seam)

This is the stable schema that binds a participant-authored statechart to phone behavior — it should be frozen early, since the separately-built authoring tool targets it. Note that the phone is only *one* endpoint: some phone interactions never reach the machine, and many machine actions never reach a phone. The contract therefore describes both what crosses the phone↔machine boundary and what stays on either side of it.

**Inputs — two tiers.** Not every phone interaction becomes an XState event. Interactions fall into two tiers, and participants decide per-interaction which tier applies:

- **Page-local (client-only).** Handled entirely within the current interactive page; never sent to the backend. Examples: scrubbing a slider to preview a value, dragging to pan an image, tapping to toggle a local UI element, a swipe that just flips between cards on the page. These keep latency low and avoid flooding the machine with high-frequency or purely cosmetic events.
- **Promoted to XState events.** Sent to the backend as canonical events (§4.1) whose `type` matches an event the machine listens for. Only interactions the *narrative logic* cares about cross this boundary. Participants bind an interaction to an event name in the authoring tool; unbound interactions default to page-local.

```jsonc
// Promoted: phone emits when the user commits a choice the story branches on:
{ "userId": "u-123", "type": "swipe.left",
  "payload": { "velocity": 0.8 }, "source": "client", "timestamp": 1720000000000 }
// In the statechart: on: { "swipe.left": { target: "clueRevealed" } }
```

A single interaction can also do both — update the page immediately for responsiveness *and* emit an event (e.g., a drag that moves an on-screen object locally while its final position is reported to the machine on release). Continuous streams (`drag.move`) are throttled and, where they must reach the backend, can bypass the machine entirely (§4.3); for the workshop most continuous input stays page-local.

Standard captured interactions (extensible): `tap` / `button:<id>`, `swipe.<dir>`, `drag` (start/move/end, normalized coordinates), `shake`, `choice:<id>` (from a prompt page), `pageDismiss`.

**Actions — three targets.** Not every XState action produces a phone command. State entry/exit and transition actions dispatch to one of three targets, and a single state can fire several actions across different targets:

- **Phone-command actions.** Emit an output command the cue player renders (audio, video, page swap, haptic). This is the subset that reaches a device.

  ```jsonc
  { "type": "output", "userId": "u-123",
    "command": "showPage", "params": { "page": "mirror" }, "sync": "immediate" }
  ```

- **Machine-control actions.** Operate on the state machine itself rather than any phone: raise/send another event, transition a parallel region, spawn or stop a child actor, send an event to *another user's* machine or to the show orchestrator (e.g., one participant's action advances a scene for everyone, or assigns a super-role). These never leave the backend.

  ```jsonc
  { "type": "raise", "event": "sceneComplete" }                       // this machine
  { "type": "sendTo", "target": "orchestrator", "event": "advanceAct" } // show-level
  { "type": "broadcast", "role": "ghost", "event": "haunt" }           // other users
  ```

- **Context / global-variable actions.** Modify state without any transition or phone output: update this machine's context (XState `assign`), or read/write **global show variables** owned by the orchestrator (§3.4) — shared counters, flags, tallies (e.g., "votes cast," "doors unlocked," "has the ritual been completed"). Global variables can gate transitions via guards and can be surfaced to phones through `setVar` when a value needs to display, but every write routes through the orchestrator (§3.4), never a direct mutation.

  ```jsonc
  { "type": "assign", "scope": "context", "key": "cluesFound", "value": "+1" }
  { "type": "assign", "scope": "global",  "key": "votesForExit", "value": "+1" }
  ```

Participants bind states/actions to any of these targets in the authoring tool. The authoring vocabulary should make the target explicit (phone / machine / variable) so a non-technical author understands whether an action is "something the audience sees" versus "something that changes the show's logic."

Supported **phone output commands** (the device-facing subset):

| Command | Effect | Key params |
|---|---|---|
| `playAudio` | Play/loop an audio asset (scheduled or immediate) | `assetId`, `gain`, `loop`, `startAt?` |
| `stopAudio` | Stop/fade an audio asset | `assetId`, `fadeMs` |
| `playVideo` | Play a video asset full-screen | `assetId`, `loop`, `startAt?` |
| `showPage` | Swap the phone to a declarative interactive page | `page`, `props` |
| `haptic` | Fire a vibration pattern | `pattern` |
| `setVar` | Update a client-side display variable (text, timer, score) | `key`, `value` |

**Interactive pages** are a small library of declarative phone screens selected by `showPage`, so participants compose experiences without writing front-end code: `audioPlayer`, `videoPlayer`, `prompt` (choice buttons that emit `choice:<id>` events), `gestureSurface` (captures swipes/drags), `text` (timed or static copy), `blank`/`waiting`. New page types are additive.

**Custom pages (implemented).** When declarative pages are not enough, collaborators author **custom pages**: a folder under `public/custom-pages/<pageName>/` with a required `page.js` (registers a renderer via `DIM.registerPage`) and optional `styles.css` and assets. The show references them by folder name in `showPage` params (`"page": "cursorArena"`). Custom pages use the same phone API surface as built-ins — `DIM.emit` for promoted inputs, `DIM.relay` for peer fan-out, `DIM.vars` / `${key}` interpolation for display variables — but may implement arbitrary DOM and interaction logic. **Development workflow:** collaborators work in a standalone **`custom-pages-kit/`** (own Express + WebSocket preview server, default port 3333) without the main repo; when ready, they hand off the page folder for drop-in at show time. The runtime lists installed pages at `GET /api/custom-pages`. Terminology is **custom pages** (not "student pages" or other labels).

The client loads scripts in order: `page-loader.js` → `pages.js` → `client.js`. The page loader registers `DIM.registerPage` / `DIM.pageAsset` before `client.js` builds the final `window.DIM` object; the runtime **must preserve** those hooks when attaching `emit`, `relay`, and session state (replacing the whole object without merging breaks async custom page registration).

The contract is transport-agnostic and versioned; the authoring tool and runtime negotiate a contract version on load so the two tools can evolve independently.

---

## 6. Synchronization Protocol

The single most important real-time design decision: **the server never says "play now"; it says "play at T."**

1. **Clock sync.** Each client continuously estimates its offset from server time via NTP-style ping/pong over the existing WebSocket (multiple samples, discard outliers, exponential smoothing). Target accuracy: 10–30 ms on managed WiFi. Sync quality is reported as telemetry.
2. **Scheduled cues.** Cues carry a `startAt` server timestamp with configurable lead time (default 2 s). Clients convert to local time and schedule.
3. **Sample-accurate audio.** Audio cues are scheduled against the Web Audio API clock (mapped from the corrected wall clock), not `setTimeout`.
4. **Preloading.** All assets are downloaded and decoded in the lobby state. Late arrivals get a catch-up preload flow.
5. **Late/failed cue policy.** Each cue declares a `fallback`: skip silently, play immediately (acceptable drift), or hold for operator decision.
6. **Drift monitoring.** Clients report actual vs. scheduled start; the Live GUI surfaces out-of-tolerance devices.

---

## 7. Connection Resilience & Session Persistence

WebSocket over TCP is reliable *while connected*; the failure mode to design for is disconnection — a WiFi blip, a page refresh, a phone locking — after which any messages sent during the gap are gone. Reliability is therefore built as a layer above the transport, anchored to the backend's authoritative state.

### 7.1 Persistent sessions (page refresh / return survival)

- On first join (QR onboarding link or lobby page), the server issues an opaque **session token**, stored client-side in both a cookie and `localStorage` (belt-and-suspenders; survives refresh, tab close, and browser restarts within the show window).
- The session token maps to the user's **session actor** on the backend — their states, role, assigned cues, and history. The actor's lifecycle is independent of any socket connection: a disconnect marks the user as `offline` but never destroys their state.
- On any page load, the client presents its token and is **rebound to the same user actor**, resuming exactly where they were in the experience. A user who refreshes mid-scene comes back into that scene, with their role intact.
- Tokens are scoped to a single show run and expire afterward. A token presented with no live show (or an ended one) routes to a graceful "show has ended" page.
- Operator affordance: the Live GUI can reissue/transfer a session to a new device (e.g., a phone dies mid-show and the user is handed a spare).

### 7.2 Reliability layers (in order of engagement)

1. **Fast failure detection.** Application-level ping/pong every 2–5 s in both directions (shared with clock-sync traffic). Missed heartbeats trigger an immediate teardown and reconnect with exponential backoff + jitter, rather than waiting for TCP timeouts (which can take 30+ s).
2. **Sequenced messages + replay buffer.** Every server→client message carries a monotonic sequence number; the server keeps a short per-client ring buffer. On reconnect the client reports its last-seen sequence and the server replays the gap. Handles brief blips with minimal traffic.
3. **Snapshot resync (authoritative backstop).** On every reconnect — regardless of whether replay succeeded — the server sends a full **state snapshot**: current state(s), role, active and pending cues, and show clock. The client rebuilds from the snapshot rather than trusting message history. Correctness never depends on the replay buffer; this reuses the same serialization path as crash recovery (§10).
4. **Scheduled cues self-heal.** Because cues are "play at T" not "play now" (§6), any snapshot-delivered cue with a future `startAt` is scheduled normally — the user rejoins in perfect sync. Past-`startAt` cues follow their declared `fallback`; long-running content (e.g., audio beds) uses **join-in-progress**: seek to `now − startAt` and the client lands exactly where every other device is.
5. **Upstream durability.** Client inputs are queued locally with client-side sequence numbers and flushed on reconnect; the server dedupes by event ID. A QR scan or button press during a blip still counts exactly once.
6. **Asset cache persistence.** Preloaded assets are cached via the Cache API/service worker, so a page refresh does not re-download the show's media — resync after refresh is near-instant.

### 7.3 Operator visibility

Offline users are flagged in the Live GUI (state graph and floor plan) with time-since-disconnect. Configurable per-show policy for prolonged absence (e.g., > 2 min): hold the user's state, auto-park them in a catch-up state, or alert the operator for a manual decision.

**Implementation note:** Socket.IO provides heartbeats, auto-reconnect, and buffered delivery (layers 1–2, part of 5) out of the box. Layer 3 (snapshot resync) and §7.1 (session persistence) are custom and non-negotiable regardless of transport library, since they bind reconnection to the state machine's source of truth.

---

## 8. TouchDesigner Integration

TD is a **peer on the event bus**, responsible for room-scale output; the backend owns all logic.

**Outbound (backend → TD):**
- OSC with a stable namespace:
  - `/show/state/<path>` — orchestrator state changes
  - `/show/cue/<cueId>` — room cues (projection, audio, practicals/DMX)
  - `/user/<id>/state/<path>` — per-user state (for per-user projection mapping, etc.)
  - `/stream/<channel>` — continuous data (e.g., forwarded cursor positions)
- WebSocket DAT for structured JSON when OSC's flat format is limiting (e.g., full roster snapshots).

**Inbound (TD → backend):**
- TD packages sensor data (pressure plates, cameras/CV, mic levels, custom rigs) as canonical events over OSC/WebSocket → `sensor.*` events into the bus.

**Resilience:** heartbeat both directions; the backend flags TD disconnect in the Live GUI; on reconnect, backend replays current-state snapshot so TD can resync.

---

## 9. GUI Tool (Design Mode ⇄ Live Mode)

One web application, one underlying document (the JSON show definition), two modes behind a toggle.

### 9.1 Design mode (directors, non-technical)

- Node-graph editor (React Flow) over the statechart JSON: states, nested states, parallel regions rendered as containers
- Transition editor with a constrained trigger vocabulary: *timer, zone, input, manual, aggregate, sensor* — no code required; an "advanced" escape hatch allows guard expressions for technical users
- Role tabs: base flow + per-role overlays, with visual indication of which states are shared vs. role-specific
- Cue library: define audio/video/haptic/room cues, attach to state entry/exit/transitions
- **Floor-plan editor:** upload image → calibrate scale/origin to real-world coordinates → draw zone polygons → bind zones to trigger sources (UWB, specific QR codes, NFC tags, beacons)
- **Simulation:** spawn virtual users, step them through the flow (fake zone entries, fake inputs), watch state and cues fire — full show logic testing with zero hardware
- Versioning: definitions are versioned; shows run against a pinned version

### 9.2 Live mode (operator, during shows/rehearsals/prototyping)

- Same graph, live-decorated: each state shows occupancy count; click to list users; each user inspectable (current states, role, device telemetry, sync quality)
- Floor plan with real-time user positions (when UWB present)
- **Cue stack / manual push panel:** fire any manual transition or cue, targeted to one user, a role, a zone, or everyone — every push is logged as an operator event
- Override controls: force-move users between states, hold/resume the show clock, rollback to a snapshot
- Health dashboard: client connections, battery, latency, drift, TD link status, adapter status
- Rehearsal tools: jump-to-scene (fast-forwards timeline and re-broadcasts state), replay of recorded shows

---

## 10. Persistence & Recovery

- **Event sourcing.** Every canonical event and every state transition is appended to an immutable log (PostgreSQL).
- **Snapshots.** Full serialized state of orchestrator + all user actors every N seconds and at scene boundaries.
- **Crash recovery.** On restart: load latest snapshot, replay subsequent events, re-broadcast state to all clients and TD. Target recovery < 10 s.
- **Analytics.** The log directly answers post-show questions: dwell time per scene/zone, path analysis, input engagement rates, cue delivery success, per-role journeys.
- **Replay.** Recorded shows can be replayed into the Live GUI (and optionally into TD) for review and debugging.

---

## 11. Non-Functional Requirements

| Concern | Target |
|---|---|
| Scale | **50 concurrent devices max** per show, single show at a time (design with headroom to ~100 so scale never becomes an architecture question) |
| Deployment | **Fully local to the venue.** Backend, MQTT broker, database, asset server, and GUI all run on a single on-site machine (or a small local server + operator laptop). No cloud dependency during shows; internet only needed for development and pre-show asset loading if desired |
| Cue sync accuracy | ≤ 50 ms perceived skew between adjacent devices (confirmed acceptable); no phase-level audio sync required |
| End-to-end input latency (input → state change → cue out) | ≤ 150 ms |
| Recovery time after backend crash | ≤ 10 s |
| Asset delivery | Served from the local machine over venue LAN — trivial at 50 devices; no CDN needed |
| Network | Dedicated, professionally configured venue WiFi (5 GHz, QoS; at 50 devices, 1–2 quality APs suffice). **Venue networking remains the highest operational risk — treat it as part of the product.** |
| Security | Per-show client tokens; operator auth for GUI; MQTT auth; no audience PII beyond an opaque session ID unless a production requires it |

---

## 12. Implementation Phases

The near-term driver is a **participant workshop in ~2 weeks**, where participants co-author their own statecharts (in a separate authoring tool being built in parallel), run them live, and have those statecharts drive real phone experiences. The phasing below front-loads the input→XState→action→phone loop that the workshop depends on, and defers location, hardware, and TouchDesigner work.

### Phase 0 — Proof of concept (de-risk sync + cueing) ✅ *Complete*
- Hardcoded XState machine, ~5–10 phones on a web app
- WebSocket transport, clock sync + scheduled audio cues
- Bare-bones manual cue panel
- Minimal resilience: session token + snapshot-on-reconnect (enough to survive a page refresh)
- **Exit criteria:** measured sync skew ≤ 50 ms across devices on venue-like WiFi; a mid-scene page refresh returns the user to the same point within ~2 s

**Built:** `public/client.js` (NTP-style clock sync, Web Audio scheduled cues, join-in-progress loops, session token in cookie + `localStorage`, snapshot restore on reconnect). Operator sync-test cue. Local measurements 0–2 ms; venue WiFi validation still recommended.

### Phase 1 — Workshop platform: runnable statecharts driving phones ⭐ ✅ *Largely complete*
The goal is a complete authoring → runtime → phone loop, with **no location, no hardware, no TD**.

- **Runtime:** load a participant-authored JSON statechart into the XState runtime and run it live (one machine per user; a hardcoded or simple manual role/assignment is fine for now).
- **Inputs (phone → XState events).** The web app captures interactions — button/tap presses, finger swipes/drags, shake, on-screen control widgets — and sends them as canonical events into the running machine. Participants bind specific interactions to specific XState events in their authoring tool (e.g., `swipe.left → event: "revealClue"`).
- **Actions (XState → phone outputs).** State entry/exit and transition actions map to output commands the phone renders: play audio, play video, show/replace an interactive page or UI screen, trigger haptics. Participants bind states/actions to these outputs in their authoring tool (e.g., `on entry of state "haunted" → action: playAudio("whispers.mp3") + showPage("mirror")`).
- **Input/output contract.** A documented, stable schema for the two directions (event names in, action/output commands out) that the separate authoring tool targets. This contract is the integration seam between the two tools and should be frozen early.
- **Delivery:** operator can start a machine and push manual states/cues to users; phones sync clock, preload assets, render outputs, report inputs (reuses Phase 0 transport + resilience).
- **Interactive pages:** a small set of declarative phone "screens" (audio player, video player, prompt/choice page, gesture-capture surface) selectable by action, so participants compose experiences without custom front-end work.
- **Exit criteria:** a participant authors a statechart in the separate tool, loads it, and a room of phones responds to their inputs and receives their outputs live — with no engineer in the loop at run time.

**Built (repo: `dim_machine`, port 4000):**

| Area | Status | Notes |
|---|---|---|
| I/O contract v1 | ✅ Frozen | `CONTRACT.md`; `contractVersion: 1` in show JSON |
| XState runtime (v1) | ✅ | One actor per user; globals, guards, action vocabulary |
| Built-in interactive pages | ✅ | `public/pages.js` — waiting, text, prompt, gestureSurface, audioPlayer, videoPlayer |
| Operator panel | ✅ | `public/operator.html` — load/start/stop, per-device state, event push, globals, telemetry, sync test |
| Author inspector | ✅ | `public/author.html` — edit show JSON, rooms, input scopes |
| Example shows | ✅ | `example-haunting.json`, `phase0-demo.json` |
| Session + snapshot | ✅ | Token persistence; reconnect restores page, vars, active cues |
| Roles | ⚠️ Manual | Operator dropdown; no assignment strategies yet |
| `sendTo: orchestrator` | ⚠️ Stub | Forwards to every user machine (Phase 1 documented behavior) |

**Also shipped ahead of Phase 2 (workshop-driven):**

| Area | Status | Notes |
|---|---|---|
| Contract v2 room mode | ✅ | `contractVersion: 2`; one actor per room; `shows/room-demo.json` |
| Zone assignment | ✅ | Operator `assignZone`, `moveAllToRoom`, `defaultRoom` on join |
| Room operator controls | ✅ | `forceRoomState`, `startRoom`, room roster in operator UI |
| Input scope | ✅ | `inputBindings` with `scope: "room"` \| `"personal"` |
| Custom pages + peer relay | ✅ | `public/custom-pages/`, `custom-pages-kit/`, `CONTRACT.md` §6b |
| Force-state audio hygiene | ✅ | `stopRoomOutputs` before room state override; `skipActiveCues` on resync |

**Not yet built (still Phase 2+):** event sourcing, PostgreSQL, sequenced replay buffer, Design-mode React Flow GUI, location adapters, TouchDesigner, native Android app, service-worker asset cache, operator auth.

### Phase 2 — Core platform hardening
- Per-user actors + show orchestrator formalized; JSON-interpreted machine definitions with versioning
- Role assignment (random + rule-based); super-role logic
- Event bus + adapter layer generalized (QR location added here as the first location adapter, client inputs, operator)
- Event sourcing + snapshots + recovery; full connection-resilience layer (§7): heartbeats, sequenced replay buffer, snapshot resync, upstream input queueing, session lifecycle + operator device-transfer
- Design-mode GUI maturation: graph editing, trigger vocabulary, cue library, simulation with virtual users
- **Exit criteria:** a director builds and simulates a small show without engineering help

### Phase 3 — Show control + TouchDesigner
- **Bidirectional TouchDesigner integration** (§8): OSC/WebSocket, room cues out, sensors in
- Live mode: occupancy visualization, cue stack, targeted pushes, overrides, health dashboard
- Floor-plan editor + zone binding; rehearsal tools (jump-to-scene, replay)

### Phase 4 — Hardware expansion & hardening
- Native **Android** app (BLE beacons, NFC); MQTT IoT devices (custom flashlight)
- UWB RTLS adapter: **deferred** — build only when a production calls for it (the zone abstraction means this is additive)
- Load testing at 50 devices (and 2× headroom); chaos testing (kill backend mid-show, drop the AP)
- Venue network playbook; show-day operational runbook for the single on-site machine

---

## 13. Resolved Decisions

| Question | Decision |
|---|---|
| UWB vendor | No current deployment plans; Eliko used previously. Adapter layer stays vendor-agnostic so any vendor can be integrated later without core changes. UWB work deferred to when a production requires it. |
| Native app platforms | **Android only** for now; iOS users use the web-app tier. |
| Multi-tenancy | **Single show at a time.** No multi-show orchestration needed; simplifies backend to one orchestrator instance and one active show definition. |
| Scale & deployment | **≤ 50 devices, fully local to the venue.** Single on-site machine hosts everything; assets served over LAN; no CDN or cloud dependency. |
| Audio sync | ≤ 50 ms skew confirmed sufficient; no phase-level sync techniques required. |
| Implementation language | **Plain JavaScript on Node.js** (not TypeScript). XState is a JS library and works identically without types; team is fluent in JS. Optional JSDoc hints available if wanted, with no build step. **Python** is a fine choice for peripheral services (UWB/sensor processing, computer vision, analytics over the event log, offline show-definition tooling), which talk to the core over WebSocket/MQTT/OSC — but the state-machine core stays JS, since no Python statechart library matches XState's parallel regions, actors, and GUI-round-trippable serializable definitions. |
| WebSocket library | **Native `ws`** (not Socket.IO). Custom reconnect + ping/pong + snapshot resync. Socket.IO's buffered delivery deferred; snapshot-on-reconnect is the authoritative backstop (§7.2). |
| I/O contract versioning | **v1 frozen** (per-user machine). **v2 additive** (room actors + scoped inputs). Additive fields only within a version; breaking changes bump version. Authoritative schema: repo `CONTRACT.md`. |
| Room vs user machines | **Both supported.** v1 = one XState actor per phone. v2 = one actor per room; phones in the same room share state. Chosen for workshop scenarios where a physical space should feel synchronized (gallery lighting, group pages). |
| Custom page authoring | **Standalone kit** (`custom-pages-kit/`) shared with collaborators who do not need the main repo. Preview on port **3333**; production drop-in to `public/custom-pages/`. Guide: `custom-pages-kit/CUSTOM-PAGES.md`. |
| Real-time phone collaboration | **Peer relay** on the main WebSocket — not XState events, not TouchDesigner. Room-scoped channels, JSON payloads, optional persist-for-late-join. Custom pages opt in via `DIM.relay`. |
| Operator force-state | **`forceRoomState`** replays entry outputs to all room members. **Must stop active room audio first** (`stopRoomOutputs`) so orphaned beds do not continue after a hard jump (e.g. gallery `lit` → `cursors`). Resync uses `skipActiveCues` to avoid double-playing stale cues. |
| Persistence (interim) | **In-memory only** until Phase 2. Server restart loses sessions and show state. Deliberate tradeoff for workshop velocity. |
| Operator security (interim) | **No auth** on operator panel. Acceptable on isolated venue LAN for Phase 1; Phase 2 target. |
| Show reload | Definition change requires operator **re-Load + re-Start** — no hot reload. |

## 14. Remaining Open Item

- **Accessibility** (captioning cues, non-audio alternatives): pending internal team discussion. Recommendation regardless of outcome: give every cue an optional `alternatives` field in the cue schema now (e.g., `{ "text": "...", "haptic": "pattern-id" }`). It costs nothing while the schema is young and avoids a painful retrofit if requirements land later.

---

## 15. Implementation Reference (July 2026)

This section records what exists in the **`dim_machine`** reference implementation and how it maps to this spec. It is the living counterpart to §12–§13 for anyone reading the spec without the repo.

### 15.1 Repository layout

```
dim_machine/
  CONTRACT.md              ← frozen I/O contract (v1 + v2 rooms + peer relay)
  shows/*.json             ← show definitions (v1 and v2 examples)
  server/
    index.js               ← WebSocket server, operator commands, relay routing
    runtime.js             ← ShowRuntime: XState v1/v2 dual mode
    relay.js               ← room-scoped peer relay (rate limit, persist, sync)
  public/
    client.js              ← phone cue player, DIM API (emit, relay, vars, self)
    pages.js               ← built-in page renderers
    page-loader.js         ← dynamic custom page load + registerPage
    custom-pages/<name>/   ← drop-in collaborator pages (page.js, styles.css, assets)
    operator.html          ← live show control
    author.html            ← show JSON editor / inspector
  custom-pages-kit/        ← standalone dev kit (share without main repo)
    CUSTOM-PAGES.md        ← canonical authoring guide for LLM + human collaborators
    server.js              ← preview server (port 3333)
    public/page-preview.html
```

### 15.2 Runtime behavior (as built)

**Show lifecycle.** Operator loads a JSON file from `shows/`, then Start with connected phone tokens. Late joiners receive `defaultRoom` / `defaultRole` (v2) or the machine initial state (v1). Stop tears down actors and sends a waiting page.

**Clock sync.** Ping/pong over WebSocket; client estimates offset with outlier rejection and smoothing. Scheduled cues use `startAt` server timestamps; audio via Web Audio API scheduling. Drift reported per cue; operator sync-test fires a flash + click to all devices.

**Resilience.** Opaque session token (cookie + `localStorage`); on reconnect, server sends snapshot (state string, page, display vars, active loop/video cues, relay cache). No sequenced replay buffer yet — snapshot is the backstop.

**Room mode (v2).** Rooms defined under `rooms` in show JSON, each with its own statechart. `startOn: "firstEnter"` starts the room actor when the first user enters; `"operatorOnly"` waits for `startRoom`. Operator can `assignZone` (move one phone), `moveAllToRoom` (bulk, optional from-room filter), `forceRoomState` (jump + replay entry), `sendEvent` with target `room:<id>`. Room outputs (`showPage`, `playAudio`, etc.) fan to all members; `inputBindings` route phone inputs to the room actor when `scope: "room"`.

**Custom pages.** `showPage` with an unknown page name triggers async load of `/custom-pages/<name>/page.js`. Page calls `DIM.registerPage(fn)`; `pages.js` invokes the renderer and loads co-located CSS. Example: `cursorArena` — tap sends normalized `{x,y}` on relay channel `"cursor"`; all phones in the same room see dots. Relay requires both phones assigned to the **same room** on the main server (preview kit simulates relay across tabs via a local WebSocket).

**Phone API (`window.DIM`).**

| API | Purpose |
|---|---|
| `DIM.emit(type, payload?)` | Promote interaction → canonical input event |
| `DIM.relay.send(channel, payload, opts?)` | Room-scoped peer fan-out (not state machine) |
| `DIM.relay.on(channel, fn)` | Subscribe; receives cached values for late handlers |
| `DIM.vars` / `${key}` in props | Display variables from `setVar` |
| `DIM.self` | `{ userId, label, token }` after join |
| `DIM.registerPage(fn)` | Custom page registration (via page-loader) |
| `DIM.pageAsset(file)` | Resolve path under active custom page folder |

### 15.3 Example shows

| File | Contract | Purpose |
|---|---|---|
| `phase0-demo.json` | v1 | Sync + audio cue smoke test |
| `example-haunting.json` | v1 | Full narrative with prompts, gestures, globals |
| `room-demo.json` | v2 | Lobby + Gallery rooms; gallery states `dark` / `lit` / `finale` / `cursors` (custom page) |

**Room demo flow:** Load → Start → phones auto-enter Lobby → operator sends `BEGIN` to lobby room → reassign or move all to Gallery → flip lights (`button:lights`) → operator force state `cursors` for shared cursor page.

### 15.4 Intentional gaps (spec vs repo)

These remain as specified for Phase 2+ and are **not** oversights:

- Event sourcing, PostgreSQL, crash recovery < 10 s
- Show orchestrator singleton actor (globals are server-owned maps, not a separate orchestrator machine)
- Role assignment strategies; super-roles
- Location adapters (UWB, QR, NFC, BLE)
- TouchDesigner OSC/WebSocket integration
- Design-mode React Flow GUI; simulation with virtual users
- Sequenced message replay buffer; upstream input queue on disconnect
- Service worker / Cache API for assets
- Operator authentication

### 15.5 Related documents

| Document | Role |
|---|---|
| `CONTRACT.md` | Machine-readable integration seam for authoring tool |
| `README.md` | Run instructions, architecture summary |
| `custom-pages-kit/CUSTOM-PAGES.md` | Custom page + relay authoring (standalone) |
| `docs/CUSTOM-PAGES.md` | Pointer to kit guide from main repo |

---

*End of specification.*
