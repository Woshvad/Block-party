// The API suite's database: next to TEST_DATABASE_URL's (same host and user),
// named after it, so two checkouts (or the db package's suite) never share one.
// Idempotent: an URL that already names an _api_test database is kept.
export function apiTestDatabaseUrl(base = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/blockparty_test") {
  const url = new URL(base);
  const name = url.pathname.slice(1);
  if (!name.endsWith("_api_test")) url.pathname = `/${name.replace(/_test$/, "")}_api_test`;
  return url.toString();
}
