// Letters from other scripts that look like Latin ones. Text that is matched
// against a word list (reserved names, scam phrases, blocked words) reads
// through them, so "Fаucet Frеn" written with a Cyrillic а and е is still
// Faucet Fren. A small table of the common lookalikes from Unicode's
// confusables list (UTS #39): Cyrillic, Greek and a few Armenian letters.
// Only shapes that pass for a Latin letter are here: lowercase Cyrillic к, м,
// н and т look like small capitals, so they stay out, while their capitals
// (К, М, Н, Т) are in.
const LOOKALIKES: Record<string, string> = {
  // Cyrillic capitals
  А: "a",
  В: "b",
  Е: "e",
  К: "k",
  М: "m",
  Н: "h",
  О: "o",
  Р: "p",
  С: "c",
  Т: "t",
  У: "y",
  Х: "x",
  Ѕ: "s",
  І: "i",
  Ј: "j",
  Ү: "y",
  Һ: "h",
  Ӏ: "i",
  Ԛ: "q",
  Ԝ: "w",
  // Cyrillic small letters
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  ѕ: "s",
  і: "i",
  ј: "j",
  ү: "y",
  һ: "h",
  ӏ: "l",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  // Greek capitals
  Α: "a",
  Β: "b",
  Ε: "e",
  Ζ: "z",
  Η: "h",
  Ι: "i",
  Κ: "k",
  Μ: "m",
  Ν: "n",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
  Υ: "y",
  Χ: "x",
  // Greek small letters
  α: "a",
  γ: "y",
  η: "n",
  ι: "i",
  ν: "v",
  ο: "o",
  ρ: "p",
  υ: "u",
  χ: "x",
  ω: "w",
  // Armenian small letters
  հ: "h",
  ո: "n",
  ս: "u",
  օ: "o",
};

const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "gu");

// Each lookalike becomes the lowercase Latin letter it passes for; everything
// else is left as it was. Run it before lowercasing: Greek capital Η looks
// like H, its small letter η like n.
export function foldLookalikes(s: string): string {
  return s.replace(LOOKALIKE, (c) => LOOKALIKES[c] ?? c);
}
