import { describe, expect, it } from "vitest";
import { PHOTO_NAME, photoWay, savePhoto, snapshot } from "../src/photo";

const png = new Blob(["png"], { type: "image/png" });
const abort = () => Object.assign(new Error("Share canceled"), { name: "AbortError" });

describe("taking the photo", () => {
  it("draws a frame and reads it in the same go, leaving out what's marked noPhoto", async () => {
    const grid = { visible: true, userData: { noPhoto: true } };
    const sofa = { visible: true, userData: {} };
    const log: string[] = [];
    const gl = {
      render: () => void log.push(`render grid:${grid.visible} sofa:${sofa.visible}`),
      domElement: {
        toBlob: (done: (b: Blob | null) => void, type?: string) => {
          log.push(`read ${type}`);
          done(png);
        },
      },
    };
    const taking = snapshot(gl, { traverse: (visit) => [grid, sofa].forEach(visit) }, {});
    // Read before anything else runs: the frame is gone once the browser shows it.
    expect(log).toEqual(["render grid:false sofa:true", "read image/png"]);
    expect(grid.visible).toBe(true);
    expect(await taking).toBe(png);
  });

  it("gives null, and puts everything back, when the frame can't be drawn", async () => {
    const grid = { visible: true, userData: { noPhoto: true } };
    const gl = {
      render: () => {
        throw new Error("context lost");
      },
      domElement: { toBlob: () => {} },
    };
    expect(await snapshot(gl, { traverse: (visit) => visit(grid) }, {})).toBeNull();
    expect(grid.visible).toBe(true);
  });
});

describe("where the photo goes", () => {
  it("shares the file where the phone can share files", async () => {
    const sent: { files: File[]; title: string }[] = [];
    const env = { canShare: (d: { files: File[] }) => d.files.length === 1, share: async (d: { files: File[]; title: string }) => void sent.push(d), download: () => {} };
    expect(photoWay(env)).toBe("share");
    expect(await savePhoto(png, env)).toBe("shared");
    expect(sent[0]!.files[0]!.name).toBe(PHOTO_NAME);
    expect(sent[0]!.files[0]!.type).toBe("image/png");
  });

  it("downloads it where files can't be shared", async () => {
    const saved: string[] = [];
    const env = { canShare: () => false, share: async () => {}, download: (_b: Blob, name: string) => void saved.push(name) };
    expect(photoWay(env)).toBe("download");
    expect(await savePhoto(png, env)).toBe("saved");
    expect(saved).toEqual([PHOTO_NAME]);
    // An old browser with share but no canShare can't say it takes files: download.
    expect(photoWay({ share: async () => {}, download: () => {} })).toBe("download");
  });

  it("has no photo button where neither works (inside Telegram on Android, say)", async () => {
    expect(photoWay({})).toBeNull();
    expect(photoWay({ canShare: () => false, share: async () => {} })).toBeNull();
    expect(photoWay({ canShare: () => { throw new Error("TypeError"); }, share: async () => {} })).toBeNull();
    expect(await savePhoto(png, {})).toBe("failed");
  });

  it("a closed share sheet is a cancel; a refusal falls back to the download", async () => {
    const saved: string[] = [];
    const download = (_b: Blob, name: string) => void saved.push(name);
    expect(await savePhoto(png, { canShare: () => true, share: () => Promise.reject(abort()), download })).toBe("cancelled");
    expect(saved).toEqual([]);
    expect(await savePhoto(png, { canShare: () => true, share: () => Promise.reject(new Error("NotAllowedError")), download })).toBe("saved");
    expect(await savePhoto(png, { canShare: () => true, share: () => Promise.reject(new Error("NotAllowedError")) })).toBe("failed");
  });
});
