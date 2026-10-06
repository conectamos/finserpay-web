import pg from "pg";
import { installApprovalAnalystAccountAuditSchema } from "./approval-analyst-account-audit-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para la auditoría de cuentas de analistas.");

const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10000,
  application_name: "finserpay-approval-analyst-account-audit-schema",
});

try {
  await client.connect();
  await installApprovalAnalystAccountAuditSchema(client);
  console.log("Auditoría de cuentas de analistas preparada.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar la auditoría de cuentas de analistas" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
