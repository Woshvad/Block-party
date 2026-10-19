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
