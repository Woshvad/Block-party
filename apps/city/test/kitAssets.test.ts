import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cityPlacements, lotPlacements } from "../src/kitcity";
import { fillCity } from "../src/citygen";
import { CAR_MODELS, KIT, KIT_PACK_NAMES, kitDir, kitUrls } from "../src/kitModels";

// The kit's files on disk, as the addresses the city asks for them by.
const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));
const KENNEY = join(PUBLIC, "assets", "kenney");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const urlOf = (path: string) => "/" + relative(PUBLIC, path).split(sep).join("/");
const shipped = () => walk(KENNEY).map(urlOf);
const onDisk = (url: string) => existsSync(join(PUBLIC, ...url.split("/").filter(Boolean)));

// A GLB's JSON chunk.
function glbJson(path: string): { images?: { uri?: string; bufferView?: number }[] } {
  const buf = readFileSync(path);
  expect(buf.readUInt32LE(0), path).toBe(0x46546c67); // "glTF"
  expect(buf.readUInt32LE(8), path).toBe(buf.length);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
}

describe("the kit's files", () => {
  it("every model the code can ask for is there", () => {
    const missing = kitUrls().filter((u) => !onDisk(u));
    expect(missing).toEqual([]);
  });

  it("the city only asks for listed models, whatever the seed", () => {
    const listed = new Set(kitUrls());
    const asked = new Set([...cityPlacements(), ...[1, 2, 3, 42, 99].flatMap((seed) => lotPlacements(fillCity(seed)))].map((p) => p.url));
    for (const m of CAR_MODELS) asked.add(KIT.cars(m));
    expect([...asked].filter((u) => !listed.has(u))).toEqual([]);
    expect(asked.size).toBeGreaterThan(50);
  });

  it("KIT takes only listed names (typecheck fails otherwise)", () => {
    // @ts-expect-error: not a model the city ships
    expect(KIT.roads("road-bend")).toBe("/assets/kenney/roads/road-bend.glb");
  });

  it("ships no model nothing asks for", () => {
    const listed = new Set(kitUrls());
    const unused = shipped().filter((u) => u.endsWith(".glb") && !listed.has(u));
    expect(unused).toEqual([]);
  });

  it("each model's palette is a file next to it, never packed inside", () => {
    // kitTextures.ts shares a pack's palette by its file name; a picture packed
    // into the model would be uploaded once per model instead.
    for (const url of kitUrls()) {
      const path = join(PUBLIC, ...url.split("/").filter(Boolean));
      const images = glbJson(path).images ?? [];
      expect(images.length, url).toBeGreaterThan(0);
      for (const image of images) {
        expect(image.bufferView, url).toBeUndefined();
        expect(image.uri, url).toBe("Textures/colormap.png");
        expect(onDisk(new URL(image.uri!, `http://x${url}`).pathname), url).toBe(true);
      }
    }
  });

  it("every pack ships its CC0 licence, and nothing but models, palettes and licences", () => {
    for (const pack of KIT_PACK_NAMES) expect(onDisk(`${kitDir(pack)}License.txt`), pack).toBe(true);
    const odd = shipped().filter((u) => !/\/(License\.txt|Textures\/colormap\.png|[A-Za-z0-9-]+\.glb)$/.test(u));
    expect(odd).toEqual([]);
  });
});
