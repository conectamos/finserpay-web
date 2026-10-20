import pg from "pg";
import { installCreditWelcomeVoiceSchema } from "./credit-welcome-voice-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para las llamadas de bienvenida.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000,
  application_name: "finserpay-credit-welcome-voice-schema" });
try {
  await client.connect();
  const summary = await installCreditWelcomeVoiceSchema(client);
  console.log("Esquema de llamadas de bienvenida preparado. Política de una llamada automática:", summary);
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de llamadas de bienvenida" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
