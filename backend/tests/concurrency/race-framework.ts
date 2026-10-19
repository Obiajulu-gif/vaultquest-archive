/**
 * Concurrency race framework for Issue #4.
 * 
 * Orchestrates multiple concurrent actors attempting the same mutation to
 * verify idempotency, CAS logic, and conflict resolution.
 */

export interface RaceScenario {
  name: string;
  actorCount: number;
  description: string;
}

export const RACE_SCENARIOS: RaceScenario[] = [
  {
    name: "duplicate_deposit_submission",
    actorCount: 5,
    description: "Five actors submit the same deposit with identical idempotency key",
  },
  {
    name: "concurrent_quest_completion",
    actorCount: 3,
    description: "Three actors evaluate the same wallet quest simultaneously",
  },
  {
    name: "concurrent_withdraw_stale_version",
    actorCount: 4,
    description: "Four actors attempt withdrawal with potentially stale reads",
  },
  {
    name: "retry_storm_exponential_backoff",
    actorCount: 6,
    description: "Six actors retry the same operation with exponential backoff",
  },
  {
    name: "concurrent_tx_hash_attachment",
    actorCount: 3,
    description: "Three actors attach the same txHash to an action",
  },
  {
    name: "concurrent_settlement_resolution",
    actorCount: 4,
    description: "Four actors attempt to resolve the same settlement",
  },
];

export async function runConcurrentRaces<T>(
  scenario: RaceScenario,
  actor: (actorId: number) => Promise<T>,
  verify: (results: T[]) => Promise<void>
): Promise<T[]> {
  const promises = Array.from({ length: scenario.actorCount }, (_, i) => actor(i + 1));
  
  const results = await Promise.allSettled(promises);
  
  const successResults = results
    .filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled")
    .map((r) => r.value);
  
  await verify(successResults);
  
  return successResults;
}
