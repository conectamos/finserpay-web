import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const jiti = createJiti(import.meta.url);
const { attentionDocumentKey, attentionPhoneOrNull, attentionPhoneSql, resolveAttentionCreditIdentity } = await jiti.import("../lib/atencion-classification.ts");
const conversation = { phone: "+573001234567", linkedCreditId: null };
const credit = (id, changes = {}) => ({ id, clienteTelefono: "3001234567", clienteDocumento: "12345678", clienteTipoDocumento: "CC", estado: "ACTIVO", ...changes });

test("créditos vigentes y pagados comparten FINSERPAY sin seleccionar una operación financiera", () => {
  const resolved = resolveAttentionCreditIdentity(conversation, [credit(2, { estado: "PAGADO" }), credit(1)]);
  assert.deepEqual(resolved, { classification: { status: "finserpay", source: "exact_phone", creditCount: 2 }, autoTags: ["FINSERPAY"], creditIds: [1, 2] });
});

test("teléfono compartido, documentos ausentes y tipos distintos requieren revisión", () => {
  for (const rows of [
    [credit(1), credit(2, { clienteDocumento: "9999" })],
    [credit(1, { clienteDocumento: null }), credit(2, { clienteDocumento: null })],
    [credit(1), credit(2, { clienteTipoDocumento: "PASAPORTE" })],
    [credit(1), credit(2, { clienteTipoDocumento: null })],
  ]) {
    const resolved = resolveAttentionCreditIdentity(conversation, rows);
    assert.equal(resolved.classification.status, "ambiguous");
    assert.deepEqual(resolved.autoTags, []);
    assert.deepEqual(resolved.creditIds, []);
  }
});

test("vínculo manual conserva solo la identidad exacta y deja de servir si cambia el teléfono", () => {
  const linked = { ...conversation, linkedCreditId: 1 };
  const rows = [credit(1), credit(2), credit(3, { clienteDocumento: "9999" })];
  assert.deepEqual(resolveAttentionCreditIdentity(linked, rows).creditIds, [1, 2]);
  assert.equal(resolveAttentionCreditIdentity(linked, rows).classification.source, "manual_link");
  rows[0].clienteTelefono = "+13001234567";
  const stale = resolveAttentionCreditIdentity(linked, rows);
  assert.equal(stale.classification.status, "unverified");
  assert.deepEqual(stale.creditIds, []);
});

test("documentos alfanuméricos no se reducen a sus dígitos; formatos conocidos se normalizan", () => {
  assert.notEqual(attentionDocumentKey(credit(1, { clienteDocumento: "AB123" })), attentionDocumentKey(credit(2, { clienteDocumento: "123" })));
  assert.equal(attentionDocumentKey(credit(1, { clienteDocumento: "12.345-678", clienteTipoDocumento: "C.C." })), attentionDocumentKey(credit(2)));
  assert.equal(attentionDocumentKey(credit(1, { clienteDocumento: "12/34" })), null);
});

test("sin teléfono verificable o sin crédito registrado no se inventa una etiqueta", () => {
  assert.equal(resolveAttentionCreditIdentity({ ...conversation, phone: null }, [credit(1)]).classification.status, "unverified");
  for (const rows of [[], [credit(1, { estado: "ANULADO" })], [credit(1, { estado: "BORRADOR" })], [credit(1, { estado: "PENDIENTE" })], [credit(1, { estado: "RECHAZADO" })], [credit(1, { estado: "SOLICITADO" })], [credit(1, { clienteTelefono: "+13001234567" })], [credit(1, { clienteTelefono: "abc3001234567" })]]) {
    const resolved = resolveAttentionCreditIdentity(conversation, rows);
    assert.deepEqual(resolved.autoTags, []);
    assert.deepEqual(resolved.creditIds, []);
    assert.equal(resolved.classification.status, "no_credit");
  }
});

test("estados financieros conocidos incluyen históricos; estados desconocidos quedan sin verificar", () => {
  for (const estado of ["GENERADO", "INSCRITO", "ENTREGABLE", "ENTREGADO", "FINALIZADO", "ACTIVO", "AL_DIA", "MORA", "MORA_BLOQUEADO", "ROBO_BLOQUEADO", "PAGADO", "PAZ_Y_SALVO", "APROBADO"]) {
    assert.deepEqual(resolveAttentionCreditIdentity(conversation, [credit(1, { estado })]).autoTags, ["FINSERPAY"], estado);
  }
  for (const estado of ["", "NUEVO_ESTADO", "REJECTED", "APROBADOO"]) {
    const resolved = resolveAttentionCreditIdentity(conversation, [credit(1, { estado })]);
    assert.equal(resolved.classification.status, "unverified");
    assert.deepEqual(resolved.creditIds, []);
  }
});

test("normalización SQL y parser coinciden sin aceptar letras ni signos + internos", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  for (const value of ["3001234567", "+57 (300) 123-4567", "\t+57 (300) 123-4567\n", "00573001234567", "003001234567", "+13001234567", "abc3001234567", "++573001234567", "57+3001234567", "300", "", null]) {
    const result = await db.query(`SELECT ${attentionPhoneSql("c")} AS phone FROM (SELECT $1::text AS "clienteTelefono") c`, [value]);
    assert.equal(result.rows[0].phone, attentionPhoneOrNull(value), String(value));
  }
});
