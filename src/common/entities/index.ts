/** Barrel export for all domain entity classes and their associated type aliases. */
export { UserEntity } from './user.entity';

/* AgentHealthStatus is a type alias — must use 'export type' with isolatedModules */
export { AgentEntity } from './agent.entity';
export type { AgentHealthStatus } from './agent.entity';

/* BountyState is a type alias — must use 'export type' with isolatedModules */
export { BountyEntity } from './bounty.entity';
export type { BountyState } from './bounty.entity';

/* DispatchState is a type alias — must use 'export type' with isolatedModules */
export { BountyRegistrationEntity } from './bounty-registration.entity';
export type { DispatchState } from './bounty-registration.entity';

export { DeliverableEntity } from './deliverable.entity';
export { AgentStatsEntity } from './agent-stats.entity';
export { LeaderboardEntryEntity } from './leaderboard-entry.entity';
