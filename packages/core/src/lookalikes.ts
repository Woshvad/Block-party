// Letters that look like Latin ones. Text that is matched against a word list
// (reserved names, scam phrases, blocked words) reads through them, so "Fаucet
// Frеn" written with a Cyrillic а and е is still Faucet Fren, and "ᴀᴅᴍɪɴ" in
// small capitals (the usual "fancy text" font) is still admin. A small table
// of the common lookalikes from Unicode's confusables list (UTS #39): Latin
// small capitals and phonetic letters, Cyrillic, Greek, a few Armenian
// letters, and the Cherokee and Lisu letters drawn like Latin capitals.
// Lowercase Cyrillic к, м, н and т look like the small capitals ᴋ, ᴍ, ʜ and ᴛ,
// so they read as those letters too.
const LOOKALIKES: Record<string, string> = {
  // Latin small capitals: NFKD leaves them alone, so without this they'd
  // simply vanish from a skeleton.
  ᴀ: "a",
  ʙ: "b",
  ᴄ: "c",
  ᴅ: "d",
  ᴇ: "e",
  ꜰ: "f",
  ɢ: "g",
  ʜ: "h",
  ɪ: "i",
  ᴊ: "j",
  ᴋ: "k",
  ʟ: "l",
  ᴍ: "m",
  ɴ: "n",
  ᴏ: "o",
  ᴘ: "p",
  ꞯ: "q",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴠ: "v",
  ᴡ: "w",
  ʏ: "y",
  ᴢ: "z",
  // Phonetic letters that pass for plain ones
  ɑ: "a",
  ɡ: "g",
  ı: "i",
  ȷ: "j",
  ɩ: "i",
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
  к: "k",
  м: "m",
  н: "h",
  т: "t",
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
  // Lisu capitals
  ꓐ: "b",
  ꓑ: "p",
  ꓓ: "d",
  ꓔ: "t",
  ꓖ: "g",
  ꓗ: "k",
  ꓙ: "j",
  ꓚ: "c",
  ꓜ: "z",
  ꓝ: "f",
  ꓟ: "m",
  ꓠ: "n",
  ꓡ: "l",
  ꓢ: "s",
  ꓣ: "r",
  ꓦ: "v",
  ꓧ: "h",
  ꓪ: "w",
  ꓫ: "x",
  ꓬ: "y",
  ꓮ: "a",
  ꓰ: "e",
  ꓲ: "i",
  ꓳ: "o",
  ꓴ: "u",
};

// Cherokee letters drawn like Latin ones ("Ꮇayor"). Their small forms look
// like small capitals, so each counts in both cases.
const CHEROKEE: Record<string, string> = {
  Ꭰ: "d",
  Ꭱ: "r",
  Ꭲ: "t",
  Ꭵ: "i",
  Ꭺ: "a",
  Ꭻ: "j",
  Ꭼ: "e",
  Ꮃ: "w",
  Ꮇ: "m",
  Ꮋ: "h",
  Ꮐ: "g",
  Ꮓ: "z",
  Ꮟ: "b",
  Ꮤ: "w",
  Ꮥ: "s",
  Ꮩ: "v",
  Ꮪ: "s",
  Ꮮ: "l",
  Ꮯ: "c",
  Ꮲ: "p",
  Ꮶ: "k",
  Ᏼ: "b",
};
for (const [capital, latin] of Object.entries(CHEROKEE)) {
  LOOKALIKES[capital] = latin;
  LOOKALIKES[capital.toLowerCase()] = latin;
}

const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "gu");

// Each lookalike becomes the lowercase Latin letter it passes for; everything
// else is left as it was. Run it before lowercasing: Greek capital Η looks
// like H, its small letter η like n.
export function foldLookalikes(s: string): string {
  return s.replace(LOOKALIKE, (c) => LOOKALIKES[c] ?? c);
}
