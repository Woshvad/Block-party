import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Chibi proportions: the head is about a third of the height, so a resident
// reads at phone size. Units are room tiles; a resident stands ~1.25 tall.
export const BODY = {
  headY: 0.86,
  headR: 0.3,
  hipY: 0.3,
  shoulderY: 0.6,
  shoulderX: 0.21,
  hipX: 0.085,
} as const;

const merge = (parts: THREE.BufferGeometry[]) => {
  // Every part must carry the same attributes to merge.
  // Some three.js shapes are indexed and some aren't (polyhedra); merging needs
  // them all the same, so every part goes non-indexed first.
  const clean = parts.map((g0) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
    return g;
  });
  return mergeGeometries(clean, false)!;
};
const sphere = (r: number, w = 16, h = 12, thetaLen = Math.PI) => new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, thetaLen);
const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);

// --- The body -------------------------------------------------------------

export const geo = {
  // Head centred at the origin of its part; placed at BODY.headY.
  head: new THREE.SphereGeometry(BODY.headR, 14, 10).scale(1.06, 0.96, 1),
  // The face: a patch of a slightly bigger sphere across the front, so it
  // curves with the head. Its UVs span one cell of the face sheet.
  // The patch spans most of the front so the features read big (chibi eyes are
  // big and sit a touch low: the patch's centre is just below the equator).
  face: new THREE.SphereGeometry(BODY.headR * 1.02, 10, 8, Math.PI / 2 - 0.85, 1.7, Math.PI / 2 - 0.78, 1.7).scale(1.06, 0.96, 1),
  body: new THREE.CapsuleGeometry(0.17, 0.1, 3, 10).scale(1, 1, 0.82),
  // Limbs pivot at the top (hip, shoulder).
  leg: new THREE.CapsuleGeometry(0.075, 0.13, 1, 6).translate(0, -0.14, 0),
  arm: new THREE.CapsuleGeometry(0.058, 0.16, 1, 6).translate(0, -0.13, 0),
  hand: new THREE.SphereGeometry(0.06, 6, 4).scale(1, 1.1, 0.85),
  shoe: new THREE.BoxGeometry(0.14, 0.07, 0.2).translate(0, 0.035, 0.025),
  blob: new THREE.CircleGeometry(0.34, 12).rotateX(-Math.PI / 2),
};

// --- Hair: 10 styles, built around a head at the origin --------------------
// The front of every style stops at the forehead (~65° from the top), above
// the face's eye line, so hair never hides the expression.

const FRONT_STOP = 1.12;
const cap = (r = BODY.headR + 0.022, stop = FRONT_STOP) => sphere(r, 12, 6, stop).scale(1.06, 0.98, 1);
const backShell = (r: number, from: number, to: number, drop = 0) =>
  new THREE.SphereGeometry(r, 10, 7, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 0, to).scale(1.06, 1, 1).translate(0, -drop, -0.01 + from * 0);

export const HAIR_NAMES = ["Crop", "Bob", "Afro", "Spikes", "Ponytail", "Bun", "Mohawk", "Long", "Curls", "Locs"];

export const hairGeo: THREE.BufferGeometry[] = [
  // 1 crop
  merge([cap()]),
  // 2 bob: a cap, plus hair down the sides and back to the jaw
  merge([cap(), backShell(BODY.headR + 0.028, 0, 1.95)]),
  // 3 afro: a big round cloud set back from the face
  merge([at(sphere(0.4, 12, 9), 0, 0.1, -0.13)]),
  // 4 spikes
  merge([cap(), ...[-0.18, -0.06, 0.06, 0.18].flatMap((x, i) => [at(new THREE.ConeGeometry(0.07, 0.2, 5).rotateZ(-x * 1.6).rotateX(-0.25), x, 0.3 - Math.abs(x) * 0.3, 0.02 - (i % 2) * 0.08)])]),
  // 5 ponytail
  merge([cap(), at(new THREE.CapsuleGeometry(0.07, 0.24, 2, 6).rotateX(0.5), 0, 0.02, -0.36)]),
  // 6 bun
  merge([cap(), at(sphere(0.12, 8, 6), 0, 0.33, -0.08)]),
  // 7 mohawk: a ridge front to back
  merge([at(new THREE.BoxGeometry(0.08, 0.16, 0.5), 0, 0.3, -0.04)]),
  // 8 long: down the back to the shoulders
  merge([cap(), backShell(BODY.headR + 0.045, 0, 2.3), at(new THREE.BoxGeometry(0.5, 0.36, 0.12), 0, -0.3, -0.2)]),
  // 9 curls: a crown of small curls
  merge(
    Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return at(sphere(0.11, 5, 4), Math.cos(a) * 0.22, 0.2 + (i % 2) * 0.05, Math.sin(a) * 0.22 - 0.03);
    }).concat([at(sphere(0.16, 6, 4), 0, 0.27, -0.04)]),
  ),
  // 10 locs: a cap with locs hanging at the sides and back
  merge([cap(), ...Array.from({ length: 6 }, (_, i) => {
    const a = Math.PI * (0.15 + (i / 5) * 0.7) + Math.PI;
    // sin(a) < 0 here: the back half of the head (a sign slip once hung a loc over the face).
    return at(new THREE.CapsuleGeometry(0.038, 0.32, 1, 4), Math.cos(a) * 0.29, -0.12, Math.sin(a) * 0.29 - 0.02);
  })]),
];

// --- Hats and glasses -------------------------------------------------------

export const HAT_NAMES = ["Cap", "Beanie", "Bucket", "Crown"];
export const hatGeo: THREE.BufferGeometry[] = [
  // cap: a dome and a brim out front
  merge([cap(BODY.headR + 0.035, 1.3), at(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 10, 1, false, -Math.PI / 2, Math.PI).scale(1, 1, 1.1), 0, 0.13, 0.2)]),
  // beanie: a taller dome with a folded rim
  merge([at(cap(BODY.headR + 0.04, 1.25).scale(1, 1.15, 1), 0, 0.02, 0), at(new THREE.TorusGeometry(BODY.headR + 0.03, 0.035, 4, 14).rotateX(Math.PI / 2).scale(1.06, 1, 1), 0, 0.1, 0)]),
  // bucket hat: a short tapered crown and a soft brim all round
  merge([at(new THREE.CylinderGeometry(0.24, 0.3, 0.16, 12), 0, 0.27, 0), at(new THREE.CylinderGeometry(0.42, 0.42, 0.02, 14), 0, 0.19, 0)]),
  // crown: a gold band with points
  merge([at(new THREE.CylinderGeometry(0.2, 0.2, 0.09, 12, 1, true), 0, 0.33, 0), ...Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2;
    return at(new THREE.ConeGeometry(0.045, 0.1, 4), Math.cos(a) * 0.2, 0.42, Math.sin(a) * 0.2);
  })]),
];

export const GLASSES_NAMES = ["Round", "Square", "Shades", "Hearts"];
const lens = (shape: "round" | "square" | "shade" | "heart", x: number) => {
  if (shape === "round") return at(new THREE.TorusGeometry(0.07, 0.014, 3, 10), x, 0, 0);
  if (shape === "square") return at(new THREE.BoxGeometry(0.14, 0.11, 0.02), x, 0, 0);
  if (shape === "shade") return at(new THREE.BoxGeometry(0.15, 0.09, 0.02), x, 0, 0);
  return at(new THREE.OctahedronGeometry(0.075, 0).scale(1, 0.8, 0.25), x, 0, 0);
};
const glasses = (shape: "round" | "square" | "shade" | "heart") =>
  merge([lens(shape, -0.11), lens(shape, 0.11), new THREE.BoxGeometry(0.08, 0.015, 0.015)]).translate(0, 0.0, BODY.headR + 0.03);
export const glassesGeo: THREE.BufferGeometry[] = [glasses("round"), glasses("square"), glasses("shade"), glasses("heart")];

// --- Look: shades, outlines --------------------------------------------------

// Three flat bands of light: the cartoon look.
export function toonRamp(): THREE.DataTexture {
  // A light shadow band: dark bands turn deeper skin tones muddy.
  const t = new THREE.DataTexture(new Uint8Array([160, 160, 160, 255, 215, 215, 215, 255, 255, 255, 255, 255]), 3, 1);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

// An ink outline: the same shape, pushed out along its normals and drawn
// from the inside. Works with instancing (the push happens before instanceMatrix).
// It uses the raw normal attribute: a basic material never declares objectNormal.
export function outlineMaterial(width = 0.018, color = "#2a1d1a"): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n transformed += normalize(normal) * ${width.toFixed(4)};`);
  };
  m.customProgramCacheKey = () => `outline-${width}`;
  return m;
}

// The face: one cell of the sheet per resident, picked per instance.
export function faceMaterial(sheet: THREE.Texture): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map: sheet, transparent: true, alphaTest: 0.35, depthWrite: true });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float faceCell;")
      .replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\n vMapUv = vec2((mod(faceCell, 4.0) + uv.x) / 4.0, 1.0 - (floor(faceCell / 4.0) + 1.0 - uv.y) / 4.0);",
      );
  };
  m.customProgramCacheKey = () => "chibi-face";
  return m;
}

// Triangles in a shape (indexed or not).
export const triangles = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute("position").count) / 3;
