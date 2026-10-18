import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadSync({ exceptionAppears = false, exceptionSequence = null, unlockError = null, lockedForTheft = false, latestOverrides = {} } = {}) {
  const source = readFileSync(new URL("../lib/credit-mora-sync.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  const calls = { order: [], locks: 0, unlocks: 0, updates: [], planInputs: [] };
  let exceptionReads = 0;
  let latestCredit;
  const update = async ({ data }) => {
    calls.updates.push(data.bloqueoMora);
    return { estado: data.estado, equalityState: data.equalityState || null, equalityService: data.equalityService || null, bloqueoMora: data.bloqueoMora, bloqueoMoraAt: data.bloqueoMoraAt || null };
  };
  const tx = {
    credito: { update, findUnique: async () => latestCredit },
    $queryRawUnsafe: async (sql) => {
      assert.match(sql, /FROM "Credito"[\s\S]*FOR UPDATE/);
      calls.order.push("credit-lock");
      return [{ id: 41, bloqueoRobo: lockedForTheft }];
    },
  };
  const prisma = {
    credito: { update },
    $transaction: async (callback) => callback(tx),
  };
  const dependencies = {
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: input => { calls.planInputs.push(input); return ({ estadoPago: input.abonos.some(payment => payment.valor >= 100) ? "PAGADO" : "MORA", saldoPendiente: 100, overdueCount: 1, nextInstallment: { fechaVencimiento: "2026-10-02" }, installments: [] }); } },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/equality-device-meta": { getEqualityDeviceMeta: () => ({ deliveryStatus: null, deviceState: null, serviceDetails: null }), getPayloadSummary: () => ({}) },
    "@/lib/equality-zero-touch": {
      isEqualityApiError: () => false,
      isEqualityConfigured: () => true,
      lockEqualityDevice: async () => { calls.order.push("remote-lock"); calls.locks += 1; return { ok: true }; },
      queryEqualityDevices: async () => null,
      unlockEqualityDevice: async () => { calls.order.push("remote-unlock"); calls.unlocks += 1; if (unlockError) throw unlockError; return { ok: true }; },
    },
    "@/lib/credit-factory": { resolveCreditState: () => "INSCRITO", sanitizeText: (value) => String(value || "") },
    "@/lib/credit-lock-message": { buildMoraLockMessage: () => "Pago vencido" },
    "@/lib/credit-import-flags": { isMassImportedCredit: () => false },
    "@/lib/mora-block-exemptions": {
      getActiveMoraBlockExemptionDocuments: async () => new Set(),
      isMoraBlockExempt: async () => false,
      normalizeMoraExemptionDocument: (value) => value,
    },
    "@/lib/mora-exception-requests": {
      getActiveMoraExceptionByCreditId: async () => null,
      getActiveMoraExceptionsByCreditIds: async () => new Map(),
    },
    "@/lib/mora-block-protection": {
      ensureMoraBlockProtectionTables: async () => {},
      hasActiveMoraBlockProtection: async (_id, _document, database) => {
        assert.ok(database === tx || database === undefined);
        calls.order.push(database ? "protection-under-lock" : "protection-now");
        return exceptionSequence ? exceptionSequence[Math.min(exceptionReads++, exceptionSequence.length - 1)] : exceptionAppears;
      },
    },
    "@/lib/prisma": { default: prisma },
  };
  runInNewContext(outputText, {
    exports: loaded.exports,
    module: loaded,
    require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
    Date,
    AbortSignal,
    JSON,
    Set,
  }, { filename: "lib/credit-mora-sync.ts" });
  return { sync: (value, options) => {
    latestCredit = { ...value, ...latestOverrides, bloqueoRobo: lockedForTheft || value.bloqueoRobo };
    return loaded.exports.syncCreditMora(value, options);
  }, calls };
}

function credit() {
  return {
    id: 41,
    folio: "F-41",
    clienteNombre: "Cliente",
    clienteDocumento: "123456",
    clienteTelefono: "3000000000",
    imei: "IMEI-41",
    deviceUid: "DEVICE-41",
    montoCredito: 100,
    planCapitalVigente: null,
    valorCuota: 100,
    plazoMeses: 1,
    frecuenciaPago: "MENSUAL",
    fechaPrimerPago: new Date("2026-10-02T00:00:00.000Z"),
    fechaProximoPago: new Date("2026-10-02T00:00:00.000Z"),
    estado: "INSCRITO",
    deliverableLabel: null,
    deliverableReady: true,
    equalityState: null,
    equalityService: null,
    equalityPayload: null,
    equalityLastCheckAt: null,
    bloqueoRobo: false,
    bloqueoRoboAt: null,
    bloqueoMora: false,
    bloqueoMoraAt: null,
    pazYSalvoEmitidoAt: null,
    observacionAdmin: null,
    sede: { id: 1, nombre: "Central" },
    abonos: [],
  };
}

test("snapshot antiguo del cron no bloquea un crédito con excepción vigente", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: true });
  const result = await sync(credit(), { exemptCreditIds: new Set() });
  assert.equal(calls.locks, 0);
  assert.equal(calls.unlocks, 0);
  assert.equal(result.action, "SKIPPED");
});

test("aprobación entre snapshot y comando se revalida bajo lock sin enviar bloqueo", async () => {
  const { sync, calls } = loadSync({ exceptionSequence: [false, true, true, true] });
  const result = await sync(credit(), { exemptCreditIds: new Set() });
  assert.deepEqual(calls.order, ["protection-now", "credit-lock", "protection-under-lock", "protection-now", "credit-lock", "protection-under-lock", "remote-unlock"]);
  assert.equal(calls.locks, 0);
  assert.equal(calls.unlocks, 1);
  assert.deepEqual(calls.updates, [false]);
  assert.equal(result.action, "UNLOCKED");
});

test("sin protección vigente conserva las reglas normales del cron", async () => {
  const { sync, calls } = loadSync();
  const result = await sync(credit(), { exemptCreditIds: new Set() });
  assert.deepEqual(calls.order, ["protection-now", "credit-lock", "protection-under-lock", "remote-lock"]);
  assert.equal(calls.locks, 1);
  assert.deepEqual(calls.updates, [true]);
  assert.equal(result.action, "LOCKED");
});

test("cache de excepción vencida no autoriza desbloqueo ni omite la mora normal", async () => {
  const { sync, calls } = loadSync();
  const result = await sync(credit(), { exemptCreditIds: new Set([41]), exemptDocuments: new Set(["123456"]), forceRemoteAudit: true });
  assert.equal(calls.unlocks, 0);
  assert.equal(calls.locks, 1);
  assert.equal(result.action, "LOCKED");
});

test("excepción o prórroga vigente retira únicamente bloqueo por mora bajo lock", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: true });
  const result = await sync({ ...credit(), bloqueoMora: true }, { forceRemoteAudit: true, preventNewMoraBlock: true });
  assert.deepEqual(calls.order, ["protection-now", "credit-lock", "protection-under-lock", "remote-unlock"]);
  assert.equal(calls.unlocks, 1);
  assert.equal(calls.locks, 0);
  assert.deepEqual(calls.updates, [false]);
  assert.equal(result.action, "UNLOCKED");
});

test("revocación antes de adquirir lock impide un desbloqueo sin autorización", async () => {
  const { sync, calls } = loadSync({ exceptionSequence: [true, false, false] });
  const result = await sync({ ...credit(), bloqueoMora: true }, { forceRemoteAudit: true, preventNewMoraBlock: true });
  assert.equal(calls.unlocks, 0);
  assert.equal(calls.locks, 0);
  assert.deepEqual(calls.updates, []);
  assert.equal(result.action, "SKIPPED");
});

for (const action of ["aprobar", "editar", "cancelar"]) {
  test(`${action} una excepción nunca envía un bloqueo, incluso sin acuerdo vigente`, async () => {
    const { sync, calls } = loadSync();
    const result = await sync(credit(), { forceRemoteAudit: true, preventNewMoraBlock: true });
    assert.equal(result.action, "SKIPPED");
    assert.equal(calls.locks, 0);
    assert.equal(calls.unlocks, 0);
    assert.deepEqual(calls.updates, []);
  });
}

test("bloqueo por robo confirmado durante la carrera no se retira por un acuerdo", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: true, lockedForTheft: true });
  const result = await sync({ ...credit(), bloqueoMora: true }, { forceRemoteAudit: true });
  assert.equal(calls.locks, 0);
  assert.equal(calls.unlocks, 0);
  assert.deepEqual(calls.updates, []);
  assert.equal(result.action, "SKIPPED");
});

test("pago recibido después del snapshot se reevalúa antes de bloquear", async () => {
  const { sync, calls } = loadSync({ latestOverrides: { abonos: [{ valor: 100, fechaAbono: new Date() }] } });
  const result = await sync(credit());
  assert.equal(calls.locks, 0);
  assert.equal(calls.unlocks, 0);
  assert.equal(result.action, "SKIPPED");
  assert.equal(calls.planInputs.at(-1).abonos[0].valor, 100);
});

test("fallo de desbloqueo con acuerdo vigente conserva FAILED y no crea otro bloqueo", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: true, unlockError: new Error("Respuesta perdida") });
  const result = await sync({ ...credit(), bloqueoMora: true }, { forceRemoteAudit: true });
  assert.equal(calls.locks, 0);
  assert.deepEqual(calls.updates, []);
  assert.equal(result.action, "FAILED");
});

test("una fecha de simulación no altera la vigencia ni el plan de una operación real", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: true });
  await sync(credit(), { today: new Date("2040-12-31T17:00:00.000Z") });
  assert.equal(calls.planInputs[0].today, null);
  assert.equal(calls.locks, 0);
});

test("la simulación sigue aceptando su fecha sin ejecutar comandos remotos", async () => {
  const { sync, calls } = loadSync();
  const result = await sync(credit(), { dryRun: true, today: new Date("2040-12-31T17:00:00.000Z") });
  assert.equal(calls.planInputs[0].today.toISOString(), "2040-12-31T17:00:00.000Z");
  assert.equal(result.action, "WOULD_LOCK");
  assert.equal(calls.locks, 0);
  assert.equal(calls.unlocks, 0);
});
