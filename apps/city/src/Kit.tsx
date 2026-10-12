"use client";
import { useGLTF } from "@react-three/drei";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { bake } from "./kitGeometry";
export { bake } from "./kitGeometry";
import type { Placement } from "./kitcity";
import { failedAsset, noteModelAsked, noteModelLoaded, takeFailedModels } from "./sceneHealth";
import { type LoadedGltf, glowFor, shareModelImages } from "./kitTextures";

// Kenney's City Kit models (CC0, see public/assets/kenney/*/License.txt),
// drawn the cheap way: each model becomes ONE instanced mesh holding every
// copy of it in the city. A pack shares one colour texture, so a whole street
// of houses is a handful of draw calls.

// Night windows: the packs colour everything from one palette image, glass in
// pale blues. A mask of just those pixels becomes the glow map, so at night
// the windows light up warm and the walls stay dark. One per palette image
// (kitTextures.ts shares the image between a pack's models).
function windowGlow(map: THREE.Texture | null): THREE.Texture | null {
  const img = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!map || !img || !img.width) return null;
  return glowFor(map, buildGlow);
}
function buildGlow(map: THREE.Texture): THREE.Texture {
  const img = map.image as CanvasImageSource & { width: number; height: number };
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
  return t;
}

// A kit model, noted so a failed download can be retried (see sceneHealth.ts),
// with its palette shared with the rest of its pack (see kitTextures.ts).
function useModel(url: string) {
  noteModelAsked(url);
  const gltf = useGLTF(url);
  noteModelLoaded(url);
  shareModelImages(url, gltf as unknown as LoadedGltf);
  return gltf;
}

// For the scene's Try again: the loader keeps a failed download's error for
// good, so drop every model that never arrived (and the one the error names)
// and the next mount downloads them again.
export function clearFailedModels(error?: unknown) {
  const urls = new Set(takeFailedModels());
  const named = failedAsset(error);
  if (named) urls.add(named);
  for (const url of urls) useGLTF.clear(url);
}

function KitModel({ url, items, shadows, night }: { url: string; items: Placement[]; shadows: boolean; night: boolean }) {
  const gltf = useModel(url);
  const baked0 = useMemo(() => bake(gltf.scene), [gltf]);
  // Our own copy of the material, with the window glow wired in.
  const baked = useMemo(() => {
    if (!baked0) return null;
    const source = Array.isArray(baked0.material) ? baked0.material : [baked0.material];
    const materials = source.map((original) => {
      const m = (original as THREE.MeshStandardMaterial).clone();
      const paletteKit = url.startsWith("/assets/kenney/");
      const glow = paletteKit && !/\/(roads|cars)\//.test(url) ? windowGlow(m.map) : null;
      if (glow) { m.emissiveMap = glow; m.emissive = new THREE.Color("#ffffff"); m.userData.cityWindowGlow = true; }
      if (paletteKit) {
        m.roughness = /\/roads\//.test(url) ? 0.96 : 0.72;
        m.envMapIntensity = 0.45;
      }
      return m;
    });
    return { geometry: baked0.geometry, materials, material: materials.length === 1 ? materials[0]! : materials };
  }, [baked0, url]);
  useLayoutEffect(() => {
    baked?.materials.forEach((m) => { if (m.userData.cityWindowGlow) m.emissiveIntensity = night ? 0.55 : 0; });
  }, [baked, night]);
  useEffect(() => () => { baked?.materials.forEach((m) => m.dispose()); }, [baked]);
  useEffect(() => () => { baked0?.geometry.dispose(); }, [baked0]);
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

// Everything placed, grouped by model. Each model waits for its own download
// only, so the city fills in as models arrive (roads are asked for first)
// instead of showing nothing until the last one lands.
export default function Kit({ placements, shadows = true, night = false }: { placements: Placement[]; shadows?: boolean; night?: boolean }) {
  const byUrl = useMemo(() => {
    const m = new Map<string, Placement[]>();
    for (const p of placements) (m.get(p.url) ?? m.set(p.url, []).get(p.url)!).push(p);
    return [...m];
  }, [placements]);
  return (
    <>
      {byUrl.map(([url, items]) => (
        <Suspense key={url} fallback={null}>
          <KitModel url={url} items={items} shadows={shadows} night={night} />
        </Suspense>
      ))}
    </>
  );
}

// A kit model baked once, for components that move their own instances (cars).
export function useBaked(url: string) {
  const gltf = useModel(url);
  const baked = useMemo(() => bake(gltf.scene), [gltf]);
  useEffect(() => () => { baked?.geometry.dispose(); }, [baked]);
  return baked;
}
