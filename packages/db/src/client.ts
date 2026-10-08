import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string, opts: postgres.Options<{}> = {}) {
  const client = postgres(url, { max: 10, onnotice: () => {}, ...opts });
  const db: Db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}
