import pg from "pg";
import { installAnalystMoraSchema } from "./analyst-mora-schema.mjs";
const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para gestión de mora.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
try { await client.connect(); await installAnalystMoraSchema(client); console.log("Gestión de mora preparada."); }
finally { await client.end(); }
