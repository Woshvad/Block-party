// The API suite's database: next to TEST_DATABASE_URL's (same host and user),
// named after it, so two checkouts (or the db package's suite) never share one.
// Each test worker then runs on its own copy (packages/db/test/test-db.ts).
// Idempotent: an URL that already names an API test database (or a worker's
// copy of one) is kept.
export function apiTestDatabaseUrl(base = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/blockparty_test") {
  const url = new URL(base);
  const name = url.pathname.slice(1);
  if (!/_api(_w\d+)?_test$/.test(name)) url.pathname = `/${name.replace(/_test$/, "")}_api_test`;
  return url.toString();
}
