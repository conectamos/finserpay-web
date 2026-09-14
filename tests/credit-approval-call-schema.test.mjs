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
