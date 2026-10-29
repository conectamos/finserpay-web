import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { loadApprovalModule, approvalErrors, plain } from "./credit-approval-test-loader.mjs";

const now = new Date("2026-10-06T20:00:00Z");
const dates = loadApprovalModule("lib/colombia-date.ts");
const types = loadApprovalModule("lib/analyst-mora-types.ts");
const products = loadApprovalModule("lib/ally-payments-core.ts");
const numbers = loadApprovalModule("lib/credit-display-number.ts");
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const paymentPlan = await jiti.import("../lib/credit-payment-plan.ts");

function source(id, patch = {}) {
  return {
    id, folio: `FC-${id}`, clienteNombre: `Cliente sintético ${id}`, clienteDocumento: `000123${id}`,
    clienteTelefono: "3001234567", estado: "ACTIVO", montoCredito: 1000000, valorCuota: 100000,
    plazoMeses: 10, frecuenciaPago: "QUINCENAL", fechaPrimerPago: new Date(id <= 30 ? "2026-09-17T00:00:00Z" : "2026-10-01T00:00:00Z"),
    fechaProximoPago: null, planCapitalVigente: null, pazYSalvoEmitidoAt: null,
    createdAt: now, fechaCredito: now, sede: { aliado: { id: id <= 30 ? 2 : 3, nombre: `Aliado ${id <= 30 ? 2 : 3}` } },
    registroSadmin: { numeroCredito: `00000${id}`, numeroCreditoConfirmado: true }, abonos: [],
    imei: `00000000000${id}`, deviceUid: null, referenciaEquipo: "Equipo sintético", equipoMarca: "IPHONE", equipoModelo: "13",
    ...patch,
  };
}

function fixture() {
  const rows = Array.from({ length: 60 }, (_, index) => source(index + 1));
  rows.push(source(61, { fechaPrimerPago: new Date("2026-10-17T00:00:00Z") }),
    source(62, { abonos: [{ valor: 1000000, fechaAbono: now }] }), source(63, { estado: "ANULADO" }),
    source(64, { pazYSalvoEmitidoAt: now }));
  const events = rows.map(row => ({
    id: `event-${row.id}`, creditoId: row.id, action: "LLAMADA", managementStatus: "SIN_RESPUESTA",
    actedAt: now, createdAt: now, nextFollowUpAt: new Date(row.id <= 30 ? "2026-10-08T04:30:00Z" : "2026-10-08T05:30:00Z"),
    responsibleUserId: row.id <= 30 ? 7 : 9, responsibleName: "Analista sintético", actorUserId: 7, actorName: "Analista sintético",
    result: "No contesta", resultCode: "SIN_RESPUESTA", requestHash: "private-request-hash",
  }));
  const calls = [];
  const prisma = {
    credito: { findMany: async ({ where, select }) => {
      calls.push({ type: "credits", where, select });
      return rows.filter(row => !where.estado?.notIn?.includes(row.estado))
        .filter(row => !("pazYSalvoEmitidoAt" in where) || row.pazYSalvoEmitidoAt === where.pazYSalvoEmitidoAt);
    } },
    $queryRawUnsafe: async sql => {
      assert.match(sql, /^SELECT/);
      calls.push({ type: sql.includes('FROM "CreditMoraManagementEvent"') ? "events" : "responsibles" });
      return sql.includes('FROM "CreditMoraManagementEvent"') ? events : [{ id: 7, nombre: "Analista sintético" }];
    },
  };
  const creditService = loadApprovalModule("lib/analyst-mora-credit.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/credit-payment-plan": paymentPlan, "@/lib/colombia-date": dates,
    "@/lib/credit-display-number": numbers, "@/lib/credit-approval-errors": approvalErrors, "@/lib/ally-payments-core": products,
  });
  const service = loadApprovalModule("lib/analyst-mora-management.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/credit-approval-errors": approvalErrors,
    "@/lib/analyst-mora-access": {}, "@/lib/analyst-mora-credit": {
      ...creditService, moraCreditSummary: (credit, clock) => {
        calls.push({ type: "summary", clock });
        return creditService.moraCreditSummary(credit, clock);
      },
    },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-types": types, "@/lib/colombia-date": dates,
    "@/lib/analyst-mora-extension": { readActiveMoraExtensions: async (ids, clock) => {
      calls.push({ type: "extensions", ids, clock });
      return new Map(ids.filter(id => id <= 30).map(id => [id, {
        id: `extension-${id}`, expiresOn: "2026-10-07", reason: "Prórroga autorizada", approvedAt: now.toISOString(),
        approvedByName: "Administrador sintético", installmentNumber: 1, installmentDueDate: "2026-09-17",
      }]));
    } },
  });
  return { service, calls, rows };
}

test("exporta más de 25 resultados en una sola lectura y un solo reloj, sin ampliar el alcance de mora", async () => {
  const f = fixture();
  const result = await f.service.exportMoraPortfolio(new URLSearchParams("page=incorrecta&financialStatus=AL_DIA"), now);
  assert.equal(result.items.length, 60);
  assert.deepEqual(Array.from(result.items, row => row.id), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.ok(result.items.every(row => row.enMora && row.estadoCartera === "EN_MORA"));
  assert.equal(result.items[0].diasMora, 19);
  assert.equal(result.items[0].valorVencido, 200000);
  assert.equal(result.items[30].diasMora, 4, "el plan quincenal real ajusta el vencimiento al día 2");
  assert.equal(result.items[30].valorVencido, 100000);
  for (const type of ["credits", "events", "extensions"]) assert.equal(f.calls.filter(call => call.type === type).length, 1, type);
  assert.equal(f.calls.filter(call => call.type === "responsibles").length, 0);
  assert.ok(f.calls.filter(call => call.clock).every(call => call.clock === now));
  const select = f.calls.find(call => call.type === "credits").select;
  assert.equal(select.contratoSnapshot, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-request-hash|contratoSnapshot/);
});

test("filtros combinados de búsqueda, aliado, responsable, días, prórroga y seguimiento coinciden con todas las páginas", async () => {
  const f = fixture();
  const filters = "q=CLIENTE%20SINTÉTICO&ally=2&responsible=7&minDays=19&maxDays=19&status=PRORROGA&followUp=2026-10-07";
  const exported = await f.service.exportMoraPortfolio(new URLSearchParams(filters), now);
  const first = await f.service.listMoraPortfolio(new URLSearchParams(filters), now);
  const second = await f.service.listMoraPortfolio(new URLSearchParams(`${filters}&page=2`), now);
  assert.equal(exported.items.length, 30);
  assert.equal(first.items.length, 25);
  assert.equal(first.total, 30);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 5);
  assert.equal(second.hasMore, false);
  assert.deepEqual(plain(exported.items), plain([...first.items, ...second.items]));
  assert.ok(exported.items.every(row => row.estadoGestion === "PRORROGA" && row.prorrogaActiva));
  assert.ok(exported.items.every(row => row.ultimaGestion.managementStatus === "SIN_RESPUESTA"));
  const other = await f.service.exportMoraPortfolio(new URLSearchParams("status=SIN_RESPUESTA&followUp=2026-10-08"), now);
  assert.equal(other.items.length, 30);
  assert.ok(other.items.every(row => row.id > 30 && row.prorrogaActiva === null));
});

test("búsqueda exacta y filtros vacíos o sin coincidencias conservan los resultados del listado", async () => {
  const f = fixture();
  for (const query of ["q=0000059", "q=Cliente+sintético+31", "ally=99", "responsible=99", "minDays=50", "maxDays=0", "status=PENDIENTE", "q=&status=&followUp="]) {
    const exported = await f.service.exportMoraPortfolio(new URLSearchParams(query), now);
    const listed = await f.service.listMoraPortfolio(new URLSearchParams(query), now);
    assert.equal(exported.items.length, listed.total, query);
    assert.deepEqual(plain(exported.items.slice(0, 25)), plain(listed.items), query);
  }
  assert.equal((await f.service.exportMoraPortfolio(new URLSearchParams("q=0000059"), now)).items[0].id, 59);
});

test("exportación y listado rechazan los mismos filtros inválidos; solo el listado valida página", async () => {
  const f = fixture();
  for (const query of ["q=" + "x".repeat(101), "ally=-1", "responsible=abc", "minDays=1.5", "maxDays=-2", "minDays=20&maxDays=1", "status=DESCONOCIDO", "followUp=2026-02-30"]) {
    for (const method of ["exportMoraPortfolio", "listMoraPortfolio"]) {
      await assert.rejects(f.service[method](new URLSearchParams(query), now), error => error.code === "INVALID_FILTER", query);
    }
  }
  await assert.rejects(f.service.listMoraPortfolio(new URLSearchParams("page=0"), now), error => error.code === "INVALID_FILTER");
  assert.equal((await f.service.exportMoraPortfolio(new URLSearchParams("page=0"), now)).items.length, 60);
});

test("refactor conserva estados y contadores de gestión de cartera completa", async () => {
  const f = fixture();
  const all = await f.service.listCreditPortfolio(new URLSearchParams(), now);
  assert.equal(all.total, 64);
  assert.deepEqual(plain(all.counts), { total: 64, enMora: 60, alDia: 1, pagados: 2, anulados: 1 });
  const current = await f.service.listCreditPortfolio(new URLSearchParams("financialStatus=AL_DIA"), now);
  assert.equal(current.total, 1);
  assert.equal(current.items[0].id, 61);
  assert.equal(current.counts.total, 64);
  assert.equal((await f.service.exportMoraPortfolio(new URLSearchParams(), now)).items.some(row => row.id >= 61), false);
});

test("el límite de volumen rechaza la selección completa sin truncar y admite exportarla tras filtrar", async () => {
  let count = 10000;
  const service = loadApprovalModule("lib/analyst-mora-management.ts", {
    "@/lib/prisma": { default: {
      credito: { findMany: async () => Array.from({ length: count }, (_, i) => ({ id: i + 1, enMora: true, estadoCartera: "EN_MORA", diasMora: i < 10000 ? 20 : 30 })) },
      $queryRawUnsafe: async () => [],
    } },
    "@/lib/credit-approval-errors": approvalErrors, "@/lib/analyst-mora-access": {},
    "@/lib/analyst-mora-credit": { moraCreditSelect: {}, moraCreditSummary: row => row },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-types": types, "@/lib/colombia-date": dates,
    "@/lib/analyst-mora-extension": { readActiveMoraExtensions: async () => new Map() },
  });
  assert.equal(service.MORA_EXPORT_MAX_ROWS, 10000);
  assert.equal((await service.exportMoraPortfolio(new URLSearchParams(), now)).items.length, 10000);
  count++;
  await assert.rejects(service.exportMoraPortfolio(new URLSearchParams(), now), error => error.status === 413 && error.code === "MORA_EXPORT_TOO_LARGE");
  assert.equal((await service.exportMoraPortfolio(new URLSearchParams("maxDays=20"), now)).items.length, 10000);
  assert.equal((await service.listMoraPortfolio(new URLSearchParams(), now)).total, 10001, "el límite de exportación no cambia el listado");
});
