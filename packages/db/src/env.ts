import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Local settings for the scripts, the dev server and the test suites. pnpm
// runs each package's scripts from that package's directory, so plain
// dotenv/config only ever saw a .env there, and README Setup makes one at the
// repo root. Now: the working directory's .env first, then the root one. A
// variable that's already set (CI sets them all) always wins. Not for Workers:
// they get their settings from bindings.
export const ROOT_ENV = fileURLToPath(new URL("../../../.env", import.meta.url));

export function loadEnv(files: string[] = [".env", ROOT_ENV]) {
  // A file that isn't there is skipped.
  config({ path: files, quiet: true });
}
