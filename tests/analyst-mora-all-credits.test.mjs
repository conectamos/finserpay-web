import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadApprovalModule, approvalErrors } from "./credit-approval-test-loader.mjs";
import { installAnalystMoraSchema } from "../scripts/analyst-mora-schema.mjs";

const now = new Date("2026-10-06T20:00:00Z");
const actor = { id: 7, nombre: "Analista sintético", centralAdmin: false };
const types = loadApprovalModule("lib/analyst-mora-types.ts");
const dates = loadApprovalModule("lib/colombia-date.ts");
const products = loadApprovalModule("lib/ally-payments-core.ts");
const numbers = loadApprovalModule("lib/credit-display-number.ts");
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const paymentPlan = await jiti.import("../lib/credit-payment-plan.ts");

function source(id = 81, patch = {}) {
  return { id, folio: `FC-${id}`, clienteNombre: `Cliente sintético ${id}`, clienteDocumento: `00123${id}`,
    clienteTelefono: "3001234567", estado: "ACTIVO", montoCredito: 1000000, valorCuota: 100000,
    plazoMeses: 10, frecuenciaPago: "QUINCENAL", fechaPrimerPago: new Date("2026-09-17T00:00:00Z"),
    fechaProximoPago: null, planCapitalVigente: null, pazYSalvoEmitidoAt: null, createdAt: now, fechaCredito: now,
    sede: { aliado: { id: 2, nombre: "Aliado sintético" } },
    registroSadmin: { numeroCredito: `000${id}`, numeroCreditoConfirmado: true }, abonos: [],
    imei: `00000000000${id}`, deviceUid: null, referenciaEquipo: "Equipo sintético", equipoMarca: "IPHONE", equipoModelo: "13",
    contratoSnapshot: { cliente: { referenciasFamiliares: [{ telefono: "3001111111" }, { telefono: "3002222222" }] } }, ...patch };
}
function input(patch = {}) {
  return { action: "LLAMADA", actedAt: "2026-10-06T14:30:00-05:00", responsibleUserId: actor.id,
    result: "SIN_RESPUESTA", comment: "Se registra la gestión del cliente", nextFollowUpAt: "2026-10-07T14:30:00-05:00",
    managementStatus: "SEGUIMIENTO", idempotencyKey: randomUUID(), ...patch };
}
async function fixture(t, rows = [source()]) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec('CREATE TABLE "Credito" ("id" INT PRIMARY KEY); CREATE TABLE "Usuario" ("id" INT PRIMARY KEY); INSERT INTO "Usuario" VALUES (7);');
  for (const credit of rows) await database.query('INSERT INTO "Credito" VALUES ($1)', [credit.id]);
  await installAnalystMoraSchema({ query: (sql, values) => database.query(sql, values) });
  const state = { rows, revoked: false, writes: 0, actorChecks: 0, listWhere: [] };
  const db = {
    credito: {
      findUnique: async ({ where }) => state.rows.find(credit => credit.id === where.id) || null,
      findMany: async ({ where }) => {
        state.listWhere.push(where);
        return state.rows.filter(credit => !where.pazYSalvoEmitidoAt || !credit.pazYSalvoEmitidoAt)
          .filter(credit => !where.estado?.notIn?.includes(credit.estado));
      },
    },
    $queryRawUnsafe: async (sql, ...values) => {
      if (sql.includes('FROM "Usuario" u')) return [{ id: actor.id, nombre: actor.nombre }];
      if (sql.startsWith('INSERT INTO "CreditMoraManagementEvent"')) state.writes++;
      return (await database.query(sql, values)).rows;
    },
  };
  const prisma = { ...db, $transaction: callback => callback(db) };
  const creditService = loadApprovalModule("lib/analyst-mora-credit.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/credit-payment-plan": paymentPlan, "@/lib/colombia-date": dates,
    "@/lib/credit-display-number": numbers, "@/lib/credit-approval-errors": approvalErrors, "@/lib/ally-payments-core": products,
  });
  const service = loadApprovalModule("lib/analyst-mora-management.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/credit-approval-errors": approvalErrors,
    "@/lib/analyst-mora-access": { assertMoraActor: async () => {
      state.actorChecks++;
      if (state.revoked) throw new approvalErrors.CreditApprovalError("FORBIDDEN", "Rol revocado", 403);
      return actor;
    } },
    "@/lib/analyst-mora-credit": { ...creditService, moraCreditSummary: credit => creditService.moraCreditSummary(credit, now) },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-types": types, "@/lib/colombia-date": dates,
    "@/lib/analyst-mora-extension": { readActiveMoraExtensions: async () => new Map() },
  });
  return { state, database, service, creditService };
}

test("la misma gestión de mora permanece al ponerse al día, pagar y anular; las nuevas se anexan sin borrar ni copiar", async t => {
  const { state, service, database } = await fixture(t);
  const first = await service.createMoraManagement(81, service.parseMoraManagement(input(), now), actor);
  assert.equal((await service.listMoraPortfolio(new URLSearchParams(), now)).total, 1);
  const initialHistory = (await service.getMoraManagement(81, now)).history;
  assert.equal(initialHistory[0].id, first.item.id);

  state.rows[0].abonos.push({ valor: 200000, fechaAbono: now });
  assert.equal((await service.listMoraPortfolio(new URLSearchParams(), now)).total, 0);
  const current = await service.getCreditManagement(81, now);
  assert.equal(current.credit.estadoCartera, "AL_DIA");
  assert.equal(current.credit.fechaProximoPago, "2026-10-17");
  assert.equal(current.credit.saldoPendiente, 800000);
  assert.deepEqual(current.history, initialHistory);
  assert.equal((await service.listCreditPortfolio(new URLSearchParams("financialStatus=AL_DIA"), now)).items[0].ultimaGestion.id, first.item.id);
  await assert.rejects(service.createMoraManagement(81, service.parseMoraManagement(input(), now), actor), error => error.code === "NOT_OVERDUE");

  const reminderInput = service.parseCreditManagement(input({ action: "MSJ_TEXTO", result: "RECORDATORIO_PAGO" }), now);
  const reminder = await service.createCreditManagement(81, reminderInput, actor);
  assert.equal(reminder.item.result, "Recordatorio de pago");
  assert.equal(reminder.item.resultCode, "RECORDATORIO_PAGO");
  assert.equal((await service.createCreditManagement(81, reminderInput, actor)).unchanged, true);
  assert.equal(state.writes, 2);
  await assert.rejects(service.createCreditManagement(81, { ...reminderInput, comment: "Contenido distinto" }, actor), error => error.code === "IDEMPOTENCY_CONFLICT");
  await assert.rejects(service.createCreditManagement(81, input({ responsibleUserId: 8 }), actor), error => error.code === "RESPONSIBLE_MISMATCH");

  for (const patch of [{ abonos: [{ valor: 1000000, fechaAbono: now }] }, { pazYSalvoEmitidoAt: now }, { estado: "ANULADO" }]) {
    Object.assign(state.rows[0], patch);
    const detail = await service.getCreditManagement(81, now);
    assert.equal(detail.credit.estadoCartera, state.rows[0].estado === "ANULADO" ? "ANULADO" : "PAGADO");
    assert.equal(detail.history.length, 2);
    assert.deepEqual(detail.history.find(event => event.id === first.item.id), initialHistory[0]);
    const ledger = await database.query('SELECT COUNT(*)::int AS n FROM "CreditMoraManagementEvent"');
    assert.equal(ledger.rows[0].n, 2);
  }
  await assert.rejects(service.getMoraManagement(81, now), error => error.code === "CREDIT_NOT_FOUND");
  state.revoked = true;
  await assert.rejects(service.createCreditManagement(81, input(), actor), error => error.status === 403);
  assert.equal(state.writes, 2);
  assert.ok(state.actorChecks >= 7, "cada escritura, incluso un reintento, revalida al actor");
});

test("el listado incluye estados financieros separados de la gestión y filtra antes de paginar", async t => {
  const rows = [source(81), source(82, { fechaPrimerPago: new Date("2026-10-17T00:00:00Z") }),
    source(83, { pazYSalvoEmitidoAt: now }), source(84, { estado: "CANCELADO" })];
  const { service, state } = await fixture(t, rows);
  const list = await service.listCreditPortfolio(new URLSearchParams(), now);
  assert.equal(list.total, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(list.counts)), { total: 4, enMora: 1, alDia: 1, pagados: 1, anulados: 1 });
  assert.deepEqual(Object.keys(state.listWhere.at(-1)), [], "todos incluye saldados y anulados, sin límite histórico oculto");
  assert.equal(list.items.every(item => item.estadoGestion === "PENDIENTE"), true);
  for (const [financialStatus, id] of [["EN_MORA", 81], ["AL_DIA", 82], ["PAGADO", 83], ["ANULADO", 84]]) {
    const result = await service.listCreditPortfolio(new URLSearchParams({ financialStatus }), now);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, id);
    assert.equal(result.counts.total, 4, "los contadores conservan los demás estados para cambiar de vista");
  }
  const search = await service.listCreditPortfolio(new URLSearchParams("q=0012382&financialStatus=AL_DIA&status=PENDIENTE"), now);
  assert.equal(search.total, 1);
  assert.equal(search.counts.total, 1);
  assert.equal((await service.listCreditPortfolio(new URLSearchParams("financialStatus=EN_MORA&maxDays=0"), now)).total, 0);
  await assert.rejects(service.listCreditPortfolio(new URLSearchParams("financialStatus=SEGUIMIENTO"), now), error => error.code === "INVALID_FILTER");
  state.rows.push(...Array.from({ length: 30 }, (_, index) => source(100 + index, { fechaPrimerPago: new Date("2026-10-17T00:00:00Z") })));
  const second = await service.listCreditPortfolio(new URLSearchParams("financialStatus=AL_DIA&maxDays=0&page=2"), now);
  assert.equal(second.total, 31);
  assert.equal(second.items.length, 6);
  assert.equal(second.items.every(item => item.estadoCartera === "AL_DIA"), true);
  assert.equal(second.hasMore, false);
});

test("recordatorio es un resultado del nuevo módulo y no modifica los contratos anteriores de mora", async t => {
  const { service, creditService } = await fixture(t);
  assert.equal(service.parseCreditManagement(input({ result: "RECORDATORIO_PAGO" }), now).result, "RECORDATORIO_PAGO");
  assert.throws(() => service.parseMoraManagement(input({ result: "RECORDATORIO_PAGO" }), now), error => error.code === "INVALID_REQUEST");
  for (const id of [NaN, 0, -1, 0.5]) {
    await assert.rejects(service.getCreditManagement(id, now), error => error.code === "INVALID_CREDIT");
    await assert.rejects(service.createCreditManagement(id, input(), actor), error => error.code === "INVALID_CREDIT");
  }
  await assert.rejects(creditService.readMoraCredit(999, true), error => error.code === "CREDIT_NOT_FOUND");
});
