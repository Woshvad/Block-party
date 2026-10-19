import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Keep each material's geometry together. Palette kits still cost one draw
// call; richer assets retain their glass, masonry and metal material slots.
export function bake(scene: THREE.Object3D): { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] } | null {
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const source = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    // A compressed model keeps quantized attributes (small integers standing
    // for -1 to 1, the real size on the node). Moved by the node's matrix in
    // place, they'd be squeezed back into that range, so they become floats first.
    for (const name of ["position", "normal", "uv"]) {
      const attr = source.getAttribute(name);
      if (attr && !(attr.array instanceof Float32Array)) source.setAttribute(name, floats(attr));
    }
    source.applyMatrix4(m.matrixWorld);
    if (!source.getAttribute("normal")) source.computeVertexNormals();
    if (!source.getAttribute("uv")) source.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(source.getAttribute("position").count * 2), 2));
    const materials = Array.isArray(m.material) ? m.material : [m.material];
    const groups = Array.isArray(m.material) ? source.groups : [{ start: 0, count: source.getAttribute("position").count, materialIndex: 0 }];
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material || !group.count) continue;
      const part = new THREE.BufferGeometry();
      for (const name of ["position", "normal", "uv"]) {
        const attr = source.getAttribute(name);
        const values = new Float32Array(group.count * attr.itemSize);
        for (let i = 0; i < group.count; i++) for (let j = 0; j < attr.itemSize; j++) values[i * attr.itemSize + j] = attr.getComponent(group.start + i, j);
        part.setAttribute(name, new THREE.BufferAttribute(values, attr.itemSize));
      }
      const bucket = buckets.get(material) ?? [];
      bucket.push(part); buckets.set(material, bucket);
    }
    source.dispose();
  });
  if (!buckets.size) return null;
  const materials = [...buckets.keys()];
  const parts = [...buckets.values()].map((xs) => {
    const merged = mergeGeometries(xs, false)!;
    xs.forEach((g) => g.dispose());
    return merged;
  });
  const geometry = mergeGeometries(parts, materials.length > 1)!;
  parts.forEach((g) => g.dispose());
  return { geometry, material: materials.length === 1 ? materials[0]! : materials };
}

function floats(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const values = new Float32Array(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i++) for (let j = 0; j < attr.itemSize; j++) values[i * attr.itemSize + j] = attr.getComponent(i, j);
  return new THREE.BufferAttribute(values, attr.itemSize);
}
