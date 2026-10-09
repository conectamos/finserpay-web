import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL("../" + file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Date, URL, Request, Response, console,
    require(name) {
      assert.ok(name in dependencies, "Unexpected dependency: " + name);
      return dependencies[name];
    },
  }, { filename: file });
  return loaded.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const core = load("lib/ally-payments-core.ts");
const dates = load("lib/colombia-date.ts");
const allies = load("lib/aliados.ts");
const importFlags = load("lib/credit-import-flags.ts");
const approval = load("lib/credit-approval-policy.ts", { "./credit-import-flags": importFlags });
const eligibility = load("lib/ally-payment-eligibility.ts", { "./ally-payments-core": core, "./credit-approval-policy": approval });
const annulments = {
  loadPendingAllyPaymentAnnulmentAdjustments: async () => [],
  lockAllyPaymentAlly: async () => {},
  serializeStoredAllyPaymentAnnulmentAdjustment: item => item,
  totalAllyPaymentAnnulmentAdjustments: items => items.reduce(
    (total, item) => Number((total + Number(item.valorDescuento || 0)).toFixed(2)),
    0
  ),
};

function settled(id, overrides = {}) {
  return {
    id, mutationId: "qa-" + id, aliado: { id: 7, nombre: "Aliado QA" },
    periodoInicio: new Date("2026-09-01T00:00:00Z"), periodoFin: new Date("2026-09-30T00:00:00Z"),
    numeroAprobacionBancaria: "0000-" + id, estado: "PAGADA", numeroCreditos: 1,
    totalValorVenta: "1000.25", totalCreditoAutorizado: "800.25", totalCuotaInicial: "200.00",
    totalIntermediacion: "80.03", totalPagar: "720.22", totalRecaudosAliado: "120.09",
    numeroAjustesAnulacion: 0, totalAjustesAnulacion: "0.00",
    saldoNeto: "600.13", direccionSaldo: "PAGO_ALIADO", registradoPorNombre: "Usuario histórico QA",
    pagadoAt: new Date("2026-10-07T04:30:00Z"), createdAt: new Date("2026-10-07T04:30:00Z"),
    creditos: [{
      id, creditoId: id, fechaCredito: new Date("2026-09-17T12:00:00Z"), folio: "0000-F-" + id,
      clienteNombre: "Cliente histórico QA", clienteDocumento: "001234567890", imei: "000012345678901",
      equipo: "Equipo congelado QA", plataforma: "IPHONE", valorVenta: "1000.25", creditoAutorizado: "800.25",
      cuotaInicial: "200.00", porcentajeIntermediacion: "10.0000", valorIntermediacion: "80.03", valorPagar: "720.22",
      credito: { sede: { id: 4, nombre: "Sede QA" } },
    }],
    recaudos: [{
      id, abonoId: id, creditoId: id, sedeId: 4, fechaAbono: new Date("2026-09-18T12:00:00Z"),
      folio: "0000-F-" + id, clienteNombre: "Cliente histórico QA", clienteDocumento: "001234567890",
      sedeNombre: "Sede congelada QA", metodoPago: "EFECTIVO", valor: "120.09",
    }],
    ajustesAnulacion: [],
    ...overrides,
  };
}

const creditRow = {
  id: 189, fechaCredito: new Date("2026-08-31T17:08:40.184Z"), fechaLiquidacion: new Date("2026-09-01T05:00:00Z"),
  folio: "0000199", clienteNombre: "Cliente pendiente QA", clienteDocumento: "001000000001",
  imei: "000000000000189", deviceUid: "device-189", referenciaEquipo: "Equipo QA", equipoMarca: "Samsung", equipoModelo: "QA",
  contratoSnapshot: { equipo: { plataforma: "IPHONE" } }, aliadoId: 7, aliadoNombre: "Aliado QA", sedeId: 4, sedeNombre: "Sede QA",
  valorEquipoTotal: "1000.25", cuotaInicial: "200", redescuentoPorcentaje: 10, redescuentoAndroidPorcentaje: 10, redescuentoIphonePorcentaje: 15,
};
const collectionRow = {
  id: 21, creditoId: 987, sedeId: 4, fechaAbono: new Date("2026-10-07T04:30:00Z"), folio: "00000987",
  clienteNombre: "Cliente con crédito ya liquidado QA", clienteDocumento: "009876543210",
  imei: "000098765432101", deviceUid: "unused-device", contratoSnapshot: { equipo: { plataforma: "ANDROID" } },
  equipoMarca: "Apple", aliadoId: 7, aliadoNombre: "Aliado QA", sedeNombre: "Sede QA", metodoPago: "BRE-B", valor: "123.45",
};

function harness({ history = [], credits = [], collections = [] } = {}) {
  const calls = [];
  const database = {
    async $queryRawUnsafe(sql, ...values) {
      calls.push(["sql", sql, plain(values)]);
      return sql.includes('FROM public."CreditoAbono"') ? collections : credits;
    },
    liquidacionAliado: {
      async findMany(query) {
        calls.push(["history", plain(query)]);
        const scoped = history.filter(row => query.where.aliadoId === undefined || row.aliado.id === query.where.aliadoId);
        return query.take === undefined ? scoped : scoped.slice(0, query.take);
      },
    },
  };
  const storage = load("lib/ally-payments.ts", {
    "server-only": {}, "node:crypto": crypto, "@/lib/aliados": allies, "@/lib/ally-payments-core": core,
    "@/lib/colombia-date": dates, "@/lib/ally-payment-eligibility": eligibility,
    "@/lib/ally-payment-annulments": annulments,
    "@/lib/credit-ally-payment-exclusion-storage": { ensureCreditAllyPaymentExclusionSchema: async () => {} },
    "@/lib/datacredito/database-errors": { isDataCreditoUniqueViolation: () => false },
    "@/lib/prisma": { default: database },
  });
  return { storage, calls };
}

test("el historial completo conserva más de 200 períodos y no aplica un límite silencioso", async () => {
  const history = Array.from({ length: 245 }, (_, index) => settled(index + 1));
  history.push(settled(999, { aliado: { id: 8, nombre: "Otro aliado QA" } }));
  const api = harness({ history });
  const result = await api.storage.listAllyPaymentHistory({ allyId: 7 });
  assert.equal(result.length, 245);
  const query = api.calls.find(([name]) => name === "history")[1];
  assert.equal(query.take, undefined);
  assert.equal(query.where.aliadoId, 7);
  assert.deepEqual(query.where.periodoInicio, { gte: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(query.orderBy, [{ pagadoAt: "desc" }, { id: "desc" }]);
});

test("los callers con limit explícito conservan el límite anterior", async () => {
  const api = harness({ history: Array.from({ length: 245 }, (_, index) => settled(index + 1)) });
  for (const [requested, expected] of [[5, 5], [0, 1], [300, 200], [Number.NaN, 100]]) {
    const result = await api.storage.listAllyPaymentHistory({ allyId: null, limit: requested });
    assert.equal(result.length, expected);
    assert.equal(api.calls.at(-1)[1].take, expected);
  }
});

test("el historial conserva montos congelados, documentos y sentido del saldo sin consultar parámetros actuales", async () => {
  const api = harness({ history: [settled(1, { saldoNeto: "-300.25", direccionSaldo: "CONSIGNACION_ALIADO" })] });
  const [result] = await api.storage.listAllyPaymentHistory({ allyId: 7 });
  assert.equal(result.totalCreditoAutorizado, 800.25);
  assert.equal(result.totalIntermediacion, 80.03);
  assert.equal(result.items[0].porcentajeIntermediacion, 10);
  assert.equal(result.items[0].valorPagar, 720.22);
  assert.equal(result.items[0].clienteDocumento, "001234567890");
  assert.equal(result.items[0].imei, "000012345678901");
  assert.equal(result.items[0].folio, "0000-F-1");
  assert.equal(result.recaudos[0].valor, 120.09);
  assert.equal(result.saldoNeto, -300.25);
  assert.equal(result.direccionSaldo, "CONSIGNACION_ALIADO");
  assert.equal(result.valorConsignarAliado, 300.25);
  assert.equal(result.registradoPorNombre, "Usuario histórico QA");
  assert.deepEqual(api.calls.map(([name]) => name), ["history"]);
});

test("pendientes entrega metadata de recaudos aunque el crédito ya no esté en los créditos pendientes", async () => {
  const api = harness({ credits: [creditRow], collections: [collectionRow] });
  const result = await api.storage.listAllyPaymentPending({ allyId: 7 });
  assert.equal(result.items[0].fechaCredito, "2026-08-31");
  assert.equal(result.items[0].fechaLiquidacion, "2026-09-01");
  assert.equal(result.items[0].clienteDocumento, "001000000001");
  assert.equal(result.items[0].imei, "000000000000189");
  const collection = result.recaudos[0];
  assert.equal(collection.creditoId, 987);
  assert.equal(collection.fechaAbono, "2026-10-07T04:30:00.000Z");
  assert.equal(dates.colombiaDateKey(collection.fechaAbono), "2026-10-06");
  assert.deepEqual(plain(collection.aliado), { id: 7, nombre: "Aliado QA" });
  assert.equal(collection.plataforma, "ANDROID", "El snapshot contractual prevalece sobre la marca.");
  assert.equal(collection.imei, "000098765432101");
  assert.equal(collection.clienteDocumento, "009876543210");
  assert.equal(collection.folio, "00000987");
  assert.equal(collection.valor, 123.45);
  assert.equal(result.summary.total.totalIntermediacion, 120.04);
  assert.equal(result.totalPagarCreditos, 680.21);
  assert.equal(result.totalRecaudosAliado, 123.45);
  assert.equal(result.saldoNeto, 556.76);
  const collectionQuery = api.calls.find(([, sql]) => sql.includes('FROM public."CreditoAbono"'));
  assert.deepEqual(collectionQuery[2], ["FINSERPAY", 7]);
  assert.match(collectionQuery[1], /snapshot\."id" IS NULL/);
  assert.match(collectionQuery[1], /payment\."anuladoAt" IS NULL/);
  assert.match(collectionQuery[1], /CreditAllyPaymentExclusion/);
  assert.doesNotMatch(collectionQuery[1], /\bLIMIT\b|\bOFFSET\b/);
});

test("recaudos pendientes usa deviceUid y marca solo cuando faltan IMEI o plataforma congelada", async () => {
  const api = harness({ collections: [{ ...collectionRow, imei: null, deviceUid: "000000000000099", contratoSnapshot: null, equipoMarca: "Apple" }] });
  const result = await api.storage.listAllyPaymentPending({ allyId: null });
  assert.equal(result.recaudos[0].imei, "000000000000099");
  assert.equal(result.recaudos[0].plataforma, "IPHONE");
  assert.equal(result.items.length, 0);
  assert.equal(result.totalRecaudosAliado, 123.45);
  assert.equal(result.saldoNeto, -123.45);
});

test("GET entrega todo el historial autorizado y rechaza un aliado fuera de alcance antes de consultar", async () => {
  const api = harness({
    history: Array.from({ length: 245 }, (_, index) => settled(index + 1)),
    credits: [creditRow], collections: [collectionRow],
  });
  const route = load("app/api/pagos-aliados/route.ts", {
    "node:crypto": crypto, "next/server": { NextResponse: Response },
    "@/lib/credit-display-number-server": { withSettlementDisplayNumbers: async rows => rows },
    "@/lib/ally-payment-access": {
      getAllyPaymentAccess: async () => ({ ok: true, kind: "ALLY_ADMIN", allyId: 7, user: { id: 4, nombre: "Admin aliado QA" } }),
      canCreateAllyPayment: () => false,
    },
    "@/lib/ally-payments": api.storage,
  });
  const denied = await route.GET(new Request("https://finserpay.test/api/pagos-aliados?aliadoId=8"));
  assert.equal(denied.status, 403);
  assert.equal(api.calls.length, 0);
  const response = await route.GET(new Request("https://finserpay.test/api/pagos-aliados"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const result = await response.json();
  assert.equal(result.settlements.length, 245);
  assert.equal(result.pending.recaudos[0].aliado.id, 7);
  assert.equal(result.pending.recaudos[0].imei, "000098765432101");
  assert.equal(result.pending.items[0].fechaLiquidacion, "2026-09-01");
  assert.equal(result.preview, null, "Los filtros cliente no ejecutan una previsualización ni escritura.");
  assert.equal(api.calls.find(([name]) => name === "history")[1].where.aliadoId, 7);
  assert.deepEqual(api.calls.find(([, sql]) => typeof sql === "string" && sql.includes('FROM public."CreditoAbono"'))[2], ["FINSERPAY", 7]);
});
