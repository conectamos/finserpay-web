import pg from "pg";
import { installApprovalSharedSchema } from "./approval-shared-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no esta configurada para acceso compartido de aprobaciones.");
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  application_name: "finserpay-approval-shared-schema",
});
try {
  await client.connect();
  await installApprovalSharedSchema(client);
  console.log("Esquema de acceso compartido de aprobaciones preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de acceso compartido de aprobaciones" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
