"use client";
import * as THREE from "three";
import { useEffect, useMemo } from "react";
import { furnitureGeometry } from "./furnitureGeometry";
import type { ThreeEvent } from "@react-three/fiber";
import type { PlacedItem, Placement } from "./api";
import { FLOOR_COLORS, WALL_COLORS, footprintSize, pieceColor, pieceHeight, pieceOf } from "./furniture";

// A home drawn in 3D: floor and walls in their finishes, and every placed
// piece with its own silhouette and surface details. Cells are 1 unit; the room is centred.

type Props = {
  w: number;
  d: number;
  wallFinish: string;
  floorFinish: string;
  placed: PlacedItem[];
  selected?: string | null;
  editing?: boolean;
  ghost?: { pieceId: string; placement: Placement; ok: boolean } | null;
  onCell?: (x: number, y: number) => void;
  onPiece?: (itemId: string) => void;
  onWall?: (wall: "n" | "e" | "s" | "w", offset: number) => void;
};

export function piecePose(pieceId: string, pl: Placement, w: number, d: number) {
  const piece = pieceOf(pieceId);
  if (pl.layer === "wall") {
    const len = piece?.w ?? 1;
    const along = pl.offset + len / 2;
    const y = 1.35;
    if (pl.wall === "n") return { pos: [along - w / 2, y, -d / 2 + 0.06] as const, size: [len * 0.92, 0.9, 0.06] as const, rotY: 0 };
    if (pl.wall === "s") return { pos: [along - w / 2, y, d / 2 - 0.06] as const, size: [len * 0.92, 0.9, 0.06] as const, rotY: 0 };
    if (pl.wall === "w") return { pos: [-w / 2 + 0.06, y, along - d / 2] as const, size: [0.06, 0.9, len * 0.92] as const, rotY: 0 };
    return { pos: [w / 2 - 0.06, y, along - d / 2] as const, size: [0.06, 0.9, len * 0.92] as const, rotY: 0 };
  }
  const f = footprintSize(pieceId, pl.rot);
  const h = pieceHeight(pieceId);
  return { pos: [pl.x + f.w / 2 - w / 2, h / 2 + (pl.layer === "rug" ? 0.005 : 0), pl.y + f.d / 2 - d / 2] as const, size: [f.w * 0.94, h, f.d * 0.94] as const, rotY: 0 };
}

function Piece({ pieceId, placement, w, d, highlight, ghost, onTap }: { pieceId: string; placement: Placement; w: number; d: number; highlight?: boolean; ghost?: "ok" | "bad"; onTap?: () => void }) {
  const pose = piecePose(pieceId, placement, w, d);
  const f = pieceOf(pieceId);
  const detailed = placement.layer !== "wall";
  const width = detailed ? (f?.w ?? 1) * 0.94 : pose.size[0];
  const depth = detailed ? (f?.d ?? 1) * 0.94 : pose.size[2];
  const color = ghost ? (ghost === "ok" ? "#1d9e75" : "#e24b4a") : pieceColor(pieceId, placement.color);
  const geometry = useMemo(() => furnitureGeometry(detailed ? pieceId : "frame", width, pose.size[1], depth, color), [pieceId, width, pose.size[1], depth, color, detailed]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
      rotation-y={placement.layer === "wall" ? 0 : placement.rot * Math.PI / 180}
      castShadow={!ghost} receiveShadow
      position={pose.pos as unknown as [number, number, number]}
      onPointerDown={
        onTap
          ? (e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation();
              onTap();
            }
          : undefined
      }
    >
      <meshStandardMaterial vertexColors roughness={0.8} transparent={!!ghost} opacity={ghost ? 0.55 : 1} emissive={highlight ? "#ffffff" : "#000000"} emissiveIntensity={highlight ? 0.25 : 0} />
    </mesh>
  );
}

function floorTexture(finish: string, w: number, d: number) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f5f1e9";
  g.fillRect(0, 0, 256, 256);
  if (finish === "boards" || finish === "tatami") {
    for (let row = 0; row < 8; row++) {
      g.fillStyle = row % 3 ? "#ece6d9" : "#e3daca";
      g.fillRect(0, row * 32, 256, 31);
      g.fillStyle = "#bdae99";
      g.fillRect(row % 2 ? 80 : 190, row * 32, 1, 32);
    }
  } else if (finish === "checker") {
    g.fillStyle = "#999b96";
    g.fillRect(0, 0, 128, 128);
    g.fillRect(128, 128, 128, 128);
  }
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = i % 2 ? "#ffffff12" : "#41342309";
    g.fillRect((i * 73) % 256, (i * 41 + Math.floor(i / 256)) % 256, finish === "boards" ? 14 : 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(w / 3, d / 3);
  t.anisotropy = 4;
  return t;
}

export function HomeRoom({ w, d, wallFinish, floorFinish, placed, selected, ghost, onCell, onPiece, onWall, editing = false }: Props) {
  const wall = WALL_COLORS[wallFinish] ?? "#efc6a8";
  const floor = FLOOR_COLORS[floorFinish] ?? "#b08355";
  const texture = useMemo(() => floorTexture(floorFinish, w, d), [floorFinish, w, d]);
  useEffect(() => () => texture.dispose(), [texture]);
  const wallTap = (which: "n" | "e" | "s" | "w") =>
    onWall
      ? (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          const along = which === "n" || which === "s" ? e.point.x + w / 2 : e.point.z + d / 2;
          onWall(which, Math.floor(along));
        }
      : undefined;
  return (
    <group>
      <mesh receiveShadow
        rotation-x={-Math.PI / 2}
        onPointerDown={
          onCell
            ? (e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation();
                onCell(Math.floor(e.point.x + w / 2), Math.floor(e.point.z + d / 2));
              }
            : undefined
        }
      >
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial map={texture} color={floor} roughness={floorFinish === "glass_led" ? 0.25 : 0.85} />
      </mesh>
      {/* Grid lines in edit mode help aim. */}
      {editing && <gridHelper args={[Math.max(w, d), Math.max(w, d), "#998b76", "#b9ac96"]} position-y={0.01} />}
      {/* Cutaway: tall walls at the back (north, west), low trims at the front. */}
      <mesh castShadow receiveShadow position={[0, 1.3, -d / 2 - 0.05]} onPointerDown={wallTap("n")}>
        <boxGeometry args={[w + 0.2, 2.6, 0.1]} />
        <meshStandardMaterial color={wall} />
      </mesh>
      <mesh castShadow receiveShadow position={[-w / 2 - 0.05, 1.3, 0]} onPointerDown={wallTap("w")}>
        <boxGeometry args={[0.1, 2.6, d]} />
        <meshStandardMaterial color={wall} />
      </mesh>
      <mesh position={[w / 2 + 0.05, 1.3, 0]} onPointerDown={wallTap("e")}>
        <boxGeometry args={[0.1, 2.6, d]} />
        <meshStandardMaterial color={wall} transparent opacity={0.18} depthWrite={false} />
      </mesh>
      <mesh position={[0, 1.3, d / 2 + 0.05]} onPointerDown={wallTap("s")}>
        <boxGeometry args={[w + 0.2, 2.6, 0.1]} />
        <meshStandardMaterial color={wall} transparent opacity={0.18} depthWrite={false} />
      </mesh>
      {placed.map((p) => (
        <Piece key={p.itemId} pieceId={p.pieceId} placement={p.placement} w={w} d={d} highlight={selected === p.itemId} onTap={onPiece ? () => onPiece(p.itemId) : undefined} />
      ))}
      {ghost && <Piece pieceId={ghost.pieceId} placement={ghost.placement} w={w} d={d} ghost={ghost.ok ? "ok" : "bad"} />}
    </group>
  );
}
