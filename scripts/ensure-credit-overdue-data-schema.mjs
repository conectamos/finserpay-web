import pg from "pg";
import { installCreditOverdueDataSchema } from "./credit-overdue-data-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para la campaña Datos.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000,
  application_name: "finserpay-credit-overdue-data-schema" });
try {
  await client.connect();
  await installCreditOverdueDataSchema(client);
  console.log("Esquema de campaña Datos preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de campaña Datos" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
