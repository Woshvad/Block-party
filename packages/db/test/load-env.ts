import { loadEnv } from "../src/env";

// Each test worker's settings: the package's .env, then the repo root's.
loadEnv();
