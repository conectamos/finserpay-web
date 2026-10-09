import assert from "node:assert/strict";
import test from "node:test";
import {
  allyPaymentColombiaDate,
  emptyAllyPaymentViewFilters,
  filterPendingAllyAnnulmentAdjustments,
  filterPendingAllyCollections,
  filterPendingAllyCredits,
  filterReceivedAllyPayments,
} from "../lib/ally-payment-view-filters.ts";
import { calculateAllyPaymentAmounts, summarizeAllyPayments } from "../lib/ally-payments-core.ts";

const filters = updates => ({ ...emptyAllyPaymentViewFilters(), ...updates });
const ids = rows => rows.map(row => row.id);

test("recibidos busca nombre de aliado, código y aprobación como texto, sin depender de la página visible", () => {
  const rows = [
    { id: 1, aliado: { id: 7, nombre: "Conectámos Centro", codigo: "CC-07" }, numeroAprobacionBancaria: "000000000000000000123" },
    { id: 2, aliadoId: 8, aliadoNombre: "Mónky Technology", numeroAprobacionBancaria: "000000000000000000124" },
    { id: 3, aliado: { id: 9, nombre: "Otro aliado" }, numeroAprobacionBancaria: "ABC-0001" },
  ];
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ search: "conectamos centro" }))), [1]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ search: "MONKY" }))), [2]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ search: "cc07" }))), [1]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ search: "000000000000000000123" }))), [1]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ search: "ABC0001" }))), [3]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ allyId: "8", search: "monky" }))), [2]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ allyId: "7", search: "monky" }))), []);
});

test("recibidos filtra por solapamiento del período guardado, con extremos inclusivos y fechas independientes del registro", () => {
  const rows = [
    { id: 1, periodoInicio: "2026-09-01", periodoFin: "2026-09-30", pagadoAt: "2026-10-10T12:00:00Z" },
    { id: 2, periodoInicio: "2026-10-01", periodoFin: "2026-10-07", pagadoAt: "2026-10-08T12:00:00Z" },
    { id: 3, periodoInicio: "2026-10-07", periodoFin: "2026-10-20" },
    { id: 4, periodoInicio: "2026-10-08", periodoFin: "2026-10-20" },
    { id: 5, periodoInicio: "2026-10-03", periodoFin: null },
    { id: 6, periodoInicio: null, periodoFin: null },
  ];
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ start: "2026-10-01", end: "2026-10-07" }))), [2, 3, 5]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ start: "2026-10-07", end: "2026-10-07" }))), [2, 3]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ start: "2026-09-30", end: "2026-10-01" }))), [1, 2]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ start: "2026-10-20" }))), [3, 4]);
  assert.deepEqual(ids(filterReceivedAllyPayments(rows, filters({ end: "2026-09-30" }))), [1]);
  assert.equal(filterReceivedAllyPayments(rows, filters()).length, 6);
});

test("fechas puras permanecen en el calendario y timestamps se convierten a Bogotá, incluidos ambos lados de medianoche", () => {
  assert.equal(allyPaymentColombiaDate("2026-10-07"), "2026-10-07");
  assert.equal(allyPaymentColombiaDate("2026-10-07T04:59:59.999Z"), "2026-10-06");
  assert.equal(allyPaymentColombiaDate("2026-10-07T05:00:00.000Z"), "2026-10-07");
  assert.equal(allyPaymentColombiaDate("2026-10-07T23:59:59-05:00"), "2026-10-07");
  assert.equal(allyPaymentColombiaDate("2026-10-08T00:00:00-05:00"), "2026-10-08");
  assert.equal(allyPaymentColombiaDate("invalid"), "");
  assert.equal(allyPaymentColombiaDate(null), "");
});

test("pendientes conserva búsquedas exactas por cédula e IMEI largos y sus ceros iniciales", () => {
  const rows = [
    Object.freeze({ id: 1, clienteNombre: "Andrés Felipe", clienteDocumento: "00100000000000000123", imei: "000000000000000000123", plataforma: "IPHONE" }),
    Object.freeze({ id: 2, cliente: "Carolina QA", clienteDocumento: "00100000000000000124", imei: "000000000000000000124", plataforma: "ANDROID" }),
  ];
  assert.deepEqual(ids(filterPendingAllyCredits(rows, filters({ search: "00100000000000000123" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyCredits(rows, filters({ search: "000000000000000000124" }))), [2]);
  assert.deepEqual(ids(filterPendingAllyCredits(rows, filters({ search: "001.000.000.000.000.00123" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyCredits(rows, filters({ search: "ANDRES FELIPE" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyCredits(rows, filters({ search: "carolina" }))), [2]);
  assert.equal(rows[0].clienteDocumento, "00100000000000000123");
  assert.equal(rows[1].imei, "000000000000000000124");
});

test("pendientes prioriza fechaLiquidacion sobre fechaCredito y admite los fallbacks sin alterar los registros", () => {
  const rows = [
    Object.freeze({ id: 189, fechaLiquidacion: "2026-09-01", fechaCredito: "2026-08-31" }),
    Object.freeze({ id: 2, fechaCredito: "2026-09-01T04:59:59Z" }),
    Object.freeze({ id: 3, fechaCredito: "2026-09-01T05:00:00Z" }),
    Object.freeze({ id: 4, fecha: "2026-09-01" }),
    Object.freeze({ id: 5, fechaLiquidacion: "2026-09-02", fechaCredito: "2026-09-01" }),
    Object.freeze({ id: 6 }),
  ];
  assert.deepEqual(ids(filterPendingAllyCredits(rows, filters({ start: "2026-09-01", end: "2026-09-01" }))), [189, 3, 4]);
  assert.deepEqual(ids(filterPendingAllyCredits(rows, filters({ start: "2026-08-31", end: "2026-08-31" }))), [2]);
  assert.deepEqual(ids(filterPendingAllyCredits(rows, filters({ start: "2026-09-02" }))), [5]);
  assert.equal(rows[0].fechaCredito, "2026-08-31");
  assert.equal(filterPendingAllyCredits(rows, filters()).length, 6);
});

test("recaudos se filtra con metadata propia aunque el crédito ya haya sido liquidado; fechaAbono usa Bogotá", () => {
  const rows = [
    { id: 1, creditoId: 987, aliado: { id: 7, nombre: "Aliado QA" }, plataforma: "IPHONE", imei: "000012345678901", clienteDocumento: "00997654321", clienteNombre: "Léonel QA", fechaAbono: "2026-10-07T04:59:59Z", valor: 123.45 },
    { id: 2, creditoId: 988, aliado: { id: 8, nombre: "Otro aliado QA" }, plataforma: "ANDROID", imei: "000012345678902", clienteDocumento: "00123456788", fechaAbono: "2026-10-07T05:00:00Z", valor: 100.01 },
    { id: 3, creditoId: 989, aliado: { id: 7, nombre: "Aliado QA" }, plataforma: "android", imei: "000012345678903", fechaAbono: "2026-10-07T06:00:00Z", valor: 200.02 },
    { id: 4, fechaAbono: "2026-10-07T06:00:00Z", valor: 300 },
  ];
  assert.deepEqual(ids(filterPendingAllyCollections(rows, filters({ allyId: "7", platform: "IPHONE", start: "2026-10-06", end: "2026-10-06" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyCollections(rows, filters({ allyId: "7", platform: "ANDROID", start: "2026-10-07", end: "2026-10-07" }))), [3]);
  assert.deepEqual(ids(filterPendingAllyCollections(rows, filters({ search: "000012345678901" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyCollections(rows, filters({ search: "00997654321" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyCollections(rows, filters({ search: "leonel" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyCollections(rows, filters({ platform: "ANDROID" }))), [2, 3]);
  assert.equal(filterPendingAllyCollections(rows, filters()).length, 4);
});

test("ajustes por anulacion se filtran por aliado, fecha, plataforma e identificadores", () => {
  const rows = [
    {
      id: 1, aliadoId: 7, aliado: { id: 7, nombre: "Aliado QA" },
      fechaAnulacion: "2026-10-09T04:59:59Z", plataforma: "IPHONE",
      numeroCreditoVisible: "QA-ANULADO-001", folio: "FOLIO-INTERNO-1",
      clienteNombre: "Crédito Anulado", clienteDocumento: "001234567890",
      imei: "000012345678901", motivo: "Solicitud aprobada", liquidacionOrigenId: 41,
    },
    {
      id: 2, aliadoId: 8, aliado: { id: 8, nombre: "Otro aliado" },
      fechaAnulacion: "2026-10-09T05:00:00Z", plataforma: "ANDROID",
      numeroCreditoVisible: "36555941", clienteDocumento: "001234567891",
      imei: "000098765432102", liquidacionOrigenId: 42,
    },
  ];

  assert.deepEqual(ids(filterPendingAllyAnnulmentAdjustments(rows, filters({
    allyId: "7", platform: "IPHONE", start: "2026-10-08", end: "2026-10-08",
  }))), [1]);
  assert.deepEqual(ids(filterPendingAllyAnnulmentAdjustments(rows, filters({ search: "QA-ANULADO-001" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyAnnulmentAdjustments(rows, filters({ search: "001.234.567.890" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyAnnulmentAdjustments(rows, filters({ search: "000098765432102" }))), [2]);
  assert.deepEqual(ids(filterPendingAllyAnnulmentAdjustments(rows, filters({ search: "LA-41" }))), [1]);
  assert.deepEqual(ids(filterPendingAllyAnnulmentAdjustments(rows, filters({ platform: "ANDROID" }))), [2]);
});

test("todos los resultados filtrados conservan cantidades y montos antes de la paginación, incluido cada tipo de equipo", () => {
  const rows = Array.from({ length: 305 }, (_, index) => ({
    id: index + 1, aliado: { id: index % 5 === 0 ? 8 : 7 },
    clienteNombre: "Cliente QA", clienteDocumento: "00" + String(index), imei: "000" + String(index),
    fechaLiquidacion: index % 3 === 0 ? "2026-10-08" : "2026-10-07",
    plataforma: index % 2 === 0 ? "IPHONE" : "ANDROID",
    ...calculateAllyPaymentAmounts({ valorVenta: 1000.25 + index, cuotaInicial: 200.1, porcentajeIntermediacion: 10 }),
  }));
  const result = filterPendingAllyCredits(rows, filters({ allyId: "7", start: "2026-10-07", end: "2026-10-07" }));
  const expected = rows.filter(row => row.aliado.id === 7 && row.fechaLiquidacion === "2026-10-07");
  const summary = summarizeAllyPayments(result);
  assert.deepEqual(ids(result), ids(expected));
  assert.ok(result.length > 100);
  assert.equal(summary.total.numeroCreditos, expected.length);
  assert.equal(summary.IPHONE.numeroCreditos, expected.filter(row => row.plataforma === "IPHONE").length);
  assert.equal(summary.ANDROID.numeroCreditos, expected.filter(row => row.plataforma === "ANDROID").length);
  const visiblePage = result.slice(0, 10);
  assert.ok(summary.total.valorPagar > summarizeAllyPayments(visiblePage).total.valorPagar);
  assert.deepEqual(summarizeAllyPayments(filterPendingAllyCredits(rows, filters({ allyId: "7", start: "2026-10-07", end: "2026-10-07", platform: "IPHONE" }))).total,
    { ...summary.IPHONE, plataforma: "TOTAL" });
  assert.deepEqual(summarizeAllyPayments(filterPendingAllyCredits(rows, filters({ allyId: "7", start: "2026-10-07", end: "2026-10-07", platform: "ANDROID" }))).total,
    { ...summary.ANDROID, plataforma: "TOTAL" });
});

test("filtros vacíos son nuevos por llamada y permiten limpiar todas las condiciones", () => {
  const first = emptyAllyPaymentViewFilters();
  first.search = "QA";
  first.allyId = "7";
  assert.deepEqual(emptyAllyPaymentViewFilters(), { search: "", allyId: "", start: "", end: "", platform: "ALL" });
});
