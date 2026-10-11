"use client";
import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

// A small, local sky environment: no HDR download or extra per-frame render.
// Reflections give glass and metal a sky to reflect, even on the low tier.
export default function CityAtmosphere({ night }: { night: boolean }) {
  const { gl, scene } = useThree();
  const environment = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const sky = ctx.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, night ? "#101b35" : "#a4c4de");
    sky.addColorStop(0.45, night ? "#566480" : "#f5e8cf");
    sky.addColorStop(0.55, night ? "#343d48" : "#b2b9ad");
    sky.addColorStop(1, night ? "#101820" : "#686958");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, 512, 256);
    const glow = ctx.createRadialGradient(360, 85, 0, 360, 85, 65);
    glow.addColorStop(0, night ? "#c0d0ef" : "#fff8df");
    glow.addColorStop(1, "transparent");
    ctx.fillStyle = glow; ctx.fillRect(285, 10, 150, 150);
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    const generator = new THREE.PMREMGenerator(gl);
    const target = generator.fromEquirectangular(texture);
    generator.dispose(); texture.dispose();
    return target;
  }, [gl, night]);
  useEffect(() => {
    const previous = scene.environment;
    const intensity = scene.environmentIntensity;
    scene.environment = environment.texture;
    scene.environmentIntensity = night ? 0.3 : 0.45;
    return () => { scene.environment = previous; scene.environmentIntensity = intensity; environment.dispose(); };
  }, [scene, environment, night]);
  return <fog attach="fog" args={[night ? "#17263b" : "#c7d5d4", 115, 240]} />;
}
