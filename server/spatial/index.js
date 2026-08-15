export {
  CONTRACT_VERSION,
  OCCUPANCY_STATES,
  ROOM_PRESENTATION_STATES,
  REQUIRED_ROOM_STATES,
  REQUIRED_ROOM_TRANSITIONS,
  ACTIVATION_CONTEXT_FIELDS,
  REVISIT_EVENTS,
  GUIDANCE_POLICIES,
  ADVANCE_SCOPES,
} from './contract.js';
export { validateShowDefinition } from './validate.js';
export { SpatialRuntime } from './runtime.js';
export { OccupancyCoordinator, nextStep } from './coordinator.js';
export { VirtualLocationAdapter } from './virtual-location.js';
export {
  classifyPoint, pointInPolygon, zoneIndex, occupancyRank,
  polygonCentroid, roomCentroid, floorPlanExtent,
} from './zone-math.js';
export { RoomActor, stateToString, rootState } from './room-actor.js';
export { Guest } from './guest.js';
export { GuestActor } from './guest-actor.js';
export {
  eligibilityStrategy,
  eligibilityConfigFor,
  IMPLEMENTED_ELIGIBILITY_STRATEGIES,
} from './eligibility.js';
export { SystemClock, ManualClock, ScaledClock, systemClock } from './clock.js';
export { WalkthroughDriver } from './walkthrough.js';
