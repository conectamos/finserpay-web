import pg from "pg";
import { installCreditApprovalNoveltiesSchema } from "./credit-approval-novelties-schema.mjs";
const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para novedades.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000, application_name: "finserpay-approval-novelties-schema" });
try {
  await client.connect();
  await installCreditApprovalNoveltiesSchema(client);
  console.log("Esquema de novedades preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de novedades" + (code ? " (" + code + ")" : "") + ".");
} finally { await client.end().catch(() => undefined); }
