"use client";
import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useRef, useState } from "react";
import { ApiError, type Api, type Home, type Placement, newKey } from "./api";
import { countdown, useNow } from "./clock";
import { RoomCamera, RoomLighting } from "./RoomLighting";
import { HomeRoom } from "./HomeRoom";
import { FLOOR_COLORS, WALL_COLORS, checkPlacement, firstFreeSpot, homeSize, nextRot, pieceOf } from "./furniture";
import { itemLabel, label } from "./palette";
import { haptic } from "./telegram";
import { useLoad } from "./useLoad";
import { useToast } from "./useToast";

// Your home: tap a piece to move, turn, recolour or store it; place things
// from storage; buy from the shop; pick your walls and floor; open your door.
// Every spot is checked with the API's own placement rule before it's sent.

type Mode = { kind: "view" } | { kind: "selected"; itemId: string } | { kind: "placing"; itemId: string; pieceId: string; placement: Placement; isNew: boolean };
type Sheet = null | "storage" | "shop" | "finishes";
const BANDS = ["basic", "everyday", "statement", "working"] as const;

export default function HomeEditor({ api, gm, onGm, onGoInside }: { api: Api; gm: number; onGm: () => void; onGoInside: () => void }) {
  const home = useLoad(() => api.home(), [api]);
  const action = useLoad(() => api.action(), [api]);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [sheet, setSheet] = useState<Sheet>(null);
  const [msg, setMsg] = useToast<{ text: string; bad: boolean }>();
  const busy = useRef(false);
  const buyKeys = useRef(new Map<string, string>());
  const catalogue = useLoad(() => (sheet === "shop" ? api.catalogue() : Promise.resolve(null)), [api, sheet]);
  const now = useNow(1000);

  const h = home.data;
  const size = h ? homeSize(h.tier) : { w: 8, d: 8 };

  // One change at a time; the home reloads after each so the screen is the truth.
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    if (busy.current) return false;
    busy.current = true;
    setMsg(null);
    try {
      await fn();
      await home.reload();
      if (ok) setMsg({ text: ok, bad: false });
      haptic("light");
      return true;
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : "that didn't work", bad: true });
      haptic("error");
      return false;
    } finally {
      busy.current = false;
    }
  };

  if (!h) return <div className="screen center muted">{home.error ?? "Unlocking your door…"}</div>;

  const selected = mode.kind === "selected" ? h.placed.find((p) => p.itemId === mode.itemId) : null;
  const ghostErr = mode.kind === "placing" ? checkPlacement(h.tier, mode.pieceId, mode.placement, h.placed, mode.itemId) : null;

  const startPlacing = (itemId: string, pieceId: string, isNew: boolean, from?: Placement) => {
    const spot = from ?? firstFreeSpot(h.tier, pieceId, h.placed);
    if (!spot) return setMsg({ text: "No room for that one. Store something first.", bad: true });
    setSheet(null);
    setMode({ kind: "placing", itemId, pieceId, placement: spot, isNew });
  };

  const onCell = (x: number, y: number) => {
    if (mode.kind === "placing" && mode.placement.layer !== "wall") setMode({ ...mode, placement: { ...mode.placement, x, y } });
    else setMode({ kind: "view" });
  };
  const onWall = (wall: "n" | "e" | "s" | "w", offset: number) => {
    if (mode.kind === "placing" && mode.placement.layer === "wall") {
      const len = pieceOf(mode.pieceId)?.w ?? 1;
      const max = (wall === "n" || wall === "s" ? size.w : size.d) - len;
      setMode({ ...mode, placement: { ...mode.placement, wall, offset: Math.max(0, Math.min(max, offset)) } });
    }
  };

  const nap = h.placed.find((p) => pieceOf(p.pieceId)?.mood === "rested");
  const running = action.data?.action;

  return (
    <>
      <div className="stage">
        <Canvas shadows dpr={[1, 1.5]} camera={{ position: [size.w * 0.9, size.w * 1.15, size.d * 1.35], fov: 42 }} gl={{ antialias: true }}>
          <RoomLighting span={Math.max(size.w, size.d)} />
          <RoomCamera w={size.w} h={size.d} />
          <HomeRoom
            editing
            w={size.w}
            d={size.d}
            wallFinish={h.wallFinish}
            floorFinish={h.floorFinish}
            placed={mode.kind === "placing" ? h.placed.filter((p) => p.itemId !== mode.itemId) : h.placed}
            selected={selected?.itemId ?? null}
            ghost={mode.kind === "placing" ? { pieceId: mode.pieceId, placement: mode.placement, ok: !ghostErr } : null}
            onCell={onCell}
            // Walls only take taps while placing a wall piece; otherwise the see-through
            // front walls would swallow taps meant for the floor behind them.
            onWall={mode.kind === "placing" && mode.placement.layer === "wall" ? onWall : undefined}
            // While placing, taps go through furniture to the floor (to aim, even at a taken spot).
            onPiece={mode.kind === "placing" ? undefined : (id) => setMode({ kind: "selected", itemId: id })}
          />
          <OrbitControls enablePan={false} minPolarAngle={0.4} maxPolarAngle={1.2} minDistance={6} maxDistance={Math.max(size.w, size.d) * 8} />
        </Canvas>
      </div>

      <div className="roomtop">
        <div className="pill">
          <b>Your home</b> · {h.doorOpen ? "door open" : "door closed"}
        </div>
        <div className="pill">{gm.toLocaleString("en-US")} GM</div>
      </div>
      {running && Date.parse(running.endsAt) > now && (
        <div className="roomstatus">
          😴 {label(running.kind)} · {countdown(Date.parse(running.endsAt) - now)} left{" "}
          <button className="link" onClick={() => run(() => api.cancelAction().then(() => action.reload()))}>
            Wake up
          </button>
        </div>
      )}
      {msg && <div className={`toast ${msg.bad ? "bad" : "good"}`}>{msg.text}</div>}

      <div className="homebar">
        {mode.kind === "view" && (
          <>
            <button onClick={() => setSheet("storage")}>📦 Storage ({h.storage.length})</button>
            <button onClick={() => setSheet("shop")}>🛒 Shop</button>
            <button onClick={() => setSheet("finishes")}>🎨 Walls & floor</button>
            <button onClick={() => run(() => api.setHome({ doorOpen: !h.doorOpen }), h.doorOpen ? "Door closed" : "Door open: visitors can drop in")}>{h.doorOpen ? "🚪 Close door" : "🚪 Open door"}</button>
            <button className="primary" onClick={onGoInside}>
              {nap ? "Go inside (nap here)" : "Go inside"}
            </button>
          </>
        )}
        {selected && mode.kind === "selected" && (
          <>
            <span className="what">{itemLabel(selected.pieceId)}</span>
            <button onClick={() => startPlacing(selected.itemId, selected.pieceId, false, selected.placement)}>✥ Move</button>
            {selected.placement.layer !== "wall" && (
              <button
                onClick={() => {
                  const pl = selected.placement as Placement & { rot: 0 | 90 | 180 | 270 };
                  const next = { ...pl, rot: nextRot(pl.rot) } as Placement;
                  const err = checkPlacement(h.tier, selected.pieceId, next, h.placed, selected.itemId);
                  if (err) return setMsg({ text: `Can't turn it there: ${err}`, bad: true });
                  void run(() => api.place(selected.itemId, next));
                }}
              >
                ↻ Turn
              </button>
            )}
            <button onClick={() => run(() => api.place(selected.itemId, { ...selected.placement, color: (selected.placement.color + 1) % 16 } as Placement))}>🎨 Colour</button>
            <button onClick={() => run(() => api.store(selected.itemId), "Put in storage").then(() => setMode({ kind: "view" }))}>📦 Store</button>
            <button onClick={() => setMode({ kind: "view" })}>Done</button>
          </>
        )}
        {mode.kind === "placing" && (
          <>
            <span className="what">{mode.placement.layer === "wall" ? "Tap a wall" : "Tap the floor"} to place {itemLabel(mode.pieceId)}</span>
            {mode.placement.layer !== "wall" && (
              <button onClick={() => setMode({ ...mode, placement: { ...mode.placement, rot: nextRot((mode.placement as { rot: number }).rot) } as Placement })}>↻ Turn</button>
            )}
            <button
              className="primary"
              disabled={!!ghostErr}
              onClick={() => run(() => api.place(mode.itemId, mode.placement), mode.isNew ? "Placed" : "Moved").then((ok) => ok && setMode({ kind: "view" }))}
            >
              {ghostErr ? ghostErr : "Place here"}
            </button>
            <button onClick={() => setMode({ kind: "view" })}>Cancel</button>
          </>
        )}
      </div>

      {sheet && (
        <div className="backdrop" onClick={() => setSheet(null)}>
          <div className="callsheet tall" onClick={(e) => e.stopPropagation()}>
            <button className="x" aria-label="close" onClick={() => setSheet(null)}>
              ×
            </button>
            {sheet === "storage" && (
              <>
                <p className="q">Storage</p>
                {h.storage.length === 0 && <p className="muted">Nothing in storage.</p>}
                {h.storage.map((s) => {
                  const p = pieceOf(s.pieceId);
                  return (
                    <div className="listrow" key={s.itemId}>
                      <span>
                        {itemLabel(s.pieceId)} <small className="muted">{s.source === "starter" ? "· starter item" : ""}</small>
                      </span>
                      {p?.layer === "wardrobe" ? <small className="muted">a wearable: wearing comes with the character kit</small> : <button onClick={() => startPlacing(s.itemId, s.pieceId, true)}>Place</button>}
                    </div>
                  );
                })}
              </>
            )}
            {sheet === "shop" && (
              <>
                <p className="q">Shop</p>
                <p className="muted">GM spent here burns. You have {gm.toLocaleString("en-US")} GM.</p>
                {!catalogue.data && <p className="muted">Loading…</p>}
                {catalogue.data &&
                  BANDS.map((band) => {
                    const items = catalogue.data!.pieces.filter((p) => p.band === band);
                    if (!items.length) return null;
                    return (
                      <div key={band}>
                        <h3 className="band">{label(band)}</h3>
                        {items.map((p) => (
                          <div className="listrow" key={p.id}>
                            <span>
                              {itemLabel(p.id)} <small className="muted">{p.layer === "wall" ? "wall" : `${p.w}×${p.d}`}{p.mood ? ` · ${p.mood}` : ""}</small>
                            </span>
                            <button
                              disabled={(p.price ?? 0) > gm}
                              onClick={() => {
                                // Same tap retried: same key, never charged twice.
                                const key = buyKeys.current.get(p.id) ?? newKey();
                                buyKeys.current.set(p.id, key);
                                void run(() => api.buy(p.id, key), `${itemLabel(p.id)} is in your storage`).then((ok) => {
                                  if (ok) {
                                    buyKeys.current.delete(p.id);
                                    onGm();
                                  }
                                });
                              }}
                            >
                              {p.price} GM
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })}
              </>
            )}
            {sheet === "finishes" && (
              <>
                <p className="q">Walls & floor</p>
                <h3 className="band">Walls</h3>
                <div className="swatches">
                  {Object.entries(WALL_COLORS).map(([k, c]) => (
                    <button key={k} title={label(k)} aria-label={`walls ${label(k)}`} className={h.wallFinish === k ? "on" : ""} style={{ background: c }} onClick={() => run(() => api.setHome({ wall: k }))} />
                  ))}
                </div>
                <h3 className="band">Floor</h3>
                <div className="swatches">
                  {Object.entries(FLOOR_COLORS).map(([k, c]) => (
                    <button key={k} title={label(k)} aria-label={`floor ${label(k)}`} className={h.floorFinish === k ? "on" : ""} style={{ background: c }} onClick={() => run(() => api.setHome({ floor: k }))} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export type { Home };
