import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cityPlacements, lotPlacements } from "../src/kitcity";
import { fillCity } from "../src/citygen";
import { CAR_MODELS, KIT, KIT_PACK_NAMES, kitDir, kitPackOf, kitUrls } from "../src/kitModels";
import { KIT_PACKS } from "../src/kitPacks";

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
    expect(KIT.roads("road-bend")).toBe(`${kitDir("roads")}road-bend.glb`);
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

  it("every model is already tidy (pnpm --filter @bp/city assets), and reads back whole", async () => {
    const { readGlb, tidyGlb } = await assetTools();
    for (const url of kitUrls()) {
      const path = join(PUBLIC, ...url.split("/").filter(Boolean));
      const buf = readFileSync(path);
      const palette = readFileSync(join(path, "..", "Textures", "colormap.png"));
      expect(tidyGlb(buf, palette) === buf, `${url} has data nothing reads: run the assets script`).toBe(true);
      const { json, bin } = readGlb(buf);
      expect(bin.length - json.buffers![0]!.byteLength, url).oneOf([0, 1, 2, 3]); // the chunk pads to 4 bytes
      for (const a of json.accessors!) {
        const v = json.bufferViews![a.bufferView!]!;
        const el = SIZE[a.componentType]! * NUM[a.type]!;
        expect((v.byteOffset ?? 0) % 4, url).toBe(0);
        expect((a.byteOffset ?? 0) + (a.count - 1) * (v.byteStride ?? el) + el, url).toBeLessThanOrEqual(v.byteLength);
        // Plain bytes sit in the binary chunk; a meshopt view's compressed
        // bytes do, at its extension's offset, and the view itself sits in a
        // fallback buffer that's never downloaded.
        const meshopt = v.extensions?.EXT_meshopt_compression;
        const stored = meshopt ?? v;
        if (meshopt) expect(json.buffers![v.buffer]!.extensions, url).toEqual({ EXT_meshopt_compression: { fallback: true } });
        expect(stored.buffer, url).toBe(0);
        expect((stored.byteOffset ?? 0) + stored.byteLength, url).toBeLessThanOrEqual(bin.length);
      }
    }
  });
});

// scripts/assets.mjs, which tidies the models.
type View = { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: { EXT_meshopt_compression?: { buffer: number; byteOffset?: number; byteLength: number } } };
type Accessor = { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string };
type Gltf = {
  accessors?: Accessor[];
  bufferViews?: View[];
  buffers?: { byteLength: number; extensions?: object }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  materials?: object[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number }[] }[];
  extensionsUsed?: string[];
  [k: string]: unknown;
};
type AssetTools = {
  readGlb: (b: Buffer) => { json: Gltf; bin: Buffer };
  writeGlb: (json: Gltf, bin: Buffer) => Buffer;
  tidyGlb: (b: Buffer, palette?: Buffer) => Buffer;
  packHash: (dir: string) => string;
  packsModule: (packs: Record<string, string>) => string;
};
const assetTools = async () => (await import(/* @vite-ignore */ new URL("../scripts/assets.mjs", import.meta.url).href)) as AssetTools;
const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

// One triangle, the way the kit's GLBs lay it out: position, normal, tangent
// and uv, then indices, then (as glTF-Transform writes them) the palette
// packed inside.
const PALETTE = Buffer.from("the pack's palette, byte for byte");
function triangle(material: object = {}) {
  const f32 = (...xs: number[]) => Buffer.from(new Float32Array(xs).buffer);
  const streams = [
    f32(0, 0, 0, 1, 0, 0, 0, 0, 1), // position
    f32(0, 1, 0, 0, 1, 0, 0, 1, 0), // normal
    f32(1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1), // tangent
    f32(0, 0, 1, 0, 0, 1), // uv
    Buffer.from(new Uint16Array([0, 1, 2]).buffer), // indices
    PALETTE,
  ];
  const views: View[] = [];
  let bin = Buffer.alloc(0);
  for (const s of streams) {
    bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    views.push({ buffer: 0, byteOffset: bin.length, byteLength: s.length });
    bin = Buffer.concat([bin, s]);
  }
  const json: Gltf = {
    asset: { version: "2.0" },
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 4, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    images: [{ bufferView: 5, mimeType: "image/png" }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, ...material }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2, TEXCOORD_0: 3 }, indices: 4, material: 0 }] }],
  };
  return { json, bin, streams };
}
const viewBytes = (g: { json: Gltf; bin: Buffer }, accessor: number) => {
  const v = g.json.bufferViews![g.json.accessors![accessor]!.bufferView!]!;
  return g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
};

describe("tidying a kit model", () => {
  it("drops the tangents and puts a packed palette back as the shared file, keeping every other byte", async () => {
    const { readGlb, writeGlb, tidyGlb } = await assetTools();
    const { json, bin, streams } = triangle();
    const before = writeGlb(json, bin);
    const after = tidyGlb(before, PALETTE);
    const g = readGlb(after);
    const prim = g.json.meshes![0]!.primitives[0]!;
    expect(Object.keys(prim.attributes)).toEqual(["POSITION", "NORMAL", "TEXCOORD_0"]);
    expect(viewBytes(g, prim.attributes.POSITION!)).toEqual(streams[0]);
    expect(viewBytes(g, prim.attributes.NORMAL!)).toEqual(streams[1]);
    expect(viewBytes(g, prim.attributes.TEXCOORD_0!)).toEqual(streams[3]);
    expect(viewBytes(g, prim.indices!)).toEqual(streams[4]);
    expect(g.json.images).toEqual([{ uri: "Textures/colormap.png" }]);
    expect(g.json.accessors).toHaveLength(4);
    expect(g.json.bufferViews).toHaveLength(4);
    for (const v of g.json.bufferViews!) expect((v.byteOffset ?? 0) % 4).toBe(0);
    expect(g.bin.length - g.json.buffers![0]!.byteLength).oneOf([0, 1, 2, 3]);
    expect(after.length).toBeLessThan(before.length - streams[2]!.length - PALETTE.length + 8);
    // Tidy already: the same buffer back.
    expect(tidyGlb(after, PALETTE)).toBe(after);
  });

  it("keeps tangents a normal map needs, and a picture that isn't the pack's palette", async () => {
    const { readGlb, writeGlb, tidyGlb } = await assetTools();
    const { json, bin } = triangle({ normalTexture: { index: 0 } });
    const g = readGlb(tidyGlb(writeGlb(json, bin), Buffer.from("some other palette")));
    expect(Object.keys(g.json.meshes![0]!.primitives[0]!.attributes)).toContain("TANGENT");
    expect(g.json.images![0]!.bufferView).toBeDefined();
  });

  it("moves meshopt's compressed bytes with their views (glTF-Transform's layout)", async () => {
    const { readGlb, writeGlb, tidyGlb } = await assetTools();
    const a = Buffer.from("compressed positions"); // 20 bytes
    const b = Buffer.from("packed idx"); // 10 bytes
    const bin = Buffer.concat([a, PALETTE, Buffer.alloc(3), b]);
    const atB = a.length + PALETTE.length + 3;
    const meshopt = (byteOffset: number, byteLength: number) => ({ EXT_meshopt_compression: { buffer: 0, byteOffset, byteLength } });
    const json: Gltf = {
      asset: { version: "2.0" },
      extensionsUsed: ["EXT_meshopt_compression"],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 1, byteLength: 36, byteStride: 12, extensions: meshopt(0, a.length) },
        { buffer: 0, byteOffset: a.length, byteLength: PALETTE.length },
        { buffer: 1, byteOffset: 36, byteLength: 6, extensions: meshopt(atB, b.length) },
      ],
      buffers: [{ byteLength: bin.length }, { byteLength: 42, extensions: { EXT_meshopt_compression: { fallback: true } } }],
      images: [{ bufferView: 1, mimeType: "image/png" }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    };
    const g = readGlb(tidyGlb(writeGlb(json, bin), PALETTE));
    expect(g.json.images).toEqual([{ uri: "Textures/colormap.png" }]);
    const [pos, idx] = g.json.bufferViews!.map((v) => v.extensions!.EXT_meshopt_compression!);
    expect(g.bin.subarray(pos!.byteOffset ?? 0, (pos!.byteOffset ?? 0) + pos!.byteLength)).toEqual(a);
    expect(g.bin.subarray(idx!.byteOffset!, idx!.byteOffset! + idx!.byteLength)).toEqual(b);
    expect(idx!.byteOffset).toBe(20);
    expect(g.json.bufferViews![1]).toMatchObject({ buffer: 1, byteOffset: 36, byteLength: 6 });
    expect(g.json.buffers).toEqual([{ byteLength: 30 }, json.buffers![1]]);
  });

  it("stops on an extension it doesn't know, rather than guess", async () => {
    const { writeGlb, tidyGlb } = await assetTools();
    const { json, bin } = triangle();
    expect(() => tidyGlb(writeGlb({ ...json, extensionsUsed: ["KHR_draco_mesh_compression"] }, bin))).toThrow("unknown extension KHR_draco_mesh_compression");
  });
});

// public/_headers, as rules: a path pattern and its headers.
function headerRules(): { path: string; headers: string[] }[] {
  const rules: { path: string; headers: string[] }[] = [];
  for (const line of readFileSync(join(PUBLIC, "_headers"), "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: [] });
    else rules.at(-1)!.headers.push(line.trim());
  }
  return rules;
}
// A _headers pattern, segment by segment: a final * matches the rest, :name
// any one segment.
function matches(pattern: string, url: string): boolean {
  const want = pattern.split("/");
  const got = url.split("/");
  for (let i = 0; i < want.length; i++) {
    if (want[i] === "*") return i < got.length;
    if (i >= got.length || (!want[i]!.startsWith(":") && want[i] !== got[i])) return false;
  }
  return want.length === got.length;
}
const IMMUTABLE = "Cache-Control: public, max-age=31536000, immutable";

describe("caching the kit for good", () => {
  it("each pack's folder is named after a hash of its files, and is the folder the city asks for", async () => {
    const { packHash, packsModule } = await assetTools();
    expect(Object.keys(KIT_PACKS).sort()).toEqual([...KIT_PACK_NAMES].sort());
    for (const pack of KIT_PACK_NAMES) {
      const folder = KIT_PACKS[pack];
      expect(folder, `${pack}'s files changed: run pnpm --filter @bp/city assets`).toBe(`${pack}-${packHash(join(KENNEY, folder))}`);
    }
    // Nothing else under /assets/kenney/, which is all cached for good.
    expect(readdirSync(KENNEY).sort()).toEqual(Object.values(KIT_PACKS).sort());
    // kitPacks.ts is exactly what the script writes.
    const written = readFileSync(new URL("../src/kitPacks.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(written).toBe(packsModule(Object.fromEntries(Object.entries(KIT_PACKS).sort())));
  });

  it("any change to a pack's files changes its hash", async () => {
    const { packHash } = await assetTools();
    const dir = mkdtempSync(join(tmpdir(), "kit-pack-"));
    try {
      mkdirSync(join(dir, "Textures"));
      writeFileSync(join(dir, "a.glb"), "model a");
      writeFileSync(join(dir, "Textures", "colormap.png"), "palette");
      const seen = new Set([packHash(dir)]);
      expect(packHash(dir)).toBe([...seen][0]);
      expect([...seen][0]).toMatch(/^[0-9a-f]{8}$/);
      writeFileSync(join(dir, "a.glb"), "model b"); // same length, new bytes
      seen.add(packHash(dir));
      renameSync(join(dir, "a.glb"), join(dir, "b.glb"));
      seen.add(packHash(dir));
      writeFileSync(join(dir, "c.glb"), "");
      seen.add(packHash(dir));
      expect(seen.size).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("knows a kit model's pack, and only at the current version", () => {
    expect(kitPackOf(KIT.roads("road-straight"))).toBe("roads");
    expect(kitPackOf(KIT.cars("taxi"))).toBe("cars");
    expect(kitPackOf("/assets/kenney/roads/road-straight.glb")).toBeNull();
    expect(kitPackOf("/assets/kenney/roads-00000000/road-straight.glb")).toBeNull();
    expect(kitPackOf("/icons/icon-192.png")).toBeNull();
  });

  it("public/_headers makes only content-versioned addresses immutable", () => {
    const rules = headerRules();
    const immutable = rules.filter((r) => r.headers.some((h) => /immutable/i.test(h)));
    // Next's own build files carry a hash in their names; the kit's carry it in their folder.
    expect(immutable.map((r) => r.path).sort()).toEqual(["/_next/static/*", "/assets/kenney/*"]);
    for (const r of immutable) expect(r.headers).toEqual([IMMUTABLE]);
    const versioned = Object.values(KIT_PACKS).map((folder) => `/assets/kenney/${folder}/`);
    const files = walk(PUBLIC).map(urlOf);
    expect(files.some((u) => matches("/assets/kenney/*", u))).toBe(true);
    for (const r of immutable)
      for (const url of files.filter((u) => matches(r.path, u))) expect(versioned.some((v) => url.startsWith(v)), `${url} is immutable but not versioned`).toBe(true);
    // Never the page, the manifest, the icons or the headers themselves.
    for (const url of ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/_headers", "/assets/kenney"]) expect(immutable.some((r) => matches(r.path, url)), url).toBe(false);
  });

  it("next.config.mjs sends the same when Next serves the city", async () => {
    const load = (await import(/* @vite-ignore */ new URL("../next.config.mjs", import.meta.url).href)) as { default: (phase: string) => { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> } };
    const rules = await load.default("phase-development-server").headers();
    const immutable = rules.filter((r) => r.headers.some((h) => /immutable/i.test(h.value)));
    // Next sends /_next/static as immutable itself.
    const fromHeaders = headerRules().filter((r) => r.headers.includes(IMMUTABLE) && r.path !== "/_next/static/*").map((r) => r.path);
    expect(immutable.map((r) => r.source.replace(/:path\*$/, "*"))).toEqual(fromHeaders);
    for (const r of immutable) expect(r.headers).toEqual([{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]);
  });
});
