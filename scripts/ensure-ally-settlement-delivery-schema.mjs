import pg from "pg";
import { allySettlementDeliverySchemaStatements } from "./ally-settlement-delivery-schema.mjs";
if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL para preparar envíos de liquidaciones.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query("BEGIN");
  for (const statement of allySettlementDeliverySchemaStatements) await client.query(statement);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally { await client.end(); }
