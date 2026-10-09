import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { creditWelcomeVoiceSchemaStatements } from "../scripts/credit-welcome-voice-schema.mjs";

function fixture({ failFirstLock = false } = {}) {
  const events = [];
  let transactions = 0;
  let firstLock = true;
  const database = {
    $queryRawUnsafe: () => assert.fail("The schema must not query outside its transaction"),
    $executeRawUnsafe: () => assert.fail("The schema must not execute DDL outside its transaction"),
    $transaction: async (callback, options) => {
      transactions++;
      assert.equal(options.timeout, 30_000);
      events.push("BEGIN");
      let locked = false;
      const executed = [];
      const transaction = {
        $queryRawUnsafe: async sql => {
          assert.match(sql, /pg_advisory_xact_lock\(hashtext\('finserpay-credit-welcome-voice-schema'\)\)/);
          // Prisma adapter-pg cannot deserialize PostgreSQL's void result column.
          // This fake adapter reproduces that restriction instead of accepting any SQL.
          if (!/::text\s*$/i.test(sql)) {
            throw Object.assign(new Error("Failed to deserialize void column"), { code: "P2010" });
          }
          if (failFirstLock && firstLock) {
            firstLock = false;
            throw Object.assign(new Error("Synthetic lock timeout"), { code: "55P03" });
          }
          locked = true;
          events.push("LOCK");
          return [{ pg_advisory_xact_lock: "" }];
        },
        $executeRawUnsafe: async sql => {
          if (sql === "SET LOCAL lock_timeout='10s'") {
            assert.equal(locked, false);
            events.push("TIMEOUT");
            return 0;
          }
          assert.equal(locked, true, "Every schema statement must be protected by the transaction-scoped lock");
          assert.equal(sql, creditWelcomeVoiceSchemaStatements[executed.length]);
          executed.push(sql);
          events.push("DDL");
          return 0;
        },
      };
      try {
        const result = await callback(transaction);
        assert.deepEqual(executed, creditWelcomeVoiceSchemaStatements);
        events.push("COMMIT");
        return result;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      } finally {
        locked = false;
      }
    },
  };
  const store = loadReissueModule("lib/credit-welcome-voice-store.ts", {
    "@/lib/prisma": { default: database }, "@/lib/credit-payment-plan": {},
    "@/lib/credit-factory-snapshot": {}, "@/lib/cartera-export": {}, "@/lib/dapta-welcome": {},
    "@/lib/credit-welcome-voice-core": {},
    "@/scripts/credit-welcome-voice-schema.mjs": { creditWelcomeVoiceSchemaStatements },
  });
  return { store, events, transactions: () => transactions };
}

test("schema lock returns Prisma-compatible text and protects all DDL in one shared transaction", async () => {
  const f = fixture();
  await Promise.all([1, 2, 3].map(() => f.store.ensureCreditWelcomeVoiceSchema()));
  assert.equal(f.transactions(), 1);
  assert.deepEqual(f.events, ["BEGIN", "TIMEOUT", "LOCK", ...creditWelcomeVoiceSchemaStatements.map(() => "DDL"), "COMMIT"]);
  await f.store.ensureCreditWelcomeVoiceSchema();
  assert.equal(f.transactions(), 1, "A successfully committed schema is reused");
});

test("a failed schema lock executes no DDL and clears the cached attempt for safe retry", async () => {
  const f = fixture({ failFirstLock: true });
  const attempts = await Promise.allSettled([f.store.ensureCreditWelcomeVoiceSchema(), f.store.ensureCreditWelcomeVoiceSchema()]);
  assert.equal(attempts.every(result => result.status === "rejected" && result.reason.code === "55P03"), true);
  assert.equal(f.transactions(), 1);
  assert.deepEqual(f.events, ["BEGIN", "TIMEOUT", "ROLLBACK"]);
  await f.store.ensureCreditWelcomeVoiceSchema();
  assert.equal(f.transactions(), 2);
  assert.deepEqual(f.events.slice(3), ["BEGIN", "TIMEOUT", "LOCK", ...creditWelcomeVoiceSchemaStatements.map(() => "DDL"), "COMMIT"]);
});
