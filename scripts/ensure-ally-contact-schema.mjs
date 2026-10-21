import pg from "pg";
import { ensureAllyContactSchema } from "./ally-contact-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para preparar los contactos de aliados.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, application_name: "finserpay-ally-contact-schema" });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-ally-contact-schema'))");
  await ensureAllyContactSchema(client);
  await client.query("COMMIT");
  console.log("Contactos de aliados preparados correctamente.");
} catch {
  await client.query("ROLLBACK").catch(() => undefined);
  throw new Error("No se pudo preparar el esquema de contactos de aliados.");
} finally {
  await client.end().catch(() => undefined);
}
