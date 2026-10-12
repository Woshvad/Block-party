"use client";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { outlineMaterial } from "./chibi/parts";
import { type Part, ball, box, colored, cyl, darker } from "./geo";
import type { Decor, Layout } from "./interiors";
import type { Board, FeedKey } from "./roomfeeds";

// A public room's interior: walls, a two-tone floor and every piece of decor,
// merged into ONE shape with per-vertex colours (one draw call, plus one for
// the ink outline), in the same toon style as the residents. Signs, screens
// and murals are painted text panels that glow.

const WOOD = "#8a5a2b";
const METAL = "#5f6670";
const LEAF = "#3b8a3e";

// One piece of decor, in world units (the room centred on the origin).
function piece(d: Decor, W: number, H: number): Part[] {
  const w = d.w ?? 1;
  const dd = d.d ?? 1;
  const x = d.x + w / 2 - W / 2;
  const z = d.y + dd / 2 - H / 2;
  const c = d.color ?? "#b9a58c";
  const back = -H / 2 + 0.08; // the back wall's face
  const f = d.facing ?? 0;
  // Behind a seat: opposite the way it faces.
  const bx = -Math.sin(f) * 0.38;
  const bz = Math.cos(f) * 0.38;
  switch (d.kind) {
    case "counter":
      return [box(x, 0.5, z, w * 0.96, 1, 0.8, c), box(x, 1.03, z, w, 0.07, 0.9, "#f4f1ea"), box(x, 0.12, z + 0.38, w * 0.96, 0.1, 0.06, darker(c, 0.6))];
    case "stool":
      return [cyl(x, 0.3, z, 0.05, 0.08, 0.6, METAL, 6), cyl(x, 0.62, z, 0.2, 0.2, 0.08, c, 12)];
    case "booth_bench":
      return [box(x, 0.24, z, 0.8, 0.48, 0.85, c), box(x + bx * 1.05, 0.62, z + bz * 1.05, Math.abs(bx) > 0.01 ? 0.16 : 0.8, 0.9, Math.abs(bz) > 0.01 ? 0.16 : 0.85, darker(c, 0.8))];
    case "table":
      return [cyl(x, 0.37, z, 0.06, 0.12, 0.74, METAL, 6), box(x, 0.76, z, 0.85, 0.05, 0.9, c), cyl(x + 0.2, 0.8, z + 0.18, 0.12, 0.12, 0.025, "#eee4d3", 10), cyl(x + 0.2, 0.88, z + 0.18, 0.07, 0.06, 0.14, "#f8f3e8", 10), cyl(x + 0.2, 0.952, z + 0.18, 0.052, 0.052, 0.005, "#4b2f21", 10)];
    case "round_table":
      return [cyl(x, 0.37, z, 0.06, 0.15, 0.74, METAL, 6), cyl(x, 0.76, z, 0.45, 0.45, 0.05, c, 14)];
    case "screen":
      return [box(x, 1.55, back + 0.06, w - 0.1, 1.9, 0.1, "#14161f")];
    case "sign":
    case "mural":
    case "string_lights":
      return d.kind === "string_lights" ? Array.from({ length: Math.max(2, Math.floor(w * 1.2)) }, (_, i) => ball(-W / 2 + 0.5 + i * (W - 1) / Math.max(1, Math.floor(w * 1.2) - 1), 2.35 - Math.sin((i / Math.floor(w * 1.2)) * Math.PI * 6) * 0.06, back + 0.1, 0.07, c)) : [];
    case "plant":
      return [cyl(x, 0.22, z, 0.22, 0.17, 0.44, "#c46a3a", 10), ball(x, 0.75, z, 0.38, LEAF, 1.15), ball(x + 0.12, 1.02, z - 0.05, 0.22, darker(LEAF, 1.15))];
    case "podium":
      return [box(x, 0.55, z, w * 0.8, 1.1, 0.7, c), box(x, 1.13, z, w * 0.85, 0.06, 0.8, darker(c, 0.75)), box(x, 0.6, z + 0.36, w * 0.4, 0.4, 0.02, "#d4a017")];
    case "ballot":
      return [box(x, 0.45, z, 0.6, 0.9, 0.6, c), box(x, 0.91, z, 0.3, 0.02, 0.06, "#2c2c2a"), box(x, 0.5, z + 0.31, 0.4, 0.2, 0.01, "#378add")];
    case "bell":
      return [box(x - 0.85, 1.1, z, 0.12, 2.2, 0.12, WOOD), box(x + 0.85, 1.1, z, 0.12, 2.2, 0.12, WOOD), box(x, 2.15, z, 1.85, 0.14, 0.14, WOOD), cyl(x, 1.55, z, 0.3, 0.62, 0.85, c, 16), ball(x, 1.98, z, 0.18, c), ball(x, 1.08, z, 0.1, darker(c, 0.6))];
    case "fountain":
      return [cyl(x, 0.2, z, 0.95, 1, 0.4, "#c9c2b6", 18), cyl(x, 0.38, z, 0.82, 0.82, 0.06, "#6fb4e8", 18), cyl(x, 0.7, z, 0.12, 0.16, 0.7, "#c9c2b6", 8), cyl(x, 1.06, z, 0.4, 0.22, 0.12, "#c9c2b6", 14), cyl(x, 1.13, z, 0.33, 0.33, 0.03, "#8ac8f0", 14), ball(x, 1.3, z, 0.12, "#a8d8f8")];
    case "railing":
      return [box(x, 0.95, back + 0.05, w, 0.07, 0.07, c), ...Array.from({ length: Math.floor(w) + 1 }, (_, i) => box(-W / 2 + i * (w / Math.floor(w)), 0.48, back + 0.05, 0.05, 0.95, 0.05, c))];
    case "sofa":
      return [box(x, 0.22, z, w * 0.95, 0.44, 0.85, c), box(x + bx, 0.6, z + bz, Math.abs(bx) > 0.01 ? 0.22 : w * 0.95, 0.75, Math.abs(bz) > 0.01 ? 0.22 : 0.85, darker(c, 0.85)), box(x - w * 0.46, 0.4, z, 0.16, 0.6, 0.85, darker(c, 0.85)), box(x + w * 0.46, 0.4, z, 0.16, 0.6, 0.85, darker(c, 0.85))];
    case "beanbag":
      return [ball(x, 0.25, z, 0.46, c, 0.6)];
    case "lamp":
      return [cyl(x, 0.05, z, 0.22, 0.25, 0.1, "#2c2c2a", 10), cyl(x, 1.1, z, 0.04, 0.05, 2.1, "#2c2c2a", 6), ball(x, 2.2, z, 0.2, "#fff2b8")];
    case "house": {
      const fx = x;
      const fz = back + 0.2;
      return [
        box(fx, 1.3, fz, w - 0.3, 2.6, 0.3, c),
        colored(new THREE.ConeGeometry((w - 0.1) * 0.72, 1.1, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.35).translate(fx, 3.15, fz), darker(c, 0.6)),
        box(fx, 0.62, fz + 0.16, 0.8, 1.24, 0.04, darker(c, 0.5)),
        ball(fx + 0.25, 0.65, fz + 0.2, 0.04, "#d4a017"),
        box(fx - (w - 0.3) * 0.3, 1.8, fz + 0.16, 0.7, 0.6, 0.04, "#fff2b8"),
        box(fx + (w - 0.3) * 0.3, 1.8, fz + 0.16, 0.7, 0.6, 0.04, "#fff2b8"),
      ];
    }
    case "jukebox":
      return [box(x, 0.65, z, 0.9, 1.3, 0.6, c), cyl(x, 1.3, z, 0.45, 0.45, 0.6, darker(c, 0.85), 14), box(x, 0.8, z + 0.31, 0.6, 0.4, 0.02, "#fff2b8")];
    case "flag":
      return [cyl(x, 1.1, z, 0.03, 0.04, 2.2, "#d4a017", 6), box(x + 0.32, 1.85, z, 0.6, 0.4, 0.02, c)];
    case "bench":
      return [box(x, 0.42, z, 0.9, 0.08, 0.45, c), box(x - 0.35, 0.2, z, 0.07, 0.4, 0.4, "#2c2c2a"), box(x + 0.35, 0.2, z, 0.07, 0.4, 0.4, "#2c2c2a"), box(x + bx * 0.6, 0.66, z + bz * 0.6, Math.abs(bx) > 0.01 ? 0.07 : 0.9, 0.4, Math.abs(bz) > 0.01 ? 0.07 : 0.45, c)];
    case "war_table":
      return [box(x, 0.4, z, w * 0.95, 0.8, dd * 0.95, c), box(x, 0.81, z, w * 0.9, 0.02, dd * 0.9, "#1d9e75")];
    case "rug":
      return [box(x, 0.012, z, w, 0.02, dd, c)];
  }
}

// Text panels: signs, screens and murals, glowing in their colour.
function useLabel(text: string, color: string, kind: Decor["kind"]) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = kind === "mural" ? 384 : 192;
    const g = c.getContext("2d")!;
    if (kind === "screen") {
      g.fillStyle = "#0f1a24";
      g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = color;
      g.globalAlpha = 0.35;
      for (let x = 40; x < c.width; x += 70) {
        g.beginPath();
        g.moveTo(x, c.height - 30);
        g.lineTo(x + 40, c.height - 30 - ((x * 37) % 90));
        g.stroke();
      }
      g.globalAlpha = 1;
    }
    g.fillStyle = color;
    g.font = `900 ${kind === "mural" ? 300 : 110}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = color;
    g.shadowBlur = kind === "sign" ? 24 : 0;
    g.fillText(text, c.width / 2, c.height / 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [text, color, kind]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

// A live board: title, rows (green up, red down, grey plain) and a credit line,
// repainted when the data changes. A dim board (stale data) fades its title
// bar and rows, and its foot (which says why) shows in amber.
function useBoard(board: Board, color: string, w: number) {
  const key = JSON.stringify(board);
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    // The canvas has the screen's shape (w - 0.25 by 1.75), so text isn't stretched.
    c.height = 360;
    c.width = Math.min(2400, Math.round((c.height * (w - 0.25)) / 1.75));
    const g = c.getContext("2d")!;
    g.fillStyle = "#0b111a";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = board.dim ? "#4a5361" : color;
    g.fillRect(0, 0, c.width, 58);
    g.fillStyle = "#0b111a";
    g.font = "900 34px ui-sans-serif, system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillText(board.title, 22, 30);
    const rowH = Math.min(46, 250 / Math.max(1, board.rows.length));
    g.font = `600 ${Math.round(rowH * 0.56)}px ui-sans-serif, system-ui, sans-serif`;
    g.globalAlpha = board.dim ? 0.45 : 1;
    board.rows.forEach((r, i) => {
      const y = 58 + rowH * (i + 0.5) + 6;
      if (i % 2) {
        g.fillStyle = "rgba(255,255,255,0.04)";
        g.fillRect(0, y - rowH / 2, c.width, rowH);
      }
      g.fillStyle = "#e6edf5";
      g.textAlign = "left";
      const right = r.right ?? "";
      const room = c.width - 44 - (right ? g.measureText(right).width + 24 : 0);
      let left = r.left;
      while (left.length > 4 && g.measureText(left).width > room) left = `${left.slice(0, -2)}…`;
      g.fillText(left, 22, y);
      if (right) {
        g.textAlign = "right";
        g.fillStyle = r.tone === "up" ? "#2bd67b" : r.tone === "down" ? "#ff4d5e" : "#9fb3c8";
        g.fillText(right, c.width - 22, y);
      }
    });
    g.globalAlpha = 1;
    if (board.foot) {
      g.textAlign = "left";
      g.fillStyle = board.dim ? "#f2c94c" : "#7d8a9c";
      g.font = "500 20px ui-sans-serif, system-ui, sans-serif";
      g.fillText(board.foot, 22, c.height - 20);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [key, color, w]); // key: the board's contents, so equal data reuses the texture
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

function BoardScreen({ d, W, H, board }: { d: Decor; W: number; H: number; board: Board }) {
  const w = d.w ?? 1;
  const tex = useBoard(board, d.color ?? "#1d9e75", w);
  return (
    <mesh position={[d.x + w / 2 - W / 2, 1.55, -H / 2 + 0.2]}>
      <planeGeometry args={[w - 0.25, 1.75]} />
      <meshBasicMaterial map={tex} toneMapped={false} />
    </mesh>
  );
}

function Label({ d, W, H }: { d: Decor; W: number; H: number }) {
  const w = d.w ?? 1;
  const tex = useLabel(d.label ?? "", d.color ?? "#ffffff", d.kind);
  const x = d.x + w / 2 - W / 2;
  const back = -H / 2 + 0.08;
  const y = d.kind === "screen" ? 1.55 : d.kind === "mural" ? 1.35 : 2.25;
  const h = d.kind === "screen" ? 1.75 : d.kind === "mural" ? 2.2 : w * 0.19;
  return (
    <mesh position={[x, y, back + (d.kind === "screen" ? 0.12 : 0.02)]}>
      <planeGeometry args={[w - (d.kind === "screen" ? 0.25 : 0.1), h]} />
      <meshBasicMaterial map={tex} transparent toneMapped={false} />
    </mesh>
  );
}

function checker(a: string, b: string, w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    ctx.fillStyle = (x + y) % 2 ? b : a;
    ctx.fillRect(x * 128, y * 128, 128, 128);
    ctx.strokeStyle = "rgba(40,30,20,0.12)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x * 128 + 1, y * 128 + 1, 126, 126);
  }
  // Fine, deterministic surface variation. No external texture downloads.
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.035)" : "rgba(25,20,15,0.025)";
    ctx.fillRect((i * 73) % 256, (i * 37 + Math.floor(i / 256) * 19) % 256, 1, 2);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(w / 2, h / 2);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export default function Interior({ layout, w, h, low = false, onFloor, feeds = {} }: { layout: Layout; w: number; h: number; low?: boolean; onFloor?: (x: number, z: number) => void; feeds?: Partial<Record<FeedKey, Board>> }) {
  const { look, decor } = layout;
  const wallH = low ? 1.1 : 2.8;
  const built = useMemo(() => {
    const parts: Part[] = [
      // Walls: back and left full height with a darker band below, low trims at the front.
      box(0, -0.16, 0, w + 0.5, 0.3, h + 0.5, "#a89e8e"),
      box(0, 0.08, -h / 2 + 0.03, w, 0.16, 0.08, "#eee4d3"),
      box(-w / 2 + 0.03, 0.08, 0, 0.08, 0.16, h, "#eee4d3"),
      box(0, 0.94, -h / 2 + 0.025, w, 0.06, 0.08, "#eee4d3"),
      box(-w / 2 + 0.025, 0.94, 0, 0.08, 0.06, h, "#eee4d3"),
      box(0, wallH / 2, -h / 2 - 0.08, w + 0.32, wallH, 0.16, look.wall),
      box(0, 0.45, -h / 2 + 0.005, w + 0.02, 0.9, 0.02, look.wall2),
      box(-w / 2 - 0.08, wallH / 2, 0, 0.16, wallH, h, look.wall),
      box(-w / 2 + 0.005, 0.45, 0, 0.02, 0.9, h, look.wall2),
      box(0, 0.12, h / 2 + 0.08, w + 0.32, 0.24, 0.16, look.wall2),
      box(w / 2 + 0.08, 0.12, 0, 0.16, 0.24, h, look.wall2),
      ...decor.flatMap((d) => piece(d, w, h)),
    ];
    const merged = mergeGeometries(parts, false)!;
    parts.forEach((p) => p.dispose());
    return merged;
  }, [decor, look, w, h, wallH]);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.03 }), []);
  const ink = useMemo(() => outlineMaterial(0.005), []);
  const floor = useMemo(() => checker(look.floor, look.floor2, w, h), [look.floor, look.floor2, w, h]);
  useEffect(
    () => () => {
      built.dispose();
      mat.dispose();
      ink.dispose();
      floor.dispose();
    },
    [built, mat, ink, floor],
  );
  return (
    <group>
      <mesh
        receiveShadow
        rotation-x={-Math.PI / 2}
        onPointerDown={
          onFloor
            ? (e) => {
                e.stopPropagation();
                onFloor(e.point.x, e.point.z);
              }
            : undefined
        }
      >
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial map={floor} roughness={0.72} metalness={0.03} />
      </mesh>
      <mesh geometry={built} material={mat} castShadow receiveShadow />
      <mesh geometry={built} material={ink} />
      {decor
        .filter((d) => d.label && (d.kind === "sign" || d.kind === "screen" || d.kind === "mural"))
        .map((d, i) => {
          const board = d.feed ? feeds[d.feed] : undefined;
          return board ? <BoardScreen key={i} d={d} W={w} H={h} board={board} /> : <Label key={i} d={d} W={w} H={h} />;
        })}
    </group>
  );
}
