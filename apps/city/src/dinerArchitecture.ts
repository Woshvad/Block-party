import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { DINER_BLOCK, LANDMARKS, blockRect, fillBlock, type Lot } from "./citygen";
import { ball, box, colored, cyl, type Part } from "./geo";

export const DINER_QUARTER = blockRect(DINER_BLOCK.bx, DINER_BLOCK.bz);
export function isDinerShop(lot: Lot) {
  return lot.kind === "shop" && Math.abs(lot.x - DINER_QUARTER.x) < 5 && Math.abs(lot.z - DINER_QUARTER.z) < 5;
}

// Hand-built architecture on the existing five filler lots. The landmark and
// the road/sidewalk plan never move. All detail is merged into four materials.
export function buildDinerQuarter() {
  const stone: Part[] = [], glass: Part[] = [], metal: Part[] = [], fabric: Part[] = [];
  const palettes = ["#b56f50", "#e3d7be", "#73938b", "#c59673", "#bfc4ad"];
  const shops = fillBlock(DINER_BLOCK.bx, DINER_BLOCK.bz).filter(isDinerShop);
  shops.forEach((shop, i) => {
    if (shop.kind !== "shop") return;
    const { x, z } = shop, w = 2.12, d = 1.88, h = [3.25, 2.4, 2.65, 3.45, 2.85][i]!;
    const c = palettes[i]!;
    stone.push(box(x, 0.16 + h / 2, z, w, h, d, c));
    // Foundation, cornice, recessed roof and parapet caps.
    stone.push(box(x, 0.3, z, w + 0.08, 0.28, d + 0.08, "#b4ad9b"), box(x, h + 0.13, z, w + 0.18, 0.12, d + 0.18, "#e5dccb"));
    metal.push(box(x, h + 0.21, z, w - 0.14, 0.08, d - 0.14, "#53635f"));
    for (const side of [-1, 1]) {
      stone.push(box(x, h + 0.31, z + side * (d / 2), w + 0.12, 0.23, 0.1, "#d8cdb7"), box(x + side * (w / 2), h + 0.31, z, 0.1, 0.23, d, "#d8cdb7"));
      // Both street and courtyard facades are finished, not blank backs.
      const fz = z + side * (d / 2 + 0.012);
      glass.push(box(x, 0.91, fz, 1.7, 1.1, 0.025, "#577c7f"));
      for (const dx of [-0.86, -0.32, 0.36, 0.86]) stone.push(box(x + dx, 0.91, fz + side * 0.025, 0.055, 1.13, 0.065, "#e6dcca"));
      metal.push(box(x - 0.17, 0.79, fz + side * 0.065, 0.025, 0.18, 0.025, "#d6bf92"));
      stone.push(box(x, 1.65, fz + side * 0.07, 1.96, 0.26, 0.1, i % 2 ? "#344c47" : "#633f35"));
      // Canvas awning with alternating woven stripes and a hanging valance.
      for (let k = 0; k < 8; k++) {
        const color = k % 2 ? "#e7dfc8" : i % 2 ? "#476b61" : "#aa5d46";
        const awning = box(x - 0.84 + k * 0.24, 1.48, fz + side * 0.2, 0.24, 0.05, 0.48, color);
        fabric.push(awning, box(x - 0.84 + k * 0.24, 1.39, fz + side * 0.42, 0.24, 0.14, 0.035, color));
      }
      for (let y = 2.16; y < h - 0.25; y += 0.9) for (const dx of [-0.59, 0.59]) {
        stone.push(box(x + dx, y, fz, 0.68, 0.76, 0.075, "#e4d9c4"));
        glass.push(box(x + dx, y + 0.01, fz + side * 0.045, 0.49, 0.59, 0.02, "#62868a"));
        stone.push(box(x + dx, y, fz + side * 0.065, 0.035, 0.62, 0.03, "#cfc7b7"), box(x + dx, y - 0.39, fz + side * 0.085, 0.78, 0.075, 0.2, "#d1c5ae"));
      }
      // Horizontal mortar courses and corner quoins catch the afternoon light.
      for (let y = 1.95; y < h; y += 0.28) stone.push(box(x, y, fz, w - 0.08, 0.014, 0.028, i % 2 ? "#aab2a1" : "#a86f53"));
      for (const dx of [-w / 2 + 0.1, w / 2 - 0.1]) for (let y = 1.9; y < h; y += 0.34) stone.push(box(x + dx, y, fz + side * 0.025, 0.19, 0.19, 0.1, "#d7c9ad"));
    }
    // Side windows, a chimney, roof plant and a screened service unit.
    for (const side of [-1, 1]) for (let y = 2.1; y < h; y += 0.9) {
      glass.push(box(x + side * (w / 2 + 0.012), y, z, 0.025, 0.54, 0.58, "#55767a"));
      stone.push(box(x + side * (w / 2 + 0.05), y - 0.3, z, 0.15, 0.06, 0.74, "#d7c9ad"));
    }
    stone.push(box(x - 0.65, h + 0.5, z - 0.55, 0.3, 0.65, 0.32, c), box(x - 0.65, h + 0.85, z - 0.55, 0.38, 0.08, 0.4, "#e0d4be"));
    metal.push(box(x + 0.43, h + 0.42, z + 0.18, 0.55, 0.35, 0.44, "#9caaa6"));
    for (let k = 0; k < 4; k++) metal.push(box(x + 0.43, h + 0.32 + k * 0.055, z + 0.415, 0.42, 0.019, 0.018, "#52605a"));
  });
  const D = LANDMARKS.diner;
  // Same capsule dimensions, red stripe and pole sign, with a chrome shell.
  metal.push(colored(new THREE.CylinderGeometry(0.956, 0.956, 2.79, 32).rotateZ(Math.PI / 2).translate(D.x, 0.95, D.z), "#bac8c7"));
  for (const dx of [-1.28, -0.66, 0, 0.66, 1.28]) metal.push(colored(new THREE.TorusGeometry(0.964, 0.015, 4, 32).rotateY(Math.PI / 2).translate(D.x + dx, 0.95, D.z), "#e4dfd1"));
  // Red belt sits outside the polished shell; the recognisable silhouette stays.
  stone.push(box(D.x, 0.75, D.z, 2.84, 0.22, 1.94, "#b9473e"));
  stone.push(box(D.x, 0.18, D.z + 1.35, 3.05, 0.05, 0.72, "#ddd1b9"));
  for (let k = 0; k < 12; k++) for (let j = 0; j < 3; j++) if ((k + j) % 2) stone.push(box(D.x - 1.4 + k * 0.255, 0.209, D.z + 1.1 + j * 0.22, 0.25, 0.012, 0.21, "#69756c"));
  glass.push(box(D.x - 1.05, 0.67, D.z + 0.95, 0.34, 0.92, 0.04, "#3b656c"));
  metal.push(box(D.x - 0.96, 0.67, D.z + 0.99, 0.025, 0.15, 0.025, "#dfd4b6"));
  for (let k = -1; k <= 1; k++) {
    for (const dy of [-0.23, 0.23]) metal.push(box(D.x + k * 0.85, 1.25 + dy, D.z + 0.96, 0.63, 0.035, 0.04, "#e5ddcd"));
    for (const dx of [-0.3, 0.3]) metal.push(box(D.x + k * 0.85 + dx, 1.25, D.z + 0.96, 0.035, 0.48, 0.04, "#e5ddcd"));
  }
  stone.push(box(D.x + 1.8, 3.29, D.z + 0.87, 1.95, 0.65, 0.075, "#344f4e"));
  metal.push(cyl(D.x + 0.8, 1.99, D.z - 0.15, 0.09, 0.12, 0.3, "#a6b5b4", 10));
  // Two pavement tables, stools, cups and planted corners.
  for (const dx of [-0.4, 0.8]) {
    const x = D.x + dx, z = D.z + 1.43;
    stone.push(cyl(x, 0.63, z, 0.23, 0.23, 0.06, "#e5d4b4", 16), cyl(x + 0.06, 0.71, z, 0.034, 0.03, 0.07, "#f2ead9", 8));
    metal.push(cyl(x, 0.41, z, 0.035, 0.035, 0.4, "#435954", 6));
    for (const sx of [-0.35, 0.35]) {
      fabric.push(cyl(x + sx, 0.38, z, 0.12, 0.12, 0.07, "#af5947", 10));
      metal.push(cyl(x + sx, 0.27, z, 0.025, 0.04, 0.2, "#435954", 6));
    }
  }
  // Courtyard pocket garden: existing trees remain around a modest timber deck.
  const b = DINER_QUARTER;
  stone.push(box(b.x - 2.7, 0.19, b.z, 1.9, 0.06, 1.8, "#a58a64"));
  for (let k = 0; k < 10; k++) stone.push(box(b.x - 3.54 + k * 0.185, 0.226, b.z, 0.012, 0.012, 1.78, "#786951"));
  for (const x of [b.x - 3.4, b.x - 2]) {
    stone.push(box(x, 0.4, b.z + 0.7, 0.42, 0.35, 0.4, "#b59472"));
    fabric.push(ball(x, 0.68, b.z + 0.7, 0.3, "#6e8b56", 0.85, 8));
  }
  const merge = (parts: Part[]) => { const g = mergeGeometries(parts, false)!; parts.forEach((p) => p.dispose()); return g; };
  return { stone: merge(stone), glass: merge(glass), metal: merge(metal), fabric: merge(fabric) };
}


export const QUARTER_SIGNS = ["BREAD & BUTTER", "CORNER COFFEE", "SUNDAY RECORDS", "THE FLOWER SHOP", "NEIGHBOURHOOD GOODS"];
export function buildQuarterSigns() {
  const parts: THREE.BufferGeometry[] = [];
  fillBlock(DINER_BLOCK.bx, DINER_BLOCK.bz).filter(isDinerShop).forEach((shop, i) => {
    for (const side of [-1, 1]) {
      const g = new THREE.PlaneGeometry(1.8, 0.2).rotateY(side < 0 ? Math.PI : 0).translate(shop.x, 1.65, shop.z + side * 1.09);
      const uv = g.getAttribute("uv");
      for (let k = 0; k < uv.count; k++) uv.setY(k, (4 - i + uv.getY(k)) / 5);
      parts.push(g);
    }
  });
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  return merged;
}
