# Tech debt and open decisions

A standing record, so none of this depends on anyone remembering it. Update it
when an item is resolved rather than deleting the row silently — knowing a thing
was considered and settled is worth as much as the answer.

Status as of Phase A completion (A1–A6, A8, plus shared rooms). 198 tests.

---

## 1. Waiting on a decision

Nothing here is blocked technically; each needs an answer that isn't ours to give.

| # | Question | Why it matters | Currently |
|---|---|---|---|
| 1.1 | **What ends free-roam?** A guest released into Admin Office / Data Center / Warehouse / Control Room needs something to move them toward the Library. | Pending the narrative team. | The journey advances on *entering the Library*. The trigger before it is an operator action. |
| 1.2 | **Kinds for the post-museum rooms.** Control Room and Library look like they want `shared` — everyone converges and presumably gets the same ending. The free-roam three are less obvious. | A `destination` gives them a holder, and the holder's history picks any revisit variant for everyone. | All five are `destination`. One-line change per room. |
| 1.3 | **Real museum path composition.** Four paths across ten rooms, and whether Consumption I/II/III are one-per-path variants of the same beat. | The four in `the-museum.json` are invented. | `pathA`–`pathD`, plausible but fictional. |
| 1.4 | **Room content.** Every room machine in the demo shows is constructed, not authored. | The contract is stable enough to author against now. | Placeholder machines. |
| 1.5 | **Accessibility.** The show is audio-guided, so a guest who cannot hear the tour has no wayfinding at all. | Parked by request. The cheap insurance is an optional `alternatives` field (`{ text, haptic }`) on every cue *before* the cue library exists. | Nothing. Cost rises once Phase B writes cues. |
| 1.6 | **Does the audience know they went off-path?** Legible, or purely felt? | Directorial; decides how explicit the audio around the transition is. | Recorded silently. |
| 1.7 | **Guidance intensity.** The original spec had `"insistent"`. Agreed it is narrative rather than structural — worth revisiting if the phone needs it as authored data. | Would live on the guidance region. | Not modelled. |
| 1.8 | **`DONE` as a room event.** Not in the contract, sent by nothing, used only by the operator button. Either give it a distinct meaning from `RELEASE` (content finished *with people still there*) or drop it. | Two events that look identical get used interchangeably. | Convention in the demo shows. |

---

## 2. Declared but not used

Config that validates cleanly and then does nothing. Each is a promise the show
JSON currently cannot keep.

| Field / value | Where it should land |
|---|---|
| `rooms.*.audio.timing` (`masterTimeline` \| `perGuest`) | Phase B |
| `rooms.*.audio.joinPolicy` (`inProgress` \| `waitForNext` \| `restart`) | Phase B |
| `rooms.*.audio.minRemainingMs` | Phase B — read nowhere at all |
| `rooms.*.outputs.cues` | Phase D (TouchDesigner / DMX) |
| `guest.audioLayers` | Phase B |
| `inputBindings` | Phase B (phone inputs) / Phase D (in-room devices) |
| `ineligible.policy`: `ambientOnly`, `lockedMessage`, `tease` | Selected and reported; the *response* is Phase B audio |
| `paths.*.guidance`: `guestDirectedPath`, `freeExplore` | Only `goldenPath` drives a target today |
| `paths` assignment strategies `manual`, `balanced` | `nextPath` handles `roundRobin` and `random` only |
| Eligibility strategies `roleBased`, `progressGated`, `inverted`, `custom` | Declared by the contract; naming one is a **load error**, so this fails loudly rather than silently |

Two of these are dead ends rather than pending work — worth deciding whether to
remove them instead of implementing:

- **`multiGuest.atCapacity: personalVariant`** exists but is indistinguishable
  from the `personalVariant` policy until phone audio exists.
- **`balanced` path assignment** was for spreading occupancy. Assignment now
  happens on reaching the museum rather than at the door, which was most of what
  `balanced` was for.

---

## 3. Not built

| Item | Notes |
|---|---|
| **Phone experience** | The pipe is built and empty. `public/client.js` is the v0.2 cue player — clock sync, `startAt` scheduling, join-in-progress seek, pages, audio — and it still works. But **nothing in the server ever sends a phone a cue**: room state goes to the operator output log, guest events go to the event log, and neither reaches a device. A phone can connect, sync, and receive its own spatial state; it will never be told to play anything. This is the thin audio slice. |
| **Zone drawing** | 23 spaces of hand-authored polygons, all currently invented. `floorplan.image` exists so zones can be traced over a real plan; the tool does not. Has a deadline attached to it that the other items do not — venue access. |
| **Scripted walkthrough replay** | Spec §5.4. Record the `setVirtualPosition` stream, replay against a `ManualClock`. Both the clock and the event log were built for it. This is the regression story for the behavioural matrix. |
| **Lock-specific disconnect grace** | Spec §11 wants a lock held briefly when a holder's socket drops. `contactLossMs` covers the coordinator's side; the lock has no separate window. |
| **Statechart views** | Spec §10.2. React Flow, shared with the authoring tool. The guest machine is now worth looking at. |

---

## 4. Known warts

| Wart | Why it is still there |
|---|---|
| **Raw operator `ACTIVATE` leaves a room running for nobody.** It bypasses `requestActivation`, so the room goes `active` with no lock and refuses every guest until `RELEASE` or `RESET`. | Deliberate: seeing a state without staging guests is worth having. Now visually separated and labelled, and joined by *Activate for occupant*, which goes through the arrival path. |
| **The authored guest chart does not show the recovery transitions.** The runtime adds a transition for every room at the region root so the machine always matches the coordinator. | Chosen so the drawn chart shows *intent*. It is one uniform rule, documented in spec §4.1, rather than per-room surprises. |
| **`pauseWhenEmpty` was removed rather than implemented.** XState cannot pause a delayed transition. | The honest alternative is a room-authoring pattern: a room whose content must hold for an absent guest drives its beats from runtime events rather than `after`. Recorded in spec §3.5. |

---

## 5. Recurring failure modes

Three bugs in this codebase have had the same shape, so it is worth naming.

**Allowlists of state names that miss what a show declared.** `rootState`
returned a dotted string verbatim, so nested `active.main` never matched.
`REQUIRES_LOCK` listed running states, so a room's intro state was missed.
`ACTIVATABLE` and `NOT_RUNNING` were one idea written twice. Fixed by expressing
the *resting* states — the closed set — and deriving the rest.

**Stored state that goes stale when the world moves.** `lastEntry` recorded the
outcome of an entry and then described a moment that had passed. Fixed by
deriving. The rule that came out of it: **what happened is an event and belongs
in the event log; what is, is computed.**

**Sending an event into a machine from inside its own subscriber.** XState
queues it, so a rollback check reads the state as unchanged and undoes work that
is about to succeed. `offerToOccupants` defers for exactly this reason, and
`requestActivation` carries a comment saying it must not be called re-entrantly.
