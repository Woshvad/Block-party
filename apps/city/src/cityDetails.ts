import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SQUARE } from "./citygen";
import { ball, box, cyl, type Part } from "./geo";

// Additive dressing only. Landmark geometry, footprints, pins and routes stay
// owned by citygen/CityScape. Low furniture keeps those silhouettes readable.
export function cityDetails() {
  const parts: Part[] = [];
  const stone = "#b4ad9b", wood = "#8c6645", iron = "#394b48", leaf = "#5f8252";
  function planter(x: number, z: number, w = 1.2) {
    parts.push(box(x, 0.33, z, w, 0.3, 0.5, stone), box(x, 0.495, z, w - 0.12, 0.03, 0.38, "#544b37"));
    for (let k = 0; k < 4; k++) parts.push(ball(x - w * 0.32 + k * w * 0.21, 0.6, z, 0.19, leaf, 0.8, 6));
  }
  function bench(x: number, z: number) {
    for (let k = 0; k < 3; k++) parts.push(box(x, 0.52, z - 0.12 + k * 0.12, 1.2, 0.06, 0.09, wood));
    parts.push(box(x, 0.78, z - 0.22, 1.2, 0.22, 0.05, wood));
    for (const dx of [-0.45, 0.45]) parts.push(box(x + dx, 0.33, z, 0.06, 0.36, 0.38, iron), box(x + dx, 0.66, z - 0.23, 0.06, 0.46, 0.06, iron));
  }
  // The square's outer promenades, clear of the hall, mural, fountain and park.
  for (const side of [-1, 1]) for (const dz of [-7, 0, 7]) {
    const x = SQUARE.x + side * (SQUARE.w / 2 - 1.3), z = SQUARE.z + dz;
    planter(x, z - 1.5); bench(x, z);
    parts.push(cyl(x, 0.47, z + 1.15, 0.16, 0.14, 0.55, iron, 8));
  }
  // Shallow paving borders give Genesis Square a designed edge.
  for (const side of [-1, 1]) {
    parts.push(box(SQUARE.x + side * (SQUARE.w / 2 - 0.3), 0.167, SQUARE.z, 0.12, 0.012, SQUARE.d - 0.5, stone));
    parts.push(box(SQUARE.x, 0.167, SQUARE.z + side * (SQUARE.d / 2 - 0.3), SQUARE.w - 0.5, 0.012, 0.12, stone));
  }
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return geometry;
}
