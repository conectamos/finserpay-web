import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { creditWelcomeVoiceSchemaStatements } from "../scripts/credit-welcome-voice-schema.mjs";
const campaignPolicy = loadReissueModule("lib/credit-voice-review-campaign-core.ts");

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
    "@/lib/credit-welcome-voice-speech": {},
    "@/lib/credit-welcome-voice-document": {},
    "@/lib/credit-welcome-voice-followup-core": loadReissueModule("lib/credit-welcome-voice-followup-core.ts"),
    "@/lib/credit-voice-review-campaign-core": campaignPolicy,
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
test("additive recovery schema upgrades existing events twice without resetting identity or completed history", async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE TABLE "Credito" ("id" integer PRIMARY KEY); INSERT INTO "Credito" VALUES(1)');
  for (const statement of creditWelcomeVoiceSchemaStatements) {
    const oldCreate = statement.startsWith('CREATE TABLE IF NOT EXISTS public."CreditWelcomeVoiceEvent"');
    if (!oldCreate && statement.includes('identityRecovery')) continue;
    await db.exec(oldCreate ? statement.replace(/^\s*"identityRecovery"[^\n]*\n/m, "") : statement);
  }
  const id = "11111111-1111-4111-8111-111111111111", verifiedAt = "2026-10-08T15:00:00.000Z";
  await db.query(`INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","status","snapshot","identityAttempts","identityVerifiedAt","providerCallId","resultHash")
    VALUES($1,1,'NORMAL','COMPLETED',$2::jsonb,2,$3,'call-historical',$4)`, [id, JSON.stringify({ name: "synthetic", document: "00123456" }), verifiedAt, "a".repeat(64)]);
  await db.query(`INSERT INTO "VoiceReviewCampaign" ("id","startDate","creditIds") VALUES ('audited-window','2026-10-09','[1]'::jsonb)`);
  await db.query(`INSERT INTO "VoiceReviewCampaignManualWindow" ("campaignId","slot","startsAt","expiresAt","createdAt","reason")
    VALUES ('audited-window','2026-10-09T12:05','2026-10-09T17:05:30Z','2026-10-09T17:15:30Z','2026-10-09T17:05:30Z','OPERATOR_AUTHORIZED_PENDING_CALLS')`);
  for (let replay = 0; replay < 2; replay++) for (const statement of creditWelcomeVoiceSchemaStatements) await db.exec(statement);
  const row = (await db.query('SELECT * FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1', [id])).rows[0];
  assert.equal(row.status, "COMPLETED"); assert.equal(row.identityAttempts, 2); assert.deepEqual(row.identityRecovery, {});
  assert.equal(new Date(row.identityVerifiedAt).toISOString(), verifiedAt); assert.equal(row.resultHash, "a".repeat(64));
  assert.equal(row.providerCallId, "call-historical"); assert.deepEqual(row.snapshot, { name: "synthetic", document: "00123456" });
  const audit = (await db.query('SELECT * FROM "VoiceReviewCampaignManualWindow"')).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].campaignId, "audited-window"); assert.equal(audit[0].slot, "2026-10-09T12:05");
  assert.equal(audit[0].reason, "OPERATOR_AUTHORIZED_PENDING_CALLS");
  assert.equal(new Date(audit[0].expiresAt).toISOString(), "2026-10-09T17:15:30.000Z");
  await assert.rejects(db.query('UPDATE "CreditWelcomeVoiceEvent" SET "identityRecovery"=\'[]\'::jsonb WHERE "id"=$1', [id]), error => error.code === "23514");
  const flags = { askedName: true, askedDocument: false, reviewRequired: false };
  await db.query('UPDATE "CreditWelcomeVoiceEvent" SET "identityRecovery"=$2::jsonb WHERE "id"=$1', [id, JSON.stringify(flags)]);
  for (const statement of creditWelcomeVoiceSchemaStatements) await db.exec(statement);
  assert.deepEqual((await db.query('SELECT "identityRecovery" FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1', [id])).rows[0].identityRecovery, flags);
});
