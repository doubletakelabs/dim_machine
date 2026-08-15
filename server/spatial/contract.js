/** Contract v3 — spatial model (spec v0.3). */

export const CONTRACT_VERSION = 3;

/**
 * You are in a room or you are not. Reported per room, not per zone — a room
 * may own several zones, and moving between them is not an exit.
 */
export const OCCUPANCY_STATES = ['outside', 'inside'];

export const ROOM_PRESENTATION_STATES = ['idle', 'active', 'settling'];

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

export const ADHERENCE_STATES = ['golden', 'drifting', 'cursed'];

export const AUDIO_TIMINGS = ['masterTimeline', 'perGuest'];

export const AUDIO_JOIN_POLICIES = ['inProgress', 'waitForNext', 'restart'];

export const AUDIO_ON_EXIT = ['fadeOut', 'continue', 'cut'];

export const PHASE_MODES = ['freeRoam', 'directed'];

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

/** Who evaluates a phase's `advanceWhen` — each guest at their own pace, or the show as one. */
export const ADVANCE_SCOPES = ['guest', 'show'];

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
