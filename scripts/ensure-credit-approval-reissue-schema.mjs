import pg from "pg";
import { installCreditApprovalReissueSchema } from "./credit-approval-reissue-schema.mjs";
const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para reemisión documental.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000, application_name: "finserpay-approval-reissue-schema" });
try {
  await client.connect();
  await installCreditApprovalReissueSchema(client);
  console.log("Esquema de reemisión documental preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0,24);
  throw new Error("No se pudo preparar el esquema de reemisión documental" + (code ? " (" + code + ")" : "") + ".");
} finally { await client.end().catch(() => undefined); }
