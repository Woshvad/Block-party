"use client";
import { useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { outlineMaterial, toonRamp } from "./chibi/parts";
import { CITY_SIZE, GRID, LANDMARKS, type Lot, SQUARE, blockRect, fillCity, roads, zoneOf } from "./citygen";
import Kit from "./Kit";
import { cityPlacements } from "./kitcity";
import { type Light, carPose, lightFor, makeTraffic, stepTraffic } from "./traffic";
import { type Part, ball, box, colored, cyl, darker, prism } from "./geo";

// The city board, SimCity style: asphalt roads with lane markings and
// crosswalks, raised sidewalks, zoned blocks full of houses, shops and
// offices, parks and the lagoon, our landmarks on their own blocks, street
// lights, and traffic. Everything static is merged into a handful of meshes:
// the toon-shaded city (plus its ink outline), its windows (they glow at
// night) and the street-light heads.

const ASPHALT = "#3d4148";
const SIDEWALK = "#d6d1c4";
const GRASS = "#9fcf7f";
const PAVING = "#e6dccb";
const WHITE = "#f4f1ea";
const YELLOW = "#f2c94c";

type Built = { city: Part[]; windows: Part[]; lamps: Part[] };
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
  for (let bx = 0; bx < GRID.blocks; bx++)
    for (let bz = 0; bz < GRID.blocks; bz++) {
      const r = blockRect(bx, bz);
      const zone = zoneOf(bx, bz);
      if (zone === "square") continue;
      b.city.push(box(r.x, 0.07, r.z, r.w + 0.5, 0.14, r.d + 0.5, SIDEWALK));
      const ground = zone === "water" ? "#5aa9d6" : zone === "commercial" || zone === "office" ? PAVING : zone === "landmark" ? "#a9d28c" : GRASS;
      if (zone === "water") {
        b.city.push(box(r.x, 0.1, r.z, r.w - 0.4, 0.06, r.d - 0.4, "#4f9bd0"), box(r.x - 1, 0.18, r.z + 2.6, 0.9, 0.12, 3.6, "#8a5a2b"));
        for (let k = 0; k < 6; k++) b.city.push(ball(r.x + 3.2 - (k % 3) * 0.6, 0.6, r.z - 3.4 + Math.floor(k / 3) * 6.6, 0.45, "#5aa05a"));
      } else b.city.push(box(r.x, 0.15, r.z, r.w - 0.2, 0.04, r.d - 0.2, ground));
    }
  // Bus shelters on the square's edges.
  for (const [x, z, yaw] of [[SQUARE.x + 4, SQUARE.z + SQUARE.d / 2 + 0.05, 0], [SQUARE.x - SQUARE.w / 2 - 0.05, SQUARE.z - 4, Math.PI / 2]] as const) {
    const along = yaw === 0;
    b.city.push(box(x, 1.05, z, along ? 1.6 : 0.06, 0.06, along ? 0.06 : 1.6, "#3a3d44"), box(x, 1.08, z + (along ? -0.25 : 0), along ? 1.7 : 0.6, 0.05, along ? 0.6 : 1.7, "#378add"));
    b.city.push(box(x - (along ? 0.75 : 0), 0.55, z - (along ? 0 : 0.75), 0.05, 1.05, 0.05, "#3a3d44"), box(x + (along ? 0.75 : 0), 0.55, z + (along ? 0 : 0.75), 0.05, 1.05, 0.05, "#3a3d44"));
    b.windows.push(box(x, 0.65, z - (along ? 0.28 : 0) - (along ? 0 : 0), along ? 1.4 : 0.03, 0.8, along ? 0.03 : 1.4, WHITE));
    b.city.push(box(x, 0.35, z - (along ? 0.18 : 0), along ? 1.2 : 0.3, 0.06, along ? 0.3 : 1.2, "#8a5a2b"));
  }
  // Tower Square: one paved plaza over the middle blocks and their roads.
  b.city.push(box(SQUARE.x, 0.08, SQUARE.z, SQUARE.w + 0.5, 0.16, SQUARE.d + 0.5, PAVING));
  b.city.push(cyl(SQUARE.x, 0.17, SQUARE.z, 7, 7, 0.02, "#d9cdb8", 32), cyl(SQUARE.x, 0.18, SQUARE.z, 5.2, 5.2, 0.02, PAVING, 32));
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    tree(b, SQUARE.x + Math.cos(a) * 9.3, SQUARE.z + Math.sin(a) * 9.3, 0.8);
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
  // The Prediction Tower: podium, glass shaft, setback crown (the LED crown on top is animated separately).
  b.city.push(box(T.x, 0.45, T.z, 6, 0.6, 6, "#d8d3c8"), box(T.x, 0.85 + 7.5, T.z, 3.6, 15, 3.6, "#4e44a8"), box(T.x, 16.35 + 1, T.z, 3, 2, 3, "#3d3590"));
  for (let y = 1.4; y < 15.8; y += 0.75) b.windows.push(box(T.x, y, T.z, 3.64, 0.38, 3.64, WHITE));
  b.city.push(cyl(T.x, 20.3, T.z, 0.05, 0.1, 3.4, "#d0d4da", 6));
  b.lamps.push(ball(T.x, 22.05, T.z, 0.14, "#ff4d4d"));

  const C = LANDMARKS.city_hall;
  // City Hall: steps, a pale hall, six columns under a pediment, and a dome.
  b.city.push(box(C.x, 0.3, C.z + 0.4, 8, 0.3, 6, "#e8e1d4"), box(C.x, 0.5, C.z + 0.4, 7.4, 0.3, 5.4, "#f0eadf"), box(C.x, 0.65 + 1.6, C.z - 0.2, 7, 3.2, 4, "#f4f1ea"));
  for (let k = 0; k < 6; k++) b.city.push(cyl(C.x - 2.75 + k * 1.1, 0.65 + 1.5, C.z + 2.1, 0.17, 0.2, 3, WHITE, 10));
  b.city.push(box(C.x, 3.85, C.z + 1.9, 7, 0.3, 0.9, "#e8e1d4"), prism(C.x, 4, C.z + 1.9, 7.2, 0.9, 0.9, "#e8e1d4"));
  b.city.push(cyl(C.x, 4.35, C.z - 0.2, 1.5, 1.6, 0.8, "#e8e1d4", 16), ball(C.x, 4.75, C.z - 0.2, 1.55, "#8fb1e0", 0.8, 16));
  b.city.push(cyl(C.x, 6.7, C.z - 0.2, 0.03, 0.04, 1.4, "#d4a017", 5), box(C.x + 0.3, 7.2, C.z - 0.2, 0.55, 0.35, 0.03, "#378add"));
  for (let k = 0; k < 3; k++) b.windows.push(box(C.x - 2.4 + k * 2.4, 2.4, C.z - 2.21, 0.8, 1.2, 0.04, WHITE));

  const W = LANDMARKS.watch_party;
  // The Watch Party Hall: a stadium bowl round a pitch, with a big screen.
  b.city.push(cyl(W.x, 1.2, W.z, 4.1, 4.3, 2.4, "#8f7cc0", 28), cyl(W.x, 1.6, W.z, 3.5, 3.2, 1.62, "#6d5ea0", 28), cyl(W.x, 2.42, W.z, 3.25, 3.25, 0.02, "#5fae55", 28));
  b.city.push(box(W.x, 2.44, W.z, 0.05, 0.01, 4.4, WHITE), cyl(W.x, 2.44, W.z, 0.8, 0.8, 0.01, "#6fbe62", 18));
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
const BRAKE = new THREE.BoxGeometry(0.4, 0.07, 0.03).translate(0, 0, -0.48);
const LAMP = new THREE.SphereGeometry(0.11, 8, 6);
const CAR_COLORS = ["#e24b4a", "#f4f1ea", "#378add", "#f2c94c", "#2c2c2a", "#97c459", "#ef9f27", "#8f5bd1"];
const LIGHT_HEX: Record<Light, string> = { green: "#3ddc6e", amber: "#ffb020", red: "#ff3b3b" };

// Cars in lanes, following each other and stopping for red lights (traffic.ts).
function Traffic({ night }: { night: boolean }) {
  const world = useMemo(() => makeTraffic(44), []);
  const body = useRef<THREE.InstancedMesh>(null);
  const cabin = useRef<THREE.InstancedMesh>(null);
  const brake = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => ({ o: new THREE.Object3D(), c: new THREE.Color() }), []);
  const clock = useRef(0);
  useEffect(() => {
    world.cars.forEach((c, i) => body.current!.setColorAt(i, tmp.c.set(CAR_COLORS[c.color % CAR_COLORS.length]!)));
    if (body.current?.instanceColor) body.current.instanceColor.needsUpdate = true;
  }, [world, tmp]);
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    clock.current += dt;
    stepTraffic(world.lanes, world.cars, clock.current, dt);
    world.cars.forEach((c, i) => {
      const p = carPose(world.lanes[c.lane]!, c);
      const off = Math.abs(p.x) > CITY_SIZE / 2 || Math.abs(p.z) > CITY_SIZE / 2;
      tmp.o.position.set(p.x, off ? -5 : 0.27, p.z);
      tmp.o.rotation.set(0, p.yaw, 0);
      tmp.o.updateMatrix();
      body.current!.setMatrixAt(i, tmp.o.matrix);
      brake.current!.setMatrixAt(i, tmp.o.matrix);
      // Brake lights glow while a car is slow or stopped.
      brake.current!.setColorAt(i, tmp.c.set(c.v < 1.2 ? "#ff3030" : "#5a1414"));
      tmp.o.position.y = off ? -5 : 0.5;
      tmp.o.updateMatrix();
      cabin.current!.setMatrixAt(i, tmp.o.matrix);
    });
    for (const m of [body, cabin, brake]) m.current!.instanceMatrix.needsUpdate = true;
    if (brake.current!.instanceColor) brake.current!.instanceColor.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={body} args={[CAR_BODY, undefined, world.cars.length]} frustumCulled={false}>
        <meshToonMaterial />
      </instancedMesh>
      <instancedMesh ref={cabin} args={[CAR_CABIN, undefined, world.cars.length]} frustumCulled={false}>
        <meshStandardMaterial color={night ? "#ffe2a0" : "#2a3a4f"} emissive={night ? "#ffcf70" : "#000000"} emissiveIntensity={night ? 0.6 : 0} />
      </instancedMesh>
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
        <meshToonMaterial vertexColors />
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

export default function CityScape({ night }: { night: boolean }) {
  const built = useMemo(() => {
    const b: Built = { city: [], windows: [], lamps: [] };
    blocks(b);
    // Roads, street lights, houses, shops, towers and trees come from Kenney's
    // City Kit (see Kit.tsx); our own code keeps pools, parking and landmarks.
    for (const l of fillCity()) if (l.kind === "pool" || l.kind === "parking") lot(b, l);
    landmarks(b);
    return { city: mergeGeometries(b.city, false)!, windows: mergeGeometries(b.windows, false)!, lamps: mergeGeometries(b.lamps, false)! };
  }, []);
  const placements = useMemo(() => cityPlacements(), []);
  const ramp = useMemo(() => toonRamp(), []);
  const mat = useMemo(() => new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp }), [ramp]);
  const ink = useMemo(() => outlineMaterial(0.02), []);
  useEffect(
    () => () => {
      built.city.dispose();
      built.windows.dispose();
      built.lamps.dispose();
      mat.dispose();
      ink.dispose();
      ramp.dispose();
    },
    [built, mat, ink, ramp],
  );
  return (
    <group>
      {/* The land beyond the grid. */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.01} receiveShadow>
        <planeGeometry args={[CITY_SIZE + 30, CITY_SIZE + 30]} />
        <meshStandardMaterial color={night ? "#2c3a2a" : "#8fbf6f"} />
      </mesh>
      <Suspense fallback={null}>
        <Kit placements={placements} />
      </Suspense>
      <mesh geometry={built.city} material={mat} castShadow receiveShadow />
      <mesh geometry={built.city} material={ink} />
      <mesh geometry={built.windows}>
        <meshStandardMaterial color={night ? "#ffdd8a" : "#6f93ba"} emissive={night ? "#ffb84d" : "#000000"} emissiveIntensity={night ? 0.9 : 0} roughness={0.25} metalness={0.2} />
      </mesh>
      <mesh geometry={built.lamps}>
        <meshStandardMaterial color="#fff2b8" emissive="#ffd27a" emissiveIntensity={night ? 1.4 : 0.1} />
      </mesh>
      <Traffic night={night} />
      <Sign text="gm" color="#ef9f27" bg="#fff2c9" position={[LANDMARKS.gm_wall.x, 1.35, LANDMARKS.gm_wall.z - 0.18]} size={[5.4, 1.35]} />
      <Sign text="CITY HALL" color="#5a6b80" bg="#e8e1d4" position={[LANDMARKS.city_hall.x, 3.85, LANDMARKS.city_hall.z + 2.36]} size={[4.2, 0.28]} />
      <Sign text="WATCH PARTY" color="#7ab8ff" bg="#14161f" position={[LANDMARKS.watch_party.x - 3.48, 4.9, LANDMARKS.watch_party.z]} size={[2.9, 1.3]} rotY={Math.PI / 2} />
      <Sign text="DINER" color="#ff5d73" position={[LANDMARKS.diner.x + 1.8, 3.3, LANDMARKS.diner.z + 0.92]} size={[1.8, 0.5]} />
      <Sign text="CREW ROW" color="#ffffff" bg="#8a5a2b" position={[blockRect(0, 2).x + GRID.block / 2 + 0.05, 1.5, blockRect(0, 2).z]} size={[2.6, 0.5]} rotY={Math.PI / 2} />
    </group>
  );
}
