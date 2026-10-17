import { cancelled } from "./share";
import { telegram } from "./telegram";

// A photo of a 3D view, taken on demand. The view keeps no copy of its last
// frame (preserveDrawingBuffer stays off: holding one costs phones memory
// and speed on every frame), so the photo draws one frame of its own and
// reads it in the same task, before the browser hands the buffer to the
// screen and clears it. Then the phone's share sheet takes it where it can
// share files, or it's saved as a download. Pure apart from what it's
// handed, so it's tested headless.

export const PHOTO_NAME = "block-party-home.png";

type Thing = { visible: boolean; userData: Record<string, unknown> };
type Renderer = { render(scene: never, camera: never): void; domElement: { toBlob(done: (blob: Blob | null) => void, type?: string): void } };

// Draws one frame and reads it as a PNG. Anything marked userData.noPhoto
// (the editor's grid) is left out of that frame.
export function snapshot(gl: Renderer, scene: { traverse(visit: (o: Thing) => void): void }, camera: unknown): Promise<Blob | null> {
  return new Promise((resolve) => {
    const hidden: Thing[] = [];
    scene.traverse((o) => {
      if (o.userData.noPhoto && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    });
    try {
      gl.render(scene as never, camera as never);
      gl.domElement.toBlob(resolve, "image/png");
    } catch {
      resolve(null);
    } finally {
      for (const o of hidden) o.visible = true;
    }
  });
}

// What this device can do with a photo.
export type PhotoEnv = {
  canShare?: ((data: { files: File[] }) => boolean) | null; // navigator.canShare
  share?: ((data: { files: File[]; title: string }) => Promise<void>) | null; // navigator.share
  download?: ((blob: Blob, name: string) => void) | null; // null where a saved file goes nowhere
};

const filesShareable = (env: PhotoEnv, files: File[]) => {
  try {
    return !!env.share && !!env.canShare?.({ files });
  } catch {
    return false;
  }
};

// "share", "download", or null: then there's no photo button at all.
export function photoWay(env: PhotoEnv): "share" | "download" | null {
  if (filesShareable(env, [new File([""], PHOTO_NAME, { type: "image/png" })])) return "share";
  return env.download ? "download" : null;
}

export async function savePhoto(blob: Blob, env: PhotoEnv): Promise<"shared" | "saved" | "cancelled" | "failed"> {
  const files = [new File([blob], PHOTO_NAME, { type: "image/png" })];
  if (filesShareable(env, files)) {
    try {
      await env.share!({ files, title: "My Block Party home" });
      return "shared";
    } catch (e) {
      if (cancelled(e)) return "cancelled";
      // refused: save it instead, where that works
    }
  }
  if (!env.download) return "failed";
  try {
    env.download(blob, PHOTO_NAME);
    return "saved";
  } catch {
    return "failed";
  }
}

// Telegram's webviews drop downloads, so inside Telegram only sharing counts.
export function browserPhotoEnv(): PhotoEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const downloads = typeof document !== "undefined" && typeof HTMLAnchorElement !== "undefined" && "download" in HTMLAnchorElement.prototype && !telegram();
  return {
    canShare: typeof nav?.canShare === "function" ? (data) => nav.canShare(data) : null,
    share: typeof nav?.share === "function" ? (data) => nav.share(data) : null,
    download: downloads ? downloadBlob : null,
  };
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
