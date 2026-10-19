import { loadEnv } from "../src/env";
import { workerDatabaseUrl } from "./test-db";

// Each test worker's settings: the package's .env, then the repo root's.
loadEnv();
// And its own database.
if (process.env.TEST_DATABASE_URL) process.env.TEST_DATABASE_URL = workerDatabaseUrl(process.env.TEST_DATABASE_URL);
