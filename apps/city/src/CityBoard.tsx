"use client";
import { Html, MapControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { BOARD, clampTarget, fitCamera } from "./camera";
import type { Api, Me } from "./api";
import { until, useNow } from "./clock";
import { useLoad } from "./useLoad";
import { PerfProbe, SHOW_PERF } from "./PerfHud";
import { haptic, initTelegram } from "./telegram";

// The city board: low-poly blocks from an angled camera, a pin with a live
// headcount over every place. Bright by day, neon at night (the plan's look).

type Place = { key: string; name: string; icon: string; x: number; z: number; w: number; d: number; h: number; day: string; night: string; info: string };
const PLACES: Place[] = [
  { key: "tower", name: "Prediction Tower", icon: "🔮", x: 0, z: 0, w: 3, d: 3, h: 11, day: "#6b63c9", night: "#5a4fb0", info: "The odds wall and every call" },
  { key: "city_hall", name: "City Hall", icon: "🏛️", x: -8, z: -3, w: 4.5, d: 3.5, h: 3.6, day: "#8fb1e0", night: "#4a5c94", info: "The Mayor, the Law and the election" },
  { key: "watch_party", name: "Watch Party Hall", icon: "📺", x: 8, z: -3, w: 4.5, d: 3.5, h: 3.2, day: "#8f7cc0", night: "#5b437f", info: "Big games on the big screen" },
  { key: "gm_wall", name: "gm Wall", icon: "☀️", x: 5, z: 6, w: 3.5, d: 1.2, h: 2, day: "#97c459", night: "#4b6b3f", info: "Say gm with the city" },
  { key: "faucet", name: "The Faucet", icon: "🚰", x: -2, z: 8, w: 2, d: 2, h: 1.6, day: "#85b7eb", night: "#38608a", info: "Free GM help from Faucet Fren" },
  { key: "diner", name: "Gwei Diner", icon: "🍔", x: 10, z: 5, w: 3.2, d: 2.6, h: 2.2, day: "#f09595", night: "#7a4040", info: "Booths for you and your crew" },
];
// Districts painted on the ground, and empty lots for what's coming next.
const DISTRICTS = [
  { name: "TOWER SQUARE", x: -2.2, z: 3.6 },
  { name: "CREW ROW", x: -9.4, z: 8.6 },
  { name: "OLD TOWN", x: -8, z: -6.4 },
  { name: "THE STRIP", x: 9, z: 1.3 },
];
const LOTS = [
  { x: 12.5, z: -9, w: 5, d: 4 },
  { x: -1, z: -9.5, w: 5, d: 3.5 },
];
const HOMES = Array.from({ length: 6 }, (_, i) => ({ x: -12 + (i % 3) * 2.6, z: 3 + Math.floor(i / 3) * 3 }));

function Building({ p, night, onTap }: { p: Place; night: boolean; onTap: (p: Place) => void }) {
  return (
    <group position={[p.x, 0, p.z]}>
      <mesh position-y={p.h / 2} onPointerDown={() => onTap(p)}>
        <boxGeometry args={[p.w, p.h, p.d]} />
        <meshStandardMaterial color={night ? p.night : p.day} flatShading />
      </mesh>
      {/* Lit windows at night, painted trim by day. */}
      <mesh position={[0, p.h * 0.55, p.d / 2 + 0.01]}>
        <planeGeometry args={[p.w * 0.7, p.h * 0.5]} />
        <meshBasicMaterial color={night ? (p.key === "tower" ? "#1d9e75" : "#fac775") : "#f4f1ea"} transparent opacity={night ? 0.9 : 0.35} />
      </mesh>
      <Html position={[0, p.h + 0.9, 0]} center distanceFactor={40} zIndexRange={[1, 0]}>
        {/* Live headcounts arrive with the rooms' presence endpoint; until then, no made-up numbers. */}
        <button className="pin" onClick={() => onTap(p)} aria-label={p.name}>
          <span className="ico">{p.icon}</span>
        </button>
      </Html>
    </group>
  );
}

// The bell rings at 00:00 UTC; used until the Slate (which carries it) loads.
const nextBell = (now: number) => new Date(Math.floor(now / 86_400_000 + 1) * 86_400_000).toISOString();

// The Tower's top glows with the market: green when the city's favourites are up, red when down.
function TowerTop({ night }: { night: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current?.material as THREE.MeshBasicMaterial | undefined;
    if (m) m.color.setHSL(Math.sin(clock.elapsedTime * 0.4) > 0 ? 0.42 : 0.0, 0.7, night ? 0.5 : 0.45);
  });
  return (
    <mesh ref={ref} position={[0, 11.4, 0]}>
      <boxGeometry args={[3.2, 0.8, 3.2]} />
      <meshBasicMaterial />
    </mesh>
  );
}

// Words painted flat on the ground, from a small canvas (no font download).
function useWords(text: string, color: string, dashed = false) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = dashed ? 384 : 96;
    const g = c.getContext("2d")!;
    if (dashed) {
      g.strokeStyle = color;
      g.lineWidth = 10;
      g.setLineDash([28, 18]);
      g.strokeRect(8, 8, c.width - 16, c.height - 16);
    }
    g.fillStyle = color;
    g.font = `800 ${dashed ? 54 : 64}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, c.width / 2, c.height / 2);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }, [text, color, dashed]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

function GroundWords({ text, x, z, night }: { text: string; x: number; z: number; night: boolean }) {
  const tex = useWords(text, night ? "rgba(230,241,251,0.35)" : "rgba(20,22,31,0.28)");
  return (
    <mesh rotation-x={-Math.PI / 2} position={[x, 0.03, z]}>
      <planeGeometry args={[5.6, 1.05]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} />
    </mesh>
  );
}

function ComingSoon({ x, z, w, d, night }: { x: number; z: number; w: number; d: number; night: boolean }) {
  const tex = useWords("Coming soon", night ? "rgba(230,241,251,0.55)" : "rgba(20,22,31,0.45)", true);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[x, 0.03, z]}>
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} />
    </mesh>
  );
}

// Fits the lens to the screen (tall phone or wide laptop) whenever it resizes.
function CameraRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  useEffect(() => {
    const { fov, distance } = fitCamera(aspect);
    camera.fov = fov;
    camera.position.copy(VIEW).multiplyScalar(distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [aspect, camera]);
  return null;
}
const VIEW = new THREE.Vector3(18, 20, 22).normalize();
const STROLLER = new THREE.CapsuleGeometry(0.18, 0.35, 2, 6); // shared: a new geometry per render would rebuild the mesh

function Board({ night, onTap }: { night: boolean; onTap: (p: Place) => void }) {
  const residents = useMemo(() => Array.from({ length: 40 }, (_, i) => ({ a: (i / 40) * Math.PI * 2, r: 5 + (i % 5) * 1.6, s: 0.05 + (i % 7) * 0.01, c: new THREE.Color().setHSL((i * 0.137) % 1, 0.6, 0.55) })), []);
  const dots = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  // Colours go on in the frame loop's first pass, so a rebuilt mesh never shows up white.
  const coloured = useRef<THREE.InstancedMesh | null>(null);
  // Residents strolling the streets: one draw call for all of them.
  useFrame(({ clock }) => {
    const m = dots.current;
    if (m && coloured.current !== m) {
      residents.forEach((r, i) => m.setColorAt(i, r.c));
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      coloured.current = m;
    }
    residents.forEach((r, i) => {
      const a = r.a + clock.elapsedTime * r.s;
      tmp.position.set(Math.cos(a) * r.r, 0.35, Math.sin(a) * r.r * 0.8);
      tmp.updateMatrix();
      dots.current!.setMatrixAt(i, tmp.matrix);
    });
    if (dots.current) dots.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[BOARD.width, BOARD.depth]} />
        <meshStandardMaterial color={night ? "#27304a" : "#bcd3a3"} />
      </mesh>
      {/* the Mempool Lagoon */}
      <mesh rotation-x={-Math.PI / 2} position={[-13, 0.01, -9]}>
        <circleGeometry args={[4.5, 24]} />
        <meshStandardMaterial color={night ? "#0f2a44" : "#7fb8e6"} />
      </mesh>
      {/* streets */}
      {[
        [0, 0.02, 3.6, 30, 1.2],
        [-4, 0.02, -0.5, 1.2, 20],
        [4, 0.02, -0.5, 1.2, 20],
      ].map(([x, y, z, w, d], i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[x!, y!, z!]}>
          <planeGeometry args={[w!, d!]} />
          <meshStandardMaterial color={night ? "#3a4566" : "#d9d4c7"} />
        </mesh>
      ))}
      {DISTRICTS.map((d) => (
        <GroundWords key={d.name} text={d.name} x={d.x} z={d.z} night={night} />
      ))}
      {LOTS.map((l, i) => (
        <ComingSoon key={i} {...l} night={night} />
      ))}
      {PLACES.map((p) => (
        <Building key={p.key} p={p} night={night} onTap={onTap} />
      ))}
      <TowerTop night={night} />
      <Html position={[0, 13.2, 0]} center distanceFactor={40} zIndexRange={[1, 0]}>
        <button className="pin" onClick={() => onTap({ ...PLACES[0]!, key: "roof", name: "The Roof", icon: "🌃", info: "Where the city watches the bell ring" })} aria-label="The Roof">
          <span className="ico">🌃</span>
        </button>
      </Html>
      {HOMES.map((h, i) => (
        <mesh key={i} position={[h.x, 0.8, h.z]}>
          <boxGeometry args={[1.8, 1.6, 1.8]} />
          <meshStandardMaterial color={night ? "#525e88" : ["#efc6a8", "#f4c0d1", "#c0dd97"][i % 3]} flatShading />
        </mesh>
      ))}
      <Html position={[-9.4, 2.6, 4.5]} center distanceFactor={40} zIndexRange={[1, 0]}>
        <button className="pin" onClick={() => onTap({ ...PLACES[0]!, key: "crew_row", name: "Crew Row", icon: "🏠", info: "Homes, and the crews' houses" })} aria-label="Crew Row">
          <span className="ico">🏠</span>
        </button>
      </Html>
      <instancedMesh ref={dots} args={[STROLLER, undefined, residents.length]}>
        <meshStandardMaterial />
      </instancedMesh>
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
  const [picked, setPicked] = useState<Place | null>(null);
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
          <span className="go">Move in to visit: open Block Party in Telegram.</span>
        </div>
      )}
      <div className="stage" style={{ background: night ? "#0b1020" : "#dfeaf5" }}>
        <Canvas dpr={[1, 2]} camera={{ position: [18, 20, 22], fov: 36, far: 200 }} gl={{ antialias: true, powerPreference: "high-performance" }}>
          <color attach="background" args={[night ? "#0b1020" : "#dfeaf5"]} />
          <hemisphereLight args={[night ? "#6b7cff" : "#ffffff", night ? "#0b1020" : "#a9c08d", night ? 1.7 : 1.1]} />
          <directionalLight position={[10, 18, 8]} intensity={night ? 1.0 : 1.4} />
          <Board
            night={night}
            onTap={(p) => {
              haptic("light");
              // Residents go there; guests can only look.
              if (me.resident && onPlace) onPlace(p.key, h?.law?.id === "gas_holiday");
              else setPicked(p);
            }}
          />
          <CameraRig />
          <MapControls
            makeDefault
            enableRotate={false}
            screenSpacePanning={false}
            minDistance={18}
            maxDistance={64}
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
