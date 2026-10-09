"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type * as THREE from "three";
import type { Look } from "./api";
import { HAIR, OUTFIT, SKIN } from "./palette";

// The move-in preview: the same blocky build as the room crowd, turning
// slowly. Faces and finer parts arrive with the real low-poly kit.

const n = (id: string) => Number(/\d+$/.exec(id)?.[0] ?? 0);
const shade = (hex: string, f: number) => {
  const v = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.max(0, Math.min(255, Math.round(((v >> s) & 255) * f)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
};

function Body({ look }: { look: Look }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (g.current) g.current.rotation.y += Math.min(dt, 0.1) * 0.6;
  });
  const skin = SKIN[look.skinTone] ?? SKIN[0]!;
  const hair = HAIR[look.hairColor] ?? HAIR[0]!;
  const top = OUTFIT[look.outfitColor] ?? OUTFIT[0]!;
  const bottom = shade(top, 0.45);
  const wide = 0.34 + n(look.bodyType) * 0.04; // body1..3: slim to broad
  const hairH = look.hair === "none" ? 0 : 0.06 + (n(look.hair) % 4) * 0.05;
  return (
    <group ref={g} position-y={-0.6}>
      {[-1, 1].map((s) => (
        <mesh key={`l${s}`} position={[s * 0.09, 0.225, 0]}>
          <boxGeometry args={[0.14, 0.45, 0.14]} />
          <meshStandardMaterial color={bottom} />
        </mesh>
      ))}
      {[-1, 1].map((s) => (
        <mesh key={`s${s}`} position={[s * 0.09, 0.03, 0.03]}>
          <boxGeometry args={[0.15, 0.06, 0.2]} />
          <meshStandardMaterial color={shade(OUTFIT[(look.outfitColor + n(look.shoes) * 3) % OUTFIT.length]!, 0.7)} />
        </mesh>
      ))}
      <mesh position-y={0.7}>
        <boxGeometry args={[wide, 0.5, 0.22]} />
        <meshStandardMaterial color={top} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={`a${s}`} position={[s * (wide / 2 + 0.06), 0.72, 0]}>
          <boxGeometry args={[0.1, 0.42, 0.1]} />
          <meshStandardMaterial color={skin} />
        </mesh>
      ))}
      <mesh position-y={1.13}>
        <icosahedronGeometry args={[0.16, 1]} />
        <meshStandardMaterial color={skin} flatShading />
      </mesh>
      {/* eyes: so the turn reads as a face */}
      {[-1, 1].map((s) => (
        <mesh key={`e${s}`} position={[s * 0.055, 1.15, 0.15]}>
          <boxGeometry args={[0.03, 0.04, 0.01]} />
          <meshBasicMaterial color="#14161f" />
        </mesh>
      ))}
      {hairH > 0 && (
        <group>
          {/* a cap of hair above the eyes, and down the back of the head */}
          <mesh position={[0, 1.22 + (hairH + 0.04) / 2, -0.01]}>
            <boxGeometry args={[0.34, hairH + 0.04, 0.34]} />
            <meshStandardMaterial color={hair} />
          </mesh>
          <mesh position={[0, 1.13, -0.13]}>
            <boxGeometry args={[0.34, 0.2, 0.08]} />
            <meshStandardMaterial color={hair} />
          </mesh>
        </group>
      )}
      {look.hat !== "none" && (
        <group position-y={1.32 + hairH}>
          <mesh>
            <cylinderGeometry args={[0.2, 0.2, 0.12, 12]} />
            <meshStandardMaterial color={shade(OUTFIT[(n(look.hat) * 5) % OUTFIT.length]!, 0.9)} />
          </mesh>
          <mesh position={[0, -0.05, 0.14]}>
            <boxGeometry args={[0.34, 0.02, 0.18]} />
            <meshStandardMaterial color={shade(OUTFIT[(n(look.hat) * 5) % OUTFIT.length]!, 0.7)} />
          </mesh>
        </group>
      )}
      {look.glasses !== "none" && (
        <mesh position={[0, 1.15, 0.16]}>
          <boxGeometry args={[0.26, 0.06, 0.02]} />
          <meshStandardMaterial color={n(look.glasses) % 2 ? "#14161f" : "#ba7517"} />
        </mesh>
      )}
    </group>
  );
}

export default function Avatar({ look }: { look: Look }) {
  return (
    <Canvas dpr={[1, 2]} camera={{ position: [0, 0.3, 3.3], fov: 30 }} onCreated={({ camera }) => camera.lookAt(0, 0.15, 0)} gl={{ antialias: true }}>
      <hemisphereLight args={["#ffffff", "#b9c7d6", 1.2]} />
      <directionalLight position={[2, 3, 2]} intensity={1.3} />
      <Body look={look} />
      <mesh rotation-x={-Math.PI / 2} position-y={-0.6}>
        <circleGeometry args={[0.45, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.12} />
      </mesh>
    </Canvas>
  );
}
