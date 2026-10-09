import { BACKSTORIES, LOOK_PALETTES } from "@bp/core";
import { describe, expect, it } from "vitest";
import { HAIR, OUTFIT, SKIN, itemLabel, label } from "../src/palette";

describe("palettes", () => {
  it("have exactly as many colours as the server allows", () => {
    expect(SKIN).toHaveLength(LOOK_PALETTES.skinTone);
    expect(HAIR).toHaveLength(LOOK_PALETTES.hairColor);
    expect(OUTFIT).toHaveLength(LOOK_PALETTES.outfitColor);
    for (const c of [...SKIN, ...HAIR, ...OUTFIT]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("labels", () => {
  it("read as words", () => {
    expect(label("night_owl")).toBe("Night owl");
    expect(label("")).toBe("");
    expect(label("bodyType")).toBe("Body type");
    expect(label("skinTone")).toBe("Skin tone");
    expect(itemLabel("poster_airdrop_baby")).toBe("Airdrop baby poster");
    expect(itemLabel("cap_og_kid")).toBe("OG kid cap");
    expect(label("og_kid")).toBe("OG kid");
    expect(label("dogs")).toBe("Dogs");
  });

  it("every starter item gets a label with no underscores", () => {
    for (const b of Object.values(BACKSTORIES)) expect(itemLabel(b.starterItem)).not.toMatch(/_/);
  });
});
