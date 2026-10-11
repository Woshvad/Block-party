"use client";
import { useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import DinerQuarter from "./DinerQuarter";
import { isDinerShop } from "./dinerArchitecture";
import CityWater from "./CityWater";
import CityStreetGlow from "./CityStreetGlow";
import { citySurface } from "./citySurface";
import { cityDetails } from "./cityDetails";
import { CITY_SIZE, GRID, LANDMARKS, type Lot, SOON, SQUARE, blockRect, districtOf, fillCity, roads, zoneOf } from "./citygen";
import Kit, { useBaked } from "./Kit";
import { KIT, cityPlacements } from "./kitcity";
import { type Car, type Lane, type Light, carPose, lightFor, makeTraffic, stepTraffic } from "./traffic";
import { type Part, ball, box, colored, cyl, darker, prism } from "./geo";

// The city board, SimCity style: asphalt roads with lane markings and
// crosswalks, raised sidewalks, zoned blocks full of houses, shops and
// offices, parks and the lagoon, our landmarks on their own blocks, street
// lights, and traffic. Everything static is merged into a handful of meshes:
// the textured stone city, its windows (they glow at
// night) and the street-light heads.

const ASPHALT = "#3d4148";
const SIDEWALK = "#d6d1c4";
const GRASS = "#91aa76";
const PAVING = "#e6dccb";
const WHITE = "#f4f1ea";
const YELLOW = "#f2c94c";

type Built = { city: Part[]; windows: Part[]; lamps: Part[]; neon: Part[] };
const inSquare = (x: number, z: number, pad = 0) => Math.abs(x - SQUARE.x) < SQUARE.w / 2 + pad && Math.abs(z - SQUARE.z) < SQUARE.d / 2 + pad;
const front = (yaw: number) => ({ fx: Math.sin(yaw), fz: Math.cos(yaw) });

// --- The street grid --------------------------------------------------------------

function streets(b: Built) {
  const half = CITY_SIZE / 2;
  const rs = roads();
  for (const r of rs) {
    if (r.along === "x") b.city.push(box(0, 0.02, r.a, CITY_SIZE, 0.04, GRID.road, ASPHALT));
    else b.city.push(box(r.a, 0.021, 0, GRID.road, 0.04, CITY_SIZE, ASPHALT));
    // Dashed centre line, broken at the junctions and inside the square.
    for (let s = -half + 0.6; s < half; s += 1.2) {
      const nearJunction = rs.some((o) => o.along !== r.along && Math.abs(o.a - s) < GRID.road * 0.9);
      const [x, z] = r.along === "x" ? [s, r.a] : [r.a, s];
      if (nearJunction || inSquare(x, z)) continue;
      b.city.push(r.along === "x" ? box(x, 0.045, z, 0.6, 0.01, 0.07, YELLOW) : box(x, 0.046, z, 0.07, 0.01, 0.6, YELLOW));
    }
  }
  // Crosswalks on every arm of every junction outside the square.
  for (const a of rs.filter((r) => r.along === "z"))
    for (const c of rs.filter((r) => r.along === "x")) {
      if (inSquare(a.a, c.a, 0.5)) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const cx = a.a + dx * (GRID.road * 0.5 + 0.35);
        const cz = c.a + dz * (GRID.road * 0.5 + 0.35);
        if (Math.abs(cx) > half - 0.2 || Math.abs(cz) > half - 0.2) continue;
        for (let k = -2; k <= 2; k++) b.city.push(dx ? box(cx, 0.047, cz + k * 0.35, 0.5, 0.01, 0.18, WHITE) : box(cx + k * 0.35, 0.047, cz, 0.18, 0.01, 0.5, WHITE));
      }
      // A street light on the junction's corner.
      const lx = a.a + GRID.road * 0.5 + 0.25;
      const lz = c.a + GRID.road * 0.5 + 0.25;
      if (Math.abs(lx) < half && Math.abs(lz) < half && !inSquare(lx, lz)) {
        b.city.push(cyl(lx, 1.2, lz, 0.05, 0.07, 2.4, "#3a3d44", 6), box(lx - 0.3, 2.38, lz - 0.3, 0.6, 0.06, 0.06, "#3a3d44"));
        b.lamps.push(box(lx - 0.55, 2.3, lz - 0.55, 0.28, 0.1, 0.28, "#fff2b8"));
      }
    }
}

// Raised sidewalks and the ground of each block by zone.
function blocks(b: Built) {
  const lagoon = blockRect(0, GRID.blocks - 1);
  for (let bx = 0; bx < GRID.blocks; bx++)
    for (let bz = 0; bz < GRID.blocks; bz++) {
      const r = blockRect(bx, bz);
      const zone = zoneOf(bx, bz);
      if (zone === "square" || zone === "water") continue;
      b.city.push(box(r.x, 0.07, r.z, r.w + 0.5, 0.14, r.d + 0.5, SIDEWALK));
      if (zone === "locked") {
        // Block 5, the Stablecoin Strip: an island behind a fence until the crowd unlocks it.
        b.city.push(box(r.x, 0.15, r.z, r.w - 0.2, 0.04, r.d - 0.2, "#c9c2b0"));
        for (let k = 0; k < 18; k++) {
          const t = (k / 18) * 4;
          const side = Math.floor(t);
          const f = t - side;
          const h = r.w / 2 - 0.3;
          const [px, pz] = side === 0 ? [-h + 2 * h * f, -h] : side === 1 ? [h, -h + 2 * h * f] : side === 2 ? [h - 2 * h * f, h] : [-h, h - 2 * h * f];
          b.city.push(box(r.x + px, 0.55, r.z + pz, 0.08, 0.8, 0.08, "#8a8f98"));
        }
        b.city.push(box(r.x, 0.8, r.z - r.w / 2 + 0.3, r.w - 0.6, 0.05, 0.03, "#f2c94c"), box(r.x, 0.5, r.z - r.w / 2 + 0.3, r.w - 0.6, 0.05, 0.03, "#2c2c2a"));
        // A blank sign board over the fence. It shows no progress: no real
        // number drives the unlock yet, and the board never invents one.
        b.city.push(box(r.x, 1.9, r.z, 5.2, 0.5, 0.25, "#2c2c2a"));
        continue;
      }
      const ground = zone === "commercial" || zone === "office" ? PAVING : zone === "landmark" ? "#a9d28c" : zone === "industrial" ? "#b9b4a8" : GRASS;
      b.city.push(box(r.x, 0.15, r.z, r.w - 0.2, 0.04, r.d - 0.2, ground));
    }
  // The Mempool Lagoon: one stretch of water along the south, with quays and reeds.
  b.city.push(box(0, 0.04, lagoon.z, CITY_SIZE - 0.2, 0.06, lagoon.d + GRID.road * 0.9, "#4f9bd0"), box(0, 0.06, lagoon.z, CITY_SIZE - 0.6, 0.02, lagoon.d, "#5aa9d6"));
  b.city.push(box(0, 0.1, lagoon.z - lagoon.d / 2 - 0.05, CITY_SIZE, 0.2, 0.15, "#b8b2a5"));
  for (let k = 0; k < 14; k++) b.city.push(ball(-CITY_SIZE / 2 + 3 + k * 4.4, 0.25, lagoon.z + lagoon.d / 2 - 0.6, 0.35, "#5aa05a", 0.7, 6));
  // The Rollup: a pier and a shelter where the bus batches its riders.
  const R = SOON.rollup;
  b.city.push(box(R.x, 0.22, R.z + 1.4, 1.6, 0.1, 3.6, "#8a5a2b"));
  for (const dx of [-0.7, 0.7]) for (const dz of [0, 1.4, 2.8]) b.city.push(cyl(R.x + dx, 0.1, R.z + dz, 0.07, 0.07, 0.5, "#6b4423", 6));
  b.city.push(box(R.x, 1.1, R.z, 2.2, 0.08, 0.9, "#378add"), box(R.x - 1, 0.6, R.z - 0.35, 0.06, 1, 0.06, "#3a3d44"), box(R.x + 1, 0.6, R.z - 0.35, 0.06, 1, 0.06, "#3a3d44"), box(R.x, 0.35, R.z - 0.2, 1.8, 0.06, 0.35, "#8a5a2b"));

  // Genesis Square: the plaza at the heart of the city, City Hall at its head.
  b.city.push(box(SQUARE.x, 0.08, SQUARE.z, SQUARE.w + 0.5, 0.16, SQUARE.d + 0.5, PAVING));
  b.city.push(cyl(SQUARE.x, 0.17, SQUARE.z + 0.5, 5.5, 5.5, 0.02, "#d9cdb8", 32), cyl(SQUARE.x, 0.18, SQUARE.z + 0.5, 4, 4, 0.02, PAVING, 32));
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2;
    const x = SQUARE.x + Math.cos(a) * 9.3;
    const z = SQUARE.z + Math.sin(a) * 9.3;
    if (z < SQUARE.z - 2 && Math.abs(x - SQUARE.x) < 5) continue; // City Hall stands there
    tree(b, x, z, 0.8);
  }
  // Touch Grass Park (opens at launch): a lawn at the square's south edge.
  const P = SOON.touch_grass_park;
  b.city.push(box(P.x, 0.18, P.z, 7, 0.04, 3.4, GRASS));
  for (const [dx, dz] of [[-2.8, -0.9], [-1.6, 1], [2.6, 0.8], [3, -1], [0.4, 1.2]] as const) tree(b, P.x + dx, P.z + dz, 0.7);
  // Bus shelters on the square's edges.
  for (const [x, z, yaw] of [[SQUARE.x + 4, SQUARE.z + SQUARE.d / 2 + 0.05, 0], [SQUARE.x - SQUARE.w / 2 - 0.05, SQUARE.z - 4, Math.PI / 2]] as const) {
    const along = yaw === 0;
    b.city.push(box(x, 1.05, z, along ? 1.6 : 0.06, 0.06, along ? 0.06 : 1.6, "#3a3d44"), box(x, 1.08, z + (along ? -0.25 : 0), along ? 1.7 : 0.6, 0.05, along ? 0.6 : 1.7, "#378add"));
    b.city.push(box(x - (along ? 0.75 : 0), 0.55, z - (along ? 0 : 0.75), 0.05, 1.05, 0.05, "#3a3d44"), box(x + (along ? 0.75 : 0), 0.55, z + (along ? 0 : 0.75), 0.05, 1.05, 0.05, "#3a3d44"));
    b.windows.push(box(x, 0.65, z - (along ? 0.28 : 0), along ? 1.4 : 0.03, 0.8, along ? 0.03 : 1.4, WHITE));
    b.city.push(box(x, 0.35, z - (along ? 0.18 : 0), along ? 1.2 : 0.3, 0.06, along ? 0.3 : 1.2, "#8a5a2b"));
  }
}

// The launch places, on the map now: built, lit, and marked "opens at launch".
function soonBuildings(b: Built) {
  const C = SOON.club_liquidity;
  // Club Liquidity: a black box with neon edges, a velvet rope and a queue spot.
  b.city.push(box(C.x, 1.9, C.z, 6, 3.6, 5, "#1b1530"), box(C.x, 3.8, C.z, 6.2, 0.2, 5.2, "#2a2145"));
  for (const [dx, dz, w, d] of [[0, 2.52, 6, 0.06], [0, -2.52, 6, 0.06], [3.02, 0, 0.06, 5], [-3.02, 0, 0.06, 5]] as const) b.neon.push(box(C.x + dx, 3.65, C.z + dz, w, 0.1, d, "#ff3fb4"));
  b.neon.push(box(C.x, 0.6, C.z + 2.55, 1.6, 1.2, 0.04, "#7a3cff"));
  for (const dx of [-1.4, 1.4]) b.city.push(cyl(C.x + dx, 0.45, C.z + 3.2, 0.06, 0.08, 0.6, "#d4a017", 6));
  b.city.push(box(C.x, 0.68, C.z + 3.2, 2.8, 0.06, 0.06, "#b23a3a"));

  const V = SOON.blockspace_canvas;
  // The Blockspace Canvas: one big shared pixel wall on a plaza, crews' corners
  // in their colours, scaffolding for the painters, sealed at every bell.
  b.city.push(box(V.x, 0.2, V.z, 7.4, 0.08, 5.4, "#d9d4c8"));
  b.city.push(box(V.x, 2.6, V.z - 1.2, 6.6, 4.6, 0.3, "#2c2c2a"));
  const CREWS = ["#ff3fb4", "#3ff0ff", "#ffe23f", "#7a3cff", "#3dff7a", "#ff7a3f", "#f4f1ea"];
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 8; j++) {
      const c = CREWS[(Math.floor(i / 4) * 3 + Math.floor(j / 3) + ((i * 7 + j * 3) % 5 === 0 ? 2 : 0)) % CREWS.length]!;
      b.neon.push(box(V.x - 2.75 + i * 0.5, 0.75 + j * 0.5, V.z - 1.03, 0.46, 0.46, 0.03, c));
    }
  for (const dx of [-3.1, 3.1]) b.city.push(box(V.x + dx, 2.6, V.z - 0.7, 0.08, 4.8, 0.08, "#8a8f98"), box(V.x + dx, 2.6, V.z - 0.3, 0.08, 4.8, 0.08, "#8a8f98"));
  for (const y of [1.4, 2.9]) b.city.push(box(V.x, y, V.z - 0.5, 6.4, 0.06, 0.5, "#8a5a2b"));

  const B = SOON.bot_cafe;
  // The Bot Café: a little café with a striped awning and outdoor tables.
  b.city.push(box(B.x, 1, B.z, 4.5, 2, 3.5, "#e8e1d4"), box(B.x, 2.08, B.z, 4.7, 0.16, 3.7, "#c46a5a"));
  for (let k = 0; k < 6; k++) b.city.push(box(B.x - 1.9 + k * 0.76, 1.6, B.z + 2.05, 0.76, 0.06, 0.6, k % 2 ? "#f4f1ea" : "#3ab5c9"));
  for (const dx of [-1.4, 0, 1.4]) b.city.push(cyl(B.x + dx, 0.38, B.z + 3, 0.35, 0.35, 0.05, WHITE, 10), cyl(B.x + dx, 0.2, B.z + 3, 0.04, 0.04, 0.38, "#3a3d44", 5));
  b.windows.push(box(B.x, 0.9, B.z + 1.77, 3.6, 0.9, 0.03, WHITE));
}

// Neon on the Trenches' shopfronts: bars of colour that blaze at night.
const NEON = ["#ff3fb4", "#3ff0ff", "#ffe23f", "#7a3cff", "#3dff7a", "#ff7a3f"];
function trenchesNeon(b: Built) {
  for (const l of fillCity())
    if (l.kind === "shop" && !isDinerShop(l)) {
      const bx = Math.floor((l.x + CITY_SIZE / 2 - GRID.road) / (GRID.block + GRID.road));
      const bz = Math.floor((l.z + CITY_SIZE / 2 - GRID.road) / (GRID.block + GRID.road));
      if (districtOf(bx, bz) !== "trenches") continue;
      const fx = Math.sin(l.yaw);
      const fz = Math.cos(l.yaw);
      const along = Math.abs(fz) > 0.5;
      const c = NEON[Math.abs(Math.floor(l.x * 7 + l.z * 3)) % NEON.length]!;
      b.neon.push(box(l.x + fx * 1.32, 1.9, l.z + fz * 1.32, along ? 1.4 : 0.05, 0.16, along ? 0.05 : 1.4, c));
    }
}

// --- Lots ---------------------------------------------------------------------

function tree(b: Built, x: number, z: number, s: number) {
  b.city.push(cyl(x, 0.45 * s, z, 0.07 * s, 0.1 * s, 0.9 * s, "#7a4a2a", 5), ball(x, 1.15 * s, z, 0.55 * s, "#4f9a4a", 1, 7), ball(x + 0.2 * s, 1.5 * s, z - 0.1 * s, 0.35 * s, "#63b05a", 1, 6));
}

function lot(b: Built, l: Lot) {
  const base = 0.17;
  switch (l.kind) {
    case "tree":
      return tree(b, l.x, l.z, l.s);
    case "pool":
      return void b.city.push(box(l.x, base + 0.03, l.z, l.w + 0.2, 0.06, l.d + 0.2, WHITE), box(l.x, base + 0.05, l.z, l.w, 0.06, l.d, "#5ec4e8"));
    case "parking": {
      b.city.push(box(l.x, base + 0.01, l.z, l.w, 0.02, l.d, "#55595f"));
      for (let k = -1; k <= 1; k++) b.city.push(box(l.x + k * 0.8, base + 0.025, l.z, 0.05, 0.01, l.d * 0.8, WHITE));
      return;
    }
    case "house": {
      const { fx, fz } = front(l.yaw);
      const sw = Math.abs(fx) > 0.5; // facing east or west: swap width and depth
      const w = sw ? l.d : l.w;
      const d = sw ? l.w : l.d;
      b.city.push(box(l.x, base + l.h / 2, l.z, w, l.h, d, l.color));
      b.city.push(prism(l.x, base + l.h, l.z, (sw ? d : w) * 1.08, 0.75, (sw ? w : d) * 1.12, l.roof, sw ? Math.PI / 2 : 0));
      b.city.push(box(l.x + fx * (d / 2 + 0.01), base + 0.35, l.z + fz * (d / 2 + 0.01), sw ? 0.04 : 0.36, 0.7, sw ? 0.36 : 0.04, darker(l.color, 0.55)));
      for (const k of [-1, 1]) {
        const ox = sw ? 0 : k * w * 0.28;
        const oz = sw ? k * d * 0.28 : 0;
        b.windows.push(box(l.x + fx * (d / 2 + 0.02) + ox, base + l.h * 0.62, l.z + fz * (d / 2 + 0.02) + oz, sw ? 0.04 : 0.32, 0.3, sw ? 0.32 : 0.04, WHITE));
      }
      return;
    }
    case "shop": {
      const { fx, fz } = front(l.yaw);
      b.city.push(box(l.x, base + l.h / 2, l.z, l.w, l.h, l.d, l.color));
      // Awning over the shopfront, a sign above it, an AC unit on the roof.
      const ax = l.x + fx * (l.d / 2 + 0.25);
      const az = l.z + fz * (l.d / 2 + 0.25);
      const along = Math.abs(fz) > 0.5;
      b.city.push(box(ax, base + 0.95, az, along ? l.w * 0.9 : 0.5, 0.08, along ? 0.5 : l.w * 0.9, l.awning));
      b.city.push(box(l.x + fx * (l.d / 2 + 0.03), base + 1.35, l.z + fz * (l.d / 2 + 0.03), along ? l.w * 0.6 : 0.06, 0.32, along ? 0.06 : l.w * 0.6, darker(l.awning, 0.8)));
      b.city.push(box(l.x - l.w * 0.2, base + l.h + 0.15, l.z, 0.5, 0.3, 0.4, "#b8bcc2"));
      b.windows.push(box(l.x + fx * (l.d / 2 + 0.02), base + 0.45, l.z + fz * (l.d / 2 + 0.02), along ? l.w * 0.75 : 0.04, 0.55, along ? 0.04 : l.w * 0.75, WHITE));
      for (let y = base + 1.75; y < base + l.h - 0.3; y += 0.9) b.windows.push(box(l.x, y, l.z, l.w + 0.03, 0.32, l.d + 0.03, WHITE));
      return;
    }
    case "office": {
      b.city.push(box(l.x, base + l.h / 2, l.z, l.w, l.h, l.d, l.color));
      // Bands of glass, floor by floor; a plant room and mast on the roof.
      for (let y = base + 0.7; y < base + l.h - 0.3; y += 0.85) b.windows.push(box(l.x, y, l.z, l.w + 0.04, 0.42, l.d + 0.04, WHITE));
      b.city.push(box(l.x, base + l.h + 0.25, l.z, l.w * 0.5, 0.5, l.d * 0.5, darker(l.color, 0.85)));
      if (l.h > 10) b.city.push(cyl(l.x, base + l.h + 1.2, l.z, 0.03, 0.05, 1.6, "#b8bcc2", 5));
      return;
    }
  }
}

// --- Landmarks -------------------------------------------------------------------

function landmarks(b: Built) {
  const T = LANDMARKS.tower;
  // The Prediction Tower: a stone podium with a glass lobby, then three glass
  // tiers stepping back as they rise, bright fins and floor lines, a crown
  // (the LED band is animated separately) and a spire.
  b.city.push(box(T.x, 0.75, T.z, 6.4, 1.2, 6.4, "#cfc9bc"), box(T.x, 1.38, T.z, 6.6, 0.08, 6.6, "#b8b2a5"));
  b.windows.push(box(T.x, 0.75, T.z, 5.6, 0.9, 5.62, WHITE));
  const tiers = [
    { w: 3.9, y0: 1.4, h: 8.6 },
    { w: 3.2, y0: 10, h: 4.4 },
    { w: 2.5, y0: 14.4, h: 2.4 },
  ];
  for (const t of tiers) {
    b.windows.push(box(T.x, t.y0 + t.h / 2, T.z, t.w, t.h, t.w, WHITE)); // the glass itself
    b.city.push(box(T.x, t.y0 + t.h + 0.06, T.z, t.w + 0.2, 0.12, t.w + 0.2, "#d9dee6")); // setback ledge
    for (let y = t.y0 + 0.7; y < t.y0 + t.h; y += 0.7) b.city.push(box(T.x, y, T.z, t.w + 0.03, 0.04, t.w + 0.03, "#c3cad6")); // floor lines
    const fins = Math.round(t.w / 0.55);
    for (let k = 0; k <= fins; k++) {
      const o = -t.w / 2 + (k * t.w) / fins;
      b.city.push(box(T.x + o, t.y0 + t.h / 2, T.z + t.w / 2 + 0.03, 0.06, t.h, 0.06, "#e6ebf2"), box(T.x + t.w / 2 + 0.03, t.y0 + t.h / 2, T.z + o, 0.06, t.h, 0.06, "#e6ebf2"));
    }
  }
  b.city.push(box(T.x, 17.35, T.z, 2.0, 0.5, 2.0, "#2a2f4a"));
  b.city.push(cyl(T.x, 19.4, T.z, 0.04, 0.14, 3.6, "#d0d4da", 8));
  b.lamps.push(ball(T.x, 21.25, T.z, 0.13, "#ff4d4d"));

  const C = LANDMARKS.city_hall;
  // City Hall: steps, a pale hall, six columns under a pediment, and a dome.
  b.city.push(box(C.x, 0.3, C.z + 0.4, 8, 0.3, 6, "#e8e1d4"), box(C.x, 0.5, C.z + 0.4, 7.4, 0.3, 5.4, "#f0eadf"), box(C.x, 0.65 + 1.6, C.z - 0.2, 7, 3.2, 4, "#f4f1ea"));
  for (let k = 0; k < 6; k++) b.city.push(cyl(C.x - 2.75 + k * 1.1, 0.65 + 1.5, C.z + 2.1, 0.17, 0.2, 3, WHITE, 10));
  b.city.push(box(C.x, 3.85, C.z + 1.9, 7, 0.3, 0.9, "#e8e1d4"), prism(C.x, 4, C.z + 1.9, 7.2, 0.9, 0.9, "#e8e1d4"));
  b.city.push(cyl(C.x, 4.35, C.z - 0.2, 1.5, 1.6, 0.8, "#e8e1d4", 16), ball(C.x, 4.75, C.z - 0.2, 1.55, "#8fb1e0", 0.8, 16));
  b.city.push(cyl(C.x, 6.7, C.z - 0.2, 0.03, 0.04, 1.4, "#d4a017", 5), box(C.x + 0.3, 7.2, C.z - 0.2, 0.55, 0.35, 0.03, "#378add"));
  for (let k = 0; k < 3; k++) b.windows.push(box(C.x - 2.4 + k * 2.4, 2.4, C.z - 2.21, 0.8, 1.2, 0.04, WHITE));

  const W = LANDMARKS.watch_party;
  // The Watch Party Hall: a stadium bowl with stepped seating round a striped
  // pitch, four floodlight masts and a big screen.
  // The bowl's outer wall (open at the top).
  b.city.push(colored(new THREE.CylinderGeometry(4.15, 4.35, 2.6, 32, 1, true).translate(W.x, 1.3, W.z), "#7d6bb3"), colored(new THREE.CylinderGeometry(3.05, 3.05, 0.9, 32, 1, true).translate(W.x, 2.15, W.z), "#6b5aa0"));
  // Seating: flat rings stepping down toward the pitch (rings, not discs, or the top one lids the bowl).
  for (let k = 0; k < 4; k++) {
    const outer = 4.15 - k * 0.27;
    b.city.push(colored(new THREE.RingGeometry(outer - 0.27, outer, 40).rotateX(-Math.PI / 2).translate(W.x, 2.61 - k * 0.2, W.z), k % 2 ? "#e24b4a" : "#f4f1ea"));
  }
  b.city.push(cyl(W.x, 1.75, W.z, 3.05, 3.05, 0.02, "#4f9d4a", 32));
  for (let k = -2; k <= 2; k++) b.city.push(box(W.x + k * 1.1, 1.77, W.z, 0.55, 0.01, 4.6, "#5fae55"));
  b.city.push(box(W.x, 1.78, W.z, 0.04, 0.01, 4.8, WHITE), cyl(W.x, 1.78, W.z, 0.7, 0.7, 0.01, "#6fbe62", 20));
  for (const [dx, dz] of [[3.4, 3.4], [-3.4, 3.4], [3.4, -3.4], [-3.4, -3.4]] as const) {
    b.city.push(cyl(W.x + dx, 2.6, W.z + dz, 0.06, 0.09, 5.2, "#3a3d44", 6), box(W.x + dx, 5.25, W.z + dz, 0.7, 0.35, 0.12, "#3a3d44"));
    b.lamps.push(box(W.x + dx - Math.sign(dx) * 0.02, 5.25, W.z + dz - Math.sign(dz) * 0.07, 0.6, 0.25, 0.03, "#fff8d8"));
  }
  b.city.push(box(W.x - 3.6, 3.6, W.z, 0.15, 2.4, 0.15, "#3a3d44"), box(W.x - 3.6, 4.9, W.z, 0.2, 1.4, 3, "#14161f"));

  const G = LANDMARKS.gm_wall;
  // The gm Wall: a mural wall on the square, with benches.
  b.city.push(box(G.x, 1.4, G.z - 0.4, 5.6, 2.5, 0.4, "#fff2c9"), box(G.x, 2.7, G.z - 0.4, 5.8, 0.15, 0.5, "#ef9f27"));
  for (const k of [-1.6, 0, 1.6]) b.city.push(box(G.x + k, 0.42, G.z + 1, 1.1, 0.08, 0.4, "#8a5a2b"), box(G.x + k, 0.22, G.z + 1, 0.9, 0.4, 0.06, "#3a3d44"));

  const F = LANDMARKS.faucet;
  // The Faucet: a fountain on the square.
  b.city.push(cyl(F.x, 0.4, F.z, 1.7, 1.8, 0.5, "#d0c9bd", 24), cyl(F.x, 0.66, F.z, 1.5, 1.5, 0.04, "#6fb4e8", 24), cyl(F.x, 1.2, F.z, 0.18, 0.24, 1.1, "#d0c9bd", 10), cyl(F.x, 1.8, F.z, 0.6, 0.35, 0.18, "#d0c9bd", 16), cyl(F.x, 1.9, F.z, 0.5, 0.5, 0.03, "#8ac8f0", 16), ball(F.x, 2.15, F.z, 0.18, "#a8d8f8"));

  const D = LANDMARKS.diner;
  // The Gwei Diner: a chrome capsule with a red stripe and a pole sign.
  b.city.push(colored(new THREE.CylinderGeometry(0.95, 0.95, 2.8, 16).rotateZ(Math.PI / 2).translate(D.x, 0.95, D.z), "#c9cdd2"), box(D.x, 0.75, D.z, 2.82, 0.22, 1.92, "#d4473f"));
  b.city.push(cyl(D.x + 1.8, 1.6, D.z + 0.9, 0.06, 0.08, 3, "#3a3d44", 6));
  for (let k = -1; k <= 1; k++) b.windows.push(box(D.x + k * 0.85, 1.25, D.z + 0.93, 0.55, 0.4, 0.04, WHITE));
}
// --- Text panels (signs that glow) -------------------------------------------------

function useSign(text: string, color: string, bg: string | null = null, w = 1024, h = 256) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
    }
    g.fillStyle = color;
    g.font = `900 ${Math.floor(h * 0.62)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = color;
    g.shadowBlur = bg ? 0 : 18;
    g.fillText(text, w / 2, h / 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [text, color, bg, w, h]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

function Sign({ text, color, bg, position, size, rotY = 0 }: { text: string; color: string; bg?: string; position: [number, number, number]; size: [number, number]; rotY?: number }) {
  const tex = useSign(text, color, bg ?? null);
  return (
    <mesh position={position} rotation-y={rotY}>
      <planeGeometry args={size} />
      <meshBasicMaterial map={tex} transparent toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

// --- Traffic ---------------------------------------------------------------------------

// Shared: a new geometry per render would rebuild the meshes (and lose their colours).
const CAR_BODY = new THREE.BoxGeometry(0.45, 0.26, 0.95);
const CAR_CABIN = new THREE.BoxGeometry(0.4, 0.22, 0.5);
const BRAKE = new THREE.BoxGeometry(0.42, 0.06, 0.03).translate(0, 0, -0.47);
const LAMP = new THREE.SphereGeometry(0.11, 8, 6);
const CAR_COLORS = ["#e24b4a", "#f4f1ea", "#378add", "#f2c94c", "#2c2c2a", "#97c459", "#ef9f27", "#8f5bd1"];
const LIGHT_HEX: Record<Light, string> = { green: "#3ddc6e", amber: "#ffb020", red: "#ff3b3b" };

// Cars in lanes, following each other and stopping for red lights (traffic.ts),
// drawn with Kenney's Car Kit: one instanced mesh per model.
const CAR_MODELS = ["sedan", "taxi", "suv", "van", "police", "truck", "delivery", "hatchback-sports", "suv-luxury", "sedan-sports", "ambulance", "garbage-truck"];
const CAR_SCALE = 0.34;

function CarModel({ model, cars, lanes, brakes }: { model: string; cars: Car[]; lanes: Lane[]; brakes: React.MutableRefObject<THREE.InstancedMesh | null>; }) {
  const baked = useBaked(KIT.cars(model));
  const ref = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    cars.forEach((c, i) => {
      const p = carPose(lanes[c.lane]!, c);
      const off = Math.abs(p.x) > CITY_SIZE / 2 || Math.abs(p.z) > CITY_SIZE / 2;
      o.position.set(p.x, off ? -5 : 0.04, p.z);
      o.rotation.set(0, p.yaw, 0);
      o.scale.setScalar(CAR_SCALE);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  if (!baked) return null;
  return <instancedMesh ref={ref} args={[baked.geometry, baked.material, cars.length]} castShadow frustumCulled={false} />;
}

function Traffic() {
  const world = useMemo(() => makeTraffic(44), []);
  const byModel = useMemo(() => CAR_MODELS.map((m, k) => ({ model: m, cars: world.cars.filter((_, i) => i % CAR_MODELS.length === k) })).filter((g) => g.cars.length), [world]);
  const brake = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => ({ o: new THREE.Object3D(), c: new THREE.Color() }), []);
  const clock = useRef(0);
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    clock.current += dt;
    stepTraffic(world.lanes, world.cars, clock.current, dt);
    // Brake lights glow while a car is slow or stopped.
    world.cars.forEach((c, i) => {
      const p = carPose(world.lanes[c.lane]!, c);
      const off = Math.abs(p.x) > CITY_SIZE / 2 || Math.abs(p.z) > CITY_SIZE / 2;
      tmp.o.position.set(p.x, off ? -5 : 0.24, p.z);
      tmp.o.rotation.set(0, p.yaw, 0);
      tmp.o.updateMatrix();
      brake.current!.setMatrixAt(i, tmp.o.matrix);
      brake.current!.setColorAt(i, tmp.c.set(c.v < 1.2 ? "#ff2a2a" : "#4a1010"));
    });
    brake.current!.instanceMatrix.needsUpdate = true;
    if (brake.current!.instanceColor) brake.current!.instanceColor.needsUpdate = true;
  });
  return (
    <>
      <Suspense fallback={null}>
        {byModel.map((g) => (
          <CarModel key={g.model} model={g.model} cars={g.cars} lanes={world.lanes} brakes={brake} />
        ))}
      </Suspense>
      <instancedMesh ref={brake} args={[BRAKE, undefined, world.cars.length]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <TrafficLights />
    </>
  );
}

// A signal on the corner of every junction: one head for each direction,
// changing with the same cycle the cars obey.
function TrafficLights() {
  const spots = useMemo(() => {
    const rs = roads();
    const out: { x: number; z: number }[] = [];
    for (const a of rs.filter((r) => r.along === "z"))
      for (const c of rs.filter((r) => r.along === "x")) {
        const x = a.a - GRID.road / 2 - 0.25;
        const z = c.a - GRID.road / 2 - 0.25;
        if (Math.abs(x) < CITY_SIZE / 2 - 0.3 && Math.abs(z) < CITY_SIZE / 2 - 0.3 && !inSquare(a.a, c.a, 0.5)) out.push({ x, z });
      }
    return out;
  }, []);
  const poles = useMemo(() => mergeGeometries(spots.flatMap((p) => [cyl(p.x, 0.9, p.z, 0.04, 0.05, 1.8, "#2c2c2a", 6), box(p.x + 0.12, 1.75, p.z, 0.18, 0.5, 0.18, "#2c2c2a"), box(p.x, 1.75, p.z + 0.12, 0.18, 0.5, 0.18, "#2c2c2a")]), false)!, [spots]);
  const xs = useRef<THREE.InstancedMesh>(null);
  const zs = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const clock = useRef(0);
  useEffect(() => {
    spots.forEach((p, i) => {
      tmp.position.set(p.x + 0.12, 1.75, p.z + 0.1);
      tmp.updateMatrix();
      xs.current!.setMatrixAt(i, tmp.matrix);
      tmp.position.set(p.x + 0.1, 1.75, p.z + 0.12);
      tmp.updateMatrix();
      zs.current!.setMatrixAt(i, tmp.matrix);
    });
    xs.current!.instanceMatrix.needsUpdate = zs.current!.instanceMatrix.needsUpdate = true;
  }, [spots, tmp]);
  useEffect(() => () => poles.dispose(), [poles]);
  useFrame((_, dt) => {
    clock.current += Math.min(dt, 0.05);
    (xs.current!.material as THREE.MeshBasicMaterial).color.set(LIGHT_HEX[lightFor("x", clock.current)]);
    (zs.current!.material as THREE.MeshBasicMaterial).color.set(LIGHT_HEX[lightFor("z", clock.current)]);
  });
  return (
    <>
      <mesh geometry={poles}>
        <meshStandardMaterial vertexColors roughness={0.72} />
      </mesh>
      <instancedMesh ref={xs} args={[LAMP, undefined, spots.length]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={zs} args={[LAMP, undefined, spots.length]} frustumCulled={false}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  );
}

// --- The whole city ------------------------------------------------------------------------

// Billboards on the Mempool quay: candle charts, green and red, that tick on,
// between Mempool Plots (ad space rented in $PARTY from launch) that read "pending" until paid.
function Billboards({ night }: { night: boolean }) {
  const lagoon = blockRect(0, GRID.blocks - 1);
  const boards = useMemo(() => [-28, -12, 6, 22].map((x, i) => ({ x, z: lagoon.z - lagoon.d / 2 - 0.4, up: i === 0, plot: i % 2 === 1 })), [lagoon.z, lagoon.d]);
  const canvases = useMemo(() => boards.map(() => { const c = document.createElement("canvas"); c.width = 256; c.height = 128; return c; }), [boards]);
  const textures = useMemo(() => canvases.map((c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }), [canvases]);
  const series = useRef(boards.map((b) => Array.from({ length: 24 }, (_, k) => 64 + (b.up ? -k : k) * 1.4)));
  useEffect(() => () => textures.forEach((t) => t.dispose()), [textures]);
  const last = useRef(0);
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current < 1.2 && last.current) return;
    last.current = clock.elapsedTime;
    canvases.forEach((c, i) => {
      const g0 = c.getContext("2d")!;
      if (boards[i]!.plot) {
        g0.fillStyle = "#14171f";
        g0.fillRect(0, 0, 256, 128);
        g0.setLineDash([8, 6]);
        g0.strokeStyle = "#5b6475";
        g0.lineWidth = 3;
        g0.strokeRect(8, 8, 240, 112);
        g0.fillStyle = "#c8cfdb";
        g0.font = "bold 22px sans-serif";
        g0.fillText("MEMPOOL PLOT", 46, 58);
        g0.fillStyle = "#f2c94c";
        g0.font = "16px sans-serif";
        g0.fillText(`pending${".".repeat(1 + (Math.floor(clock.elapsedTime / 1.2) % 3))}`, 92, 88);
        textures[i]!.needsUpdate = true;
        return;
      }
      const s = series.current[i]!;
      const drift = boards[i]!.up ? -0.8 : 0.8;
      s.push(Math.min(116, Math.max(12, s[s.length - 1]! + drift + (Math.random() - 0.5) * 9)));
      s.shift();
      const g = c.getContext("2d")!;
      g.fillStyle = "#0e1118";
      g.fillRect(0, 0, 256, 128);
      g.strokeStyle = "#1e2432";
      for (let y = 16; y < 128; y += 24) g.strokeRect(0, y, 256, 0);
      s.forEach((v, k) => {
        if (!k) return;
        const up = v < s[k - 1]!;
        g.fillStyle = up ? "#2bd67b" : "#ff4d5e";
        const top = Math.min(v, s[k - 1]!);
        g.fillRect(6 + k * 10, top, 7, Math.max(2, Math.abs(v - s[k - 1]!)));
        g.fillRect(9 + k * 10, top - 4, 1, Math.abs(v - s[k - 1]!) + 8);
      });
      g.fillStyle = "#0e1118";
      g.fillRect(0, 0, 256, 29);
      g.font = "bold 17px sans-serif";
      g.fillStyle = "#f0e8d6";
      g.fillText("CITY ART · NOT LIVE DATA", 8, 21);
      textures[i]!.needsUpdate = true;
    });
  });
  return (
    <>
      {boards.map((b, i) => (
        <group key={b.x} position={[b.x, 0, b.z]}>
          <mesh position={[0, 1.4, 0]} castShadow>
            <boxGeometry args={[0.15, 2.8, 0.15]} />
            <meshStandardMaterial color="#3a3d44" />
          </mesh>
          <mesh position={[0, 3.3, 0]} castShadow>
            <boxGeometry args={[4.2, 2.2, 0.15]} />
            <meshStandardMaterial color="#2c2c2a" />
          </mesh>
          {[0.08, -0.08].map((dz) => (
            <mesh key={dz} position={[0, 3.3, dz]} rotation={[0, dz > 0 ? 0 : Math.PI, 0]}>
              <planeGeometry args={[3.9, 1.95]} />
              <meshBasicMaterial map={textures[i]} toneMapped={false} color={night ? "#ffffff" : "#d8d8d8"} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

// `lamps` false leaves out the two night point lights (the low quality tier).
export default function CityScape({ night, lamps = true }: { night: boolean; lamps?: boolean }) {
  const built = useMemo(() => {
    const b: Built = { city: [], windows: [], lamps: [], neon: [] };
    blocks(b);
    soonBuildings(b);
    trenchesNeon(b);
    // Roads, street lights, houses, shops, towers and trees come from Kenney's
    // City Kit (see Kit.tsx); our own code keeps pools, parking and landmarks.
    for (const l of fillCity()) if (l.kind === "pool" || l.kind === "parking") lot(b, l);
    landmarks(b);
    const merged = { city: mergeGeometries(b.city, false)!, windows: mergeGeometries(b.windows, false)!, lamps: mergeGeometries(b.lamps, false)!, neon: mergeGeometries(b.neon, false)! };
    Object.values(b).forEach((parts) => parts.forEach((part) => part.dispose()));
    return merged;
  }, []);
  const placements = useMemo(() => cityPlacements(), []);
  const mat = useMemo(() => citySurface(), []);
  const details = useMemo(() => cityDetails(), []);
  useEffect(
    () => () => {
      built.city.dispose();
      built.windows.dispose();
      built.lamps.dispose();
      built.neon.dispose();
      mat.dispose();
      details.dispose();
    },
    [built, mat, details],
  );
  return (
    <group>
      {/* The land beyond the grid. */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.01} receiveShadow>
        <planeGeometry args={[CITY_SIZE + 30, CITY_SIZE + 30]} />
        <meshStandardMaterial color="#81956a" roughness={1} />
      </mesh>
      <Suspense fallback={null}>
        <Kit placements={placements} night={night} />
      </Suspense>
      <mesh geometry={built.city} material={mat} castShadow receiveShadow />
      <mesh geometry={details} material={mat} castShadow receiveShadow />
      <DinerQuarter night={night} />
      <CityWater night={night} />
      <CityStreetGlow night={night} lamps={lamps} />
      <mesh geometry={built.windows}>
        <meshStandardMaterial color={night ? "#bd9d68" : "#688995"} emissive={night ? "#ffb84d" : "#000000"} emissiveIntensity={night ? 0.9 : 0} roughness={0.19} metalness={0.48} envMapIntensity={1.3} />
      </mesh>
      {/* Neon: always coloured, blazing at night. */}
      <mesh geometry={built.neon}>
        <meshBasicMaterial vertexColors toneMapped={false} color={night ? "#ffffff" : "#b8b8b8"} />
      </mesh>
      <mesh geometry={built.lamps}>
        <meshStandardMaterial color="#fff2b8" emissive="#ffd27a" emissiveIntensity={night ? 1.4 : 0.1} />
      </mesh>
      <Traffic />
      <Billboards night={night} />
      <Sign text="gm" color="#ef9f27" bg="#fff2c9" position={[LANDMARKS.gm_wall.x, 1.35, LANDMARKS.gm_wall.z - 0.18]} size={[5.4, 1.35]} />
      <Sign text="CITY HALL" color="#5a6b80" bg="#e8e1d4" position={[LANDMARKS.city_hall.x, 3.85, LANDMARKS.city_hall.z + 2.36]} size={[4.2, 0.28]} />
      <Sign text="WATCH PARTY" color="#7ab8ff" bg="#14161f" position={[LANDMARKS.watch_party.x - 3.48, 4.9, LANDMARKS.watch_party.z]} size={[2.9, 1.3]} rotY={Math.PI / 2} />
      <Sign text="DINER" color="#ff5d73" position={[LANDMARKS.diner.x + 1.8, 3.3, LANDMARKS.diner.z + 0.92]} size={[1.8, 0.5]} />
      <Sign text="CREW ROW" color="#ffffff" bg="#8a5a2b" position={[blockRect(0, 2).x + GRID.block / 2 + 0.05, 1.5, blockRect(0, 2).z]} size={[2.6, 0.5]} rotY={Math.PI / 2} />
    </group>
  );
}
