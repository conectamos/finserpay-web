import pg from "pg";
import { installCreditApprovalCallSchema } from "./credit-approval-call-schema.mjs";
const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para la grabación de aprobaciones.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000, application_name: "finserpay-approval-call-schema" });
try {
  await client.connect(); await installCreditApprovalCallSchema(client);
  console.log("Grabación de aprobaciones preparada; decisiones anteriores conservadas.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar la grabación de aprobaciones" + (code ? " (" + code + ")" : "") + ".");
} finally { await client.end().catch(() => undefined); }
