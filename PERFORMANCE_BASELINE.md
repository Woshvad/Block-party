# City visual-layer baseline — 11 October 2026

Observed in the local development build, Codex in-app desktop browser, `/design-preview?perf`, default city camera. Current layers include the detailed diner, furniture, water, lighting, atmosphere and street effects. Values below are individual meter snapshots, not averages or a controlled before/after regression study.

| View | FPS snapshot | Draw calls | Triangles | JS heap |
| --- | ---: | ---: | ---: | ---: |
| Desktop day | 120 | 146 | 413.6k | 81 MB |
| Desktop night, shortly after toggle | 100 | 147 | 413.7k | 105 MB |
| 390 × 844 night | 120 | 123 | 354.0k | 94 MB |
| 390 × 844 day, shortly after toggle | 120 | 123 | 354.0k | 111 MB |

Viewport was restored after measurement. Different camera framing/culling explains some geometry variation. Heap varies with garbage collection; these samples do not establish a leak. The meter counts frames over approximately one second and is affected by browser visibility/throttling. No hardware/GPU or sustained thermal benchmark was collected. These results do not establish phone performance.

Next performance acceptance: production build on a real mid-range phone inside Telegram, fixed day/night and diner camera positions, warm-up followed by a sustained run, including median/p95 frame time, reconnect, memory growth and touch responsiveness. Compare identical camera and crowd configurations before optimizing additional visual layers.

## 12 October: what the meter counts now

The table above counted the main pass only. Since 12 October the `?perf` meter counts every pass, shadows included, and also shows GPU geometries, textures and shader programs. In a local dev build at the default 1280 × 720 view, with frames stepped by hand because the browser pane was in the background, the same city read 256 draw calls and 794k triangles, where the main pass alone was 147. That is one snapshot, not a benchmark, and it is above the plan's 100–150 budget once shadows count.

Also new: kit models share one palette texture per pack instead of uploading a copy each, and there's a low quality tier (device pixel ratio 1, no antialiasing, no shadows, no sidewalk walkers or night lamps), picked from the device or forced with `?quality=low|high` or Graphics in Me. Neither has been measured on a phone. The acceptance run described above, on a real mid-range phone inside Telegram, is still the next step, and should be done on both tiers.

## 19 October: the Roof's leaderboards

The Roof gained three board screens. Each board is one textured plane, so the room costs 3 more draw calls; they cast no shadows, so the shadow pass is unchanged. The screen frames and their 6 posts are merged into the room's existing single mesh and its outline: 9 boxes, 108 triangles more in passes it already draws, and no new draw calls. Each board paints a 1183 × 360 canvas texture, about 1.7 MB of GPU memory before mipmaps. Nothing changed on the city board, so the numbers above stand. Counted from the code, not measured: the browser pane was shared while this was built. To measure, open `/room-social-preview` in a dev build and pick The Roof: its readout counts every pass.

## 19 October: the kit's download

Kenney's packs shipped whole. Now only the models the code can ask for ship (`src/kitModels.ts`), and each model has lost its tangents, a third of its vertex data, which nothing read (no kit material has a normal map, and `bake()` keeps only position, normal and uv). Byte counts, not a browser measurement:

| | Files in `public/assets` | Size | What the city downloads (63 models, 5 palettes) |
| --- | ---: | ---: | ---: |
| Before | 273 (263 models) | 16.75 MB | 8.48 MB |
| After | 84 (74 models) | 6.84 MB | 5.90 MB |

The loader keeps each model's binary, and a copy of each part it reads, for the life of the page, so the tangents also cost about 6 MB of JS heap (3 MB twice). That's an estimate from the byte counts.

The packs now sit in folders named after a hash of their files, served as immutable (README "Deploying"), so a phone downloads them once per change, not once per visit.

### Compression: what it would save, and what to do

Measured on the 74 models (6.78 MB) with the meshoptimizer 0.18 and draco3d 1.5.7 encoders already in the pnpm store (three-stdlib's dependencies), quantized like glTF-Transform's defaults (positions 14 bits, normals 8 or 10, uvs 12). Nothing was installed, and the shipped files aren't compressed. glTF-Transform's own output will differ a little.

| | As stored | gzip | brotli |
| --- | ---: | ---: | ---: |
| Shipped now (floats, no tangents) | 6.78 MB | 1.34 MB | 0.80 MB |
| Meshopt | 1.85 MB | 0.90 MB | 0.81 MB |
| Draco | 0.67 MB | 0.48 MB | 0.45 MB |

1. **First, the host has to compress `.glb`.** It needs no tool and is the biggest saving: 6.78 MB becomes 0.80 MB with brotli at its highest level (a CDN's on-the-fly brotli comes out a little bigger). `next start` gzips them already (checked). On a static host, check with `curl -sI -H "Accept-Encoding: br, gzip" https://<city>/assets/kenney/<pack folder>/taxi.glb`. If there's no `Content-Encoding`, turn compression on for `model/gltf-binary` (on Cloudflare, a compression rule).
2. **Then meshopt, for memory and for a host that won't compress.**
   - **Tool:** glTF-Transform's CLI (`@gltf-transform/cli`, MIT). It's a new dev dependency, so adding it is the owner's call.
   - **Commands:**
     ```bash
     pnpm --filter @bp/city add -D @gltf-transform/cli
     cd apps/city/public/assets/kenney
     for f in */*.glb; do pnpm exec gltf-transform meshopt "$f" "$f"; done
     pnpm --filter @bp/city assets   # palettes back out of the models, new folder names
     ```
   - **Saving:** 6.78 MB becomes about 1.85 MB stored and 0.90 MB gzipped, about the same as brotli on today's files. The bigger win is memory: quantized attributes take 16 bytes a vertex instead of 32, so what the loader keeps falls from about 13 MB to about 6 MB (an estimate).
   - **Decoder:** already shipping. drei's `useGLTF` sets three-stdlib's `MeshoptDecoder` on every load. It's meshoptimizer's decoder, which three also ships as `three/examples/jsm/libs/meshopt_decoder.module.js` (25 KB, 6 KB gzipped). No code change, nothing new to download.
   - **Ready for it:** glTF-Transform packs each pack's palette into every GLB it writes; the assets script puts it back as the shared `Textures/colormap.png` that `kitTextures.ts` uploads once per pack. `bake()` now turns quantized attributes into floats before moving them (it used to wrap them into garbage). The kit test reads meshopt models back. Look at the city in a browser afterwards, close up, before shipping.
3. **Not Draco.** It's the smallest (0.45 MB with brotli), but drei fetches its decoder from www.gstatic.com unless we host three's copy (`three/examples/jsm/libs/draco/gltf/`, 250 KB, about 60 KB with brotli). It also decodes more slowly on a phone, and into floats, so it saves no memory. Net, about 0.3 MB, on a first visit only.
4. **Not KTX2 for the palettes.** They're five 512 × 512 PNGs of about 11 KB each. KTX2 would cut their GPU memory (about 1.4 MB each with mipmaps) but not the download, and block compression can bleed colours across the palette's cell edges. Revisit only if the phone run shows GPU memory pressure.
