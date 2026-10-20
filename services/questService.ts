/**
 * Quest Service (#651)
 *
 * Orchestration layer for Savings Quests: creation, enrollment, tracking, and
 * completion. Like `savingsService.ts` this is a frontend mock for local
 * development, so reward/participation semantics must stay aligned with the
 * contract-facing fixtures in `lib/conformance-spec.ts` (funded quests only,
 * strict positive amounts, no regressions on progress).
 *
 * Intentionally mocked behavior (see docs/VAULT_ENGAGEMENT_DATA.md):
 *  - In-memory "Mock DB" with no persistence.
 *  - Escrow is simulated via `escrowId`/`escrowStatus`; the real contract
 *    releases funds through its payout flow.
 */

import { validateQuestReward, type ContractBehaviorError } from "../lib/conformance-spec";

export interface QuestMilestone {
  id: string;
  description: string;
  targetAmount: number;
  deadline: number;
  isCompleted: boolean;
}

export interface Quest {
  id: string;
  title: string;
  description: string;
  sponsorAddress: string;
  rewardAmount: number;
  rewardToken: string;
  status: "ACTIVE" | "DRAFT" | "CLOSED";
  escrowId?: string;
  escrowStatus?: string;
  milestones: QuestMilestone[];
  createdAt: number;
  updatedAt: number;
}

export interface MilestoneProgress {
  completedAt: number | null;
}

export interface UserQuestParticipation {
  questId: string;
  userAddress: string;
  currentBalance: number;
  streakDays: number;
  lastDepositAt: number | null;
  milestoneProgress: MilestoneProgress[];
  isEligibleForReward: boolean;
}

// Mock DB for demonstration (#651: intentional — see doc header).
function seedQuests(): Quest[] {
  return [
    {
      id: "q_1",
      title: "30-Day Savings Sprint",
      description: "Save daily for 30 days to earn a shared USDC reward pool.",
      sponsorAddress: "GB...SPONSOR",
      rewardAmount: 500,
      rewardToken: "USDC",
      status: "ACTIVE",
      escrowId: "tw_escrow_1",
      escrowStatus: "FUNDED",
      milestones: [
        { id: "ms_1", description: "Week 1 Goal", targetAmount: 50, deadline: Date.now() + 7 * 86400000, isCompleted: false },
        { id: "ms_2", description: "Week 2 Goal", targetAmount: 100, deadline: Date.now() + 14 * 86400000, isCompleted: false },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "q_2",
      title: "Student Saver Quest",
      description: "A special quest for students to build their first emergency fund.",
      sponsorAddress: "GB...EDU",
      rewardAmount: 250,
      rewardToken: "XLM",
      status: "ACTIVE",
      escrowId: "tw_escrow_2",
      escrowStatus: "FUNDED",
      milestones: [
        { id: "ms_3", description: "Initial Deposit", targetAmount: 10, deadline: Date.now() + 2 * 86400000, isCompleted: false },
        { id: "ms_4", description: "Halfway Mark", targetAmount: 50, deadline: Date.now() + 15 * 86400000, isCompleted: false },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
}
let quests: Quest[] = seedQuests();
let participations: UserQuestParticipation[] = [];

const QUEST_NOT_FOUND = "Quest not found";
const QUEST_NOT_JOINABLE = "Quest is not joinable at this time";
const PARTICIPATION_NOT_FOUND = "Participation not found";

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}`;
}

function assertFunded(rewardAmount: number): void {
  const err = validateQuestReward(rewardAmount);
  if (err) {
    throw new Error(err);
  }
}

/**
 * Creates a new savings quest and initializes its escrow.
 * Mirrors contract funding semantics: an unfunded reward pool is invalid.
 */
export async function createChallenge(
  title: string,
  description: string,
  sponsorAddress: string,
  rewardAmount: number,
  rewardToken: string,
  milestoneTargets: number[],
  escrowId?: string,
): Promise<Quest> {
  assertFunded(rewardAmount);

  const newQuest: Quest = {
    id: nextId("q"),
    title,
    description,
    sponsorAddress,
    rewardAmount,
    rewardToken,
    status: escrowId ? "ACTIVE" : "DRAFT",
    escrowId,
    escrowStatus: escrowId ? "FUNDED" : "PENDING",
    milestones: milestoneTargets.map((target, index) => ({
      id: `ms_${index}`,
      description: `Save ${target} ${rewardToken}`,
      targetAmount: target,
      deadline: Date.now() + (index + 1) * 7 * 86400000,
      isCompleted: false,
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  quests.push(newQuest);
  return newQuest;
}

/** Fetches all available quests. */
export function getAllChallenges(): Quest[] {
  return quests;
}

/** Resets the mock DB (test helper; not part of the production API). */
export function __resetQuestDb(): void {
  quests = seedQuests();
  participations = [];
}

/**
 * Joins a user to a quest. Only funded, active quests are joinable — this
 * mirrors the contract refusing to accept value for an inactive pool.
 */
export async function joinChallenge(questId: string, userAddress: string): Promise<UserQuestParticipation> {
  const quest = quests.find((q) => q.id === questId);
  if (!quest) throw new Error(QUEST_NOT_FOUND);
  if (quest.status !== "ACTIVE") throw new Error(QUEST_NOT_JOINABLE);

  const existing = participations.find((p) => p.questId === questId && p.userAddress === userAddress);
  if (existing) return existing;

  const participation: UserQuestParticipation = {
    questId,
    userAddress,
    currentBalance: 0,
    streakDays: 0,
    lastDepositAt: null,
    milestoneProgress: quest.milestones.map(() => ({ completedAt: null })),
    isEligibleForReward: false,
  };
  participations.push(participation);
  return participation;
}

/**
 * Updates progress for a user's quest.
 *
 * Contract-aligned monotonic guarantee: `newBalance` may never regress
 * (withdrawals never reduce earned progress), so an invalid regression is
 * rejected rather than silently rolled back.
 */
export async function updateProgress(questId: string, userAddress: string, newBalance: number): Promise<UserQuestParticipation> {
  const pIdx = participations.findIndex((p) => p.questId === questId && p.userAddress === userAddress);
  if (pIdx === -1) throw new Error(PARTICIPATION_NOT_FOUND);

  const participation = participations[pIdx];
  if (newBalance < participation.currentBalance) {
    throw new Error("InvalidAmount");
  }

  participation.currentBalance = newBalance;
  participation.isEligibleForReward = newBalance > 0;
  return participation;
}

export function isContractBehaviorError(error: unknown): error is ContractBehaviorError {
  return (
    error === "InvalidAmount" ||
    error === "LockupActive" ||
    error === "InvalidAction" ||
    error === "ClaimDeadlinePassed"
  );
}