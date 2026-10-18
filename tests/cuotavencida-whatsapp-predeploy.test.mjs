import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installCommissionSchema } from "../scripts/commissions-schema-install.mjs";

const sql = "BEGIN; SELECT 1; COMMIT;";
const failure = code => Object.assign(new Error("Synthetic installation failure"), { code });
const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");

function fixture(errors = [], { rollbackFailure, rollbackCommand = "ROLLBACK", random = () => 0 } = {}) {
  const calls = [];
  let attempts = 0;
  const client = { query: async query => {
    calls.push(query);
    if (query === "ROLLBACK") {
      if (rollbackFailure) throw rollbackFailure;
      return { command: rollbackCommand };
    }
    assert.equal(query, sql, "The caller's BEGIN/COMMIT block must not be split or changed");
    const error = errors[attempts++];
    if (error) throw error;
    return { command: "COMMIT" };
  } };
  return { calls, run: () => installCommissionSchema(client, sql, {
    sleep: async milliseconds => { calls.push({ sleep: milliseconds }); }, random,
  }), get attempts() { return attempts; } };
}

test("successful commission installation runs the complete transaction exactly once", async () => {
  const f = fixture();
  assert.equal(await f.run(), undefined);
  assert.deepEqual(f.calls, [sql]);
  assert.equal(f.attempts, 1);
});

test("deadlock and NOWAIT conflicts rollback before each bounded jittered retry", async () => {
  const samples = [0, 0.5];
  const f = fixture([failure("40P01"), failure("55P03")], { random: () => samples.shift() });
  await f.run();
  assert.deepEqual(f.calls, [sql, "ROLLBACK", { sleep: 250 }, sql, "ROLLBACK", { sleep: 625 }, sql]);
  assert.equal(f.attempts, 3);
});

test("the sixth lock conflict is rolled back and rethrows the original final error without another wait", async () => {
  const errors = Array.from({ length: 6 }, (_, index) => failure(index % 2 ? "55P03" : "40P01"));
  const f = fixture(errors, { random: () => 0.999 });
  await assert.rejects(f.run(), error => error === errors[5]);
  assert.equal(f.attempts, 6);
  assert.equal(f.calls.filter(call => call === "ROLLBACK").length, 6);
  assert.deepEqual(f.calls.filter(call => typeof call === "object").map(call => call.sleep), [499, 749, 999, 1249, 1499]);
  assert.equal(f.calls.at(-1), "ROLLBACK");
});

test("syntax, constraints, network and unclassified failures never retry even if rollback succeeds", async () => {
  for (const code of ["42601", "23505", "ECONNRESET", "ETIMEDOUT", undefined, "40p01"]) {
    const original = failure(code);
    const f = fixture([original]);
    await assert.rejects(f.run(), error => error === original);
    assert.deepEqual(f.calls, [sql, "ROLLBACK"]);
  }
});

test("a rejected or unconfirmed rollback aborts with the installation error and never retries", async () => {
  for (const options of [{ rollbackFailure: failure("ECONNRESET") }, { rollbackCommand: "COMMIT" }, { rollbackCommand: undefined }]) {
    const original = failure("40P01");
    // The last case intentionally returns no acknowledgement instead of the fixture default.
    const f = fixture([original], options.rollbackCommand === undefined && !options.rollbackFailure
      ? { rollbackCommand: null } : options);
    await assert.rejects(f.run(), error => error === original);
    assert.deepEqual(f.calls, [sql, "ROLLBACK"]);
  }
});

test("a retry cannot start while the rollback acknowledgement is still pending", async () => {
  const calls = [];
  let finishRollback, attempts = 0;
  const original = failure("55P03");
  const running = installCommissionSchema({ query: async query => {
    calls.push(query);
    if (query === "ROLLBACK") return new Promise(resolve => { finishRollback = resolve; });
    if (attempts++ === 0) throw original;
    return { command: "COMMIT" };
  } }, sql, { sleep: async delay => { calls.push({ sleep: delay }); }, random: () => 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [sql, "ROLLBACK"]);
  finishRollback({ command: "ROLLBACK" });
  await running;
  assert.deepEqual(calls, [sql, "ROLLBACK", { sleep: 250 }, sql]);
});

test("the commission installer uses the retry helper packaged into the final runtime image", () => {
  const installer = read("scripts/ensure-commissions-schema.mjs");
  assert.match(installer, /from\s+["']\.\/commissions-schema-install\.mjs["']/);
  assert.match(installer, /await\s+installCommissionSchema\s*\(/);
  const dockerfile = read("Dockerfile");
  const runner = dockerfile.slice(dockerfile.lastIndexOf(" AS runner"));
  for (const file of ["ensure-commissions-schema.mjs", "commissions-schema-install.mjs", "setup-commissions.sql"]) {
    assert.ok(runner.includes(`/app/scripts/${file}`), `${file} must be in the final runtime image`);
  }
});

test("transactional NOWAIT prelocks precede commission DDL and cover every existing journal table", () => {
  const source = read("scripts/setup-commissions.sql");
  const firstDDL = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|INDEX|TRIGGER)|ALTER\s+TABLE|DROP\s+)/i.exec(source);
  assert.ok(firstDDL, "Expected commission schema DDL");
  const beforeDDL = source.slice(0, firstDDL.index);
  assert.match(beforeDDL, /\bBEGIN\s*;/i);
  const creditLock = /LOCK\s+TABLE\s+(?:public\.)?"Credito"\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE\s+NOWAIT/i.exec(beforeDDL);
  assert.ok(creditLock, "Credit lock must be acquired without waiting before touching commission DDL");
  const block = beforeDDL.slice(creditLock.index + creditLock[0].length);
  assert.match(block, /\bDO\s+\$(?:[a-z_][a-z0-9_]*)?\$/i);
  assert.match(block, /to_regclass/i);
  assert.match(block, /ACCESS\s+EXCLUSIVE\s+MODE\s+NOWAIT/i);
  for (const table of ["CommissionPeriod", "CommissionRequest", "CommissionPayment", "CommissionAudit", "CommissionCreditSource"]) {
    assert.ok(block.includes(table), `${table} must be guarded before DDL`);
  }
  assert.doesNotMatch(beforeDDL, /\b(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i);
  assert.match(source, /\bCOMMIT\s*;\s*$/i);
});
