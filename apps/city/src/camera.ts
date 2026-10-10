// Camera maths for the city board, kept pure so it can be tested without WebGL.

// The city board (see citygen.ts: 6 blocks of 9 plus 7 roads of 2 each way).
export const BOARD = { width: 68, depth: 68 } as const;

// A phone held upright sees far less width than a laptop. Widen the lens and
// pull back on tall screens so about `seeWidth` world units fit across, then
// let the player drag to see the rest (like a map).
export function fitCamera(aspect: number, seeWidth = 22, range: { min: number; max: number } = { min: 26, max: 60 }): { fov: number; distance: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const fov = a < 1 ? 50 : 36;
  const halfH = (fov * Math.PI) / 360;
  const halfW = Math.atan(Math.tan(halfH) * a);
  const distance = seeWidth / 2 / Math.tan(halfW);
  return { fov, distance: Math.min(Math.max(distance, range.min), range.max) };
}

// Keeps the camera's focus point on the board while dragging.
export function clampTarget(x: number, z: number, margin = 3): { x: number; z: number } {
  const hx = BOARD.width / 2 - margin;
  const hz = BOARD.depth / 2 - margin;
  return { x: Math.min(Math.max(x, -hx), hx), z: Math.min(Math.max(z, -hz), hz) };
}

// Shortens big headcounts for pins: 950, 1.2k, 12k.
export function shortCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  const k = n / 1000;
  return `${k < 10 ? Math.floor(k * 10) / 10 : Math.floor(k)}k`;
}
