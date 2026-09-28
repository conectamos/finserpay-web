import { readFile } from "node:fs/promises";
import pg from "pg";

// Explicit installer. Importing application modules never runs schema changes.
const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para preparar comisiones.");
const client = new pg.Client({ connectionString, application_name: "finserpay-commissions-schema", connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query("SET lock_timeout = '10s'");
  await client.query("SET statement_timeout = '120s'");
  await client.query(await readFile(new URL("./setup-commissions.sql", import.meta.url), "utf8"));
  console.log("Esquema de comisiones preparado correctamente.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error(`No se pudo preparar el esquema de comisiones${code ? ` (${code})` : ""}.`);
} finally { await client.end().catch(() => undefined); }
