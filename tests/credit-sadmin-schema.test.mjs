import assert from "node:assert/strict";
import test from "node:test";
import { creditSadminSchemaStatements, installCreditSadminSchema } from "../scripts/credit-sadmin-schema.mjs";

test("SADMIN installer executes the entire schema under a transaction and advisory lock", async () => {
  const queries = [];
  await installCreditSadminSchema({ query: async statement => { queries.push(statement); } });
  assert.equal(queries[0], "BEGIN");
  assert.match(queries[3], /pg_advisory_xact_lock/);
  assert.deepEqual(queries.slice(4, -1), creditSadminSchemaStatements);
  assert.equal(queries.at(-1), "COMMIT");
});

test("SADMIN installer rolls back every partial schema change on error", async () => {
  const queries = [];
  const failure = new Error("synthetic migration failure");
  await assert.rejects(installCreditSadminSchema({ query: async statement => {
    queries.push(statement);
    if (statement === creditSadminSchemaStatements[4]) throw failure;
  } }), failure);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.includes("COMMIT"), false);
});
