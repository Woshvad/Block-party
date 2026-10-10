"use client";
import { Html, MapControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { clampTarget } from "./camera";
import { DISTRICT_NAMES, GRID, LANDMARKS, type PlaceKey, SOON, SQUARE, blockRect, zoneOf } from "./citygen";
import CityScape from "./CityScape";
import { PLACE_INFO } from "./places";
import type { Api, Me } from "./api";
import ChibiCrowd, { type ChibiPerson } from "./chibi/Crowd";
import { until, useNow } from "./clock";
import { useLoad } from "./useLoad";
import { PerfProbe, SHOW_PERF } from "./PerfHud";
import { haptic, initTelegram } from "./telegram";

// The city board, SimCity style: an isometric view over a street grid of
// zoned blocks, traffic and people on the sidewalks, our landmarks with a
// pin over each. Bright by day; windows and street lights glow at night.

type Place = { key: PlaceKey; name: string; icon: string; info: string };
type Picked = { name: string; icon: string; info: string; soon?: boolean };
const PLACES: Place[] = (Object.keys(LANDMARKS) as PlaceKey[]).map((key) => ({ key, name: PLACE_INFO[key]!.name, icon: PLACE_INFO[key]!.icon, info: PLACE_INFO[key]!.info }));

// Pins float over each landmark at a fixed size on screen.
function Pins({ onTap }: { onTap: (p: Place) => void }) {
  return (
    <>
      {PLACES.map((p) => {
        const l = LANDMARKS[p.key];
        return (
          <Html key={p.key} position={[l.x, l.pinY, l.z]} center zIndexRange={[1, 0]}>
            {/* Live headcounts arrive with the rooms' presence endpoint; until then, no made-up numbers. */}
            <button className="pin" onClick={() => onTap(p)} aria-label={p.name}>
              <span className="ico">{p.icon}</span>
              <span className="name">{p.name}</span>
            </button>
          </Html>
        );
      })}
    </>
  );
}

// The launch places: on the map, locked until launch.
function SoonPins({ onTap }: { onTap: (p: Picked) => void }) {
  return (
    <>
      {Object.values(SOON).map((p) => (
        <Html key={p.name} position={[p.x, p.pinY, p.z]} center zIndexRange={[1, 0]}>
          <button className="pin soon" onClick={() => onTap({ name: p.name, icon: p.icon, info: "Opens at launch.", soon: true })} aria-label={`${p.name}, opens at launch`}>
            <span className="ico">{p.icon}</span>
            <span className="name">
              {p.name}
              <small>opens at launch</small>
            </span>
            <span className="lock">🔒</span>
          </button>
        </Html>
      ))}
    </>
  );
}

// District names, painted low over each quarter of the city.
// The districts on the map: a badge each, in its own colour, with what's there.
const DISTRICTS: { key: string; name: string; icon: string; tag: string; color: string; x: number; z: number }[] = [
  { key: "oracle", name: DISTRICT_NAMES.oracle, icon: "🔮", tag: "Odds, calls and the big screen", color: "#6d4fd8", ...blockRect(1, 0) },
  { key: "trenches", name: DISTRICT_NAMES.trenches, icon: "🔥", tag: "Diner, club and late nights", color: "#e0457b", ...blockRect(5, 0) },
  { key: "square", name: DISTRICT_NAMES.square, icon: "🏛️", tag: "gm, the drip and the vote", color: "#378add", x: SQUARE.x, z: SQUARE.z + SQUARE.d / 2 + GRID.road + 1 }, // on the avenue south of the plaza, clear of its pins
  { key: "residences", name: DISTRICT_NAMES.residences, icon: "🏡", tag: "Homes and Crew Row", color: "#2f9e5b", ...blockRect(0, 3) },
  { key: "yard", name: DISTRICT_NAMES.yard, icon: "🛠️", tag: "Build, paint and ship", color: "#d98a1c", ...blockRect(5, 3) },
  { key: "lagoon", name: DISTRICT_NAMES.lagoon, icon: "🌊", tag: "Plots, billboards and the Rollup", color: "#1f8fb8", x: blockRect(0, 5).x + 2, z: blockRect(0, 5).z }, // the west end, clear of the Rollup
];
function DistrictLabels() {
  return (
    <>
      {DISTRICTS.map((d) => (
        <Html key={d.key} position={[d.x, 3, d.z]} center zIndexRange={[0, 0]} style={{ pointerEvents: "none" }}>
          <div className="district" style={{ "--d": d.color } as React.CSSProperties}>
            <span className="d-ico">{d.icon}</span>
            <span className="d-text">
              <b>{d.name}</b>
              <small>{d.tag}</small>
            </span>
          </div>
        </Html>
      ))}
    </>
  );
}

// How close the camera is: zoomed out the map shows district badges and bare
// pins; closer in, pins show their names and the badges step back.
// (Set on the page root: drei's labels render outside the canvas's own box.)
function ZoomLevel() {
  const camera = useThree((s) => s.camera);
  const last = useRef("");
  useEffect(() => () => document.documentElement.removeAttribute("data-zoom"), []);
  useFrame(() => {
    const z = camera.zoom;
    const level = z < 13 ? "far" : z < 30 ? "mid" : "near";
    if (level === last.current) return;
    last.current = level;
    document.documentElement.setAttribute("data-zoom", level);
  });
  return null;
}

// The bell rings at 00:00 UTC; used until the Slate (which carries it) loads.
const nextBell = (now: number) => new Date(Math.floor(now / 86_400_000 + 1) * 86_400_000).toISOString();

// The Tower's LED crown glows with the market: green when the city's favourites are up, red when down.
function TowerTop({ night }: { night: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current?.material as THREE.MeshBasicMaterial | undefined;
    if (m) m.color.setHSL(Math.sin(clock.elapsedTime * 0.4) > 0 ? 0.42 : 0.0, 0.75, night ? 0.55 : 0.47);
  });
  return (
    <mesh ref={ref} position={[LANDMARKS.tower.x, 17.05, LANDMARKS.tower.z]}>
      <boxGeometry args={[2.6, 0.32, 2.6]} />
      <meshBasicMaterial toneMapped={false} />
    </mesh>
  );
}

// The isometric camera: fixed angle (no orbiting, like SimCity); fits about
// 22 tiles across a phone held upright, 40 across a laptop.
const ISO = new THREE.Vector3(1, 0.85, 1).normalize();
function IsoRig() {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const size = useThree((s) => s.size);
  useEffect(() => {
    const across = size.width < size.height ? 22 : 40;
    camera.zoom = size.width / across;
    camera.position.copy(ISO).multiplyScalar(90);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);
  return null;
}

// People strolling the sidewalks round the blocks: little chibis drawn by the shared crowd renderer.
const STROLL_SCALE = 0.45;
const WALKABLE = Array.from({ length: GRID.blocks * GRID.blocks }, (_, k) => ({ bx: k % GRID.blocks, bz: Math.floor(k / GRID.blocks) })).filter((b) => !["square", "water", "locked"].includes(zoneOf(b.bx, b.bz)));
function Strollers() {
  const loops = useMemo(() => Array.from({ length: 36 }, (_, i) => ({ b: blockRect(WALKABLE[i % WALKABLE.length]!.bx, WALKABLE[i % WALKABLE.length]!.bz), t: (i * 0.618) % 1, dir: i % 2 ? 1 : -1, speed: 0.012 + (i % 5) * 0.002 })), []);
  const people = useRef<ChibiPerson[]>(loops.map((_, i) => ({ id: `stroller-${i}`, look: null, x: 0, z: 0, yaw: 0, moving: true, phase: i, dim: false })));
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    loops.forEach((l, i) => {
      l.t = (l.t + l.dir * l.speed * dt + 1) % 1;
      // On the sidewalk: walkers keep right, so the two directions use their own lanes.
      const o = l.b.w / 2 + (l.dir > 0 ? 0.2 : -0.02);
      const side = Math.floor(l.t * 4);
      const f = l.t * 4 - side;
      const pts = [
        [l.b.x - o, l.b.z - o],
        [l.b.x + o, l.b.z - o],
        [l.b.x + o, l.b.z + o],
        [l.b.x - o, l.b.z + o],
      ] as const;
      const a = pts[side]!;
      const b = pts[(side + 1) % 4]!;
      const p = people.current[i]!;
      p.x = (a[0] + (b[0] - a[0]) * f) / STROLL_SCALE;
      p.z = (a[1] + (b[1] - a[1]) * f) / STROLL_SCALE;
      p.yaw = Math.atan2((b[0] - a[0]) * l.dir, (b[1] - a[1]) * l.dir);
      p.phase += dt * 8;
    });
  });
  return (
    <group scale={STROLL_SCALE} position-y={0.14}>
      <ChibiCrowd people={people} cap={36} />
    </group>
  );
}

export default function CityBoard({ api, me, onOpenToday, onPlace, onOpenHall, onOpenMe }: { api: Api; me: Me; onOpenToday?: () => void; onPlace?: (place: string, ridesFree: boolean) => void; onOpenHall?: () => void; onOpenMe?: () => void }) {
  const hall = useLoad(() => api.cityHall(), [api]);
  const slate = useLoad(() => api.slate(), [api]);
  const now = useNow(1000);
  const h = hall.data;
  const s = slate.data;
  const bellAt = s?.bellAt ?? nextBell(now);
  const hour = new Date().getHours();
  const [night, setNight] = useState(hour >= 19 || hour < 6);
  const [picked, setPicked] = useState<Picked | null>(null);
  const perf = useRef<HTMLDivElement>(null);
  useEffect(() => {
    initTelegram();
  }, []);
  return (
    <>
      {/* Mock values until the API is wired in phase 1. */}
      <div className="banner" role="button" onClick={onOpenHall}>
        {h?.mayor ? (
          <>
            Mayor <b>@{h.mayor.handle}</b>
          </>
        ) : (
          "No Mayor yet"
        )}
        {" · "}
        {h?.law ? (
          <>
            Law: <b>{h.law.name}</b>
          </>
        ) : h?.election?.phase === "voting" ? (
          <>
            Polls close in <b>{until(h.election.pollsClose, now)}</b>
          </>
        ) : (
          "No Law this week"
        )}
      </div>
      <div className="hud">
        {me?.resident ? (
          <button className="pill" onClick={onOpenMe}>
            @{me.resident.handle} · <b>{me.gm.toLocaleString("en-US")} GM</b>
          </button>
        ) : null}
        <div className="pill">
          🔔 Bell in <b>{until(bellAt, now)}</b>
        </div>
        {s && (
          <button className="pill" onClick={onOpenToday}>
            Slate #{s.number} · {s.cards.filter((c) => c.mine).length}/{s.cards.length} called ›
          </button>
        )}
        <button className="pill" onClick={() => setNight((n) => !n)}>
          {night ? "Show day" : "Show night"}
        </button>
        {SHOW_PERF && (
          <div className="perf" ref={perf}>
            measuring…
          </div>
        )}
      </div>
      {picked && (
        <div className="sheet" onClick={() => setPicked(null)}>
          <strong>
            {picked.icon} {picked.name}
          </strong>
          <span className="muted">{picked.info}</span>
          <span className="go">{picked.soon ? "Being built now: the doors open at launch." : "Move in to visit: open Block Party in Telegram."}</span>
        </div>
      )}
      <div className="stage" style={{ background: night ? "linear-gradient(#05070f, #1a2240 60%, #2a2f55)" : "linear-gradient(#8ec5f0, #cfe6f7 55%, #f4efe4)" }}>
        <Canvas shadows orthographic dpr={[1, 2]} camera={{ position: [60, 52, 60], zoom: 20, near: 0.1, far: 400 }} gl={{ antialias: true, powerPreference: "high-performance" }}>
          <hemisphereLight args={[night ? "#6b7cff" : "#ffffff", night ? "#0b1020" : "#b9c79d", night ? 0.9 : 1.15]} />
          {/* The sun, casting real shadows over the whole city. */}
          <directionalLight
            position={[22, 34, 12]}
            intensity={night ? 0.45 : 1.7}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-camera-left={-44}
            shadow-camera-right={44}
            shadow-camera-top={44}
            shadow-camera-bottom={-44}
            shadow-camera-far={120}
            shadow-bias={-0.0004}
            shadow-normalBias={0.03}
          />
          <CityScape night={night} />
          <TowerTop night={night} />
          <Strollers />
          <Pins
            onTap={(p) => {
              haptic("light");
              // Residents go there; guests can only look.
              if (me.resident && onPlace) onPlace(p.key, h?.law?.id === "gas_holiday");
              else setPicked(p);
            }}
          />
          <SoonPins
            onTap={(p) => {
              haptic("light");
              setPicked(p);
            }}
          />
          <DistrictLabels />
          <ZoomLevel />
          <IsoRig />
          <MapControls
            makeDefault
            enableRotate={false}
            screenSpacePanning={false}
            minZoom={8}
            maxZoom={90}
            onChange={(e) => {
              // Keep the board under the player's thumb: shift camera and focus together.
              const c = e?.target as unknown as { target: THREE.Vector3; object: THREE.Camera } | undefined;
              if (!c) return;
              const t = clampTarget(c.target.x, c.target.z);
              const dx = t.x - c.target.x;
              const dz = t.z - c.target.z;
              if (dx || dz) {
                c.target.x += dx;
                c.target.z += dz;
                c.object.position.x += dx;
                c.object.position.z += dz;
              }
            }}
          />
          {SHOW_PERF && <PerfProbe target={perf} />}
        </Canvas>
      </div>
    </>
  );
}
