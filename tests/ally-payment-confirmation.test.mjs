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
const centralCollectionAdjustments = load(
  "lib/ally-payment-central-collection-adjustments.ts",
  { "server-only": {} }
);

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

function centralAdjustment(id = 501, value = "110000.00") {
  return {
    id,
    abonoId: 1574,
    creditoId: 30_000_014,
    aliadoId: 7,
    aliadoNombre: "Aliado sintético",
    fechaRecaudo: new Date("2026-10-08T12:00:00Z"),
    fechaAjuste: new Date("2026-10-08T15:00:00Z"),
    folio: "300000014",
    clienteNombre: "MORENO MARIN LINA LUZ",
    clienteDocumento: "53068434",
    sedeId: 4,
    sedeNombre: "Sede sintética",
    metodoPago: "OTRO",
    liquidacionOrigenId: 901,
    valorAjuste: value,
    motivo: "Reintegro de recaudo registrado por FINSER PAY",
    usuarioRecaudoId: 1,
    usuarioRecaudoNombre: "Administrador",
    usuarioRecaudoLogin: "admin",
  };
}

function ledger({
  rows = [credit(1)],
  collectionValue = "123.45",
  centralAdjustmentRows = [],
  enqueueFailures = 0,
} = {}) {
  const calls = [];
  const settlements = [];
  const deliveries = [];
  let activeTransaction = null;
  const collections = collectionValue === null ? [] : [{
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
      if (sql.includes('FROM public."AjusteRecaudoCentralAliado"')) {
        return centralAdjustmentRows.filter(row =>
          !settlements.some(item => item.ajustesRecaudoCentral.some(
            saved => saved.ajuste.id === row.id
          ))
        );
      }
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
          ajustesRecaudoCentral: (data.ajustesRecaudoCentral?.create || []).map((item, index) => ({
            id: index + 1,
            valorAjuste: item.valorAjuste,
            estado: item.estado,
            ajuste: centralAdjustmentRows.find(row => row.id === item.ajuste.connect.id),
          })),
        };
        settlements.push(result);
        return result;
      },
    },
    async $transaction(run, options) {
      calls.push(["transaction", plain(options)]);
      const settlementCount = settlements.length;
      const deliveryCount = deliveries.length;
      const tx = { ...database };
      activeTransaction = tx;
      try {
        const result = await run(tx);
        calls.push(["commit"]);
        return result;
      } catch (error) {
        settlements.splice(settlementCount);
        deliveries.splice(deliveryCount);
        calls.push(["rollback"]);
        throw error;
      } finally {
        activeTransaction = null;
      }
    },
  };
  const storage = load("lib/ally-payments.ts", {
    "server-only": {}, "node:crypto": crypto, "@/lib/aliados": allies, "@/lib/ally-payments-core": core,
    "@/lib/colombia-date": dates, "@/lib/ally-payment-eligibility": eligibility,
    "@/lib/ally-payment-annulments": annulments,
    "@/lib/ally-payment-central-collection-adjustments": centralCollectionAdjustments,
    "@/lib/ally-settlement-delivery-store": {
      async enqueueInitialSettlementDeliveries(tx, settlement, actorUserId) {
        assert.equal(tx, activeTransaction, "La cola debe guardarse dentro de la misma transacción de la liquidación.");
        assert.notEqual(tx, database, "No debe escribirse la cola por fuera del cliente transaccional.");
        assert.ok(settlements.some((saved) => saved.id === settlement.id), "La liquidación debe existir antes de encolar.");
        calls.push(["enqueue", plain(settlement), actorUserId]);
        for (const channel of ["EMAIL", "WHATSAPP"]) {
          deliveries.push({ settlementId: settlement.id, channel, snapshot: plain(settlement), actorUserId });
        }
        if (enqueueFailures-- > 0) throw new Error("Outbox de prueba no disponible");
      },
    },
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
  return {
    storage,
    rows,
    collections,
    centralAdjustmentRows,
    calls,
    settlements,
    deliveries,
    preview,
    confirmation,
  };
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
  const enqueued = api.calls.filter(([kind]) => kind === "enqueue");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0][1].id, result.id);
  assert.equal(enqueued[0][1].aliado.id, 7);
  assert.equal(enqueued[0][1].saldoNeto, result.saldoNeto);
  assert.equal(enqueued[0][1].periodoInicio, result.periodoInicio);
  assert.equal(enqueued[0][1].periodoFin, result.periodoFin);
  assert.equal(enqueued[0][2], 3);
  assert.deepEqual(api.deliveries.map((delivery) => delivery.channel), ["EMAIL", "WHATSAPP"]);
  assert.ok(api.calls.findIndex(([kind]) => kind === "create") < api.calls.findIndex(([kind]) => kind === "enqueue"));
  assert.ok(api.calls.findIndex(([kind]) => kind === "enqueue") < api.calls.findIndex(([kind]) => kind === "commit"));
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
  assert.equal(api.calls.filter(([kind]) => kind === "enqueue").length, 1, "Repetir la operación guardada no encola nuevos envíos.");
  assert.equal(api.deliveries.length, 2);
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
      assert.equal(api.calls.some(([kind]) => kind === "enqueue"), false);
      assert.equal(api.deliveries.length, 0);
    });
  }
});

test("si falla la cola, revierte el registro y los intentos; el mismo mutationId puede confirmarse después", async () => {
  const api = ledger({ enqueueFailures: 1 });
  const preview = await api.preview();
  const input = api.confirmation(preview.token);
  await assert.rejects(api.storage.createAllyPayment(input), /Outbox de prueba no disponible/);
  assert.equal(api.settlements.length, 0, "No queda una liquidación sin sus envíos durables.");
  assert.equal(api.deliveries.length, 0, "La cola parcial se revierte junto a la liquidación.");
  assert.equal(api.calls.filter(([kind]) => kind === "rollback").length, 1);
  const current = await api.preview();
  assert.equal(current.items.length, 1, "El crédito no queda consumido por la transacción fallida.");
  assert.equal(current.recaudos.length, 1, "El recaudo queda disponible tras la reversión.");
  assert.equal(current.token, preview.token);
  const saved = await api.storage.createAllyPayment(input);
  assert.equal(saved.idempotent, false);
  assert.equal(api.settlements.length, 1);
  assert.equal(api.deliveries.length, 2);
  assert.equal(api.deliveries.every((delivery) => delivery.settlementId === saved.id), true);
  const replay = await api.storage.createAllyPayment(input);
  assert.equal(replay.idempotent, true);
  assert.equal(api.deliveries.length, 2);
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

test("una liquidación sin créditos conserva y descuenta el único recaudo pendiente", async () => {
  const api = ledger({ rows: [], collectionValue: "110000" });
  const preview = await api.preview();
  assert.equal(preview.items.length, 0);
  assert.equal(preview.recaudos.length, 1);
  assert.equal(preview.totalRecaudosAliado, 110000);
  assert.equal(preview.saldoNeto, -110000);
  assert.equal(preview.direccionSaldo, "CONSIGNACION_ALIADO");

  const result = await api.storage.createAllyPayment(api.confirmation(preview.token));
  assert.equal(result.numeroCreditos, 0);
  assert.equal(result.recaudos.length, 1);
  assert.equal(result.recaudos[0].abonoId, 99);
  assert.equal(result.totalPagarCreditos, 0);
  assert.equal(result.totalRecaudosAliado, 110000);
  assert.equal(result.saldoNeto, -110000);
  assert.equal(result.valorConsignarAliado, 110000);

  const persisted = api.calls.find(([kind]) => kind === "create")[1];
  assert.equal(persisted.creditos, undefined);
  assert.equal(persisted.recaudos.create[0].abonoId, 99);
});

test("el reintegro central se acredita una vez, queda congelado y no reaparece", async () => {
  const adjustment = centralAdjustment();
  const api = ledger({
    rows: [],
    collectionValue: null,
    centralAdjustmentRows: [adjustment],
  });
  const preview = await api.preview();

  assert.equal(preview.items.length, 0);
  assert.equal(preview.recaudos.length, 0);
  assert.equal(preview.ajustesRecaudoCentral.length, 1);
  assert.equal(preview.totalAjustesRecaudoCentral, 110000);
  assert.equal(preview.saldoNeto, 110000);
  assert.equal(preview.direccionSaldo, "PAGO_ALIADO");

  const result = await api.storage.createAllyPayment(api.confirmation(preview.token));
  assert.equal(result.numeroCreditos, 0);
  assert.equal(result.numeroAjustesRecaudoCentral, 1);
  assert.equal(result.totalAjustesRecaudoCentral, 110000);
  assert.equal(result.saldoNeto, 110000);
  assert.equal(result.valorPagarAliado, 110000);
  assert.equal(result.ajustesRecaudoCentral[0].abonoId, 1574);
  assert.equal(result.ajustesRecaudoCentral[0].usuarioRecaudoLogin, "admin");
  assert.equal(result.ajustesRecaudoCentral[0].estado, "ACREDITADO");

  const persisted = api.calls.find(([kind]) => kind === "create")[1];
  assert.equal(persisted.totalAjustesRecaudoCentral, "110000.00");
  assert.equal(persisted.saldoNeto, "110000.00");
  assert.deepEqual(plain(persisted.ajustesRecaudoCentral.create[0]), {
    valorAjuste: "110000.00",
    estado: "ACREDITADO",
    ajuste: { connect: { id: 501 } },
  });

  adjustment.valorAjuste = "999999.00";
  const historical = await api.storage.getAllyPaymentDetail({ id: result.id, allyId: 7 });
  assert.equal(historical.totalAjustesRecaudoCentral, 110000);
  assert.equal(historical.ajustesRecaudoCentral[0].valorAjuste, 110000);

  const after = await api.preview();
  assert.equal(after.ajustesRecaudoCentral.length, 0);
  assert.equal(after.totalAjustesRecaudoCentral, 0);
});
