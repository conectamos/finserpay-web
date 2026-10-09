import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadSync({ exceptionAppears, exceptionSequence = null, unlockError = null }) {
  const source = readFileSync(new URL("../lib/credit-mora-sync.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  const calls = { order: [], locks: 0, unlocks: 0, updates: [] };
  let exceptionReads = 0;
  const update = async ({ data }) => {
    calls.updates.push(data.bloqueoMora);
    return { estado: data.estado, equalityState: data.equalityState || null, equalityService: data.equalityService || null, bloqueoMora: data.bloqueoMora, bloqueoMoraAt: data.bloqueoMoraAt || null };
  };
  const tx = {
    credito: { update },
    $queryRawUnsafe: async (sql) => {
      assert.match(sql, /FROM "Credito"[\s\S]*FOR UPDATE/);
      calls.order.push("credit-lock");
      return [{ id: 41 }];
    },
  };
  const prisma = {
    credito: { update },
    $transaction: async (callback) => callback(tx),
  };
  const dependencies = {
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: () => ({ estadoPago: "MORA", saldoPendiente: 100, overdueCount: 1, nextInstallment: { fechaVencimiento: "2026-10-02" }, installments: [] }) },
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
      getActiveMoraExceptionsByCreditIds: async (_ids, _at, database) => {
        assert.ok(database === tx || database === undefined);
        calls.order.push("exception-read");
        const active = exceptionSequence ? exceptionSequence[Math.min(exceptionReads++, exceptionSequence.length - 1)] : exceptionAppears;
        return active ? new Map([[41, { fechaFin: new Date(), type: "EXCEPCION" }]]) : new Map();
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
    JSON,
    Set,
  }, { filename: "lib/credit-mora-sync.ts" });
  return { sync: loaded.exports.syncCreditMora, calls };
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

test("snapshot stale del cron revalida bajo lock y nunca vuelve a bloquear un crédito recién exceptuado", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: true });
  const result = await sync(credit(), { exemptCreditIds: new Set(), today: new Date("2026-10-03T17:00:00.000Z") });
  assert.deepEqual(calls.order, ["credit-lock", "exception-read", "remote-unlock", "credit-lock", "exception-read"]);
  assert.equal(calls.locks, 0);
  assert.equal(calls.unlocks, 1);
  assert.deepEqual(calls.updates, [false]);
  assert.equal(result.action, "UNLOCKED");
});

test("sin excepción tras adquirir el lock conserva el bloqueo normal por mora", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: false });
  const result = await sync(credit(), { exemptCreditIds: new Set(), today: new Date("2026-10-03T17:00:00.000Z") });
  assert.deepEqual(calls.order, ["credit-lock", "exception-read", "remote-lock"]);
  assert.equal(calls.locks, 1);
  assert.equal(calls.unlocks, 0);
  assert.deepEqual(calls.updates, [true]);
  assert.equal(result.action, "LOCKED");
});

test("cancelación durante un desbloqueo en vuelo descarta el snapshot y restablece el bloqueo por mora", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: false });
  const result = await sync(credit(), { exemptCreditIds: new Set([41]), forceRemoteAudit: true, today: new Date("2026-10-03T17:00:00.000Z") });
  assert.deepEqual(calls.order, ["remote-unlock", "credit-lock", "exception-read", "credit-lock", "exception-read", "remote-lock"]);
  assert.equal(calls.unlocks, 1);
  assert.equal(calls.locks, 1);
  assert.deepEqual(calls.updates, [true], "La lectura antigua no debe volver a guardar desbloqueo");
  assert.equal(result.action, "LOCKED");
});

test("excepción vigente se revalida después de la llamada remota y guarda el resultado bajo lock corto", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: true });
  const result = await sync(credit(), { exemptCreditIds: new Set([41]), forceRemoteAudit: true, today: new Date("2026-10-03T17:00:00.000Z") });
  assert.deepEqual(calls.order, ["remote-unlock", "credit-lock", "exception-read"]);
  assert.equal(calls.unlocks, 1);
  assert.equal(calls.locks, 0);
  assert.deepEqual(calls.updates, [false]);
  assert.equal(result.action, "UNLOCKED");
});

test("excepción revocada tras revalidación del cron no deja que su intento de desbloqueo antiguo gane", async () => {
  const { sync, calls } = loadSync({ exceptionSequence: [true, false, false] });
  const result = await sync(credit(), { exemptCreditIds: new Set(), today: new Date("2026-10-03T17:00:00.000Z") });
  assert.equal(calls.unlocks, 1);
  assert.equal(calls.locks, 1);
  assert.deepEqual(calls.updates, [true]);
  assert.equal(result.action, "LOCKED");
});

test("respuesta de desbloqueo perdida con excepción cancelada también reconcilia el equipo", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: false, unlockError: new Error("Respuesta perdida") });
  const result = await sync(credit(), { exemptCreditIds: new Set([41]), forceRemoteAudit: true, today: new Date("2026-10-03T17:00:00.000Z") });
  assert.deepEqual(calls.order, ["remote-unlock", "exception-read", "credit-lock", "exception-read", "remote-lock"]);
  assert.deepEqual(calls.updates, [true]);
  assert.equal(result.action, "LOCKED");
});

test("fallo remoto sin revocación mantiene FAILED y no bloquea una excepción vigente", async () => {
  const { sync, calls } = loadSync({ exceptionAppears: true, unlockError: new Error("Respuesta perdida") });
  const result = await sync(credit(), { exemptCreditIds: new Set([41]), forceRemoteAudit: true, today: new Date("2026-10-03T17:00:00.000Z") });
  assert.equal(calls.locks, 0);
  assert.deepEqual(calls.updates, []);
  assert.equal(result.action, "FAILED");
});
