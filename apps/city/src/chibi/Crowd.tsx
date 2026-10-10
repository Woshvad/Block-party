"use client";
import { randomLook, seededRandomInt } from "@bp/core";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { Look } from "../api";
import { HAIR, OUTFIT, SKIN } from "../palette";
import { cellFor, faceSheet } from "./faces";
import { BODY, faceMaterial, geo, glassesGeo, hairGeo, hatGeo, outlineMaterial, toonRamp } from "./parts";

// Every resident in a scene, drawn as chibis with one instanced mesh per part
// (and one per hair style, hat and glasses that's in use). One person or
// sixty costs the same handful of draw calls. The caller moves people; this
// animates them: walking, breathing, blinking, and the mood on their face.

export type ChibiPerson = {
  id: string;
  look: Look | null; // null: a steady random look from the id until theirs loads
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
  phase: number; // walk cycle
  mood?: string | null;
  dim?: boolean; // away residents
};

const n = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
const BODY_W: Record<string, number> = { body1: 0.92, body2: 1.04, body3: 1.18 };
const BOTTOMS = ["#3d5a8a", "#2c2c2a", "#b59a6b", "#6b6b70", "#5c6b3a"];
const SHORTS = new Set([3, 5]);
const SHOES = ["#f4f1ea", "#2c2c2a", "#e24b4a", "#378add"];
const HAT_LIFT: Record<number, number> = { 3: 0.1, 4: 0.05, 6: 0.05, 7: 0.06, 9: 0.04 };
const LEG = 0.28;

export function hashOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const fallbackLooks = new Map<string, Look>();
export function lookFor(p: Pick<ChibiPerson, "id" | "look">): Look {
  if (p.look) return p.look;
  let l = fallbackLooks.get(p.id);
  if (!l) {
    // A calm stand-in until their real look loads: hats and glasses on about
    // one in four, not four in five (a room of crowns is noise).
    const r = randomLook(seededRandomInt(hashOf(p.id))) as unknown as Look;
    const h = hashOf(`${p.id}:extras`);
    l = { ...r, hat: h % 4 === 0 ? r.hat : "none", glasses: (h >> 3) % 4 === 0 ? r.glasses : "none" };
    fallbackLooks.set(p.id, l);
  }
  return l;
}

export class CrowdRig {
  readonly group = new THREE.Group();
  private ramp = toonRamp();
  private toon = new THREE.MeshToonMaterial({ gradientMap: this.ramp });
  private ink = outlineMaterial();
  private sheet: THREE.CanvasTexture;
  private faceMat: THREE.MeshBasicMaterial;
  private faceGeo = geo.face.clone();
  private cells: THREE.InstancedBufferAttribute;
  readonly body: THREE.InstancedMesh;
  readonly head: THREE.InstancedMesh;
  private parts: Record<"legs" | "arms" | "shoes" | "face" | "blob", THREE.InstancedMesh>;
  private hair: THREE.InstancedMesh[];
  private hats: THREE.InstancedMesh[];
  private glasses: THREE.InstancedMesh[];
  private outlines: { of: THREE.InstancedMesh; ink: THREE.InstancedMesh }[] = [];
  private t = { base: new THREE.Matrix4(), local: new THREE.Matrix4(), out: new THREE.Matrix4(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), up: new THREE.Vector3(0, 1, 0), c: new THREE.Color() };

  constructor(readonly cap: number) {
    this.sheet = new THREE.CanvasTexture(faceSheet());
    this.sheet.colorSpace = THREE.SRGBColorSpace;
    this.sheet.anisotropy = 4;
    this.faceMat = faceMaterial(this.sheet);
    this.cells = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.faceGeo.setAttribute("faceCell", this.cells);
    const mesh = (g: THREE.BufferGeometry, count: number, mat: THREE.Material = this.toon, outline = true) => {
      const m = new THREE.InstancedMesh(g, mat, count);
      m.frustumCulled = false;
      m.count = 0;
      if (mat === this.toon) for (let i = 0; i < count; i++) m.setColorAt(i, this.t.c.set("#ffffff"));
      this.group.add(m);
      if (outline) {
        const ink = new THREE.InstancedMesh(g, this.ink, count);
        ink.frustumCulled = false;
        ink.count = 0;
        ink.instanceMatrix = m.instanceMatrix; // the outline follows the part exactly
        this.group.add(ink);
        this.outlines.push({ of: m, ink });
      }
      return m;
    };
    this.parts = {
      // Small parts go without an outline: it costs triangles nobody can see at room scale.
      legs: mesh(geo.leg, cap * 2, this.toon, false),
      arms: mesh(geo.arm, cap * 2, this.toon, false),
      shoes: mesh(geo.shoe, cap * 2, this.toon, false),
      face: mesh(this.faceGeo, cap, this.faceMat, false),
      blob: mesh(geo.blob, cap, new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.16, depthWrite: false }), false),
    };
    this.body = mesh(geo.body, cap);
    this.head = mesh(geo.head, cap);
    this.hair = hairGeo.map((g) => mesh(g, cap));
    this.hats = hatGeo.map((g) => mesh(g, cap));
    this.glasses = glassesGeo.map((g) => mesh(g, cap, this.toon, false));
  }

  // Which person a picked instance belongs to (body or head), if any.
  pick(object: THREE.Object3D, instanceId: number | undefined): number | null {
    if (instanceId === undefined || (object !== this.body && object !== this.head)) return null;
    return instanceId;
  }

  update(people: readonly ChibiPerson[], time: number) {
    const t = this.t;
    const n0 = Math.min(people.length, this.cap);
    const counts = { hair: new Array(this.hair.length).fill(0) as number[], hats: new Array(this.hats.length).fill(0) as number[], glasses: new Array(this.glasses.length).fill(0) as number[] };
    const place = (m: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, rx = 0, rz = 0, sx = 1) => {
      t.local.compose(t.v.set(x, y, z), t.q2.setFromEuler(t.e.set(rx, 0, rz)), t.s.set(sx, 1, 1));
      m.setMatrixAt(idx, t.out.multiplyMatrices(t.base, t.local));
    };
    const tint = (m: THREE.InstancedMesh, idx: number, hex: string, dim: boolean) => m.setColorAt(idx, t.c.set(hex).multiplyScalar(dim ? 0.55 : 1));

    for (let i = 0; i < n0; i++) {
      const p = people[i]!;
      const L = lookFor(p);
      const seed = hashOf(p.id) % 1000;
      const dim = !!p.dim;
      const bw = BODY_W[L.bodyType] ?? 1;
      const bob = p.moving ? Math.abs(Math.sin(p.phase)) * 0.035 : Math.sin(time * 2 + seed) * 0.006;
      const swing = p.moving ? Math.sin(p.phase) * 0.7 : 0;
      t.q.setFromAxisAngle(t.up, p.yaw);
      t.base.compose(t.v.set(p.x, 0, p.z), t.q, t.s.set(1, 1, 1));

      const skin = SKIN[L.skinTone] ?? SKIN[3]!;
      const top = OUTFIT[L.outfitColor] ?? OUTFIT[0]!;
      const bottomN = n(L.bottom) || 1;
      const legC = SHORTS.has(bottomN) ? skin : BOTTOMS[bottomN - 1] ?? BOTTOMS[0]!;
      const armC = n(L.top) >= 5 ? top : skin;

      for (const k of [0, 1] as const) {
        const side = k === 0 ? -1 : 1;
        const a = side * swing;
        place(this.parts.legs, i * 2 + k, side * BODY.hipX * bw, BODY.hipY + bob * 0.5, 0, a);
        tint(this.parts.legs, i * 2 + k, legC, dim);
        place(this.parts.shoes, i * 2 + k, side * BODY.hipX * bw, Math.max(0, BODY.hipY + bob * 0.5 - LEG * Math.cos(a) - 0.0), -LEG * Math.sin(a) * 0.9);
        tint(this.parts.shoes, i * 2 + k, SHOES[(n(L.shoes) || 1) - 1] ?? SHOES[0]!, dim);
        place(this.parts.arms, i * 2 + k, side * BODY.shoulderX * bw, BODY.shoulderY + bob, 0, -a * 0.8, side * 0.12);
        tint(this.parts.arms, i * 2 + k, armC, dim);
      }
      place(this.body, i, 0, 0.44 + bob, 0, 0, 0, bw);
      tint(this.body, i, top, dim);
      place(this.head, i, 0, BODY.headY + bob, 0);
      tint(this.head, i, skin, dim);
      place(this.parts.face, i, 0, BODY.headY + bob, 0);
      const blinking = !dim && (time + seed * 0.37) % 4.2 < 0.13;
      this.cells.setX(i, cellFor(L.face, p.mood ?? null, blinking));
      place(this.parts.blob, i, 0, 0.01, 0);

      const h = L.hair === "none" ? -1 : (n(L.hair) || 1) - 1;
      if (h >= 0 && this.hair[h]) {
        const m = this.hair[h]!;
        const j = counts.hair[h]!++;
        place(m, j, 0, BODY.headY + bob, 0);
        tint(m, j, HAIR[L.hairColor] ?? HAIR[0]!, dim);
      }
      const hat = L.hat === "none" ? -1 : (n(L.hat) || 1) - 1;
      if (hat >= 0 && this.hats[hat]) {
        const m = this.hats[hat]!;
        const j = counts.hats[hat]!++;
        place(m, j, 0, BODY.headY + bob + (HAT_LIFT[h + 1] ?? 0), 0);
        tint(m, j, hat === 3 ? "#e8b923" : OUTFIT[(L.outfitColor + 5) % OUTFIT.length]!, dim);
      }
      const gl = L.glasses === "none" ? -1 : (n(L.glasses) || 1) - 1;
      if (gl >= 0 && this.glasses[gl]) {
        const m = this.glasses[gl]!;
        const j = counts.glasses[gl]!++;
        place(m, j, 0, BODY.headY + bob - 0.01, 0);
        tint(m, j, gl === 3 ? "#e85d8f" : "#1e1e24", dim);
      }
    }

    const set = (m: THREE.InstancedMesh, count: number) => {
      m.count = count;
      m.visible = count > 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    };
    set(this.parts.legs, n0 * 2);
    set(this.parts.arms, n0 * 2);
    set(this.parts.shoes, n0 * 2);
    set(this.parts.face, n0);
    set(this.parts.blob, n0);
    set(this.body, n0);
    set(this.head, n0);
    this.hair.forEach((m, i) => set(m, counts.hair[i]!));
    this.hats.forEach((m, i) => set(m, counts.hats[i]!));
    this.glasses.forEach((m, i) => set(m, counts.glasses[i]!));
    for (const o of this.outlines) {
      o.ink.count = o.of.count;
      o.ink.visible = o.of.visible;
    }
    this.cells.needsUpdate = true;
  }

  dispose() {
    this.sheet.dispose();
    this.ramp.dispose();
    this.toon.dispose();
    this.ink.dispose();
    this.faceMat.dispose();
    this.faceGeo.dispose();
    this.group.traverse((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).dispose());
  }
}

export default function ChibiCrowd({ people, cap = 64, onPerson }: { people: React.MutableRefObject<ChibiPerson[]>; cap?: number; onPerson?: (id: string) => void }) {
  const rig = useMemo(() => new CrowdRig(cap), [cap]);
  useEffect(() => () => rig.dispose(), [rig]);
  useFrame(({ clock }) => rig.update(people.current, clock.elapsedTime));
  return (
    <primitive
      object={rig.group}
      onPointerDown={
        onPerson
          ? (e: ThreeEvent<PointerEvent>) => {
              const i = rig.pick(e.object, e.instanceId);
              const p = i === null ? undefined : people.current[i];
              if (!p || p.dim) return;
              e.stopPropagation();
              onPerson(p.id);
            }
          : undefined
      }
    />
  );
}
