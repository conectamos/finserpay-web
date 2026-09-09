import pg from "pg";
import { installCreditApprovalSchema } from "./credit-approval-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no esta configurada para aprobaciones de analistas.");
const client = new pg.Client({
  connectionString, connectionTimeoutMillis: 10_000,
  application_name: "finserpay-credit-approval-schema",
});
try {
  await client.connect();
  await installCreditApprovalSchema(client);
  console.log("Esquema de aprobaciones de analistas preparado; corte de activacion conservado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de aprobaciones de analistas" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
