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
export function bake(scene: THREE.Object3D): { geometry: THREE.BufferGeometry; material: THREE.Material } | null {
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

// Night windows: the packs colour everything from one palette image, glass in
// pale blues. A mask of just those pixels becomes the glow map, so at night
// the windows light up warm and the walls stay dark. One per palette image.
const glowCache = new Map<THREE.Texture, THREE.Texture>();
function windowGlow(map: THREE.Texture | null): THREE.Texture | null {
  const img = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!map || !img || !img.width) return null;
  const hit = glowCache.get(map);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const r = d.data[i]!;
    const gr = d.data[i + 1]!;
    const b = d.data[i + 2]!;
    const glass = b > 150 && b > r + 45 && b > gr + 10; // clearly blue glass only
    d.data[i] = glass ? 255 : 0;
    d.data[i + 1] = glass ? 200 : 0;
    d.data[i + 2] = glass ? 120 : 0;
  }
  g.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = map.flipY;
  t.magFilter = map.magFilter;
  t.minFilter = map.minFilter;
  glowCache.set(map, t);
  return t;
}

function KitModel({ url, items, shadows, night }: { url: string; items: Placement[]; shadows: boolean; night: boolean }) {
  const gltf = useGLTF(url);
  const baked0 = useMemo(() => bake(gltf.scene), [gltf]);
  // Our own copy of the material, with the window glow wired in.
  const baked = useMemo(() => {
    if (!baked0) return null;
    const m = (baked0.material as THREE.MeshStandardMaterial).clone();
    // Roads and cars never glow (their palettes' blues are paint, not windows).
    const glow = /\/(roads|cars)\//.test(url) ? null : windowGlow(m.map);
    if (glow) {
      m.emissiveMap = glow;
      m.emissive = new THREE.Color("#ffffff");
    }
    return { geometry: baked0.geometry, material: m };
  }, [baked0]);
  useLayoutEffect(() => {
    const m = baked?.material as THREE.MeshStandardMaterial | undefined;
    if (m) m.emissiveIntensity = night ? 0.9 : 0;
  }, [baked, night]);
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
export default function Kit({ placements, shadows = true, night = false }: { placements: Placement[]; shadows?: boolean; night?: boolean }) {
  const byUrl = useMemo(() => {
    const m = new Map<string, Placement[]>();
    for (const p of placements) (m.get(p.url) ?? m.set(p.url, []).get(p.url)!).push(p);
    return [...m];
  }, [placements]);
  return (
    <>
      {byUrl.map(([url, items]) => (
        <KitModel key={url} url={url} items={items} shadows={shadows} night={night} />
      ))}
    </>
  );
}

// A kit model baked once, for components that move their own instances (cars).
export function useBaked(url: string) {
  const gltf = useGLTF(url);
  return useMemo(() => bake(gltf.scene), [gltf]);
}
