"use client";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { lightPlacements } from "./kitcity";
import { LANDMARKS } from "./citygen";

// Ground light pools share one instanced draw call. Only the two landmark
// accent lights affect surfaces; none creates an additional shadow map.
// The low quality tier goes without them (`lamps` false): every lit surface
// on screen pays for a point light.
export default function CityStreetGlow({ night, lamps = true }: { night: boolean; lamps?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const lights = useMemo(() => lightPlacements(), []);
  const texture = useMemo(() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,219,155,0.28)");
    gradient.addColorStop(0.3, "rgba(255,205,120,0.13)");
    gradient.addColorStop(1, "rgba(255,205,120,0)");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  useLayoutEffect(() => {
    const mesh = ref.current; if (!mesh) return;
    const o = new THREE.Object3D(); o.rotation.x = -Math.PI / 2;
    lights.forEach((p, i) => { o.position.set(p.x, 0.165, p.z); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix); });
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
  }, [lights]);
  useEffect(() => () => texture.dispose(), [texture]);
  const hall = LANDMARKS.city_hall, diner = LANDMARKS.diner;
  return <group visible={night}>
    <instancedMesh ref={ref} args={[undefined, undefined, lights.length]}>
      <planeGeometry args={[3, 3]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
    </instancedMesh>
    {lamps && <pointLight position={[hall.x, 2, hall.z + 4]} color="#ffd9a4" intensity={night ? 34 : 0} distance={11} decay={2} />}
    {lamps && <pointLight position={[diner.x, 2.2, diner.z + 1.8]} color="#ffd9a4" intensity={night ? 14 : 0} distance={6} decay={2} />}
  </group>;
}
