import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { type Part, box, ball, cyl, darker } from "./geo";

// Recognisable furniture inside the same placement footprint. Each item is
// merged into one mesh, including cushions, legs and small surface details.
export function furnitureGeometry(id: string, w: number, h: number, d: number, color: string) {
  const parts: Part[] = [];
  const wood = "#785841", linen = "#f0e7d7", metal = "#414c49";
  const b = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c = color) => parts.push(box(x, y, z, sx, sy, sz, c));
  const legs = (top: number) => {
    for (const x of [-w * 0.38, w * 0.38]) for (const z of [-d * 0.36, d * 0.36]) b(x, top / 2, z, w * 0.055, top, d * 0.055, wood);
  };
  if (/rug/.test(id)) {
    b(0, h / 2, 0, w, h, d, darker(color, 0.75));
    b(0, h, 0, w * 0.88, 0.002, d * 0.88);
  } else if (/bed|hammock/.test(id)) {
    legs(h * 0.28);
    b(0, h * 0.36, 0, w, h * 0.24, d, wood);
    b(0, h * 0.63, 0, w * 0.94, h * 0.3, d * 0.96, linen);
    b(0, h * 0.81, d * 0.12, w * 0.95, h * 0.07, d * 0.68);
    b(0, h * 0.89, -d * 0.33, w * 0.75, h * 0.18, d * 0.2, linen);
    b(0, h * 0.56, -d * 0.46, w, h * 0.88, d * 0.08, wood);
  } else if (/sofa|couch|beanbag/.test(id)) {
    legs(h * 0.18);
    b(0, h * 0.3, 0, w, h * 0.3, d, darker(color, 0.8));
    b(0, h * 0.68, -d * 0.38, w, h * 0.64, d * 0.24);
    for (const x of [-w * 0.45, w * 0.45]) b(x, h * 0.48, 0, w * 0.1, h * 0.6, d);
    const n = Math.max(1, Math.round(w));
    for (let i = 0; i < n; i++) b(-w * 0.39 + w * 0.78 * (i + 0.5) / n, h * 0.5, d * 0.07, w * 0.76 / n, h * 0.18, d * 0.65);
  } else if (/desk|table|stool|counter/.test(id)) {
    legs(h * 0.9);
    b(0, h * 0.95, 0, w, h * 0.1, d);
    if (/desk/.test(id)) {
      b(-w * 0.22, h * 0.58, -d * 0.02, w * 0.28, h * 0.46, d * 0.78, darker(color, 0.8));
      b(-w * 0.22, h * 0.62, d * 0.38, w * 0.12, 0.025, 0.025, metal);
    }
  } else if (/plant|cactus|monstera/.test(id)) {
    const radius = Math.min(w, d) * 0.26;
    parts.push(cyl(0, h * 0.18, 0, radius, radius * 0.7, h * 0.36, "#b77b57", 12));
    parts.push(cyl(0, h * 0.45, 0, 0.025, 0.03, h * 0.5, wood, 6));
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 0.4;
      parts.push(ball(Math.cos(a) * w * 0.16, h * (0.58 + i % 2 * 0.08), Math.sin(a) * d * 0.16, Math.min(w, d, h) * 0.23, i % 2 ? darker(color, 0.75) : color, 1.2));
    }
  } else if (/lamp/.test(id)) {
    const radius = Math.min(w, d) * 0.3;
    parts.push(cyl(0, h * 0.03, 0, radius, radius, h * 0.06, metal, 12));
    parts.push(cyl(0, h * 0.43, 0, 0.025, 0.035, h * 0.8, metal, 8));
    parts.push(cyl(0, h * 0.85, 0, radius * 0.65, radius, h * 0.3, linen, 16));
  } else if (/tv|crt|aquarium/.test(id)) {
    legs(h * 0.2);
    b(0, h * 0.25, 0, w, h * 0.16, d, wood);
    b(0, h * 0.66, -d * 0.14, w * 0.92, h * 0.68, d * 0.4, metal);
    b(0, h * 0.66, d * 0.068, w * 0.8, h * 0.52, d * 0.015, "#659a99");
  } else b(0, h / 2, 0, w, h, d);
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged.translate(0, -h / 2, 0);
}
