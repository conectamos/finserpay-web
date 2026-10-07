import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { creditOverdueDataSchemaStatements } from "../scripts/credit-overdue-data-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const policy = await jiti.import("../lib/credit-overdue-data-policy.ts");
const dates = await jiti.import("../lib/colombia-date.ts");

export const sampleOverdueDataCredit = (id = 1, overrides = {}) => ({
  id, clienteNombre: "CLIENTE PRUEBA", clienteTelefono: "3000000001", estado: "INSCRITO",
  pazYSalvoEmitidoAt: null, montoCredito: 300, valorCuota: 100, plazoMeses: 3, frecuenciaPago: "CATORCENAL",
  fechaPrimerPago: "2026-09-17", fechaProximoPago: null, abonos: [], ...overrides,
});

export function overdueDataRecipientKey(phone = "573000000001") {
  return createHash("sha256").update("finserpay-datos:" + phone).digest("hex");
}

export async function overdueDataFixture(t, options = {}) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "data" JSONB NOT NULL)');
  for (const statement of creditOverdueDataSchemaStatements) await database.exec(statement);
  for (const credit of options.credits || [sampleOverdueDataCredit()]) {
    await database.query('INSERT INTO "Credito" ("id","data") VALUES ($1,$2::jsonb)', [credit.id, JSON.stringify(credit)]);
  }
  const counts = { reads: 0, writes: 0, pages: 0, sends: 0, transactions: 0 };
  const payloads = [];
  const webhooks = [];
  const requests = [];
  let clock = new Date(options.now || "2026-10-07T15:00:00.000Z");
  let failTransactionOnce = Boolean(options.failTransactionOnce);
  let failFinalizeOnce = Boolean(options.failFinalizeOnce);
  let afterClaimRead = false;
  const setClock = value => { clock = new Date(value); };
  const updateCredit = async (id, overrides) => database.query(
    'UPDATE "Credito" SET "data"="data" || $2::jsonb WHERE "id"=$1', [id, JSON.stringify(overrides)],
  );
  const hookArguments = () => ({ database, setClock, updateCredit });

  function adapter(connection, inTransaction = false, transactionState = {}) {
    return {
      $queryRawUnsafe: async (sql, ...values) => {
        if (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) counts.writes += 1;
        const result = await connection.query(sql, values);
        if (/INSERT INTO "CreditOverdueDataAttempt"/.test(sql) && result.rows.length) transactionState.createdClaim = true;
        if (!inTransaction && /^\s*SELECT\b[\s\S]*"claimExpiresAt"[\s\S]*FROM "CreditOverdueDataAttempt"/.test(sql)) {
          await options.afterActiveClaim?.(hookArguments());
        }
        return result.rows;
      },
      $executeRawUnsafe: async (sql, ...values) => {
        counts.writes += 1;
        if (failFinalizeOnce && /UPDATE "CreditOverdueDataAttempt" SET "status"=\$2/.test(sql)) {
          failFinalizeOnce = false;
          await connection.query("SELECT 'injected finalize failure'::integer");
        }
        return (await connection.query(sql, values)).affectedRows;
      },
      credito: {
        findMany: async input => {
          counts.pages += 1;
          assert.deepEqual(JSON.parse(JSON.stringify(input.where)), { id: { gt: input.where.id.gt } });
          assert.deepEqual(JSON.parse(JSON.stringify(input.orderBy)), { id: "asc" });
          assert.equal(input.take, 250);
          assert.equal(input.select.abonos.where.estado.not, "ANULADO");
          const rows = (await connection.query('SELECT "data" FROM "Credito" WHERE "id">$1 ORDER BY "id" LIMIT $2',
            [input.where.id.gt, input.take])).rows.map(row => row.data);
          await options.afterScanPage?.({ ...hookArguments(), input, rows });
          return rows;
        },
        findUnique: async input => {
          counts.reads += 1;
          if (!inTransaction && afterClaimRead) {
            afterClaimRead = false;
            await options.afterClaim?.(hookArguments());
          }
          return (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [input.where.id])).rows[0]?.data || null;
        },
      },
    };
  }

  const client = {
    ...adapter(database),
    $transaction: async work => {
      const transactionState = {};
      const result = await database.transaction(async connection => {
        counts.transactions += 1;
        const outcome = await work(adapter(connection, true, transactionState));
        if (failTransactionOnce) {
          failTransactionOnce = false;
          // A real PostgreSQL error proves the claim and cooldown both roll back.
          await connection.query("SELECT 'injected transaction failure'::integer");
        }
        return outcome;
      });
      if (transactionState.createdClaim) {
        afterClaimRead = true;
        await options.afterClaimTransaction?.(hookArguments());
      }
      return result;
    },
  };
  const core = loadReissueModule("lib/credit-overdue-data-campaign.ts", {
    "@/lib/prisma": { default: client },
    "@/lib/colombia-date": dates,
    "@/lib/credit-overdue-data-policy": policy,
  }, { AbortSignal, Error, process: { env: options.env || {} }, fetch: () => assert.fail("Unexpected real network") });
  const runnerDependencies = {
    database: client, now: () => new Date(clock),
    ...(!options.useEnvironmentConfig ? {
      enabled: () => options.enabled !== false,
      webhookUrl: () => options.url ?? "https://api.dapta.ai/api/test-only-datos",
    } : {}),
    fetcher: async (url, request) => {
      counts.sends += 1;
      webhooks.push(String(url));
      payloads.push(JSON.parse(request.body));
      requests.push(request);
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "error");
      assert.equal(request.cache, "no-store");
      assert.ok(request.signal instanceof AbortSignal);
      await options.onFetch?.({ ...hookArguments(), url, request });
      if (options.providerError) throw new Error("private phone 573000000001/provider credential must stay private");
      return new Response(options.rawResponse ?? JSON.stringify(options.response ?? { ok: true }), {
        status: options.status || 200, headers: { "Content-Type": "application/json" },
      });
    },
  };
  const run = core.createCreditOverdueDataRunner(runnerDependencies);
  const rows = async () => (await database.query('SELECT * FROM "CreditOverdueDataAttempt" ORDER BY "campaignDate","creditoId"')).rows;
  const recipients = async () => (await database.query('SELECT * FROM "CreditOverdueDataRecipient" ORDER BY "recipientKey"')).rows;
  const seedClaim = async (overrides = {}) => {
    const seed = { id: randomUUID(), recipientKey: overdueDataRecipientKey(), creditoId: 1, campaignDate: "2026-10-07",
      daysPastDue: 20, status: "CLAIMED", claimedAt: "2026-10-07T15:00:00Z", claimExpiresAt: "2026-10-07T15:01:30Z",
      nextEligibleDate: "2026-10-10", ...overrides };
    await database.query('INSERT INTO "CreditOverdueDataRecipient" ("recipientKey","nextEligibleDate") VALUES ($1,$2::date)',
      [seed.recipientKey, seed.nextEligibleDate]);
    await database.query(`INSERT INTO "CreditOverdueDataAttempt"
      ("id","recipientKey","creditoId","campaignDate","daysPastDue","status","claimedAt","claimExpiresAt")
      VALUES ($1::uuid,$2,$3,$4::date,$5,$6,$7,$8)`,
      [seed.id, seed.recipientKey, seed.creditoId, seed.campaignDate, seed.daysPastDue, seed.status, seed.claimedAt, seed.claimExpiresAt]);
    return seed;
  };
  return { run, core, database, client, counts, rows, recipients, payloads, webhooks, requests, setClock, updateCredit, seedClaim,
    restart: () => core.createCreditOverdueDataRunner(runnerDependencies) };
}
