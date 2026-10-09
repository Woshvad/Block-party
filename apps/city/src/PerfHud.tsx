"use client";
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";

// Frame rate, draw calls, triangles and JS memory, written straight to a DOM
// node (no React re-render per frame). Lives inside the Canvas.
export function PerfProbe({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  const gl = useThree((s) => s.gl);
  const state = useThree();
  // Development only: lets tooling step frames by hand when the tab is hidden.
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") (window as unknown as { __city?: unknown }).__city = state;
  const frames = useRef<number[]>([]);
  useFrame(() => {
    const now = performance.now();
    const f = frames.current;
    f.push(now);
    while (f.length && now - f[0]! > 1000) f.shift(); // loop-bound: drops at most the frames older than a second
    if (!target.current || f.length % 10) return;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const r = gl.info.render;
    target.current.textContent = `${f.length} fps\n${r.calls} draw calls\n${(r.triangles / 1000).toFixed(1)}k triangles${mem ? `\n${Math.round(mem.usedJSHeapSize / 1048576)} MB js heap` : ""}`;
  });
  return null;
}
