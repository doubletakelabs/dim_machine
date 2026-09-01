# Tech debt and open decisions

A standing record, so none of this depends on anyone remembering it. Update it
when an item is resolved rather than deleting the row silently — knowing a thing
was considered and settled is worth as much as the answer.

Status: Phase A complete (A1–A6, A8, plus shared rooms), plus the thin audio
layer, screens, phone input, screen sequences, room experiences, and installations.
313 tests, now including the WebSocket and HTTP surface and the gesture recogniser. The v0.2 custom-pages
framework has been removed.

---

## 1. Waiting on a decision

Nothing here is blocked technically; each needs an answer that isn't ours to give.

| # | Question | Why it matters | Currently |
|---|---|---|---|
| 1.1 | **What ends free-roam?** A guest released into Admin Office / Data Center / Warehouse / Control Room needs something to move them toward the Library. | Pending the narrative team. | The journey advances on *entering the Library*. The trigger before it is an operator action. |
| 1.2 | **Kinds for the post-museum rooms.** Control Room and Library look like they want `shared` — everyone converges and presumably gets the same ending. The free-roam three are less obvious. | A `destination` gives them a holder, and the holder's history picks any revisit variant for everyone. | All five are `destination`. One-line change per room. |
| 1.3 | **Real museum path composition.** Four paths across ten rooms, and whether Consumption I/II/III are one-per-path variants of the same beat. | The four in `shows/MAD-DIM.json` are invented. | `pathA`–`pathD`, plausible but fictional. |
| 1.4 | **Room content.** Every room machine in the demo shows is constructed, not authored. | The contract is stable enough to author against now. | Placeholder machines. |
| 1.5 | **Accessibility.** The show is audio-guided, so a guest who cannot hear the tour has no wayfinding at all. | Parked by request, reaffirmed 2026-08-27 at the Phase B doorstep with the cost understood: retrofitting `alternatives` text across an authored cue library is a transcription project rather than a schema edit. The open design questions when this is taken up: who sees the alternatives (a per-guest flag, not every phone), how far it goes (guidance lines vs full narration captions), and whether haptic patterns beat text for wayfinding in the dark. | Nothing. The accepted cost of deciding later. |
| 1.6 | **Does the audience know they went off-path?** Legible, or purely felt? | Directorial; decides how explicit the audio around the transition is. | A single quiet chime at the moment of divergence — a placeholder chosen to be *audible once* rather than correct. It was a looping click until somebody wore the headphones. Adherence never returns to `onPath`, so anything looping here plays for the rest of that guest's night. |
| 1.7 | **Guidance intensity.** The original spec had `"insistent"`. Agreed it is narrative rather than structural — worth revisiting if the phone needs it as authored data. | Would live on the guidance region. | Not modelled. |
| 1.8 | **Should a sequence list its screens, or read the folder?** Renaming a screen means editing the show too, because the show names the file. A sequence could instead take `img/calibration_*` and order by filename — the deck becomes the folder, and dropping a file in is the whole edit. | Removes the mismatch that produced the blank screen, at the cost of the server scanning the filesystem to decide show structure. | The show lists each step explicitly. |
| 1.9 | **What does `ondelay` measure from?** Currently from the moment the screen appears. It could reasonably mean "N ms after the narration ends", which is what a screen carrying a long clip usually wants. | `calibration_07_ondelay5000` shows for 5s over an 18.55s clip, cutting it 13.6s short. | Measured from screen entry. `npm run audition` flags the mismatch. |
| ~~1.10~~ | ~~Two plan labels matched by elimination.~~ | **Resolved.** Confirmed: BOARD ROOM → maskRoom and BACK OFFICE → adminOffice are both correct. | The zones stand. |
| ~~1.11~~ | ~~`DONE` as a room event.~~ | **Resolved by removal.** It looked identical to `RELEASE` and was sent by nothing. Removed from the operator panel and every demo machine; if "content finished with people still there" matters later, it gets designed on purpose. | Gone. |

---

## 2. Declared but not used

Config that validates cleanly and then does nothing. Each is a promise the show
JSON currently cannot keep.

| Field / value | Where it should land |
|---|---|
| Cue `offset`/`duration` | Live, but nothing uses it — the calibration clips are discrete files now. Kept because a long uncut take is a normal thing to be handed |
| `rooms.*.audio.timing` (`masterTimeline` \| `perGuest`) | Phase B. The thin layer behaves as `perGuest`-with-seek, which is `masterTimeline`'s join behaviour minus the timeline — indistinguishable until projection must stay aligned to it |
| ~~`rooms.*.audio.joinPolicy`~~ | **Dropped** (team meeting 2026-08-27): every guest either gets individualized audio or joins a synchronized room — `inProgress` is the only join there is. Remove the field from the contract when the exhibit-machine experiment settles the room shape |
| ~~`rooms.*.audio.minRemainingMs`~~ | **Dropped** with `joinPolicy`, same meeting — no late-arrival variant is wanted |
| `rooms.*.outputs.cues` | Phase D — lighting and DMX. Room *experiences* (docs/ROOM-EXPERIENCE.md) are live and take a different route: a broker link to a piece running its own server, not an output intent |
| `guest.audioLayers` | Phase B. Three fixed audio slots (`room`, `guidance`, `adherence`) plus `screen` stand in; no ducking, crossfade, or priority |
| `server/relay.js` | Live and correct, with no consumer. Its only one was the custom-pages framework, now removed; a room experience talks to its own server directly. Kept because phone-to-phone within a room is plausible for a future room, and the rate limiting and room scoping are the parts that would have to be got right again. Delete it if nothing wants it by the time Phase B closes |
| `inputBindings` | **Live for phone gestures** (`tap`, `swipe`, `shake` → guest-machine events). In-room device inputs are still Phase D |
| `ineligible.policy`: `ambientOnly`, `lockedMessage`, `tease` | Still selected and reported without choosing a response — but `audience: "ineligible"` now exists, so a show can author the audio by hand. Wiring the policy to pick it is the remaining step |
| `paths.*.guidance`: `guestDirectedPath`, `freeExplore` | Only `goldenPath` drives a target today |
| ~~`paths` assignment strategy `balanced`~~ | **Resolved by removal.** `balanced` was for spreading occupancy at the door, and assignment moved to museum arrival; `manual` correctly lives as an operator action (the inspector's Path picker), a person overriding the show. Naming either in a show is now a load error rather than a promise the show cannot keep |
| Eligibility strategies `roleBased`, `progressGated`, `inverted`, `custom` | Declared by the contract; naming one is a **load error**, so this fails loudly rather than silently |
| `cueReport` (phone → server) | The phone reports each scheduled cue's actual-vs-target time; the server ignores the message. Powers the handset's own drift readout today, and is the raw feed a cross-phone latency monitor would want. Wire it up or drop the send when that monitor is designed |

*Resolved by screens and input:* `inputBindings` was a declared block nothing
read. A gesture now becomes a show event through it, which is what let the
calibration sequence be self-paced without the client or the runtime learning
anything about the narrative.

*Resolved by the thin audio layer:* `multiGuest.policy: spectator` and
`atCapacity: personalVariant` were labels in the operator panel with no
consequence. Cue audiences now make them audible, which is the whole point of
having derived standing in the first place.

---

## 2.5 Experiment in flight — the museum machine

**Third iteration** (creative meeting 2026-08-31, confirmed 2026-09-01). The
queue is gone: each guest gets to **enter four rooms**, and every offer is
drawn **at random** from the rooms available — not full, not completed, not
locked — at that moment. No pre-assigned set exists; who you are offered
depends on where the crowd is when the hallway calls. A slot burns when an
Entrance begins, so abandonment costs the slot *and* locks the room
("4 entered" was the team's ruling); entering a full room burns nothing,
because no entrance ever began — a flagged assumption. Once the slots are
spent the hallway stops calling and every unvisited door answers "Approach,
No State". The two-strike lockouts, the cycle deferral, Continue at the
offered threshold, full-room silence-without-prejudice, and the offer latch
all survive from iteration 2. The machine takes its randomness as an event
field (`roll`), so the tests hold the dice.

Superseded second iteration, kept for the record (team feedback interrogated
2026-08-28). Still deliberately
**not** in the runtime; lives at `public/sim/museum-machine.js`, rules encoded
verbatim in `public/__tests__/museum-machine.test.js`, demo at `/sim/`.

The shape now: each guest carries a **queue** of DIM rooms, seeded
north→south. The hallway offers the closest queued room that is not full and
not rejected this cycle ("Exhibit Approach"); a rejected room rotates to the
back and is only offerable again when everything else is done or full — the
turn of the cycle announces itself as "Return Later". The offered room's
threshold plays "Continue"; inside, Entrance → Instruction → Interaction →
Complete hold. Two refusals lock a room forever. Entering a **full** room
(maxOccupants) is silence — no stem, no strike, the queue holds their place —
and the consumed offer cannot convict them on the way out. A room never on
the queue answers its threshold with "Approach, No State", then "Return, No
State".

Judgements the harness owns, tuned for BLE scepticism: the offer **latches**
(evaluated only in the hallway with no offer standing, after a cool-off, and
never over a playing stem), and "walked past" needs the guest measurably
nearer another queued door than the offered one, sustained 1.5s — a wobble
cannot convict, and lingering is not refusing. The team suspects venue BLE
may not support this reliably; that is precisely what the onsite week tests.

Standing notes: this replaces `paths` in the DIM area (the queue is the
path — collapses §1.3 into queue-assignment policy); threshold zones join the
contract with it (not rooms — no state, no occupancy, may overlap hallways);
settling is decided out (idle ↔ active, instant, landing together with this);
Instruction → Interaction → Complete still advance manually — what advances
them for real is an open team question.

## 3. Not built

| Item | Notes |
|---|---|
| **Phone experience beyond audio and screens** | Audio, full-screen images and touch input are live (CONTRACT.md §8.1), and the status line tracks room + standing. Video and haptics are still v0.2 surfaces nothing drives. The v0.2 page framework is gone — each screen is now built for itself as it is designed. |
| **The phone client is partly tested** | The **gesture recogniser** is now `public/gestures.js` — a pure module with the clock and timers injected, and 26 tests. `hold` shipped missing entirely; removing it again now fails six of them. What is still untested is everything that genuinely needs a browser: cue execution, asset preloading, the AudioContext, the two sockets. `index.html` now loads `client.js` as `type="module"`, which is the one change here that has not been run on a handset. |
| ~~**`server/index.js` has no tests**~~ | **Resolved.** `server/__tests__/server.test.js` forks the real server on an ephemeral port and drives it over `ws`: sessions, the displacement rule, phone state push, operator authority, disconnect and return, malformed input, and the HTTP routes. Each of the three faults that hid here was reintroduced and confirmed to fail a test. What it still does not cover is anything requiring a browser — see the `public/client.js` row, which is now the only untested surface left. |
| **The server is http only** | Which costs more than it looks. `navigator.wakeLock`, and every other API gated on a secure context, is simply undefined on the `http://192.168.x.x` a phone uses on venue wifi — so the screen-sleep fix falls back to a muted looping video. Self-signed https means trusting a profile on every handset; a real cert means a domain resolving on a network with no internet. Worth deciding before load-in rather than at it. |
| **Phone-reported zones beyond the picker** | The handset's room picker (CONTRACT.md §8.1) covers browser test mode, which is Phase B's exit criterion. It is a `<select>` in the debug status bar, not a guest-facing surface, and it trusts whatever the phone says. Fine for rehearsal, wrong for a show. |
| **Experience input is untested on a handset** | Partly resolved: what the recogniser *emits* — the stream events, hold begin and end, a drag cancelling a hold, a hold that must not also be a tap — is now covered. What is not is the second socket itself: reconnection, the driver secret, and release velocity are still verified against a fake room server and by hand. |
| **The room experience protocol has one implementation** | `docs/experience-template` conforms and 02_influence does not yet. Anything the contract got wrong will surface on the second piece, not the first. |
| ~~**Zone drawing**~~ | **Resolved.** `public/zones.html` traces zones over the vector plan: drag vertices, double-click an edge to add one, right-click or ⌫ to remove, arrows to nudge, ⌘Z to undo, add and delete zones, and save through the same validated `POST /api/shows` route everything else uses. It judges overlaps in the browser with the show's own `zone-math.js` (served at `/lib/zone-math.js`, one source of truth) and flags them red as you drag; the validator repeats the check at save and load. What remains is the *work*, not the tool: the precise tracing pass against the venue, and the two label-mapping assumptions in §1.10. Zone coordinates live in the floorplan box (784×1510, origin top-left); polygons take any number of points ≥3, concave included; a room may own several zones. |
| **Scripted walkthrough replay** | Spec §5.4. Record the `setVirtualPosition` stream, replay against a `ManualClock`. Both the clock and the event log were built for it. This is the regression story for the behavioural matrix. **Deliberately deferred until after Phase B** (decided 2026-08-27): the recording is most valuable made against the finished audio layer, and the unit suite carries the risk until then. |
| **Lock-specific disconnect grace** | Spec §11 wants a lock held briefly when a holder's socket drops. `contactLossMs` covers the coordinator's side; the lock has no separate window. |
| **Statechart views** | Spec §10.2. React Flow, shared with the authoring tool. The guest machine is now worth looking at. |

---

## 4. Known warts

| Wart | Why it is still there |
|---|---|
| **Raw operator `ACTIVATE` leaves a room running for nobody.** It bypasses `requestActivation`, so the room goes `active` with no lock and refuses every guest until `RELEASE` or `RESET`. | Deliberate: seeing a state without staging guests is worth having. Now visually separated and labelled, and joined by *Activate for occupant*, which goes through the arrival path. |
| **The authored guest chart does not show the recovery transitions.** The runtime adds a transition for every room at the region root so the machine always matches the coordinator. | Chosen so the drawn chart shows *intent*. It is one uniform rule, documented in spec §4.1, rather than per-room surprises. |
| **Every state change reconciles every guest's audio.** Cheap now (a few map lookups per guest, and it sends nothing when nothing differs) and correct by construction, but it is O(guests) on every tick of every room. | If it ever bites, the fix is to reconcile only guests whose room or regions moved — not to go back to firing events. |
| **The integration suite can flake under machine load.** Twice, one run has reported a single failure that three immediate reruns could not reproduce — both times while other processes were competing for the machine. The server tests fork real processes and wait on real sockets, so a busy box can push a boot past its timeout. | Tolerated, recorded here so a lone red run gets a rerun before it gets an investigation. If it ever reproduces on a quiet machine, chase it. |
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
covering `server/spatial/__tests__` alone.

Worth recording how the lesson was acted on, because the ratio is the argument.
`server/spatial/` had 265 tests and has produced roughly one bug.
`server/index.js` and `public/client.js` had none between them and produced
six — the relay rename, the unsent `state`, the two-tab flap, the missing
`hold`, the looping click, and the listener below the overlay. The pattern was
not that the edges are harder; it is that nothing there could fail except in
front of a person.

The claim this note used to end on — that the v0.2 surfaces are the least-
tested code and the most likely to hold a stale assumption — has been worked
off, and it was right to the last. `relay.js` runs against a real runtime in
its own tests; `server/index.js` is driven over a real socket; the test glob
covers all three trees. The client's pure decisions were pulled out where tests
reach them: the gesture recogniser (`gestures.js`), the clock estimator every
cue's timing rests on (`clock-sync.js`), and the play/seek/skip choice
(`cue-plan.js`). And the final audit of what remained found three more stale
assumptions exactly where predicted, none of which any rehearsal had surfaced:
the relay cache keyed peers by `from.userId` — a field the server stopped
sending at the rename, so every peer collapsed onto one `undefined` key;
`welcome` was read for `msg.userId` and fell back to a token fragment; and the
snapshot-restore path replayed `snap.cues`, a field the server has never sent —
dead code impersonating a second restoration path beside the real one (`ready`
→ resync). The server was also still sending `displayVars` to phones that
stopped reading it when the page framework was removed.

What is left in `client.js` genuinely needs a browser: the WebAudio and DOM
wiring the tested decisions are carried out with. The lesson to carry into
Phase B stands — write the decisions somewhere a test can reach *before*
wiring them to an AudioContext. The seams now exist to write them into.

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
