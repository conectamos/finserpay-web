import pg from "pg";
import { creditApprovalDocumentRefreshSchemaStatements } from "./credit-approval-document-refresh-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para la consulta de documentos de aprobaciones.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000,
  application_name: "finserpay-approval-document-refresh-schema" });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-approval-document-refresh-schema'))");
  for (const sql of creditApprovalDocumentRefreshSchemaStatements()) await client.query(sql);
  await client.query("COMMIT");
  console.log("Auditoría de consulta de documentos de aprobaciones preparada.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar la auditoría de documentos de aprobaciones" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
