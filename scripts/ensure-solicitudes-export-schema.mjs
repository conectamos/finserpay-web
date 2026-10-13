import { readFile } from "node:fs/promises";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL no está configurada para preparar las exportaciones.");
const statements = JSON.parse(await readFile(new URL("../lib/solicitudes-export-schema-statements.json", import.meta.url), "utf8"));
const client = new pg.Client({ connectionString, application_name: "finserpay-export-schema", connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-export-schema'))");
  for (const statement of statements) await client.query(statement);
  await client.query("COMMIT");
  console.log("Esquema de exportaciones preparado correctamente.");
} catch {
  await client.query("ROLLBACK").catch(() => undefined);
  throw new Error("No se pudo preparar el esquema de exportaciones.");
} finally { await client.end().catch(() => undefined); }
