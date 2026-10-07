import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { creditDueReminderSchemaStatements } from "../scripts/credit-due-reminders-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const policy = await jiti.import("../lib/credit-due-reminder-policy.ts");
const dates = await jiti.import("../lib/colombia-date.ts");
const welcome = await jiti.import("../lib/dapta-welcome.ts");
export const sampleCredit = (id = 1, overrides = {}) => ({
  id, clienteNombre: "CLIENTE PRUEBA", clienteTelefono: "3000000001", estado: "INSCRITO",
  montoCredito: 300, valorCuota: 100, plazoMeses: 3, frecuenciaPago: "MENSUAL",
  fechaPrimerPago: "2026-10-08", fechaProximoPago: "2026-10-08", abonos: [],
  ...overrides,
});

export async function reminderFixture(t, options = {}) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "data" JSONB NOT NULL)');
  for (const sql of creditDueReminderSchemaStatements) await database.exec(sql);
  const credits = options.credits || [sampleCredit()];
  for (const credit of credits) await database.query('INSERT INTO "Credito" ("id","data") VALUES ($1,$2::jsonb)', [credit.id, JSON.stringify(credit)]);
  const counts = { reads: 0, writes: 0, pages: 0, sends: 0, transactions: 0 };
  let failTransactionOnce = Boolean(options.failTransactionOnce);
  let afterClaimRead = false;
  let clock = new Date(options.now || "2026-10-07T15:00:00Z");
  const payloads = [];
  function adapter(connection, inTransaction = false) {
    return {
      $queryRawUnsafe: async (sql, ...values) => {
        if (/INSERT|UPDATE|DELETE/.test(sql)) counts.writes += 1;
        const result = await connection.query(sql, values);
        if (/INSERT INTO "CreditDueReminder"/.test(sql) && result.rows.length) afterClaimRead = true;
        if (/SELECT "id","claimExpiresAt" FROM "CreditDueReminder"/.test(sql)) {
          await options.afterActiveClaim?.({ database, setClock: value => { clock = new Date(value); } });
        }
        return result.rows;
      },
      $executeRawUnsafe: async (sql, ...values) => {
        counts.writes += 1;
        return (await connection.query(sql, values)).affectedRows;
      },
      credito: {
        findMany: async (input) => {
          counts.pages += 1;
          assert.deepEqual(JSON.parse(JSON.stringify(input.where)), { id: { gt: input.where.id.gt } });
          const rows = (await connection.query('SELECT "data" FROM "Credito" WHERE "id">$1 ORDER BY "id" LIMIT $2', [input.where.id.gt, input.take])).rows;
          return rows.map(row => row.data);
        },
        findUnique: async (input) => {
          counts.reads += 1;
          if (!inTransaction && afterClaimRead) {
            afterClaimRead = false;
            await options.afterClaim?.({ database, setClock: value => { clock = new Date(value); } });
          }
          return (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [input.where.id])).rows[0]?.data || null;
        },
      },
    };
  }
  const client = {
    ...adapter(database),
    $transaction: (work) => database.transaction(async connection => {
      counts.transactions += 1;
      const result = await work(adapter(connection, true));
      if (failTransactionOnce) {
        failTransactionOnce = false;
        // An actual PostgreSQL error aborts and rolls back the claim transaction.
        await connection.query("SELECT 'injected transaction failure'::integer");
      }
      return result;
    }),
  };
  const core = loadReissueModule("lib/credit-due-reminders.ts", {
    "@/lib/prisma": { default: client },
    "@/lib/colombia-date": dates,
    "@/lib/dapta-welcome": welcome,
    "@/lib/credit-due-reminder-policy": policy,
  }, { AbortSignal, fetch: () => assert.fail("Unexpected real network"), Error });
  const run = core.createCreditDueReminderRunner({
    database: client, now: () => new Date(clock),
    enabled: () => options.enabled !== false,
    webhookUrl: () => options.url || "https://api.dapta.ai/api/test-only-webhook",
    fetcher: async (_url, request) => {
      counts.sends += 1;
      payloads.push(JSON.parse(request.body));
      assert.equal(request.redirect, "error");
      assert.equal(request.cache, "no-store");
      if (options.providerError) throw new Error("private provider/phone/credential must stay private");
      return new Response(options.rawResponse ?? JSON.stringify(options.response ?? { ok: true }), {
        status: options.status || 200, headers: { "Content-Type": "application/json" },
      });
    },
  });
  const rows = async () => (await database.query('SELECT * FROM "CreditDueReminder" ORDER BY "creditoId"')).rows;
  return { run, database, client, counts, rows, core, payloads,
    setClock: value => { clock = new Date(value); },
    updateCredit: async (id, overrides) => database.query('UPDATE "Credito" SET "data"="data" || $2::jsonb WHERE "id"=$1', [id, JSON.stringify(overrides)]),
  };
}
