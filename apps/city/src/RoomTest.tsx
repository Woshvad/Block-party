"use client";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import ChibiCrowd, { type ChibiPerson } from "./chibi/Crowd";
import { rng } from "./crowd";
import { HomeRoom } from "./HomeRoom";
import type { PlacedItem } from "./api";
import { footprintSize } from "./furniture";
import Interior from "./Interior";
import { layoutFor, planFor } from "./interiors";
import { type Plan, makePlan, findPath, nearestFree, toTile, toWorld } from "./plan";
import { type Body, step } from "./steer";
import { PerfProbe } from "./PerfHud";
import { RoomCamera, RoomLighting } from "./RoomLighting";
import { PLACE_INFO, roomSize } from "./places";

const HOME_ITEMS: PlacedItem[] = [
  ["double_bed", 0, 0], ["sofa", 4, 1], ["coffee_table", 4, 3],
  ["plant_monstera", 7, 0], ["floor_lamp", 3, 0], ["gaming_desk", 0, 6],
].map(([pieceId, x, y], i) => ({ room: "main", itemId: `preview-${i}`, pieceId: String(pieceId), placement: { layer: "floor", x: Number(x), y: Number(y), rot: 0, color: 0 } }));
const PREVIEW_PLACES: Record<string, { name: string; icon: string }> = { ...PLACE_INFO, home: { name: "Your home", icon: "🏡" } };

// A public visual/performance preview. It uses the same interiors, lighting,
// camera and character renderer as live rooms, with explicitly simulated people.
function PreviewCrowd({ plan, count, busy }: { plan: Plan; count: number; busy: boolean }) {
  const random = useMemo(() => rng(42), []);
  const people = useRef<(ChibiPerson & Body & { idle: number })[]>([]);
  if (!people.current.length) {
    people.current = Array.from({ length: count }, (_, i) => {
      const seat = !busy && i < 6 ? plan.seats[i] : undefined;
      const tile = seat ?? nearestFree(plan, { x: 1 + (i * 7) % (plan.w - 2), y: 1 + (Math.floor(i / 3) * 3) % (plan.h - 2) })!;
      const p = toWorld(plan, tile);
      return { id: `preview-${i}`, look: null, x: p.x, z: p.z, yaw: seat?.facing ?? 0,
        moving: false, phase: i, vx: 0, vz: 0, path: [], fixed: !!seat,
        sitY: seat ? seat.h ?? 0.45 : null, idle: 2 + random() * 12, speed: 1.1 + random() * 0.7 };
    });
  }
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    for (const p of people.current) {
      if (p.fixed || p.path.length) continue;
      p.idle -= dt;
      if (p.idle <= 0) {
        const target = nearestFree(plan, { x: 1 + Math.floor(random() * (plan.w - 2)), y: 1 + Math.floor(random() * (plan.h - 2)) });
        if (target) p.path = findPath(plan, toTile(plan, p.x, p.z), target).map((t) => toWorld(plan, t));
        p.idle = 4 + random() * 10;
      }
    }
    step(people.current, dt, plan);
    for (const p of people.current) {
      const speed = Math.hypot(p.vx, p.vz);
      p.moving = speed > 0.15;
      if (p.moving) p.phase += dt * 3.5 * speed;
    }
  });
  return <ChibiCrowd people={people} cap={count} />;
}

export default function RoomTest() {
  const [place, setPlace] = useState("diner");
  const [busy, setBusy] = useState(false);
  const perf = useRef<HTMLDivElement>(null);
  const size = roomSize(place)!;
  const plan = useMemo(() => planFor(place) ?? makePlan(8, 8, HOME_ITEMS.map((p) => {
    const pl = p.placement as { x: number; y: number; rot: number };
    const f = footprintSize(p.pieceId, pl.rot);
    return { x: pl.x, y: pl.y, w: f.w, d: f.d };
  })), [place]);
  const layout = layoutFor(place)!;
  const count = busy ? 60 : place === "home" ? 3 : 14;
  const span = Math.max(size.w, size.h);
  return <main className="room-preview">
    <header className="preview-header">
      <a className="brand-mark" href="/" aria-label="Block Party home">bp<span>·</span></a>
      <div><span className="eyebrow">THE CITY, UP CLOSE</span><h1>{PREVIEW_PLACES[place]!.name}</h1></div>
      <span className="preview-badge">Preview</span>
    </header>
    <div className="stage room-stage">
      <Canvas shadows dpr={[1, 1.5]} camera={{ position: [14, 15, 17], fov: 45 }} gl={{ antialias: true }}>
        <RoomLighting span={span} outdoor={place === "roof"} />
        {place === "home" ? <HomeRoom w={8} d={8} wallFinish="plaster" floorFinish="boards" placed={HOME_ITEMS} /> : <Interior layout={layout} w={size.w} h={size.h} low={place === "roof"} />}
        <PreviewCrowd key={`${place}:${busy}`} plan={plan} count={count} busy={busy} />
        <RoomCamera w={size.w} h={size.h} />
        <OrbitControls enablePan={false} minPolarAngle={0.5} maxPolarAngle={1.15} minDistance={span * 0.65} maxDistance={span * 8} />
        <PerfProbe target={perf} />
      </Canvas>
    </div>
    <aside className="preview-info"><span className="live-dot" />{count} simulated neighbours · drag to look around</aside>
    <footer className="preview-dock">
      <div className="preview-places" aria-label="Preview a room">
        {["diner", "roof", "watch_party", "home"].map((p) => <button key={p} className={place === p ? "on" : ""} aria-pressed={place === p} onClick={() => setPlace(p)}>{PREVIEW_PLACES[p]!.icon}<span>{p === "watch_party" ? "Watch Party" : PREVIEW_PLACES[p]!.name}</span></button>)}
      </div>
      <div className="preview-meta"><button className="link" onClick={() => setBusy((v) => !v)}>{busy ? "Show a quiet room" : "Try a 60-person crowd"}</button><div className="preview-perf" ref={perf}>Measuring…</div></div>
    </footer>
  </main>;
}
