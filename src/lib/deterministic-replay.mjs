// SPDX-License-Identifier: MIT

/**
 * Deterministic Replay Engine for Multi-Actor Mutations (#1097).
 *
 * Provides reproducible, sequential transaction log replay across multiple actors,
 * detecting divergence, enforcing monotonic nonces, and ensuring rollback consistency.
 */

export class ReplayDivergenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReplayDivergenceError";
    this.details = details;
  }
}

export class AuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class DeterministicReplayEngine {
  constructor(options = {}) {
    this.allowedRoles = options.allowedRoles || ["admin", "auditor", "system"];
    this.state = options.initialState ? { ...options.initialState } : { balances: {}, nonces: {} };
    this.history = [];
    this.snapshots = new Map();
  }

  _authorize(actorRole) {
    if (!this.allowedRoles.includes(actorRole)) {
      throw new AuthorizationError(`Role "${actorRole}" is not authorized for replay operations`);
    }
  }

  recordMutation(actor, nonce, type, payload) {
    const currentNonce = this.state.nonces[actor] || 0;
    if (nonce !== currentNonce + 1) {
      throw new ReplayDivergenceError(`Invalid nonce for actor ${actor}: expected ${currentNonce + 1}, got ${nonce}`);
    }

    const event = {
      index: this.history.length,
      timestamp: Date.now(),
      actor,
      nonce,
      type,
      payload,
    };

    this._applyEvent(this.state, event);
    this.history.push(event);
    return event;
  }

  _applyEvent(targetState, event) {
    targetState.nonces[event.actor] = event.nonce;

    switch (event.type) {
      case "TRANSFER": {
        const { from, to, amount } = event.payload;
        if (!amount || amount <= 0) {
          throw new ReplayDivergenceError("Transfer amount must be positive");
        }
        const fromBal = targetState.balances[from] || 0;
        if (fromBal < amount) {
          throw new ReplayDivergenceError(`Insufficient balance for ${from}: have ${fromBal}, need ${amount}`);
        }
        targetState.balances[from] = fromBal - amount;
        targetState.balances[to] = (targetState.balances[to] || 0) + amount;
        break;
      }
      case "DEPOSIT": {
        const { account, amount } = event.payload;
        if (!amount || amount <= 0) {
          throw new ReplayDivergenceError("Deposit amount must be positive");
        }
        targetState.balances[account] = (targetState.balances[account] || 0) + amount;
        break;
      }
      default:
        throw new ReplayDivergenceError(`Unknown mutation type: ${event.type}`);
    }
  }

  createCheckpoint(id, callerRole = "system") {
    this._authorize(callerRole);
    this.snapshots.set(id, JSON.parse(JSON.stringify(this.state)));
    return { id, state: this.snapshots.get(id) };
  }

  rollbackToCheckpoint(id, callerRole = "system") {
    this._authorize(callerRole);
    const snapshot = this.snapshots.get(id);
    if (!snapshot) {
      throw new ReplayDivergenceError(`Snapshot ${id} does not exist`);
    }
    this.state = JSON.parse(JSON.stringify(snapshot));
    return this.state;
  }

  replayHistory(targetEvents = null, callerRole = "system") {
    this._authorize(callerRole);
    const events = targetEvents || this.history;
    const replayedState = { balances: {}, nonces: {} };

    for (const event of events) {
      this._applyEvent(replayedState, event);
    }

    // Verify divergence against current state if replaying full history
    if (!targetEvents) {
      const match = JSON.stringify(replayedState) === JSON.stringify(this.state);
      if (!match) {
        throw new ReplayDivergenceError("State diverged during replay verification", {
          expected: this.state,
          replayed: replayedState,
        });
      }
    }

    return replayedState;
  }
}
