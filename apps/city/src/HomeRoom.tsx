"use client";
import type { ThreeEvent } from "@react-three/fiber";
import type { PlacedItem, Placement } from "./api";
import { FLOOR_COLORS, WALL_COLORS, footprintSize, pieceColor, pieceHeight, pieceOf } from "./furniture";

// A home drawn in 3D: floor and walls in their finishes, and every placed
// piece as a block in its colour. Cells are 1 unit; the room is centred.

type Props = {
  w: number;
  d: number;
  wallFinish: string;
  floorFinish: string;
  placed: PlacedItem[];
  selected?: string | null;
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
  const color = ghost ? (ghost === "ok" ? "#1d9e75" : "#e24b4a") : pieceColor(pieceId, placement.color);
  return (
    <mesh
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
      <boxGeometry args={pose.size as unknown as [number, number, number]} />
      <meshStandardMaterial color={color} transparent={!!ghost} opacity={ghost ? 0.55 : 1} emissive={highlight ? "#ffffff" : "#000000"} emissiveIntensity={highlight ? 0.25 : 0} />
    </mesh>
  );
}

export function HomeRoom({ w, d, wallFinish, floorFinish, placed, selected, ghost, onCell, onPiece, onWall }: Props) {
  const wall = WALL_COLORS[wallFinish] ?? "#efc6a8";
  const floor = FLOOR_COLORS[floorFinish] ?? "#b08355";
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
      <mesh
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
        <meshStandardMaterial color={floor} />
      </mesh>
      {/* Grid lines in edit mode help aim. */}
      {onCell && <gridHelper args={[Math.max(w, d), Math.max(w, d), "#00000033", "#00000022"]} position-y={0.01} />}
      {/* Cutaway: tall walls at the back (north, west), low trims at the front. */}
      <mesh position={[0, 1.3, -d / 2 - 0.05]} onPointerDown={wallTap("n")}>
        <boxGeometry args={[w + 0.2, 2.6, 0.1]} />
        <meshStandardMaterial color={wall} />
      </mesh>
      <mesh position={[-w / 2 - 0.05, 1.3, 0]} onPointerDown={wallTap("w")}>
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
