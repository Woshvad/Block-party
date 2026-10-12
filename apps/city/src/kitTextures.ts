import type * as THREE from "three";

// Kit pictures, shared. Every model in a Kenney pack is coloured from the
// same palette image (Textures/colormap.png), but the loader reads each model
// on its own, so each one arrives with its own copy of the picture: about 70
// copies for the city, each uploaded to the GPU and each given its own window
// glow mask. three.js uploads one GPU texture per image source, so here every
// texture that reads the same file is pointed at one shared source. A pack's
// palette is then uploaded once, and its glow mask built once.

// The parts of a loaded glTF this reads: its JSON, and which of its textures
// each three.js texture was made from.
export type LoadedGltf = {
  scene: THREE.Object3D;
  parser: {
    json: { textures?: { source?: number }[]; images?: { uri?: string }[] };
    associations: Map<object, { textures?: number } | undefined>;
  };
};

const LOCAL = "http://local.invalid";

// The file a model's texture was read from, as a path next to the model
// ("/assets/kenney/roads/Textures/colormap.png"), or null when there's no
// file to name: a picture packed inside the model (it keeps its own copy),
// or a texture the loader copied without saying where from (a texCoord 1
// slot is a clone of the map; it follows its source, see shareModelImages).
export function imageUrl(modelUrl: string, gltf: Pick<LoadedGltf, "parser">, texture: object): string | null {
  const index = gltf.parser.associations.get(texture)?.textures;
  if (index === undefined) return null;
  const source = gltf.parser.json.textures?.[index]?.source;
  const uri = source === undefined ? undefined : gltf.parser.json.images?.[source]?.uri;
  if (!uri || uri.startsWith("data:")) return null;
  const url = new URL(uri, new URL(modelUrl, `${LOCAL}/`));
  return url.origin === LOCAL ? url.pathname + url.search : url.href;
}

// One source per image file, kept for the life of the page like the loader's
// own cache. The GPU copy belongs to the renderer and goes with it.
const sources = new Map<string, THREE.Source>();

// The shared source for a file. The first source seen for it is the one
// everyone shares.
function sharedSource(key: string, own: THREE.Source): THREE.Source {
  const shared = sources.get(key);
  if (shared) return shared;
  sources.set(key, own);
  return own;
}

// Every texture in a freshly loaded model, pointed at the shared sources.
// Once per model: the loader caches the model, so this runs on its first use.
// It goes by source, not texture: the loader gives a texCoord 1 slot a clone
// of the map, sharing the map's source but untraceable to a file, and a
// clone left on a source whose picture was closed would draw nothing. So
// every texture on a replaced source moves, and only then is the replaced
// copy's decoded bitmap closed (rather than left for the collector).
const done = new WeakSet<object>();
export function shareModelImages(modelUrl: string, gltf: LoadedGltf) {
  if (done.has(gltf)) return;
  done.add(gltf);
  const textures = new Set<THREE.Texture>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) {
        const texture = value as THREE.Texture | null;
        if (texture?.isTexture) textures.add(texture);
      }
    }
  });
  const swap = new Map<THREE.Source, THREE.Source>();
  for (const texture of textures) {
    if (swap.has(texture.source)) continue;
    const key = imageUrl(modelUrl, gltf, texture);
    if (key) swap.set(texture.source, sharedSource(key, texture.source));
  }
  for (const texture of textures) {
    const shared = swap.get(texture.source);
    if (shared) texture.source = shared;
  }
  for (const [own, shared] of swap) {
    const bitmap = own.data as { close?: () => void } | null;
    if (own !== shared && bitmap && bitmap !== shared.data && typeof bitmap.close === "function") bitmap.close();
  }
}

// The night window mask (see Kit.tsx), built once per image source rather
// than once per model.
const glows = new WeakMap<THREE.Source, THREE.Texture>();
export function glowFor(map: THREE.Texture, build: (map: THREE.Texture) => THREE.Texture | null): THREE.Texture | null {
  const hit = glows.get(map.source);
  if (hit) return hit;
  const made = build(map);
  if (made) glows.set(map.source, made);
  return made;
}

// For tests: forget every shared source.
export function forgetSharedImages() {
  sources.clear();
}
