import * as THREE from "three";

// Shape helpers for merged, vertex-coloured scenery (one draw call for a whole
// interior or the whole city). Every part comes out non-indexed with
// position, normal and color, so any set of them merges.

export type Part = THREE.BufferGeometry;

export function colored(g: THREE.BufferGeometry, hex: string): Part {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (!["position", "normal"].includes(k)) n.deleteAttribute(k);
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n.getAttribute("position").count * 3);
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = c.r;
    arr[i + 1] = c.g;
    arr[i + 2] = c.b;
  }
  n.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return n;
}
export const box = (x: number, y: number, z: number, w: number, h: number, d: number, c: string) => colored(new THREE.BoxGeometry(w, h, d).translate(x, y, z), c);
export const cyl = (x: number, y: number, z: number, rt: number, rb: number, h: number, c: string, seg = 10) => colored(new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z), c);
export const ball = (x: number, y: number, z: number, r: number, c: string, sy = 1, seg = 10) => colored(new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.7))).scale(1, sy, 1).translate(x, y, z), c);
// A pitched roof: a triangular prism along x, turned by yaw.
export const prism = (x: number, y: number, z: number, w: number, h: number, d: number, c: string, yaw = 0) => {
  const s = new THREE.Shape();
  s.moveTo(-d / 2, 0);
  s.lineTo(d / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false }).translate(0, 0, -w / 2).rotateY(Math.PI / 2 + yaw).translate(x, y, z);
  return colored(g, c);
};
export const darker = (hex: string, f = 0.7) => `#${new THREE.Color(hex).multiplyScalar(f).getHexString()}`;
