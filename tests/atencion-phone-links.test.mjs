import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { attentionPhoneTextParts } = await jiti.import("../lib/atencion-phone-links.ts");
const phones = text => {
  const parts = attentionPhoneTextParts(text);
  assert.equal(parts.map(part => part.text).join(""), text, "every character stays unchanged");
  return parts.filter(part => part.phone);
};

test("el celular del mensaje del usuario se reconoce sin modificar el texto", () => {
  const text = "Pregunta que cuánta cuotas le queda 3227403431";
  assert.deepEqual(phones(text), [{ text: "3227403431", phone: "+573227403431" }]);
});

test("formatos colombianos locales e internacionales conservan cada separador", () => {
  for (const text of ["3227403431", "322 740 3431", "322-740-3431", "322.740.3431", "(322) 740-3431", "573227403431", "57 (322) 740-3431", "+573227403431", "+57 (322) 740-3431", "00573227403431", "0057 (322) 740-3431", "+57\u00a0322\u202f740\u202f3431"]) {
    assert.deepEqual(phones(text), [{ text, phone: "+573227403431" }], text);
  }
});

test("otros países requieren + explícito y una longitud E164 acotada", () => {
  for (const [text, phone] of [["+1 (202) 555-0100", "+12025550100"], ["+34 612 345 678", "+34612345678"], ["+442071234567", "+442071234567"], ["+12345678", "+12345678"], ["+123456789012345", "+123456789012345"]]) assert.deepEqual(phones(text), [{ text, phone }]);
  for (const text of ["12025550100", "0034612345678", "+0123456789", "+1234567", "+1234567890123456", "++573227403431", "+57+3227403431"]) assert.deepEqual(phones(text), [], text);
});

test("cédulas, créditos, IMEI, referencias e importes no se convierten en teléfonos", () => {
  for (const label of ["CC", "C.C.", "cédula", "CEDULA", "documento", "NIT", "IMEI", "crédito", "credito", "solicitud", "referencia", "recibo", "folio", "ID", "FC", "COP", "$", "#"]) {
    assert.deepEqual(phones(`${label}: 3227403431`), [], label);
  }
  for (const text of ["Cédula del cliente: 3227403431", "C.C.:\n3227403431", "documento número 3227403431", "referencia familiar 3227403431", "3227403431 (cédula)", "3227403431 COP", "3227403431,00", "$ 3.227.403.431", "3.227.403.431", "IMEI 322740343112345", "FC-3227403431", "D-3227403431", "cliente_3227403431", "abc3227403431", "3227403431abc", "é3227403431", "3227403431ñ", "/3227403431", "3227403431/", "322740343112345", "3".repeat(1000)]) assert.deepEqual(phones(text), [], text.slice(0, 80));
});

test("URLs, consultas, rutas y esquemas se mantienen íntegros sin enlaces anidados", () => {
  for (const text of ["https://example.com/?phone=3227403431", "(https://example.com/3227403431)", "www.example.com?phone=3227403431", "example.com?phone=3227403431", "wa.me/573227403431", "tel:+573227403431", "mailto:3227403431@example.com", "https://example.com/?phone=+57-322-740-3431", "archivo/3227403431/report.pdf", "https://example.com/?phone=322 740 3431"]) assert.deepEqual(phones(text), [], text);
  const text = "https://example.com/3227403431 y escribe al 3227403431";
  assert.deepEqual(phones(text), [{ text: "3227403431", phone: "+573227403431" }]);
});

test("Unicode, nuevas líneas, comillas y varios contactos mantienen el round trip exacto", () => {
  const text = "👋 María dice: ‘3227403431’.\nO'Connor: +1 (202) 555-0100; también \"3112345678\".\nFin 🧾";
  assert.deepEqual(phones(text).map(part => part.phone), ["+573227403431", "+12025550100", "+573112345678"]);
  for (const text of ["", "Sin teléfono 👋\n", "300'1234567", "322\n740\n3431", "x".repeat(20001) + " 3227403431"]) assert.deepEqual(phones(text), []);
});

test("los límites impiden sufijos de runs largos aun con espacios o puntuación", () => {
  for (const text of ["3 ".repeat(500) + "3227403431", "3-".repeat(500) + "3227403431", "(3227403431", "3227403431)", "(322) 740-3431/archivo", "3227403431.xml", "abc.3227403431", "𝒜3227403431"]) assert.deepEqual(phones(text), [], text.slice(0, 80));
  assert.deepEqual(phones("Escribe al 3227403431 (WhatsApp)."), [{ text: "3227403431", phone: "+573227403431" }]);
});
