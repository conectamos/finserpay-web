import pg from "pg";
import { blacklistSchemaStatements } from "./document-blacklist-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para preparar la lista negra.");
const client = new pg.Client({ connectionString, application_name: "finserpay-document-blacklist-schema", connectionTimeoutMillis: 10000 });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-document-blacklist-schema'))");
  for (const statement of blacklistSchemaStatements) await client.query(statement);
  await client.query("COMMIT");
  console.log("Esquema de lista negra verificado.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
