import pg from "pg";
import { installAdminSessionSchema } from "./admin-session-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para preparar las sesiones administrativas.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, application_name: "finserpay-admin-session-schema" });
// Connection errors may include connection details; keep deployment logs generic.
client.on("error", () => console.error("Se interrumpió la conexión de preparación de sesiones administrativas."));
try {
  await client.connect();
  await installAdminSessionSchema(client);
  console.log("Sesiones administrativas preparadas correctamente.");
} catch {
  throw new Error("No se pudo preparar el esquema de sesiones administrativas.");
} finally {
  await client.end().catch(() => undefined);
}
