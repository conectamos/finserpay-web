import assert from "node:assert/strict";
import test from "node:test";
import {
  creditApprovalNoveltiesSchemaStatements,
  installCreditApprovalNoveltiesSchema,
} from "../scripts/credit-approval-novelties-schema.mjs";

const upgrades = [
  {
    table: "CreditApprovalNoveltyItem",
    name: "CreditApprovalNoveltyItem_state_check",
    marker: "verified",
    fragments: ["'OPEN','RESPONDED','VERIFIED'", '"version">0'],
  },
  {
    table: "CreditApprovalNoveltyItem",
    name: "CreditApprovalNoveltyItem_response_check",
    marker: "verified",
    fragments: [
      '"status"=\'VERIFIED\'',
      '"respondedAt" IS NOT NULL',
      '"responseText" IS NOT NULL',
      '"responsePhotoHash" ~ \'^[a-f0-9]{64}$\'',
    ],
  },
  {
    table: "CreditApprovalNoveltyEvent",
    name: "CreditApprovalNoveltyEvent_type_check",
    marker: "analyst_verified",
    fragments: ["'ANALYST_VERIFIED'", "'APPROVED_RESOLVED'"],
  },
];

test("novelty schema upgrades every extensible CHECK on an existing installation", () => {
  for (const expected of upgrades) {
    const migration = creditApprovalNoveltiesSchemaStatements.find(statement =>
      statement.includes(expected.name) && statement.includes("pg_get_constraintdef"));
    assert.ok(migration, expected.name);
    assert.ok(migration.includes(
      "WHERE conname='" + expected.name + "' AND conrelid='public.\"" +
      expected.table + "\"'::regclass AND contype='c'"));
    assert.ok(migration.includes(
      "POSITION('" + expected.marker + "' IN LOWER(current_definition))=0"));
    assert.equal((migration.match(/DROP CONSTRAINT/g) || []).length, 1);
    assert.equal((migration.match(/ADD CONSTRAINT/g) || []).length, 2);
    for (const fragment of expected.fragments) assert.ok(migration.includes(fragment), fragment);
  }
});

test("VERIFIED requires a note and a current photo hash, while GENERAL remains hashless", () => {
  const responseCheck = creditApprovalNoveltiesSchemaStatements.find(statement => statement.includes("CreditApprovalNoveltyItem_response_check"));
  assert.ok(responseCheck);
  const verifiedLimits = [...responseCheck.matchAll(/OR \("status"='VERIFIED'[\s\S]*?LENGTH\(BTRIM\("responseText"\)\) BETWEEN 5 AND (\d+)/g)]
    .map(match => match[1]);
  assert.deepEqual(verifiedLimits, ["1000", "1000"]);
  assert.match(responseCheck, /"key"='GENERAL' AND "responsePhotoHash" IS NULL/);
  assert.match(responseCheck, /"key"<>'GENERAL' AND "responsePhotoHash" IS NOT NULL AND "responsePhotoHash" ~ '\^\[a-f0-9\]\{64\}\$'/);
});

test("item transitions retain reopening and derive the case status from remaining OPEN items", () => {
  const schema = creditApprovalNoveltiesSchemaStatements.join("\n");
  assert.match(schema, /OLD\."status"='OPEN' AND NEW\."status" IN \('OPEN','RESPONDED','VERIFIED'\)/);
  assert.match(schema, /OLD\."status" IN \('RESPONDED','VERIFIED'\) AND NEW\."status"='OPEN'/);
  assert.match(schema, /CASE WHEN EXISTS \([\s\S]*"status"='OPEN'\) THEN 'WAITING_ALLY' ELSE 'RESPONDED' END/);
  assert.match(schema, /NEW\."status"='RESOLVED' AND OLD\."status"<>'RESPONDED'/);
});

test("novelty installer runs all CHECK upgrades in one transaction", async () => {
  const queries = [];
  await installCreditApprovalNoveltiesSchema({
    query: async statement => { queries.push(statement); },
  });
  assert.equal(queries[0], "BEGIN");
  for (const expected of upgrades) {
    const migration = creditApprovalNoveltiesSchemaStatements.find(statement =>
      statement.includes(expected.name) && statement.includes("pg_get_constraintdef"));
    assert.ok(queries.indexOf(migration) > queries.indexOf("BEGIN"));
  }
  assert.equal(queries.at(-1), "COMMIT");
});
