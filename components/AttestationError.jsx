"use client";

export default function AttestationError({ mismatches }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
        color: "#ff4444",
        fontFamily: "monospace",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: 600, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
          Deployment Configuration Mismatch
        </h1>
        <p style={{ color: "#888", marginBottom: "1.5rem" }}>
          The application cannot start because the deployment manifest does not
          match the current environment configuration.
        </p>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            textAlign: "left",
            fontSize: "0.85rem",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #333" }}>
              <th style={{ padding: "0.5rem" }}>Field</th>
              <th style={{ padding: "0.5rem" }}>Manifest</th>
              <th style={{ padding: "0.5rem" }}>Environment</th>
            </tr>
          </thead>
          <tbody>
            {mismatches.map((m, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #222" }}>
                <td style={{ padding: "0.5rem" }}>{m.field}</td>
                <td style={{ padding: "0.5rem", color: "#4ade80" }}>
                  {m.manifestValue}
                </td>
                <td style={{ padding: "0.5rem", color: "#f87171" }}>
                  {m.envValue}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ color: "#666", marginTop: "1.5rem", fontSize: "0.8rem" }}>
          Fix your .env.local to match the deployment manifest, or regenerate
          the manifest with <code>pnpm generate:manifest</code>.
        </p>
      </div>
    </div>
  );
}
