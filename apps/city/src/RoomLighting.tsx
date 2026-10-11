"use client";
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import * as THREE from "three";
import { fitCamera } from "./camera";

export function RoomCamera({ w, h }: { w: number; h: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  useEffect(() => {
    const diagonal = Math.hypot(w, h);
    const visible = Math.max(diagonal + 2, (diagonal * 0.65 + 4) * aspect);
    const { fov, distance } = fitCamera(aspect, visible, { min: diagonal * 0.8, max: diagonal * 8 });
    camera.fov = fov;
    camera.position.copy(new THREE.Vector3(0.55, 0.8, 0.95).normalize()).multiplyScalar(distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, aspect, w, h]);
  return null;
}

// One shadow map for the room, with warm window light and a cool sky fill.
// Local accents do not cast shadows, keeping the cost bounded on phones.
export function RoomLighting({ span, outdoor = false }: { span: number; outdoor?: boolean }) {
  return <>
    <color attach="background" args={[outdoor ? "#d5e5ea" : "#e9e4db"]} />
    <hemisphereLight args={["#e8f3ff", "#ad8d71", 1.5]} />
    <directionalLight position={[span * 0.35, span * 0.9, span * 0.4]} color="#fff1d9" intensity={2.4} castShadow
      shadow-mapSize={[1024, 1024]} shadow-camera-left={-span} shadow-camera-right={span}
      shadow-camera-top={span} shadow-camera-bottom={-span} shadow-camera-far={span * 4}
      shadow-bias={-0.0003} shadow-normalBias={0.025} shadow-radius={3} />
    <directionalLight position={[-span, span * 0.4, -span * 0.3]} color="#b9d9f0" intensity={0.5} />
    {!outdoor && <pointLight position={[0, 3, -span * 0.28]} color="#ffd49a" intensity={12} distance={span} decay={2} />}
  </>;
}
