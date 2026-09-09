import pg from "pg";
import { installApprovalEvidenceSchema } from "./approval-evidence-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para el historial de fotografías.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, application_name: "finserpay-approval-evidence-schema" });
try {
  await client.connect();
  await installApprovalEvidenceSchema(client);
  console.log("Historial de fotografías preparado; sin cambios en evidencias existentes.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el historial de fotografías" + (code ? ` (${code})` : "") + ".");
} finally { await client.end().catch(() => undefined); }
