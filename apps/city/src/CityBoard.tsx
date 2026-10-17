"use client";
import { Html, MapControls, useProgress } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import { ISO, ZOOM, clampTarget, shortCount, startZoom, zoomLevel } from "./camera";
import { DISTRICT_NAMES, GRID, LANDMARKS, type PlaceKey, SOON, SQUARE, blockRect, zoneOf } from "./citygen";
import CityScape from "./CityScape";
import { clearFailedModels } from "./Kit";
import SceneBoundary from "./SceneBoundary";
import CityAtmosphere from "./CityAtmosphere";
import { PLACE_INFO } from "./places";
import type { Api, Me } from "./api";
import { useBackLayer } from "./back";
import ChibiCrowd, { type ChibiPerson } from "./chibi/Crowd";
import { boardShown } from "./boardMode";
import { until, useNow } from "./clock";
import { useLoad } from "./useLoad";
import { cityTotal, cityTotalLabel } from "./neighbours";
import { PerfProbe, SHOW_PERF } from "./PerfHud";
import { cityView, deviceTier, subscribePick, watchContext } from "./quality";
import { haptic, initTelegram } from "./telegram";

// The city board, SimCity style: an isometric view over a street grid of
// zoned blocks, traffic and people on the sidewalks, our landmarks with a
// pin over each. Bright by day; windows and street lights glow at night.

type Place = { key: PlaceKey; name: string; icon: string; info: string };
type Picked = { name: string; icon: string; info: string; soon?: boolean };
const PLACES: Place[] = (Object.keys(LANDMARKS) as PlaceKey[]).map((key) => ({ key, name: PLACE_INFO[key]!.name, icon: PLACE_INFO[key]!.icon, info: PLACE_INFO[key]!.info }));

// Pins float over each landmark at a fixed size on screen. The headcount is
// its own badge, so it shows at every zoom, even when the name is hidden.
function Pins({ onTap, counts }: { counts: Record<string, number | null>; onTap: (p: Place) => void }) {
  return (
    <>
      {PLACES.map((p) => {
        const l = LANDMARKS[p.key];
        const n = counts[p.key];
        return (
          <Html key={p.key} position={[l.x, l.pinY, l.z]} center zIndexRange={[1, 0]}>
            {/* A missing or failed count shows no badge; it's never shown as zero. */}
            <button className="pin" onClick={() => onTap(p)} aria-label={n != null ? `${p.name}, ${n} here` : p.name}>
              <span className="ico">{p.icon}</span>
              <span className="name">{p.name}</span>
              {n != null && (
                <span className={`here ${n > 0 ? "" : "none"}`} aria-hidden="true">
                  {shortCount(n)}
                </span>
              )}
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

// Every place as a list: "Explore places" over the map, and the whole board
// in the list view (Me → Graphics → List), where the launch places join it.
// Same headcounts as the pins (none shown when unknown), same taps.
function PlaceList({ counts, board, onPlace, onSoon }: { counts: Record<string, number | null>; board: boolean; onPlace: (p: Place) => void; onSoon: (p: Picked) => void }) {
  return (
    <section className={`map-directory ${board ? "list-board" : ""}`} aria-label="Places in the city">
      <h2>Where to?</h2>
      {PLACES.map((p) => (
        <button key={p.key} onClick={() => onPlace(p)}>
          {p.icon}
          <span>
            <b>{p.name}</b>
            <small>
              {p.info}
              {counts[p.key] != null ? ` · ${counts[p.key]} here` : ""}
            </small>
          </span>
          <span aria-hidden="true">↗</span>
        </button>
      ))}
      {board &&
        Object.values(SOON).map((p) => (
          <button key={p.name} className="soon" onClick={() => onSoon({ name: p.name, icon: p.icon, info: "Opens at launch.", soon: true })} aria-label={`${p.name}, opens at launch`}>
            {p.icon}
            <span>
              <b>{p.name}</b>
              <small>Opens at launch</small>
            </span>
            <span aria-hidden="true">🔒</span>
          </button>
        ))}
    </section>
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
    const level = zoomLevel(camera.zoom);
    if (level === last.current) return;
    last.current = level;
    document.documentElement.setAttribute("data-zoom", level);
  });
  return null;
}

// The bell rings at 00:00 UTC; used until the Slate (which carries it) loads.
const nextBell = (now: number) => new Date(Math.floor(now / 86_400_000 + 1) * 86_400_000).toISOString();

// A gentle architectural glow; market direction comes only from real odds data.
function TowerTop({ night }: { night: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current?.material as THREE.MeshBasicMaterial | undefined;
    if (m) m.color.setHSL(0.42, 0.45, (night ? 0.55 : 0.47) + Math.sin(clock.elapsedTime * 0.4) * 0.03);
  });
  return (
    <mesh ref={ref} position={[LANDMARKS.tower.x, 17.05, LANDMARKS.tower.z]}>
      <boxGeometry args={[2.6, 0.32, 2.6]} />
      <meshBasicMaterial toneMapped={false} />
    </mesh>
  );
}

// The isometric camera: fixed angle (no orbiting, like SimCity); opens at
// startZoom (camera.ts), about 30 tiles across a phone held upright, 65 across
// a laptop.
const ISO_DIR = new THREE.Vector3(ISO.x, ISO.y, ISO.z).normalize();
type MapCommand = { action: "in" | "out" | "reset" | "diner"; n: number };
function IsoRig({ command }: { command: MapCommand }) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  useEffect(() => {
    camera.zoom = command.action === "diner" ? size.width / (size.width < size.height ? 16 : 24) : startZoom(size.width, size.height);
    const target = controls?.target ?? new THREE.Vector3();
    camera.position.copy(ISO_DIR).multiplyScalar(90).add(target);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);
  useEffect(() => {
    if (!command.n) return;
    if (command.action === "diner") {
      const target = new THREE.Vector3(LANDMARKS.diner.x + 2, 0, LANDMARKS.diner.z + 2);
      controls?.target.copy(target);
      camera.position.copy(ISO_DIR).multiplyScalar(90).add(target);
      camera.zoom = Math.min(ZOOM.max, size.width / (size.width < size.height ? 16 : 24));
      camera.lookAt(target);
    } else if (command.action === "reset") {
      controls?.target.set(0, 0, 0);
      camera.position.copy(ISO_DIR).multiplyScalar(90);
      camera.zoom = startZoom(size.width, size.height);
    } else camera.zoom = Math.max(ZOOM.min, Math.min(ZOOM.max, camera.zoom * (command.action === "in" ? 1.3 : 1 / 1.3)));
    camera.updateProjectionMatrix();
    controls?.update();
  }, [command]);
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

// `active` false keeps the board mounted but hidden and not drawing, under
// another screen (App.tsx), so coming back to it doesn't rebuild the city.
export default function CityBoard({ api, me, onOpenToday, onPlace, onOpenHall, onOpenMe, showcase = false, active = true }: { showcase?: boolean; active?: boolean; api: Pick<Api, "cityHall" | "slate"> & Partial<Pick<Api, "headcounts">>; me: Me; onOpenToday?: () => void; onPlace?: (place: string, ridesFree: boolean) => void; onOpenHall?: () => void; onOpenMe?: () => void }) {
  const tier = deviceTier();
  // The list view mounts no Canvas at all, so the board makes no WebGL context.
  const list = useSyncExternalStore(subscribePick, cityView, () => "map" as const) === "list";
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const total = cityTotalLabel(cityTotal(counts));
  // Headcounts are polled only while the board shows.
  useEffect(() => {
    if (!api.headcounts || !active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const r = await api.headcounts!(); if (live) setCounts(r.counts); }
      catch { if (live) setCounts({}); }
      if (live) timer = setTimeout(poll, 15000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [api, active]);
  // City Hall and the Slate, fetched once the board is first shown and again
  // on each return to it (boardShown). Mounted hidden, they wait.
  const seen = useRef({ shown: active, everShown: active });
  const hall = useLoad(() => (seen.current.everShown ? api.cityHall() : Promise.resolve(undefined)), [api]);
  const slate = useLoad(() => (seen.current.everShown ? api.slate() : Promise.resolve(undefined)), [api]);
  useEffect(() => {
    const step = boardShown(seen.current, active);
    seen.current = { shown: active, everShown: step.everShown };
    if (step.fetch) {
      void hall.reload();
      void slate.reload();
    }
  }, [active]);
  const now = useNow(1000, active);
  const h = hall.data;
  const s = slate.data;
  const bellAt = s?.bellAt ?? nextBell(now);
  const hour = new Date().getHours();
  const [night, setNight] = useState(hour >= 19 || hour < 6);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [guide, setGuide] = useState(false);
  const [command, setCommand] = useState<MapCommand>({ action: "reset", n: 0 });
  const mapAction = (action: MapCommand["action"]) => setCommand((c) => ({ action, n: c.n + 1 }));
  useEffect(() => { if (showcase) mapAction("diner"); else mapAction("reset"); }, [showcase]);
  const perf = useRef<HTMLDivElement>(null);
  // Hidden under another screen: close the place list and the place card,
  // as leaving the board always has.
  useEffect(() => {
    if (!active) {
      setGuide(false);
      setPicked(null);
    }
  }, [active]);
  useBackLayer(guide, () => setGuide(false));
  useBackLayer(picked !== null, () => setPicked(null));
  // Models still downloading: the roads come first, then the buildings.
  const loading = useProgress((p) => p.active);
  useEffect(() => {
    initTelegram();
  }, []);
  // Residents go there; guests can only look.
  const visit = (p: Place) => {
    haptic("light");
    setGuide(false);
    if (me.resident && onPlace) onPlace(p.key, h?.law?.id === "gas_holiday");
    else setPicked(p);
  };
  const look = (p: Picked) => {
    haptic("light");
    setPicked(p);
  };
  return (
    <div className={`city-board ${list ? "as-list" : ""}`} hidden={!active}>
      {/* The live banner: City Hall's Mayor and this week's Law, from the API. */}
      <button className="banner" onClick={onOpenHall} disabled={!onOpenHall} aria-label="Open City Hall">
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
      </button>
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
        {/* Only from real headcounts: unknown shows nothing, never 0 (neighbours.ts). */}
        {total && (
          <div className="pill neighbours-now">
            <span className="live" aria-hidden="true" />
            {total}
          </div>
        )}
        {!list && (
          <button className="pill" onClick={() => setNight((n) => !n)}>
            {night ? "Show day" : "Show night"}
          </button>
        )}
        {!list && loading && (
          <div className="pill muted" role="status">
            Loading the city…
          </div>
        )}
        {SHOW_PERF && !list && (
          <div className="perf" ref={perf}>
            measuring…
          </div>
        )}
      </div>
      {list ? (
        <PlaceList board counts={counts} onPlace={visit} onSoon={look} />
      ) : (
        <>
          <nav className="map-tools" aria-label="Map controls">
            <button className="map-guide" aria-expanded={guide} onClick={() => setGuide((v) => !v)}>Explore places {guide ? "−" : "+"}</button>
            <button aria-label="Zoom out" onClick={() => mapAction("out")}>−</button>
            <button aria-label="Zoom in" onClick={() => mapAction("in")}>+</button>
            <button aria-label="Recenter city" onClick={() => mapAction("reset")}>⌖</button>
          </nav>
          {guide && <PlaceList board={false} counts={counts} onPlace={visit} onSoon={look} />}
        </>
      )}
      {picked && (
        <div className="sheet" onClick={() => setPicked(null)}>
          <strong>
            {picked.icon} {picked.name}
          </strong>
          <span className="muted">{picked.info}</span>
          <span className="go">{picked.soon ? "Being built now: the doors open at launch." : "Move in to visit: open Block Party in Telegram."}</span>
        </div>
      )}
      {!list && (
        <div className="stage" style={{ background: night ? "linear-gradient(#05070f, #1a2240 60%, #2a2f55)" : "linear-gradient(#8ec5f0, #cfe6f7 55%, #f4efe4)" }}>
          <SceneBoundary what="the city map" note="Explore places still works." onRetry={clearFailedModels}>
            {/* Hidden, it draws nothing ("never") but keeps everything it built. */}
            <Canvas shadows={tier.shadows} orthographic dpr={tier.dpr} frameloop={active ? "always" : "never"} camera={{ position: [60, 52, 60], zoom: 20, near: 0.1, far: 400 }} gl={{ antialias: tier.antialias, powerPreference: "high-performance" }} onCreated={watchContext}>
              <CityAtmosphere night={night} />
              <hemisphereLight args={[night ? "#8fa3da" : "#eaf4ff", night ? "#182422" : "#bba789", night ? 0.65 : 0.8]} />
              {/* The sun, casting real shadows over the whole city. */}
              <directionalLight
                position={[-28, 42, 24]}
                color={night ? "#b1c7f7" : "#fff1d9"}
                intensity={night ? 0.7 : 2.5}
                castShadow={tier.shadows}
                shadow-mapSize={[2048, 2048]}
                shadow-camera-left={-62}
                shadow-camera-right={62}
                shadow-camera-top={62}
                shadow-camera-bottom={-62}
                shadow-camera-far={120}
                shadow-bias={-0.0004}
                shadow-normalBias={0.03}
              />
              <CityScape night={night} lamps={tier.nightLamps} />
              <TowerTop night={night} />
              {tier.strollers && <Strollers />}
              <Pins counts={counts} onTap={visit} />
              <SoonPins onTap={look} />
              <DistrictLabels />
              <ZoomLevel />
              <IsoRig command={command} />
              <MapControls
                makeDefault
                enableRotate={false}
                screenSpacePanning={false}
                minZoom={ZOOM.min}
                maxZoom={ZOOM.max}
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
              {SHOW_PERF && <PerfProbe target={perf} quality={tier.quality} />}
            </Canvas>
          </SceneBoundary>
        </div>
      )}
    </div>
  );
}
