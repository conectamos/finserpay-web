import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the real storage service against an isolated Prisma-shaped ledger.
// No network, application session, or production database is used.
function load(file, dependencies = {}) {
  const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, Date, RangeError, console,
    require(name) {
      assert.ok(name in dependencies, "Unexpected dependency: " + name);
      return dependencies[name];
    },
  }, { filename: file });
  return loadedModule.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const core = load("lib/ally-payments-core.ts");
const dates = load("lib/colombia-date.ts");
const allies = load("lib/aliados.ts");
const flags = load("lib/credit-import-flags.ts");
const policy = load("lib/credit-approval-policy.ts", { "./credit-import-flags": flags });
const eligibility = load("lib/ally-payment-eligibility.ts", {
  "./ally-payments-core": core, "./credit-approval-policy": policy,
});
const annulments = {
  loadPendingAllyPaymentAnnulmentAdjustments: async () => [],
  lockAllyPaymentAlly: async (database, allyId) => database.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    "ALLY_PAYMENT_ALLY:" + allyId
  ),
  serializeStoredAllyPaymentAnnulmentAdjustment: item => item,
  totalAllyPaymentAnnulmentAdjustments: items => items.reduce(
    (total, item) => Number((total + Number(item.valorDescuento || 0)).toFixed(2)),
    0
  ),
};

function credit(id, platform = "IPHONE") {
  return {
    id, fechaCredito: new Date("2026-10-07T12:00:00Z"), fechaLiquidacion: new Date("2026-10-07T12:00:00Z"),
    approvalRevision: 2, folio: `0000-F-${id}`, clienteNombre: `Cliente sintético ${id}`,
    clienteDocumento: "001234567890", imei: "000012345678901", deviceUid: "unused-device",
    referenciaEquipo: `Equipo sintético ${id}`, equipoMarca: platform === "IPHONE" ? "Apple" : "Samsung",
    equipoModelo: "QA", valorEquipoTotal: "1000.25", cuotaInicial: "200.00",
    contratoSnapshot: { equipo: { plataforma: platform } }, aliadoId: 7, aliadoNombre: "Aliado sintético",
    sedeId: 4, sedeNombre: "Sede sintética", redescuentoPorcentaje: 10,
    redescuentoAndroidPorcentaje: 10, redescuentoIphonePorcentaje: 15,
  };
}

function ledger({ rows = [credit(1)], collectionValue = "123.45" } = {}) {
  const calls = [];
  const settlements = [];
  const collections = [{
    id: 99, creditoId: 1, sedeId: 4, fechaAbono: new Date("2026-10-07T12:30:00Z"),
    folio: "0000-F-1", clienteNombre: "Cliente sintético 1", clienteDocumento: "001234567890",
    imei: "000012345678901", deviceUid: "unused-device", contratoSnapshot: { equipo: { plataforma: "IPHONE" } },
    equipoMarca: "Apple", aliadoId: 7, aliadoNombre: "Aliado sintético", sedeNombre: "Sede sintética",
    metodoPago: "BRE-B", valor: collectionValue,
  }];
  const ally = { id: 7, nombre: "Aliado sintético", codigo: "QA", activo: true };
  const database = {
    async $executeRawUnsafe(sql, ...values) {
      calls.push(["lock", sql, plain(values)]);
      return 1;
    },
    async $queryRawUnsafe(sql, ...values) {
      calls.push(["sql", sql, plain(values)]);
      return sql.includes('FROM public."CreditoAbono"')
        ? collections.filter(row => !settlements.some(item => item.recaudos.some(saved => saved.abonoId === row.id)))
        : rows.filter(row => !settlements.some(item => item.creditos.some(saved => saved.creditoId === row.id)));
    },
    aliado: { async findUnique() { calls.push(["ally"]); return ally; } },
    liquidacionAliado: {
      async findUnique({ where }) {
        calls.push(["unique", plain(where)]);
        return settlements.find(item => where.mutationId
          ? item.mutationId === where.mutationId
          : item.numeroAprobacionNormalizado === where.numeroAprobacionNormalizado) || null;
      },
      async findFirst({ where }) {
        calls.push(["detail", plain(where)]);
        return settlements.find(item => item.id === where.id &&
          (where.aliadoId === undefined || item.aliado.id === where.aliadoId)) || null;
      },
      async findMany({ where }) {
        calls.push(["history", plain(where)]);
        return settlements.filter(item => where.aliadoId === undefined || item.aliado.id === where.aliadoId);
      },
      async create({ data }) {
        calls.push(["create", plain(data)]);
        const result = {
          ...data, id: settlements.length + 1, aliado: ally,
          pagadoAt: new Date("2026-10-09T15:00:00Z"), createdAt: new Date("2026-10-09T15:00:00Z"),
          creditos: (data.creditos?.create || []).map((item, index) => ({
            ...item, id: index + 1, creditoId: item.credito.connect.id,
            credito: { sede: { id: 4, nombre: "Sede sintética" } },
          })),
          recaudos: (data.recaudos?.create || []).map((item, index) => ({ ...item, id: index + 1 })),
          ajustesAnulacion: [],
        };
        settlements.push(result);
        return result;
      },
    },
    async $transaction(run, options) {
      calls.push(["transaction", plain(options)]);
      return run(database);
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
  const preview = () => storage.getAllyPaymentPreview({ allyId: 7, startDate: "2026-10-01", endDate: "2026-10-08" });
  const confirmation = (token, adjustments = [], overrides = {}) => ({
    mutationId: crypto.randomUUID(), allyId: 7, startDate: "2026-10-01", endDate: "2026-10-08",
    numeroAprobacionBancaria: "0000-QA-09", previewToken: token,
    intermediationAdjustments: adjustments, registradoPorUsuarioId: 3,
    registradoPorNombre: "Administrador sintético", ...overrides,
  });
  return { storage, rows, collections, calls, settlements, preview, confirmation };
}

test("confirmación guarda todos los ajustes y los dos productos; central y aliado leen el mismo snapshot", async () => {
  const api = ledger({ rows: [...Array.from({ length: 11 }, (_, i) => credit(i + 1)), credit(12, "ANDROID")] });
  const preview = await api.preview();
  assert.equal(preview.items.length, 12, "La liquidación no se limita a una página de diez créditos.");
  const result = await api.storage.createAllyPayment(api.confirmation(preview.token, [
    { creditoId: 1, porcentajeIntermediacion: 0 }, { creditoId: 11, porcentajeIntermediacion: 5.25 },
  ]));
  assert.equal(result.items.length, 12);
  assert.equal(result.items[0].porcentajeIntermediacion, 0);
  assert.equal(result.items[0].valorPagar, 800.25);
  assert.equal(result.items[10].porcentajeIntermediacion, 5.25);
  assert.equal(result.items[10].valorIntermediacion, 42.01);
  assert.equal(result.items[10].valorPagar, 758.24);
  assert.equal(result.summary.IPHONE.numeroCreditos, 11);
  assert.equal(result.summary.IPHONE.porcentajeIntermediacion, null, "Tasas distintas se presentan como Mixto.");
  assert.equal(result.summary.IPHONE.totalIntermediacion, 1122.37);
  assert.equal(result.summary.IPHONE.totalPagar, 7680.38);
  assert.equal(result.summary.ANDROID.totalIntermediacion, 80.03);
  assert.equal(result.totalPagarCreditos, 8400.60);
  assert.equal(result.totalRecaudosAliado, 123.45);
  assert.equal(result.saldoNeto, 8277.15);
  assert.equal(result.items[0].clienteDocumento, "001234567890");
  assert.equal(result.items[0].imei, "000012345678901");
  assert.equal(result.items[0].folio, "0000-F-1");
  assert.equal(result.recaudos[0].metodoPago, "BRE-B");
  const persisted = api.calls.find(([kind]) => kind === "create")[1];
  assert.equal(persisted.totalPagar, "8400.60");
  assert.equal(persisted.saldoNeto, "8277.15");
  assert.equal(persisted.creditos.create[10].porcentajeIntermediacion, "5.2500");
  assert.deepEqual(api.calls.find(([kind]) => kind === "transaction")[1], {
    isolationLevel: "Serializable", maxWait: 5000, timeout: 20000,
  });
  // A later change in product prices or configured rates cannot rewrite history.
  api.rows.forEach(row => { row.valorEquipoTotal = "99999999"; row.redescuentoIphonePorcentaje = 99; });
  api.collections[0].valor = "99999999";
  api.calls.length = 0;
  const central = await api.storage.getAllyPaymentDetail({ id: result.id, allyId: null });
  const ally = await api.storage.getAllyPaymentDetail({ id: result.id, allyId: 7 });
  assert.deepEqual(plain(central), plain(ally));
  assert.equal(central.saldoNeto, 8277.15);
  assert.equal(central.items[10].valorPagar, 758.24);
  assert.deepEqual(api.calls.map(([kind]) => kind), ["detail", "detail"]);
  await assert.rejects(api.storage.getAllyPaymentDetail({ id: result.id, allyId: 8 }), error => error.name === "AllyPaymentNotFoundError");
});

test("reintentar la misma confirmación es idempotente y cambiar sus ajustes da conflicto", async () => {
  const api = ledger();
  const preview = await api.preview();
  const input = api.confirmation(preview.token, [{ creditoId: 1, porcentajeIntermediacion: 5 }]);
  const first = await api.storage.createAllyPayment(input);
  const retry = await api.storage.createAllyPayment(input);
  assert.equal(first.idempotent, false);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.id, first.id);
  assert.equal(api.settlements.length, 1);
  assert.equal(api.calls.filter(([kind]) => kind === "create").length, 1);
  await assert.rejects(api.storage.createAllyPayment({ ...input,
    intermediationAdjustments: [{ creditoId: 1, porcentajeIntermediacion: 0 }],
  }), error => error.code === "ALLY_PAYMENT_MUTATION_CONFLICT");
  const after = await api.preview();
  assert.equal(after.items.length, 0, "Un crédito conciliado no vuelve a ser elegible.");
  assert.equal(after.recaudos.length, 0, "Un abono conciliado no vuelve a descontarse.");
});

test("cambios en recaudos o aprobación invalidan el token antes de guardar", async t => {
  for (const change of [api => { api.collections[0].valor = "124.45"; }, api => { api.rows[0].approvalRevision += 1; }]) {
    await t.test("previsualización obsoleta", async () => {
      const api = ledger();
      const preview = await api.preview();
      change(api);
      await assert.rejects(api.storage.createAllyPayment(api.confirmation(preview.token)),
        error => error.code === "ALLY_PAYMENT_PREVIEW_CHANGED");
      assert.equal(api.settlements.length, 0);
      assert.equal(api.calls.some(([kind]) => kind === "create"), false);
    });
  }
});

test("solo acepta ajustes de créditos vigentes y porcentajes numéricos con máximo dos decimales", async () => {
  const api = ledger();
  const preview = await api.preview();
  for (const adjustment of [
    { creditoId: 1, porcentajeIntermediacion: "5" },
    { creditoId: 1, porcentajeIntermediacion: 5.123 },
    { creditoId: 1, porcentajeIntermediacion: -1 },
    { creditoId: 1, porcentajeIntermediacion: 101 },
    { creditoId: 999, porcentajeIntermediacion: 5 },
  ]) {
    await assert.rejects(api.storage.createAllyPayment(api.confirmation(preview.token, [adjustment])),
      error => error.name === "AllyPaymentValidationError");
  }
  assert.equal(api.settlements.length, 0);
});

test("la confirmación persiste consignación del aliado o saldo cero según el neto real", async () => {
  for (const [collectionValue, balance, direction] of [
    ["900.35", -220.14, "CONSIGNACION_ALIADO"], ["680.21", 0, "SALDO_CERO"],
  ]) {
    const api = ledger({ collectionValue });
    const preview = await api.preview();
    const result = await api.storage.createAllyPayment(api.confirmation(preview.token));
    assert.equal(result.totalPagarCreditos, 680.21);
    assert.equal(result.saldoNeto, balance);
    assert.equal(result.direccionSaldo, direction);
    assert.equal(result.valorPagarAliado, 0);
    assert.equal(result.valorConsignarAliado, Math.max(-balance, 0));
    assert.equal(api.settlements[0].direccionSaldo, direction);
  }
});
