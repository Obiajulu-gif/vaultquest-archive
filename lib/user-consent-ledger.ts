/**
 * User Consent Ledger for terms, policies, and data processing changes (#Issue).
 *
 * Provides immutable, versioned recording of consent for regulatory compliance,
 * auditability, and access control gating in VaultQuest.
 */

export type ConsentStatus = 'granted' | 'revoked';

export type PolicyType = 'terms_of_service' | 'privacy_policy' | 'data_processing' | 'marketing' | (string & {});

export interface ConsentRecord {
  id: string;
  userId: string;
  policyType: PolicyType;
  policyVersion: string;
  status: ConsentStatus;
  actor: string;
  source: string; // e.g. 'web_wallet_connect', 'deposit_flow', 'settings_modal', 'api'
  timestamp: string; // ISO-8601 string
  metadata?: Record<string, unknown>;
}

export interface PolicyDefinition {
  type: PolicyType;
  version: string;
  title: string;
  required: boolean;
  effectiveDate: string;
}

export interface ConsentHistoryQuery {
  userId: string;
  policyType?: PolicyType;
}

export interface FlowGateCheckResult {
  allowed: boolean;
  missingPolicies: Array<{
    type: PolicyType;
    requiredVersion: string;
    currentConsentStatus?: ConsentStatus;
    currentConsentedVersion?: string;
  }>;
}

export class UserConsentLedger {
  private readonly records: ConsentRecord[] = [];
  private readonly activePolicies: Map<PolicyType, PolicyDefinition> = new Map();
  private recordSequence = 0;

  constructor(initialPolicies?: PolicyDefinition[]) {
    if (initialPolicies) {
      for (const policy of initialPolicies) {
        this.registerPolicy(policy);
      }
    }
  }

  /**
   * Register or update active policy version.
   */
  registerPolicy(policy: PolicyDefinition): void {
    if (!policy.type || !policy.version) {
      throw new Error('Policy definition requires type and version');
    }
    this.activePolicies.set(policy.type, Object.freeze({ ...policy }));
  }

  /**
   * Get current policy definition by type.
   */
  getPolicy(type: PolicyType): PolicyDefinition | undefined {
    return this.activePolicies.get(type);
  }

  /**
   * Record a new consent action (grant or revoke) against an immutable policy version.
   */
  recordConsent(params: {
    userId: string;
    policyType: PolicyType;
    policyVersion: string;
    status: ConsentStatus;
    actor: string;
    source: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }): Readonly<ConsentRecord> {
    if (!params.userId) throw new Error('userId is required');
    if (!params.policyType) throw new Error('policyType is required');
    if (!params.policyVersion) throw new Error('policyVersion is required');
    if (!params.actor) throw new Error('actor is required');
    if (!params.source) throw new Error('source is required');

    this.recordSequence += 1;
    const record: ConsentRecord = Object.freeze({
      id: `consent-${this.recordSequence}`,
      userId: params.userId,
      policyType: params.policyType,
      policyVersion: params.policyVersion,
      status: params.status,
      actor: params.actor,
      source: params.source,
      timestamp: params.timestamp ?? new Date().toISOString(),
      metadata: params.metadata ? Object.freeze({ ...params.metadata }) : undefined,
    });

    this.records.push(record);
    return record;
  }

  /**
   * Check if a user has active consent for a specific policy and version.
   */
  hasValidConsent(userId: string, policyType: PolicyType, requiredVersion?: string): boolean {
    const targetVersion = requiredVersion ?? this.activePolicies.get(policyType)?.version;
    if (!targetVersion) {
      return false;
    }

    // Find the latest record for this user and policyType
    const userRecords = this.records.filter(
      (r) => r.userId === userId && r.policyType === policyType
    );

    if (userRecords.length === 0) {
      return false;
    }

    const latest = userRecords[userRecords.length - 1];
    return latest.status === 'granted' && latest.policyVersion === targetVersion;
  }

  /**
   * Gates flows based on required policies.
   * Users missing required consent or having outdated/revoked consent are disallowed.
   */
  gateFlow(userId: string, requiredPolicyTypes?: PolicyType[]): FlowGateCheckResult {
    const typesToCheck = requiredPolicyTypes ?? Array.from(this.activePolicies.values())
      .filter((p) => p.required)
      .map((p) => p.type);

    const missingPolicies: FlowGateCheckResult['missingPolicies'] = [];

    for (const type of typesToCheck) {
      const activePolicy = this.activePolicies.get(type);
      const requiredVersion = activePolicy ? activePolicy.version : 'latest';

      const userRecords = this.records.filter(
        (r) => r.userId === userId && r.policyType === type
      );
      const latest = userRecords.length > 0 ? userRecords[userRecords.length - 1] : undefined;

      if (!latest || latest.status !== 'granted' || latest.policyVersion !== requiredVersion) {
        missingPolicies.push({
          type,
          requiredVersion,
          currentConsentStatus: latest?.status,
          currentConsentedVersion: latest?.policyVersion,
        });
      }
    }

    return {
      allowed: missingPolicies.length === 0,
      missingPolicies,
    };
  }

  /**
   * Expose safe consent history to authorized viewers (self user or maintainer/auditor).
   */
  getConsentHistory(
    query: ConsentHistoryQuery,
    viewer: { actorId: string; role: 'user' | 'maintainer' | 'auditor' }
  ): ReadonlyArray<ConsentRecord> {
    if (viewer.role === 'user' && viewer.actorId !== query.userId) {
      throw new Error('Unauthorized: users can only view their own consent history');
    }

    return this.records
      .filter((r) => {
        if (r.userId !== query.userId) return false;
        if (query.policyType && r.policyType !== query.policyType) return false;
        return true;
      })
      .map((r) => ({ ...r }));
  }

  /**
   * Query all records for auditing (restricted to auditor or maintainer).
   */
  exportAuditLedger(viewer: { actorId: string; role: 'maintainer' | 'auditor' }): ReadonlyArray<ConsentRecord> {
    if (viewer.role !== 'maintainer' && viewer.role !== 'auditor') {
      throw new Error('Unauthorized: only maintainers and auditors can export the consent ledger');
    }
    return [...this.records];
  }
}

export const defaultConsentLedger = new UserConsentLedger([
  {
    type: 'terms_of_service',
    version: '1.0.0',
    title: 'Terms of Service',
    required: true,
    effectiveDate: '2026-01-01T00:00:00Z',
  },
  {
    type: 'privacy_policy',
    version: '1.0.0',
    title: 'Privacy Policy',
    required: true,
    effectiveDate: '2026-01-01T00:00:00Z',
  },
  {
    type: 'data_processing',
    version: '1.0.0',
    title: 'Data Processing Agreement',
    required: true,
    effectiveDate: '2026-01-01T00:00:00Z',
  },
]);
