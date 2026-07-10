# DIM Machine — Phase 1 (workshop platform)

Show-control runtime for the Interactive Theater Platform
(spec: `Specs/Interactive Theater Platform Spec.md` in the Drive project folder).

Phase 1 (spec §12): participant-authored **JSON statecharts drive real phones**
— inputs (taps, swipes, choices, shake) become XState events; state actions
become phone outputs (audio, video, pages, haptics). No location, no hardware,
no TouchDesigner.

The authoring-tool integration seam is **[CONTRACT.md](CONTRACT.md)** (I/O
contract v1, frozen — additions only).

## Run

```sh
npm install
npm start          # → http://localhost:4000
```

- **Phones:** `http://<machine-ip>:4000/` on each device (same WiFi) → tap **Join Show**
  (unlocks audio + motion permission, preloads assets).
- **Operator:** `http://<machine-ip>:4000/operator.html` → pick a show → **Load** → **▶ Start**.
- Local multi-phone testing in one browser: add `?u=1`, `?u=2`, … to get separate sessions.

## Show definitions

Drop `*.json` files (contract v1, see CONTRACT.md) into `shows/`. Assets they
reference go in `public/assets/` (audio: wav/mp3…, video: mp4/webm). Included:

- `example-haunting.json` — exercises the whole contract: pages, choice
  branching, input binding (`swipe.left → revealClue`), context + global
  variables, `${global.…}` live interpolation on pages, a vote gated by a
  guard (`votesForExit >= 2`), `sendTo` orchestrator advancing everyone,
  scheduled audio, haptics, author `log` actions, timed (`after`) transitions.
- `phase0-demo.json` — the Phase 0 hardcoded show, now as data.

## Architecture

- `server/runtime.js` — **ShowRuntime**: validates a definition, spawns one
  XState v5 actor per user, interprets the contract's action vocabulary
  (`output` / `raise` / `sendTo` / `broadcast` / `assign` / `log`) and guards,
  owns global variables (single owner, serialized writes — spec §3.4; writes
  replicate as `setVar` to phones + `global.changed` into machines), and
  produces per-user snapshots for reconnect resync.
- `server/index.js` — WebSocket bridge: sessions (token → user, survives
  refresh), clock-sync pongs, show loading from `shows/`, operator commands,
  telemetry, Phase 0 sync-test cues.
- `public/client.js` — phone cue player: NTP-style clock sync, asset preload
  (audio buffers + video blobs), scheduled Web Audio cues with join-in-progress
  loops, video overlay, haptics, display-variable store, snapshot resume.
- `public/pages.js` — interactive page library (`waiting`, `blank`, `text`,
  `prompt`, `gestureSurface`, `audioPlayer`, `videoPlayer`) emitting canonical
  input events; drag *moves* stay page-local (contract §3), only committed
  gestures are promoted.
- `public/operator.html` — load/start/stop shows, per-device state/page/role,
  event push (quick buttons harvested from the machine + custom), global
  variable readout, telemetry, log.

## Workshop-day flow

1. Participant exports a contract-v1 JSON from the authoring tool → drop in `shows/`.
2. Operator: Load → Start. Late joiners enter at the machine's initial state.
3. Phones respond to the participant's inputs/outputs live; operator can push
   any event to one phone or all, and assign roles (used by `broadcast`).

## Known limitations (deliberate, Phase 2 targets)

- In-memory only: server restart loses sessions and show state (event sourcing
  + snapshots are Phase 2, spec §10).
- One machine per user; no show-orchestrator statechart yet — `sendTo:
  orchestrator` forwards the event to every user machine (documented in the
  contract as Phase 1 behavior).
- Roles are manual (operator dropdown); assignment strategies are Phase 2.
- No auth on the operator panel; no asset cache service worker.
- A show definition change requires re-Load + re-Start (no hot reload).

## Sync testing (Phase 0 exit criteria still apply)

Operator → **⚡ Sync test** flashes all screens + plays a click at the same
`startAt`; per-device cue drift shows in the Devices table. Local measurements:
0–2 ms. Validate on venue WiFi with real phones (target ≤ 50 ms).
