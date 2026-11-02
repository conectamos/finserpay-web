import pg from "pg";
import { pathToFileURL } from "node:url";
import { dianaExtensionRequestSchemaCheckSql, installDianaExtensionRequestSchema } from "./diana-extension-request-schema.mjs";

export async function ensureDianaExtensionRequestSchema({ apply }) {
  if (typeof apply !== "boolean") throw new Error("Indica si la preparación del esquema está autorizada.");
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL no está configurada para las prórrogas directas de Diana.");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query("SET lock_timeout='10s'");
    await client.query("SET statement_timeout='120s'");
    if (apply) await installDianaExtensionRequestSchema(client);
    const { rows: [schema] } = await client.query(dianaExtensionRequestSchemaCheckSql());
    return { ready: schema?.ready === true };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes("--apply"), check = process.argv.includes("--check");
  if (apply === check) throw new Error("Indica exactamente --check (solo lectura) o --apply (preparar esquema).");
  const schema = await ensureDianaExtensionRequestSchema({ apply });
  console.log(JSON.stringify({ operation: apply ? "schema-prepared" : "schema-check", ...schema, automationActivated: false }));
  if (!schema.ready) process.exitCode = 2;
}
