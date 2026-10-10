"use client";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import ChibiCrowd, { type ChibiPerson } from "./chibi/Crowd";
import { ROOM, type Resident, makeCrowd, rng } from "./crowd";
import { findPath, makePlan, nearestFree, toTile, toWorld as planWorld } from "./plan";
import { type Body, step } from "./steer";
import { PerfProbe, SHOW_PERF } from "./PerfHud";
import { initTelegram } from "./telegram";

// The plan's week-1 phone test: one room, 60 residents and 10 dimmed away
// residents, all animated. Every body part is one instanced draw call for the
// whole crowd, so the room stays far inside the 100 to 150 draw-call budget.

// What blocks walking in the test room (world boxes, centre and size).
const SOLID: { c: [number, number]; s: [number, number] }[] = [
  { c: [-4, 4.3], s: [5, 1.1] }, // sofa
  { c: [-4, 4.75], s: [5, 0.3] },
  { c: [-4.8, 1.6], s: [1.6, 1] }, // tables
  { c: [-2.6, 1.4], s: [1.4, 1] },
  { c: [3, -ROOM.depth / 2 + 0.4], s: [3, 0.6] }, // shelf
  { c: [6.5, -2], s: [3.6, 1.2] }, // counter
  { c: [5.8, -0.9], s: [0.4, 0.4] }, // stools
  { c: [7.2, -0.9], s: [0.4, 0.4] },
  { c: [-ROOM.width / 2 + 0.6, -ROOM.depth / 2 + 0.6], s: [0.4, 0.4] }, // plant
];
const TEST_PLAN = makePlan(
  ROOM.width,
  ROOM.depth,
  SOLID.map(({ c, s }) => {
    const x0 = Math.floor(c[0] - s[0] / 2 + ROOM.width / 2);
    const y0 = Math.floor(c[1] - s[1] / 2 + ROOM.depth / 2);
    return { x: x0, y: y0, w: Math.ceil(c[0] + s[0] / 2 + ROOM.width / 2) - x0, d: Math.ceil(c[1] + s[1] / 2 + ROOM.depth / 2) - y0 };
  }),
);

// The crowd wanders the room on real paths (around the sofa, never through
// the counter), stands a moment, then picks a new free spot.
function TestCrowd({ crowd }: { crowd: Resident[] }) {
  const r = useMemo(() => rng(42), []);
  const people = useRef<(ChibiPerson & Body & { idle: number })[]>(
    crowd.map((c) => {
      const start = planWorld(TEST_PLAN, nearestFree(TEST_PLAN, toTile(TEST_PLAN, c.x, c.z))!);
      return { id: `test-${c.id}`, look: null, x: start.x, z: start.z, vx: 0, vz: 0, yaw: 0, moving: false, phase: c.phase, dim: c.away, path: [], idle: c.idle, speed: 1.2 + c.speed * (c.away ? 0.5 : 1) };
    }),
  );
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    for (const p of people.current) {
      if (p.path.length) continue;
      p.idle -= dt;
      if (p.idle <= 0) {
        const to = { x: Math.floor(r() * ROOM.width), y: Math.floor(r() * ROOM.depth) };
        p.path = findPath(TEST_PLAN, toTile(TEST_PLAN, p.x, p.z), to).map((t) => planWorld(TEST_PLAN, t));
        p.idle = 1 + r() * 4;
      }
    }
    // The same game movement as the live rooms: solid, steering, dodging.
    step(people.current, dt, TEST_PLAN);
    for (const p of people.current) {
      const sp = Math.hypot(p.vx, p.vz);
      p.moving = sp > 0.15;
      if (p.moving) p.phase += dt * 3.5 * sp;
    }
  });
  return <ChibiCrowd people={people} cap={crowd.length} />;
}

// A dark tiled floor, like a real flat, from a tiny generated texture.
function useTiles() {
  return useMemo(() => {
    const data = new Uint8Array([40, 42, 50, 255, 52, 55, 64, 255, 52, 55, 64, 255, 40, 42, 50, 255]);
    const t = new THREE.DataTexture(data, 2, 2);
    t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(ROOM.width / 2, ROOM.depth / 2);
    t.needsUpdate = true;
    return t;
  }, []);
}

const box = (key: string, pos: [number, number, number], size: [number, number, number], color: string) => (
  <mesh key={key} position={pos}>
    <boxGeometry args={size} />
    <meshStandardMaterial color={color} />
  </mesh>
);

// The room, cut away on the camera's side: two tall walls at the back, a low
// trim at the front, and enough furniture to read as a place.
function Room() {
  const tiles = useTiles();
  const W = ROOM.width;
  const D = ROOM.depth;
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={0}>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial map={tiles} />
      </mesh>
      {box("wall-back", [0, 1.3, -D / 2 - 0.1], [W + 0.4, 2.6, 0.2], "#e8b99a")}
      {box("wall-left", [-W / 2 - 0.1, 1.3, 0], [0.2, 2.6, D], "#efc6a8")}
      {box("trim-front", [0, 0.1, D / 2 + 0.1], [W + 0.4, 0.2, 0.2], "#e8b99a")}
      {box("trim-right", [W / 2 + 0.1, 0.1, 0], [0.2, 0.2, D], "#efc6a8")}
      {box("rug", [-4, 0.01, 2], [6, 0.02, 4], "#f0b8c4")}
      {box("sofa", [-4, 0.35, 4.3], [5, 0.7, 1.1], "#e7a3b3")}
      {box("sofa-back", [-4, 0.75, 4.75], [5, 0.8, 0.3], "#d9909f")}
      {box("table-1", [-4.8, 0.25, 1.6], [1.6, 0.5, 1], "#1e1a1a")}
      {box("table-2", [-2.6, 0.25, 1.4], [1.4, 0.5, 1], "#1e1a1a")}
      {box("tv", [-4, 1.4, -D / 2 + 0.15], [3.2, 1.8, 0.12], "#0d0f14")}
      {box("tv-glow", [-4, 1.4, -D / 2 + 0.22], [2.9, 1.5, 0.02], "#1d9e75")}
      {box("shelf", [3, 1.1, -D / 2 + 0.4], [3, 2.2, 0.6], "#f4f1ea")}
      {box("shelf-books", [3, 1.3, -D / 2 + 0.72], [2.6, 0.4, 0.05], "#534ab7")}
      {box("counter", [6.5, 0.5, -2], [3.5, 1, 1.1], "#f4f1ea")}
      {box("counter-top", [6.5, 1.02, -2], [3.6, 0.06, 1.2], "#2c2c2a")}
      {box("bar-stool-1", [5.8, 0.35, -0.9], [0.4, 0.7, 0.4], "#1e1a1a")}
      {box("bar-stool-2", [7.2, 0.35, -0.9], [0.4, 0.7, 0.4], "#1e1a1a")}
      {box("plant-pot", [-W / 2 + 0.6, 0.2, -D / 2 + 0.6], [0.4, 0.4, 0.4], "#f4f1ea")}
      {box("plant", [-W / 2 + 0.6, 0.8, -D / 2 + 0.6], [0.3, 0.9, 0.3], "#3b6d11")}
      {box("lamp", [0.5, 0.9, -D / 2 + 0.5], [0.1, 1.8, 0.1], "#ba7517")}
      {box("candle", [-7.5, 1.6, -D / 2 + 0.25], [0.5, 0.5, 0.1], "#ef9f27")}
    </group>
  );
}

export default function RoomTest() {
  const perf = useRef<HTMLDivElement>(null);
  const crowd = useMemo(() => makeCrowd(7), []);
  useEffect(() => {
    initTelegram();
  }, []);
  return (
    <>
      <div className="hud">
        <div className="pill">Room test · 60 here · 10 away</div>
        {SHOW_PERF && (
          <div className="perf" ref={perf}>
            measuring…
          </div>
        )}
      </div>
      <div className="stage">
        <Canvas dpr={[1, 2]} camera={{ position: [14, 15, 17], fov: 38 }} gl={{ antialias: true, powerPreference: "high-performance" }}>
          <color attach="background" args={["#dfeaf5"]} />
          <hemisphereLight args={["#ffffff", "#b9c7d6", 1.1]} />
          <directionalLight position={[8, 14, 6]} intensity={1.4} />
          <Room />
          <TestCrowd crowd={crowd} />
          <OrbitControls enablePan={false} minPolarAngle={0.5} maxPolarAngle={1.15} minDistance={12} maxDistance={34} target={[0, 0, 0]} />
          {SHOW_PERF && <PerfProbe target={perf} />}
        </Canvas>
      </div>
    </>
  );
}
