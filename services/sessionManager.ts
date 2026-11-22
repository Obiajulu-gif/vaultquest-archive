/**
 * Deterministic Stale-Session Invalidation (#846)
 *
 * Invalidates sessions, cached permissions, and old client assumptions
 * when security-sensitive events occur (password change, key rotation,
 * role change, recovery, logout-all).
 */

export type SecurityEvent =
  | 'password_changed'
  | 'key_rotated'
  | 'role_changed'
  | 'recovery_completed'
  | 'logout_all';

export interface SessionRecord {
  sessionId: string;
  userId: string;
  tokenVersion: number;
  createdAt: number;
  lastUsedAt: number;
  invalidatedAt?: number;
  invalidationReason?: SecurityEvent;
}

export interface InvalidateSessionsResult {
  invalidated: string[];
  kept: string[];
}

/**
 * SessionManager handles token versioning and deterministic session
 * invalidation based on security events.
 */
export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private tokenVersions = new Map<string, number>();

  /**
   * Register a new session. Token version is captured at creation.
   */
  createSession(userId: string): SessionRecord {
    const version = this.tokenVersions.get(userId) ?? 0;
    const session: SessionRecord = {
      sessionId: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      tokenVersion: version,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Validate a session. Returns false if the session is invalidated or
   * its token version is stale.
   */
  validateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.invalidatedAt) return false;
    if (session.tokenVersion !== (this.tokenVersions.get(session.userId) ?? 0)) {
      return false;
    }
    session.lastUsedAt = Date.now();
    return true;
  }

  /**
   * Invalidate sessions based on a security event.
   *
   * - password_changed / key_rotated / recovery_completed: invalidates ALL
   *   sessions for the user (token version bump)
   * - role_changed: invalidates sessions with stale permission assumptions
   * - logout_all: invalidates all sessions for the user
   */
  invalidateOnSecurityEvent(
    userId: string,
    event: SecurityEvent
  ): InvalidateSessionsResult {
    const currentVersion = this.tokenVersions.get(userId) ?? 0;
    const newVersion = currentVersion + 1;
    this.tokenVersions.set(userId, newVersion);

    const invalidated: string[] = [];
    const kept: string[] = [];

    for (const session of this.sessions.values()) {
      if (session.userId !== userId) continue;
      if (session.invalidatedAt) continue;

      // All security events invalidate active sessions for the user.
      // role_changed also bumps token version to invalidate stale clients.
      session.invalidatedAt = Date.now();
      session.invalidationReason = event;
      invalidated.push(session.sessionId);
    }

    return { invalidated, kept };
  }

  /**
   * Invalidate a single session (e.g., explicit logout).
   */
  invalidateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.invalidatedAt) return false;
    session.invalidatedAt = Date.now();
    session.invalidationReason = 'logout_all';
    return true;
  }

  /**
   * Get the current token version for a user.
   */
  getTokenVersion(userId: string): number {
    return this.tokenVersions.get(userId) ?? 0;
  }

  /**
   * Get all active sessions for a user.
   */
  getActiveSessions(userId: string): SessionRecord[] {
    return [...this.sessions.values()].filter(
      s => s.userId === userId && !s.invalidatedAt
    );
  }

  /**
   * Get a session record by ID.
   */
  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }
}
