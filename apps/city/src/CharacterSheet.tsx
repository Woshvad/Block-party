"use client";
import { randomLook, seededRandomInt } from "@bp/core";
import { OrthographicCamera } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Look } from "./api";
import ChibiCrowd, { type ChibiPerson } from "./chibi/Crowd";
import { FACE_NAMES, SHEET, faceSheet } from "./chibi/faces";
import { GLASSES_NAMES, HAIR_NAMES, HAT_NAMES } from "./chibi/parts";
import { HAIR, OUTFIT, SKIN } from "./palette";

// The character sheet: the drafts our artist judges and paints over. Every
// row is the live renderer the city uses, so what's here is what players see.

const BASE: Look = { v: 1, bodyType: "body2", face: "face1", hair: "hair2", top: "top5", bottom: "bottom1", shoes: "shoes1", hat: "none", glasses: "none", skinTone: 4, hairColor: 1, outfitColor: 7 };
const person = (id: string, look: Look, x: number, yaw = 0.35, extra: Partial<ChibiPerson> = {}): ChibiPerson => ({ id, look, x, z: 0, yaw, moving: false, phase: 0, ...extra });

// Fits the whole row across the canvas, phone or laptop.
function FitRow({ span, max }: { span: number; max: number }) {
  const camera = useThree((s) => s.camera);
  const width = useThree((s) => s.size.width);
  useEffect(() => {
    camera.zoom = Math.min(max, width / span);
    camera.updateProjectionMatrix();
  }, [camera, width, span, max]);
  return null;
}

function Lineup({ people, height = 220, zoom = 120, walk = false }: { people: ChibiPerson[]; height?: number; zoom?: number; walk?: boolean }) {
  const xsAll = people.map((p) => p.x);
  const span = (xsAll.length ? Math.max(...xsAll) - Math.min(...xsAll) : 0) + 1.1;
  const ref = useRef(people);
  ref.current = people;
  return (
    <div className="lineup" style={{ height }}>
      <Canvas dpr={[1, 2]} gl={{ antialias: true }}>
        <OrthographicCamera makeDefault position={[0, 0.7, 6]} zoom={zoom} />
        <FitRow span={span} max={zoom} />
        <color attach="background" args={["#f4efe6"]} />
        <hemisphereLight args={["#ffffff", "#c9c2b6", 1.1]} />
        <directionalLight position={[3, 5, 4]} intensity={1.5} />
        <ChibiCrowd people={ref} cap={Math.max(1, people.length)} />
        {walk && <Walker people={ref} />}
      </Canvas>
    </div>
  );
}

// Walks a lineup in place, to judge the walk cycle.
function Walker({ people }: { people: React.MutableRefObject<ChibiPerson[]> }) {
  useFrame((_, dt) => {
    for (const p of people.current) {
      p.moving = true;
      p.phase += Math.min(dt, 0.1) * 9;
    }
  });
  return null;
}

export default function CharacterSheet() {
  const [faces, setFaces] = useState<string | null>(null);
  useEffect(() => {
    setFaces(faceSheet().toDataURL("image/png"));
  }, []);
  const crowd = useMemo(() => Array.from({ length: 12 }, (_, i) => person(`crowd${i}`, randomLook(seededRandomInt(100 + i)) as unknown as Look, (i - 5.5) * 0.85, 0.3)), []);

  const xs = (n: number, gap: number) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * gap);

  return (
    <div className="sheetpage">
      <h1>Block Party · character sheet</h1>
      <p className="muted">
        First drafts, drawn in code: original, not traced from anywhere. Every row is the live renderer the city uses. Paint over the face sheet (same grid, transparent PNG) and it drops straight in.
      </p>

      <h2>Turnaround</h2>
      <Lineup people={[0, -0.75, -Math.PI / 2, Math.PI].map((yaw, i) => person(`turn${i}`, BASE, xs(4, 1.3)[i]!, yaw))} />

      <h2>Faces (pick one at move-in)</h2>
      <Lineup people={xs(8, 0.8).map((x, i) => person(`face${i}`, { ...BASE, face: `face${i + 1}`, hair: "hair1" }, x, 0))} height={190} zoom={105} />
      <p className="caption">{FACE_NAMES.slice(0, 8).join(" · ")}</p>

      <h2>Moods (they replace the face while they last)</h2>
      <Lineup
        people={["called_it", "rekt", "tilted", "cozy", "rested", "chart_brain"].map((mood, i) => person(`mood${i}`, { ...BASE, hair: "hair1" }, xs(6, 0.95)[i]!, 0, { mood }))}
        height={190}
        zoom={105}
      />
      <p className="caption">{FACE_NAMES.slice(8, 14).join(" · ")}</p>

      <h2>Hair</h2>
      <Lineup people={xs(10, 0.72).map((x, i) => person(`hair${i}`, { ...BASE, hair: `hair${i + 1}`, hairColor: i }, x, 0.5))} height={190} zoom={88} />
      <p className="caption">{HAIR_NAMES.join(" · ")}</p>

      <h2>Hats and glasses</h2>
      <Lineup
        people={[
          ...HAT_NAMES.map((_, i) => ({ ...BASE, hat: `hat${i + 1}`, hair: "hair1", outfitColor: i * 3 })),
          ...GLASSES_NAMES.map((_, i) => ({ ...BASE, glasses: `glasses${i + 1}`, hair: "hair1" })),
        ].map((l, i) => person(`acc${i}`, l, xs(8, 0.85)[i]!, 0.35))}
        height={190}
        zoom={100}
      />
      <p className="caption">
        {HAT_NAMES.join(" · ")} · {GLASSES_NAMES.join(" · ")}
      </p>

      <h2>Bodies and skin tones</h2>
      <Lineup people={xs(10, 0.72).map((x, i) => person(`skin${i}`, { ...BASE, skinTone: i, bodyType: `body${(i % 3) + 1}`, top: i % 2 ? "top2" : "top6", bottom: `bottom${(i % 5) + 1}`, outfitColor: (i * 5) % 16, shoes: `shoes${(i % 4) + 1}` }, x, 0.4))} height={190} zoom={88} />

      <h2>A crowd, walking</h2>
      <Lineup people={crowd} height={200} zoom={80} walk />

      <h2>Face sheet</h2>
      <p className="muted">
        {SHEET.cols} × {SHEET.rows} cells of {SHEET.cell}px. Row 1-2: the 8 faces. Row 3: moods. Last row: Chart-brain, blink, spare.
      </p>
      {faces && (
        <>
          <img className="facesheet" src={faces} alt="face sheet" />
          <a className="btn" download="block-party-face-sheet.png" href={faces}>
            Download the face sheet (to paint over)
          </a>
        </>
      )}

      <h2>Palettes</h2>
      {[
        ["Skin", SKIN],
        ["Hair", HAIR],
        ["Outfit", OUTFIT],
      ].map(([name, colors]) => (
        <div className="swatches" key={name as string}>
          <small className="muted swatch-label">{name as string}</small>
          {(colors as string[]).map((c) => (
            <span key={c} className="sw" style={{ background: c }} title={c} />
          ))}
        </div>
      ))}
    </div>
  );
}
