import pg from "pg";
import { installCreditPrincipalPaymentSchema } from "./credit-principal-payment-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para abonos a capital.");
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  application_name: "finserpay-credit-principal-payment-schema",
});
try {
  await client.connect();
  await installCreditPrincipalPaymentSchema(client);
  console.log("Esquema de abonos extraordinarios a capital preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de abonos a capital" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
