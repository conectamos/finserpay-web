import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const factory = await jiti.import("../lib/credit-factory.ts");
const amortization = await jiti.import("../lib/credit-amortization.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const {
  createAdministrativeAmortization, ensureCreditPlanRevisionSchema,
  insertCreditPlanRevision, getLatestCreditPlanAmortization, getCreditPlanTermsAtDate,
} = loadReissueModule("lib/credit-plan-revision.ts", {
  "@/lib/prisma": { default: { $executeRawUnsafe: () => { throw new Error("No production database calls"); } } },
  "@/lib/credit-factory": factory,
  "@/lib/credit-amortization": amortization,
});

function stored(version = "ARES_FRANCES_V2", overrides = {}) {
  const settings = {
    calculoVersion: version, valorVenta: 2500000, cuotaInicial: 500000, numeroCuotas: 16,
    tasaInteresEa: 29.66, fianzaCuotaPorcentaje: 2.083333333333, seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-09-17", tasaPeriodoDecimales: version === "FRANCES_V1" ? 12 : 6,
    redondeoComercial: version === "FRANCES_V1" ? { modo: "REDONDEO", multiplo: 100 } : { modo: "PISO", multiplo: 50 },
    ...overrides,
  };
  const result = amortization.calculateFrenchAmortization(settings);
  const amount = (value, places = 6) => value.toFixed(places);
  return {
    id: 5, creditoId: 72, calculoVersion: result.version, frecuenciaPago: result.frecuenciaPago,
    periodosPorAnio: result.periodosPorAno, numeroCuotas: result.numeroCuotas,
    valorVenta: amount(result.valorVenta), cuotaInicial: amount(result.cuotaInicial), valorFinanciado: amount(result.valorFinanciado),
    tasaInteresEaPorcentaje: amount(result.tasaInteresEa, 12), tasaPeriodo: amount(result.tasaPeriodo, 12),
    fianzaCuotaPorcentaje: amount(result.fianzaCuotaPorcentaje, 12), seguroCuotaPorcentaje: amount(result.seguroCuotaPorcentaje, 12),
    cuotaCreditoExacta: amount(result.cuotaCredito), cuotaFianzaExacta: amount(result.cuotaFianza), cuotaSeguroExacta: amount(result.cuotaSeguro),
    cuotaTotalExacta: amount(result.cuotaTotal), cuotaComercial: amount(result.cuotaComercial, 2), totalInteres: amount(result.valorInteresTotal),
    totalFianza: amount(result.valorFianzaTotal), totalSeguro: amount(result.valorSeguroTotal), totalPagar: amount(result.montoTotal),
    checksum: "original-signed-plan-checksum", aprobadoAt: "2026-09-01T15:00:00.000Z", createdAt: "2026-09-01T15:00:00.000Z",
    parametrosSnapshot: { tasaPeriodoDecimales: settings.tasaPeriodoDecimales, redondeoComercial: settings.redondeoComercial,
      origenFianza: "POR_CUOTA", origenParametros: { tasa: "POLITICA_HISTORICA" } },
    cuotas: result.cuotas.map((item, index) => ({ ...item, id: 100 + index, amortizacionId: 5,
      createdAt: "2026-09-01T15:00:00.000Z", saldoInicial: amount(item.saldoInicial), interes: amount(item.interes),
      abonoCapital: amount(item.abonoCapital), fianza: amount(item.fianza), seguro: amount(item.seguro),
      cuotaCredito: amount(item.cuotaCredito), cuotaTotal: amount(item.cuotaTotal), cuotaCobro: amount(item.cuotaCobro, 2), saldoFinal: amount(item.saldoFinal),
    })),
  };
}
const copy = value => JSON.parse(JSON.stringify(value));
const revise = (current, input = {}) => createAdministrativeAmortization(current, {
  numeroCuotas: current.numeroCuotas, frecuenciaPago: current.frecuenciaPago, fechaPrimerPago: "2026-11-17", ...input,
});

for (const version of ["FRANCES_V1", "ARES_FRANCES_V1", "ARES_FRANCES_V2"]) {
  test(`${version}: calendar-only revision preserves every amount and the signed source`, () => {
    const current = stored(version);
    const before = copy(current);
    const after = revise(current);
    assert.deepEqual(current, before);
    assert.notEqual(after.checksum, current.checksum);
    assert.match(after.checksum, /^[a-f0-9]{64}$/);
    assert.equal(after.cuotas[0].fechaVencimiento, "2026-11-17");
    assert.equal(after.cuotas.at(-1).fechaVencimiento, "2028-02-17");
    assert.equal(after.aprobadoAt, current.aprobadoAt);
    assert.equal(after.totalPagar, current.totalPagar);
    for (let index = 0; index < after.cuotas.length; index++) {
      const { fechaVencimiento: _afterDate, ...a } = after.cuotas[index];
      const { fechaVencimiento: _beforeDate, ...b } = current.cuotas[index];
      assert.deepEqual(a, b);
    }
    assert.equal(revise(current).checksum, after.checksum);
  });

  test(`${version}: changed terms use saved financial parameters and exact rounding`, () => {
    const current = stored(version, version === "ARES_FRANCES_V1" ? { tasaPeriodoDecimales: 5, redondeoComercial: { modo: "REDONDEO", multiplo: 500 } } : {});
    const before = copy(current);
    const after = revise(current, { numeroCuotas: 24, frecuenciaPago: "QUINCENAL" });
    const expected = amortization.calculateFrenchAmortization({
      calculoVersion: version, valorVenta: Number(current.valorVenta), cuotaInicial: Number(current.cuotaInicial),
      numeroCuotas: 24, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-11-17",
      tasaInteresEa: Number(current.tasaInteresEaPorcentaje), fianzaCuotaPorcentaje: Number(current.fianzaCuotaPorcentaje),
      seguroCuotaPorcentaje: Number(current.seguroCuotaPorcentaje), ...current.parametrosSnapshot,
    });
    assert.deepEqual(current, before);
    assert.equal(after.calculoVersion, version);
    assert.equal(after.totalPagar, expected.montoTotal.toFixed(6));
    assert.equal(after.cuotaComercial, expected.cuotaComercial.toFixed(2));
    assert.equal(after.tasaPeriodo, expected.tasaPeriodo.toFixed(12));
    assert.equal(after.periodosPorAnio, 24);
    assert.equal(after.cuotas.length, 24);
    assert.equal(after.cuotas[1].fechaVencimiento, "2026-12-02");
    assert.equal(after.cuotas.at(-1).saldoFinal, "0.000000");
    for (let index = 0; index < expected.cuotas.length; index++) {
      assert.equal(after.cuotas[index].cuotaCobro, expected.cuotas[index].cuotaCobro.toFixed(2));
      assert.equal(after.cuotas[index].interes, expected.cuotas[index].interes.toFixed(6));
    }
    if (version === "ARES_FRANCES_V2") {
      assert.equal(Number(after.totalPagar), Number(after.cuotaComercial) * after.numeroCuotas);
      assert.equal(after.parametrosSnapshot.cuotaPactada, expected.cuotaCobro);
    }
  });
}

test("TOTAL_CREDITO preserves the saved total surety percentage when extending the plan", () => {
  const current = stored("ARES_FRANCES_V2", { fianzaCuotaPorcentaje: 75 / 16 });
  current.parametrosSnapshot.origenFianza = "TOTAL_CREDITO";
  current.parametrosSnapshot.fianzaTotalPorcentaje = 75;
  const after = revise(current, { numeroCuotas: 30 });
  assert.equal(after.fianzaCuotaPorcentaje, "2.500000000000");
  assert.equal(after.totalFianza, current.totalFianza);
  const broken = copy(current);
  delete broken.parametrosSnapshot.fianzaTotalPorcentaje;
  assert.throws(() => revise(broken, { numeroCuotas: 30 }), /fianzaTotalPorcentaje/);
});

test("rejects invalid dates, frequency, counts and historical configuration instead of using current defaults", () => {
  const current = stored();
  for (const date of ["2026-02-30", "2026-13-01", "not-a-date", "17/11/2026"]) assert.throws(() => revise(current, { fechaPrimerPago: date }), /fecha/);
  for (const count of [0, -1, 1.2, 61, Infinity]) assert.throws(() => revise(current, { numeroCuotas: count }), /numeroCuotas/);
  assert.throws(() => revise(current, { frecuenciaPago: "INVALIDA" }), /frecuenciaPago/);
  const missing = copy(current);
  delete missing.parametrosSnapshot.redondeoComercial;
  assert.throws(() => revise(missing, { numeroCuotas: 24 }), /históricos/);
  assert.equal(revise(missing).totalPagar, current.totalPagar, "Moving dates does not need recalculation parameters");
  const invalidRateRounding = copy(current);
  invalidRateRounding.parametrosSnapshot.tasaPeriodoDecimales = null;
  assert.throws(() => revise(invalidRateRounding, { numeroCuotas: 24 }), /históricos/);
  const incomplete = copy(current);
  incomplete.cuotas.pop();
  assert.throws(() => revise(incomplete), /todas las cuotas/);
});

test("monthly date shifts clamp month ends using the existing calendar", () => {
  const after = revise(stored(), { fechaPrimerPago: "2027-01-31" });
  assert.deepEqual(Array.from(after.cuotas.slice(0, 3), item => item.fechaVencimiento), ["2027-01-31", "2027-02-28", "2027-03-31"]);
});

for (const [firstDueDate, secondDueDate] of [["2027-01-31", "2027-02-28"], ["2028-01-31", "2028-02-29"], ["2028-02-29", "2028-03-29"]]) {
  test(`monthly collection and stored revision share the full calendar from ${firstDueDate}`, () => {
    const after = revise(stored(), { fechaPrimerPago: firstDueDate });
    const operational = buildCreditPaymentPlan({
      montoCredito: Number(after.totalPagar), valorCuota: Number(after.cuotaComercial), plazoMeses: after.numeroCuotas,
      frecuenciaPago: after.frecuenciaPago, fechaPrimerPago: firstDueDate, today: "2026-01-01",
    });
    assert.equal(after.cuotas[1].fechaVencimiento, secondDueDate);
    assert.deepEqual(operational.installments.map(item => item.fechaVencimiento), Array.from(after.cuotas, item => item.fechaVencimiento));
    assert.equal(operational.installments.at(-1).fechaVencimiento, after.cuotas.at(-1).fechaVencimiento);
  });
}

test("quincenal collection dates remain 02 and 17 across leap years and match revised amortization", () => {
  const after = revise(stored(), { frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2028-02-17" });
  const operational = buildCreditPaymentPlan({
    montoCredito: Number(after.totalPagar), valorCuota: Number(after.cuotaComercial), plazoMeses: after.numeroCuotas,
    frecuenciaPago: after.frecuenciaPago, fechaPrimerPago: "2028-02-17", today: "2026-01-01",
  });
  assert.deepEqual(operational.installments.slice(0, 4).map(item => item.fechaVencimiento), ["2028-02-17", "2028-03-02", "2028-03-17", "2028-04-02"]);
  assert.deepEqual(operational.installments.map(item => item.fechaVencimiento), Array.from(after.cuotas, item => item.fechaVencimiento));
});

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY); CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY); INSERT INTO "Credito" VALUES (72),(99); INSERT INTO "Usuario" VALUES (7)');
  const client = {
    $queryRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).affectedRows ?? 0,
  };
  await ensureCreditPlanRevisionSchema(client);
  const save = (plan, overrides = {}) => insertCreditPlanRevision(client, {
    creditoId: 72, usuarioId: 7, nombreUsuario: "Administrador central", motivo: "Ajuste solicitado y autorizado",
    beforeSnapshot: { plazoMeses: 16 }, afterSnapshot: { plazoMeses: plan.numeroCuotas }, amortizationSnapshot: plan, ...overrides,
  });
  return { db, client, save };
}

test("decimal storage uses PostgreSQL half-up precision instead of binary toFixed ties", async t => {
  const f = await fixture(t);
  const current = stored("FRANCES_V1", { valorVenta: 0.000001, cuotaInicial: 0,
    tasaInteresEa: 0, fianzaCuotaPorcentaje: 0, seguroCuotaPorcentaje: 0 });
  const after = revise(current, { numeroCuotas: 2 });
  const { rows } = await f.db.query("SELECT $1::numeric(20,6)::text AS amount", [String(0.000001 / 2)]);
  assert.equal(rows[0].amount, "0.000001");
  assert.equal(after.cuotaCreditoExacta, rows[0].amount);
  assert.equal(after.cuotas[0].abonoCapital, rows[0].amount);
});

test("append-only persistence scopes the latest snapshot and retains the complete actor audit", async t => {
  const f = await fixture(t);
  assert.equal(await getLatestCreditPlanAmortization(72, f.client), null);
  const first = revise(stored());
  const firstRow = await f.save(first);
  const second = revise(first, { fechaPrimerPago: "2026-12-17" });
  const secondRow = await f.save(second);
  assert.ok(secondRow.id > firstRow.id);
  assert.deepEqual(copy(await getLatestCreditPlanAmortization(72, f.client)), copy(second));
  assert.equal(await getLatestCreditPlanAmortization(99, f.client), null);
  const { rows } = await f.db.query('SELECT * FROM "CreditPaymentPlanRevision" ORDER BY "id"');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usuarioId, 7);
  assert.equal(rows[0].nombreUsuario, "Administrador central");
  assert.equal(rows[0].motivo, "Ajuste solicitado y autorizado");
  assert.equal(rows[0].amortizationSnapshot.checksum, first.checksum);
  assert.deepEqual(rows[0].beforeSnapshot, { plazoMeses: 16 });
  assert.ok(firstRow.createdAt);
  await assert.rejects(f.db.query('DELETE FROM "Usuario" WHERE "id"=7'), /foreign key/i);
  await assert.rejects(f.db.query('DELETE FROM "Credito" WHERE "id"=72'), /foreign key/i);
});

test("corrupt, cross-credit or modified latest revisions fail closed instead of reverting to the signed plan", async t => {
  const f = await fixture(t);
  const after = revise(stored());
  await f.save(after);
  const corrupt = copy(after);
  corrupt.totalPagar = "1";
  await assert.rejects(f.save(corrupt), /huella/);
  await assert.rejects(f.save(after, { creditoId: 99 }), /corresponde/);
  await assert.rejects(f.save(after, { motivo: "" }), /motivo/);
  await f.db.query('UPDATE "CreditPaymentPlanRevision" SET "amortizationSnapshot"=$1::jsonb', [JSON.stringify(corrupt)]);
  await assert.rejects(getLatestCreditPlanAmortization(72, f.client), /huella/);
  await f.db.query('UPDATE "CreditPaymentPlanRevision" SET "amortizationSnapshot"=$1::jsonb', [JSON.stringify({ ...after, cuotas: [] })]);
  await assert.rejects(getLatestCreditPlanAmortization(72, f.client), /todas las cuotas/);
});

const operationalTerms = (plan, extras = {}) => ({
  montoCredito: Number(plan.totalPagar), valorCuota: Number(plan.cuotaComercial), plazoMeses: plan.numeroCuotas,
  frecuenciaPago: plan.frecuenciaPago, fechaPrimerPago: `${plan.cuotas[0].fechaVencimiento}T00:00:00.000Z`,
  fechaProximoPago: `${plan.cuotas[0].fechaVencimiento}T00:00:00.000Z`,
  valorInteres: Number(plan.totalInteres), valorFianza: Number(plan.totalFianza), tasaInteresEa: Number(plan.tasaInteresEaPorcentaje),
  ...extras,
});

test("receipt terms use the first revision after the accounting date, scoped per credit", async t => {
  const f = await fixture(t);
  const original = stored();
  const first = revise(original, { numeroCuotas: 24 });
  const second = revise(first, { numeroCuotas: 30 });
  const source = operationalTerms(original, { contratoSnapshot: { shouldNeverOverwriteSignedDocument: true }, usuarioId: 7 });
  const middle = operationalTerms(first);
  const row1 = await f.save(first, { beforeSnapshot: source, afterSnapshot: middle });
  const row2 = await f.save(second, { beforeSnapshot: middle, afterSnapshot: operationalTerms(second) });
  await f.db.query('UPDATE "CreditPaymentPlanRevision" SET "createdAt"=$2::timestamp WHERE "id"=$1', [row1.id, "2026-10-01T15:00:00.000Z"]);
  await f.db.query('UPDATE "CreditPaymentPlanRevision" SET "createdAt"=$2::timestamp WHERE "id"=$1', [row2.id, "2026-10-05T15:00:00.000Z"]);
  const before = await getCreditPlanTermsAtDate(72, new Date("2026-09-30T15:00:00Z"), f.client);
  assert.equal(before.plazoMeses, 16);
  assert.equal(before.montoCredito, Number(original.totalPagar));
  assert.equal(before.fechaPrimerPago, original.cuotas[0].fechaVencimiento);
  assert.equal(before.fechaProximoPago, original.cuotas[0].fechaVencimiento);
  assert.equal("contratoSnapshot" in before, false);
  assert.equal("usuarioId" in before, false);
  const between = await getCreditPlanTermsAtDate(72, "2026-10-03T15:00:00Z", f.client);
  assert.equal(between.plazoMeses, 24);
  assert.equal(between.montoCredito, Number(first.totalPagar));
  const equalFirst = await getCreditPlanTermsAtDate(72, "2026-10-01T15:00:00Z", f.client);
  assert.equal(equalFirst.plazoMeses, 24, "The timestamp boundary is strictly after the accounting event");
  assert.equal(await getCreditPlanTermsAtDate(72, "2026-10-06T15:00:00Z", f.client), null);
  assert.equal(await getCreditPlanTermsAtDate(99, "2026-09-30T15:00:00Z", f.client), null);
});

test("historical operational terms fail closed on corrupt dates, amounts and missing snapshots", async t => {
  const f = await fixture(t);
  const original = stored();
  const after = revise(original);
  const saved = await f.save(after, { beforeSnapshot: operationalTerms(original) });
  await f.db.query('UPDATE "CreditPaymentPlanRevision" SET "createdAt"=$2::timestamp WHERE "id"=$1', [saved.id, "2026-10-01T15:00:00Z"]);
  const corrupt = async before => {
    await f.db.query('UPDATE "CreditPaymentPlanRevision" SET "beforeSnapshot"=$2::jsonb WHERE "id"=$1', [saved.id, JSON.stringify(before)]);
    await assert.rejects(getCreditPlanTermsAtDate(72, "2026-09-01T15:00:00Z", f.client));
  };
  await corrupt(null);
  await corrupt({});
  await corrupt(operationalTerms(original, { montoCredito: "not-an-amount" }));
  await corrupt(operationalTerms(original, { fechaPrimerPago: "2026-02-30T00:00:00Z" }));
  await corrupt(operationalTerms(original, { frecuenciaPago: "INVALIDA" }));
  await assert.rejects(getCreditPlanTermsAtDate(72, "invalid", f.client), /fecha/);
  await f.db.query('UPDATE "CreditPaymentPlanRevision" SET "beforeSnapshot"=$2::jsonb WHERE "id"=$1', [saved.id, JSON.stringify(operationalTerms(original, { fechaProximoPago: null }))]);
  assert.equal((await getCreditPlanTermsAtDate(72, "2026-09-01T15:00:00Z", f.client)).fechaProximoPago, null);
});
