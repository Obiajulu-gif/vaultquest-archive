"use client";
import { useState, useEffect, useCallback } from "react";

function formatExpiry(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function SessionCard({ session, onEnd }) {
  const [countdown, setCountdown] = useState(formatExpiry(session.expires_at));

  useEffect(() => {
    const t = setInterval(() => setCountdown(formatExpiry(session.expires_at)), 1000);
    return () => clearInterval(t);
  }, [session.expires_at]);

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-5 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-vault-muted uppercase tracking-wider mb-1">Session</p>
          <p className="font-mono text-sm text-white">{session.id}</p>
        </div>
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20 shrink-0">
          {session.state}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-vault-muted block text-xs">Target Wallet</span>
          <span className="font-mono text-gray-200 text-xs break-all">{session.target_wallet}</span>
        </div>
        <div>
          <span className="text-vault-muted block text-xs">Expires In</span>
          <span className={`font-semibold ${countdown === "Expired" ? "text-red-400" : "text-yellow-400"}`}>
            {countdown}
          </span>
        </div>
        <div className="col-span-2">
          <span className="text-vault-muted block text-xs">Reason</span>
          <span className="text-gray-300">{session.reason}</span>
        </div>
      </div>

      {session.allow_mutations && (
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-400">
          ⚠ Mutations allowed — destructive operations are not blocked for this session.
        </div>
      )}

      <button
        id={`imp-end-${session.id}`}
        onClick={() => onEnd(session.id)}
        className="w-full rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors text-sm px-3 py-2 font-medium"
      >
        End Session
      </button>
    </div>
  );
}

export default function ImpersonationPage() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    target_wallet: "",
    reason: "",
    ttl_minutes: "30",
    allow_mutations: false,
  });
  const [creating, setCreating] = useState(false);
  const [endNote, setEndNote] = useState({ id: null, reason: "" });

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/admin/impersonation");
      if (res.ok) setSessions(await res.json().then((d) => d.data));
    } catch { /* non-fatal */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const createSession = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/admin/impersonation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_wallet: form.target_wallet.trim(),
          reason: form.reason.trim(),
          ttl_ms: Math.min(parseInt(form.ttl_minutes) || 30, 240) * 60_000,
          allow_mutations: form.allow_mutations,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setForm({ target_wallet: "", reason: "", ttl_minutes: "30", allow_mutations: false });
      loadSessions();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }, [form, loadSessions]);

  const endSession = useCallback(async (id) => {
    const reason = endNote.id === id ? endNote.reason : "Ended by maintainer";
    try {
      const res = await fetch(`/admin/impersonation/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEndNote({ id: null, reason: "" });
      loadSessions();
    } catch (e) {
      setError(e.message);
    }
  }, [endNote, loadSessions]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-white to-indigo-300 bg-clip-text text-transparent">
            Maintainer Impersonation
          </h1>
          <p className="text-vault-muted mt-1">
            Reproduce user-reported issues safely. Sessions are time-limited, scoped, and fully audited.
          </p>
        </div>

        {/* Security callout */}
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4 space-y-1">
          <p className="font-semibold text-amber-400 text-sm">Security Notice</p>
          <ul className="text-xs text-amber-300/80 list-disc list-inside space-y-0.5">
            <li>Every session start, action, and end is written to the immutable audit trail.</li>
            <li>Dangerous mutations (withdraw, select_winner) are blocked unless explicitly enabled.</li>
            <li>Only one active session per maintainer is permitted.</li>
            <li>Sessions expire automatically after the configured TTL.</li>
          </ul>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Create Form */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-6 space-y-4">
          <h2 className="text-lg font-semibold">Start Impersonation Session</h2>

          <div className="space-y-3">
            <div>
              <label htmlFor="imp-target-wallet" className="block text-xs text-vault-muted mb-1">
                Target Wallet Address <span className="text-red-400">*</span>
              </label>
              <input
                id="imp-target-wallet"
                type="text"
                value={form.target_wallet}
                onChange={(e) => setForm((f) => ({ ...f, target_wallet: e.target.value }))}
                placeholder="G…"
                className="w-full rounded-lg bg-white/5 border border-white/15 px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label htmlFor="imp-reason" className="block text-xs text-vault-muted mb-1">
                Reason <span className="text-red-400">*</span> (min 10 chars)
              </label>
              <textarea
                id="imp-reason"
                rows={3}
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="Support ticket #… — user reports incorrect balance display"
                className="w-full rounded-lg bg-white/5 border border-white/15 px-3 py-2 text-sm text-white resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div className="flex gap-4 flex-wrap">
              <div>
                <label htmlFor="imp-ttl" className="block text-xs text-vault-muted mb-1">
                  TTL (minutes, max 240)
                </label>
                <input
                  id="imp-ttl"
                  type="number"
                  min={1}
                  max={240}
                  value={form.ttl_minutes}
                  onChange={(e) => setForm((f) => ({ ...f, ttl_minutes: e.target.value }))}
                  className="w-28 rounded-lg bg-white/5 border border-white/15 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    id="imp-allow-mutations"
                    type="checkbox"
                    checked={form.allow_mutations}
                    onChange={(e) => setForm((f) => ({ ...f, allow_mutations: e.target.checked }))}
                    className="w-4 h-4 rounded accent-orange-500"
                  />
                  <span className={form.allow_mutations ? "text-orange-400" : "text-gray-400"}>
                    Allow dangerous mutations
                  </span>
                </label>
              </div>
            </div>
          </div>

          <button
            id="imp-create-btn"
            onClick={createSession}
            disabled={
              creating ||
              form.target_wallet.trim().length === 0 ||
              form.reason.trim().length < 10
            }
            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-colors px-5 py-2.5 text-sm font-semibold"
          >
            {creating ? "Starting…" : "Start Session"}
          </button>
        </div>

        {/* Active Sessions */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Your Active Sessions</h2>
            <button id="imp-refresh-btn" onClick={loadSessions} className="vq-btn-ghost text-xs px-3 py-1.5">
              ↻ Refresh
            </button>
          </div>

          {loading ? (
            <p className="text-vault-muted text-sm">Loading…</p>
          ) : sessions.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/5 px-6 py-8 text-center text-vault-muted text-sm">
              No active impersonation sessions.
            </div>
          ) : (
            <div className="space-y-4">
              {sessions.map((s) => (
                <SessionCard key={s.id} session={s} onEnd={endSession} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
