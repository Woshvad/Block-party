import { isDinerShop } from "./dinerArchitecture";
import { CITY_SIZE, GRID, type Lot, SQUARE, blockRect, fillCity, roads, zoneOf } from "./citygen";

// The lagoon row: roads crossing it become bridges.
const LAGOON = blockRect(0, GRID.blocks - 1);
const overLagoon = (z: number) => Math.abs(z - LAGOON.z) < LAGOON.d / 2;


export type Placement = { url: string; x: number; y?: number; z: number; rotY?: number; scale?: number | [number, number, number] };

export const KIT = {
  roads: (name: string) => `/assets/kenney/roads/${name}.glb`,
  commercial: (name: string) => `/assets/kenney/commercial/${name}.glb`,
  suburban: (name: string) => `/assets/kenney/suburban/${name}.glb`,
  industrial: (name: string) => `/assets/kenney/industrial/${name}.glb`,
  cars: (name: string) => `/assets/kenney/cars/${name}.glb`,
};

// The city dressed in Kenney's City Kit: road tiles (zebra crossings at every
// junction), street lights, and the zoned lots turned into real buildings,
// houses and trees. Pure: same city every time, and testable.

const ROAD_TILE = GRID.road; // kit road tiles are 1×1, scaled to our road width
const SHOPS = "abcdefghijklmn".split("").map((c) => `building-${c}`);
const TOWERS = "abcde".split("").map((c) => `building-skyscraper-${c}`);
const HOUSES = "abcdefghijklmnopqrstu".split("").map((c) => `building-type-${c}`);
const pick = <T,>(xs: readonly T[], k: number) => xs[((k % xs.length) + xs.length) % xs.length]!;
const hash = (x: number, z: number) => Math.abs(Math.floor(x * 73.1 + z * 19.7 + x * z * 3.3));
const inSquare = (x: number, z: number) => Math.abs(x - SQUARE.x) < SQUARE.w / 2 && Math.abs(z - SQUARE.z) < SQUARE.d / 2;

export function roadPlacements(): Placement[] {
  const rs = roads();
  const half = CITY_SIZE / 2;
  const out: Placement[] = [];
  const junction = (s: number, along: "x" | "z") => rs.some((o) => o.along !== along && Math.abs(o.a - s) < 0.01);
  const nearJunction = (s: number, along: "x" | "z") => rs.some((o) => o.along !== along && Math.abs(Math.abs(o.a - s) - ROAD_TILE) < 0.01);
  for (const r of rs) {
    for (let s = -half + ROAD_TILE / 2; s < half; s += ROAD_TILE) {
      const [x, z] = r.along === "x" ? [s, r.a] : [r.a, s];
      if (inSquare(x, z)) continue;
      if (junction(s, r.along)) {
        if (r.along === "x") out.push({ url: KIT.roads("road-crossroad"), x, z, y: 0.02, scale: ROAD_TILE }); // once per junction
        continue;
      }
      const name = r.along === "z" && overLagoon(z) ? "road-bridge" : nearJunction(s, r.along) ? "road-crossing" : "road-straight";
      out.push({ url: KIT.roads(name), x, z, y: 0.02, scale: ROAD_TILE, rotY: r.along === "x" ? Math.PI / 2 : 0 });
    }
  }
  return out;
}

// Street lights along the sidewalks, every other tile, facing the road.
export function lightPlacements(): Placement[] {
  const out: Placement[] = [];
  const half = CITY_SIZE / 2;
  for (const r of roads()) {
    for (let s = -half + 3; s < half - 1; s += 5.5) {
      const off = GRID.road / 2 + 0.35;
      const [x, z] = r.along === "x" ? [s, r.a + off] : [r.a + off, s];
      if (inSquare(x, z) || overLagoon(z) || Math.abs(x) > half - 0.5 || Math.abs(z) > half - 0.5) continue;
      if (roads().some((o) => o.along !== r.along && Math.abs(o.a - s) < GRID.road)) continue;
      out.push({ url: KIT.roads("light-square"), x, z, y: 0.14, scale: 2.4, rotY: r.along === "x" ? Math.PI : -Math.PI / 2 });
    }
  }
  return out;
}

// The lots, as kit buildings. Houses face their street. Shops and towers are
// sized to leave daylight between them (models ~0.95 and ~1.36 wide on 3- and
// 4.5-unit lots); height varies, not footprint.
export function lotPlacements(lots: Lot[] = fillCity()): Placement[] {
  const out: Placement[] = [];
  for (const l of lots) {
    if (isDinerShop(l)) continue; // Custom architecture occupies exactly these existing lots.
    const k = hash(l.x, l.z);
    if (l.kind === "house") out.push({ url: KIT.suburban(pick(HOUSES, k)), x: l.x, z: l.z, y: 0.16, rotY: l.yaw, scale: 1.75 });
    else if (l.kind === "shop") out.push({ url: KIT.commercial(pick(SHOPS, k)), x: l.x, z: l.z, y: 0.16, rotY: l.yaw, scale: [2.0, 2.0 * (1 + (k % 3) * 0.25), 2.0] });
    else if (l.kind === "office") out.push({ url: KIT.commercial(pick(TOWERS, k)), x: l.x, z: l.z, y: 0.16, rotY: (k % 4) * (Math.PI / 2), scale: [1.9, 1.9 * (l.tall ?? 1), 1.9] });
    else if (l.kind === "factory") out.push({ url: KIT.industrial(l.model), x: l.x, z: l.z, y: 0.16, rotY: l.yaw, scale: l.scale });
    else if (l.kind === "tree") out.push({ url: KIT.suburban(k % 3 ? "tree-large" : "tree-small"), x: l.x, z: l.z, y: 0.16, rotY: k, scale: 2.2 * l.s });
  }
  return out;
}

// Trees along every sidewalk, clear of the corners and crossings.
export function streetTreePlacements(): Placement[] {
  const out: Placement[] = [];
  for (let bx = 0; bx < GRID.blocks; bx++)
    for (let bz = 0; bz < GRID.blocks; bz++) {
      const zone = zoneOf(bx, bz);
      if (zone === "square" || zone === "water" || zone === "locked") continue;
      const r = blockRect(bx, bz);
      const e = r.w / 2 + 0.12;
      for (let k = -r.w / 2 + 1.6; k <= r.w / 2 - 1.6; k += 2.3)
        for (const [x, z] of [[r.x + k, r.z + e], [r.x + k, r.z - e], [r.x + e, r.z + k], [r.x - e, r.z + k]] as const)
          out.push({ url: KIT.suburban(hash(x, z) % 3 ? "tree-small" : "tree-large"), x, z, y: 0.14, rotY: hash(z, x), scale: 2 });
    }
  return out;
}

export function cityPlacements(): Placement[] {
  return [...roadPlacements(), ...lightPlacements(), ...lotPlacements(), ...streetTreePlacements()];
}
