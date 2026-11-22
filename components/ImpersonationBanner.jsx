"use client";
import { useEffect, useState } from "react";

/**
 * ImpersonationBanner (#791)
 *
 * Reads the `X-Impersonation-Active` response header injected by the backend
 * middleware and displays a persistent warning banner when the current session
 * is executing inside an impersonation context.
 *
 * The banner is sticky so it is always visible, and includes a link to end
 * the session immediately.
 */
export default function ImpersonationBanner() {
  const [active, setActive] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    // Patch fetch to intercept the X-Impersonation-Active header.
    const original = window.fetch;
    window.fetch = async (...args) => {
      const res = await original(...args);
      if (res.headers.get("x-impersonation-active") === "true") {
        setActive(true);
        // Best-effort: read session id from request headers if present.
        const init = args[1];
        if (init?.headers) {
          const headers = new Headers(init.headers);
          const id = headers.get("x-impersonation-session");
          if (id) setSessionId(id);
        }
      }
      return res;
    };
    return () => { window.fetch = original; };
  }, []);

  const endSession = async () => {
    if (!sessionId) return;
    setEnding(true);
    try {
      await fetch(`/admin/impersonation/${sessionId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Session ended from UI banner" }),
      });
      setActive(false);
    } finally {
      setEnding(false);
    }
  };

  if (!active) return null;

  return (
    <div
      id="impersonation-banner"
      className="fixed top-0 inset-x-0 z-[9999] flex items-center justify-between gap-4 px-4 py-2 bg-orange-600 text-white text-sm font-medium shadow-lg"
    >
      <span className="flex items-center gap-2">
        <span className="text-base">⚠</span>
        You are viewing as another user. All actions are audited.
      </span>
      {sessionId && (
        <button
          id="impersonation-banner-end"
          onClick={endSession}
          disabled={ending}
          className="shrink-0 rounded-md bg-white/20 hover:bg-white/30 transition-colors px-3 py-1 text-xs font-semibold disabled:opacity-60"
        >
          {ending ? "Ending…" : "End Session"}
        </button>
      )}
    </div>
  );
}
