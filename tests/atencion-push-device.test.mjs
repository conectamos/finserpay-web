import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../lib/atencion-push-device.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
runInNewContext(source, {
  exports: mod.exports, module: mod, Date,
  process: { env: { NODE_ENV: "production" } },
  require: name => { assert.ok(["server-only", "next/headers"].includes(name)); return {}; },
});
const { ATTENTION_PUSH_DEVICE_COOKIE, revokeAttentionPushDeviceWith } = mod.exports;
const id = "12345678-1234-4234-8234-123456789abc";

function fixture(value) {
  const clears = [], queries = [];
  return {
    clears, queries,
    jar: { get: name => { assert.equal(name, ATTENTION_PUSH_DEVICE_COOKIE); return value ? { value } : undefined; }, set: (...args) => clears.push(args) },
    database: async () => ({ $queryRawUnsafe: async (...args) => { queries.push(args); return [{ id }]; } }),
  };
}

test("revoca sólo el dispositivo de la cookie opaca y elimina su permiso local", async () => {
  const f = fixture(id);
  await revokeAttentionPushDeviceWith(f.jar, f.database);
  assert.equal(f.queries.length, 1);
  assert.equal(f.queries[0][0], 'DELETE FROM "AttentionPushSubscription" WHERE id=$1::uuid RETURNING id');
  assert.equal(f.queries[0][1], id);
  assert.equal(f.clears.length, 1);
  assert.equal(f.clears[0][0], ATTENTION_PUSH_DEVICE_COOKIE);
  assert.equal(f.clears[0][1], "");
  assert.equal(f.clears[0][2].maxAge, 0);
  assert.equal(f.clears[0][2].path, "/");
  assert.equal(f.clears[0][2].httpOnly, true);
  assert.equal(f.clears[0][2].secure, true);
  assert.equal(f.clears[0][2].sameSite, "strict");
});

test("cookie ausente o manipulada no realiza consultas ni revoca otras suscripciones", async () => {
  for (const value of [undefined, "not-an-id", "'; DELETE FROM x;--", id + "suffix"]) {
    const f = fixture(value);
    await revokeAttentionPushDeviceWith(f.jar, async () => { assert.fail("No database for invalid cookie"); });
    assert.equal(f.queries.length, 0);
    assert.equal(f.clears.length, 1);
  }
});

test("un fallo del almacén de push permite cerrar sesión y expira la cookie", async () => {
  const f = fixture(id);
  await revokeAttentionPushDeviceWith(f.jar, async () => { throw new Error("synthetic outage"); });
  assert.equal(f.clears.length, 1);
  assert.equal(f.clears[0][2].maxAge, 0);
});
