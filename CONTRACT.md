# DIM Machine — Input/Output Contract v1 (FROZEN)

This is the integration seam between the **authoring tool** and the **runtime**
(spec §5.5). Version 1 is frozen: fields may be **added** (new page types, new
input types, new commands, new params), but existing names and shapes will not
change. The show definition declares `"contractVersion": 1`.

---

## 1. Show definition (what the authoring tool exports)

```jsonc
{
  "contractVersion": 1,
  "showId": "my-show",
  "name": "My Show",                     // display name
  "machine": { /* XState-compatible statechart JSON, see §2 */ },
  "inputBindings": {                     // optional: rename canonical inputs → machine events
    "swipe.left": "revealClue"           // unbound inputs pass through under their canonical name
  },
  "globals": {                           // optional: orchestrator-owned shared variables
    "votesForExit": { "type": "number", "initial": 0 }
  },
  "roles": ["ghost", "detective"],       // optional: assignable via operator; used by broadcast
  "assets": ["whispers.mp3", "intro.mp4"] // preloaded on phones; served from /assets/
}
```

One machine is spawned **per user** (Phase 1). Every user runs the same
machine; roles are assigned manually by the operator and filter `broadcast`.

## 2. Machine JSON

Standard XState statechart JSON: `initial`, `states`, nested states, `on`,
`after` (ms-keyed delayed transitions), `always`. Actions appear in `entry`,
`exit`, or a transition's `actions` (single object or array). Guards appear as
`guard` on a transition.

```jsonc
{
  "initial": "waiting",
  "states": {
    "waiting": { "on": { "START": "intro" } },
    "intro": {
      "entry": [
        { "type": "output", "command": "showPage",
          "params": { "page": "text", "props": { "title": "It begins…" } } },
        { "type": "output", "command": "playAudio",
          "params": { "assetId": "ambient.wav", "loop": true }, "sync": "scheduled" }
      ],
      "after": { "8000": { "target": "doorChoice" } }
    }
  }
}
```

## 3. Inputs (phone → machine)

Canonical interaction events. **Page-local interactions never reach the
backend**; only these committed interactions are promoted (spec §5.5 tiers).
The machine hears them as XState events — either under the canonical name or
renamed via `inputBindings`. Payload fields ride on the event object under
`payload`.

| Canonical event type | Emitted by | Payload |
|---|---|---|
| `tap` | gestureSurface tap | `{ x, y }` normalized 0–1 |
| `button:<id>` | any page's `buttons` | — |
| `choice:<id>` | prompt page choice | — |
| `swipe.left/.right/.up/.down` | gestureSurface | `{ velocity }` |
| `drag.end` | gestureSurface drag release | `{ x, y }` normalized final position (moves are page-local) |
| `shake` | device motion (throttled 1/s) | — |
| `pageDismiss` | dismissible text page | — |
| `video.ended` | non-loop video finishing | `{ assetId }` |

Operator manual pushes arrive as plain events of any name (e.g. `START`),
targeted at one user or all. The server may also deliver `global.changed`
(payload `{ key, value }`) after any global variable write, so machines can
re-check guards.

## 4. Actions (machine → three targets)

Every action object has a `type`. Unknown types are logged and skipped.

### 4.1 Phone-command actions — `{ "type": "output", "command": …, "params": …, "sync"? }`

`sync`: `"immediate"` (default) or `"scheduled"` (cue carries a future
`startAt`; lead time `params.leadTimeMs`, default 2000). Scheduled is for
moments that must land in sync across devices (spec §6).

| `command` | Effect | `params` |
|---|---|---|
| `playAudio` | play an audio asset | `assetId`, `gain?` (0–1), `loop?`, `leadTimeMs?` |
| `stopAudio` | stop/fade audio | `assetId?` (default `"*"` = all), `fadeMs?` |
| `playVideo` | full-screen video overlay | `assetId`, `loop?`, `leadTimeMs?` |
| `showPage` | swap the phone to a declarative page (clears any video) | `page`, `props` |
| `haptic` | vibration | `pattern` (ms array, e.g. `[200,100,200]`) |
| `setVar` | set a client display variable | `key`, `value` |

### 4.2 Machine-control actions (never leave the backend)

```jsonc
{ "type": "raise", "event": "sceneComplete", "payload"?: {} }      // this user's machine
{ "type": "sendTo", "target": "orchestrator", "event": "advanceAct" } // Phase 1: forwarded to every user machine
{ "type": "broadcast", "event": "haunt", "role"?: "ghost", "payload"?: {} } // all users, or one role
{ "type": "log", "message": "reached the crypt" }                  // operator log (author debugging)
```

### 4.3 Context / global-variable actions

```jsonc
{ "type": "assign", "scope": "context", "key": "cluesFound", "value": "+1" }
{ "type": "assign", "scope": "global",  "key": "votesForExit", "value": "+1" }
```

`value`: a string matching `+N` / `-N` increments the current numeric value;
anything else is assigned literally. Global writes are applied serially by the
server (spec §3.4), then: (a) every phone receives `setVar` with key
`global.<key>`, and (b) every machine receives a `global.changed` event.
Guarding a transition on `global.changed` with a global condition is the
idiomatic "wait until the vote passes" pattern. (Avoid assigning a global
*inside* a `global.changed` handler without a guard — that loops.)

## 5. Guards

```jsonc
{ "var": "global.votesForExit", "op": ">=", "value": 2 }
{ "all": [g1, g2] }   { "any": [g1, g2] }   { "not": g }
```

`var` reads `global.<key>` or `context.<key>`. `op`: `==  !=  >  >=  <  <=`
(default `==`).

## 6. Interactive pages (`showPage` params)

All string props interpolate display variables with `${key}` (e.g.
`"Votes: ${global.votesForExit}"`), live-updated on `setVar`.

| `page` | `props` |
|---|---|
| `waiting` | `title?`, `subtitle?` |
| `blank` | — |
| `text` | `title?`, `body?`, `dismissible?` (tap → `pageDismiss`), `buttons?: [{id,label}]` |
| `prompt` | `title?`, `question?`, `choices: [{id,label}]` → `choice:<id>` |
| `gestureSurface` | `hint?`, `swipes?` (default true), `drag?` (default true), `tap?` (default true) |
| `audioPlayer` | `title?`, `subtitle?` (visual shell; audio driven by `playAudio`) |
| `videoPlayer` | `hint?` (shell; video driven by `playVideo`) |

New page types are additive.

## 7. Versioning

The runtime rejects definitions whose `contractVersion` it doesn't support and
reports the mismatch to the operator. Additions within v1 are backwards
compatible; breaking changes bump to v2.
