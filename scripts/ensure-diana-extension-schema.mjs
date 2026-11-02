import pg from "pg";
import { dianaExtensionSchemaCheckSql, installDianaExtensionSchema } from "./diana-extension-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para prórrogas de Diana.");
const apply = process.argv.includes("--apply"), check = process.argv.includes("--check");
if (apply === check) throw new Error("Indica exactamente --check (solo lectura) o --apply (preparar esquema).");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  if (apply) await installDianaExtensionSchema(client);
  const { rows: [schema] } = await client.query(dianaExtensionSchemaCheckSql());
  console.log(JSON.stringify({ operation: apply ? "schema-prepared" : "schema-check", ...schema, automationActivated: false }));
  if (schema.ready !== true) process.exitCode = 2;
} finally {
  await client.end();
}
