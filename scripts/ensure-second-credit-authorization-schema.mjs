import pg from "pg";
import { secondCreditAuthorizationSchemaStatements } from "./second-credit-authorization-schema.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para preparar autorizaciones de segundo crédito.");
const client = new pg.Client({ connectionString, application_name: "finserpay-second-credit-authorization-schema", connectionTimeoutMillis: 10000 });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-second-credit-authorization-schema'))");
  for (const statement of secondCreditAuthorizationSchemaStatements) await client.query(statement);
  await client.query("COMMIT");
  console.log("Esquema de autorizaciones de segundo crédito verificado; no se habilitaron cédulas.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}