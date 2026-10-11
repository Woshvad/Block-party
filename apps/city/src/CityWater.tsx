"use client";
import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { CITY_SIZE, GRID, blockRect } from "./citygen";

// Reflective lagoon with a moving normal map, not a flat blue solid.
// One plane and one small texture; bridges and the Rollup retain their positions.
export default function CityWater({ night }: { night: boolean }) {
  const lagoon = blockRect(0, GRID.blocks - 1);
  const normal = useMemo(() => {
    const n = 128, data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = x / n * Math.PI * 2, v = y / n * Math.PI * 2;
      const i = (y * n + x) * 4;
      data[i] = 128 + Math.round(25 * Math.cos(u * 4 + v * 2) + 9 * Math.cos(u * 9 - v * 3));
      data[i + 1] = 128 + Math.round(20 * Math.cos(v * 5 + u * 2));
      data[i + 2] = 250; data[i + 3] = 255;
    }
    const t = new THREE.DataTexture(data, n, n);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(18, 3); t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }, []);
  useFrame((_, dt) => { normal.offset.x = (normal.offset.x + Math.min(dt, 0.1) * 0.009) % 1; normal.offset.y = (normal.offset.y + Math.min(dt, 0.1) * 0.006) % 1; });
  useEffect(() => () => normal.dispose(), [normal]);
  return <mesh rotation-x={-Math.PI / 2} position={[0, 0.077, lagoon.z]} receiveShadow>
    <planeGeometry args={[CITY_SIZE - 0.2, lagoon.d + GRID.road * 0.9]} />
    <meshStandardMaterial color={night ? "#183e50" : "#488b91"} normalMap={normal} normalScale={new THREE.Vector2(0.35, 0.35)} roughness={0.24} metalness={0.38} envMapIntensity={1.4} />
  </mesh>;
}
