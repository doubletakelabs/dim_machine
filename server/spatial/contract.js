/** Contract v3 — spatial model (spec v0.3). */

export const CONTRACT_VERSION = 3;

/**
 * You are in a room or you are not. Reported per room, not per zone — a room
 * may own several zones, and moving between them is not an exit.
 */
export const OCCUPANCY_STATES = ['outside', 'inside'];

export const ROOM_PRESENTATION_STATES = ['idle', 'active', 'settling'];

/**
 * What kind of space a room is — really, who the room runs *for*.
 *
 * A `destination` runs for a person: one guest activates it, it plays the
 * variant their history calls for, they hold it, and company gets the room's
 * `multiGuest` policy.
 *
 * A `shared` room runs for the space: it plays when the first eligible guest
 * arrives and everyone inside gets the same thing. Nobody holds it, because
 * there is nothing to arbitrate — which also means it can have no revisit
 * variant, since there is no one guest whose history could choose it. A veteran
 * arriving a second before a newcomer must not decide what the newcomer sees.
 *
 * A `hallway` is somewhere you pass through to reach somewhere else. It is
 * always eligible — you cannot deviate by using the only route between rooms —
 * never counts toward `seen`, and is exempt from the activation contract it
 * could never satisfy. Guests still occupy it, and it is where guidance speaks.
 */
export const ROOM_KINDS = ['destination', 'shared', 'hallway'];

/**
 * Presentation roots every room machine must declare.
 *
 * Rooms have no memory of having run before, deliberately. What matters when
 * someone walks in is whether *they* have seen the room, not whether anyone
 * has — a room that reset after A's visit should still play in full for B, who
 * has never been inside. Revisit variants are therefore driven by the
 * activating guest's history, carried on the ACTIVATE event.
 */
export const REQUIRED_ROOM_STATES = ['idle', 'active', 'settling'];

/**
 * Events the runtime sends into a room machine, and the states that must handle
 * them. This is the contract room actors rely on (room-actor.js); authoring a
 * machine that omits any of it produces a room that silently never moves, so it
 * is a load-time error rather than a runtime surprise.
 */
export const REQUIRED_ROOM_TRANSITIONS = [
  { state: 'idle', event: 'ACTIVATE', why: 'activation' },
  { state: 'settling', event: 'RESET', why: 'exit grace completion (§3.5)' },
  { state: 'active', event: 'RELEASE', why: 'lock release with no occupants (§3.4)' },
];

/**
 * Facts about the activating guest, carried on ACTIVATE so a room can
 * present a revisit variant. Deliberately not identity or path — rooms stay
 * portable across shows because they never learn who is allowed in.
 */
export const ACTIVATION_CONTEXT_FIELDS = ['seen', 'completed', 'activatedByMe'];

/**
 * Room-machine events the runtime sends for a revisit variant. The runtime
 * resolves which one applies from the room's `revisit` block and the activating
 * guest's history, so branching lives in the orchestrator and the statechart
 * holds only plain transitions (no guard language in show JSON).
 */
export const REVISIT_EVENTS = {
  whenSeen: 'ACTIVATE_SEEN',
  whenCompleted: 'ACTIVATE_COMPLETED',
};

/**
 * Sent instead of ACTIVATE when a guest enters a room they were not sent to and
 * the room declares `ineligible.policy: "activateVariant"`.
 *
 * Eligibility therefore selects *which* activation a room gets rather than
 * gating activation outright. A room that would rather stay dark for such a
 * guest keeps `ignore`, which most do.
 */
export const OFF_PATH_ACTIVATION_EVENT = 'ACTIVATE_OFFPATH';

/** Room entry, as the guest machine hears it. Dotted, so `entered.*` works. */
export const enteredEvent = (roomId) => `entered.${roomId}`;

/**
 * How many guests a room is currently running for, as the room machine hears it.
 *
 * Dotted for the same reason as `entered.*`: a room declares transitions for the
 * counts it cares about — `occupants.2` to open a collaborative sub-state,
 * `occupants.1` to close it again — without needing a guard to compare numbers.
 */
export const occupantsEvent = (count) => `occupants.${count}`;

/**
 * Parallel regions of the guest machine.
 *
 * `location` mirrors the coordinator and is generated from room adjacency —
 * it is the map. `guidance` is the authored journey, and the small readable
 * chart an author reasons about. `adherence` is whether they are still
 * following what guidance asked.
 */
export const GUEST_REGIONS = ['location', 'guidance', 'adherence'];
export const AUTHORED_GUEST_REGIONS = ['guidance', 'adherence'];

export const ADHERENCE_STATES = ['golden', 'drifting', 'cursed'];

export const AUDIO_TIMINGS = ['masterTimeline', 'perGuest'];

export const AUDIO_JOIN_POLICIES = ['inProgress', 'waitForNext', 'restart'];

export const AUDIO_ON_EXIT = ['fadeOut', 'continue', 'cut'];

/**
 * What the tour audio does for a guest.
 *
 * `goldenPath` is authored intent — an ordered route the audio leads them
 * along. `guestDirectedPath` is where a guest who ignores that lands: the audio
 * follows them instead of leading. It is both authorable from the start and a
 * runtime destination, because straying off a golden path is a designed
 * outcome, not an error.
 */
export const GUIDANCE_POLICIES = ['goldenPath', 'guestDirectedPath', 'freeExplore'];

/**
 * What a guest gets on entering a room that is not theirs. This now
 * carries the weight the passing-by glitch used to: it is the only place the
 * show distinguishes "this room is yours" from "this room is not".
 */
export const INELIGIBLE_POLICIES = [
  'ignore',
  'ambientOnly',
  'lockedMessage',
  'tease',
  'activateVariant',
];

export const MULTI_GUEST_POLICIES = [
  'collaborative',
  'spectator',
  'personalVariant',
  'refuse',
];

/** `queue` was dropped: holding a guest in a hallway needs audio the show does not want. */
export const AT_CAPACITY_POLICIES = [
  'spectator',
  'refuse',
  'personalVariant',
];

export const EXIT_POLICIES = ['resetAfter', 'finish', 'hold', 'resetImmediate'];

/**
 * What a room does when it becomes available with eligible guests still inside.
 *
 * Happens whenever a room's content ends under its own steam while someone is
 * standing in it — they were refused on the way in, or arrived mid-run, and now
 * the room has reset at their feet. Per room, because "play again for whoever is
 * here" is right for an ambient space and wrong for a narrative one.
 */
export const WHEN_AVAILABLE_POLICIES = ['wait', 'activate'];

export const PATH_ASSIGNMENT_STRATEGIES = [
  'roundRobin',
  'random',
  'manual',
  'balanced',
];

export const ELIGIBILITY_STRATEGIES = [
  'goldenPath',
  'all',
  'roleBased',
  'progressGated',
  'custom',
  'inverted',
  'none',
];

/**
 * Audio slots a guest hears at once. One cue per slot, replaced when the slot's
 * source state changes.
 *
 * `room` is what the space is doing; `guidance` is the tour talking to them;
 * `adherence` is the show reacting to how they are following it. Three fixed
 * slots is not a mixer — `guest.audioLayers` is still Phase B — but it is enough
 * that guidance can speak over an ambient room without either cutting the other.
 */
export const CUE_SLOTS = ['room', 'guidance', 'adherence', 'screen'];

/**
 * Slots that carry sound. `screen` is the exception — it holds an image, and the
 * director emits `image`/`clearImage` for it rather than `audio`/`stopAudio`.
 *
 * One screen slot rather than one per source, because a phone has one screen.
 * Which source gets it is a precedence decision (runtime.desiredCues), not a
 * mixing one.
 */
export const AUDIO_CUE_SLOTS = CUE_SLOTS.filter((slot) => slot !== 'screen');
export const SCREEN_CUE_SLOT = 'screen';

/**
 * What a guest is.
 *
 * `phone` means a handset was issued for this guest — a person is carrying it,
 * and the show can ask them things. `simulated` is a dot the operator spawned to
 * exercise the building with.
 *
 * Fixed when the guest is created, and deliberately not the same fact as
 * `connected`. A phone that has backgrounded or lost wifi still belongs to
 * somebody standing in a room; treating that moment as "nobody is holding this"
 * is how a tool for standing in for people ends up acting on a person.
 */
export const GUEST_KINDS = ['phone', 'simulated'];

/**
 * Gestures a phone can report. These are raw — what they *mean* is a show
 * decision, made by `inputBindings` mapping each to a guest-machine event, so a
 * room can ask for a tap without the client knowing why.
 */
export const INPUT_KINDS = ['tap', 'swipe', 'shake'];

/**
 * Who in a room a given cue is for, expressed in standings.
 *
 * A room declares its audio once per state and, if it wants, declares a
 * different cue for a different audience of the same state. Which one a guest
 * gets is decided from the standing the guest actor derived — so `multiGuest:
 * "spectator"` and `atCapacity: "personalVariant"` become audible here rather
 * than remaining labels in the operator panel.
 */
export const CUE_AUDIENCES = [
  'participants',
  'spectators',
  'personalVariant',
  'ineligible',
  'occupants',
];

const AUDIENCE_STANDINGS = {
  participants: ['holder', 'participant', 'present'],
  spectators: ['spectator'],
  personalVariant: ['personalVariant'],
  ineligible: ['notTheirs', 'refused'],
};

/**
 * A destination runs for the people it admitted, so its default audience is
 * whoever it is running for. A shared room and a hallway run for the space, and
 * everyone standing in them hears the same thing — which is the whole
 * distinction between the kinds, carried into audio.
 */
export const defaultCueAudience = (kind) => (kind === 'destination' ? 'participants' : 'occupants');

export function cueAudienceMatches(audience, standing, kind) {
  const resolved = audience ?? defaultCueAudience(kind);
  if (resolved === 'occupants') return true;
  return (AUDIENCE_STANDINGS[resolved] ?? []).includes(standing);
}
