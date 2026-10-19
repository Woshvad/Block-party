import type { TestProject } from "vitest/node";
import { loadEnv } from "../src/env";
import { freshDatabases } from "./test-db";

loadEnv();

// Fresh test databases per run, one per worker (see test-db.ts).
export default async function setup(project: TestProject) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  await freshDatabases(url, project.config.maxWorkers);
}
