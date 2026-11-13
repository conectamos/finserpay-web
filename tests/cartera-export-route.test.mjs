import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const carteraAccess = await jiti.import("../lib/cartera-access.ts");
const carteraExport = await jiti.import("../lib/cartera-export.ts");
const carteraDueDays = await jiti.import("../lib/cartera-due-days.ts");
const displayNumber = await jiti.import("../lib/credit-display-number.ts");
const paymentPlan = await jiti.import("../lib/credit-payment-plan.ts");
const outstandingBalance = await jiti.import("../lib/credit-outstanding-balance.ts");
const creditFactory = await jiti.import("../lib/credit-factory.ts");
const allyPayments = await jiti.import("../lib/ally-payments-core.ts");
const roles = await jiti.import("../lib/roles.ts");
const allies = await jiti.import("../lib/aliados.ts");

function loadRoute(dependencies, routePath = "app/api/dashboard/cartera/export/route.ts", clock = Date) {
  const source = readFileSync(path.join(projectRoot, routePath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = { exports: {} };

  runInNewContext(
    outputText,
    {
      exports: loaded.exports,
      module: loaded,
      console,
      Date: clock,
      Intl,
      Request,
      Response,
      URL,
      require(name) {
        assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
        return dependencies[name];
      },
    },
    { filename: routePath }
  );

  return loaded.exports;
}

function creditFixture(id, estado, changes = {}) {
  return {
    id,
    folio: `CARTERA-${id}`,
    clienteNombre: `CLIENTE_${estado}_${id}`,
    clienteDocumento: `10000000${id}`,
    clienteTelefono: `30000000${id}`,
    clienteDireccion: "Calle de prueba",
    clienteFechaNacimiento: new Date("1990-01-02T00:00:00.000Z"),
    clienteCorreo: `cliente${id}@example.test`,
    clienteGenero: "OTRO",
    imei: `0000000000000${id}`,
    referenciaEquipo: `EQUIPO-${id}`,
    equipoMarca: "MARCA",
    equipoModelo: "MODELO",
    valorEquipoTotal: 1_200_000,
    saldoBaseFinanciado: 1_000_000,
    montoCredito: 1_100_000,
    cuotaInicial: 200_000,
    plazoMeses: 12,
    frecuenciaPago: "MENSUAL",
    tasaInteresEa: 10,
    valorInteres: 100_000,
    fianzaPorcentaje: 10,
    valorFianza: 100_000,
    valorCuota: 100_000,
    fechaCredito: new Date("2026-09-01T15:00:00.000Z"),
    fechaPrimerPago: new Date("2026-10-01T15:00:00.000Z"),
    fechaProximoPago: new Date("2026-10-01T15:00:00.000Z"),
    estado,
    pazYSalvoEmitidoAt: null,
    contratoSnapshot: null,
    amortizacion: null,
    abonos: [],
    sede: {
      nombre: "SEDE PRUEBA",
      aliado: { nombre: "ALIADO PRUEBA" },
    },
    ...changes,
  };
}

function workbookRows(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(
    (match) => match[1]
  );
}

function workbookHeaders(html) {
  return [...html.matchAll(/<th>([\s\S]*?)<\/th>/g)].map(match => match[1]);
}

function rowCells(row) {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]);
}

function actualPlanRoute({ credits = [], central = true, now = "2026-11-14T04:30:00.000Z" } = {}) {
  const calls = { queries: [], plans: [], exemptions: [], creditExceptions: [], currentInstants: 0 };
  class ExportDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); if (!args.length) calls.currentInstants++; }
    static now() { return Date.parse(now); }
  }
  const route = loadRoute({
    "next/server": { NextResponse: Response },
    "@/lib/cartera-due-days": carteraDueDays,
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan(input) { calls.plans.push(input); return paymentPlan.buildCreditPaymentPlan(input); } },
    "@/lib/credit-outstanding-balance": outstandingBalance,
    "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-factory": creditFactory,
    "@/lib/ally-payments-core": allyPayments,
    "@/lib/auth": { getSessionUser: async () => ({ id: 8, rolNombre: "ADMIN", aliadoAccesoId: 7,
      aliadoAccesoCodigo: central ? "FINSERPAY" : "ALIADO" }) },
    "@/lib/aliados": allies,
    "@/lib/cartera-export": carteraExport,
    "@/lib/cartera-access": carteraAccess,
    "@/lib/credit-display-number": displayNumber,
    "@/lib/credit-display-number-server": { getCreditDisplayNumbers: async () => new Map(), withCreditDisplayNumber: credit => credit },
    "@/lib/mora-block-exemptions": {
      normalizeMoraExemptionDocument: value => String(value || "").replace(/[^0-9]/g, ""),
      getActiveMoraBlockExemptionDocuments: async today => { calls.exemptions.push(today); return new Set(); },
    },
    "@/lib/mora-exception-requests": { getActiveMoraExceptionsByCreditIds: async (ids, today) => {
      calls.creditExceptions.push({ ids, today }); return new Map([[101, { type: "PRORROGA" }]]);
    } },
    "@/lib/roles": roles,
    "@/lib/prisma": { default: { credito: { findMany: async query => {
      calls.queries.push(query);
      // Emulate the actual Prisma payment predicate instead of prefiltering the
      // fixture: an annulment must stop contributing to the real payment plan.
      const condition = query.include.abonos.where.estado;
      return credits.map(credit => ({ ...credit, abonos: credit.abonos.filter(payment =>
        (condition.not === undefined || payment.estado !== condition.not) &&
        (!condition.notIn || !condition.notIn.includes(payment.estado))) }));
    } } } },
  }, "app/api/dashboard/cartera/export/route.ts", ExportDate);
  return { calls, async get(scope = "mora") {
    const response = await route.GET(new Request(`https://finserpay.test/api/dashboard/cartera/export?scope=${scope}&aliadoId=99&adminCentral=true`));
    const html = await response.text();
    assert.equal(response.status, 200);
    return { response, html, headers: workbookHeaders(html), rows: workbookRows(html) };
  } };
}

function weeklyCredit(id, changes = {}) {
  return creditFixture(id, "ACTIVO", {
    montoCredito: 600.24, valorCuota: 100.04, plazoMeses: 6, frecuenciaPago: "SEMANAL",
    fechaPrimerPago: new Date("2026-10-16T00:00:00.000Z"), fechaProximoPago: null,
    cuotaInicial: 0, saldoBaseFinanciado: 600.24, valorEquipoTotal: 600.24, valorFianza: 0, valorInteres: 0,
    abonos: [{ valor: 150.06, estado: "ACTIVO", metodoPago: "EFECTIVO", fechaAbono: new Date("2026-10-20T15:00:00Z") }],
    ...changes,
  });
}

function assertOverdueCells(result, row, { count, amount, prorroga = "NO" }) {
  const cells = [...row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(match => ({ attrs: match[1], value: match[2] }));
  assert.equal(cells.length, result.headers.length);
  const countIndex = result.headers.indexOf("Cuotas en mora");
  const amountIndex = result.headers.indexOf("Valor de cuotas en mora");
  assert.ok(countIndex > 0);
  assert.equal(result.headers[countIndex - 1], "Cuotas pendientes");
  assert.equal(amountIndex, countIndex + 1);
  assert.equal(result.headers[amountIndex + 1], "Valor cuota");
  assert.equal(cells[countIndex].value, String(count));
  assert.match(cells[countIndex].attrs, /mso-number-format:"0"/);
  assert.equal(cells[amountIndex].value, amount.toFixed(2));
  assert.ok(cells[amountIndex].attrs.includes(`x:num="${amount.toFixed(2)}"`), "Excel recibe un número exacto, no moneda escrita como texto");
  assert.match(result.html, /xmlns:x="urn:schemas-microsoft-com:office:excel"/);
  assert.match(cells[amountIndex].attrs, /mso-number-format:.*0\.00/);
  assert.doesNotMatch(cells[amountIndex].attrs, /\\@/);
  assert.equal(result.headers.at(-1), "PRORROGA ACTIVA");
  assert.equal(cells.at(-1).value, prorroga);
}

test("Excel mora calcula cuotas vencidas parcialmente pagadas sin incluir hoy, futuras, pagadas o canceladas", async () => {
  const credits = [
    weeklyCredit(101),
    weeklyCredit(102, { abonos: [] }),
    weeklyCredit(103, { fechaPrimerPago: new Date("2026-11-13T00:00:00Z"), abonos: [] }),
    weeklyCredit(104, { fechaPrimerPago: new Date("2026-11-20T00:00:00Z"), abonos: [] }),
    weeklyCredit(105, { abonos: [{ valor: 600.24, estado: "ACTIVO", fechaAbono: new Date("2026-10-20T15:00:00Z") }] }),
    weeklyCredit(106, { pazYSalvoEmitidoAt: new Date("2026-10-20T15:00:00Z"), abonos: [] }),
    ...["CANCELADO", "ANULADO", "CANCELADA", "ANULADA"].map((estado, index) => weeklyCredit(107 + index, { estado, abonos: [] })),
    weeklyCredit(111, { montoCredito: 0, valorCuota: 0, abonos: [] }),
  ];
  for (const central of [true, false]) {
    const f = actualPlanRoute({ credits, central });
    const result = await f.get();
    assert.equal(result.rows.length, 2);
    assertOverdueCells(result, result.rows.find(row => row.includes("CARTERA-101")), { count: 3, amount: 250.10, prorroga: "SI" });
    const unpaid = result.rows.find(row => row.includes("CARTERA-102"));
    assertOverdueCells(result, unpaid, { count: 4, amount: 400.16 });
    assert.equal(rowCells(unpaid)[result.headers.indexOf("Cuotas pagadas")], "0");
    assert.equal(f.calls.currentInstants, 1, "La descarga captura una sola fecha efectiva");
    assert.ok(f.calls.plans.every(input => input.today === f.calls.exemptions[0]));
    assert.equal(f.calls.creditExceptions[0].today, f.calls.exemptions[0]);
    assert.equal(f.calls.queries[0].include.abonos.where.estado.not, "ANULADO");
    assert.equal(f.calls.queries[0].where.sede.aliadoId, central ? 99 : 7);
    for (const label of ["Saldo obligacion", "Saldo fianza", "Saldo intereses", "Saldo seguro"]) {
      assert.equal(result.headers.includes(label), central, `${label} sigue reservado`);
    }
    const general = await f.get("cartera");
    assert.equal(general.headers.includes("Cuotas en mora"), false);
    assert.equal(general.headers.includes("Valor de cuotas en mora"), false);
    assert.equal(general.headers.includes("PRORROGA ACTIVA"), false);
    assert.ok(general.rows.some(row => row.includes("CARTERA-105")), "El reporte general conserva pagados");
    for (const row of general.rows) assert.equal(rowCells(row).length, general.headers.length);
  }
});

test("Excel mora usa el saldo vigente tras anular un pago y respeta la próxima cuota reprogramada", async () => {
  const original = weeklyCredit(101);
  const reversed = weeklyCredit(102, { abonos: original.abonos.map(payment => ({ ...payment, estado: "ANULADO" })) });
  const moved = weeklyCredit(103, { fechaProximoPago: new Date("2026-12-17T00:00:00Z") });
  const f = actualPlanRoute({ credits: [original, reversed, moved], central: false });
  const result = await f.get();
  assert.equal(result.rows.length, 3);
  assertOverdueCells(result, result.rows.find(row => row.includes("CARTERA-101")), { count: 3, amount: 250.10, prorroga: "SI" });
  assertOverdueCells(result, result.rows.find(row => row.includes("CARTERA-102")), { count: 4, amount: 400.16 });
  assertOverdueCells(result, result.rows.find(row => row.includes("CARTERA-103")), { count: 2, amount: 200.08 });
  assert.equal(f.calls.plans[1].abonos.length, 0, "El abono anulado no se entrega al motor");
  assert.equal(reversed.abonos[0].estado, "ANULADO", "Consultar no modifica el abono");
});

test("el vencimiento de hoy entra a Excel mora sólo al comenzar el siguiente día de Bogotá", async () => {
  const credits = [weeklyCredit(101, { fechaPrimerPago: new Date("2026-11-13T00:00:00Z"), abonos: [] })];
  const before = await actualPlanRoute({ credits, now: "2026-11-14T04:59:59.999Z" }).get();
  assert.equal(before.rows.length, 0);
  assert.ok(before.headers.includes("Cuotas en mora"));
  assert.ok(before.headers.includes("Valor de cuotas en mora"));
  const after = await actualPlanRoute({ credits, now: "2026-11-14T05:00:00.000Z" }).get();
  assert.equal(after.rows.length, 1);
  assertOverdueCells(after, after.rows[0], { count: 1, amount: 100.04, prorroga: "SI" });
});

test("descargas sin mora conservan encabezados y no inventan filas de cero", async () => {
  const almostPaid = weeklyCredit(101, { montoCredito: 100.04, valorCuota: 100.04, plazoMeses: 1,
    abonos: [{ valor: 99.54, estado: "ACTIVO", fechaAbono: new Date("2026-10-20T15:00:00Z") }] });
  for (const central of [true, false]) {
    for (const credits of [[], [almostPaid]]) {
      const result = await actualPlanRoute({ credits, central }).get();
      assert.equal(result.rows.length, 0, "El residuo menor de un peso conserva el tratamiento del motor vigente");
      assert.equal(result.headers.filter(header => header === "Cuotas en mora").length, 1);
      assert.equal(result.headers.filter(header => header === "Valor de cuotas en mora").length, 1);
      assert.equal(result.headers.at(-1), "PRORROGA ACTIVA");
      assert.doesNotMatch(result.html, /NaN|Infinity|undefined/);
    }
  }
});

test("la cuota reducida del plan de capital suma su valor real y la eliminada no cuenta", async () => {
  const planCapitalVigente = {
    version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 1, totalAbonadoAlCorte: 100.04,
    abonosAlCorte: [{ id: 501, valor: 100.04 }], saldoCapitalAlCorte: 150.07, numeroCuotasOriginal: 4,
    parametros: { capitalPendiente: 150.07, tasaPeriodo: 0, cuotaCredito: 100.04, fianzaCuota: 0, seguroCuota: 0,
      numeroProximaCuota: 2, fuente: "Conciliación de prueba documentada" },
    cuotas: [
      { numero: 1, fechaVencimiento: "2026-10-02", valorProgramado: 100.04, valorAbonadoAlCorte: 100.04, eliminada: false },
      { numero: 2, fechaVencimiento: "2026-10-17", valorProgramado: 100.04, valorAbonadoAlCorte: 0, eliminada: false,
        capital: 100.04, interes: 0, fianza: 0, seguro: 0, saldoCapital: 50.03 },
      { numero: 3, fechaVencimiento: "2026-11-02", valorProgramado: 50.03, valorAbonadoAlCorte: 0, eliminada: false,
        capital: 50.03, interes: 0, fianza: 0, seguro: 0, saldoCapital: 0 },
      { numero: 4, fechaVencimiento: "2026-11-08", valorProgramado: 0, valorAbonadoAlCorte: 0, eliminada: true },
    ],
  };
  const credit = weeklyCredit(101, { planCapitalVigente, montoCredito: 250.11, plazoMeses: 4,
    abonos: [{ valor: 100.04, estado: "ACTIVO", fechaAbono: new Date("2026-10-03T15:00:00Z") }] });
  const before = JSON.stringify(credit);
  for (const central of [true, false]) {
    const result = await actualPlanRoute({ credits: [credit], central }).get();
    assert.equal(result.rows.length, 1);
    assertOverdueCells(result, result.rows[0], { count: 2, amount: 150.07, prorroga: "SI" });
  }
  assert.equal(JSON.stringify(credit), before);
});

test("GET exporta cartera activa y pagada, excluye anulados y conserva tasas porcentuales numericas", async (t) => {
  const credits = [
    creditFixture(1, "INSCRITO", {
      clienteNombre: "CLIENTE_ACTIVO_EXPORTADO",
      contratoSnapshot: {
        equipo: { plataforma: "IPHONE" },
      },
      amortizacion: {
        tasaInteresEaPorcentaje: 29.24,
        fianzaCuotaPorcentaje: 75 / 12,
        seguroCuotaPorcentaje: 0.03,
        numeroCuotas: 12,
      },
    }),
    creditFixture(2, "PAZ_Y_SALVO", {
      clienteNombre: "CLIENTE_PAGADO_EXPORTADO",
      pazYSalvoEmitidoAt: new Date("2026-09-15T15:00:00.000Z"),
      contratoSnapshot: {
        equipo: { plataforma: "ANDROID" },
        financiero: {
          tasaInteresEa: 25,
          fianzaTotalPorcentaje: 60,
          seguroCuotaPorcentaje: 0.05,
        },
      },
    }),
    creditFixture(3, "CANCELADO", {
      clienteNombre: "CLIENTE_CANCELADO_NO_EXPORTAR",
    }),
    creditFixture(4, "ANULADO", {
      clienteNombre: "CLIENTE_ANULADO_NO_EXPORTAR",
    }),
  ];
  const database = new PGlite();
  t.after(() => database.close());
  const exemptions = loadRoute({
    "@/lib/prisma": { default: {
      $executeRawUnsafe: (sql) => database.query(sql),
      $queryRaw: async (parts, ...values) => {
        const sql = parts.reduce((text, part, index) => text + part + (index < values.length ? "$" + (index + 1) : ""), "");
        return (await database.query(sql, values)).rows;
      },
    } },
  }, "lib/mora-block-exemptions.ts");
  await exemptions.ensureMoraBlockExemptionTable();
  await database.query(`
    INSERT INTO "ExcepcionBloqueoMora" (documento, motivo, activa, "fechaFin") VALUES
      ('100000001', 'Vigente', TRUE, $1),
      ('100000005', 'Vencida', TRUE, $2),
      ('100000006', 'Desactivada', FALSE, $1),
      ('100000008', 'Sin fecha de fin', TRUE, NULL),
      ('SIN-CC', 'Documento historico invalido', TRUE, NULL)
  `, [new Date(Date.now() + 86400000), new Date(Date.now() - 86400000)]);
  let overdue = false;
  const exemptionCalls = [];
  let creditExceptions = new Map();
  let findManyQuery = null;
  const displayNumberCalls = [];
  let sessionUser = {
    id: 1,
    rolNombre: "ADMIN",
    aliadoAccesoCodigo: "FINSERPAY",
    aliadoAccesoId: 1,
  };
  const prisma = {
    credito: {
      async findMany(query) {
        findManyQuery = query;
        return credits;
      },
    },
  };
  const route = loadRoute({
    "next/server": { NextResponse: Response },
    "@/lib/cartera-due-days": carteraDueDays,
    "@/lib/credit-payment-plan": {
      buildCreditPaymentPlan(input) {
        const paid = Boolean(input.settled);
        const nextInstallment = paid
          ? null
          : {
              fechaVencimiento: "2026-10-01",
              saldoPendiente: 400_000,
              estaEnMora: overdue,
            };

        return {
          saldoPendiente: paid ? 0 : 400_000,
          installments: nextInstallment ? [nextInstallment] : [],
          nextInstallment,
          paidCount: paid ? 12 : 8,
          pendingCount: paid ? 0 : 4,
          overdueCount: !paid && overdue ? 1 : 0,
        };
      },
    },
    "@/lib/credit-outstanding-balance": {
      splitOutstandingBalance({ saldoPendiente }) {
        return {
          saldoCapital: saldoPendiente > 0 ? 234_567 : 0,
          saldoFianza: saldoPendiente > 0 ? 81_234 : 0,
          saldoIntereses: saldoPendiente > 0 ? 75_000 : 0,
          saldoSeguro: saldoPendiente > 0 ? 9_199 : 0,
        };
      },
    },
    "@/lib/credit-abono-audit": {
      ensureCreditAbonoAuditColumns: async () => {},
    },
    "@/lib/credit-factory": {
      getPaymentFrequencyLabel: (value) => String(value || ""),
      normalizeCreditDevicePlatform(value) {
        const normalized = String(value || "").trim().toUpperCase();
        return normalized === "ANDROID" || normalized === "IPHONE"
          ? normalized
          : null;
      },
      sanitizeText: (value) => String(value || ""),
    },
    "@/lib/ally-payments-core": {
      resolveAllyPaymentPlatform(snapshot, brand) {
        const platform = String(snapshot?.equipo?.plataforma || "")
          .trim()
          .toUpperCase();
        if (platform === "ANDROID" || platform === "IPHONE") return platform;
        return /^(APPLE|IPHONE)$/i.test(String(brand || "").trim())
          ? "IPHONE"
          : String(brand || "").trim()
            ? "ANDROID"
            : null;
      },
    },
    "@/lib/auth": {
      getSessionUser: async () => sessionUser,
    },
    "@/lib/aliados": {
      isFinserPayCentralAlly: (code) => code === "FINSERPAY",
    },
    "@/lib/cartera-export": carteraExport,
    "@/lib/cartera-access": carteraAccess,
    "@/lib/credit-display-number": displayNumber,
    "@/lib/credit-display-number-server": {
      async getCreditDisplayNumbers(ids) {
        displayNumberCalls.push(Array.from(ids));
        return new Map([[1, "000123-A"]]);
      },
      withCreditDisplayNumber: (credit, numbers) => ({ ...credit, numeroCreditoVisible: numbers.get(credit.id) || credit.folio }),
    },
    "@/lib/mora-block-exemptions": {
      normalizeMoraExemptionDocument: exemptions.normalizeMoraExemptionDocument,
      getActiveMoraBlockExemptionDocuments: async (effectiveAt) => {
        exemptionCalls.push(effectiveAt);
        return exemptions.getActiveMoraBlockExemptionDocuments(effectiveAt);
      },
    },
    "@/lib/mora-exception-requests": {
      getActiveMoraExceptionsByCreditIds: async () => creditExceptions,
    },
    "@/lib/roles": { isAdminRole: () => true },
    "@/lib/prisma": { default: prisma },
  });

  const response = await route.GET(
    new Request("https://finserpay.test/api/dashboard/cartera/export")
  );
  const html = await response.text();
  const rows = workbookRows(html);

  assert.equal(response.status, 200);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(html, /PRORROGA ACTIVA/);
  assert.ok(findManyQuery);
  assert.match(html, /Interés mensual efectivo \(%\)/);
  assert.match(html, /Fianza total del crédito \(%\)/);
  assert.match(html, /Seguro por cuota \(%\)/);
  assert.match(html, /<th>Número crédito<\/th>/);
  assert.match(html, /<th>Folio original<\/th>/);

  const activeRow = rows.find((row) => row.includes("CLIENTE_ACTIVO_EXPORTADO"));
  const paidRow = rows.find((row) => row.includes("CLIENTE_PAGADO_EXPORTADO"));
  assert.ok(activeRow);
  assert.ok(paidRow);
  assert.match(activeRow, />000123-A<\/td>[\s\S]*>CARTERA-1<\/td>/);
  assert.match(paidRow, />CARTERA-2<\/td>[\s\S]*>CARTERA-2<\/td>/);
  assert.equal(credits[0].folio, "CARTERA-1");
  assert.equal(credits[0].numeroCreditoVisible, undefined);
  assert.doesNotMatch(html, /CLIENTE_CANCELADO_NO_EXPORTAR/);
  assert.doesNotMatch(html, /CLIENTE_ANULADO_NO_EXPORTAR/);

  assert.match(activeRow, />0\.021605<\/td>[\s\S]*>0\.75<\/td>[\s\S]*>0\.0003<\/td>/);
  assert.match(paidRow, />0\.018769<\/td>[\s\S]*>0\.6<\/td>[\s\S]*>0\.0005<\/td>/);
  assert.match(activeRow, /mso-number-format:"0\.0000%"/);
  assert.match(paidRow, />0<\/td>[\s\S]*>0<\/td>/);
  assert.deepEqual(displayNumberCalls[0], [1, 2, 3, 4]);

  const iphoneResponse = await route.GET(
    new Request(
      "https://finserpay.test/api/dashboard/cartera/export?aliadoId=4&plataforma=iphone"
    )
  );
  const iphoneHtml = await iphoneResponse.text();
  const iphoneRows = workbookRows(iphoneHtml);

  assert.equal(iphoneResponse.status, 200);
  assert.equal(iphoneRows.length, 1);
  assert.match(iphoneRows[0], /CLIENTE_ACTIVO_EXPORTADO/);
  assert.match(iphoneRows[0], />IPHONE<\/td>/);
  assert.doesNotMatch(iphoneHtml, /CLIENTE_PAGADO_EXPORTADO/);
  assert.deepEqual(displayNumberCalls[1], [1]);
  assert.equal(findManyQuery.where.sede.aliadoId, 4);

  sessionUser = {
    id: 8,
    rolNombre: "ADMIN",
    aliadoAccesoCodigo: "ALIADO_PRUEBA",
    aliadoAccesoId: 7,
  };
  const allyResponse = await route.GET(
    new Request(
      "https://finserpay.test/api/dashboard/cartera/export?aliadoId=99&plataforma=ANDROID"
    )
  );

  assert.equal(allyResponse.status, 200);
  assert.equal(findManyQuery.where.sede.aliadoId, 7);
  assert.doesNotMatch(await allyResponse.text(), /CLIENTE_ACTIVO_EXPORTADO/);

  sessionUser = {
    id: 9,
    rolNombre: "ADMIN",
    aliadoAccesoCodigo: "ALIADO_SIN_CONFIGURAR",
    aliadoAccesoId: null,
  };
  findManyQuery = null;

  const allyWithoutScopeResponse = await route.GET(
    new Request(
      "https://finserpay.test/api/dashboard/cartera/export?aliadoId=99"
    )
  );

  assert.equal(allyWithoutScopeResponse.status, 403);
  assert.equal(findManyQuery, null);
  assert.equal(exemptionCalls.length, 0, "La cartera general no consulta excepciones");

  await t.test("aliado recibe solo capital y columnas permitidas sin saldos reservados en cartera ni mora", async () => {
    const previousSession = sessionUser;
    const previousOverdue = overdue;
    const centralHeaders = [
      "Fecha apertura", "Número crédito", "Folio original", "Nombre del cliente", "Cedula",
      "Telefono del cliente", "DIRECCION", "FECHA DE NACIMIENTO", "CORREO", "SEXO", "IMEI",
      "Referencia", "Plataforma", "Plazo credito", "Frecuencia de pago", "Interés mensual efectivo (%)",
      "Fianza total del crédito (%)", "Seguro por cuota (%)", "ALIADO", "SEDE",
      "Fecha proxima cuota a pagar", "Cuotas pagadas", "Cuotas pendientes", "Valor cuota",
      "Saldo obligacion", "Saldo capital", "Saldo fianza", "Saldo intereses", "Saldo seguro",
      "Dias vencidos", "Ultimo pago que ha realizado",
    ];
    const reserved = new Set(["Saldo obligacion", "Saldo fianza", "Saldo intereses", "Saldo seguro"]);
    try {
      overdue = true;
      for (const scope of ["cartera", "mora", "central"]) {
        sessionUser = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoAccesoId: 1 };
        const centralResponse = await route.GET(new Request(
          `https://finserpay.test/api/dashboard/cartera/export?scope=${scope}&plataforma=IPHONE`
        ));
        const centralHtml = await centralResponse.text();
        const headers = workbookHeaders(centralHtml);
        const centralRows = workbookRows(centralHtml);
        assert.equal(centralResponse.status, 200);
        const expectedHeaders = [...centralHeaders];
        if (scope === "mora") expectedHeaders.splice(expectedHeaders.indexOf("Valor cuota"), 0, "Cuotas en mora", "Valor de cuotas en mora");
        assert.deepEqual(headers, [...expectedHeaders, ...(scope === "mora" ? ["PRORROGA ACTIVA"] : [])]);
        assert.equal(centralRows.length, 1);
        assert.equal(rowCells(centralRows[0]).length, headers.length);
        for (const value of [400_000, 81_234, 75_000, 9_199]) assert.match(centralHtml, new RegExp(`>${value}</td>`));

        sessionUser = { id: 8, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO_PRUEBA", aliadoAccesoId: 7 };
        const allyResponse = await route.GET(new Request(
          `https://finserpay.test/api/dashboard/cartera/export?scope=${scope}&plataforma=IPHONE` +
          "&aliadoId=99&adminCentral=true&central=true&rolNombre=ADMIN&includeFinancial=true"
        ));
        const allyHtml = await allyResponse.text();
        const allyHeaders = workbookHeaders(allyHtml);
        const allyRows = workbookRows(allyHtml);
        assert.equal(allyResponse.status, 200);
        assert.equal(findManyQuery.where.sede.aliadoId, 7, "El aliado de sesión prevalece sobre parámetros falsificados");
        assert.deepEqual(allyHeaders, headers.filter(heading => !reserved.has(heading)));
        assert.equal(allyRows.length, centralRows.length);
        for (let index = 0; index < allyRows.length; index++) {
          const cells = rowCells(allyRows[index]);
          assert.equal(cells.length, allyHeaders.length);
          assert.deepEqual(cells, rowCells(centralRows[index]).filter((_, column) => !reserved.has(headers[column])),
            "Capital, cuota, conteos y tasas conservan los mismos valores y orden");
        }
        for (const heading of reserved) assert.equal(allyHtml.includes(heading), false);
        // The new overdue amount may equal the obligation balance; that amount
        // is authorized only in the new mora column, never as a private column.
        assert.doesNotMatch(allyHtml, scope === "mora" ? /81234|75000|9199/ : /400000|81234|75000|9199/,
          "Los cargos reservados no aparecen en texto, atributos ni metadatos");
        assert.match(allyHtml, />234567<\/td>/);
        assert.match(allyHtml, />100000<\/td>/);
        assert.doesNotMatch(allyHtml, /CLIENTE_PAGADO_EXPORTADO/, "Se conserva el filtro de plataforma");
      }
    } finally {
      sessionUser = previousSession;
      overdue = previousOverdue;
      exemptionCalls.length = 0;
    }
  });

  await t.test("Excel mora marca SI/NO con excepciones vigentes, vencidas y desactivadas", async () => {
    sessionUser = {
      id: 1,
      rolNombre: "ADMIN",
      aliadoAccesoCodigo: "FINSERPAY",
      aliadoAccesoId: 1,
    };
    overdue = true;
    creditExceptions = new Map([[5, { fechaFin: new Date("2026-10-21T23:59:59.999-05:00"), type: "PRORROGA" }]]);
    credits[0].clienteDocumento = "100.000.001";
    credits.push(
      creditFixture(5, "MORA"),
      creditFixture(6, "MORA"),
      creditFixture(7, "MORA"),
      creditFixture(8, "MORA"),
      creditFixture(9, "MORA", { clienteDocumento: "100 000 001" }),
      creditFixture(10, "MORA", { clienteDocumento: null })
    );

    const moraResponse = await route.GET(
      new Request("https://finserpay.test/api/dashboard/cartera/export?scope=mora")
    );
    const moraHtml = await moraResponse.text();
    const moraRows = workbookRows(moraHtml);
    assert.equal(moraResponse.status, 200);
    assert.match(moraResponse.headers.get("Content-Disposition"), /clientes-en-mora-finserpay/);
    assert.match(moraHtml, /<th>PRORROGA ACTIVA<\/th>/);
    assert.equal(exemptionCalls.length, 1, "Una consulta de excepciones por descarga");
    assert.equal(moraRows.length, 7, "La prorroga no excluye al cliente del reporte de mora");

    for (const [name, expected] of [
      ["CLIENTE_ACTIVO_EXPORTADO", "SI"],
      ["CLIENTE_MORA_5", "SI"],
      ["CLIENTE_MORA_6", "NO"],
      ["CLIENTE_MORA_7", "NO"],
      ["CLIENTE_MORA_8", "SI"],
      ["CLIENTE_MORA_9", "SI"],
      ["CLIENTE_MORA_10", "NO"],
    ]) {
      const row = moraRows.find((row) => row.includes(name));
      assert.ok(row, name);
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]);
      assert.equal(cells.length, workbookHeaders(moraHtml).length, name);
      assert.equal(cells.at(-1), expected, name);
    }
    assert.doesNotMatch(moraHtml, /Sin fecha de fin|Vencida|Desactivada|Documento historico invalido/);
  });

  await t.test("Excel usa el importe de fianza vigente de un plazo revisado y conserva las demás tasas", async () => {
    const active = credits[0];
    const before = { plazoMeses: active.plazoMeses, valorFianza: active.valorFianza, amortizacion: active.amortizacion };
    try {
      active.plazoMeses = 24;
      active.valorFianza = 480_000;
      active.amortizacion = {
        numeroCuotas: 16, fianzaCuotaPorcentaje: 2,
        tasaInteresEaPorcentaje: 29.24, seguroCuotaPorcentaje: 0.03,
      };
      const revisedResponse = await route.GET(new Request("https://finserpay.test/api/dashboard/cartera/export"));
      const revisedRows = workbookRows(await revisedResponse.text());
      const revisedRow = revisedRows.find(row => row.includes("CLIENTE_ACTIVO_EXPORTADO"));
      assert.equal(revisedResponse.status, 200);
      assert.match(revisedRow, />0\.021605<\/td>[\s\S]*>0\.48<\/td>[\s\S]*>0\.0003<\/td>/);

      active.valorFianza = 600_000;
      active.amortizacion.fianzaCuotaPorcentaje = 3.75;
      const fixedTotalResponse = await route.GET(new Request("https://finserpay.test/api/dashboard/cartera/export"));
      const fixedTotalRow = workbookRows(await fixedTotalResponse.text()).find(row => row.includes("CLIENTE_ACTIVO_EXPORTADO"));
      assert.equal(fixedTotalResponse.status, 200);
      assert.match(fixedTotalRow, />0\.021605<\/td>[\s\S]*>0\.6<\/td>[\s\S]*>0\.0003<\/td>/);
    } finally {
      Object.assign(active, before);
    }
  });
});
