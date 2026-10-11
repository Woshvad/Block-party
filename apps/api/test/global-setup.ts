import "dotenv/config";
import { apiTestDatabaseUrl } from "./db-url";

// The API suite gets its own database so it never races the db package's suite.
export default async function setup() {
  process.env.TEST_DATABASE_URL = apiTestDatabaseUrl();
  const { default: dbSetup } = await import("../../../packages/db/test/global-setup");
  await dbSetup();
  return () => {};
}
