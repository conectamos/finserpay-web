import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}) {
  const loadedModule = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { module: loadedModule, exports: loadedModule.exports, Map, Set, require(name) {
    if (name === "server-only") return {};
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return loadedModule.exports;
}
const pure = load("lib/credit-display-number.ts");
const server = load("lib/credit-display-number-server.ts", {
  "@/lib/prisma": { default: {} }, "@/lib/credit-display-number": pure,
});
const clone = value => JSON.parse(JSON.stringify(value));

test("only a confirmed SADMIN number replaces the visible number, preserving leading zeros", () => {
  const saved = { numeroCredito: " 000145-A ", numeroCreditoConfirmado: false };
  assert.equal(pure.confirmedSadminNumber(saved), null);
  assert.equal(pure.confirmedSadminNumber({ ...saved, numeroCreditoConfirmado: true }), "000145-A");
  assert.equal(pure.confirmedSadminNumber({ numeroCredito: " ", numeroCreditoConfirmado: true }), null);
  assert.equal(pure.creditDisplayNumber({ folio: "FC-ORIGINAL" }), "FC-ORIGINAL");
  assert.equal(pure.creditDisplayNumber({ folio: "FC-ORIGINAL", numeroCreditoVisible: "000145-A" }), "000145-A");
});

test("batch lookup stays within selected credit IDs, deduplicates and preserves each original folio", async () => {
  const calls = [];
  const database = { creditSadminRegistration: { findMany: async query => {
    calls.push(clone(query));
    return [{ creditoId: 712, numeroCredito: "000145-A", numeroCreditoConfirmado: true },
      { creditoId: 713, numeroCredito: "UNCONFIRMED", numeroCreditoConfirmado: false }];
  } } };
  const numbers = await server.getCreditDisplayNumbers([712, 713, 712, 0, -1, NaN], database);
  assert.deepEqual(calls[0].where.creditoId.in, [712, 713]);
  assert.equal(calls[0].where.numeroCreditoConfirmado, true);
  assert.equal(numbers.get(712), "000145-A");
  assert.equal(numbers.has(713), false);
  const original = Object.freeze({ id: 712, folio: "FC-CONTRACT", processUuid: "SIGNED-PROCESS" });
  const visible = server.withCreditDisplayNumber(original, numbers);
  assert.equal(visible.numeroCreditoVisible, "000145-A");
  assert.equal(visible.folio, "FC-CONTRACT");
  assert.equal(visible.processUuid, "SIGNED-PROCESS");
  assert.equal(original.numeroCreditoVisible, undefined);
});

test("large exports use bounded batches and empty selections do not query", async () => {
  const batches = [];
  const db = { creditSadminRegistration: { findMany: async input => { batches.push(input.where.creditoId.in); return []; } } };
  await server.getCreditDisplayNumbers([], db);
  assert.equal(batches.length, 0);
  await server.getCreditDisplayNumbers(Array.from({ length: 4001 }, (_, index) => index + 1), db);
  assert.deepEqual(batches.map(items => items.length), [2000, 2000, 1]);
});

test("search preserves the original folio and adds only confirmed SADMIN numbers", () => {
  const where = clone(server.creditNumberSearchWhere("000145-A"));
  assert.equal(where.OR[0].folio.contains, "000145-A");
  assert.equal(where.OR[1].registroSadmin.is.numeroCreditoConfirmado, true);
  assert.equal(where.OR[1].registroSadmin.is.numeroCredito.contains, "000145-A");
});

test("storage failure is propagated instead of showing an incorrect number silently", async () => {
  await assert.rejects(server.getCreditDisplayNumbers([712], { creditSadminRegistration: {
    findMany: async () => { throw new Error("database unavailable"); },
  } }), /database unavailable/);
});

test("settlement presentation only decorates credits already authorized without changing stored folios or payment data", async () => {
  const calls = [];
  const database = { creditSadminRegistration: { findMany: async query => {
    calls.push(clone(query));
    return [{ creditoId: 31, numeroCredito: "000031-A", numeroCreditoConfirmado: true }];
  } } };
  const helpers = load("lib/credit-display-number-server.ts", {
    "@/lib/prisma": { default: database }, "@/lib/credit-display-number": pure,
  });
  const settlements = [{
    id: 7, totalPagar: 200000, numeroAprobacionBancaria: "BANCO-QA",
    items: [{ creditoId: 31, folio: "FC-ORIGINAL-31", valorPagar: 200000 }],
    recaudos: [{ creditoId: 31, folio: "FC-ORIGINAL-31", valor: 50000 }, { creditoId: 32, folio: "FC-ORIGINAL-32", valor: 30000 }],
  }];
  const original = structuredClone(settlements);
  const decorated = await helpers.withSettlementDisplayNumbers(settlements);
  assert.deepEqual(calls[0].where.creditoId.in, [31, 32]);
  assert.equal(decorated[0].items[0].numeroCreditoVisible, "000031-A");
  assert.equal(decorated[0].items[0].folio, "FC-ORIGINAL-31");
  assert.equal(decorated[0].recaudos[0].numeroCreditoVisible, "000031-A");
  assert.equal(decorated[0].recaudos[1].numeroCreditoVisible, "FC-ORIGINAL-32");
  assert.equal(decorated[0].totalPagar, 200000);
  assert.equal(decorated[0].numeroAprobacionBancaria, "BANCO-QA");
  assert.deepEqual(settlements, original);
});
