import type { TestProject } from "vitest/node";
import { loadEnv } from "@bp/db/src/env";
import { apiTestDatabaseUrl } from "./db-url";

loadEnv();

// The API suite gets its own databases so it never races the db package's suite.
export default async function setup(project: TestProject) {
  process.env.TEST_DATABASE_URL = apiTestDatabaseUrl();
  const { default: dbSetup } = await import("../../../packages/db/test/global-setup");
  await dbSetup(project);
  return () => {};
}
