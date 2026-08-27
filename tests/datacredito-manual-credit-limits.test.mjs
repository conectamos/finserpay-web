import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("manual limits persist only document HMAC and masked suffix", async () => {
  const sql = await source("scripts/setup-datacredito.sql");
  const table = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS "DataCreditoManualCreditLimit"'),
    sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoManualCreditLimit_document_key"')
  );

  assert.match(table, /"documentHash" CHAR\(64\) NOT NULL/);
  assert.match(table, /"documentLast4" VARCHAR\(4\) NOT NULL/);
  assert.doesNotMatch(table, /"documentNumber"|"cedula"/i);
  assert.match(table, /"maxFinancedAmount" BETWEEN 1 AND 100000000/);
  assert.match(table, /LENGTH\(BTRIM\("reason"\)\) BETWEEN 5 AND 240/);
  assert.match(table, /"version" >= 1/);
});

test("manual limits have immutable audit, idempotency and no physical delete", async () => {
  const sql = await source("scripts/setup-datacredito.sql");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS "DataCreditoManualCreditLimitAudit"/);
  assert.match(sql, /"mutationId" UUID NOT NULL/);
  assert.match(sql, /"requestHash" CHAR\(64\) NOT NULL/);
  assert.match(sql, /DataCreditoManualCreditLimitAudit_mutation_key/);
  assert.match(sql, /DataCreditoManualCreditLimitAudit_immutable/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON "DataCreditoManualCreditLimitAudit"/);
  assert.match(sql, /DataCreditoManualCreditLimit_no_delete/);
  assert.match(sql, /BEFORE DELETE ON "DataCreditoManualCreditLimit"/);
  assert.match(sql, /REFERENCES "Usuario" \("id"\) ON DELETE RESTRICT/);
});

test("storage hashes exact documents and never exposes the hash in public rows", async () => {
  const storage = await source("lib/datacredito/manual-credit-limits.ts");

  assert.match(storage, /hmacDataCreditoValue\("document", documentNumber\)/);
  assert.match(storage, /export async function getActiveDataCreditoManualCreditLimit/);
  assert.match(storage, /export async function resolveDataCreditoManualCreditLimit/);
  assert.match(storage, /source: manualLimit \? \("MANUAL_DOCUMENT" as const\)/);
  assert.match(storage, /policyMaxFinancedAmount,/);
  assert.match(storage, /manualLimit,/);
  assert.match(storage, /pg_advisory_xact_lock/);
  const lockHelpers = storage.slice(
    storage.indexOf("async function lockMutation"),
    storage.indexOf("async function findMutationReplay")
  );
  assert.equal(
    (
      lockHelpers.match(
        /transaction\.\$executeRawUnsafe\(\s*`SELECT pg_advisory_xact_lock/g
      ) || []
    ).length,
    2
  );
  assert.doesNotMatch(lockHelpers, /\$queryRawUnsafe/);
  assert.match(storage, /expectedVersion/);
  assert.match(storage, /findMutationReplay/);
  assert.match(storage, /DataCreditoManualCreditLimitAudit/);

  const publicType = storage.slice(
    storage.indexOf("export type DataCreditoManualCreditLimit ="),
    storage.indexOf("export type DataCreditoManualCreditLimitStatus")
  );
  assert.doesNotMatch(publicType, /documentHash|documentNumber/);
  assert.match(publicType, /documentLast4/);
});

test("central admin API is private, versioned and has no DELETE handler", async () => {
  const route = await source(
    "app/api/creditos/datacredito/cupos-manuales/route.ts"
  );

  assert.match(route, /getDataCreditoCentralAdmin\(\)/g);
  assert.match(route, /Cache-Control": "private, no-store, max-age=0"/);
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.match(route, /url\.searchParams\.get\("estado"\)/);
  assert.doesNotMatch(route, /searchParams\.get\("document/);
  assert.match(route, /export async function POST\(request: Request\)/);
  assert.match(route, /export async function PATCH\(request: Request\)/);
  assert.match(route, /expectedVersion: body\.expectedVersion/);
  assert.match(route, /mutationId: body\.mutationId/);
  assert.doesNotMatch(route, /export async function DELETE/);
});

test("exact document search uses authenticated POST so the cedula is absent from URLs", async () => {
  const route = await source(
    "app/api/creditos/datacredito/cupos-manuales/buscar/route.ts"
  );

  assert.match(route, /export async function POST\(request: Request\)/);
  assert.match(route, /getDataCreditoCentralAdmin\(\)/);
  assert.match(route, /documentNumber: body\.documentNumber/);
  assert.match(route, /Cache-Control": "private, no-store, max-age=0"/);
  assert.doesNotMatch(route, /export async function GET|searchParams/);
  assert.match(route, /\{ ok: true, items, correlationId \}/);
});
