import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import path from "node:path";
import { creditPrincipalPaymentSchemaStatements, installCreditPrincipalPaymentSchema } from "../scripts/credit-principal-payment-schema.mjs";
import { makeNativeCapitalFixture } from "./fixtures/credit-principal-payment-native.mjs";

const routeFile = new URL("../app/api/creditos/[id]/abono-capital/route.ts", import.meta.url);
const source = readFileSync(routeFile, "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const realFactory=await jiti.import("../lib/credit-factory.ts");
const realCore = await jiti.import("../lib/credit-principal-payment.ts");
const realPlan = await jiti.import("../lib/credit-payment-plan.ts");
const realContext = await jiti.import("../lib/credit-principal-payment-context.ts");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const canonical = (v) => v instanceof Date ? JSON.stringify(v.toISOString()) : Array.isArray(v) ? `[${v.map(canonical)}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null);
const hash = v => createHash("sha256").update(canonical(v)).digest("hex");
class ValidationError extends Error {}

function fixture(options = {}) {
  const state = {
    user: { id: 1, sedeId: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" },
    credit: { id: 7, folio: "TEST", clienteNombre: "Cliente de prueba", sedeId: 1, estado: "GENERADO", pazYSalvoEmitidoAt: null, saldoBaseFinanciado: 3500000, montoCredito: 7185600, valorCuota: 149700, plazoMeses: 48, frecuenciaPago: "QUINCENAL", fechaPrimerPago: new Date("2026-09-17T12:00:00Z"), fechaProximoPago: new Date("2026-11-02T12:00:00Z"), planCapitalVigente: null },
    abonos: [{ id: 1, valor: 450000, fechaAbono: new Date("2026-09-26T12:00:00Z") }],
    revisions: [], caja: [], locks: 0, overdueCount: 0, pendingWompi: false, failPersistence: false,
    amortizationReads: [], revisedAmortization: null,
    ...options,
  };
  const tx = {
    $queryRaw: async () => { state.locks++; return [{ id: 7 }]; },
    credito: {
      findFirst: async () => structuredClone(state.credit),
      update: async ({ data }) => { Object.assign(state.credit, data); return state.credit; },
    },
    creditoAbono: {
      findMany: async () => state.abonos.map(x => ({ ...x })),
      create: async ({ data }) => { const item = { id: state.abonos.length + 1, ...data, fechaAbono: new Date("2026-09-26T12:01:00Z") }; state.abonos.push(item); return item; },
    },
    wompiPaymentIntent: { findFirst: async ({ where }) => {
      const pendingStatus = state.pendingWompi === true ? "PENDING" : state.pendingWompi;
      const queriedStatuses = typeof where.status === "string" ? [where.status] : where.status.in;
      return pendingStatus && queriedStatuses.includes(pendingStatus) ? { id: 2 } : null;
    } },
    cajaMovimiento: { create: async ({ data }) => { state.caja.push(data); return data; } },
  };
  let transactionQueue = Promise.resolve();
  const prisma = { ...tx, $transaction: (run) => {
    const execute = async () => {
      const before = structuredClone({ credit: state.credit, abonos: state.abonos, revisions: state.revisions, caja: state.caja });
      try { return await run(tx); } catch (error) { Object.assign(state, before); throw error; }
    };
    const result = transactionQueue.then(execute);
    transactionQueue = result.catch(() => {});
    return result;
  } };
  const imports = {
    "next/server": { NextResponse: { json: (body, options) => ({ status: options?.status || 200, body }) } },
    "@/lib/auth": { getSessionUser: async () => state.user },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/credit-route-lookup": { buildCreditAccessWhere: () => ({}) },
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-plan-revision": {
      ensureCreditPlanRevisionSchema: async () => {},
      getLatestCreditPlanAmortization: async (creditId, db) => {
        state.amortizationReads.push({ creditId, transactional: db === tx, locks: state.locks });
        if (state.revisionReadError) throw new Error("Administrative revision unavailable");
        return state.revisedAmortization;
      },
    },
    "@/lib/credit-factory": {
      normalizePaymentMethod: realFactory.normalizePaymentMethod, sanitizeText: x => typeof x === "string" ? x.trim() : "",
      creditCajaConcept: () => "ABONO CREDITO EFECTIVO", creditCajaDescription: x => `Abono ${x.id}`,
    },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: input => ({
      saldoPendiente: input.montoCredito - input.abonos.reduce((sum, item) => sum + item.valor, 0),
      overdueCount: state.overdueCount, nextInstallment: { numero: 4, fechaVencimiento: "2026-11-02", saldoPendiente: 149700 },
    }) },
    "@/lib/credit-principal-payment": {
      CapitalPaymentValidationError: ValidationError,
      createPrincipalPaymentQuote: input => {
        if (state.invalidQuote) throw new ValidationError("Conciliación inválida.");
        if (!input.planCapitalVigente && !input.conciliacion) throw new ValidationError("Falta conciliación.");
        return {
          abonoCapital: input.valor, montoCreditoActualizado: 6000000,
          saldoCapitalAntes: 3347264, saldoCapitalDespues: 3347264 - input.valor,
          planCapitalVigente: { version: "CAPITAL_REDUCCION_PLAZO_V1", revision: (input.planCapitalVigente?.revision || 0) + 1,
            abonosAlCorte: input.abonos, totalAbonadoAlCorte: input.abonos.reduce((s, a) => s + a.valor, 0) + input.valor,
            parametros: input.conciliacion || input.planCapitalVigente.parametros, cuotas: [] },
        };
      },
    },
    "@/lib/credit-principal-payment-storage": {
      hashPrincipalPayment: hash,
      findPrincipalPaymentRevision: async (_db, creditoId, idempotencyKey) => state.revisions.find(x => x.creditoId === creditoId && x.idempotencyKey === idempotencyKey),
      persistPrincipalPaymentRevision: async (_db, value) => { if (state.failPersistence) throw new Error("db unavailable"); state.revisions.push(structuredClone(value)); },
    },
    "@/lib/credit-principal-payment-context": {
      resolvePrincipalPaymentContext: ({ credit }) => ({
        modoConciliacion: credit.planCapitalVigente ? "VIGENTE" : "MANUAL",
        requiereConciliacion: !credit.planCapitalVigente,
        motivoConciliacion: credit.planCapitalVigente ? null : "Falta conciliación documentada.",
        capitalPendiente: null, conciliacion: null,
      }),
    },
  };
  if (options.realCore) {
    imports["@/lib/credit-principal-payment-context"] = realContext;
    imports["@/lib/credit-principal-payment"] = realCore;
    imports["@/lib/credit-payment-plan"] = {
      buildCreditPaymentPlan: input => realPlan.buildCreditPaymentPlan({ ...input, today: "2026-09-26" }),
    };
  }
  const mod = { exports: {} };
  const context = vm.createContext({ module: mod, exports: mod.exports, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, console: { error() {} }, Date, Error, Number, String });
  vm.runInContext(code, context);
  const routeContext = { params: Promise.resolve({ id: "7" }) };
  const post = async body => mod.exports.POST(new Request("https://example.test/api/creditos/7/abono-capital", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), routeContext);
  const base = { accion: "PREVISUALIZAR", valor: 700000, conciliacion: { capitalPendiente: 3347264, tasaPeriodo: 0.010881, cuotaCredito: 94470, fianzaCuota: 54180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Conciliación de prueba, sin datos personales" }, metodoPago: "EFECTIVO", observacion: "Prueba" };
  const preview = () => post(base);
  const confirm = quoteHash => post({ ...base, accion: "CONFIRMAR", quoteHash, idempotencyKey: "test-request-00000001" });
  return { state, post, base, preview, confirm, get: () => mod.exports.GET(new Request("https://example.test"), routeContext) };
}

test("principal API denies anonymous, seller and non-central admin before mutations", async () => {
  for (const [user, expected] of [[null, 401], [{ rolNombre: "VENDEDOR", aliadoAccesoCodigo: "FINSERPAY" }, 403], [{ rolNombre: "ADMIN", aliadoAccesoCodigo: "OTHER" }, 403]]) {
    const f = fixture({ user });
    assert.equal((await f.preview()).status, expected);
    assert.equal(f.state.locks, 0);
    assert.equal(f.state.abonos.length, 1);
  }
});
test("principal preview is read only and requires documented reconciliation", async () => {
  const f = fixture();
  const result = await f.preview();
  assert.equal(result.status, 200);
  assert.match(result.body.quoteHash, /^[a-f0-9]{64}$/);
  assert.equal(f.state.abonos.length, 1);
  assert.equal(f.state.caja.length, 0);
  assert.equal(f.state.credit.planCapitalVigente, null);
  assert.equal((await f.post({ ...f.base, conciliacion: undefined })).status, 400);
});
test("principal confirmation requires preview and rejects stale payment state without writes", async () => {
  const f = fixture();
  assert.equal((await f.confirm(undefined)).status, 400);
  const preview = await f.preview();
  f.state.abonos.push({ id: 10, valor: 1000, fechaAbono: new Date("2026-09-26T12:02:00Z") });
  const result = await f.confirm(preview.body.quoteHash);
  assert.equal(result.status, 409);
  assert.equal(f.state.caja.length, 0);
  assert.equal(f.state.credit.planCapitalVigente, null);
});
test("principal confirmation atomically records full cash, exact principal and immutable revision", async () => {
  const f = fixture();
  const preview = await f.preview();
  const result = await f.confirm(preview.body.quoteHash);
  assert.equal(result.status, 200);
  assert.equal(f.state.abonos.at(-1).valor, 700000);
  assert.equal(f.state.caja[0].valor, 700000);
  assert.equal(f.state.revisions.length, 1);
  assert.equal(f.state.credit.planCapitalVigente.abonosAlCorte.at(-1).id, result.body.abonoId);
  assert.equal(f.state.credit.plazoMeses, 48);
  assert.equal(f.state.credit.saldoBaseFinanciado, 3500000);
  assert.equal(f.state.credit.montoCredito, 6000000);
});
test("identical retry is idempotent and changed payload cannot reuse its key", async () => {
  const f = fixture();
  const { body } = await f.preview();
  const first = await f.confirm(body.quoteHash);
  const repeat = await f.confirm(body.quoteHash);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.alreadyApplied, true);
  assert.equal(repeat.body.abonoId, first.body.abonoId);
  assert.equal(f.state.abonos.length, 2);
  assert.equal(f.state.caja.length, 1);
  const changed = await f.post({ ...f.base, accion: "CONFIRMAR", quoteHash: body.quoteHash, idempotencyKey: "test-request-00000001", valor: 800000 });
  assert.equal(changed.status, 409);
  assert.equal(f.state.abonos.length, 2);
});
test("concurrent identical confirmations result in only one receipt", async () => {
  const f = fixture();
  const { body } = await f.preview();
  const results = await Promise.all([f.confirm(body.quoteHash), f.confirm(body.quoteHash)]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(f.state.abonos.length, 2);
  assert.equal(f.state.caja.length, 1);
  assert.equal(f.state.revisions.length, 1);
});
test("real financial engine survives API preview, atomic confirmation and retry with exact updated schedule", async () => {
  const f = fixture({ realCore: true });
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  assert.equal(preview.body.quote.saldoCapitalDespues, 2647264);
  assert.equal(preview.body.quote.ultimaCuota.numero, 37);
  assert.equal(preview.body.quote.ultimaCuota.valor, 112799);
  const confirmed = await f.confirm(preview.body.quoteHash);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(f.state.credit.planCapitalVigente.cuotas[3].capital, 65665);
  assert.equal(f.state.credit.planCapitalVigente.cuotas[3].valorAbonadoAlCorte, 900);
  assert.equal(f.state.credit.planCapitalVigente.cuotas[36].valorProgramado, 112799);
  assert.ok(f.state.credit.planCapitalVigente.cuotas.slice(37).every(row => row.eliminada && row.valorProgramado === 0));
  assert.equal(f.state.credit.fechaProximoPago.toISOString().slice(0, 10), "2026-11-02");
  const parsed = realCore.parseCapitalPlanSnapshot(f.state.credit.planCapitalVigente);
  assert.equal(parsed.saldoCapitalAlCorte, 2647264);
  const repeat = await f.confirm(preview.body.quoteHash);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.alreadyApplied, true);
  assert.equal(f.state.caja.length, 1);
});
test("changed financial input, payment method or note invalidates prior preview", async () => {
  for (const changed of [{ valor: 700001 }, { metodoPago: "TRANSFERENCIA" }, { observacion: "Otro detalle" }, { conciliacion: { fuente: "Datos cambiados" } }]) {
    const f = fixture();
    const preview = await f.preview();
    const result = await f.post({ ...f.base, accion: "CONFIRMAR", quoteHash: preview.body.quoteHash, idempotencyKey: "test-request-00000001", ...changed });
    assert.equal(result.status, 409);
    assert.equal(f.state.caja.length, 0);
  }
});
test("a later principal payment keeps reconciled terms and creates a second audit revision", async () => {
  const f = fixture({ realCore: true });
  const firstPreview = await f.preview();
  assert.equal((await f.confirm(firstPreview.body.quoteHash)).status, 200);
  assert.equal((await f.preview()).status, 400, "A later principal quote must not silently ignore a supplied reconciliation");
  const body = { accion: "PREVISUALIZAR", valor: 100000, metodoPago: "EFECTIVO", observacion: "Segundo abono" };
  const preview = await f.post(body);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.quote.saldoCapitalAntes, 2647264);
  assert.equal(preview.body.quote.saldoCapitalDespues, 2547264);
  const confirmed = await f.post({ ...body, accion: "CONFIRMAR", quoteHash: preview.body.quoteHash, idempotencyKey: "test-request-00000002" });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(f.state.revisions.length, 2);
  assert.equal(f.state.credit.planCapitalVigente.revision, 2);
  assert.equal(f.state.credit.planCapitalVigente.parametros.tasaPeriodo, 0.010881);
  assert.equal(f.state.credit.planCapitalVigente.abonosAlCorte.length, 3);
  assert.equal(f.state.caja.reduce((sum, row) => sum + row.valor, 0), 800000);
});
test("audit persistence failure rolls back payment, cash and schedule", async () => {
  const f = fixture();
  const { body } = await f.preview();
  f.state.failPersistence = true;
  const result = await f.confirm(body.quoteHash);
  assert.equal(result.status, 500);
  assert.equal(f.state.credit.planCapitalVigente, null);
  assert.equal(f.state.abonos.length, 1);
  assert.equal(f.state.caja.length, 0);
  assert.equal(f.state.revisions.length, 0);
});
test("overdue installments and pending Wompi payments block principal payment", async () => {
  for (const options of [{ overdueCount: 1 }, { pendingWompi: true }]) {
    const f = fixture(options);
    assert.equal((await f.preview()).status, 409);
    assert.equal(f.state.caja.length, 0);
  }
});
test("a Nequi intent in any active stage blocks changes to its quoted principal plan", async () => {
  for (const pendingWompi of ["APPROVED", "APPROVED_REVIEW_REQUIRED", "APPROVED_DUPLICATE_REVIEW_REQUIRED", "AMOUNT_MISMATCH", "CHECKOUT_FALLBACK", "CREATING_NEQUI", "PENDING", "PROCESSING_APPROVED"]) {
    const f = fixture({ pendingWompi });
    assert.equal((await f.preview()).status, 409, pendingWompi);
    assert.equal(f.state.revisions.length, 0);
    assert.equal(f.state.caja.length, 0);
  }
  for (const pendingWompi of ["DECLINED", "VOIDED", "ERROR"]) {
    const f = fixture({ pendingWompi });
    assert.equal((await f.preview()).status, 200, pendingWompi);
  }
});

test("closed and annulled credits reject new principal quotes", async () => {
  const f = fixture();
  f.state.credit.estado = "ANULADO";
  assert.equal((await f.preview()).status, 409);
  f.state.credit.estado = "PAGADO";
  f.state.credit.pazYSalvoEmitidoAt = new Date();
  assert.equal((await f.preview()).status, 409);
});
test("schema includes restrictive references, idempotency and append-only audit triggers", () => {
  const sql = creditPrincipalPaymentSchemaStatements.join("\n");
  assert.match(sql, /"abonoId" INTEGER NOT NULL UNIQUE REFERENCES/);
  assert.match(sql, /UNIQUE \("creditoId", "idempotencyKey"\)/);
  assert.match(sql, /UNIQUE \("creditoId", "revision"\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /BEFORE TRUNCATE/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/);
});
test("schema installation uses a transaction and rollback on failure", async () => {
  const calls = [];
  await assert.rejects(installCreditPrincipalPaymentSchema({ query: async sql => {
    calls.push(sql);
    if (sql.startsWith("ALTER TABLE")) throw new Error("test failure");
  } }), /test failure/);
  assert.equal(calls[0], "BEGIN");
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.ok(!calls.includes("COMMIT"));
});
test("existing destructive and calendar APIs guard the principal revision", () => {
  const payments = readFileSync(new URL("../app/api/creditos/[id]/abonos/[abonoId]/route.ts", import.meta.url), "utf8");
  const command = readFileSync(new URL("../app/api/creditos/[id]/command/route.ts", import.meta.url), "utf8");
  assert.equal((payments.match(/if \(abono.credito.planCapitalVigente\)/g) || []).length, 2);
  assert.match(command, /current.planCapitalVigente && \(command === "update-plan" \|\| command === "update-due-date" \|\| command === "annul-credit"\)/);
  assert.equal((command.match(/planCapitalVigente: \{ equals: Prisma.DbNull \}/g) || []).length, 4);
  assert.match(command, /where: \{ id: creditId, updatedAt: current.updatedAt, planCapitalVigente: \{ equals: Prisma.DbNull \} \}/);
});

function nativeFixture(options = {}) {
  const native = makeNativeCapitalFixture({ paidInstallments: 3, signed: true, ...options });
  const f = fixture({ realCore: true, credit: {
    ...native.credit, id: 7, folio: "TEST-NATIVE", clienteNombre: "TEST", sedeId: 1,
    estado: "GENERADO", pazYSalvoEmitidoAt: null, fechaProximoPago: null,
    amortizacion: { ...native.credit.amortizacion, creditoId: 7 },
  }, abonos: native.abonos.map(payment => ({ ...payment, fechaAbono: new Date("2026-09-26T12:00:00Z") })) });
  const body = { accion: "PREVISUALIZAR", valor: 300000, metodoPago: "EFECTIVO", observacion: "TEST" };
  return { ...f, native, body, preview: () => f.post(body),
    confirm: quoteHash => f.post({ ...body, accion: "CONFIRMAR", quoteHash, idempotencyKey: "native-request-000001" }) };
}

test("native GET returns the UI context contract without exposing financial source or writing", async () => {
  const f = nativeFixture();
  const result = await f.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.creditoId, 7);
  assert.equal(result.body.modoConciliacion, "AUTOMATICA");
  assert.equal(result.body.requiereConciliacion, false);
  assert.equal(result.body.capitalPendiente, Math.round(f.native.calculated.cuotas[3].saldoInicial * 100) / 100);
  assert.equal(result.body.conciliacion, undefined);
  assert.equal(result.body.contratoSnapshot, undefined);
  assert.equal(f.state.locks, 0);
  assert.equal(f.state.revisions.length, 0);
  assert.equal(f.state.caja.length, 0);
});

test("GET and locked principal preview resolve the scoped administrative amortization instead of original terms", async () => {
  const f = nativeFixture({ signed: false });
  f.state.revisedAmortization = structuredClone(f.state.credit.amortizacion);
  // The operative credit matches the revision; the preserved original has an
  // older term and must not silently become the source for the new operation.
  f.state.credit.amortizacion.numeroCuotas = 39;
  const original = structuredClone(f.state.credit.amortizacion);
  const get = await f.get();
  assert.equal(get.status, 200);
  assert.equal(get.body.modoConciliacion, "AUTOMATICA");
  assert.equal(f.state.amortizationReads[0].creditId, 7);
  assert.equal(f.state.amortizationReads[0].transactional, false);
  const preview = await f.preview();
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(f.state.amortizationReads[1].creditId, 7);
  assert.equal(f.state.amortizationReads[1].transactional, true);
  assert.equal(f.state.amortizationReads[1].locks, 1);
  assert.equal((await f.confirm(preview.body.quoteHash)).status, 200);
  assert.deepEqual(f.state.credit.amortizacion, original);
  assert.equal(f.state.caja.length, 1);
});

test("a changed administrative revision invalidates a principal preview before any payment writes", async () => {
  const f = nativeFixture({ signed: false });
  f.state.revisedAmortization = structuredClone(f.state.credit.amortizacion);
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  f.state.revisedAmortization.checksum = "c".repeat(64);
  const confirmed = await f.confirm(preview.body.quoteHash);
  assert.equal(confirmed.status, 409);
  assert.equal(f.state.caja.length, 0);
  assert.equal(f.state.revisions.length, 0);
  assert.equal(f.state.abonos.length, 1);
});

test("invalid administrative amortization cannot fall back to a valid original for automatic principal quotes", async () => {
  const f = nativeFixture();
  f.state.revisedAmortization = structuredClone(f.state.credit.amortizacion);
  f.state.revisedAmortization.cuotas.pop();
  const get = await f.get();
  assert.equal(get.status, 200);
  assert.equal(get.body.modoConciliacion, "MANUAL");
  assert.equal(get.body.requiereConciliacion, true);
  assert.equal((await f.preview()).status, 400);
  assert.equal(f.state.caja.length, 0);
});

test("administrative revision lookup failure aborts GET and locked preview instead of using original terms", async () => {
  const f = nativeFixture();
  f.state.revisionReadError = true;
  assert.equal((await f.get()).status, 500);
  assert.equal((await f.preview()).status, 500);
  assert.equal(f.state.caja.length, 0);
  assert.equal(f.state.revisions.length, 0);
});

test("a current revision does not bypass a contradictory signed financial seal", async () => {
  const f = nativeFixture();
  f.state.revisedAmortization = structuredClone(f.state.credit.amortizacion);
  f.state.credit.contratoSnapshot.financiero.selloFinanciero.checksum = "d".repeat(64);
  assert.equal((await f.get()).body.modoConciliacion, "MANUAL");
  assert.equal((await f.preview()).status, 400);
  assert.equal(f.state.caja.length, 0);
});

for (const version of ["FRANCES_V1", "ARES_FRANCES_V1", "ARES_FRANCES_V2"]) {
  test(`native ${version} first principal payment needs only amount, audits stored rate and preserves originals`, async () => {
    const f = nativeFixture({ version, partial: 900 });
    const original = structuredClone(f.state.credit.amortizacion);
    const contract = structuredClone(f.state.credit.contratoSnapshot);
    const preview = await f.preview();
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const result = await f.confirm(preview.body.quoteHash);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.quote.saldoCapitalAntes, Math.round(f.native.calculated.cuotas[3].saldoInicial * 100) / 100);
    assert.equal(Math.round((result.body.quote.saldoCapitalAntes - result.body.quote.saldoCapitalDespues) * 100), 30000000);
    assert.equal(result.body.quote.planCapitalVigente.cuotas[3].valorAbonadoAlCorte, 900);
    assert.equal(result.body.quote.planCapitalVigente.parametros.tasaPeriodo, Number(original.tasaPeriodo));
    assert.match(f.state.revisions[0].conciliacion.fuente, /automatica FINSERPAY/);
    assert.deepEqual(f.state.credit.amortizacion, original);
    assert.deepEqual(f.state.credit.contratoSnapshot, contract);
    assert.equal(f.state.credit.plazoMeses, 40);
    assert.equal(f.state.caja.length, 1);
    assert.equal(f.state.caja[0].valor, 300000);
    assert.equal((await f.get()).body.modoConciliacion, "VIGENTE");
    const repeat = await f.confirm(preview.body.quoteHash);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.alreadyApplied, true);
    assert.equal(f.state.caja.length, 1);
  });
}

test("native request cannot override reconciled principal or rate with client values", async () => {
  const f = nativeFixture();
  const result = await f.post({ ...f.body, conciliacion: f.base.conciliacion });
  assert.equal(result.status, 409);
  assert.equal(f.state.caja.length, 0);
});

test("imported and incomplete credits cannot bypass manual reconciliation by posting automatic mode", async () => {
  for (const mutate of [
    f => { f.state.credit.observacionAdmin = "[IMPORTACION_MASIVA_SIN_BLOQUEO]"; },
    f => { f.state.credit.amortizacion = null; },
    f => { f.state.credit.amortizacion.cuotas.pop(); },
  ]) {
    const f = nativeFixture(); mutate(f);
    const context = await f.get();
    assert.equal(context.body.requiereConciliacion, true);
    assert.equal(context.body.modoConciliacion, "MANUAL");
    const result = await f.post({ ...f.body, modoConciliacion: "AUTOMATICA", requiereConciliacion: false });
    assert.equal(result.status, 400);
    assert.equal(f.state.caja.length, 0);
  }
});

test("native preview binds original terms and paid state before any confirm writes", async () => {
  for (const mutate of [
    f => { f.state.credit.amortizacion.checksum = "b".repeat(64); },
    f => { f.state.abonos.push({ id: 300, valor: 100, fechaAbono: new Date("2026-09-26T13:00:00Z") }); },
    f => { f.state.credit.fechaProximoPago = new Date("2030-12-02T12:00:00Z"); },
  ]) {
    const f = nativeFixture();
    const preview = await f.preview();
    assert.equal(preview.status, 200);
    mutate(f);
    const result = await f.confirm(preview.body.quoteHash);
    assert.ok([400, 409].includes(result.status), JSON.stringify(result.body));
    assert.equal(f.state.caja.length, 0);
    assert.equal(f.state.credit.planCapitalVigente, null);
  }
});

test("native concurrent confirmation stays idempotent and failed audit rolls back every write", async () => {
  const f = nativeFixture();
  const preview = await f.preview();
  f.state.failPersistence = true;
  assert.equal((await f.confirm(preview.body.quoteHash)).status, 500);
  assert.equal(f.state.credit.planCapitalVigente, null);
  assert.equal(f.state.caja.length, 0);
  assert.equal(f.state.abonos.length, 1);
  f.state.failPersistence = false;
  const responses = await Promise.all([f.confirm(preview.body.quoteHash), f.confirm(preview.body.quoteHash)]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(f.state.caja.length, 1);
  assert.equal(f.state.revisions.length, 1);
});

for(const method of ["BANCOLOMBIA","BRE-B"])test(method+" se conserva al confirmar un abono a capital",async()=>{const f=fixture();f.base.metodoPago=method;const preview=await f.preview();assert.equal(preview.status,200);const result=await f.confirm(preview.body.quoteHash);assert.equal(result.status,200);assert.equal(f.state.abonos.at(-1).metodoPago,method);});

function historicalRateFixture({ partial = false } = {}) {
  // Synthetic historical cut: the later ordinary receipt finishes installment1.
  // Its paid principal/components and all existing receipt ids must survive.
  const snapshot = {
    version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 1, numeroCuotasOriginal: 3,
    requiereConciliacionTasaPeriodo: true,
    totalAbonadoAlCorte: 250, abonosAlCorte: [{ id: 10, valor: 80 }, { id: 11, valor: 170 }],
    saldoCapitalAlCorte: 250,
    parametros: { capitalPendiente: 250, tasaPeriodo: 0, cuotaCredito: 100,
      fianzaCuota: 20, seguroCuota: 3, numeroProximaCuota: 1,
      fuente: "Correccion historica sintetica; la tasa no esta documentada" },
    cuotas: [
      { numero: 1, fechaVencimiento: "2030-01-10", valorProgramado: 115, valorAbonadoAlCorte: 80,
        eliminada: false, capital: 80, interes: 12, fianza: 20, seguro: 3, saldoCapital: 220,
        componentesAbonadosAlCorte: { capital: 50, interes: 12, fianza: 15, seguro: 3 } },
      { numero: 2, fechaVencimiento: "2030-01-25", valorProgramado: 133, valorAbonadoAlCorte: 0,
        eliminada: false, capital: 100, interes: 10, fianza: 20, seguro: 3, saldoCapital: 120 },
      { numero: 3, fechaVencimiento: "2030-02-10", valorProgramado: 151, valorAbonadoAlCorte: 0,
        eliminada: false, capital: 120, interes: 8, fianza: 20, seguro: 3, saldoCapital: 0 },
    ],
  };
  const priorRevision = { creditoId: 7, revision: 1, idempotencyKey: "historical-source-0001",
    snapshotBefore: null, snapshotAfter: structuredClone(snapshot), conciliacion: structuredClone(snapshot.parametros) };
  const f = fixture({ realCore: true, credit: {
    id: 7, folio: "TEST-HISTORICAL", clienteNombre: "Cliente sintetico", sedeId: 1,
    estado: "GENERADO", pazYSalvoEmitidoAt: null, saldoBaseFinanciado: 470,
    montoCredito: 569, valorCuota: 123, plazoMeses: 3, frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: new Date("2030-01-10T12:00:00Z"), fechaProximoPago: new Date(`${partial ? "2030-01-10" : "2030-01-25"}T12:00:00Z`),
    planCapitalVigente: snapshot,
  }, abonos: [
    { id: 10, valor: 80, fechaAbono: new Date("2026-09-01T12:00:00Z") },
    { id: 11, valor: 170, fechaAbono: new Date("2026-09-01T12:01:00Z") },
    ...(!partial ? [{ id: 12, valor: 35, fechaAbono: new Date("2026-09-26T12:00:00Z") }] : []),
  ], revisions: [priorRevision] });
  const body = { accion: "PREVISUALIZAR", valor: 50, metodoPago: "EFECTIVO", observacion: "Prueba sintetica",
    conciliacion: { capitalPendiente: partial ? 250 : 220, tasaPeriodo: 0.01, cuotaCredito: 100,
      fianzaCuota: 20, seguroCuota: 3, numeroProximaCuota: partial ? 1 : 2,
      fuente: "Contrato sintetico original, tasa quincenal documentada y verificada" } };
  return { ...f, body, preview: () => f.post(body),
    confirm: quoteHash => f.post({ ...body, accion: "CONFIRMAR", quoteHash, idempotencyKey: "historical-rate-00001" }) };
}

test("marked historical GET exposes manual reconciliation and actual principal without writes", async () => {
  const f = historicalRateFixture();
  const before = structuredClone({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions });
  const result = await f.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.modoConciliacion, "MANUAL");
  assert.equal(result.body.requiereConciliacion, true);
  assert.equal(result.body.capitalPendiente, 220);
  assert.match(result.body.motivoConciliacion, /tasa periódica.*no está documentada/);
  assert.equal(result.body.conciliacion, undefined);
  assert.equal(f.state.locks, 0);
  assert.deepEqual({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions }, before);
});

test("marked historical preview accepts explicit documentation without changing the live rate marker or payments", async () => {
  const f = historicalRateFixture();
  const before = structuredClone({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions });
  const missing = await f.post({ ...f.body, conciliacion: undefined });
  assert.equal(missing.status, 400);
  const preview = await f.preview();
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.quote.saldoCapitalAntes, 220);
  assert.equal(preview.body.quote.saldoCapitalDespues, 170);
  assert.equal(preview.body.quote.planCapitalVigente.requiereConciliacionTasaPeriodo, false);
  assert.equal(f.state.credit.planCapitalVigente.requiereConciliacionTasaPeriodo, true);
  assert.equal(f.state.caja.length, 0);
  assert.deepEqual({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions }, before);
});

test("marked historical preview rejects forged capital, next installment and incomplete sources without writes", async () => {
  for (const change of [
    { capitalPendiente: 219 }, { capitalPendiente: 250 }, { numeroProximaCuota: 1 },
    { numeroProximaCuota: 3 }, { tasaPeriodo: null }, { fuente: "" }, { cuotaCredito: 101 },
  ]) {
    const f = historicalRateFixture();
    const before = structuredClone({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions });
    const result = await f.post({ ...f.body, conciliacion: { ...f.body.conciliacion, ...change } });
    assert.equal(result.status, 400, JSON.stringify({ change, response: result.body }));
    assert.equal(f.state.caja.length, 0);
    assert.deepEqual({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions }, before);
  }
});

test("documented historical confirmation audits the source, preserves receipts and replays only one cash movement", async () => {
  const f = historicalRateFixture();
  const creditBefore = structuredClone(f.state.credit);
  const receiptsBefore = structuredClone(f.state.abonos);
  const priorAudit = structuredClone(f.state.revisions[0]);
  const preview = await f.preview();
  const responses = await Promise.all([f.confirm(preview.body.quoteHash), f.confirm(preview.body.quoteHash)]);
  assert.ok(responses.every(result => result.status === 200), JSON.stringify(responses));
  assert.equal(responses.filter(result => result.body.alreadyApplied).length, 1);
  assert.equal(responses[0].body.abonoId, responses[1].body.abonoId);
  assert.deepEqual(f.state.abonos.slice(0, receiptsBefore.length), receiptsBefore);
  assert.equal(f.state.abonos.length, receiptsBefore.length + 1);
  assert.equal(f.state.abonos.at(-1).valor, 50);
  assert.equal(f.state.caja.length, 1);
  assert.equal(f.state.caja[0].valor, 50);
  assert.equal(f.state.revisions.length, 2);
  assert.deepEqual(f.state.revisions[0], priorAudit);
  assert.deepEqual(f.state.revisions[1].snapshotBefore, creditBefore.planCapitalVigente);
  assert.deepEqual(f.state.revisions[1].snapshotAfter, structuredClone(f.state.credit.planCapitalVigente));
  assert.deepEqual(f.state.revisions[1].conciliacion, f.body.conciliacion);
  assert.equal(f.state.credit.planCapitalVigente.revision, 2);
  assert.equal(f.state.credit.planCapitalVigente.requiereConciliacionTasaPeriodo, false);
  assert.equal(f.state.credit.planCapitalVigente.parametros.tasaPeriodo, 0.01);
  assert.equal(f.state.credit.planCapitalVigente.cuotas[1].interes, 2);
  assert.equal(f.state.credit.planCapitalVigente.cuotas[0].valorAbonadoAlCorte, 115);
  assert.deepEqual(f.state.credit.planCapitalVigente.cuotas[0].componentesAbonadosAlCorte,
    { capital: 80, interes: 12, fianza: 20, seguro: 3 });
  assert.equal(f.state.credit.saldoBaseFinanciado, creditBefore.saldoBaseFinanciado);
  assert.equal(f.state.credit.plazoMeses, creditBefore.plazoMeses);
  assert.equal((await f.get()).body.modoConciliacion, "VIGENTE");
  assert.equal((await f.preview()).status, 400, "A verified revision cannot accept replacement terms");
});

test("historical reconciliation becomes stale after ordinary payments or a source revision and leaves no new payment", async () => {
  for (const change of [
    f => { f.state.abonos.push({ id: 30, valor: 40, fechaAbono: new Date("2026-09-26T13:00:00Z") }); },
    f => { f.state.credit.planCapitalVigente.revision++; },
    f => { f.body.conciliacion.fuente += "; documento cambiado"; },
  ]) {
    const f = historicalRateFixture();
    const preview = await f.preview();
    assert.equal(preview.status, 200);
    change(f);
    const before = structuredClone({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions });
    const result = await f.confirm(preview.body.quoteHash);
    assert.ok([400, 409].includes(result.status), JSON.stringify(result.body));
    assert.equal(f.state.caja.length, 0);
    assert.deepEqual({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions }, before);
  }
});

test("failed historical audit rolls back the new cash receipt and keeps its rate pending documentation", async () => {
  const f = historicalRateFixture();
  const preview = await f.preview();
  const before = structuredClone({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions });
  f.state.failPersistence = true;
  assert.equal((await f.confirm(preview.body.quoteHash)).status, 500);
  assert.equal(f.state.caja.length, 0);
  assert.deepEqual({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions }, before);
  f.state.failPersistence = false;
  assert.equal((await f.confirm(preview.body.quoteHash)).status, 200);
  assert.equal(f.state.caja.length, 1);
  assert.equal(f.state.revisions.length, 2);
});

test("historical partial installment stays intact through preview, confirmation and a later ordinary payment", async () => {
  const f = historicalRateFixture({ partial: true });
  const before = structuredClone({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions });
  const context = await f.get();
  assert.equal(context.body.modoConciliacion, "MANUAL");
  assert.equal(context.body.capitalPendiente, 250);
  const preview = await f.preview();
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.quote.cuotaParcialConservada, { numero: 1, saldoPendiente: 35 });
  assert.equal(preview.body.quote.saldoCapitalDespues, 200);
  assert.deepEqual({ credit: f.state.credit, abonos: f.state.abonos, revisions: f.state.revisions }, before);
  assert.equal((await f.confirm(preview.body.quoteHash)).status, 200);
  assert.deepEqual(f.state.abonos.slice(0, 2), before.abonos);
  assert.equal(f.state.caja.length, 1);
  assert.equal(f.state.caja[0].valor, 50);
  assert.deepEqual(structuredClone(f.state.credit.planCapitalVigente.cuotas[0]),
    { ...before.credit.planCapitalVigente.cuotas[0], saldoCapital: 170 });
  assert.equal(f.state.credit.fechaProximoPago.toISOString().slice(0, 10), "2030-01-10");
  assert.deepEqual(f.state.revisions[1].snapshotBefore, before.credit.planCapitalVigente);
  assert.equal(f.state.revisions[1].snapshotAfter.requiereConciliacionTasaPeriodo, false);
  const repeatBody = { accion: "PREVISUALIZAR", valor: 40, metodoPago: "EFECTIVO", observacion: "Segundo extra sintetico" };
  const repeatPreview = await f.post(repeatBody);
  assert.equal(repeatPreview.status, 200, JSON.stringify(repeatPreview.body));
  assert.equal(repeatPreview.body.quote.saldoCapitalAntes, 200);
  assert.equal(repeatPreview.body.quote.saldoCapitalDespues, 160);
  assert.deepEqual(repeatPreview.body.quote.cuotaParcialConservada, { numero: 1, saldoPendiente: 35 });
  const confirmation = { ...repeatBody, accion: "CONFIRMAR", quoteHash: repeatPreview.body.quoteHash,
    idempotencyKey: "historical-rate-00002" };
  const responses = await Promise.all([f.post(confirmation), f.post(confirmation)]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(f.state.caja.length, 2);
  assert.equal(f.state.caja.reduce((sum, movement) => sum + movement.valor, 0), 90);
  assert.equal(f.state.revisions.length, 3);
  assert.deepEqual(structuredClone(f.state.credit.planCapitalVigente.cuotas[0]),
    { ...before.credit.planCapitalVigente.cuotas[0], saldoCapital: 130 });
  assert.equal((await f.get()).body.capitalPendiente, 160);
  f.state.abonos.push({ id: 30, valor: 35, fechaAbono: new Date("2026-09-26T13:00:00Z") });
  const plan = realPlan.buildCreditPaymentPlan({ ...f.state.credit, abonos: f.state.abonos, today: "2026-09-26" });
  assert.equal(plan.nextInstallment.numero, 2);
  assert.equal(plan.saldoCapitalPendiente, 130);
  assert.equal((await f.get()).body.capitalPendiente, 130);
  const rows = realCore.resolveCapitalPlanRows(f.state.credit.planCapitalVigente, 375);
  assert.deepEqual(rows[0].componentsPaid, { capital: 80, interes: 12, fianza: 20, seguro: 3 });
  assert.deepEqual(f.state.abonos.slice(0, 2), before.abonos);
});

test("historical partial principal cap protects the current installment while permitting all future capital to settle", async () => {
  const blocked = historicalRateFixture({ partial: true });
  const before = structuredClone({ credit: blocked.state.credit, abonos: blocked.state.abonos, revisions: blocked.state.revisions });
  const tooMuch = await blocked.post({ ...blocked.body, valor: 221 });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /capital de las cuotas futuras/);
  assert.equal(blocked.state.caja.length, 0);
  assert.deepEqual({ credit: blocked.state.credit, abonos: blocked.state.abonos, revisions: blocked.state.revisions }, before);
  const f = historicalRateFixture({ partial: true });
  f.body.valor = 220;
  const preview = await f.preview();
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.quote.saldoCapitalDespues, 30);
  assert.equal(preview.body.quote.ultimaCuota.numero, 1);
  assert.equal(preview.body.quote.cuotasEliminadas, 2);
  assert.equal((await f.confirm(preview.body.quoteHash)).status, 200);
  assert.equal((await f.get()).body.capitalPendiente, 30);
  assert.ok(f.state.credit.planCapitalVigente.cuotas.slice(1).every(row => row.eliminada && row.valorProgramado === 0));
  assert.equal(f.state.credit.planCapitalVigente.cuotas[0].valorAbonadoAlCorte, 80);
  assert.equal(f.state.caja[0].valor, 220);
});
