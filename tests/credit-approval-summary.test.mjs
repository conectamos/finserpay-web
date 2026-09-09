import assert from "node:assert/strict";
import test from "node:test";
import { service, approvalFixture, approvalDatabase, plain } from "./credit-approval-test-loader.mjs";
const detail = (fixture) => service.buildCreditApprovalDetail(fixture.credit, fixture.review, fixture.assessment, fixture.document);

test("el resumen muestra contacto y condiciones guardadas sin alterar el crédito", () => {
  const fixture = approvalFixture();
  fixture.credit.clienteCorreo = "  cliente@example.test  ";
  fixture.credit.clienteTelefono = "  +57 300 1234567  ";
  const before = plain(fixture);
  const item = detail(fixture);
  assert.equal(item.clienteNombre, fixture.credit.clienteNombre);
  assert.equal(item.clienteDocumento, fixture.credit.clienteDocumento);
  assert.equal(item.clienteCorreo, "cliente@example.test");
  assert.equal(item.clienteTelefono, "+57 300 1234567");
  assert.equal(item.score, 750);
  assert.equal(item.valorVenta, 1000000);
  assert.equal(item.cuotaInicial, 200000);
  assert.equal(item.creditoAutorizado, 800000);
  assert.equal(item.numeroCuotas, 12);
  assert.equal(item.frecuenciaPago, "QUINCENAL");
  assert.equal(item.valorCuota, 98765.43);
  assert.equal(item.fechaPrimerPago, "2026-10-01");
  assert.deepEqual(plain(fixture), before);
});

test("la cuota comercial de amortización prevalece sobre contrato y cuota exacta", () => {
  const fixture = approvalFixture();
  fixture.credit.cuotaComercialGuardada = "100100.00";
  fixture.credit.contratoSnapshot.financiero.cuotaComercial = 100000;
  assert.equal(detail(fixture).valorCuota, 100100);
  fixture.credit.cuotaComercialGuardada = null;
  assert.equal(detail(fixture).valorCuota, 100000);
  fixture.credit.contratoSnapshot.financiero.cuotaComercial = null;
  assert.equal(detail(fixture).valorCuota, 98765.43);
});

test("cuota ausente o inválida no se recalcula desde el capital ni se inventa cero", () => {
  for (const invalid of [null, undefined, "", "  ", "invalid", -1, 0, Infinity, NaN, false]) {
    const fixture = approvalFixture();
    fixture.credit.cuotaComercialGuardada = invalid;
    fixture.credit.contratoSnapshot.financiero.cuotaComercial = invalid;
    fixture.credit.valorCuota = invalid;
    assert.equal(detail(fixture).valorCuota, null);
  }
});

test("el plazo conserva número de cuotas y frecuencia sin convertirlo en meses", () => {
  for (const frequency of ["SEMANAL", "CATORCENAL", "QUINCENAL", "MENSUAL"]) {
    const fixture = approvalFixture();
    fixture.credit.frecuenciaPago = frequency;
    assert.equal(detail(fixture).numeroCuotas, 12);
    assert.equal(detail(fixture).frecuenciaPago, frequency);
  }
  const fixture = approvalFixture();
  fixture.credit.frecuenciaPago = " quincenal ";
  assert.equal(detail(fixture).frecuenciaPago, "QUINCENAL");
  for (const invalid of [null, undefined, "", "invalid", -1, 0, 1.5, Infinity, false]) {
    fixture.credit.plazoMeses = invalid;
    assert.equal(detail(fixture).numeroCuotas, null);
  }
  for (const invalid of [null, undefined, "", "OTRA", 1]) {
    fixture.credit.frecuenciaPago = invalid;
    assert.equal(detail(fixture).frecuenciaPago, null);
  }
});

test("primer pago conserva el día calendario UTC sin usar el próximo pago", () => {
  const fixture = approvalFixture();
  for (const [stored, expected] of [[new Date("2026-10-01T00:00:00Z"), "2026-10-01"], ["2026-10-01", "2026-10-01"], [new Date("2026-12-31T12:00:00Z"), "2026-12-31"]]) {
    fixture.credit.fechaPrimerPago = stored;
    fixture.credit.fechaProximoPago = new Date("2099-01-01T00:00:00Z");
    assert.equal(detail(fixture).fechaPrimerPago, expected);
  }
  for (const invalid of [null, undefined, "", "invalid", new Date("invalid")]) {
    fixture.credit.fechaPrimerPago = invalid;
    assert.equal(detail(fixture).fechaPrimerPago, null);
  }
});

test("contactos vacíos no se sustituyen por datos de otro cliente", () => {
  const fixture = approvalFixture();
  fixture.credit.contratoSnapshot.cliente = { correo: "otro@example.test", telefono: "999999999" };
  for (const invalid of [null, undefined, "", "  ", 123]) {
    fixture.credit.clienteCorreo = invalid;
    fixture.credit.clienteTelefono = invalid;
    assert.equal(detail(fixture).clienteCorreo, null);
    assert.equal(detail(fixture).clienteTelefono, null);
  }
});

test("exponer el resumen conserva aprobación y huella previamente guardadas", () => {
  const fixture = approvalFixture();
  const before = detail(fixture);
  fixture.review = { status: "APPROVED", revision: 3, approvedRevision: 3,
    approvedAt: new Date("2026-09-10T16:00:00Z"), approvedByName: "Analista existente", reviewHash: before.review.reviewHash };
  const item = detail(fixture);
  assert.equal(item.review.status, "APPROVED");
  assert.equal(item.review.revision, 3);
  assert.equal(item.review.approvedByName, "Analista existente");
  assert.equal(item.review.reviewHash, before.review.reviewHash);
});

test("la consulta del resumen es de lectura y conserva el bloqueo por crédito", async () => {
  const { db, state } = approvalDatabase();
  await service.getCreditApprovalDetail(db, state.credit.id);
  assert.equal(state.writes.length, 0);
  const query = state.queries.find(row => row.sql.includes('AS "cuotaComercialGuardada"'));
  assert.ok(query);
  assert.match(query.sql, /LEFT JOIN "CreditoAmortizacion" amortization ON amortization."creditoId" = credit."id"/);
  assert.equal(query.params[0], state.credit.id);
});
