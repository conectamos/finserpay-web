import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { calculateMassCreditComponents, readMassCreditComponents, getMassCreditInsurance,
  updateMassCreditComponentsForPayoff } = await jiti.import("../lib/mass-credit-financial-components.ts");
const { splitOutstandingBalance } = await jiti.import("../lib/credit-outstanding-balance.ts");

const imported = { capital: 2_800_000, cuota: 119_350, numeroCuotas: 48,
  fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03 };
function makeCredit() {
  const components = calculateMassCreditComponents(imported);
  const receipt = { tipo: "IMPORTACION_MASIVA", valorCredito: 2_800_000, cuota: 119_350, plazo: 48 };
  const marker = { ...components, audit: { reason: "Corrección autorizada del desglose", original: receipt } };
  return { montoCredito: components.total, saldoBaseFinanciado: components.capital,
    valorCuota: components.cuota, plazoMeses: components.numeroCuotas,
    valorFianza: components.fianza, valorInteres: components.intereses,
    cuotaInicial: 0, valorEquipoTotal: components.capital,
    contratoSnapshot: { origen: receipt, firma: { unchanged: "evidencia" },
      financiero: { montoCredito: components.total, cargosIncorporados: components.total - components.capital,
        valorCuota: components.cuota, plazo: components.numeroCuotas, valorSeguro: components.seguro,
        componentesMasivos: marker } } };
}
const cents = value => Math.round(value * 100);
const sumBalance = balance => Object.values(balance).reduce((sum, value) => sum + cents(value), 0);

test("conserva capital, cuota y plazo y separa fianza75%, seguro0.03% por cuota e interés residual", () => {
  const components = calculateMassCreditComponents(imported);
  assert.deepEqual(components, { version: "MASIVO_COMPONENTES_V1", ...imported,
    total: 5_728_800, fianza: 2_100_000, seguro: 40_320, intereses: 788_480 });
  assert.equal(components.capital + components.fianza + components.seguro + components.intereses, components.total);
});

test("redondea a centavos con aritmética entera y no introduce una nueva cuota", () => {
  assert.deepEqual(calculateMassCreditComponents({ ...imported, capital: 1234.56, cuota: 200, numeroCuotas: 12 }),
    { version: "MASIVO_COMPONENTES_V1", capital: 1234.56, cuota: 200, numeroCuotas: 12,
      fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03, total: 2400, fianza: 925.92, seguro: 4.44, intereses: 235.08 });
  const ties = calculateMassCreditComponents({ capital: 0.02, cuota: 0.1, numeroCuotas: 1,
    fianzaPorcentaje: 75, seguroCuotaPorcentaje: 25 });
  assert.equal(ties.fianza, 0.02);
  assert.equal(ties.seguro, 0.01);
  assert.equal(ties.intereses, 0.05);
});

test("rechaza cuotas insuficientes, precisión monetaria inválida y parámetros ajenos al rango", () => {
  assert.throws(() => calculateMassCreditComponents({ ...imported, cuota: 50_000 }), /negativos/);
  for (const patch of [{ capital: 0 }, { capital: 1.001 }, { cuota: -1 }, { cuota: NaN },
    { numeroCuotas: 0 }, { numeroCuotas: 1.5 }, { numeroCuotas: 601 },
    { fianzaPorcentaje: 101 }, { seguroCuotaPorcentaje: -0.03 }]) {
    assert.throws(() => calculateMassCreditComponents({ ...imported, ...patch }));
  }
});

test("lee sólo el marcador válido de raíz completa o de proyección financiera", () => {
  const credit = makeCredit();
  const expected = calculateMassCreditComponents(imported);
  assert.deepEqual(readMassCreditComponents(credit.contratoSnapshot, credit), expected);
  assert.deepEqual(readMassCreditComponents(credit.contratoSnapshot.financiero, credit), expected);
  assert.equal(getMassCreditInsurance(credit), 40_320);
  assert.equal(getMassCreditInsurance({ ...credit, contratoSnapshot: { financiero: { valorSeguro: 40_320 } } }), 0);
});

test("ignora marcadores inválidos, no reconciliados, obsoletos y reemplazados por plan de capital", () => {
  const credit = makeCredit();
  for (const markerPatch of [{ version: "OTRA" }, { capital: "2800000" }, { intereses: -1 },
    { fianza: 2_000_000, intereses: 888_480 }, { seguro: 40_321, intereses: 788_479 },
    { total: 5_728_801 }, { numeroCuotas: 47 }, { liquidacionAnticipada: false }]) {
    const snapshot = structuredClone(credit.contratoSnapshot);
    Object.assign(snapshot.financiero.componentesMasivos, markerPatch);
    assert.equal(readMassCreditComponents(snapshot, credit), null);
  }
  for (const patch of [{ montoCredito: credit.montoCredito + 1 }, { saldoBaseFinanciado: 2_799_999 },
    { valorCuota: 119_349 }, { plazoMeses: 47 }, { valorFianza: 1 }, { valorInteres: 1 },
    { planCapitalVigente: { version: "OTRA" } }]) {
    assert.equal(getMassCreditInsurance({ ...credit, ...patch }), 0);
  }
});

test("el saldo completo separa todos los componentes, sin añadir seguro al interés", () => {
  const credit = makeCredit();
  const balance = splitOutstandingBalance({ ...credit, saldoPendiente: credit.montoCredito });
  assert.deepEqual(balance, { saldoCapital: 2_800_000, saldoFianza: 2_100_000,
    saldoIntereses: 788_480, saldoSeguro: 40_320 });
  assert.equal(sumBalance(balance), cents(credit.montoCredito));
});

test("el reparto después de abonos conserva cada centavo incluso en saldos diminutos", () => {
  const credit = makeCredit();
  for (const pending of [credit.montoCredito / 2, credit.montoCredito - credit.valorCuota,
    789.33, 1, 0.02, 0.01, 0]) {
    const balance = splitOutstandingBalance({ ...credit, saldoPendiente: pending });
    assert.equal(sumBalance(balance), cents(pending));
    for (const value of Object.values(balance)) assert.ok(value >= 0);
    assert.ok(Object.hasOwn(balance, "saldoSeguro"));
  }
});

test("créditos sin marcador conservan el contrato de resultados anterior", () => {
  const credit = makeCredit();
  const balance = splitOutstandingBalance({ ...credit, contratoSnapshot: {}, saldoPendiente: 500_000,
    montoCredito: 1_000_000, saldoBaseFinanciado: 800_000, valorFianza: 100_000, valorInteres: 100_000 });
  assert.deepEqual(balance, { saldoCapital: 400_000, saldoFianza: 50_000, saldoIntereses: 50_000 });
});

test("la liquidación cambia sólo el desglose actual y conserva el recibo importado, auditoría y demás evidencia", () => {
  const credit = makeCredit();
  const before = structuredClone(credit.contratoSnapshot);
  const amounts = { montoCredito: 2_801_210, valorFianza: 1000, valorInteres: 200, valorSeguro: 10 };
  const closed = updateMassCreditComponentsForPayoff(credit.contratoSnapshot, amounts);
  assert.deepEqual(credit.contratoSnapshot, before);
  assert.deepEqual(closed.origen, before.origen);
  assert.deepEqual(closed.firma, before.firma);
  assert.deepEqual(closed.financiero.componentesMasivos.audit, before.financiero.componentesMasivos.audit);
  assert.equal(closed.financiero.valorCuota, before.financiero.valorCuota);
  assert.equal(closed.financiero.plazo, before.financiero.plazo);
  assert.equal(closed.financiero.valorSeguro, 10);
  assert.equal(closed.financiero.cargosIncorporados, 1210);
  const current = { ...credit, ...amounts, contratoSnapshot: closed };
  assert.equal(getMassCreditInsurance(current), 10);
  assert.equal(readMassCreditComponents(closed, current).liquidacionAnticipada, true);
  assert.equal(readMassCreditComponents(closed, current).total, 2_801_210);
  assert.deepEqual(splitOutstandingBalance({ ...current, saldoPendiente: 0 }),
    { saldoCapital: 0, saldoFianza: 0, saldoIntereses: 0, saldoSeguro: 0 });
});

test("rechaza cierres que aumentan deuda o no concilian, y no modifica créditos sin marcador", () => {
  const snapshot = makeCredit().contratoSnapshot;
  assert.throws(() => updateMassCreditComponentsForPayoff(snapshot,
    { montoCredito: 2_801_210, valorFianza: 1000, valorInteres: 200, valorSeguro: 11 }), /concilian/);
  assert.throws(() => updateMassCreditComponentsForPayoff(snapshot,
    { montoCredito: 5_728_801, valorFianza: 2_100_001, valorInteres: 788_480, valorSeguro: 40_320 }), /aumentar/);
  const legacy = { financiero: { montoCredito: 720_000 }, firma: "original" };
  assert.equal(updateMassCreditComponentsForPayoff(legacy,
    { montoCredito: 600_000, valorFianza: 0, valorInteres: 0, valorSeguro: 0 }), legacy);
});
