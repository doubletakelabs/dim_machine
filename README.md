# DIM Machine — Phase 0

Proof of concept for the Interactive Theater Show-Control Platform
(spec: `Specs/Interactive Theater Platform Spec.md` in the Drive project folder).

Phase 0 goal (spec §12): de-risk **clock sync + scheduled cueing** across ~5–10
phones, with a hardcoded XState machine, a bare-bones operator panel, and just
enough resilience to survive a page refresh.

## Run

```sh
npm install
npm start          # → http://localhost:4000
```

- **Phones:** open `http://<machine-ip>:4000/` on each device (same WiFi), tap **Join Show**.
  The tap is required — it's the user gesture that unlocks audio on iOS/Android.
- **Operator:** open `http://<machine-ip>:4000/operator.html`.

Test audio (click / ambient loop / whisper / chime) is generated locally —
regenerate with `npm run assets`.

## What's implemented

| Spec item | Where |
|---|---|
| Hardcoded XState v5 show machine (`lobby → act1 → act2 → finale → ended`) | `server/machine.js` |
| WebSocket transport + JSON protocol | `server/index.js`, `public/client.js` |
| NTP-style clock sync (ping bursts, lowest-RTT median, smoothing) — §6.1 | `client.js` `clock` |
| Scheduled cues: `startAt` server timestamp, 2 s default lead, Web Audio scheduling — §6.2–6.3 | `pushCue` / `playAudio` |
| Asset preload + decode on join — §6.4 | `preload()` |
| Late-cue policy: ≤500 ms late one-shots play immediately, older skip; loops join-in-progress (seek to `now − startAt`) — §7.2.4 | `playAudio` |
| Session token (localStorage + cookie) → server rebinds the same user; snapshot resync on every (re)connect — §7.1, §7.2.3 | `hello` / `welcome` / `snapshotFor` |
| Auto-reconnect with backoff | `client.js` `connect()` |
| Manual cue panel: machine events, ad-hoc cues (all or per-phone), device telemetry (offset/RTT/jitter/cue drift), event log | `public/operator.html` |
| Sync-skew instrumentation: **⚡ Sync test** flashes every screen + plays a click at the same `startAt`; each phone reports actual-vs-scheduled drift | `synctest` cue, `cueReport` |

## Exit-criteria test procedure

1. **Sync skew ≤ 50 ms:** join 5–10 phones on venue-like WiFi, press **⚡ Sync test**.
   Judge the flash/click alignment by eye/ear (a slow-mo phone video of the row of
   screens gives a hard number), and check each device's reported cue drift plus
   clock jitter in the Devices table. Local testing showed 0–2 ms drift.
2. **Refresh recovery ≤ 2 s:** with the show in `act1` (ambient loop playing),
   refresh a phone. It reconnects as the same user, re-taps Join (browser audio
   gesture), and lands back in `act1` with the loop seeked to where every other
   phone is.

## Known Phase 0 limitations (deliberate)

- Sessions and show state are **in-memory** — a server restart resets the show
  (clients auto-reconnect and resync to it). Event sourcing/crash recovery is Phase 2 (§10).
- One shared show-level machine; per-user actors, roles, and JSON-loaded
  definitions are Phase 1/2.
- Cues already delivered to phones still fire if the show is RESET inside their
  lead window (no cue cancellation yet).
- Assets re-download on refresh (no service-worker cache yet — §7.2.6 is Phase 2).
- No auth on the operator panel; anything on the LAN can drive the show.

## Protocol sketch (will grow into the §5.5 contract in Phase 1)

Phone → server: `hello{token?}`, `ping{t0}`, `telemetry{offset,rtt,jitter}`, `cueReport{cueId,targetAt,actualAt}`
Server → phone: `welcome{token,label,assets,snapshot}`, `pong{t0,server}`, `state{state}`, `cue{cue}`
Cue: `{cueId, kind: audio|flash|stopAudio|synctest, assetId?, gain, loop, fadeMs, startAt}`
Operator → server: `hello{role:'operator'}`, `send{event}`, `pushCue{cue, target:'all'|token}`
Server → operator: `roster{users,state,events,assets}`, `log{line,at}`
