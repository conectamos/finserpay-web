import assert from "node:assert/strict";
import test from "node:test";
import { service, loadSadminModule } from "./credit-sadmin-service-fixture.mjs";

const { calculateMassCreditComponents } = loadSadminModule("lib/mass-credit-financial-components.ts");
const example = calculateMassCreditComponents({ capital: 2_800_000, cuota: 119_350,
  numeroCuotas: 48, fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03 });
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = (changes = {}) => ({
  id: 776, folio: "QA-MASS-COMPONENTS", createdAt: new Date("2026-09-27T08:19:47Z"),
  fechaCredito: new Date("2026-09-02T17:00:00Z"), clienteNombre: "Cliente de prueba",
  clienteDocumento: "DOCUMENTO-SINTETICO", clienteTelefono: "3000000000", clienteDireccion: "Dirección prueba",
  clienteFechaNacimiento: new Date("1990-01-01T00:00:00Z"), clienteCorreo: "qa@example.invalid", clienteGenero: "F",
  imei: "000000000000000", referenciaEquipo: "Equipo prueba", equipoMarca: "IPHONE", equipoModelo: "",
  plazoMeses: 48, frecuenciaPago: "CATORCENAL", valorEquipoTotal: 2_800_000, cuotaInicial: 0,
  saldoBaseFinanciado: 2_800_000, valorCuota: 119_350, montoCredito: 5_728_800,
  valorFianza: 2_100_000, valorInteres: 788_480, tasaInteresEa: 0, fianzaPorcentaje: 75,
  contratoSnapshot: { financiero: { componentesMasivos: example,
    fianzaPorcentaje: 75, fianzaTotalPorcentaje: 75, seguroCuotaPorcentaje: 0.03 } },
  amortizacion: null, aliadoNombre: "Aliado QA", sedeNombre: "Sede QA",
  fechaPrimerPago: new Date("2026-09-17T17:00:00Z"), fechaProximoPago: new Date("2026-09-17T17:00:00Z"),
  pazYSalvoEmitidoAt: null, abonos: [], registration: null, ...changes,
});

test("SADMIN presenta el desglose exacto con seguro sin cambiar cuota, capital, obligación ni calendario", () => {
  const input = fixture();
  const before = plain(input);
  const row = service.buildSadminCreditRow(input, new Date("2026-09-01T12:00:00Z"));
  assert.equal(row.saldoObligacion, 5_728_800);
  assert.equal(row.saldoCapital, 2_800_000);
  assert.equal(row.saldoFianza, 2_100_000);
  assert.equal(row.saldoIntereses, 788_480);
  assert.equal(row.saldoSeguro, 40_320);
  assert.equal(row.valorCuota, 119_350);
  assert.equal(row.numeroCuotas, 48);
  assert.equal(row.fechaProximoPago, "2026-09-17");
  assert.equal(row.fianza, 0.75);
  assert.equal(row.seguro, 0.0003);
  assert.equal(row.sadmin.estado, "PENDIENTE");
  assert.deepEqual(plain(input), before);
});

test("SADMIN conserva los tres componentes de créditos sin marcador o con marcador desactualizado", () => {
  for (const input of [fixture({ contratoSnapshot: null, valorFianza: 0, valorInteres: 2_928_800 }),
    fixture({ valorFianza: 0, valorInteres: 2_928_800 })]) {
    const row = service.buildSadminCreditRow(input, new Date("2026-09-01T12:00:00Z"));
    assert.equal(row.saldoObligacion, 5_728_800);
    assert.equal(row.saldoCapital, 2_800_000);
    assert.equal(row.saldoFianza, 0);
    assert.equal(row.saldoIntereses, 2_928_800);
    assert.equal(row.saldoSeguro, undefined);
  }
});

test("SADMIN descuenta los abonos de todos los componentes conservando el saldo total exacto", () => {
  const input = fixture({ abonos: [{ valor: 119_350, fechaAbono: "2026-09-17T17:00:00Z", metodoPago: "EFECTIVO" }] });
  const row = service.buildSadminCreditRow(input, new Date("2026-09-18T12:00:00Z"));
  assert.equal(row.saldoObligacion, 5_609_450);
  assert.equal(row.saldoSeguro, 39_480);
  assert.equal(row.cuotasPagadas, 1);
  assert.equal(row.cuotasPendientes, 47);
  assert.equal(Math.round((row.saldoCapital + row.saldoFianza + row.saldoIntereses + row.saldoSeguro) * 100),
    Math.round(row.saldoObligacion * 100));
});
