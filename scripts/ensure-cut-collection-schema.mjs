import { readFile } from "node:fs/promises";
import pg from "pg";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para preparar recaudo por corte.");
const client = new pg.Client({ connectionString, application_name: "finserpay-cut-collection-schema", connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query("SET lock_timeout = '10s'");
  await client.query("SET statement_timeout = '120s'");
  await client.query(await readFile(new URL("./setup-cut-collection.sql", import.meta.url), "utf8"));
  console.log("Esquema de recaudo por corte preparado correctamente.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error(`No se pudo preparar recaudo por corte${code ? ` (${code})` : ""}.`);
} finally { await client.end().catch(() => undefined); }
