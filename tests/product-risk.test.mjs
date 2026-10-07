import assert from "node:assert/strict";
import test from "node:test";
import { aggregateProductRisk, emptyProductRiskFilters, filterRiskCredits, riskCreditEligible, riskTone } from "../lib/product-risk.ts";

const credit = (id, changes = {}) => ({ id, folio: String(id), cliente: "Cliente", marca: "Apple", referencia: "iPhone 13", tipo: "IPHONE", aliado: "Aliado A", sede: "Sede A", fecha: "2026-10-01", capital: 1000, saldo: 500, vencido: 0, dias: 0, gestion: null, ...changes });
test("mora usa todas las unidades financiadas, incluyendo pagadas, y cuenta créditos, no cuotas", () => {
  const rows = aggregateProductRisk([credit(1, { dias: 20, vencido: 200 }), credit(2, { saldo: 0 }), credit(3, { dias: 10, vencido: 100 }), credit(4)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].financiadas, 4);
  assert.equal(rows[0].activas, 3);
  assert.equal(rows[0].mora, 2);
  assert.equal(rows[0].porcentaje, 50);
  assert.equal(rows[0].capital, 4000);
  assert.equal(rows[0].saldo, 1500);
  assert.equal(rows[0].vencido, 300);
  assert.equal(rows[0].dias, 15);
});
test("umbrales se clasifican sin redondear antes de comparar", () => {
  assert.equal(riskTone(4.999), "positive");
  assert.equal(riskTone(5), "warning");
  assert.equal(riskTone(7.999), "warning");
  assert.equal(riskTone(8), "danger");
});
test("no incluye anulados ni equipos solamente listos para entregar", () => {
  const base = { estado: "ENTREGABLE", montoCredito: 1000, contratoAceptadoAt: "date", pagareAceptadoAt: "date", fotoEntregaDataUrl: null, fotoRemisionDataUrl: null, pazYSalvoEmitidoAt: null };
  assert.equal(riskCreditEligible(base), false);
  assert.equal(riskCreditEligible({ ...base, fotoEntregaDataUrl: true }), true);
  for (const estado of ["ANULADO", "NO_DESEMBOLSADO", "PENDIENTE", "CANCELADO"]) assert.equal(riskCreditEligible({ ...base, estado, fotoEntregaDataUrl: true, pazYSalvoEmitidoAt: "date" }), false);
  assert.equal(riskCreditEligible({ ...base, estado: "DESEMBOLSADO" }), true);
  assert.equal(riskCreditEligible({ ...base, montoCredito: 0, fotoEntregaDataUrl: true }), false);
});
test("combina los ocho filtros con extremos inclusivos", () => {
  const filters = { ...emptyProductRiskFilters, desde: "2026-10-01", hasta: "2026-10-01", marca: "Apple", referencia: "iPhone 13", tipo: "IPHONE", aliado: "Aliado A", sede: "Sede A", estado: "mora", minDias: "10", maxDias: "20" };
  const rows = [credit(1, { dias: 10 }), credit(2, { dias: 20 }), credit(3, { dias: 21 }), credit(4, { dias: 10, sede: "Sede B" }), credit(5, { dias: 10, fecha: "2026-10-02" }), credit(6, { dias: 0 })];
  assert.deepEqual(filterRiskCredits(rows, filters).map(c => c.id), [1, 2]);
});
test("incluye cartera histórica identificada y conserva exclusiones antes de la evidencia", () => {
  const historical = { estado: "GENERADO", montoCredito: 1000, contratoAceptadoAt: null, pagareAceptadoAt: null, fotoEntregaDataUrl: null, fotoRemisionDataUrl: null, pazYSalvoEmitidoAt: null, equalityService: "IMPORTACION_MASIVA", importOriginType: "IMPORTACION_MASIVA" };
  assert.equal(riskCreditEligible(historical), true);
  assert.equal(riskCreditEligible({ ...historical, importOriginType: null }), false);
  assert.equal(riskCreditEligible({ ...historical, equalityService: null }), false);
  for (const estado of ["ANULADO", "NO_DESEMBOLSADO", "PENDIENTE"]) assert.equal(riskCreditEligible({ ...historical, estado }), false);
});
test("agrupa por modelo y plataforma y conserva el detalle completo", () => {
  const rows = aggregateProductRisk([credit(1), credit(2, { marca: "APPLE", referencia: "IPHONE 13", fecha: "2026-10-03" }), credit(3, { marca: "Samsung", tipo: "ANDROID" })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ultima, "2026-10-03");
  assert.equal(rows[0].credits.length, 2);
  assert.deepEqual(aggregateProductRisk([]), []);
});

test("unifica IPHONE 13 exacto con 128GB sin cambiar Pro, Pro Max ni otras capacidades", () => {
  const rows = aggregateProductRisk([
    credit(1, { referencia: "IPHONE 13", marca: "Sin marca", dias: 20 }),
    credit(2, { referencia: "iPhone 13 128GB", marca: "Apple", saldo: 0 }),
    credit(3, { referencia: "IPHONE 13 256GB" }),
    credit(4, { referencia: "IPHONE 13 PRO 128GB" }),
    credit(5, { referencia: "IPHONE 13 PRO MAX 128GB" }),
  ]);
  assert.equal(rows.length, 4);
  const unified = rows.find(row => row.referencia === "IPHONE 13 128GB");
  assert.equal(unified.financiadas, 2);
  assert.equal(unified.mora, 1);
  assert.equal(unified.porcentaje, 50);
  assert.deepEqual(unified.credits.map(row => row.id), [1, 2]);
  assert.equal(filterRiskCredits(unified.credits, { ...emptyProductRiskFilters, referencia: "IPHONE 13 128GB" }).length, 2);
});
test("el mismo modelo suma 6 y 9 créditos aunque cambien marca, espacios o formato GB", () => {
  const credits = Array.from({ length: 15 }, (_, i) => credit(i + 1, {
    marca: i < 6 ? "APPLE" : "Sin marca",
    referencia: i < 6 ? "IPHONE 13 PRO MAX 256GB" : " iphone  13 pro max 256 GB ",
    dias: i < 3 ? 10 : 0,
  }));
  const rows = aggregateProductRisk(credits);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].referencia, "IPHONE 13 PRO MAX 256GB");
  assert.equal(rows[0].financiadas, 15);
  assert.equal(rows[0].mora, 3);
  assert.equal(rows[0].porcentaje, 20);
  assert.equal(new Set(rows[0].credits.map(row => row.id)).size, 15);
  assert.equal(filterRiskCredits(credits, { ...emptyProductRiskFilters, marca: "APPLE" }).length, 6);
});
