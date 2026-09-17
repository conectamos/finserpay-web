import pg from "pg";
import { installCreditSadminSchema } from "./credit-sadmin-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para SADMIN.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000, application_name: "finserpay-credit-sadmin-schema" });
try {
  await client.connect();
  await installCreditSadminSchema(client);
  console.log("Esquema de seguimiento SADMIN preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de seguimiento SADMIN" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
