import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRiskReference, aggregateProductRisk, emptyProductRiskFilters, filterRiskCredits, riskCreditEligible, riskTone } from "../lib/product-risk.ts";

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
test("cuenta cartera registrada sin depender de firmas, fotos ni estado de entrega", () => {
  for (const estado of ["GENERADO", "ENTREGABLE", "ENTREGADO", "DESEMBOLSADO", "PAGADO", "PENDIENTE"]) {
    assert.equal(riskCreditEligible({ estado, montoCredito: 1000 }), true);
  }
  for (const estado of ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"]) {
    assert.equal(riskCreditEligible({ estado, montoCredito: 1000 }), false);
  }
  assert.equal(riskCreditEligible({ estado: "GENERADO", montoCredito: 0 }), false);
});
test("combina los ocho filtros con extremos inclusivos", () => {
  const filters = { ...emptyProductRiskFilters, desde: "2026-10-01", hasta: "2026-10-01", marca: "Apple", referencia: "iPhone 13", tipo: "IPHONE", aliado: "Aliado A", sede: "Sede A", estado: "mora", minDias: "10", maxDias: "20" };
  const rows = [credit(1, { dias: 10 }), credit(2, { dias: 20 }), credit(3, { dias: 21 }), credit(4, { dias: 10, sede: "Sede B" }), credit(5, { dias: 10, fecha: "2026-10-02" }), credit(6, { dias: 0 })];
  assert.deepEqual(filterRiskCredits(rows, filters).map(c => c.id), [1, 2]);
});
test("agrupa por modelo y plataforma y conserva el detalle completo", () => {
  const rows = aggregateProductRisk([credit(1), credit(2, { marca: "APPLE", referencia: "IPHONE 13", fecha: "2026-10-03" }), credit(3, { marca: "Samsung", tipo: "ANDROID" })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ultima, "2026-10-03");
  assert.equal(rows[0].credits.length, 2);
  assert.deepEqual(aggregateProductRisk([]), []);
});

test("unifica capacidades por modelo conservando Pro y Pro Max", () => {
  const rows = aggregateProductRisk([
    credit(1, { referencia: "IPHONE 13", marca: "Sin marca", dias: 20 }),
    credit(2, { referencia: "iPhone 13 128GB", marca: "Apple", saldo: 0 }),
    credit(3, { referencia: "IPHONE 13 256GB" }),
    credit(4, { referencia: "IPHONE 13 PRO 128GB" }),
    credit(5, { referencia: "IPHONE 13 PRO MAX 128GB" }),
  ]);
  assert.equal(rows.length, 3);
  const unified = rows.find(row => row.referencia === "IPHONE 13");
  assert.equal(unified.financiadas, 3);
  assert.equal(unified.mora, 1);
  assert.ok(Math.abs(unified.porcentaje - 100 / 3) < 1e-10);
  assert.deepEqual(unified.credits.map(row => row.id), [1, 2, 3]);
  assert.equal(filterRiskCredits(unified.credits, { ...emptyProductRiskFilters, referencia: "IPHONE 13" }).length, 3);
});
test("el mismo modelo suma 6 y 9 créditos aunque cambien marca, espacios o formato GB", () => {
  const credits = Array.from({ length: 15 }, (_, i) => credit(i + 1, {
    marca: i < 6 ? "APPLE" : "Sin marca",
    referencia: i < 6 ? "IPHONE 13 PRO MAX 256GB" : " iphone  13 pro max 256 GB ",
    dias: i < 3 ? 10 : 0,
  }));
  const rows = aggregateProductRisk(credits);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].referencia, "IPHONE 13 PRO MAX");
  assert.equal(rows[0].financiadas, 15);
  assert.equal(rows[0].mora, 3);
  assert.equal(rows[0].porcentaje, 20);
  assert.equal(new Set(rows[0].credits.map(row => row.id)).size, 15);
  assert.equal(filterRiskCredits(credits, { ...emptyProductRiskFilters, marca: "APPLE" }).length, 6);
});

test("agrupa todas las generaciones y variantes iPhone sin capacidad ni color", () => {
  for (const generation of [11, 12, 13, 14, 15, 16, 17]) {
    for (const variant of ["", " PRO", " PRO MAX", " PLUS", " MINI"]) {
      const name = `IPHONE ${generation}${variant}`;
      for (const storage of ["", " 64GB", " 128 GB", " 256GB AZUL", " 512GB", " 1TB NEGRO"]) {
        assert.equal(normalizeRiskReference(name + storage), name);
      }
    }
  }
  assert.equal(normalizeRiskReference("ipohn 15 pro max 256gb"), "IPHONE 15 PRO MAX");
  assert.equal(normalizeRiskReference("iPhone XS Max 256GB"), "IPHONE XS MAX");
  assert.equal(normalizeRiskReference("iPhone SE 128GB"), "IPHONE SE");
  assert.equal(normalizeRiskReference("IPHONE 16E 128GB"), "IPHONE 16E");
  assert.equal(normalizeRiskReference("Samsung A15 128GB"), "SAMSUNG A15 128GB");
});
