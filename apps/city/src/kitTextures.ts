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
// file to name: a picture packed inside the model, or a texture the loader
// copied without saying where from. Those keep their own copy.
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

// Points the texture at the shared source for its file. The first texture
// seen for a file lends its own source; a later one's copy is no longer used,
// so a decoded bitmap is closed at once rather than left for the collector.
export function shareImage(key: string, texture: THREE.Texture) {
  const shared = sources.get(key);
  if (!shared) {
    sources.set(key, texture.source);
    return;
  }
  if (texture.source === shared) return;
  const own = texture.source.data as { close?: () => void } | null;
  texture.source = shared;
  if (own && own !== shared.data && typeof own.close === "function") own.close();
}

// Every texture in a freshly loaded model, pointed at the shared sources.
// Once per model: the loader caches the model, so this runs on its first use.
const done = new WeakSet<object>();
export function shareModelImages(modelUrl: string, gltf: LoadedGltf) {
  if (done.has(gltf)) return;
  done.add(gltf);
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) {
        const texture = value as THREE.Texture | null;
        if (!texture?.isTexture) continue;
        const key = imageUrl(modelUrl, gltf, texture);
        if (key) shareImage(key, texture);
      }
    }
  });
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
