import assert from "node:assert/strict";
import test from "node:test";
import {
  creditApprovalCallSchemaStatements,
  installCreditApprovalCallSchema,
} from "../scripts/credit-approval-call-schema.mjs";

const constraintName = "CreditApprovalCallRecording_file_check";
const migration = creditApprovalCallSchemaStatements.find(statement =>
  statement.includes(constraintName) && statement.includes("pg_get_constraintdef"));

test("call schema adds or upgrades the MIME CHECK only on its expected table", () => {
  assert.ok(migration);
  assert.match(migration, /WHERE conname='CreditApprovalCallRecording_file_check' AND conrelid='public."CreditApprovalCallRecording"'::regclass AND contype='c'/);
  assert.match(migration, /"mimeType" IN \('audio\/mpeg','audio\/mp4','audio\/ogg','audio\/wav'\)/);
  assert.match(migration, /IF current_definition IS NULL THEN[\s\S]*ADD CONSTRAINT "CreditApprovalCallRecording_file_check"/);
  assert.match(migration, /ELSIF POSITION\('audio\/ogg' IN LOWER\(current_definition\)\)=0 THEN[\s\S]*DROP CONSTRAINT "CreditApprovalCallRecording_file_check";[\s\S]*ADD CONSTRAINT "CreditApprovalCallRecording_file_check"/);
  assert.equal(migration.match(/DROP CONSTRAINT/g)?.length, 1);
});

test("call schema executes the MIME upgrade inside its installer transaction", async () => {
  const queries = [];
  await installCreditApprovalCallSchema({ query: async statement => { queries.push(statement); } });
  assert.equal(queries[0], "BEGIN");
  assert.ok(queries.indexOf(migration) > queries.indexOf("BEGIN"));
  assert.equal(queries.at(-1), "COMMIT");
  assert.equal(queries.includes("ROLLBACK"), false);
});

test("call schema rolls back if the MIME upgrade cannot be completed", async () => {
  const queries = [];
  const failure = new Error("synthetic migration failure");
  await assert.rejects(installCreditApprovalCallSchema({
    query: async statement => {
      queries.push(statement);
      if (statement === migration) throw failure;
    },
  }), failure);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.includes("COMMIT"), false);
});

test("call continuity is append-only, bound to novelty events and used by the approval gate", () => {
  const schema = creditApprovalCallSchemaStatements.join("\n");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\."CreditApprovalCallContinuation"/);
  for (const foreignKey of [
    /FOREIGN KEY \("creditoId"\) REFERENCES public\."Credito"\("id"\) ON DELETE RESTRICT/,
    /FOREIGN KEY \("recordingId"\) REFERENCES public\."CreditApprovalCallRecording"\("id"\) ON DELETE RESTRICT/,
    /FOREIGN KEY \("noveltyId"\) REFERENCES public\."CreditApprovalNovelty"\("id"\) ON DELETE RESTRICT/,
    /FOREIGN KEY \("noveltyEventId"\) REFERENCES public\."CreditApprovalNoveltyEvent"\("id"\) ON DELETE RESTRICT/,
  ]) assert.match(schema, foreignKey);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalCallContinuation_noveltyEvent_key"/);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalCallContinuation_target_key"/);
  assert.match(schema, /CreditApprovalCallContinuation_immutable[\s\S]*BEFORE UPDATE OR DELETE/);
  assert.match(schema, /CreditApprovalCallContinuation_no_truncate[\s\S]*BEFORE TRUNCATE/);
  assert.match(schema, /credit_approval_call_continuation_insert[\s\S]*CALL_CONTINUATION_SOURCE_INVALID/);
  assert.match(schema, /event_type NOT IN \('REPORTED','GENERAL_RESPONDED','PHOTO_RESPONDED'\)/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION public\.credit_approval_effective_call_recording/);
  assert.match(schema, /FROM public\."CreditApprovalEvent" approval_event[\s\S]*JOIN public\."CreditApprovalCallRecording" recording ON recording\."id"=approval_event\."callRecordingId"[\s\S]*approval_event\."eventType"='APPROVED'[\s\S]*approval_event\."revision"=target_revision[\s\S]*approval_event\."reviewHash"=target_review_hash/);
  assert.ok((schema.match(/credit_approval_effective_call_recording\(/g) || []).length >= 3,
    "la lectura, la continuidad y el OK comparten el resolvedor canónico");
  assert.match(schema, /NEW\."callRecordingId"<>latest_id/);
});

test("call schema only exempts a verified active FINSERPAY administrator from audio", () => {
  const schema = creditApprovalCallSchemaStatements.join("\n");
  assert.match(schema, /CREATE OR REPLACE FUNCTION public\.credit_approval_actor_can_skip_call_recording\([\s\S]*RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE/);
  assert.match(schema, /FROM public\."Usuario" account[\s\S]*JOIN public\."Rol" user_role ON user_role\."id"=account\."rolId"[\s\S]*JOIN public\."Sede" site ON site\."id"=account\."sedeId"[\s\S]*JOIN public\."Aliado" ally ON ally\."id"=site\."aliadoId"/);
  for (const requirement of [
    /actor_kind IS DISTINCT FROM 'USER'/,
    /account\."activo" IS TRUE/,
    /site\."activa" IS TRUE/,
    /ally\."activo" IS TRUE/,
    /UPPER\(BTRIM\(user_role\."nombre"\)\)='ADMIN'/,
    /UPPER\(BTRIM\(ally\."codigo"\)\)='FINSERPAY'/,
    /FOR SHARE OF account,user_role,site,ally/,
  ]) assert.match(schema, requirement);
  assert.match(schema, /credit_approval_effective_call_recording\([\s\S]*IF latest_id IS NOT NULL THEN[\s\S]*NEW\."callRecordingId" IS NULL OR NEW\."callRecordingId"<>latest_id/);
  assert.match(schema, /ELSIF NEW\."callRecordingId" IS NOT NULL[\s\S]*credit_approval_actor_can_skip_call_recording\([\s\S]*NEW\."approvedByKind",NEW\."approvedByUserId"/);
  assert.match(schema, /current_review\."callRecordingId" IS NOT NULL[\s\S]*credit_approval_actor_can_skip_call_recording\([\s\S]*current_review\."approvedByKind",current_review\."approvedByUserId"/);
  assert.match(schema, /SELECT \* INTO current_review FROM public\."CreditApprovalReview"[\s\S]*"reviewHash"=NEW\."reviewHash" FOR SHARE;/);
  assert.match(schema, /ROW\(NEW\."actorKind",NEW\."actorUserId",NEW\."actorName",NEW\."actorGrantId",NEW\."actorSessionId"\) IS DISTINCT FROM[\s\S]*ROW\(current_review\."approvedByKind",current_review\."approvedByUserId",current_review\."approvedByName"/);
  assert.match(schema, /ELSIF current_review\."callRecordingId" IS DISTINCT FROM NEW\."callRecordingId"/);
});
