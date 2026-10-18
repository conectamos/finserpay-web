import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const factory = await jiti.import("../lib/credit-factory.ts");
const plan = await jiti.import("../lib/credit-payment-plan.ts");
const payoff = await jiti.import("../lib/credit-early-payoff.ts");
const nextPayment = await jiti.import("../lib/credit-next-payment-date.ts");
const amounts = await jiti.import("../lib/manual-payment-amount.ts");
const snapshots = await jiti.import("../lib/credit-factory-snapshot.ts");

function load(file, dependencies, signalApi = AbortSignal) {
  const loaded = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(outputText, { exports: loaded.exports, module: loaded, Date, Map, Set, Number, String, Math, Intl, JSON, AbortSignal: signalApi,
    console: { error() {} },
    require(name) { assert.ok(name in dependencies, `Dependencia inesperada ${file}: ${name}`); return dependencies[name]; },
  }, { filename: file });
  return loaded.exports;
}

function fixture({ protectedCredit = true, blockedForMora = false, blockedForTheft = false, central = true, role = "ADMIN", slowQuery = false, pauseUnlock = false } = {}) {
  const calls = { locks: 0, unlocks: 0, protections: [], order: [], timeouts: [] };
  const signalApi = { timeout: ms => { calls.timeouts.push(ms); return AbortSignal.timeout(slowQuery && ms === 3000 ? 10 : ms); }, any: signals => AbortSignal.any(signals) };
  let announceUnlock;
  let resumeUnlock;
  const unlockStarted = new Promise(resolve => { announceUnlock = resolve; });
  const unlockGate = new Promise(resolve => { resumeUnlock = resolve; });
  const credit = {
    id: 41, folio: "FC-PRORROGA-QA", clienteNombre: "Cliente de prueba", clienteDocumento: "001234567",
    clienteTelefono: "3000000000", imei: "355043750843865", deviceUid: "355043750843865", equipoMarca: "SAMSUNG",
    equipoModelo: "Equipo de prueba", estado: "INSCRITO", sedeId: 1, montoCredito: 1000000, cuotaInicial: 200000,
    fechaCredito: new Date("2025-12-01T17:00:00Z"), createdAt: new Date("2025-12-01T17:00:00Z"), updatedAt: new Date("2025-12-01T17:00:00Z"),
    saldoBaseFinanciado: 800000, valorCuota: 100000, plazoMeses: 10, frecuenciaPago: "MENSUAL", planCapitalVigente: null,
    fechaPrimerPago: new Date("2026-01-02T17:00:00Z"), fechaProximoPago: new Date("2026-01-02T17:00:00Z"),
    contratoSnapshot: null, pazYSalvoEmitidoAt: null, bloqueoMora: blockedForMora, bloqueoMoraAt: blockedForMora ? new Date() : null,
    bloqueoRobo: blockedForTheft, bloqueoRoboAt: blockedForTheft ? new Date() : null, valorInteres: 100000,
    valorFianza: 100000, deliverableLabel: null, deliverableReady: true, equalityState: null, equalityService: null,
    equalityPayload: null, equalityLastCheckAt: null, observacionAdmin: null, referenciaPago: "QA41",
    usuario: { id: 1, nombre: "Administrador prueba", usuario: "qa" }, vendedor: null, sede: { id: 1, nombre: "Sede QA", aliadoId: 1 },
  };
  const payments = [];
  const db = {
    usuario: { findMany: async () => [credit.usuario] }, vendedor: { findMany: async () => [] }, sede: { findMany: async () => [credit.sede] },
    $queryRaw: async () => [{ id: credit.id }],
    $queryRawUnsafe: async () => { calls.order.push("credit-lock"); return [{ id: credit.id }]; },
    credito: { findFirst: async () => credit, findUnique: async () => ({ ...credit, abonos: [...payments] }),
      update: async ({ data }) => { Object.assign(credit, data); return credit; } },
    creditoAbono: { findMany: async () => [...payments], groupBy: async () => payments.length ? [{ creditoId: 41,
      _sum: { valor: payments.reduce((sum, item) => sum + item.valor, 0) }, _count: { _all: payments.length }, _max: { fechaAbono: payments.at(-1).fechaAbono } }] : [],
      create: async ({ data }) => { const payment = { ...data, id: payments.length + 1, estado: "ACTIVO", fechaAbono: new Date(), createdAt: new Date(),
        usuario: credit.usuario, sede: credit.sede, vendedor: null }; payments.push(payment); return payment; } },
    cajaMovimiento: { create: async () => ({}) },
  };
  let previousTransaction = Promise.resolve();
  db.$transaction = async callback => {
    const predecessor = previousTransaction;
    let release;
    previousTransaction = new Promise(resolve => { release = resolve; });
    await predecessor;
    try { return await callback(db); } finally { release(); }
  };
  const protection = { ensureMoraBlockProtectionTables: async () => {}, hasActiveMoraBlockProtection: async (id, document, tx) => {
    calls.order.push("protection"); calls.protections.push({ id, document, tx: tx === db }); return protectedCredit;
  } };
  const equality = {
    isEqualityConfigured: () => true, isEqualityApiError: () => false,
    lockEqualityDevice: async (_device, options) => { assert.ok(options.signal); calls.order.push("provider-lock"); calls.locks++; return { confirmedCommand: "LOCK" }; },
    unlockEqualityDevice: async (_device, options) => {
      assert.ok(options.signal); calls.order.push("provider-unlock"); calls.unlocks++;
      announceUnlock(); if (pauseUnlock) await unlockGate;
      return { confirmedCommand: "UNLOCK" };
    },
    queryEqualityDevices: async (_device, options) => {
      if (!slowQuery) return null;
      const signal = options.signal;
      await new Promise((_, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("No se canceló la consulta")), 200);
        const abort = () => { clearTimeout(keepAlive); reject(signal.reason); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const meta = { getEqualityDeviceMeta: () => ({}), getPayloadSummary: () => ({}) };
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } },
    "@/app/generated/prisma/client": { Prisma: { DbNull: null, PrismaClientKnownRequestError: class extends Error {} } },
    "@/lib/auth": { getSessionUser: async () => ({ id: 1, sedeId: 1, rolNombre: role, aliadoAccesoCodigo: central ? "FINSERPAY" : "ALIADO", aliadoAccesoId: central ? 1 : 2 }) },
    "@/lib/seller-auth": { getSellerSessionUser: async () => role === "VENDEDOR" ? { id: 2, tipoPerfil: "VENDEDOR" } : null },
    "@/lib/roles": { isAdminRole: value => value === "ADMIN" },
    "@/lib/aliados": { isFinserPayCentralAlly: value => value === "FINSERPAY" },
    "@/lib/prisma": { default: db }, "@/lib/credit-factory": factory, "@/lib/credit-payment-plan": plan,
    "@/lib/credit-early-payoff": payoff, "@/lib/credit-next-payment-date": nextPayment, "@/lib/manual-payment-amount": amounts,
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-route-lookup": { buildCreditAccessWhere: () => ({}) },
    "@/lib/credit-import-flags": { isMassImportedCredit: () => false },
    "@/lib/equality-zero-touch": equality, "@/lib/equality-device-meta": meta,
    "@/lib/mora-block-protection": protection,
    "@/lib/mora-block-exemptions": { getActiveMoraBlockExemptionDocuments: async () => new Set(), isMoraBlockExempt: async () => false,
      normalizeMoraExemptionDocument: value => String(value ?? "").replace(/\D/g, "") },
    "@/lib/mora-exception-requests": { getActiveMoraExceptionByCreditId: async () => null, getActiveMoraExceptionsByCreditIds: async () => new Map() },
    "@/lib/credit-lock-message": { buildMoraLockMessage: () => "Pago vencido" },
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map([[41, "0000041"]]) },
    "@/lib/mass-credit-financial-components": { readMassCreditComponents: () => null },
    "@/lib/device-unlock-queue": {}, "@/lib/credit-assigned-seller": { resolveCreditSellerDisplay: () => "QA" },
    "@/lib/credit-factory-snapshot": snapshots,
    "@/lib/credit-amortization-storage": {}, "@/lib/credit-plan-revision": {}, "@/lib/ally-payment-annulments": {},
  };
  dependencies["@/lib/credit-mora-sync"] = load("lib/credit-mora-sync.ts", dependencies, signalApi);
  const abonos = load("app/api/creditos/[id]/abonos/route.ts", dependencies, signalApi);
  const command = load("app/api/creditos/[id]/command/route.ts", dependencies, signalApi);
  const context = { params: Promise.resolve({ id: "41" }) };
  return { calls, credit, payments, unlockStarted, resumeUnlock,
    get: () => abonos.GET({}, context),
    pay: () => abonos.POST({ json: async () => ({ valor: 10000, metodoPago: "EFECTIVO" }) }, context),
    toggle: (action = "toggle-mora-lock") => command.POST({ json: async () => ({ command: action }) }, context),
  };
}

for (const operation of ["get", "pay"]) {
  test(`${operation} de abonos no bloquea el equipo con prórroga aprobada vigente`, async () => {
    const f = fixture();
    const result = await f[operation]();
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.automation.action, "SKIPPED");
    assert.equal(f.calls.locks, 0);
    assert.equal(f.calls.unlocks, 0);
    assert.equal(f.credit.bloqueoMora, false);
    assert.equal(f.calls.protections[0].id, 41);
    assert.equal(f.calls.protections[0].document, "001234567");
    if (operation === "pay") assert.equal(f.payments.length, 1, "Conserva el registro del recaudo parcial");
  });
}

test("abonos retira únicamente la mora existente si el crédito está amparado", async () => {
  const f = fixture({ blockedForMora: true });
  const result = await f.get();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.automation.action, "UNLOCKED");
  assert.equal(f.calls.locks, 0);
  assert.equal(f.calls.unlocks, 1);
  assert.equal(f.credit.bloqueoMora, false);
});

test("bloqueo manual por mora queda denegado bajo lock si hay excepción o prórroga", async () => {
  const f = fixture();
  const result = await f.toggle();
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.match(result.body.error, /excepción.*prórroga/);
  assert.deepEqual(f.calls.order, ["credit-lock", "protection"]);
  assert.equal(f.calls.protections[0].tx, true);
  assert.equal(f.calls.locks, 0);
});

test("bloqueo manual sin protección vigente mantiene su funcionamiento", async () => {
  const f = fixture({ protectedCredit: false });
  const result = await f.toggle();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.locks, 1);
  assert.equal(f.credit.bloqueoMora, true);
});

test("ni abonos ni acción mora retiran el bloqueo por robo", async () => {
  const f = fixture({ blockedForMora: true, blockedForTheft: true });
  assert.equal((await f.get()).status, 200);
  assert.equal((await f.toggle()).status, 409);
  assert.equal(f.calls.locks, 0);
  assert.equal(f.calls.unlocks, 0);
  assert.equal(f.credit.bloqueoRobo, true);
});

test("bloqueo por robo sigue disponible con prórroga y se serializa antes de tocar el equipo", async () => {
  const f = fixture();
  const result = await f.toggle("toggle-stolen-lock");
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.credit.bloqueoRobo, true);
  assert.equal(f.credit.bloqueoMora, false);
  assert.deepEqual(f.calls.order, ["credit-lock", "provider-lock"]);
});

test("retirar robo conserva el bloqueo por mora sin enviar un desbloqueo remoto", async () => {
  const f = fixture({ protectedCredit: false, blockedForMora: true, blockedForTheft: true });
  const result = await f.toggle("toggle-stolen-lock");
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.credit.bloqueoRobo, false);
  assert.equal(f.credit.bloqueoMora, true);
  assert.equal(f.calls.unlocks, 0);
});

test("reporte de robo concurrente espera el desbloqueo por acuerdo y queda protegido al terminar", async () => {
  const f = fixture({ blockedForMora: true, pauseUnlock: true });
  const refreshing = f.get();
  await f.unlockStarted;
  const theft = f.toggle("toggle-stolen-lock");
  await Promise.resolve();
  assert.equal(f.calls.locks, 0, "Robo espera el mismo lock del crédito");
  f.resumeUnlock();
  const responses = await Promise.all([refreshing, theft]);
  assert.ok(responses.every(result => result.status === 200), JSON.stringify(responses));
  assert.equal(f.calls.unlocks, 1);
  assert.equal(f.calls.locks, 1);
  assert.equal(f.credit.bloqueoRobo, true);
  assert.equal(f.credit.bloqueoMora, false);
  assert.ok(f.calls.order.indexOf("provider-lock") > f.calls.order.indexOf("provider-unlock"));
});

test("timeout de consulta secundaria no pierde el desbloqueo confirmado por excepción", async () => {
  const f = fixture({ blockedForMora: true, slowQuery: true });
  const result = await f.get();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.automation.action, "UNLOCKED");
  assert.equal(f.credit.bloqueoMora, false);
  assert.equal(f.credit.equalityPayload.confirmedCommand, "UNLOCK");
  assert.deepEqual(f.calls.timeouts, [15000, 3000]);
});

test("timeout de consulta secundaria conserva comando manual confirmado y flags", async () => {
  const f = fixture({ protectedCredit: false, slowQuery: true });
  const result = await f.toggle();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.credit.bloqueoMora, true);
  assert.equal(f.credit.equalityPayload.confirmedCommand, "LOCK");
  assert.deepEqual(f.calls.timeouts, [15000, 3000]);
});

for (const permissions of [{ central: false }, { role: "VENDEDOR" }]) {
  test(`bloqueo manual respeta alcance y rol ${JSON.stringify(permissions)}`, async () => {
    const f = fixture(permissions);
    const result = await f.toggle();
    assert.ok([403, 404].includes(result.status));
    assert.equal(f.calls.locks, 0);
    assert.equal(f.calls.protections.length, 0);
  });
}
