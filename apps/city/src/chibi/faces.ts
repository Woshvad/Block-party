// The face sheet: 16 cells in a 4×4 grid, drawn once into a canvas and used
// as a texture by every head in the city. Cells 0-7 are the 8 faces a
// resident picks; 8-13 replace them while a mood is showing; 14 is a blink.
// Original drafts drawn in code, made to be repainted by our artist: swap
// the canvas for their PNG sheet (same grid) and nothing else changes.

export const SHEET = { cols: 4, rows: 4, cell: 256 } as const;
export const MOOD_CELLS: Record<string, number> = { called_it: 8, rekt: 9, tilted: 10, cozy: 11, rested: 12, chart_brain: 13 };
export const BLINK_CELL = 14;

export const faceIndex = (face: string) => {
  const n = Number(/(\d+)$/.exec(face)?.[1] ?? 1);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n - 1 : 0;
};

// Which cell to show: a mood beats the face, a blink beats both.
export function cellFor(face: string, mood: string | null = null, blinking = false): number {
  if (blinking) return BLINK_CELL;
  if (mood && mood in MOOD_CELLS) return MOOD_CELLS[mood]!;
  return faceIndex(face);
}

// Where that cell sits in the texture, in UV space (v counts up from the bottom).
export function cellUv(cell: number): { u: number; v: number; w: number; h: number } {
  const c = ((cell % 16) + 16) % 16;
  const col = c % SHEET.cols;
  const row = Math.floor(c / SHEET.cols);
  return { u: col / SHEET.cols, v: 1 - (row + 1) / SHEET.rows, w: 1 / SHEET.cols, h: 1 / SHEET.rows };
}

// --- Drawing (browser only) -------------------------------------------------

type G = CanvasRenderingContext2D;
const INK = "#2a1d1a";
const BLUSH = "rgba(240,120,130,0.45)";

function eye(g: G, x: number, y: number, kind: "round" | "big" | "sleepy" | "narrow" | "happy" | "wink" | "spiral" | "x" | "closed", s = 1) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = INK;
  g.strokeStyle = INK;
  g.lineWidth = 7;
  g.lineCap = "round";
  switch (kind) {
    case "round":
      g.beginPath();
      g.ellipse(0, 0, 13, 17, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(-4, -6, 5, 0, Math.PI * 2);
      g.fill();
      break;
    case "big":
      g.beginPath();
      g.ellipse(0, 0, 17, 22, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(-6, -8, 7, 0, Math.PI * 2);
      g.arc(6, 7, 3, 0, Math.PI * 2);
      g.fill();
      break;
    case "sleepy":
      g.beginPath();
      g.ellipse(0, 4, 13, 9, 0, 0, Math.PI);
      g.fill();
      g.beginPath();
      g.moveTo(-15, 2);
      g.lineTo(15, 2);
      g.stroke();
      break;
    case "narrow":
      g.beginPath();
      g.ellipse(0, 0, 15, 7, 0, 0, Math.PI * 2);
      g.fill();
      break;
    case "happy":
      g.beginPath();
      g.arc(0, 6, 13, Math.PI * 1.1, Math.PI * 1.9);
      g.stroke();
      break;
    case "wink":
      g.beginPath();
      g.moveTo(-14, 0);
      g.lineTo(0, -6);
      g.lineTo(14, 0);
      g.stroke();
      break;
    case "closed":
      g.beginPath();
      g.arc(0, -4, 13, Math.PI * 0.15, Math.PI * 0.85);
      g.stroke();
      break;
    case "spiral":
      g.lineWidth = 4;
      g.beginPath();
      for (let a = 0; a < Math.PI * 5; a += 0.2) g.lineTo(Math.cos(a) * a * 1.1, Math.sin(a) * a * 1.1);
      g.stroke();
      break;
    case "x":
      g.beginPath();
      g.moveTo(-11, -11);
      g.lineTo(11, 11);
      g.moveTo(11, -11);
      g.lineTo(-11, 11);
      g.stroke();
      break;
  }
  g.restore();
}

function mouth(g: G, kind: "smile" | "grin" | "o" | "smirk" | "flat" | "cat" | "wobble" | "teeth" | "zz" | "soft", y = 168) {
  g.save();
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.lineWidth = 7;
  g.lineCap = "round";
  g.lineJoin = "round";
  const x = 128;
  g.beginPath();
  switch (kind) {
    case "smile":
      g.arc(x, y - 12, 20, Math.PI * 0.2, Math.PI * 0.8);
      g.stroke();
      break;
    case "soft":
      g.arc(x, y - 8, 12, Math.PI * 0.25, Math.PI * 0.75);
      g.stroke();
      break;
    case "grin":
      g.moveTo(x - 24, y - 6);
      g.quadraticCurveTo(x, y + 26, x + 24, y - 6);
      g.closePath();
      g.fill();
      g.fillStyle = "#e8737a";
      g.beginPath();
      g.ellipse(x, y + 8, 10, 5, 0, 0, Math.PI * 2);
      g.fill();
      break;
    case "o":
      g.ellipse(x, y, 9, 12, 0, 0, Math.PI * 2);
      g.fill();
      break;
    case "smirk":
      g.moveTo(x - 16, y);
      g.quadraticCurveTo(x + 6, y + 6, x + 20, y - 10);
      g.stroke();
      break;
    case "flat":
      g.moveTo(x - 14, y);
      g.lineTo(x + 14, y);
      g.stroke();
      break;
    case "cat":
      g.moveTo(x - 20, y - 4);
      g.quadraticCurveTo(x - 10, y + 10, x, y - 2);
      g.quadraticCurveTo(x + 10, y + 10, x + 20, y - 4);
      g.stroke();
      break;
    case "wobble":
      g.moveTo(x - 22, y + 4);
      for (let i = -22; i <= 22; i += 4) g.lineTo(x + i, y + Math.sin(i / 3) * 4);
      g.stroke();
      break;
    case "teeth":
      g.fillStyle = "#fff";
      g.rect(x - 22, y - 8, 44, 16);
      g.fill();
      g.stroke();
      g.beginPath();
      for (let i = -11; i <= 11; i += 11) {
        g.moveTo(x + i, y - 8);
        g.lineTo(x + i, y + 8);
      }
      g.lineWidth = 3;
      g.stroke();
      break;
    case "zz":
      g.lineWidth = 5;
      g.ellipse(x, y, 7, 5, 0, 0, Math.PI * 2);
      g.stroke();
      break;
  }
  g.restore();
}

const brow = (g: G, x: number, y: number, tilt: number, w = 22) => {
  g.save();
  g.strokeStyle = INK;
  g.lineWidth = 7;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(x - w / 2, y + tilt);
  g.lineTo(x + w / 2, y - tilt);
  g.stroke();
  g.restore();
};

const blush = (g: G) => {
  g.fillStyle = BLUSH;
  for (const x of [70, 186]) {
    g.beginPath();
    g.ellipse(x, 150, 20, 11, 0, 0, Math.PI * 2);
    g.fill();
  }
};

const freckles = (g: G) => {
  g.fillStyle = "rgba(120,70,50,0.6)";
  for (const [x, y] of [[66, 140], [78, 148], [72, 156], [184, 140], [176, 148], [190, 154]] as const) {
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
  }
};

const EY = 116; // eye line
const EL = 92;
const ER = 164;

// The 16 cells, in order. Each draws on a 256×256 transparent square.
const CELLS: ((g: G) => void)[] = [
  // 0 face1: bright and friendly
  (g) => (eye(g, EL, EY, "round"), eye(g, ER, EY, "round"), mouth(g, "smile"), blush(g)),
  // 1 face2: sleepy, unbothered
  (g) => (eye(g, EL, EY, "sleepy"), eye(g, ER, EY, "sleepy"), mouth(g, "soft")),
  // 2 face3: the wink
  (g) => (eye(g, EL, EY, "round"), eye(g, ER, EY, "wink"), mouth(g, "smirk"), blush(g)),
  // 3 face4: wide-eyed
  (g) => (eye(g, EL, EY, "big"), eye(g, ER, EY, "big"), mouth(g, "o")),
  // 4 face5: cool and narrow
  (g) => (brow(g, EL, EY - 26, -3), brow(g, ER, EY - 26, 3), eye(g, EL, EY, "narrow"), eye(g, ER, EY, "narrow"), mouth(g, "smirk")),
  // 5 face6: determined
  (g) => (brow(g, EL, EY - 28, 6), brow(g, ER, EY - 28, -6), eye(g, EL, EY, "round"), eye(g, ER, EY, "round"), mouth(g, "flat")),
  // 6 face7: freckled grin
  (g) => (eye(g, EL, EY, "round", 0.9), eye(g, ER, EY, "round", 0.9), freckles(g), mouth(g, "grin")),
  // 7 face8: the cat
  (g) => (eye(g, EL, EY, "happy"), eye(g, ER, EY, "happy"), mouth(g, "cat"), blush(g)),
  // 8 called_it: smug delight
  (g) => (eye(g, EL, EY, "happy"), eye(g, ER, EY, "happy"), mouth(g, "grin"), blush(g)),
  // 9 rekt: tears
  (g) => {
    eye(g, EL, EY, "x");
    eye(g, ER, EY, "x");
    mouth(g, "wobble");
    g.fillStyle = "rgba(90,170,240,0.85)";
    for (const x of [EL, ER]) {
      g.beginPath();
      g.moveTo(x, EY + 16);
      g.quadraticCurveTo(x - 9, EY + 40, x, EY + 46);
      g.quadraticCurveTo(x + 9, EY + 40, x, EY + 16);
      g.fill();
    }
  },
  // 10 tilted: gritted teeth
  (g) => (brow(g, EL, EY - 24, 8), brow(g, ER, EY - 24, -8), eye(g, EL, EY, "narrow"), eye(g, ER, EY, "narrow"), mouth(g, "teeth")),
  // 11 cozy: content, warm
  (g) => (eye(g, EL, EY, "closed"), eye(g, ER, EY, "closed"), mouth(g, "soft"), blush(g)),
  // 12 rested: fresh
  (g) => (eye(g, EL, EY, "big", 0.85), eye(g, ER, EY, "big", 0.85), mouth(g, "smile")),
  // 13 chart_brain: spiral eyes
  (g) => (eye(g, EL, EY, "spiral"), eye(g, ER, EY, "spiral"), mouth(g, "flat")),
  // 14 blink
  (g) => (eye(g, EL, EY, "closed"), eye(g, ER, EY, "closed"), mouth(g, "soft")),
  // 15 spare: surprised
  (g) => (eye(g, EL, EY, "round", 1.15), eye(g, ER, EY, "round", 1.15), mouth(g, "o")),
];

export const FACE_NAMES = ["Bright", "Sleepy", "Wink", "Wide-eyed", "Cool", "Determined", "Freckled grin", "Cat", "Called it", "REKT", "Tilted", "Cozy", "Rested", "Chart-brain", "Blink", "Surprised"];

let sheet: HTMLCanvasElement | null = null;

// One shared canvas for the whole visit.
export function faceSheet(): HTMLCanvasElement {
  if (sheet) return sheet;
  const c = document.createElement("canvas");
  c.width = SHEET.cols * SHEET.cell;
  c.height = SHEET.rows * SHEET.cell;
  const g = c.getContext("2d")!;
  CELLS.forEach((draw, i) => {
    g.save();
    g.translate((i % SHEET.cols) * SHEET.cell, Math.floor(i / SHEET.cols) * SHEET.cell);
    // Features drawn 1.3× around the cell's centre: big, readable chibi faces.
    g.translate(128, 128);
    g.scale(1.3, 1.3);
    g.translate(-128, -128);
    draw(g);
    g.restore();
  });
  sheet = c;
  return c;
}

export const CELL_COUNT = CELLS.length;
