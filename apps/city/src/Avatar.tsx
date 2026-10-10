"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Look } from "./api";
import ChibiCrowd, { type ChibiPerson } from "./chibi/Crowd";

// The move-in preview: one resident from the same chibi renderer the rooms
// use (so what you pick is exactly what the city shows), turning slowly.

function Turn({ who, look }: { who: React.MutableRefObject<ChibiPerson[]>; look: Look }) {
  useFrame((_, dt) => {
    const p = who.current[0]!;
    p.look = look;
    p.yaw += Math.min(dt, 0.1) * 0.6;
  });
  return null;
}

export default function Avatar({ look }: { look: Look }) {
  const who = useRef<ChibiPerson[]>([{ id: "preview", look, x: 0, z: 0, yaw: 0.4, moving: false, phase: 0 }]);
  return (
    <Canvas dpr={[1, 2]} camera={{ position: [0, 0.75, 3.1], fov: 30 }} onCreated={({ camera }) => camera.lookAt(0, 0.62, 0)} gl={{ antialias: true }}>
      <hemisphereLight args={["#ffffff", "#c9c2b6", 1.1]} />
      <directionalLight position={[2, 4, 3]} intensity={1.5} />
      <Turn who={who} look={look} />
      <ChibiCrowd people={who} cap={1} />
    </Canvas>
  );
}
