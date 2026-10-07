import pg from "pg";
import { installCreditDueReminderSchema } from "./credit-due-reminders-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para recordatorios de cuota.");
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  application_name: "finserpay-credit-due-reminder-schema",
});
try {
  await client.connect();
  await installCreditDueReminderSchema(client);
  console.log("Esquema de recordatorios de cuota preparado.");
} catch (error) {
  const code = String(error?.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24);
  throw new Error("No se pudo preparar el esquema de recordatorios de cuota" + (code ? " (" + code + ")" : "") + ".");
} finally {
  await client.end().catch(() => undefined);
}
