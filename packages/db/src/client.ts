import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

/** Create a Drizzle client. Call `close()` on shutdown. */
export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

/** Liveness probe; throws when the database is unreachable. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
