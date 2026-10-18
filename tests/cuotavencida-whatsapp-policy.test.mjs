import assert from "node:assert/strict";
import test from "node:test";
import { credit, policy } from "./cuotavencida-whatsapp-fixture.mjs";
const today = new Date("2026-10-18T15:00:00Z");

test("selection is exact Cartera mora at least one Bogotá day with unpaid installments, not due-today or future", () => {
  for (const [date, expected] of [["2026-10-19", null], ["2026-10-18", null], ["2026-10-17", 1], ["2026-10-02", 16]]) {
    const selected = policy.getCuotaVencidaWhatsAppCandidate(credit(1, { fechaPrimerPago: date, fechaProximoPago: date }), today);
    assert.equal(selected?.daysPastDue ?? null, expected);
  }
  assert.equal(policy.getCuotaVencidaWhatsAppCandidate(credit(), "2026-10-18T04:59:59Z"), null);
  assert.equal(policy.getCuotaVencidaWhatsAppCandidate(credit(), "2026-10-18T05:00:00Z").daysPastDue, 1);
});

test("applied payments remove old mora, annulled payments do not, and zero balances or invalid financial dates never send", () => {
  for (const changes of [{ estado: "ANULADO" }, { estado: "PAGADO" }, { pazYSalvoEmitidoAt: today },
    { abonos: [{ valor: 300 }] }, { fechaPrimerPago: null, fechaProximoPago: null },
    { fechaPrimerPago: "2026-02-30", fechaProximoPago: null }, { planCapitalVigente: { invalid: true } }, { clienteTelefono: "123" }]) {
    assert.equal(policy.getCuotaVencidaWhatsAppCandidate(credit(1, changes), today), null);
  }
  assert.equal(policy.getCuotaVencidaWhatsAppCandidate(credit(1, { fechaProximoPago: "2026-11-02", abonos: [{ valor: 100, estado: "ACTIVO" }] }), today), null);
  assert.equal(policy.getCuotaVencidaWhatsAppCandidate(credit(1, { abonos: [{ valor: 99, estado: "ACTIVO" }] }), today).daysPastDue, 1);
  assert.ok(policy.getCuotaVencidaWhatsAppCandidate(credit(1, { abonos: [{ valor: 100, estado: "ANULADO" }] }), today));
});

test("one titular gets one message across credits and phones; document-less clients fall back to mobile", () => {
  const source = [credit(1), credit(2, { clienteDocumento: credit().clienteDocumento }),
    credit(3, { clienteDocumento: null }), credit(4, { clienteDocumento: null, clienteTelefono: credit(3).clienteTelefono })];
  const candidates = source.map(item => policy.getCuotaVencidaWhatsAppCandidate(item, today));
  const result = policy.groupCuotaVencidaWhatsAppCandidates(candidates);
  assert.equal(result.groups.length, 2); assert.equal(result.sharedPhoneCredits, 0);
  assert.deepEqual(result.groups.map(group => group.creditIds), [[1, 2], [3, 4]]);
  assert.equal(result.groups[0].representativeCreditId, 1);
  assert.equal(result.groups[1].phone, credit(3).clienteTelefono.replace(/^3/, "573"));
});

test("different known documents sharing a mobile are excluded; no-document duplicates cannot cause a second send", () => {
  const source = [credit(1), credit(2, { clienteTelefono: credit().clienteTelefono }), credit(3, { clienteDocumento: null })];
  const grouped = policy.groupCuotaVencidaWhatsAppCandidates(source.map(item => policy.getCuotaVencidaWhatsAppCandidate(item, today)));
  assert.equal(grouped.sharedPhoneCredits, 2); assert.deepEqual(grouped.groups.map(group => group.creditIds), [[3]]);
  const oneOwner = [credit(), credit(2, { clienteTelefono: credit().clienteTelefono, clienteDocumento: null })];
  assert.deepEqual(policy.groupCuotaVencidaWhatsAppCandidates(oneOwner.map(item => policy.getCuotaVencidaWhatsAppCandidate(item, today))).groups[0].creditIds, [1, 2]);
});
