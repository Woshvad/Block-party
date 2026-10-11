"use client";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buildDinerQuarter, buildQuarterSigns, QUARTER_SIGNS } from "./dinerArchitecture";
import { citySurface } from "./citySurface";

export default function DinerQuarter({ night }: { night: boolean }) {
  const geometry = useMemo(() => buildDinerQuarter(), []);
  const signs = useMemo(() => buildQuarterSigns(), []);
  const lettering = useMemo(() => {
    const c = document.createElement("canvas"); c.width = 1024; c.height = 640;
    const ctx = c.getContext("2d")!;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#f5e7c9"; ctx.font = "600 58px Georgia, serif";
    QUARTER_SIGNS.forEach((name, i) => ctx.fillText(name, 512, i * 128 + 64, 950));
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }, []);
  useEffect(() => () => { signs.dispose(); lettering.dispose(); }, [signs, lettering]);
  const masonry = useMemo(() => citySurface(), []);
  useEffect(() => () => { Object.values(geometry).forEach((g) => g.dispose()); masonry.dispose(); }, [geometry, masonry]);
  return <group>
    <mesh geometry={signs}>
      <meshBasicMaterial map={lettering} transparent depthWrite={false} toneMapped={false} color={night ? "#cfc4ad" : "#ffffff"} />
    </mesh>
    <mesh geometry={geometry.stone} material={masonry} castShadow receiveShadow />
    <mesh geometry={geometry.glass} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.19} metalness={0.35} envMapIntensity={1.2} emissive={night ? "#ecc587" : "#000000"} emissiveIntensity={night ? 0.34 : 0} />
    </mesh>
    <mesh geometry={geometry.metal} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.32} metalness={0.7} envMapIntensity={1.15} />
    </mesh>
    <mesh geometry={geometry.fabric} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.93} />
    </mesh>
  </group>;
}
