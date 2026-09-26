import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const consumers = [
  "app/api/clientes/creditos/route.ts",
  "app/api/clientes/wompi-checkout/route.ts",
  "app/api/creditos/route.ts",
  "app/api/creditos/push-manual/route.ts",
  "app/api/integraciones/creditos/imei/route.ts",
  "app/api/dashboard/cartera/export/route.ts",
  "app/dashboard/cartera/page.tsx",
  "app/dashboard/reportes/page.tsx",
  "app/dashboard/_lib/admin-dashboard-data.ts",
  "lib/credit-mora-sync.ts",
  "lib/credit-push-reminders.ts",
  "lib/credit-sadmin.ts",
  "lib/device-unlock-queue.ts",
  "lib/efecty-recaudos.ts",
  "lib/wompi-payment-processing.ts",
  "app/api/creditos/[id]/abonos/route.ts",
  "app/api/creditos/[id]/plan-pagos/route.ts",
  "app/api/creditos/[id]/abonos/[abonoId]/recibo/route.ts",
];

function inspect(file, callback) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    callback(node, ast, source);
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

for (const file of consumers) {
  test(`${file}: forwards the current principal plan from the same credit`, () => {
    let calls = 0;
    inspect(file, (node, ast) => {
      if (!ts.isCallExpression(node)) return;
      if (!["buildCreditPaymentPlan", "calculateCreditEarlyPayoff"].includes(node.expression.getText(ast))) return;
      calls++;
      const input = node.arguments[0];
      assert.ok(ts.isObjectLiteralExpression(input));
      const amount = input.properties.find((property) => property.name?.getText(ast) === "montoCredito");
      const credit = amount?.getText(ast).match(/([A-Za-z]+)\.montoCredito/)?.[1];
      assert.ok(credit, "source credit must be identifiable");
      const plan = input.properties.find((property) => property.name?.getText(ast) === "planCapitalVigente");
      assert.ok(plan, "missing current principal plan");
      assert.equal(plan.initializer.getText(ast), `${credit}.planCapitalVigente`);
    });
    assert.ok(calls > 0);
  });

  test(`${file}: explicit financial selects load the current principal plan`, () => {
    inspect(file, (node, ast) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const amount = node.properties.find((property) => property.name?.getText(ast) === "montoCredito");
      if (!amount || amount.initializer?.kind !== ts.SyntaxKind.TrueKeyword) return;
      const plan = node.properties.find((property) => property.name?.getText(ast) === "planCapitalVigente");
      assert.equal(plan?.initializer?.kind, ts.SyntaxKind.TrueKeyword);
    });
  });
}

test("SADMIN SQL reads the current principal plan with its credit row", () => {
  const source = fs.readFileSync(path.join(root, "lib/credit-sadmin.ts"), "utf8");
  assert.match(source, /credit\."planCapitalVigente"/);
});

test("payment processors evaluate revised amounts using locked credit state", () => {
  for (const file of ["lib/wompi-payment-processing.ts", "lib/efecty-recaudos.ts", "app/api/creditos/[id]/abonos/route.ts", "app/api/clientes/wompi-checkout/route.ts"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /FOR UPDATE/);
    assert.match(source, /planCapitalVigente: lockedCredit\.planCapitalVigente/);
  }
});

test("Wompi repair sends a revised principal ledger to review without removing a cut payment", async () => {
  const file = "lib/wompi-payment-processing.ts";
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "repairProcessedWompiEarlyPayoffIntent");
  assert.ok(fn);
  const code = ts.transpileModule(fn.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const revised of [false, true]) {
    let calculations = 0;
    let locks = 0;
    let writes = 0;
    const tx = {
      $queryRaw: async () => { locks++; return [{ id: 7 }]; },
      wompiPaymentIntent: { findUnique: async () => ({ id: 1, creditoId: 7, processedAbonoId: 3, status: "APPROVED", reference: "PAYOFF-QA" }) },
      credito: {
        findUnique: async () => ({ montoCredito: 1000000, planCapitalVigente: revised ? { version: "CAPITAL_REDUCCION_PLAZO_V1" } : null }),
        update: async () => { writes++; throw new Error("unexpected write"); },
      },
      creditoAbono: { findMany: async () => [{ id: 3, valor: 500000, fechaAbono: new Date("2026-09-26T12:00:00Z") }] },
    };
    const mod = { exports: {} };
    vm.runInNewContext(code, { module: mod, exports: mod.exports,
      ensureCreditAbonoAuditColumns: async () => {}, ensureDeviceUnlockCommandTable: async () => {},
      prisma: { $transaction: (run) => run(tx) }, isWompiEarlyPayoffIntent: () => true,
      wasWompiPayoffFinalized: () => false,
      calculateCreditEarlyPayoff: () => { calculations++; return { eligible: false, reason: "LEGACY_REASON" }; },
    });
    const result = await mod.exports.repairProcessedWompiEarlyPayoffIntent(1);
    assert.equal(result.action, "REVIEW_REQUIRED");
    assert.equal(result.reason, revised ? "PRINCIPAL_PLAN_REQUIRES_RECONCILIATION" : "LEGACY_REASON");
    assert.equal(calculations, revised ? 0 : 1);
    assert.equal(locks, 2);
    assert.equal(writes, 0);
  }
});
