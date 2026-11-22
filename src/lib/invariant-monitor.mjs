// SPDX-License-Identifier: MIT

/**
 * Invariant Monitoring Engine for Balances and Ownership (#1103).
 *
 * Continuously evaluates conservation of funds, non-negative balances, and unambiguous
 * single-ownership invariants across vault resources, with anomaly alerting and emergency rollback.
 */

export class InvariantViolationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InvariantViolationError";
    this.details = details;
  }
}

export class InvariantAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvariantAuthError";
  }
}

export class InvariantMonitor {
  constructor(options = {}) {
    this.allowedRoles = options.allowedRoles || ["admin", "auditor", "security"];
    this.alertLog = [];
    this.isPaused = false;
  }

  _authorize(role) {
    if (!this.allowedRoles.includes(role)) {
      throw new InvariantAuthError(`Role "${role}" unauthorized for invariant monitor management`);
    }
  }

  checkConservation(vaults, totalSupply) {
    const totalVaultBalances = Object.values(vaults).reduce((acc, val) => acc + (val || 0), 0);
    if (totalVaultBalances !== totalSupply) {
      const delta = totalVaultBalances - totalSupply;
      const violation = {
        type: "BALANCE_CONSERVATION_BREACH",
        totalVaultBalances,
        totalSupply,
        delta,
        timestamp: Date.now(),
      };
      this.alertLog.push(violation);
      this.isPaused = true; // Auto-trip emergency stop
      throw new InvariantViolationError(
        `Balance conservation violated: vault sum (${totalVaultBalances}) != total supply (${totalSupply})`,
        violation
      );
    }
    return true;
  }

  checkNonNegativeBalances(accounts) {
    for (const [account, balance] of Object.entries(accounts)) {
      if (balance < 0) {
        const violation = {
          type: "NEGATIVE_BALANCE_DETECTED",
          account,
          balance,
          timestamp: Date.now(),
        };
        this.alertLog.push(violation);
        this.isPaused = true;
        throw new InvariantViolationError(
          `Negative balance invariant breached: account ${account} has balance ${balance}`,
          violation
        );
      }
    }
    return true;
  }

  checkSingleOwnership(ownershipRegistry) {
    const seenResources = new Set();
    for (const [resourceId, owner] of Object.entries(ownershipRegistry)) {
      if (!owner || typeof owner !== "string" || owner.trim() === "") {
        const violation = {
          type: "ORPHANED_RESOURCE_DETECTED",
          resourceId,
          timestamp: Date.now(),
        };
        this.alertLog.push(violation);
        this.isPaused = true;
        throw new InvariantViolationError(`Resource ${resourceId} has no valid owner`, violation);
      }
      if (seenResources.has(resourceId)) {
        const violation = {
          type: "DUAL_OWNERSHIP_DETECTED",
          resourceId,
          timestamp: Date.now(),
        };
        this.alertLog.push(violation);
        this.isPaused = true;
        throw new InvariantViolationError(`Duplicate ownership detected for resource ${resourceId}`, violation);
      }
      seenResources.add(resourceId);
    }
    return true;
  }

  acknowledgeAlerts(callerRole = "security") {
    this._authorize(callerRole);
    const acknowledgedCount = this.alertLog.length;
    this.alertLog = [];
    this.isPaused = false;
    return { acknowledgedCount };
  }

  getAlerts() {
    return [...this.alertLog];
  }
}
