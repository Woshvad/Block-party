import { CITY_SIZE } from "./citygen";

// Camera maths for the city board, kept pure so it can be tested without WebGL.

// The city board: the whole plan (see citygen.ts).
export const BOARD = { width: CITY_SIZE, depth: CITY_SIZE } as const;

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

// --- The board's isometric view ----------------------------------------------

// The board camera looks along this direction (from the camera's target up
// to the camera), at a fixed angle: no orbiting, like SimCity.
export const ISO = { x: 1, y: 0.85, z: 1 } as const;

// Zoom is pixels per world unit. Pins show their names from `names` up (on a
// phone too), and the district badges step back from `near` (globals.css
// styles each level through [data-zoom]).
export const ZOOM = { min: 8, max: 90, names: 13, near: 30 } as const;
export type ZoomLevel = "far" | "mid" | "near";
export const zoomLevel = (zoom: number): ZoomLevel => (zoom < ZOOM.names ? "far" : zoom < ZOOM.near ? "mid" : "near");

// The zoom the board opens (and recentres) at: about 30 tiles across a phone
// held upright, but never so far out that the pins lose their names; about 65
// across a laptop.
export function startZoom(width: number, height: number): number {
  return width < height ? Math.max(ZOOM.names, width / 30) : width / 65;
}

type Point = { x: number; y: number; z: number };

// Where world point `b` lands on screen relative to `a`, in pixels at `zoom`:
// dx to the right, dy up. The view is orthographic, so this is exact.
export function screenOffset(a: Point, b: Point, zoom: number): { dx: number; dy: number } {
  const n = Math.hypot(ISO.x, ISO.y, ISO.z);
  const f = { x: -ISO.x / n, y: -ISO.y / n, z: -ISO.z / n }; // looking direction
  const r = { x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 }; // screen right: f × up, normalised
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x }; // screen up: r × f
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  return { dx: (d.x * r.x + d.y * r.y + d.z * r.z) * zoom, dy: (d.x * u.x + d.y * u.y + d.z * u.z) * zoom };
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
