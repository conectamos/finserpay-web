import pg from "pg";
import { readFile } from "node:fs/promises";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("Falta DATABASE_URL para preparar postulaciones de comercios.");
const client = new pg.Client({ connectionString, application_name: "finserpay-merchant-applications-schema", connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-merchant-applications-schema'))");
  await client.query(await readFile(new URL("./setup-merchant-applications.sql", import.meta.url), "utf8"));
  await client.query(`SELECT "id", "data", "notificationStatus", "ambiguousAttempt", "providerEmailId", "leaseToken" FROM public."MerchantApplication" LIMIT 0`);
  await client.query("COMMIT");
  console.log("Esquema de postulaciones de comercios preparado.");
} catch {
  await client.query("ROLLBACK").catch(() => undefined);
  throw new Error("No se pudo preparar el esquema de postulaciones de comercios.");
} finally { await client.end().catch(() => undefined); }
