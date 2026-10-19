// Tidies the city's kit models in public/assets/kenney, in place. Run it
// after adding, replacing or compressing a model:
//   pnpm --filter @bp/city assets
// Each GLB loses the vertex data nothing draws: tangents, when no material in
// it has a normal map (the kit's have none, and Kit.tsx keeps only position,
// normal and uv anyway). A pack palette packed inside a model (glTF-Transform
// writes GLBs that way) goes back to being the pack's shared
// Textures/colormap.png, which kitTextures.ts uploads once per pack. Running
// it twice changes nothing. No dependencies: a GLB is a JSON chunk and a
// binary chunk, rewritten here by hand.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const PALETTE = "Textures/colormap.png";

// Extensions this knows don't point at buffer views (or, for meshopt, how
// they do). Anything else stops the script rather than risk a broken model.
const KNOWN = new Set(["KHR_texture_transform", "KHR_mesh_quantization", "EXT_meshopt_compression", "KHR_materials_unlit", "KHR_materials_emissive_strength"]);

export function readGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== MAGIC || buf.readUInt32LE(4) !== 2) throw new Error("not a glTF 2 binary");
  if (buf.readUInt32LE(8) !== buf.length) throw new Error("length doesn't match the header");
  const jsonLength = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== JSON_CHUNK) throw new Error("first chunk isn't JSON");
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString("utf8"));
  const at = 20 + jsonLength;
  if (at + 8 > buf.length) return { json, bin: Buffer.alloc(0) };
  if (buf.readUInt32LE(at + 4) !== BIN_CHUNK) throw new Error("second chunk isn't BIN");
  return { json, bin: buf.subarray(at + 8, at + 8 + buf.readUInt32LE(at)) };
}

const pad4 = (n) => (n + 3) & ~3;
const u32 = (...xs) => {
  const b = Buffer.alloc(xs.length * 4);
  xs.forEach((x, i) => b.writeUInt32LE(x, i * 4));
  return b;
};

export function writeGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPart = Buffer.concat([text, Buffer.alloc(pad4(text.length) - text.length, 0x20)]);
  const binPart = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);
  const length = 12 + 8 + jsonPart.length + (bin.length ? 8 + binPart.length : 0);
  const parts = [u32(MAGIC, 2, length), u32(jsonPart.length, JSON_CHUNK), jsonPart];
  if (bin.length) parts.push(u32(binPart.length, BIN_CHUNK), binPart);
  return Buffer.concat(parts);
}

// The model, without what nothing reads. `palette` is the pack's
// Textures/colormap.png, to put back where a copy was packed inside. Returns
// the same buffer when there's nothing to do.
export function tidyGlb(buf, palette) {
  const { json, bin } = readGlb(buf);
  const unknown = (json.extensionsUsed ?? []).filter((e) => !KNOWN.has(e));
  if (unknown.length) throw new Error(`unknown extension ${unknown.join(", ")}: check it, then add it to KNOWN`);
  if ((json.buffers ?? []).some((b, i) => i === 0 ? b.uri !== undefined : !b.extensions?.EXT_meshopt_compression?.fallback)) throw new Error("data outside the GLB");
  let changed = false;

  // Tangents only matter to a normal map (normalTexture, or an extension's
  // clearcoatNormalTexture and the like).
  if (!JSON.stringify(json.materials ?? []).includes("ormalTexture"))
    for (const mesh of json.meshes ?? [])
      for (const p of mesh.primitives)
        for (const set of [p.attributes, ...(p.targets ?? [])])
          if ("TANGENT" in set) {
            delete set.TANGENT;
            changed = true;
          }

  // A packed copy of the pack's palette: back to the shared file.
  for (const image of json.images ?? []) {
    if (image.bufferView === undefined || !palette) continue;
    const view = json.bufferViews[image.bufferView];
    if (view.buffer !== 0 || view.extensions) continue;
    const start = view.byteOffset ?? 0;
    if (!bin.subarray(start, start + view.byteLength).equals(palette)) continue;
    delete image.bufferView;
    delete image.mimeType;
    image.uri = PALETTE;
    changed = true;
  }

  // Accessors and buffer views still in use, in their old order.
  const usedAccessors = new Set();
  for (const mesh of json.meshes ?? [])
    for (const p of mesh.primitives) {
      if (p.indices !== undefined) usedAccessors.add(p.indices);
      for (const set of [p.attributes, ...(p.targets ?? [])]) for (const a of Object.values(set)) usedAccessors.add(a);
    }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) usedAccessors.add(skin.inverseBindMatrices);
  for (const anim of json.animations ?? []) for (const s of anim.samplers) usedAccessors.add(s.input).add(s.output);
  const accessors = (json.accessors ?? []).map((a, i) => (usedAccessors.has(i) ? a : null));
  const usedViews = new Set();
  for (const a of accessors) {
    if (!a) continue;
    if (a.bufferView !== undefined) usedViews.add(a.bufferView);
    if (a.sparse) usedViews.add(a.sparse.indices.bufferView).add(a.sparse.values.bufferView);
  }
  for (const image of json.images ?? []) if (image.bufferView !== undefined) usedViews.add(image.bufferView);
  const views = (json.bufferViews ?? []).map((v, i) => (usedViews.has(i) ? v : null));
  if (!changed && accessors.every(Boolean) && views.every(Boolean)) return buf;

  // The binary chunk again, holding only what the kept views point at (a
  // meshopt view's compressed bytes sit at its extension's offset), each
  // piece 4-byte aligned as glTF asks.
  const pieces = [];
  let length = 0;
  const placed = new Map();
  const place = (offset = 0, byteLength) => {
    const key = `${offset}:${byteLength}`;
    if (!placed.has(key)) {
      length = pad4(length);
      placed.set(key, length);
      pieces.push({ at: length, bytes: bin.subarray(offset, offset + byteLength) });
      length += byteLength;
    }
    return placed.get(key);
  };
  for (const v of views) {
    if (!v) continue;
    if (v.buffer === 0) v.byteOffset = place(v.byteOffset, v.byteLength);
    const m = v.extensions?.EXT_meshopt_compression;
    if (m && m.buffer === 0) m.byteOffset = place(m.byteOffset, m.byteLength);
    if (v.byteOffset === 0) delete v.byteOffset;
  }
  const out = Buffer.alloc(length);
  for (const p of pieces) p.bytes.copy(out, p.at);

  // Renumber what's left.
  const viewIndex = new Map();
  views.forEach((v, i) => v && viewIndex.set(i, viewIndex.size));
  const accessorIndex = new Map();
  accessors.forEach((a, i) => a && accessorIndex.set(i, accessorIndex.size));
  for (const a of accessors) {
    if (!a) continue;
    if (a.bufferView !== undefined) a.bufferView = viewIndex.get(a.bufferView);
    if (a.sparse) {
      a.sparse.indices.bufferView = viewIndex.get(a.sparse.indices.bufferView);
      a.sparse.values.bufferView = viewIndex.get(a.sparse.values.bufferView);
    }
  }
  for (const image of json.images ?? []) if (image.bufferView !== undefined) image.bufferView = viewIndex.get(image.bufferView);
  for (const mesh of json.meshes ?? [])
    for (const p of mesh.primitives) {
      if (p.indices !== undefined) p.indices = accessorIndex.get(p.indices);
      for (const set of [p.attributes, ...(p.targets ?? [])]) for (const k of Object.keys(set)) set[k] = accessorIndex.get(set[k]);
    }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = accessorIndex.get(skin.inverseBindMatrices);
  for (const anim of json.animations ?? [])
    for (const s of anim.samplers) {
      s.input = accessorIndex.get(s.input);
      s.output = accessorIndex.get(s.output);
    }
  if (json.accessors) json.accessors = accessors.filter(Boolean);
  if (json.bufferViews) json.bufferViews = views.filter(Boolean);
  if (json.buffers?.[0]) json.buffers[0].byteLength = out.length;
  return writeGlb(json, out);
}

// The folder each pack lives in: public/assets/kenney/<pack>.
export const KENNEY = fileURLToPath(new URL("../public/assets/kenney/", import.meta.url));

function main() {
  let before = 0;
  let after = 0;
  for (const pack of readdirSync(KENNEY).sort()) {
    const dir = join(KENNEY, pack);
    if (!statSync(dir).isDirectory()) continue;
    const palette = readFileSync(join(dir, PALETTE));
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".glb")) continue;
      const path = join(dir, name);
      const buf = readFileSync(path);
      const tidy = tidyGlb(buf, palette);
      before += buf.length;
      after += tidy.length;
      if (tidy !== buf) writeFileSync(path, tidy);
    }
  }
  console.log(`kit models: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
