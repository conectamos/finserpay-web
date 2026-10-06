import pg from "pg";
import { installMoraExceptionRequestSchema } from "./mora-exception-requests-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para excepciones de mora.");
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await installMoraExceptionRequestSchema(client);
  console.log("Excepciones de mora preparadas.");
} finally {
  await client.end();
}
