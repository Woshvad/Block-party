import { beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { type LoadedGltf, forgetSharedImages, glowFor, imageUrl, shareModelImages } from "../src/kitTextures";

// A decoded picture, standing in for the ImageBitmap the loader makes.
class Bitmap {
  closed = false;
  constructor(readonly width = 512, readonly height = 512) {}
  close() {
    this.closed = true;
  }
}

// A model as the glTF loader hands it over: one mesh per material, each
// material's map made from texture 0, which reads `uri`.
function model(uri: string | undefined, materials = 1): { gltf: LoadedGltf; maps: THREE.Texture[] } {
  const scene = new THREE.Group();
  const associations = new Map<object, { textures?: number }>();
  const map = new THREE.Texture(new Bitmap());
  associations.set(map, { textures: 0 });
  const maps: THREE.Texture[] = [];
  for (let i = 0; i < materials; i++) {
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map })));
    maps.push(map);
  }
  const images = uri === undefined ? [{}] : [{ uri }];
  return { gltf: { scene, parser: { json: { textures: [{ source: 0 }], images }, associations } }, maps };
}

beforeEach(() => forgetSharedImages());

describe("which file a kit texture came from", () => {
  it("resolves the image next to the model", () => {
    const { gltf, maps } = model("Textures/colormap.png");
    expect(imageUrl("/assets/kenney/roads/road-straight.glb", gltf, maps[0]!)).toBe("/assets/kenney/roads/Textures/colormap.png");
    expect(imageUrl("/assets/kenney/commercial/building-a.glb", gltf, maps[0]!)).toBe("/assets/kenney/commercial/Textures/colormap.png");
    expect(imageUrl("https://cdn.example/kit/cars/taxi.glb", gltf, maps[0]!)).toBe("https://cdn.example/kit/cars/Textures/colormap.png");
  });

  it("names no file for a packed picture or a texture it can't trace", () => {
    const packed = model(undefined);
    expect(imageUrl("/assets/a.glb", packed.gltf, packed.maps[0]!)).toBeNull();
    const inline = model("data:image/png;base64,AAAA");
    expect(imageUrl("/assets/a.glb", inline.gltf, inline.maps[0]!)).toBeNull();
    const { gltf } = model("Textures/colormap.png");
    expect(imageUrl("/assets/a.glb", gltf, new THREE.Texture())).toBeNull();
  });
});

describe("sharing a pack's palette", () => {
  it("gives every model in a pack one image source, and closes the extra copies", () => {
    const a = model("Textures/colormap.png");
    const b = model("Textures/colormap.png");
    const firstBitmap = a.maps[0]!.source.data as Bitmap;
    const secondBitmap = b.maps[0]!.source.data as Bitmap;
    shareModelImages("/assets/kenney/commercial/building-a.glb", a.gltf);
    shareModelImages("/assets/kenney/commercial/building-b.glb", b.gltf);
    expect(b.maps[0]!.source).toBe(a.maps[0]!.source);
    expect(secondBitmap.closed).toBe(true);
    expect(firstBitmap.closed).toBe(false);
  });

  it("keeps packs apart, and leaves a packed picture alone", () => {
    const shop = model("Textures/colormap.png");
    const road = model("Textures/colormap.png");
    const packed = model(undefined);
    const packedSource = packed.maps[0]!.source;
    shareModelImages("/assets/kenney/commercial/building-a.glb", shop.gltf);
    shareModelImages("/assets/kenney/roads/road-straight.glb", road.gltf);
    shareModelImages("/assets/kenney/roads/odd.glb", packed.gltf);
    expect(road.maps[0]!.source).not.toBe(shop.maps[0]!.source);
    expect(packed.maps[0]!.source).toBe(packedSource);
    expect((road.maps[0]!.source.data as Bitmap).closed).toBe(false);
  });

  it("handles a model once, however often it's used", () => {
    const a = model("Textures/colormap.png");
    shareModelImages("/assets/kenney/suburban/house.glb", a.gltf);
    const source = a.maps[0]!.source;
    shareModelImages("/assets/kenney/suburban/house.glb", a.gltf);
    expect(a.maps[0]!.source).toBe(source);
    expect((source.data as Bitmap).closed).toBe(false);
  });

  it("builds one glow mask per shared image, not one per model", () => {
    const models = [model("Textures/colormap.png"), model("Textures/colormap.png"), model("Textures/colormap.png")];
    models.forEach((m, i) => shareModelImages(`/assets/kenney/commercial/building-${i}.glb`, m.gltf));
    let built = 0;
    const build = () => {
      built++;
      return new THREE.Texture();
    };
    const masks = models.map((m) => glowFor(m.maps[0]!, build));
    expect(built).toBe(1);
    expect(new Set(masks).size).toBe(1);
    const other = model("Textures/colormap.png");
    shareModelImages("/assets/kenney/industrial/factory.glb", other.gltf);
    expect(glowFor(other.maps[0]!, build)).not.toBe(masks[0]);
    expect(built).toBe(2);
  });
});
