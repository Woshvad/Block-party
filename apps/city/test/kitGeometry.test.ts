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

  it("bakes a compressed model's quantized attributes in floats, so the node's scale isn't squeezed back into their range", () => {
    // How glTF-Transform's meshopt output arrives: positions as normalized
    // int16 in [-1, 1] with the real size on the node, normals as int8, uvs as uint16.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Int16Array([-32767, 0, 0, 32767, 0, 0, 0, 32767, 0]), 3, true));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]), 3, true));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Uint16Array([0, 0, 65535, 0, 0, 65535]), 2, true));
    geometry.setIndex([0, 1, 2]);
    const material = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(4, 4, 4);
    mesh.position.set(10, 0, 0);
    const result = bake(mesh)!;
    const position = result.geometry.getAttribute("position");
    expect(position.array).toBeInstanceOf(Float32Array);
    expect([0, 1, 2].map((i) => [position.getX(i), position.getY(i)])).toEqual([[6, 0], [14, 0], [10, 4]]);
    const normal = result.geometry.getAttribute("normal");
    expect([normal.getX(0), normal.getY(0), normal.getZ(0)]).toEqual([0, 0, 1]);
    const uv = result.geometry.getAttribute("uv");
    expect([uv.getX(1), uv.getY(2)]).toEqual([1, 1]);
    // The cached source stays as it came.
    expect(geometry.getAttribute("position").array).toBeInstanceOf(Int16Array);
    result.geometry.dispose(); geometry.dispose(); material.dispose();
  });
});
