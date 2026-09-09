import pg from "pg";
import { installApprovalAccessSchema } from "./approval-access-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no esta configurada para enlaces personales de analistas.");
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  application_name: "finserpay-approval-access-schema",
});
try {
  await client.connect();
  await installApprovalAccessSchema(client);
  console.log("Esquema de enlaces personales de analistas preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de enlaces personales de analistas" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
