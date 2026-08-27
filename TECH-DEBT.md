# Tech debt and open decisions

A standing record, so none of this depends on anyone remembering it. Update it
when an item is resolved rather than deleting the row silently — knowing a thing
was considered and settled is worth as much as the answer.

Status: Phase A complete (A1–A6, A8, plus shared rooms), plus the thin audio
layer, screens, phone input, screen sequences, room experiences, and installations.
265 tests.

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
| 1.6 | **Does the audience know they went off-path?** Legible, or purely felt? | Directorial; decides how explicit the audio around the transition is. | A single quiet chime at the moment of divergence — a placeholder chosen to be *audible once* rather than correct. It was a looping click until somebody wore the headphones. Adherence never returns to `onPath`, so anything looping here plays for the rest of that guest's night. |
| 1.7 | **Guidance intensity.** The original spec had `"insistent"`. Agreed it is narrative rather than structural — worth revisiting if the phone needs it as authored data. | Would live on the guidance region. | Not modelled. |
| 1.8 | **Should a sequence list its screens, or read the folder?** Renaming a screen means editing the show too, because the show names the file. A sequence could instead take `img/calibration_*` and order by filename — the deck becomes the folder, and dropping a file in is the whole edit. | Removes the mismatch that produced the blank screen, at the cost of the server scanning the filesystem to decide show structure. | The show lists each step explicitly. |
| 1.9 | **What does `ondelay` measure from?** Currently from the moment the screen appears. It could reasonably mean "N ms after the narration ends", which is what a screen carrying a long clip usually wants. | `calibration_07_ondelay5000` shows for 5s over an 18.55s clip, cutting it 13.6s short. | Measured from screen entry. `npm run audition` flags the mismatch. |
| 1.10 | **`DONE` as a room event.** Not in the contract, sent by nothing, used only by the operator button. Either give it a distinct meaning from `RELEASE` (content finished *with people still there*) or drop it. | Two events that look identical get used interchangeably. | Convention in the demo shows. |

---

## 2. Declared but not used

Config that validates cleanly and then does nothing. Each is a promise the show
JSON currently cannot keep.

| Field / value | Where it should land |
|---|---|
| Cue `offset`/`duration` | Live, but nothing uses it — the calibration clips are discrete files now. Kept because a long uncut take is a normal thing to be handed |
| `rooms.*.audio.timing` (`masterTimeline` \| `perGuest`) | Phase B. The thin layer behaves as `perGuest`-with-seek, which is `masterTimeline`'s join behaviour minus the timeline — indistinguishable until projection must stay aligned to it |
| `rooms.*.audio.joinPolicy` (`inProgress` \| `waitForNext` \| `restart`) | Phase B. Always `inProgress` today |
| `rooms.*.audio.minRemainingMs` | Phase B — read nowhere at all. A one-shot that already finished is dropped rather than replayed, but there is no late-arrival variant to route to |
| `rooms.*.outputs.cues` | Phase D — lighting and DMX. Room *experiences* (docs/ROOM-EXPERIENCE.md) are live and take a different route: a broker link to a piece running its own server, not an output intent |
| `guest.audioLayers` | Phase B. Three fixed audio slots (`room`, `guidance`, `adherence`) plus `screen` stand in; no ducking, crossfade, or priority |
| `inputBindings` | **Live for phone gestures** (`tap`, `swipe`, `shake` → guest-machine events). In-room device inputs are still Phase D |
| `ineligible.policy`: `ambientOnly`, `lockedMessage`, `tease` | Still selected and reported without choosing a response — but `audience: "ineligible"` now exists, so a show can author the audio by hand. Wiring the policy to pick it is the remaining step |
| `paths.*.guidance`: `guestDirectedPath`, `freeExplore` | Only `goldenPath` drives a target today |
| `paths` assignment strategy `balanced` | `nextPath` handles `roundRobin` and `random`. `manual` now exists as an operator action (the guest inspector's Path picker) rather than as a strategy the show can name — which is where it belongs, since it is a person overriding the show rather than the show deciding |
| Eligibility strategies `roleBased`, `progressGated`, `inverted`, `custom` | Declared by the contract; naming one is a **load error**, so this fails loudly rather than silently |

**`balanced` path assignment** is a dead end rather than pending work — worth
deciding whether to remove it. It was for spreading occupancy, and assignment now
happens on reaching the museum rather than at the door, which was most of its
purpose.

*Resolved by screens and input:* `inputBindings` was a declared block nothing
read. A gesture now becomes a show event through it, which is what let the
calibration sequence be self-paced without the client or the runtime learning
anything about the narrative.

*Resolved by the thin audio layer:* `multiGuest.policy: spectator` and
`atCapacity: personalVariant` were labels in the operator panel with no
consequence. Cue audiences now make them audible, which is the whole point of
having derived standing in the first place.

---

## 3. Not built

| Item | Notes |
|---|---|
| **Phone experience beyond audio and screens** | Audio, full-screen images and touch input are live (CONTRACT.md §8.1), and the status line tracks room + standing. Pages, video, haptics and `setVar` are still v0.2 surfaces nothing drives. |
| **The phone client has no tests** | `public/client.js` is a plain browser script with no way to load it headless, so gesture recognition, cue execution and asset loading are verified by hand on a handset. Two faults have hidden here. Making the recogniser importable (or adding a headless browser) is the cheapest first step. |
| **`server/index.js` has no tests** | The WS command surface, session handling, and phone push are verified by hand against a live server. Two bugs have now hidden there (the relay rename, the unsent `state` message) and both needed a real socket to surface. A harness that boots the server on an ephemeral port and drives it over `ws` would have caught both. |
| **The server is http only** | Which costs more than it looks. `navigator.wakeLock`, and every other API gated on a secure context, is simply undefined on the `http://192.168.x.x` a phone uses on venue wifi — so the screen-sleep fix falls back to a muted looping video. Self-signed https means trusting a profile on every handset; a real cert means a domain resolving on a network with no internet. Worth deciding before load-in rather than at it. |
| **Phone-reported zones beyond the picker** | The handset's room picker (CONTRACT.md §8.1) covers browser test mode, which is Phase B's exit criterion. It is a `<select>` in the debug status bar, not a guest-facing surface, and it trusts whatever the phone says. Fine for rehearsal, wrong for a show. |
| **Experience input is untested on a handset** | The phone's `stream` mode — continuous drag, release velocity, hold, the second socket — is verified against a fake room server and by hand. `hold` shipped missing entirely and no test could have caught it, because nothing tests what the recogniser emits. `public/client.js` still has no headless test, so this is the third capability landing there unproven by machine. |
| **The room experience protocol has one implementation** | `docs/experience-template` conforms and 02_influence does not yet. Anything the contract got wrong will surface on the second piece, not the first. |
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
| **Every state change reconciles every guest's audio.** Cheap now (a few map lookups per guest, and it sends nothing when nothing differs) and correct by construction, but it is O(guests) on every tick of every room. | If it ever bites, the fix is to reconcile only guests whose room or regions moved — not to go back to firing events. |
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

A fourth is worth adding now that audio exists: **describing a moment instead of
a condition.** An event-driven cue director would have been the same mistake as
`lastEntry` in a new costume — a guest who arrives after the event that would
have told them what to play hears nothing, forever. Reconciliation is the same
answer as derived `standing`, applied to sound.

**A rename that stopped at the edge of the rebuild.** `participant` → `guest`
renamed the runtime and every caller inside `server/spatial/`, and missed
`relay.js` — a carried v0.2 module reached only when a phone connects, which no
test did. It crashed on the first real handset. The test glob compounded it by
covering `server/spatial/__tests__` alone, so the carried modules had no tests
that could have failed. Both are fixed; the lesson is that the v0.2 surfaces
still in the tree (`relay.js`, `client.js`, `pages.js`) are the least-tested
code here and the most likely to hold a stale assumption.

**A simulation tool acting on a real participant.** The walkthrough driver was
built when every guest was a dot on a floor plan, and `start()` with no arguments
adopts every guest in the show — including someone holding an actual handset. It
walked a real guest out of a room mid-question, because a room's dwell time was
the only thing it knew about how long to stay. The runtime could not tell the two
apart: `connected` is about location contact and is true for a spawned dot.

Fixed twice, and the second fix is the interesting one. The first attempt tracked
whether a socket was attached — which is *liveness*, and would have tapped
through somebody's orientation while their handset was backgrounded. A guest now
carries `kind` (`phone` | `simulated`), fixed when they are created and never
changed; a handset session spawns its own guest rather than adopting a dot off
the plan. The driver answers for simulated guests and never for people.

Fixed a third time, and the third one is about *who asked*. Refusing to walk a
phone guest at all also broke the operator's own Walk button — the fix had
flattened "adopt everybody on a timer" and "somebody selected this handset and
pressed a button" into one rule. They are not the same act. The default sweep
skips phone guests; naming one is honoured; and the driver still never answers
their screens, whoever asked for them to be walked.

Settled on the fourth pass, by building the missing thing rather than tuning the
rule again. The reason a phone guest kept getting walked is that Walk was the
only way to move one, and it is the wrong instrument: it starts a process where
what was wanted was an act. `sendGuestToRoom` is that act — the operator's Send
to control and the handset's own room picker — and with it in place the driver
can go back to never touching a person at all.

The lessons: **a tool for standing in for people, pointed at a person**; when a
check keeps needing exceptions, the question is probably about identity rather
than state; and **when a rule keeps needing to be relaxed, the missing thing is
usually a tool, not a looser rule.**

**Reconciliation is only as good as its picture of the other end.** A phone that
slept came back to silence: the AudioContext was suspended and every buffer
source dead, while the server — comparing the world against what that phone was
*last told* — saw no difference and sent nothing. The phone was correct as far as
anyone knew, and quiet. The `ready` resync existed for exactly this and was only
ever sent once, on first join. The rule: **whenever a client may have lost what
it was told, it has to say so** — a reconnect, a wake, a resumed context.

**A name in two places, only one of which anybody edits.** A screen was renamed
on disk to change its advance rule; the show still named the old file, so the cue
pointed at a 404 and the guest got a blank screen with the narration playing over
it. Nothing checked that a cued asset existed — the gap was even named in a
commit message and not built. Missing assets are now listed at load and held on
the operator panel rather than scrolling past in the log. The open question is
whether a sequence should read its deck from the folder instead of listing it,
which would remove the second place entirely (§1.9).

**Two clients, one identity, no tiebreak.** A guest's token lives in the phone's
storage, so a second tab on the same handset is a second socket claiming the same
person. The server closed the older one — correctly — and said nothing, so that
client reconnected, displaced the newer one in turn, and the two flapped against
each other for as long as both pages were open. Deciding a winner is not enough
when the loser has a reconnect loop: it has to be *told*. The general shape:
**any rule that evicts a client needs the client to know it was evicted.**

**A listener attached below the thing it needs to hear.** Touch handlers sat on
`#stage`; a screen cue covers the viewport with a fixed overlay that is the
stage's *sibling*, so taps bubbled to `<body>` and never crossed the listener.
The handler was deaf at exactly the moment a tap mattered, and worked fine in
every other moment. Now on `document`, above anything that can fill the screen.
The class: **an event listener scoped to a box, in a UI built out of overlays.**

**A stale server holding the port.** Twice now a fix has looked broken because
an older `node server/index.js` was still bound to 4000 and serving the previous
build. Both times the code was already correct. Check `lsof -ti:<port>` before
believing a live test — and prefer a spare port over killing whatever is there,
since it may be somebody's running rehearsal.

**Sending an event into a machine from inside its own subscriber.** XState
queues it, so a rollback check reads the state as unchanged and undoes work that
is about to succeed. `offerToOccupants` defers for exactly this reason, and
`requestActivation` carries a comment saying it must not be called re-entrantly.
