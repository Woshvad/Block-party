"use client";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { meterText } from "./perfMeter";

// The meter shows on the room test, or anywhere with ?perf in the address.
export const SHOW_PERF = typeof location !== "undefined" && (/[?&]perf\b/.test(location.search) || location.pathname === "/room-test");

// Frame rate, draw calls, triangles, what the GPU holds and JS memory,
// written straight to a DOM node (no React re-render per frame). Lives
// inside the Canvas. `quality` is the tier the view runs at (quality.ts).
export function PerfProbe({ target, quality }: { target: React.RefObject<HTMLDivElement | null>; quality?: string }) {
  const gl = useThree((s) => s.gl);
  const state = useThree();
  // Development only: lets tooling step frames by hand when the tab is hidden.
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") (window as unknown as { __city?: unknown }).__city = state;
  // three.js clears its counters after drawing the shadow maps, so on its own
  // it reports the main pass only. Here they're cleared once a frame instead,
  // before anything is drawn, so the count is the whole of the last frame.
  useEffect(() => {
    const before = gl.info.autoReset;
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = before;
    };
  }, [gl]);
  const frames = useRef<number[]>([]);
  useFrame(() => {
    const now = performance.now();
    const f = frames.current;
    f.push(now);
    while (f.length && now - f[0]! > 1000) f.shift(); // loop-bound: drops at most the frames older than a second
    const { calls, triangles } = gl.info.render;
    gl.info.reset();
    if (!target.current || f.length % 10) return;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    target.current.textContent = meterText({
      fps: f.length,
      calls,
      triangles,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      programs: gl.info.programs?.length ?? 0,
      ...(mem ? { heapMb: Math.round(mem.usedJSHeapSize / 1048576) } : {}),
      ...(quality ? { quality } : {}),
    });
  });
  return null;
}
