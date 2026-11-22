/**
 * Time-boxed maintainer access grants (#850).
 *
 * Temporary maintainer access that expires automatically and is auditable.
 */

export interface AccessGrant {
  id: string;
  grantee: string;
  scope: string[];
  reason: string;
  approver: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  revokedBy?: string;
}

export interface CreateGrantParams {
  grantee: string;
  scope: string[];
  reason: string;
  approver: string;
  durationMs: number;
}

const grants = new Map<string, AccessGrant>();
let grantCounter = 0;

/**
 * Create a new time-boxed access grant.
 */
export function createAccessGrant(params: CreateGrantParams): AccessGrant {
  if (params.durationMs <= 0) {
    throw new Error('Duration must be positive');
  }
  if (params.durationMs > 30 * 24 * 60 * 60 * 1000) {
    throw new Error('Duration cannot exceed 30 days');
  }

  grantCounter++;
  const grant: AccessGrant = {
    id: `grant-${grantCounter}`,
    grantee: params.grantee,
    scope: params.scope,
    reason: params.reason,
    approver: params.approver,
    createdAt: Date.now(),
    expiresAt: Date.now() + params.durationMs,
  };

  grants.set(grant.id, grant);
  return grant;
}

/**
 * Check if a grant is valid and has the required scope.
 */
export function validateAccessGrant(
  grantId: string,
  requiredScope: string,
  currentTime: number = Date.now()
): { valid: boolean; reason?: string } {
  const grant = grants.get(grantId);
  if (!grant) {
    return { valid: false, reason: 'Grant not found' };
  }

  if (grant.revokedAt) {
    return { valid: false, reason: 'Grant has been revoked' };
  }

  if (currentTime > grant.expiresAt) {
    return { valid: false, reason: 'Grant has expired' };
  }

  if (!grant.scope.includes(requiredScope) && !grant.scope.includes('*')) {
    return { valid: false, reason: 'Scope not authorized' };
  }

  return { valid: true };
}

/**
 * Revoke an access grant.
 */
export function revokeAccessGrant(grantId: string, revokedBy: string): boolean {
  const grant = grants.get(grantId);
  if (!grant || grant.revokedAt) {
    return false;
  }

  grant.revokedAt = Date.now();
  grant.revokedBy = revokedBy;
  return true;
}

/**
 * Get report of active and expired grants.
 */
export function getGrantsReport(): {
  active: AccessGrant[];
  expired: AccessGrant[];
  revoked: AccessGrant[];
} {
  const now = Date.now();
  const active: AccessGrant[] = [];
  const expired: AccessGrant[] = [];
  const revoked: AccessGrant[] = [];

  for (const grant of grants.values()) {
    if (grant.revokedAt) {
      revoked.push(grant);
    } else if (now > grant.expiresAt) {
      expired.push(grant);
    } else {
      active.push(grant);
    }
  }

  return { active, expired, revoked };
}
