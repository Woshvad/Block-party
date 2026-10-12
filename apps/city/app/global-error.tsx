"use client";
import { useEffect } from "react";

// When even the root layout fails. This replaces the whole document, without
// globals.css, so it carries its own few styles.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const button = { border: 0, borderRadius: 14, padding: "13px 22px", fontSize: 16, fontWeight: 600, cursor: "pointer" } as const;
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 16, textAlign: "center", background: "#f3f1eb", color: "#202c2a", fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
        <title>Block Party</title>
        <h1 style={{ margin: 0, fontSize: 26 }}>Something went wrong</h1>
        <p style={{ margin: 0, color: "#63716b" }}>The city couldn't open. Try again in a moment.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...button, background: "#234b3f", color: "#fff" }} onClick={() => retry()}>
            Try again
          </button>
          <button style={{ ...button, background: "transparent", color: "#202c2a", border: "1px solid #20202026" }} onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
