import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function parseJsonc(text: string) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      // loop-bound: skips to the end of this line, at most the rest of the text
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += ch;
  }
  return JSON.parse(out);
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const cfg = parseJsonc(read("../wrangler.jsonc"));
const worker = read("../src/worker.ts");

describe("the rooms wrangler config matches the code", () => {
  it("every Durable Object binding names a class the Worker exports, and each class is migrated once", () => {
    const migrated = cfg.migrations.flatMap((m: { new_sqlite_classes?: string[] }) => m.new_sqlite_classes ?? []);
    for (const b of cfg.durable_objects.bindings) {
      expect(worker).toContain(`export class ${b.class_name} `);
      expect(worker).toMatch(new RegExp(`\\b${b.name}: DurableObjectNamespace`));
      expect(migrated.filter((c: string) => c === b.class_name)).toHaveLength(1);
    }
  });

  it("vars are ones the Worker reads; the runtime test uses the same date", () => {
    for (const k of Object.keys(cfg.vars)) expect(worker).toMatch(new RegExp(`\\b${k}\\??:`));
    expect(read("./rooms.test.ts")).toContain(`compatibilityDate: "${cfg.compatibility_date}"`);
    expect(cfg.main).toBe("dist/worker.js");
  });

  it("no secret sits in the config", () => {
    const text = JSON.stringify(cfg);
    for (const k of ["TICKET_SECRET", "INTERNAL_SECRET"]) expect(text).not.toContain(k);
  });
});
