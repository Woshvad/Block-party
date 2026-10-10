"use client";
import { useGLTF } from "@react-three/drei";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Placement } from "./kitcity";

// Kenney's City Kit models (CC0, see public/assets/kenney/*/License.txt),
// drawn the cheap way: each model becomes ONE instanced mesh holding every
// copy of it in the city. A pack shares one colour texture, so a whole street
// of houses is a handful of draw calls.

// One model's meshes baked into a single geometry (transforms applied).
function bake(scene: THREE.Object3D): { geometry: THREE.BufferGeometry; material: THREE.Material } | null {
  const parts: THREE.BufferGeometry[] = [];
  let material: THREE.Material | null = null;
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
    parts.push(g);
    material ??= Array.isArray(m.material) ? m.material[0]! : m.material;
  });
  if (!parts.length || !material) return null;
  return { geometry: mergeGeometries(parts, false)!, material };
}

function KitModel({ url, items, shadows }: { url: string; items: Placement[]; shadows: boolean }) {
  const gltf = useGLTF(url);
  const baked = useMemo(() => bake(gltf.scene), [gltf]);
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new THREE.Object3D();
    items.forEach((p, i) => {
      o.position.set(p.x, p.y ?? 0, p.z);
      o.rotation.set(0, p.rotY ?? 0, 0);
      const s = p.scale ?? 1;
      if (Array.isArray(s)) o.scale.set(...s);
      else o.scale.setScalar(s);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!baked) return null;
  return <instancedMesh ref={ref} args={[baked.geometry, baked.material, items.length]} castShadow={shadows} receiveShadow />;
}

// Everything placed, grouped by model.
export default function Kit({ placements, shadows = true }: { placements: Placement[]; shadows?: boolean }) {
  const byUrl = useMemo(() => {
    const m = new Map<string, Placement[]>();
    for (const p of placements) (m.get(p.url) ?? m.set(p.url, []).get(p.url)!).push(p);
    return [...m];
  }, [placements]);
  return (
    <>
      {byUrl.map(([url, items]) => (
        <KitModel key={url} url={url} items={items} shadows={shadows} />
      ))}
    </>
  );
}
