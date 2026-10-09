"use client";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ROOM, type Resident, animatedThisFrame, makeCrowd, rng, stepCrowd, walking } from "./crowd";
import { PerfProbe } from "./PerfHud";
import { initTelegram } from "./telegram";

// The plan's week-1 phone test: one room, 60 residents and 10 dimmed away
// residents, all animated. Every body part is one instanced draw call for the
// whole crowd, so the room stays far inside the 100 to 150 draw-call budget.

const SKIN = ["#f1c7a5", "#d9a47c", "#b97a52", "#8d5a3b", "#5e3a26"].map((c) => new THREE.Color(c));
const PANTS = ["#1f2433", "#2d3b5a", "#3a3a3a", "#4a3324"].map((c) => new THREE.Color(c));

const geo = {
  leg: new THREE.BoxGeometry(0.14, 0.45, 0.14).translate(0, -0.225, 0), // pivot at the hip
  arm: new THREE.BoxGeometry(0.1, 0.42, 0.1).translate(0, -0.21, 0), // pivot at the shoulder
  body: new THREE.BoxGeometry(0.38, 0.5, 0.22),
  head: new THREE.IcosahedronGeometry(0.16, 1),
  hair: new THREE.SphereGeometry(0.17, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
  blob: new THREE.CircleGeometry(0.32, 16).rotateX(-Math.PI / 2),
};

function Crowd({ crowd, away }: { crowd: Resident[]; away: boolean }) {
  const people = useMemo(() => crowd.filter((c) => c.away === away), [crowd, away]);
  const n = people.length;
  const refs = {
    legs: useRef<THREE.InstancedMesh>(null),
    arms: useRef<THREE.InstancedMesh>(null),
    body: useRef<THREE.InstancedMesh>(null),
    head: useRef<THREE.InstancedMesh>(null),
    hair: useRef<THREE.InstancedMesh>(null),
    blob: useRef<THREE.InstancedMesh>(null),
  };
  // Reused every frame: no allocation in the loop (garbage collection stutters on phones).
  const tmp = useMemo(() => ({ base: new THREE.Matrix4(), local: new THREE.Matrix4(), out: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1), yaw: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) }), []);
  const frame = useRef(0);
  const r = useMemo(() => rng(away ? 99 : 42), [away]);

  // Colours once: outfit by hue, skin and trousers from small palettes.
  useEffect(() => {
    const c = new THREE.Color();
    people.forEach((p, i) => {
      refs.body.current!.setColorAt(i, c.setHSL(p.hue, 0.55, away ? 0.75 : 0.55));
      refs.head.current!.setColorAt(i, SKIN[p.id % SKIN.length]!);
      refs.hair.current!.setColorAt(i, c.setHSL((p.hue + 0.5) % 1, 0.3, 0.2 + (p.id % 3) * 0.15));
      for (const k of [0, 1]) {
        refs.legs.current!.setColorAt(i * 2 + k, PANTS[p.id % PANTS.length]!);
        refs.arms.current!.setColorAt(i * 2 + k, SKIN[p.id % SKIN.length]!);
      }
    });
    for (const m of Object.values(refs)) if (m.current?.instanceColor) m.current.instanceColor.needsUpdate = true;
  }, [people, away]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(({ camera }, dt) => {
    const step = Math.min(dt, 0.1);
    stepCrowd(people, step, r);
    const animate = animatedThisFrame(people, { x: camera.position.x, z: camera.position.z }, frame.current++);
    people.forEach((p, i) => {
      if (!animate.has(p.id) && frame.current > 2) return;
      const moving = walking(p);
      const swing = moving ? Math.sin(p.phase) * 0.6 : 0;
      const bob = moving ? Math.abs(Math.sin(p.phase)) * 0.04 : 0;
      const face = Math.atan2(p.tx - p.x, p.tz - p.z);
      tmp.yaw.setFromAxisAngle(tmp.up, face);
      tmp.base.compose(tmp.v.set(p.x, 0, p.z), tmp.yaw, tmp.one);
      const place = (m: THREE.InstancedMesh, idx: number, lx: number, ly: number, rx: number) => {
        tmp.local.compose(tmp.v.set(lx, ly + bob, 0), tmp.q.setFromEuler(tmp.e.set(rx, 0, 0)), tmp.one);
        m.setMatrixAt(idx, tmp.out.multiplyMatrices(tmp.base, tmp.local));
      };
      place(refs.legs.current!, i * 2, -0.09, 0.45, swing);
      place(refs.legs.current!, i * 2 + 1, 0.09, 0.45, -swing);
      place(refs.arms.current!, i * 2, -0.25, 0.92, -swing * 0.8);
      place(refs.arms.current!, i * 2 + 1, 0.25, 0.92, swing * 0.8);
      place(refs.body.current!, i, 0, 0.7, 0);
      place(refs.head.current!, i, 0, 1.13, 0);
      place(refs.hair.current!, i, 0, 1.16, 0);
      place(refs.blob.current!, i, 0, 0.01 - bob, 0);
    });
    for (const m of Object.values(refs)) if (m.current) m.current.instanceMatrix.needsUpdate = true;
  });

  const mat = (extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    away ? <meshStandardMaterial transparent opacity={0.38} depthWrite={false} {...extra} /> : <meshStandardMaterial {...extra} />;
  return (
    <group>
      <instancedMesh ref={refs.legs} args={[geo.leg, undefined, n * 2]}>{mat()}</instancedMesh>
      <instancedMesh ref={refs.arms} args={[geo.arm, undefined, n * 2]}>{mat()}</instancedMesh>
      <instancedMesh ref={refs.body} args={[geo.body, undefined, n]}>{mat()}</instancedMesh>
      <instancedMesh ref={refs.head} args={[geo.head, undefined, n]}>{mat({ flatShading: true })}</instancedMesh>
      <instancedMesh ref={refs.hair} args={[geo.hair, undefined, n]}>{mat()}</instancedMesh>
      <instancedMesh ref={refs.blob} args={[geo.blob, undefined, n]}>
        <meshBasicMaterial color="#000000" transparent opacity={away ? 0.08 : 0.18} depthWrite={false} />
      </instancedMesh>
    </group>
  );
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
        <div className="perf" ref={perf}>measuring…</div>
      </div>
      <div className="stage">
        <Canvas dpr={[1, 2]} camera={{ position: [14, 15, 17], fov: 38 }} gl={{ antialias: true, powerPreference: "high-performance" }}>
          <color attach="background" args={["#dfeaf5"]} />
          <hemisphereLight args={["#ffffff", "#b9c7d6", 1.1]} />
          <directionalLight position={[8, 14, 6]} intensity={1.4} />
          <Room />
          <Crowd crowd={crowd} away={false} />
          <Crowd crowd={crowd} away />
          <OrbitControls enablePan={false} minPolarAngle={0.5} maxPolarAngle={1.15} minDistance={12} maxDistance={34} target={[0, 0, 0]} />
          <PerfProbe target={perf} />
        </Canvas>
      </div>
    </>
  );
}
