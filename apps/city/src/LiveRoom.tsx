"use client";
import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as THREE from "three";
import { ApiError, type Api, type CityHall, type Home, type Look, type MarketRow } from "./api";
import ChibiCrowd, { type ChibiPerson } from "./chibi/Crowd";
import Interior from "./Interior";
import { layoutFor, planFor } from "./interiors";
import { type Plan, type Seat, findPath, makePlan, nearestFree, toTile, toWorld as planWorld } from "./plan";
import { type Body, step } from "./steer";
import HomeDisplay from "./HomeDisplay";
import { HomeRoom } from "./HomeRoom";
import Person from "./Person";
import { footprintSize, homeSize, pieceOf } from "./furniture";
import { RoomCamera, RoomLighting } from "./RoomLighting";
import { useNow } from "./clock";
import { placeName, roomSize } from "./places";
import { type RoomState, applyEvent, bubbles, emptyRoom, showingEmote } from "./roomState";
import { type SocketStatus, openRoomSocket } from "./roomSocket";
import { chatDraft } from "./chatDraft";
import { haptic } from "./telegram";
import { useToast } from "./useToast";
import { type Board, type FeedKey, dinerBoard, hallBoard, matchBoard, oddsBoard } from "./roomfeeds";

// A live room: everyone here walking where they tapped, chat bubbles over
// heads, emotes, and the dimmed away residents. Every body part is one
// instanced draw call for the whole room.

import { EMOTE_ICON } from "./emoteIcons";
import RoomPanel, { type RoomAction } from "./RoomPanel";
import { roomSeatActions } from "./roomActions";
export { EMOTE_ICON } from "./emoteIcons";

const CAP = 64; // 60 here plus a few drawn away residents and NPCs
const WALK = 3; // tiles a second


// Looks, fetched once per handle for the whole visit.
const looks = new Map<string, Look | "loading" | "none">();

type Drawn = ChibiPerson & Body & { handle: string; tx: number; tz: number; goal: string; seat: Seat | null };

// Game movement: everyone is a solid body that steers along their path,
// dodges people ahead, eases in on arrival and slides along furniture (see
// steer.ts). On reaching a seat they sit, facing the way it faces, and become
// fixed: others walk round them. NPCs and away residents are fixed too.
function Walk({ drawn, plan }: { drawn: React.MutableRefObject<Drawn[]>; plan: Plan }) {
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const list = drawn.current;
    for (const p of list) {
      if (p.dim || p.id.startsWith("npc:")) p.fixed = true;
      else if (p.seat && !p.path.length && Math.hypot(p.x - p.tx, p.z - p.tz) < 0.2) {
        p.fixed = true;
        p.x = p.tx;
        p.z = p.tz;
      } else p.fixed = false;
    }
    step(list, dt, plan);
    for (const p of list) {
      const sp = Math.hypot(p.vx, p.vz);
      p.moving = sp > 0.15;
      if (p.moving) p.phase += dt * 3.5 * sp;
      p.sitY = p.fixed && p.seat ? (p.seat.h ?? 0.45) : null;
      if (p.sitY !== null && p.seat) p.yaw = p.seat.facing;
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

// The live boards for this room's screens: fetched on entry and every minute.
function useRoomFeeds(api: Api, place: string, now: number): Partial<Record<FeedKey, Board>> {
  const [odds, setOdds] = useState<MarketRow[] | null>(null);
  const [hall, setHall] = useState<CityHall | null>(null);
  useEffect(() => {
    const wantsOdds = place === "tower" || place === "watch_party";
    const load = () => {
      if (wantsOdds) void api.oddsWall().then(setOdds).catch(() => {});
      if (place === "city_hall") void api.cityHall().then(setHall).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [api, place]);
  const minute = Math.floor(now / 60_000);
  return useMemo(() => {
    const at = minute * 60_000;
    return {
      ...(odds ? { odds: oddsBoard(odds, at), match: matchBoard(odds, at) } : {}),
      ...(hall ? { hall: hallBoard(hall, at) } : {}),
      diner: dinerBoard(new Date(at).toISOString().slice(0, 10)),
    };
  }, [odds, hall, minute]);
}

export default function LiveRoom({ api, place, onLeave, me, crewId }: { api: Api; place: string; onLeave: () => void; me?: string; crewId?: string | null }) {
  // Draw permitted home layouts, including open homes visited by neighbours.
  const owner = place.startsWith("home:") ? place.slice(5) : null;
  const [display, setDisplay] = useState<"trophy_wall" | "tv" | null>(null);
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
    let live = true;
    setHome(null); setDisplay(null);
    if (owner) void (mine ? api.home() : api.visitHome(owner)).then((h) => { if (live) setHome(h); }).catch(() => { if (live) setNapMsg("Couldn’t load this home. Its door may be closed."); });
    if (ourHouse)
      void api
        .crewHouse()
        .then((h) => { if (live) setHome({ userId: "", tier: "lounge", wallFinish: h.wallFinish, floorFinish: h.floorFinish, doorOpen: true, placed: h.placed.filter((p) => p.room === "lounge"), storage: [] }); })
        .catch(() => {});
    return () => { live = false; };
  }, [api, mine, ourHouse, owner]);
  const size = roomSize(place) ?? { w: 10, h: 10 };
  const [room, dispatch] = useReducer((s: RoomState, a: { ev: unknown; now: number }) => applyEvent(s, a.ev, a.now), undefined, emptyRoom);
  const [status, setStatus] = useState<SocketStatus>({ kind: "connecting" });
  const [draft, updateDraft] = useReducer(chatDraft, { text: "", pending: null });
  const text = draft.text;
  const [clean, setClean] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const conn = useRef<ReturnType<typeof openRoomSocket> | null>(null);
  const drawn = useRef<Drawn[]>([]);
  const now = useNow(1000);

  const layout = useMemo(() => layoutFor(place), [place]);
  const feeds = useRoomFeeds(api, place, now);
  // What blocks walking here: the place's layout, or a home's floor furniture.
  const plan = useMemo<Plan>(() => {
    const p = planFor(place);
    if (p) return p;
    const blocks = (home?.placed ?? [])
      .filter((it) => it.placement.layer === "floor")
      .map((it) => {
        const pl = it.placement as { x: number; y: number; rot: number };
        const f = footprintSize(it.pieceId, pl.rot);
        return { x: pl.x, y: pl.y, w: f.w, d: f.d };
      });
    return makePlan(size.w, size.h, blocks);
  }, [place, home, size.w, size.h]);
  const toWorld = (t: { x: number; y: number }) => planWorld(plan, t);
  // Where someone is now, in tiles, for pathing from there.
  const here = (d: Drawn) => toTile(plan, d.x, d.z);

  useEffect(() => {
    const c = openRoomSocket({ ticket: () => api.roomTicket(place) }, { event: (ev) => {
      updateDraft({ type: "event", event: ev });
      dispatch({ ev, now: Date.now() });
    }, status: (s) => {
      setStatus(s);
      if (s.kind !== "live") updateDraft({ type: "disconnect" });
    } });
    conn.current = c;
    return () => c.close();
  }, [api, place]);

  useEffect(() => {
    if (!draft.pending) return;
    const timer = setTimeout(() => {
      updateDraft({ type: "disconnect" });
      setNapMsg("Delivery hasn't been confirmed. Your message is still here; check the chat before retrying.");
    }, 15_000);
    return () => clearTimeout(timer);
  }, [draft.pending, setNapMsg]);

  // Keep the drawn list in step with who's here; walking happens per frame.
  useEffect(() => {
    const prev = new Map(drawn.current.map((d) => [d.id, d]));
    const next: Drawn[] = [];
    for (const p of Object.values(room.people)) {
      const seat = p.seat ? (plan.seats.find((x) => x.id === p.seat) ?? null) : null;
      const target = seat ? { x: seat.x, y: seat.y } : p.pos;
      const goal = `${target.x},${target.y}`;
      const w = toWorld(target);
      const old = prev.get(p.userId);
      const look = looks.get(p.handle);
      const lk = typeof look === "object" ? look : (old?.look ?? null);
      const mood = p.userId === me ? myMood : (old?.mood ?? null);
      if (old) {
        // A new destination: a fresh path from wherever they are now.
        const path = old.goal === goal ? old.path : [...findPath(plan, here(old), target).map(toWorld), w];
        next.push({ ...old, tx: w.x, tz: w.z, goal, path, seat, handle: p.handle, mood, look: lk });
      } else {
        next.push({ id: p.userId, handle: p.handle, x: w.x, z: w.z, vx: 0, vz: 0, tx: w.x, tz: w.z, goal, path: [], seat, yaw: seat?.facing ?? 0, moving: false, phase: 0, dim: false, mood, look: lk });
      }
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
      next.push({ id: `away:${a.userId}`, handle: a.handle, x, z: -size.h / 2 + 1, tx: x, tz: -size.h / 2 + 1, goal: "", path: [], seat: null, vx: 0, vz: 0, yaw: 0, moving: false, phase: 0, dim: true, mood: "rested", look: null });
    });
    // The room's NPCs, as chibis with a steady look of their own.
    for (let i = 0; i < Math.min(room.headcount.npc, 4); i++) {
      const { x, z } = npcSpot(i, size.w, size.h);
      next.push({ id: `npc:${place}:${i}`, handle: "NPC", x, z, tx: x, tz: z, goal: "", path: [], seat: null, vx: 0, vz: 0, yaw: 0, moving: false, phase: 0, look: null });
    }
    drawn.current = next.slice(0, CAP);
  }, [room.people, room.away, room.headcount.npc, myMood, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (msg: unknown) => {
    if (!conn.current?.send(msg)) return false;
    return true;
  };
  const goTo = (wx: number, wz: number) => {
    const t = toTile(plan, wx, wz);
    const seat = plan.seats.find((s) => s.x === t.x && s.y === t.y);
    if (seat) {
      // Walk over, then sit: the room keeps the seat; everyone sees you take it.
      if (send({ t: "move", to: { x: seat.x, y: seat.y } }) && send({ t: "sit", seat: seat.id })) haptic("light");
      return;
    }
    const to = nearestFree(plan, t);
    if (to && send({ t: "move", to })) haptic("light");
  };
  const onFloor = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    goTo(e.point.x, e.point.z);
  };
  const say = () => {
    const t = text.trim();
    if (!t || draft.pending) return;
    const requestId = crypto.randomUUID();
    if (send({ t: "chat", text: t, requestId })) updateDraft({ type: "send", id: requestId });
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

  const actions:RoomAction[]=roomSeatActions(place,plan.seats,room.people).map(({label,seat})=>({id:label,label:seat?label:`${label} · full`,disabled:!seat,run:()=>{if(seat){const world=toWorld(seat);goTo(world.x,world.z);}}}));
  for(const kind of ["trophy_wall","tv"] as const) if(home?.placed.some(p=>p.pieceId===kind)) actions.push({id:kind,label:kind==='tv'?'Watch TV':'Trophy wall',run:()=>setDisplay(kind)});
  if(mine&&home){const bed=home.placed.find(p=>pieceOf(p.pieceId)?.mood==='rested');if(bed)actions.push({id:'nap',label:'Take a nap',run:()=>{void api.nap(bed.itemId).then(a=>{setNapMsg(`Napping until ${new Date(a.endsAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}. You’ll wake up Rested.`);}).catch(e=>setNapMsg(e instanceof ApiError?e.message:'Couldn’t nap. Try again.'));}});}
  const span = Math.max(size.w, size.h);
  return (
    <>
      <div className={`stage room-stage social-live-stage ${clean ? "is-clean" : ""}`}>
        <Canvas shadows dpr={[1, 1.5]} camera={{ position: [span * 0.55, span * 0.8, span * 0.95], fov: 40 }} gl={{ antialias: true }}>
          <RoomLighting span={span} outdoor={place === "roof"} />
          {home ? (
            <HomeRoom
              w={homeSize(home.tier).w}
              d={homeSize(home.tier).d}
              wallFinish={home.wallFinish}
              floorFinish={home.floorFinish}
              placed={home.placed}
              onPiece={(id) => { const p = home.placed.find((item) => item.itemId === id); if (p?.pieceId === "trophy_wall" || p?.pieceId === "tv") setDisplay(p.pieceId); }}
              onCell={(x, y) => goTo(x - size.w / 2 + 0.5, y - size.h / 2 + 0.5)}
            />
          ) : layout ? (
            <Interior layout={layout} w={size.w} h={size.h} low={place === "roof"} onFloor={goTo} feeds={feeds} />
          ) : (
            <>
              <mesh receiveShadow rotation-x={-Math.PI / 2} onPointerDown={onFloor}>
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
          <RoomCamera w={size.w} h={size.h} />
          {!clean && <Npcs n={room.headcount.npc} w={size.w} h={size.h} scale={span * 1.5} />}
          <Walk drawn={drawn} plan={plan} />
          <ChibiCrowd people={drawn} cap={CAP} onPerson={(id) => id !== room.you && !id.startsWith("npc:") && setPerson(id)} />
          {!clean && <Tags drawn={drawn} room={room} now={now} me={room.you} scale={span * 1.5} />}
          <OrbitControls enablePan={false} minPolarAngle={0.5} maxPolarAngle={1.15} minDistance={span * 0.6} maxDistance={span * 8} />
        </Canvas>
      </div>

      <RoomPanel name={placeName(place)} room={room} status={status} text={text} pending={!!draft.pending} clean={clean}
        onClean={()=>setClean(v=>!v)} onLeave={onLeave} onText={text=>updateDraft({type:'edit',text})} onSend={say}
        onEmote={emote=>{if(send({t:'emote',emote}))haptic('light');}} onPerson={id=>{if(id!==room.you)setPerson(id);}} actions={actions}/>
      {err && <div className="toast bad" role="alert">{err.message}</div>}
      {napMsg && <div className="toast" role="status">{napMsg}</div>}
      {person && <Person api={api} userId={person} place={place} onClose={() => setPerson(null)} />}
      {display && <HomeDisplay api={api} owner={owner ?? me ?? ""} kind={display} onClose={() => setDisplay(null)} />}
    </>
  );
}
