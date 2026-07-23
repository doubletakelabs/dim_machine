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
- **Custom pages dev kit:** **`custom-pages-kit/`** — standalone folder to share with collaborators (`npm install && npm start`). Guide: **`custom-pages-kit/CUSTOM-PAGES.md`**
- **Operator:** `http://<machine-ip>:4000/operator.html` → pick a show → **Load** → **▶ Start**.
- **Author:** `http://<machine-ip>:4000/author.html` → inspect/edit show JSON, rooms, input scopes.
- Local multi-phone testing in one browser: add `?u=1`, `?u=2`, … to get separate sessions.

## Show definitions

Drop `*.json` files into `shows/`. Assets they reference go in `public/assets/`.

**Contract v1** (flat machine per user): `example-haunting.json`, `phase0-demo.json`

**Contract v2** (room actors — shared scene per physical room): `room-demo.json`

See [CONTRACT.md](CONTRACT.md). Room-mode shows use `rooms` instead of a top-level `machine`.

## Architecture

- `server/runtime.js` — **ShowRuntime**: contract v1 (one XState actor per user)
  or **v2 room mode** (one actor per room + zone membership sync). Owns globals,
  interprets the action vocabulary, fans room outputs to all members in a zone.
- `server/index.js` — WebSocket bridge: sessions, clock sync, `assignZone` /
  `startRoom` operator commands, show loading from `shows/`.
- `public/client.js` — phone cue player: NTP-style clock sync, asset preload
  (audio buffers + video blobs), scheduled Web Audio cues with join-in-progress
  loops, video overlay, haptics, display-variable store, snapshot resume.
- `public/pages.js` + `public/page-loader.js` — built-in pages + dynamic custom page loading.
- `public/custom-pages/` — collaborator page folders (drop-in at show time).
  Build and test in **`custom-pages-kit/`** before drop-in.
- `public/operator.html` — load/start/stop shows, per-device state/page/role,
  event push (quick buttons harvested from the machine + custom), global
  variable readout, telemetry, log.

## Room-mode test flow (`room-demo.json`)

1. Load → Start on the operator panel.
2. Join phones — they auto-enter **Lobby** as role **guest** (via `defaultRoom` / `defaultRole`).
3. Send `BEGIN` to **Room: Lobby** → all lobby phones advance together.
4. Reassign a phone to **Gallery** to test room transfer + late-join sync.
5. **Move all** → Gallery to shift everyone at once (optional "from room" filter).

## Workshop-day flow (contract v1)

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
