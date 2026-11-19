import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const core = await jiti.import("../lib/credit-historical-plan-correction.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { splitOutstandingBalance } = await jiti.import("../lib/credit-outstanding-balance.ts");
const canonical = v => v instanceof Date ? JSON.stringify(v.toISOString()) : Array.isArray(v) ? `[${v.map(canonical)}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null);
const hash = v => createHash("sha256").update(canonical(v)).digest("hex");
const base = { plazoMeses: 48, cuotasPagadas: 5, valorCuota: 106000, frecuenciaPago: "QUINCENAL", fechaProximaCuota: "2026-12-02", motivo: "Corrección documentada de condiciones históricas de prueba" };

function fixture(options = {}) {
  const state = {
    user: { id: 1, nombre: "Administrador de prueba", rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1, sedeId: 1 },
    credit: { id: 7, folio: "SYNTHETIC-7", clienteDocumento: "0000000000", clienteNombre: "CLIENTE SINTETICO", sedeId: 1,
      estado: "GENERADO", pazYSalvoEmitidoAt: null, montoCredito: 4912200, valorCuota: 136450,
      plazoMeses: 36, frecuenciaPago: "QUINCENAL", fechaPrimerPago: new Date("2026-09-17T12:00:00Z"), fechaProximoPago: new Date("2026-11-17T12:00:00Z"),
      saldoBaseFinanciado: 2488000, valorEquipoTotal: 2488000, cuotaInicial: 0, valorFianza: 2424200,
      valorInteres: 0, tasaInteresEa: 0, contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } },
      equalityService: "IMPORTACION_MASIVA", observacionAdmin: "Histórico de prueba", amortizacion: null, planCapitalVigente: null,
      updatedAt: new Date("2026-11-01T00:00:00Z") },
    payments: [136450, 136450, 136450, 213000].map((valor, i) => ({ id: i + 1, valor, estado: "ACTIVO", metodoPago: i < 2 ? "EFECTIVO" : "BANCOLOMBIA", observacion: "Recibo original de prueba", fechaAbono: new Date(`2026-${i < 3 ? "10" : "11"}-${String(i + 2).padStart(2, "0")}T12:00:00Z`), createdAt: new Date("2026-11-01T12:00:00Z") })),
    audits: [], writes: 0, locks: 0, pending: false, failAudit: false, found: true, ...options,
  };
  const originalPayments = structuredClone(state.payments);
  const tx = {
    $queryRawUnsafe: async () => { state.locks++; return [{ id: 7 }]; },
    credito: { findFirst: async query => { assert.ok(query.where.AND); return state.found ? state.credit : null; }, update: async ({ data }) => { state.writes++; Object.assign(state.credit, data); return state.credit; } },
    creditoAbono: { findMany: async () => structuredClone(state.payments), create: () => assert.fail("Must never create a receipt"), update: () => assert.fail("Must never amend a receipt"), delete: () => assert.fail("Must never delete a receipt") },
    cajaMovimiento: { create: () => assert.fail("Must never move cash") },
    wompiPaymentIntent: { findFirst: async () => state.pending ? { id: "pending" } : null },
  };
  let queue = Promise.resolve();
  const db = { ...tx, $transaction: (run, config) => {
    assert.equal(config.isolationLevel, "Serializable");
    const promise = queue.then(async () => {
      const before = structuredClone({ credit: state.credit, payments: state.payments, audits: state.audits, writes: state.writes });
      try { return await run(tx); } catch (error) { Object.assign(state, before); throw error; }
    });
    queue = promise.catch(() => {}); return promise;
  } };
  const route = loadReissueModule("app/api/creditos/[id]/correccion-plan-historico/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": { getSessionUser: async () => state.user },
    "@/lib/roles": { isAdminRole: value => value === "ADMIN" }, "@/lib/aliados": { isFinserPayCentralAlly: value => value === "FINSERPAY" },
    "@/lib/credit-route-lookup": { buildCreditAccessWhere: () => ({ sede: { aliadoId: 1 } }) },
    "@/lib/credit-import-flags": { isMassImportedCredit: value => value.equalityService === "IMPORTACION_MASIVA" },
    "@/lib/prisma": { default: db }, "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: input => buildCreditPaymentPlan({ ...input, today: "2026-11-19" }) },
    "@/lib/credit-outstanding-balance": { splitOutstandingBalance }, "@/lib/credit-principal-payment-storage": { hashPrincipalPayment: hash },
    "@/lib/credit-historical-plan-correction": core,
    "@/lib/credit-historical-plan-correction-storage": {
      ensureHistoricalPlanCorrectionSchema: async () => {},
      findHistoricalPlanCorrection: async (_db, id, key) => state.audits.find(r => r.creditoId === id && r.idempotencyKey === key) || null,
      persistHistoricalPlanCorrection: async (_db, value) => { if (state.failAudit) throw new Error("Unavailable"); state.audits.push(structuredClone(value)); return "audit-1"; },
    },
  }, { console: { error() {} } });
  const ctx = { params: Promise.resolve({ id: "7" }) };
  const post = (body, headers = {}) => route.POST(new Request("https://finser.example/api/creditos/7/correccion-plan-historico", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://finser.example", ...headers }, body: JSON.stringify(body),
  }), ctx);
  const preview = () => post({ ...base, accion: "PREVISUALIZAR" });
  const confirm = quoteHash => post({ ...base, accion: "CONFIRMAR", quoteHash, idempotencyKey: "synthetic-correction-0001" });
  return { state, originalPayments, post, preview, confirm, get: () => route.GET(new Request("https://finser.example"), ctx) };
}

test("preview is read-only and confirmation preserves every original receipt and cash", async () => {
  const f = fixture();
  assert.equal((await f.get()).status, 200);
  const preview = await f.preview(); assert.equal(preview.status, 200);
  const { quote, quoteHash } = await preview.json();
  assert.equal(quote.saldoPendiente, 4558000); assert.equal(quote.diferenciaHistorica, 92350);
  assert.equal(quote.totalPlanNominal, 5088000); assert.equal(quote.montoCreditoActualizado, 5180350);
  assert.equal(f.state.writes, 0); assert.equal(f.state.audits.length, 0);
  assert.equal((await f.confirm(quoteHash)).status, 200);
  assert.deepEqual(f.state.payments, f.originalPayments);
  assert.equal(f.state.audits.length, 1);
  assert.deepEqual(f.state.credit.contratoSnapshot, { origen: { tipo: "IMPORTACION_MASIVA" } });
  const current = buildCreditPaymentPlan({ ...f.state.credit, abonos: f.state.payments, today: "2026-11-19" });
  assert.equal(current.paidCount, 5); assert.equal(current.pendingCount, 43);
  assert.equal(current.nextInstallment.numero, 6); assert.equal(current.nextInstallment.fechaVencimiento, "2026-12-02");
  assert.equal(current.nextInstallment.saldoPendiente, 106000);
});

test("a concurrent duplicate confirmation is idempotent and another payload cannot reuse its key", async () => {
  const f = fixture(); const { quoteHash } = await (await f.preview()).json();
  const responses = await Promise.all([f.confirm(quoteHash), f.confirm(quoteHash)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(f.state.writes, 1); assert.equal(f.state.audits.length, 1);
  assert.equal((await f.post({ ...base, valorCuota: 107000, accion: "CONFIRMAR", quoteHash, idempotencyKey: "synthetic-correction-0001" })).status, 409);
});

test("changed payments, receipt identity, credit or actor invalidate the preview", async () => {
  for (const change of [f => { f.state.payments[0].valor++; }, f => { f.state.payments[0].id = 900; },
    f => { f.state.payments[0].fechaAbono = new Date("2026-10-09T12:00:00Z"); }, f => { f.state.credit.observacionAdmin += " revised"; },
    f => { f.state.user.id = 2; }]) {
    const f = fixture(); const { quoteHash } = await (await f.preview()).json(); change(f);
    const r = await f.confirm(quoteHash); assert.equal(r.status, 409, await r.text());
    assert.equal(f.state.writes, 0); assert.equal(f.state.audits.length, 0);
  }
});

test("audit failure rolls back the entire plan change without touching receipts", async () => {
  const f = fixture(); const before = structuredClone(f.state.credit);
  const { quoteHash } = await (await f.preview()).json(); f.state.failAudit = true;
  assert.equal((await f.confirm(quoteHash)).status, 500);
  assert.deepEqual(f.state.credit, before); assert.deepEqual(f.state.payments, f.originalPayments); assert.equal(f.state.writes, 0);
});

test("closed, amortized, non-historical and already revised credits are rejected", async () => {
  for (const change of [c => { c.estado = "ANULADO"; }, c => { c.pazYSalvoEmitidoAt = new Date(); },
    c => { c.amortizacion = { id: 9 }; }, c => { c.equalityService = "OTHER"; }, c => { c.fechaPrimerPago = null; }]) {
    const f = fixture(); change(f.state.credit); assert.equal((await f.preview()).status, 409); assert.equal(f.state.writes, 0);
  }
  const f = fixture(); f.state.pending = true; assert.equal((await f.preview()).status, 409);
});

test("access scope, JSON, origin and values are validated before a mutation", async () => {
  const anonymous = fixture({ user: null }); assert.equal((await anonymous.preview()).status, 401);
  const otherAlly = fixture(); otherAlly.state.user.aliadoAccesoCodigo = "OTHER"; assert.equal((await otherAlly.preview()).status, 403);
  const missing = fixture({ found: false }); assert.equal((await missing.preview()).status, 404);
  const f = fixture();
  assert.equal((await f.post({ ...base, accion: "PREVISUALIZAR" }, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await f.post({ ...base, accion: "PREVISUALIZAR" }, { "content-type": "text/plain" })).status, 400);
  assert.equal((await f.post({ ...base, plazoMeses: "48", accion: "PREVISUALIZAR" })).status, 400);
  assert.equal((await f.post({ ...base, accion: "CONFIRMAR" })).status, 400);
  assert.equal(f.state.writes, 0);
});

test("native audit schema preserves snapshots and enforces one key per credit", async () => {
  const pg = new PGlite();
  try {
    await pg.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY); CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY); INSERT INTO "Credito" VALUES (7); INSERT INTO "Usuario" VALUES (1);');
    const db = { $executeRawUnsafe: async (q, ...args) => pg.query(q, args), $queryRawUnsafe: async (q, ...args) => (await pg.query(q, args)).rows };
    const store = loadReissueModule("lib/credit-historical-plan-correction-storage.ts", { "@/lib/prisma": { default: db } });
    await store.ensureHistoricalPlanCorrectionSchema();
    const input = { creditoId: 7, usuarioId: 1, nombreUsuario: "QA", motivo: base.motivo, idempotencyKey: "test-native-0001", requestHash: "request", previewHash: "preview", beforeSnapshot: { credit: { plazoMeses: 36 }, abonos: [{ id: 1, valor: 100 }] }, afterSnapshot: { credit: { plazoMeses: 48 } }, resultado: { ok: true } };
    await store.persistHistoricalPlanCorrection(db, input);
    const replay = await store.findHistoricalPlanCorrection(db, 7, input.idempotencyKey);
    assert.equal(replay.requestHash, "request"); assert.deepEqual(replay.resultado, { ok: true });
    await assert.rejects(store.persistHistoricalPlanCorrection(db, input), /unique|duplicate/i);
    for (const sql of ['UPDATE "CreditHistoricalPlanCorrection" SET "motivo"=\'changed\'', 'DELETE FROM "CreditHistoricalPlanCorrection"', 'TRUNCATE "CreditHistoricalPlanCorrection"']) {
      await assert.rejects(pg.exec(sql), /immutable/i);
    }
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM "CreditHistoricalPlanCorrection"')).rows[0].n, 1);
  } finally { await pg.close(); }
});
