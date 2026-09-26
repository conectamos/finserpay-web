import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import path from "node:path";
import { creditPrincipalPaymentSchemaStatements, installCreditPrincipalPaymentSchema } from "../scripts/credit-principal-payment-schema.mjs";

const routeFile = new URL("../app/api/creditos/[id]/abono-capital/route.ts", import.meta.url);
const source = readFileSync(routeFile, "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const realCore = await jiti.import("../lib/credit-principal-payment.ts");
const realPlan = await jiti.import("../lib/credit-payment-plan.ts");
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
    ...options,
  };
  const tx = {
    $queryRaw: async () => { state.locks++; return [{ id: 7 }]; },
    credito: {
      findFirst: async () => state.credit,
      update: async ({ data }) => { Object.assign(state.credit, data); return state.credit; },
    },
    creditoAbono: {
      findMany: async () => state.abonos.map(x => ({ ...x })),
      create: async ({ data }) => { const item = { id: state.abonos.length + 1, ...data, fechaAbono: new Date("2026-09-26T12:01:00Z") }; state.abonos.push(item); return item; },
    },
    wompiPaymentIntent: { findFirst: async () => state.pendingWompi ? { id: 2 } : null },
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
    "@/lib/credit-factory": {
      normalizePaymentMethod: x => x || "EFECTIVO", sanitizeText: x => typeof x === "string" ? x.trim() : "",
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
  };
  if (options.realCore) {
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
  assert.equal((command.match(/planCapitalVigente: \{ equals: Prisma.DbNull \}/g) || []).length, 3);
});
