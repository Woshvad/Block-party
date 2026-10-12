// The ?perf meter's text. PerfHud.tsx reads the numbers off the renderer.
export type PerfSample = {
  fps: number;
  calls: number; // every draw in the frame, the shadow pass included
  triangles: number;
  geometries: number; // held on the GPU right now
  textures: number; // held on the GPU right now
  programs: number; // compiled shader programs
  heapMb?: number; // Chromium only
  quality?: string; // the tier the view runs at (quality.ts)
};

export function meterText(s: PerfSample): string {
  const lines = [
    `${s.fps} fps`,
    `${s.calls} draw calls (all passes)`,
    `${(s.triangles / 1000).toFixed(1)}k triangles`,
    `${s.geometries} geometries · ${s.textures} textures`,
    `${s.programs} shader programs`,
  ];
  if (s.heapMb !== undefined) lines.push(`${s.heapMb} MB js heap`);
  if (s.quality) lines.push(`${s.quality} quality`);
  return lines.join("\n");
}
