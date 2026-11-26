import { createHash } from 'node:crypto';

/**
 * Versioned Event Replay for Derived Projections (#1113).
 *
 * Implements deterministic event replay over versioned append-only event logs
 * to rebuild derived read models (vault balances, user positions, quest progress)
 * with optimistic checkpointing, strict invariant enforcement, and role-based
 * authorization boundaries.
 */

export interface StoredEvent {
  id: string;
  sequence: number;
  ledgerSequence: number;
  txHash: string;
  type: 'deposit' | 'withdraw' | 'yield' | 'quest_complete' | 'claim';
  payload: Record<string, any>;
  version: number;
  timestamp: string;
}

export interface VaultProjection {
  totalDeposits: number;
  participantCount: number;
  yieldDistributed: number;
}

export interface UserPositionProjection {
  totalDeposited: number;
  rewardsClaimed: number;
  completedQuests: string[];
}

export interface DerivedProjectionsState {
  projectionVersion: number;
  lastReplayedSequence: number;
  lastReplayedEventId: string | null;
  stateChecksum: string;
  vaults: Record<string, VaultProjection>;
  users: Record<string, UserPositionProjection>;
}

export interface ReplayOptions {
  targetProjectionVersion: number;
  fromSequence?: number;
  toSequence?: number;
  allowDowngrade?: boolean;
  actorRole: 'admin' | 'maintainer' | 'contributor' | 'user' | 'public';
  actorSubject: string;
  reason?: string;
  maxBatchSize?: number;
  simulateTransientError?: boolean;
}

export interface ReplayResult {
  runId: string;
  status: 'completed' | 'paused' | 'failed' | 'quarantined';
  projectionVersion: number;
  eventsReplayed: number;
  checkpointSequence: number;
  stateChecksum: string;
  error?: {
    code: string;
    message: string;
    sequence?: number;
    eventId?: string;
    retryable?: boolean;
  };
}

export class ReplayError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly retryable = false,
    public readonly sequence?: number,
    public readonly eventId?: string
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

/**
 * Computes deterministic canonical SHA-256 hash across derived projection state.
 */
export function computeStateChecksum(state: Pick<DerivedProjectionsState, 'projectionVersion' | 'lastReplayedSequence' | 'vaults' | 'users'>): string {
  const canonical = {
    v: state.projectionVersion,
    seq: state.lastReplayedSequence,
    vaults: Object.keys(state.vaults).sort().reduce((acc, k) => {
      acc[k] = state.vaults[k];
      return acc;
    }, {} as Record<string, VaultProjection>),
    users: Object.keys(state.users).sort().reduce((acc, k) => {
      acc[k] = {
        totalDeposited: state.users[k].totalDeposited,
        rewardsClaimed: state.users[k].rewardsClaimed,
        completedQuests: [...state.users[k].completedQuests].sort(),
      };
      return acc;
    }, {} as Record<string, UserPositionProjection>),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function createInitialProjections(version: number): DerivedProjectionsState {
  return {
    projectionVersion: version,
    lastReplayedSequence: 0,
    lastReplayedEventId: null,
    stateChecksum: computeStateChecksum({
      projectionVersion: version,
      lastReplayedSequence: 0,
      vaults: {},
      users: {},
    }),
    vaults: {},
    users: {},
  };
}

export class VersionedEventReplayEngine {
  private state: DerivedProjectionsState;
  private readonly quarantinedEvents = new Set<string>();

  constructor(initialState?: DerivedProjectionsState) {
    this.state = initialState
      ? JSON.parse(JSON.stringify(initialState))
      : createInitialProjections(1);
  }

  getState(): Readonly<DerivedProjectionsState> {
    return JSON.parse(JSON.stringify(this.state));
  }

  resolveQuarantinedEvent(eventId: string): void {
    this.quarantinedEvents.delete(eventId);
  }

  /**
   * Replays an ordered slice of versioned events into the projection state.
   */
  async replay(events: StoredEvent[], options: ReplayOptions): Promise<ReplayResult> {
    const runId = `replay-${Date.now()}`;

    // 1. Authorization check
    if (!options.actorSubject || options.actorRole === 'public') {
      throw new ReplayError('Unauthenticated request', 401, 'UNAUTHORIZED', false);
    }
    if (options.actorRole !== 'admin' && options.actorRole !== 'maintainer') {
      throw new ReplayError('Requires maintainer or admin role to execute projection replay', 403, 'FORBIDDEN', false);
    }
    if (!options.reason || options.reason.trim().length < 3) {
      throw new ReplayError('Replay execution requires an audited reason (minimum 3 characters)', 400, 'INVALID_REASON', false);
    }

    // 2. Version compatibility check
    if (this.state.projectionVersion > options.targetProjectionVersion && !options.allowDowngrade) {
      throw new ReplayError(
        `Projection version downgrade from v${this.state.projectionVersion} to v${options.targetProjectionVersion} requires explicit allowDowngrade flag`,
        409,
        'DOWNGRADE_FORBIDDEN',
        false
      );
    }

    // 3. Transient simulation check
    if (options.simulateTransientError) {
      throw new ReplayError('Transient I/O failure during event stream fetch', 503, 'TRANSIENT_IO_ERROR', true);
    }

    // Sort events deterministically by sequence
    const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
    let eventsReplayed = 0;
    const fromSeq = options.fromSequence ?? this.state.lastReplayedSequence + 1;
    const toSeq = options.toSequence ?? Infinity;

    for (const event of sorted) {
      // Skip events prior to fromSeq
      if (event.sequence < fromSeq) {
        continue;
      }
      if (event.sequence > toSeq) {
        break;
      }

      // Check for sequence gaps
      if (event.sequence > this.state.lastReplayedSequence + 1) {
        return {
          runId,
          status: 'failed',
          projectionVersion: this.state.projectionVersion,
          eventsReplayed,
          checkpointSequence: this.state.lastReplayedSequence,
          stateChecksum: this.state.stateChecksum,
          error: {
            code: 'SEQUENCE_GAP',
            message: `Detected sequence gap: expected sequence ${this.state.lastReplayedSequence + 1}, found ${event.sequence}`,
            sequence: event.sequence,
            eventId: event.id,
            retryable: false,
          },
        };
      }

      // Check quarantine
      if (this.quarantinedEvents.has(event.id)) {
        return {
          runId,
          status: 'quarantined',
          projectionVersion: this.state.projectionVersion,
          eventsReplayed,
          checkpointSequence: this.state.lastReplayedSequence,
          stateChecksum: this.state.stateChecksum,
          error: {
            code: 'POISON_EVENT_QUARANTINED',
            message: `Halting at unresolved poison event ${event.id}`,
            sequence: event.sequence,
            eventId: event.id,
            retryable: false,
          },
        };
      }

      // Check event schema version against target
      if (event.version > options.targetProjectionVersion) {
        this.quarantinedEvents.add(event.id);
        return {
          runId,
          status: 'quarantined',
          projectionVersion: this.state.projectionVersion,
          eventsReplayed,
          checkpointSequence: this.state.lastReplayedSequence,
          stateChecksum: this.state.stateChecksum,
          error: {
            code: 'FORWARD_VERSION_UNSUPPORTED',
            message: `Event ${event.id} requires schema v${event.version}, exceeding target projection v${options.targetProjectionVersion}`,
            sequence: event.sequence,
            eventId: event.id,
            retryable: false,
          },
        };
      }

      // Apply event transition
      try {
        this.applyEvent(event);
        eventsReplayed++;
        this.state.lastReplayedSequence = event.sequence;
        this.state.lastReplayedEventId = event.id;
        this.state.projectionVersion = options.targetProjectionVersion;
        this.state.stateChecksum = computeStateChecksum(this.state);
      } catch (err: any) {
        this.quarantinedEvents.add(event.id);
        return {
          runId,
          status: 'quarantined',
          projectionVersion: this.state.projectionVersion,
          eventsReplayed,
          checkpointSequence: this.state.lastReplayedSequence,
          stateChecksum: this.state.stateChecksum,
          error: {
            code: err.code || 'INVARIANT_VIOLATION',
            message: err.message,
            sequence: event.sequence,
            eventId: event.id,
            retryable: false,
          },
        };
      }
    }

    return {
      runId,
      status: 'completed',
      projectionVersion: this.state.projectionVersion,
      eventsReplayed,
      checkpointSequence: this.state.lastReplayedSequence,
      stateChecksum: this.state.stateChecksum,
    };
  }

  private applyEvent(event: StoredEvent): void {
    const { type, payload } = event;

    switch (type) {
      case 'deposit': {
        const { vaultId, walletAddress, amount } = payload;
        if (!vaultId || !walletAddress || typeof amount !== 'number' || amount <= 0) {
          throw new ReplayError('Invalid deposit payload structure or non-positive amount', 400, 'MALFORMED_EVENT_PAYLOAD');
        }
        if (!this.state.vaults[vaultId]) {
          this.state.vaults[vaultId] = { totalDeposits: 0, participantCount: 0, yieldDistributed: 0 };
        }
        if (!this.state.users[walletAddress]) {
          this.state.users[walletAddress] = { totalDeposited: 0, rewardsClaimed: 0, completedQuests: [] };
          this.state.vaults[vaultId].participantCount++;
        }
        this.state.vaults[vaultId].totalDeposits += amount;
        this.state.users[walletAddress].totalDeposited += amount;
        break;
      }

      case 'withdraw': {
        const { vaultId, walletAddress, amount } = payload;
        if (!vaultId || !walletAddress || typeof amount !== 'number' || amount <= 0) {
          throw new ReplayError('Invalid withdraw payload structure or non-positive amount', 400, 'MALFORMED_EVENT_PAYLOAD');
        }
        const vault = this.state.vaults[vaultId];
        const user = this.state.users[walletAddress];
        if (!vault || vault.totalDeposits < amount) {
          throw new ReplayError(`Vault ${vaultId} has insufficient balance for withdrawal`, 409, 'INVARIANT_VIOLATION');
        }
        if (!user || user.totalDeposited < amount) {
          throw new ReplayError(`User ${walletAddress} has insufficient deposit balance`, 409, 'INVARIANT_VIOLATION');
        }
        vault.totalDeposits -= amount;
        user.totalDeposited -= amount;
        break;
      }

      case 'yield': {
        const { vaultId, amount } = payload;
        if (!vaultId || typeof amount !== 'number' || amount < 0) {
          throw new ReplayError('Invalid yield payload', 400, 'MALFORMED_EVENT_PAYLOAD');
        }
        if (!this.state.vaults[vaultId]) {
          this.state.vaults[vaultId] = { totalDeposits: 0, participantCount: 0, yieldDistributed: 0 };
        }
        this.state.vaults[vaultId].yieldDistributed += amount;
        break;
      }

      case 'quest_complete': {
        const { questId, walletAddress } = payload;
        if (!questId || !walletAddress) {
          throw new ReplayError('Invalid quest_complete payload', 400, 'MALFORMED_EVENT_PAYLOAD');
        }
        if (!this.state.users[walletAddress]) {
          this.state.users[walletAddress] = { totalDeposited: 0, rewardsClaimed: 0, completedQuests: [] };
        }
        if (!this.state.users[walletAddress].completedQuests.includes(questId)) {
          this.state.users[walletAddress].completedQuests.push(questId);
        }
        break;
      }

      case 'claim': {
        const { walletAddress, amount } = payload;
        if (!walletAddress || typeof amount !== 'number' || amount <= 0) {
          throw new ReplayError('Invalid claim payload', 400, 'MALFORMED_EVENT_PAYLOAD');
        }
        if (!this.state.users[walletAddress]) {
          this.state.users[walletAddress] = { totalDeposited: 0, rewardsClaimed: 0, completedQuests: [] };
        }
        this.state.users[walletAddress].rewardsClaimed += amount;
        break;
      }

      default:
        throw new ReplayError(`Unknown event type: ${type}`, 400, 'UNKNOWN_EVENT_TYPE');
    }
  }
}
