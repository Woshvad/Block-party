import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { bake } from "../src/kitGeometry";

describe("city model material preservation", () => {
  it("keeps glass and masonry groups on a multi-material model", () => {
    const stone = new THREE.MeshStandardMaterial({ color: "#ddd8ca" });
    const glass = new THREE.MeshStandardMaterial({ color: "#618798", roughness: 0.1 });
    const source = new THREE.BoxGeometry();
    source.groups.forEach((g, i) => { g.materialIndex = i % 2; });
    const mesh = new THREE.Mesh(source, [stone, glass]);
    mesh.position.set(4, 2, -3);
    const result = bake(mesh)!;
    expect(result.material).toEqual([stone, glass]);
    expect(result.geometry.groups.map((g) => g.count)).toEqual([18, 18]);
    expect(result.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    result.geometry.computeBoundingBox();
    expect(result.geometry.boundingBox!.min.toArray()).toEqual([3.5, 1.5, -3.5]);
    expect(result.geometry.boundingBox!.max.toArray()).toEqual([4.5, 2.5, -2.5]);
    // Cached GLTF source data remains untouched.
    expect(source.index).not.toBeNull();
    expect(source.getAttribute("position").getX(0)).toBe(0.5);
    result.geometry.dispose(); source.dispose(); stone.dispose(); glass.dispose();
  });

  it("batches shared palette materials into a single draw call", () => {
    const material = new THREE.MeshStandardMaterial();
    const group = new THREE.Group();
    const source = new THREE.BoxGeometry();
    group.add(new THREE.Mesh(source, material));
    const second = new THREE.Mesh(source, material); second.position.x = 2; group.add(second);
    const result = bake(group)!;
    expect(result.material).toBe(material);
    expect(result.geometry.groups).toHaveLength(0);
    expect(result.geometry.getAttribute("position").count).toBe(72);
    result.geometry.dispose(); source.dispose(); material.dispose();
  });

  it("ignores empty scenes", () => { expect(bake(new THREE.Group())).toBeNull(); });
});
