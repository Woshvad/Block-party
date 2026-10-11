import { expect, it } from "vitest";
import { messageFeed } from "../src/messageFeed";

it("uses new conversation data and never restores an older poll over new messages", async () => {
  let resolve!: (v: string[]) => void;
  let loader = () => new Promise<string[]>((r) => { resolve = r; });
  const seen: string[][] = [];
  const errors: unknown[] = [];
  const feed = messageFeed(() => loader(), (v) => seen.push(v), (e) => errors.push(e));
  const old = feed.refresh();
  loader = async () => ["first DM", "reply"];
  await feed.refresh();
  resolve([]);
  await old;
  expect(seen).toEqual([["first DM", "reply"]]);
  loader = () => new Promise((r) => { resolve = r; });
  const last = feed.refresh();
  feed.close();
  resolve(["late reply"]);
  await last;
  expect(seen).toHaveLength(1);
  expect(errors).toEqual([]);
});
