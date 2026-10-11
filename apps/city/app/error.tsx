"use client";
import { useEffect } from "react";

// The last line of defence for the city: anything that throws outside a 3D
// view (each of those has its own SceneBoundary) lands here instead of on a
// blank "Application error" page.
export default function CityError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="screen center">
      <h1>Something went wrong</h1>
      <p className="muted">The city hit a problem it couldn't get past on its own.</p>
      <div className="btnrow">
        <button className="cta" onClick={() => retry()}>
          Try again
        </button>
        <button className="ghost" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
