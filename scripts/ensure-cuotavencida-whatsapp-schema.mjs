import pg from "pg";
import { installCuotaVencidaWhatsAppSchema } from "./cuotavencida-whatsapp-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para Cuotavencida.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000,
  application_name: "finserpay-cuotavencida-whatsapp-schema" });
try {
  await client.connect();
  await installCuotaVencidaWhatsAppSchema(client);
  console.log("Esquema de Cuotavencida por WhatsApp preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de Cuotavencida" + (code ? " (" + code + ")" : "") + ".");
} finally { await client.end().catch(() => undefined); }
