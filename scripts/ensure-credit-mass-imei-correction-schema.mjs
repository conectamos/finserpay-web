import pg from "pg";
import { installCreditMassImeiCorrectionSchema } from "./credit-mass-imei-correction-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) {
  throw new Error("DATABASE_URL no está configurada para correcciones de IMEI masivo.");
}
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  application_name: "finserpay-credit-mass-imei-correction-schema",
});
try {
  await client.connect();
  await installCreditMassImeiCorrectionSchema(client);
  console.log("Esquema de correcciones de IMEI masivo preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de correcciones de IMEI masivo" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
