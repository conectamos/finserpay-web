import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { assertDataCreditoBranchAllocation } from "../lib/datacredito/branch-quota-allocation.ts";

test("moving and reactivating a branch cannot overallocate the ally's query budget", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "Aliado" (id INTEGER PRIMARY KEY, "dataCreditoBranchQuotaEnabled" BOOLEAN, "dataCreditoDailyQueryLimit" INTEGER);
      CREATE TABLE "Sede" (id INTEGER PRIMARY KEY, "aliadoId" INTEGER, activa BOOLEAN, "dataCreditoDailyQueryLimit" INTEGER);
      INSERT INTO "Aliado" VALUES (1, true, 10), (2, true, 8), (3, false, NULL);
      INSERT INTO "Sede" VALUES (11, 1, true, 6), (12, 1, false, 5), (21, 2, true, 4);`);
    const adapter = { $queryRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).rows };
    async function check(branchId, expectedAllyId, targetAllyId, activating) {
      await db.exec("BEGIN");
      try { return await assertDataCreditoBranchAllocation({ database: adapter, branchId, expectedAllyId, targetAllyId, activating }); }
      finally { await db.exec("ROLLBACK"); }
    }
    await assert.rejects(check(12, 1, 1, true), /excedería el total/);
    await assert.rejects(check(11, 1, 2), /excedería el total/);
    await assert.rejects(check(11, 2, 2), /cambió de aliado/);
    await check(11, 1, 1);
    await check(11, 1, 3);
    await db.exec('UPDATE "Aliado" SET "dataCreditoDailyQueryLimit" = 11 WHERE id = 1');
    await check(12, 1, 1, true);
    assert.deepEqual((await db.query('SELECT "dataCreditoDailyQueryLimit" AS quota FROM "Sede" ORDER BY id')).rows,
      [{ quota: 6 }, { quota: 5 }, { quota: 4 }], "El guard conserva los cupos y nunca los resetea automáticamente");
  } finally { await db.close(); }
});
