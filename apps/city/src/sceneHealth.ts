// Keeping a failed 3D scene recoverable. Pure, so it's tested headless; the
// error boundary (SceneBoundary.tsx) and the model loader (Kit.tsx) use it.

// --- Models that never arrived ---------------------------------------------

// The model loader caches a failed download for good: every later mount
// rethrows the same error until the page reloads. So we note which models
// were asked for and which arrived; a retry clears only the rest.
const asked = new Set<string>();
const loaded = new Set<string>();

export function noteModelAsked(url: string) {
  asked.add(url);
}

export function noteModelLoaded(url: string) {
  loaded.add(url);
}

// The models asked for that never arrived (failed, or still on their way),
// forgotten here so the next ask starts fresh.
export function takeFailedModels(): string[] {
  const failed = [...asked].filter((u) => !loaded.has(u));
  for (const u of failed) asked.delete(u);
  return failed;
}

// The file a loader error names: "Could not load /assets/x.glb: 404 Not Found".
export function failedAsset(e: unknown): string | null {
  const m = e instanceof Error ? /^Could not load (.+?): /.exec(e.message) : null;
  return m ? m[1]! : null;
}

// --- What a failed scene shows -----------------------------------------------

export type SceneFallbackCopy = { title: string; detail?: string; action?: "retry" | "reload" };

// What a 3D view shows in its place, or null to draw it: no button on a
// device without WebGL, Reload when the game was updated since the page
// opened (no retry can fetch what the update took away), Try again for
// anything else that failed.
export function sceneFallback(what: string, note: string | undefined, scene: { webgl: boolean; failed: boolean; outdated: boolean }): SceneFallbackCopy | null {
  const and = (first: string) => [first, note].filter(Boolean).join(" ");
  if (!scene.webgl) return { title: `This device can't show ${what} in 3D.`, detail: note };
  if (scene.failed && scene.outdated) return { title: "Block Party has been updated.", detail: and(`Reload to see ${what}.`), action: "reload" };
  if (scene.failed) return { title: `Couldn't draw ${what}.`, detail: and("A download failed or the 3D view stopped."), action: "retry" };
  return null;
}

// --- WebGL ----------------------------------------------------------------------

type ProbeCanvas = { getContext(kind: string): unknown };

// Whether a canvas can give us WebGL 2 (three.js has needed it since r163).
// Without it the renderer fails asynchronously, inside the 3D library, and
// the player would only see a blank board. The probe's context is released
// at once: browsers allow only a few at a time.
export function canRenderWebGL(canvas: ProbeCanvas | null): boolean {
  if (!canvas) return false;
  try {
    const gl = canvas.getContext("webgl2") as { getExtension?(name: string): { loseContext?(): void } | null } | null;
    if (!gl) return false;
    gl.getExtension?.("WEBGL_lose_context")?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}

let webgl: boolean | null = null;
// Asked once per visit.
export function webglSupported(): boolean {
  if (webgl === null) webgl = typeof document !== "undefined" && canRenderWebGL(document.createElement("canvas"));
  return webgl;
}
