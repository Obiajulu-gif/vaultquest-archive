/**
 * SessionManager tests (#846)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../services/sessionManager';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('creates and validates a session', () => {
    const session = manager.createSession('user-1');
    expect(manager.validateSession(session.sessionId)).toBe(true);
  });

  it('invalidates session on password change', () => {
    const session = manager.createSession('user-1');
    manager.invalidateOnSecurityEvent('user-1', 'password_changed');
    expect(manager.validateSession(session.sessionId)).toBe(false);
  });

  it('invalidates session on key rotation', () => {
    const session = manager.createSession('user-1');
    manager.invalidateOnSecurityEvent('user-1', 'key_rotated');
    expect(manager.validateSession(session.sessionId)).toBe(false);
  });

  it('invalidates session on role change', () => {
    const session = manager.createSession('user-1');
    manager.invalidateOnSecurityEvent('user-1', 'role_changed');
    expect(manager.validateSession(session.sessionId)).toBe(false);
  });

  it('invalidates session on recovery', () => {
    const session = manager.createSession('user-1');
    manager.invalidateOnSecurityEvent('user-1', 'recovery_completed');
    expect(manager.validateSession(session.sessionId)).toBe(false);
  });

  it('invalidates all sessions on logout_all', () => {
    manager.createSession('user-1');
    manager.createSession('user-1');
    const result = manager.invalidateOnSecurityEvent('user-1', 'logout_all');
    expect(result.invalidated).toHaveLength(2);
  });

  it('does not affect other users sessions', () => {
    const s1 = manager.createSession('user-1');
    const s2 = manager.createSession('user-2');
    manager.invalidateOnSecurityEvent('user-1', 'password_changed');
    expect(manager.validateSession(s1.sessionId)).toBe(false);
    expect(manager.validateSession(s2.sessionId)).toBe(true);
  });

  it('rejects stale tokens after version bump', () => {
    const session = manager.createSession('user-1');
    manager.invalidateOnSecurityEvent('user-1', 'password_changed');
    // New session has higher version
    const newSession = manager.createSession('user-1');
    expect(manager.validateSession(newSession.sessionId)).toBe(true);
    // Old session is invalidated
    expect(manager.validateSession(session.sessionId)).toBe(false);
  });

  it('returns active sessions for a user', () => {
    manager.createSession('user-1');
    manager.createSession('user-1');
    manager.createSession('user-2');
    expect(manager.getActiveSessions('user-1')).toHaveLength(2);
    expect(manager.getActiveSessions('user-2')).toHaveLength(1);
  });
});
