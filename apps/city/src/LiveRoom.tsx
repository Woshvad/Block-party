"use client";
import { EMOTES } from "@bp/core";
import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as THREE from "three";
import { ApiError, type Api, type Home, type Look } from "./api";
import ChibiCrowd, { type ChibiPerson } from "./chibi/Crowd";
import { HomeRoom } from "./HomeRoom";
import Person from "./Person";
import { homeSize, pieceOf } from "./furniture";
import { fitCamera } from "./camera";
import { useNow } from "./clock";
import { placeName, roomSize } from "./places";
import { type RoomState, applyEvent, bubbles, emptyRoom, showingEmote } from "./roomState";
import { type SocketStatus, openRoomSocket } from "./roomSocket";
import { haptic } from "./telegram";
import { useToast } from "./useToast";

// A live room: everyone here walking where they tapped, chat bubbles over
// heads, emotes, and the dimmed away residents. Every body part is one
// instanced draw call for the whole room.

export const EMOTE_ICON: Record<string, string> = {
  wave: "👋", gm: "☀️", lfg: "🚀", rekt: "💀", victory_lap: "🏁", crew_couch: "🛋️", hodl: "💎", actually: "☝️", ring_it: "🔔",
  touched_grass: "🌱", objection: "✋", shipped: "📦", watching: "👀", aping: "🦍", first: "🥇", gm_3am: "🌙", bull_trap: "🪤", fresh_eyes: "👁️",
};

const CAP = 64; // 60 here plus a few drawn away residents and NPCs
const WALK = 3; // tiles a second


// Looks, fetched once per handle for the whole visit.
const looks = new Map<string, Look | "loading" | "none">();

type Drawn = ChibiPerson & { handle: string; tx: number; tz: number };

// Walks everyone toward where they tapped; the chibi crowd draws them.
function Walk({ drawn }: { drawn: React.MutableRefObject<Drawn[]> }) {
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    for (const p of drawn.current) {
      const dx = p.tx - p.x;
      const dz = p.tz - p.z;
      const dist = Math.hypot(dx, dz);
      p.moving = dist > 0.02;
      if (!p.moving) continue;
      const step = Math.min(dist, WALK * dt);
      p.x += (dx / dist) * step;
      p.z += (dz / dist) * step;
      p.phase += dt * 9;
      p.yaw = Math.atan2(dx, dz);
    }
  });
  return null;
}

// Bubbles, emotes and your own name, following each person as they walk.
function Tags({ drawn, room, now, me, scale }: { drawn: React.MutableRefObject<Drawn[]>; room: RoomState; now: number; me: string | null; scale: number }) {
  const b = bubbles(room, now);
  // Only real room members get tags: NPC and away chibis aren't in room.people.
  const shown = drawn.current.filter((d) => {
    const p = room.people[d.id];
    return !!p && !d.dim && (!!b[d.id] || d.id === me || !!showingEmote(p, now));
  });
  return (
    <>
      {shown.map((d) => (
        <Follow key={d.id} d={d} scale={scale}>
          <div className="tag3d">
            {showingEmote(room.people[d.id]!, now) && <span className="emo">{EMOTE_ICON[showingEmote(room.people[d.id]!, now)!] ?? "✨"}</span>}
            {b[d.id] ? <span className="bubble">{b[d.id]!.text}</span> : <span className="who">{d.id === me ? "you" : `@${d.handle}`}</span>}
          </div>
        </Follow>
      ))}
    </>
  );
}

// Fits the whole room on screen, tall phone or wide laptop.
function RoomCamera({ span }: { span: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  useEffect(() => {
    const { fov, distance } = fitCamera(aspect, span * 1.02, { min: span * 0.8, max: span * 3 });
    camera.fov = fov;
    camera.position.copy(ROOM_VIEW).multiplyScalar(distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [aspect, span, camera]);
  return null;
}
const ROOM_VIEW = new THREE.Vector3(0.55, 0.8, 0.95).normalize();

// The room's NPCs (the server only counts them): standing at fixed spots by the back wall.
// Where a room's NPCs stand: by the back wall, facing the room.
const npcSpot = (i: number, w: number, h: number) => ({ x: w / 2 - 1.5 - i * 1.6, z: -h / 2 + 1.2 });

function Npcs({ n, w, h, scale }: { n: number; w: number; h: number; scale: number }) {
  return (
    <>
      {Array.from({ length: Math.min(n, 4) }, (_, i) => {
        const { x, z } = npcSpot(i, w, h);
        return (
          <group key={i} position={[x, 0, z]}>
            {/* The NPC itself is a chibi in the crowd (see npcSpot); this is its tag. */}
            <Html position={[0, 1.6, 0]} center distanceFactor={scale} zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
              <span className="npc">NPC</span>
            </Html>
          </group>
        );
      })}
    </>
  );
}

function Follow({ d, children, scale }: { d: Drawn; children: React.ReactNode; scale: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => g.current?.position.set(d.x, 1.75, d.z));
  return (
    <group ref={g}>
      <Html center distanceFactor={scale} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        {children}
      </Html>
    </group>
  );
}

export default function LiveRoom({ api, place, onLeave, me, crewId }: { api: Api; place: string; onLeave: () => void; me?: string; crewId?: string | null }) {
  // Your own home or your crew's house: draw the furniture (the API shares a
  // layout only with its owner, or the crew's members).
  const mine = !!me && place === `home:${me}`;
  const ourHouse = !!crewId && place === `crew_house:${crewId}`;
  const [home, setHome] = useState<Home | null>(null);
  const [napMsg, setNapMsg] = useToast<string>();
  // Your mood shows on your own face (REKT, tilted, cozy...).
  const [myMood, setMyMood] = useState<string | null>(null);
  useEffect(() => {
    void api
      .moods()
      .then((m) => setMyMood(m.active[0]?.mood ?? null))
      .catch(() => {});
  }, [api]);
  useEffect(() => {
    if (mine) void api.home().then(setHome).catch(() => {});
    if (ourHouse)
      void api
        .crewHouse()
        .then((h) => setHome({ userId: "", tier: "lounge", wallFinish: h.wallFinish, floorFinish: h.floorFinish, doorOpen: true, placed: h.placed.filter((p) => p.room === "lounge"), storage: [] }))
        .catch(() => {});
  }, [api, mine, ourHouse]);
  const size = roomSize(place) ?? { w: 10, h: 10 };
  const [room, dispatch] = useReducer((s: RoomState, a: { ev: unknown; now: number }) => applyEvent(s, a.ev, a.now), undefined, emptyRoom);
  const [status, setStatus] = useState<SocketStatus>({ kind: "connecting" });
  const [text, setText] = useState("");
  const [emotes, setEmotes] = useState(false);
  const [log, setLog] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const conn = useRef<ReturnType<typeof openRoomSocket> | null>(null);
  const drawn = useRef<Drawn[]>([]);
  const now = useNow(1000);

  const toWorld = (p: { x: number; y: number }) => ({ x: p.x - size.w / 2 + 0.5, z: p.y - size.h / 2 + 0.5 });

  useEffect(() => {
    const c = openRoomSocket({ ticket: () => api.roomTicket(place) }, { event: (ev) => dispatch({ ev, now: Date.now() }), status: setStatus });
    conn.current = c;
    return () => c.close();
  }, [api, place]);

  // Keep the drawn list in step with who's here; walking happens per frame.
  useEffect(() => {
    const prev = new Map(drawn.current.map((d) => [d.id, d]));
    const next: Drawn[] = [];
    for (const p of Object.values(room.people)) {
      const w = toWorld(p.pos);
      const old = prev.get(p.userId);
      const look = looks.get(p.handle);
      next.push(old ? { ...old, tx: w.x, tz: w.z, handle: p.handle, mood: p.userId === me ? myMood : old.mood, look: typeof look === "object" ? look : old.look } : { id: p.userId, handle: p.handle, x: w.x, z: w.z, tx: w.x, tz: w.z, yaw: 0, moving: false, phase: 0, dim: false, mood: p.userId === me ? myMood : null, look: typeof look === "object" ? look : null });
      if (!looks.has(p.handle)) {
        looks.set(p.handle, "loading");
        api
          .resident(p.handle)
          .then((r) => {
            looks.set(p.handle, r.look);
            const d = drawn.current.find((x) => x.handle === p.handle);
            if (d) d.look = r.look;
            bump();
          })
          .catch(() => looks.set(p.handle, "none"));
      }
    }
    // Away residents (dimmed) along the back, never walking.
    room.away.slice(0, 10).forEach((a, i) => {
      const x = -size.w / 2 + 1 + ((i * 1.7) % (size.w - 2));
      next.push({ id: `away:${a.userId}`, handle: a.handle, x, z: -size.h / 2 + 1, tx: x, tz: -size.h / 2 + 1, yaw: 0, moving: false, phase: 0, dim: true, mood: "rested", look: null });
    });
    // The room's NPCs, as chibis with a steady look of their own.
    for (let i = 0; i < Math.min(room.headcount.npc, 4); i++) {
      const { x, z } = npcSpot(i, size.w, size.h);
      next.push({ id: `npc:${place}:${i}`, handle: "NPC", x, z, tx: x, tz: z, yaw: 0, moving: false, phase: 0, look: null });
    }
    drawn.current = next.slice(0, CAP);
  }, [room.people, room.away, room.headcount.npc, myMood]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (msg: unknown) => {
    if (!conn.current?.send(msg)) return false;
    return true;
  };
  const onFloor = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const x = Math.floor(e.point.x + size.w / 2);
    const y = Math.floor(e.point.z + size.h / 2);
    if (send({ t: "move", to: { x, y } })) haptic("light");
  };
  const say = () => {
    const t = text.trim();
    if (!t) return;
    if (send({ t: "chat", text: t })) setText("");
  };

  const err = room.lastError && now - room.lastError.at < 4000 ? room.lastError : null;
  const tiles = useMemo(() => {
    const data = new Uint8Array([233, 226, 212, 255, 222, 214, 198, 255, 222, 214, 198, 255, 233, 226, 212, 255]);
    const t = new THREE.DataTexture(data, 2, 2);
    t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(size.w / 2, size.h / 2);
    t.needsUpdate = true;
    return t;
  }, [size.w, size.h]);
  useEffect(() => () => tiles.dispose(), [tiles]);

  const span = Math.max(size.w, size.h);
  return (
    <>
      <div className="stage">
        <Canvas dpr={[1, 2]} camera={{ position: [span * 0.55, span * 0.8, span * 0.95], fov: 40 }} gl={{ antialias: true }}>
          <color attach="background" args={["#dfeaf5"]} />
          <hemisphereLight args={["#ffffff", "#b9c7d6", 1.1]} />
          <directionalLight position={[6, 12, 6]} intensity={1.3} />
          {home ? (
            <HomeRoom
              w={homeSize(home.tier).w}
              d={homeSize(home.tier).d}
              wallFinish={home.wallFinish}
              floorFinish={home.floorFinish}
              placed={home.placed}
              onCell={(x, y) => send({ t: "move", to: { x, y } }) && haptic("light")}
            />
          ) : (
            <>
              <mesh rotation-x={-Math.PI / 2} onPointerDown={onFloor}>
                <planeGeometry args={[size.w, size.h]} />
                <meshStandardMaterial map={tiles} />
              </mesh>
              <mesh position={[0, 1.2, -size.h / 2 - 0.1]}>
                <boxGeometry args={[size.w + 0.4, 2.4, 0.2]} />
                <meshStandardMaterial color="#e8b99a" />
              </mesh>
              <mesh position={[-size.w / 2 - 0.1, 1.2, 0]}>
                <boxGeometry args={[0.2, 2.4, size.h]} />
                <meshStandardMaterial color="#efc6a8" />
              </mesh>
            </>
          )}
          <RoomCamera span={span} />
          <Npcs n={room.headcount.npc} w={size.w} h={size.h} scale={span * 1.5} />
          <Walk drawn={drawn} />
          <ChibiCrowd people={drawn} cap={CAP} onPerson={(id) => id !== room.you && !id.startsWith("npc:") && setPerson(id)} />
          <Tags drawn={drawn} room={room} now={now} me={room.you} scale={span * 1.5} />
          <OrbitControls enablePan={false} minPolarAngle={0.5} maxPolarAngle={1.15} minDistance={span * 0.6} maxDistance={span * 3} />
        </Canvas>
      </div>

      <div className="roomtop">
        <button className="pill" onClick={onLeave} aria-label="leave the room">
          ‹ City
        </button>
        <div className="pill">
          <b>{placeName(place)}</b> · {room.headcount.here} here{room.headcount.npc ? ` · ${room.headcount.npc} NPC` : ""}
          {room.headcount.away ? ` · ${room.headcount.away} away` : ""}
        </div>
      </div>
      {status.kind !== "live" && (
        <div className={`roomstatus ${status.kind}`}>
          {status.kind === "connecting" && "Walking in…"}
          {status.kind === "reconnecting" && `Reconnecting… (try ${status.attempt})`}
          {status.kind === "stopped" && (
            <>
              {status.reason}{" "}
              <button className="link" onClick={onLeave}>
                Back to the city
              </button>
            </>
          )}
        </div>
      )}
      {err && <div className="toast bad">{err.message}</div>}
      {person && <Person api={api} userId={person} place={place} onClose={() => setPerson(null)} />}
      {napMsg && <div className="toast">{napMsg}</div>}
      {mine && home && status.kind === "live" && home.placed.some((p) => pieceOf(p.pieceId)?.mood === "rested") && (
        <button
          className="pill napbtn"
          onClick={async () => {
            const bed = home.placed.find((p) => pieceOf(p.pieceId)?.mood === "rested")!;
            try {
              const a = await api.nap(bed.itemId);
              setNapMsg(`😴 Napping until ${new Date(a.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. You'll wake up Rested.`);
              haptic("success");
            } catch (e) {
              setNapMsg(e instanceof ApiError ? e.message : "couldn't nap");
            }
          }}
        >
          😴 Nap
        </button>
      )}

      {log && (
        <div className="chatlog" onClick={() => setLog(false)}>
          {room.lines.slice(-12).map((l) => (
            <p key={l.id}>
              <b>@{l.handle}</b> {l.text}
            </p>
          ))}
          {room.lines.length === 0 && <p className="muted">Nobody's said anything yet.</p>}
        </div>
      )}
      {emotes && (
        <div className="emotes">
          {EMOTES.map((e) => (
            <button
              key={e}
              title={e.replace(/_/g, " ")}
              onClick={() => {
                if (send({ t: "emote", emote: e })) haptic("light");
                setEmotes(false);
              }}
            >
              {EMOTE_ICON[e] ?? "✨"}
            </button>
          ))}
        </div>
      )}
      <form
        className="chatbar"
        onSubmit={(e) => {
          e.preventDefault();
          say();
        }}
      >
        <button type="button" className="round" aria-label="chat log" onClick={() => setLog((v) => !v)}>
          💬
        </button>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={status.kind === "live" ? "Say something…" : "…"} maxLength={280} disabled={status.kind !== "live"} enterKeyHint="send" />
        <button type="button" className="round" aria-label="emotes" onClick={() => setEmotes((v) => !v)} disabled={status.kind !== "live"}>
          😀
        </button>
        <button type="submit" className="round send" disabled={status.kind !== "live" || !text.trim()} aria-label="send">
          ↑
        </button>
      </form>
    </>
  );
}
