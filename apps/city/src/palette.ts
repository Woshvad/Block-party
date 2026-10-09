// Resident colours, indexed by the look's palette numbers (sizes match
// LOOK_PALETTES in @bp/core; the test checks it).
export const SKIN = ["#f6d5bd", "#f1c7a5", "#e3b08a", "#d9a47c", "#c48a5f", "#b97a52", "#9c6440", "#8d5a3b", "#6e4429", "#5e3a26"];
export const HAIR = ["#1b1714", "#3b2a20", "#5a3a22", "#8a5a2b", "#b98a4e", "#e2c48a", "#d9d4cc", "#9b2f2f", "#d0682e", "#2f5fae", "#7b4fc9", "#2e9e74"];
export const OUTFIT = [
  "#e24b4a", "#ef9f27", "#f2d04b", "#97c459", "#1d9e75", "#3ab5c9", "#378add", "#534ab7",
  "#8f5bd1", "#d4537e", "#f4c0d1", "#f4f1ea", "#9a9a94", "#2c2c2a", "#7a4a2a", "#c9a27a",
];

// Plain words for ids: "night_owl" -> "Night owl", "bodyType" -> "Body type".
export function label(id: string): string {
  const s = id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b(og|gm|nft)\b/g, (w) => w.toUpperCase());
  return s ? s[0]!.toUpperCase() + s.slice(1) : "";
}

// Starter items read naturally: "poster_airdrop_baby" -> "Airdrop baby poster".
export function itemLabel(id: string): string {
  const m = /^(poster|tee|cap)_(.+)$/.exec(id);
  return m ? `${label(m[2]!)} ${m[1]}` : label(id);
}
