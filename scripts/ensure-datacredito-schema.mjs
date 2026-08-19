import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para preparar el esquema DataCredito."
  );
}

const client = new Client({
  application_name: "finserpay-datacredito-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

try {
  const setupSql = await readFile(
    new URL("./setup-datacredito.sql", import.meta.url),
    "utf8"
  );

  await client.connect();
  await client.query("SET lock_timeout = '10s'");
  await client.query("SET statement_timeout = '120s'");
  await client.query(setupSql);
  console.log("Esquema DataCredito preparado correctamente.");
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24)
      : "";
  throw new Error(
    `No se pudo preparar el esquema DataCredito${code ? ` (${code})` : ""}.`
  );
} finally {
  await client.end().catch(() => undefined);
}
