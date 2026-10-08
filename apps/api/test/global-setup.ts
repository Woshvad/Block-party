import "dotenv/config";

// The API suite gets its own database so it never races the db package's suite.
export default async function setup() {
  const base = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/blockparty_test";
  const url = new URL(base);
  url.pathname = "/blockparty_api_test";
  process.env.TEST_DATABASE_URL = url.toString();
  const { default: dbSetup } = await import("../../../packages/db/test/global-setup");
  await dbSetup();
  return () => {};
}
