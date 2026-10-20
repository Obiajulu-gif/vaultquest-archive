export interface LockupWeightTier {
  /** Inclusive upper bound; null marks the final unbounded tier. */
  maxDays: number | null;
  multiplierBps: number;
}

export interface BusinessPolicyConfig {
  /** Amount must be strictly greater than this value. */
  minimumDeposit: number;
  /** Null disables the per-deposit ceiling. */
  maximumDeposit: number | null;
  /** Null disables the per-withdrawal ceiling. */
  maximumWithdrawal: number | null;
  /** Prize must be strictly greater than this value. */
  minimumPrize: number;
  minimumEligibleParticipants: number;
  /** Quest reward must be strictly greater than this value. */
  minimumQuestReward: number;
  /** Null disables the quest reward ceiling. */
  maximumQuestReward: number | null;
  lockupWeightTiers: readonly LockupWeightTier[];
}

export type BusinessPolicyOverrides = Partial<Omit<BusinessPolicyConfig, "lockupWeightTiers">> & {
  lockupWeightTiers?: readonly LockupWeightTier[];
};

export type BusinessPolicyInput =
  | { rule: "deposit"; amount: number }
  | { rule: "withdrawal"; amount?: number; lockedUntilLedger?: number; currentLedger?: number }
  | { rule: "claim"; availableAmount: number; deadline?: number | null; now: number }
  | { rule: "credit_yield"; amount: number; distributableYield: number }
  | { rule: "draw"; prize: number; eligibleParticipants?: number }
  | { rule: "quest_reward"; amount: number }
  | { rule: "lockup_weight"; lockupDays: number };

export type BusinessPolicyCode =
  | "Allowed"
  | "NoClaimableReward"
  | "InvalidAmount"
  | "DepositLimitExceeded"
  | "WithdrawalLimitExceeded"
  | "LockupActive"
  | "ClaimDeadlinePassed"
  | "InvalidAction"
  | "NoEligibleParticipants"
  | "QuestRewardLimitExceeded"
  | "InvalidPolicyConfiguration";

export interface BusinessPolicyDecision {
  status: "allow" | "deny" | "noop";
  rule: BusinessPolicyInput["rule"];
  code: BusinessPolicyCode;
  message: string;
  value?: number;
}

export class BusinessPolicyError extends Error {
  readonly code: BusinessPolicyCode;
  readonly rule: BusinessPolicyInput["rule"];
  readonly userMessage: string;

  constructor(decision: BusinessPolicyDecision) {
    super(`${decision.code}: ${decision.message}`);
    this.name = "BusinessPolicyError";
    this.code = decision.code;
    this.rule = decision.rule;
    this.userMessage = decision.message;
  }
}

export const DEFAULT_BUSINESS_POLICY: BusinessPolicyConfig = Object.freeze({
  minimumDeposit: 0,
  maximumDeposit: null,
  maximumWithdrawal: null,
  minimumPrize: 0,
  minimumEligibleParticipants: 1,
  minimumQuestReward: 0,
  maximumQuestReward: null,
  lockupWeightTiers: Object.freeze([
    Object.freeze({ maxDays: 0, multiplierBps: 100 }),
    Object.freeze({ maxDays: 7, multiplierBps: 110 }),
    Object.freeze({ maxDays: 14, multiplierBps: 125 }),
    Object.freeze({ maxDays: null, multiplierBps: 150 })
  ])
});

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function invalidConfiguration(): never {
  throw new Error("InvalidPolicyConfiguration: check policy thresholds and lockup tiers");
}

function validateConfig(config: BusinessPolicyConfig): void {
  if (!isFiniteNonNegative(config.minimumDeposit) || !isFiniteNonNegative(config.minimumPrize) ||
      !isFiniteNonNegative(config.minimumQuestReward) ||
      (config.maximumDeposit !== null && (!Number.isFinite(config.maximumDeposit) || config.maximumDeposit <= config.minimumDeposit)) ||
      (config.maximumWithdrawal !== null && (!Number.isFinite(config.maximumWithdrawal) || config.maximumWithdrawal <= 0)) ||
      (config.maximumQuestReward !== null && (!Number.isFinite(config.maximumQuestReward) || config.maximumQuestReward <= config.minimumQuestReward)) ||
      !Number.isInteger(config.minimumEligibleParticipants) || config.minimumEligibleParticipants < 1 ||
      config.lockupWeightTiers.length === 0) {
    invalidConfiguration();
  }

  let previousMax = -1;
  for (let index = 0; index < config.lockupWeightTiers.length; index += 1) {
    const tier = config.lockupWeightTiers[index];
    const isLast = index === config.lockupWeightTiers.length - 1;
    if (!Number.isInteger(tier.multiplierBps) || tier.multiplierBps <= 0 ||
        (tier.maxDays !== null && (!Number.isInteger(tier.maxDays) || tier.maxDays < 0 || tier.maxDays <= previousMax)) ||
        (isLast !== (tier.maxDays === null))) {
      invalidConfiguration();
    }
    if (tier.maxDays !== null) previousMax = tier.maxDays;
  }
}

function allow(rule: BusinessPolicyInput["rule"], value?: number): BusinessPolicyDecision {
  return { status: "allow", rule, code: "Allowed", message: "This action meets the current policy.", ...(value === undefined ? {} : { value }) };
}

function deny(rule: BusinessPolicyInput["rule"], code: BusinessPolicyCode, message: string): BusinessPolicyDecision {
  return { status: "deny", rule, code, message };
}

export class BusinessPolicyEngine {
  readonly config: Readonly<BusinessPolicyConfig>;

  constructor(overrides: BusinessPolicyOverrides = {}) {
    const merged = {
      ...DEFAULT_BUSINESS_POLICY,
      ...overrides,
      lockupWeightTiers: (overrides.lockupWeightTiers ?? DEFAULT_BUSINESS_POLICY.lockupWeightTiers)
        .map((tier) => Object.freeze({ ...tier }))
    };
    this.config = Object.freeze({ ...merged, lockupWeightTiers: Object.freeze(merged.lockupWeightTiers) });
    validateConfig(this.config);
  }

  evaluate(input: BusinessPolicyInput): BusinessPolicyDecision {
    switch (input.rule) {
      case "deposit": {
        if (!Number.isFinite(input.amount) || input.amount <= this.config.minimumDeposit) {
          return deny("deposit", "InvalidAmount", "Enter a deposit amount greater than zero.");
        }
        if (this.config.maximumDeposit !== null && input.amount > this.config.maximumDeposit) {
          return deny("deposit", "DepositLimitExceeded", `Deposit is above the current per-transaction limit of ${this.config.maximumDeposit}. Lower the amount and try again.`);
        }
        return allow("deposit");
      }
      case "withdrawal":
        if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount <= 0)) {
          return deny("withdrawal", "InvalidAmount", "Enter a withdrawal amount greater than zero.");
        }
        if (input.amount !== undefined && this.config.maximumWithdrawal !== null && input.amount > this.config.maximumWithdrawal) {
          return deny("withdrawal", "WithdrawalLimitExceeded", `Withdrawal is above the current per-transaction limit of ${this.config.maximumWithdrawal}. Lower the amount and try again.`);
        }
        if (input.lockedUntilLedger === undefined && input.currentLedger === undefined) return allow("withdrawal");
        if (!Number.isFinite(input.lockedUntilLedger) || !Number.isFinite(input.currentLedger)) {
          return deny("withdrawal", "InvalidAction", "Withdrawal eligibility could not be checked. Refresh the vault and try again.");
        }
        return input.currentLedger! < input.lockedUntilLedger!
          ? deny("withdrawal", "LockupActive", "Your deposit is still locked. Wait until the lockup period ends before withdrawing.")
          : allow("withdrawal");
      case "claim":
        if (input.deadline != null && input.now > input.deadline) {
          return deny("claim", "ClaimDeadlinePassed", "The claim period has ended. Contact support if you believe this is an error.");
        }
        if (!Number.isFinite(input.availableAmount)) {
          return deny("claim", "InvalidAction", "Claimable rewards could not be calculated. Refresh and try again.");
        }
        return input.availableAmount <= 0
          ? { status: "noop", rule: "claim", code: "NoClaimableReward", message: "There are no rewards available to claim yet.", value: 0 }
          : allow("claim", input.availableAmount);
      case "credit_yield":
        if (!Number.isFinite(input.amount) || input.amount <= 0) {
          return deny("credit_yield", "InvalidAmount", "Yield credit must be greater than zero.");
        }
        if (!Number.isFinite(input.distributableYield) || input.amount > input.distributableYield) {
          return deny("credit_yield", "InvalidAction", "The requested yield exceeds the amount currently available for distribution.");
        }
        return allow("credit_yield");
      case "draw":
        if (!Number.isFinite(input.prize) || input.prize <= this.config.minimumPrize) {
          return deny("draw", "InvalidAmount", "The prize must be greater than the configured minimum before a draw can run.");
        }
        if (input.eligibleParticipants !== undefined &&
            (!Number.isInteger(input.eligibleParticipants) || input.eligibleParticipants < this.config.minimumEligibleParticipants)) {
          return deny("draw", "NoEligibleParticipants", `At least ${this.config.minimumEligibleParticipants} eligible participant(s) are required to run this draw.`);
        }
        return allow("draw");
      case "quest_reward":
        if (!Number.isFinite(input.amount) || input.amount <= this.config.minimumQuestReward) {
          return deny("quest_reward", "InvalidAmount", "The quest reward must be greater than zero.");
        }
        if (this.config.maximumQuestReward !== null && input.amount > this.config.maximumQuestReward) {
          return deny("quest_reward", "QuestRewardLimitExceeded", `Quest reward is above the current limit of ${this.config.maximumQuestReward}. Lower the reward and try again.`);
        }
        return allow("quest_reward");
      case "lockup_weight": {
        if (!Number.isFinite(input.lockupDays)) {
          return deny("lockup_weight", "InvalidAction", "Lockup duration must be a finite number of days.");
        }
        const tier = this.config.lockupWeightTiers.find((candidate) => candidate.maxDays === null || input.lockupDays <= candidate.maxDays);
        return tier ? allow("lockup_weight", tier.multiplierBps) : deny("lockup_weight", "InvalidPolicyConfiguration", "No reward-weight tier is configured for this lockup duration.");
      }
    }
  }
}

export const DEFAULT_BUSINESS_POLICY_ENGINE = new BusinessPolicyEngine();

export function parseBusinessPolicyOverrides(json: string): BusinessPolicyOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("InvalidPolicyConfiguration: policy overrides must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidConfiguration();
  const overrides = parsed as BusinessPolicyOverrides;
  new BusinessPolicyEngine(overrides);
  return overrides;
}