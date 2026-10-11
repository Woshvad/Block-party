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
