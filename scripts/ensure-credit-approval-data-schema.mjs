import pg from "pg";
import { installCreditApprovalDataSchema } from "./credit-approval-data-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para correcciones de aprobación.");
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  application_name: "finserpay-credit-approval-data-schema",
});
try {
  await client.connect();
  await installCreditApprovalDataSchema(client);
  console.log("Esquema de correcciones auditadas de aprobación preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de correcciones de aprobación" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
