import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseDianaExtensionRequest: parse, resolveDianaExtensionRequest: resolve } = await jiti.import("../lib/diana-extension-request-intent.ts");
const at = "2026-11-03T04:30:00.000Z"; // Still November 2 in Bogota.
const msg = (id, text, offset = 0, kind = "lead") => ({ id, text, sentAt: new Date(Date.parse(at) + offset * 1000).toISOString(), kind, direction: kind === "lead" ? "inbound" : "outbound" });

test("direct personal requests recognize exact days, native folio and polite greetings", () => {
  for (const [word, days] of [["1", 1], ["dos", 2], ["tres", 3], ["cuatro", 4]]) {
    assert.deepEqual(parse(`Hola Diana, por favor necesito una prórroga de ${word} días`, at), { kind: "days", days });
  }
  assert.deepEqual(parse("No tengo dinero, necesito prórroga de 2 días para el crédito FC-123", at), { kind: "days", days: 2, folio: "FC-123" });
  assert.deepEqual(parse("¿Me puedes conceder prórroga de una día?", at), { kind: "days", days: 1 });
  assert.deepEqual(parse("Prórroga de 4 días después del vencimiento", at), { kind: "days", days: 4 });
  assert.deepEqual(parse("Quisiera una prórroga de 3 días", at), { kind: "days", days: 3 });
  assert.deepEqual(parse("Sí, necesito una prórroga de 2 días", at), { kind: "days", days: 2 });
  assert.deepEqual(parse("Prórroga de 2 días por favor", at), { kind: "days", days: 2 });
  assert.deepEqual(parse("Prórroga hasta mañana", at), { kind: "date", date: "2026-11-03" });
  assert.deepEqual(parse("Necesito 2 días de prórroga", at), { kind: "days", days: 2 });
  assert.deepEqual(parse("Por favor solicito tres días de plazo", at), { kind: "days", days: 3 });
  assert.deepEqual(parse("Prórroga para mañana", at), { kind: "date", date: "2026-11-03" });
});

test("calendar requests derive from the native message Bogota date and preserve conflicting hints for core validation", () => {
  assert.deepEqual(parse("Necesito una prórroga hasta mañana", at), { kind: "date", date: "2026-11-03" });
  assert.deepEqual(parse("Necesito una prórroga de 2 días desde hoy", at), { kind: "date", date: "2026-11-04" });
  assert.deepEqual(parse("Necesito una prórroga de 2 días", at), { kind: "days", days: 2 });
  assert.deepEqual(parse("Solicito prórroga hasta el 2026-11-04", at), { kind: "date", date: "2026-11-04" });
  assert.deepEqual(parse("Solicito prórroga hasta el 04/11/2026", at), { kind: "date", date: "2026-11-04" });
  assert.deepEqual(parse("Necesito prórroga de 4 días hasta mañana", at), { kind: "days", days: 4, date: "2026-11-03" });
  assert.equal(parse("Necesito prórroga hasta 2026-02-30", at), null);
});

test("information, hypotheses, reported speech, negation and ambiguous terms never grant", () => {
  for (const text of [
    "¿Qué pasa si pido una prórroga de 4 días?", "¿Qué requisitos necesito para solicitar una prórroga de 2 días?",
    "Me preguntaron si necesito una prórroga de 4 días", "El asesor dijo que solicito una prórroga de 4 días",
    "Quiero saber si puedo pedir una prórroga de 2 días", "Si quisiera una prórroga de 2 días, ¿cómo funciona?",
    "¿Puedo solicitar una prórroga de 2 días?", "Necesito que me expliques la prórroga de 2 días",
    "Quiero consultar la prórroga de 2 días", "Necesito prórroga de 2 días si no me pagan",
    "Necesito guardar el texto prórroga de 2 días", "Quiero entender una prórroga de 2 días",
    "Si necesito una prórroga de 2 días, ¿me ayudarías?",
    "Prórroga de 4 días está permitida?", "Prórroga de 4 días: ¿cuáles son los requisitos?",
    "2 días de prórroga están permitidos?", "Prórroga de 4 días?",
    "Quiero saber si necesito 2 días de prórroga", "Necesito 2 días de prórroga si no me pagan",
    "Necesito 2 días de prórroga: ¿cuáles son los requisitos?", "Prórroga para mañana es posible?",
    "Prórroga para mañana: ¿qué requisitos hay?", "Prórroga para mañana?", "Necesito 2 días para pagar",
    "2 días para pagar", "Quiero entender 2 días de plazo",
    "Tal vez necesito una prórroga de 2 días", "Por ejemplo, necesito una prórroga de 2 días",
    "No quiero prórroga de 2 días", "No la quiero, prórroga de 2 días", "Ya pagué, necesito prórroga de 2 días",
    'El cliente dice: "Necesito prórroga de 2 días"', "Mi mamá necesita prórroga de 2 días",
    "Necesito prórroga de 1 o 2 días", "Necesito prórroga de 1-4 días", "Necesito prórroga de 2 días o 3 días",
    "Necesito prórroga de 5 días", "Necesito prórroga de unos 2 días", "Necesito prórroga hasta mañana o pasado mañana",
    "Necesito prórroga desde el viernes por 2 días", "Necesito prórroga de 2 días crédito FC-1 y crédito FC-2",
    "Necesito prórroga", "2", "mañana", "CONFIRMO PR-AAAAAAAAAAAAAAAA",
  ]) assert.equal(parse(text, at), null, text);
});

test("bare duration requires an actual preceding Diana duration question and a personal native request", () => {
  const request = msg("a", "Necesito prórroga para mi crédito FC-1");
  const question = msg("b", "¿Cuántos días de prórroga necesitas?", 1, "agent");
  const answer = msg("c", "2", 2);
  assert.deepEqual(resolve("c", [request, question, answer]), { intent: { kind: "days", days: 2, folio: "FC-1" }, evidenceIds: ["a", "b", "c"] });
  assert.deepEqual(resolve("c", [request, question, { ...answer, text: "mañana" }])?.intent, { kind: "date", date: "2026-11-03", folio: "FC-1" });
  assert.equal(resolve("c", [answer]), null);
  assert.equal(resolve("c", [msg("a", "Hola"), question, answer]), null);
  assert.equal(resolve("c", [request, msg("b", "¿Cuántos días?", 1, "agent"), answer]), null);
  assert.equal(resolve("c", [msg("a", "¿Qué requisitos necesito para prórroga?"), question, answer]), null);
  assert.equal(resolve("c", [request, question, { ...answer, sentAt: "2026-11-03T05:30:00Z" }]), null);
  assert.equal(resolve("c", [request, { ...question, sentAt: request.sentAt }, answer]), null);
});

test("credit clarification uses native request context while later cancellation or revisions invalidate it", () => {
  const request = msg("a", "Solicito prórroga de 2 días");
  const question = msg("b", "¿Cuál crédito? Indica el folio", 1, "agent");
  const answer = msg("c", "FC-123", 2);
  assert.deepEqual(resolve("c", [request, question, answer])?.intent, { kind: "days", days: 2, folio: "FC-123" });
  for (const text of ["No gracias", "Mejor 3 días", "Ya pagué", "Espera", "Necesito prórroga de 4 días", "Crédito FC-2"]) {
    assert.equal(resolve("a", [request, msg("b", text, 1)]), null, text);
  }
  for (const text of ["1001234567", "Gracias", "Es que no tengo dinero en el momento"]) {
    assert.deepEqual(resolve("a", [request, msg("b", text, 1)])?.intent, { kind: "days", days: 2 }, text);
  }
});

test("equal millisecond timestamps fail closed instead of sorting a cancellation by random UUID", () => {
  const request = msg("z", "Necesito prórroga de 2 días");
  for (const id of ["a", "zz"]) {
    assert.equal(resolve("z", [request, msg(id, "No gracias")]), null);
  }
});
