import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseWelcomeVoiceSpokenDocument: parse, parseWelcomeVoiceDocumentDictation: dictation } = await jiti.import("../lib/credit-welcome-voice-document.ts");

test("numeric document accepts explicit formatting without guessing signs or decimal fractions", () => {
  for (const [raw, expected] of [
    ["12345678", "12345678"], ["  00123456  ", "00123456"],
    ["12.345.678", "12345678"], ["12,345,678", "12345678"],
    ["12 345 678", "12345678"], ["00123-456", "00123456"],
    ["00.123.456-78", "0012345678"], ["12345", "12345"],
    ["123456789012345", "123456789012345"],
  ]) assert.equal(parse(raw), expected, raw);
  for (const raw of ["-12345678", "+12345678", "12.34", "12345.67", "12345,67", "12,34,56",
    "12..345.678", "12,,345,678", "12.345,678", "12345-", "-12-345", "1234", "1234567890123456"]) {
    assert.equal(parse(raw), null, raw);
  }
});

test("a sequence of spoken digits preserves every digit and leading zero", () => {
  for (const [raw, expected] of [
    ["uno dos tres cuatro cinco", "12345"],
    ["cero cero uno dos tres cuatro cinco seis", "00123456"],
    ["NUEVE   ocho siete seis cinco cuatro tres dos uno cero", "9876543210"],
    ["uno dos; tres cuatro; cero cinco", "123405"],
  ]) assert.equal(parse(raw), expected, raw);
  assert.equal(parse("uno dos tres cuatro"), null);
  assert.equal(parse(Array(16).fill("uno").join(" ")), null);
});

test("explicit doble repeats one digit word before the existing grouped-number parser", () => {
  // Synthetic document with the same spoken grouping as the reported call.
  assert.equal(parse("Uno doble cero dos cuatro cuarenta y tres uno diez."), "1002443110");
  for (const [digit, expected] of [
    ["cero", "10092"], ["uno", "11192"], ["dos", "12292"], ["tres", "13392"], ["cuatro", "14492"],
    ["cinco", "15592"], ["seis", "16692"], ["siete", "17792"], ["ocho", "18892"], ["nueve", "19992"],
  ]) assert.equal(parse(`uno doble ${digit} nueve dos`), expected, digit);
  assert.equal(parse("DOBLE   NUEVE doble ocho doble siete!"), "998877");
  assert.equal(parse("12; doble cero; tres cuatro cinco"), "1200345");
  assert.equal(parse("doce, doble cero tres cuatro cinco"), "1200345");
});

test("doble cannot infer a digit, cross a block boundary or introduce other multipliers", () => {
  for (const raw of [
    "uno dos tres doble", "uno doble equis tres cuatro", "uno doble 0 tres cuatro", "uno doble diez tres cuatro",
    "uno doble cien tres cuatro", "uno doble veinte tres cuatro", "uno doble doble cero tres cuatro",
    "uno triple cero tres cuatro", "uno doble triple cero tres cuatro", "uno dobles cero tres cuatro",
    "uno doble ceros tres cuatro", "uno redoble cero tres cuatro", "uno doble, cero tres cuatro cinco",
    "uno doble; cero tres cuatro cinco", "12 doble cero tres cuatro cinco", "uno doblecero tres cuatro cinco",
  ]) assert.equal(parse(raw), null, raw);
});

test("double digits preserve ambiguity, separator validation and document bounds", () => {
  for (const raw of [
    "cien doble uno; doscientos; noventa", "treinta doble ocho; uno dos tres", "doscientos doble dos; uno dos tres",
    "doscientos cuarenta y cuatro veinte doble uno", "uno doble cero;; tres cuatro cinco",
    "uno doble cero / tres cuatro cinco", "uno doble cero. tres cuatro cinco", "uno doble cero\u200b tres cuatro cinco",
    "uno doble cero\n tres cuatro cinco", "doble cero uno dos", Array(8).fill("doble cero").join(" "),
  ]) assert.equal(parse(raw), null, raw);
  assert.equal(parse(Array(7).fill("doble cero").join(" ") + " uno"), "0".repeat(14) + "1");
  const withinLimit = " ".repeat(240 - "uno doble cero nueve dos".length) + "uno doble cero nueve dos";
  assert.equal(parse(withinLimit), "10092");
  assert.equal(parse(" " + withinLimit), null);
});

test("sentence punctuation does not change numeric formatting or spoken digits", () => {
  for (const [raw, expected] of [
    ["00.123.456-78.", "0012345678"], ["12345!", "12345"],
    ["12.345.678?", "12345678"], ["cero cero uno dos tres cuatro cinco…", "0012345"],
    ["uno dos tres cuatro cinco.", "12345"],
  ]) assert.equal(parse(raw), expected, raw);
  for (const raw of ["12345.67.", "12345,67!", "12.34?", "-12345678.", "12..345.678…",
    "doce. trescientos. noventa.", "uno dos tres cuatro equis."]) {
    assert.equal(parse(raw), null, raw);
  }
});

test("uniquely decomposable spoken fragments accept the actual call transcripts without guessing", () => {
  for (const [raw, expected] of [
    ["Treinta y ocho, uno cuarenta y cuatro, cero nueve dos.", "38144092"],
    ["treinta y ocho, ciento cuarenta y cuatro, cero noventa y dos.", "38144092"],
    ["treinta y ocho ciento cuarenta y cuatro cero noventa y dos", "38144092"],
    ["treinta y ocho ciento cuarenta y cuatro cero noventa y dos.", "38144092"],
    ["doce; uno cuarenta y cuatro; cero noventa y dos", "12144092"],
    ["treinta, ocho, cero nueve dos", "308092"],
    ["diez once doce", "101112"],
    ["cero uno noventa y dos; ciento cuarenta; treinta", "019214030"],
    ["cien, uno, doscientos, noventa", "100120090"],
  ]) assert.equal(parse(raw), expected, raw);
  for (const raw of ["doscientos cuarenta y cuatro veinte", "doce; doscientos cuarenta y cuatro veinte",
    "treinta ocho; ciento cuarenta y cuatro; cero noventa y dos", "veinte dos; ciento cuarenta y cuatro; cero noventa y dos",
    "treinta y ocho, uno cuarenta y cuatro, cero equis dos."]) {
    assert.equal(parse(raw), null, raw);
  }
});

test("explicit cardinal blocks accept 0–999 and retain leading zeroes inside a block", () => {
  for (const [raw, expected] of [
    ["treinta y ocho, ciento cuarenta y cuatro, cero noventa y dos", "38144092"],
    ["doce; trescientos cuarenta y cinco; seiscientos setenta y ocho", "12345678"],
    ["veintidós, dieciséis, cero cero cinco", "2216005"],
    ["cien; doscientos; cero", "1002000"],
    ["cero cero ciento veintitrés", "00123"],
    ["novecientos noventa y nueve; quinientos; setecientos", "999500700"],
    ["ochocientos; seiscientos; cuatrocientos", "800600400"],
    ["ciento uno; ciento diez; ciento veintinueve", "101110129"],
    ["treinta y uno; cuarenta y dos; cincuenta y tres; sesenta y cuatro", "31425364"],
    ["setenta y cinco; ochenta y seis; noventa y siete", "758697"],
  ]) assert.equal(parse(raw), expected, raw);
});

test("numeric and spoken blocks may mix only across explicit comma or semicolon boundaries", () => {
  assert.equal(parse("12; trescientos cuarenta y cinco; 678"), "12345678");
  assert.equal(parse("12, uno cuatro cuatro, cero noventa y dos"), "12144092");
  for (const raw of ["doce 345 seis", "12 tres cuatro cinco", "ciento 23; cuatro cinco seis",
    "12345; seis", "doce; 3.45; seiscientos", "doce; 345-678; nueve", "uno2trescuatrocinco"]) {
    assert.equal(parse(raw), null, raw);
  }
});

test("ambiguous grouping, unknown words, unsupported cardinals and malformed separators fail closed", () => {
  for (const raw of [
    "treinta ocho; ciento cuarenta cuatro; noventa dos",
    "treinta y cero; ciento cuarenta y cuatro; noventa y dos",
    "ciento; cuarenta; cuatro", "cien uno; doscientos; noventa",
    "ciento cero; ciento cuarenta; noventa", "dos cientos; ciento cuarenta; noventa",
    "mil; ciento cuarenta; noventa", "menos doce; trescientos cuarenta; noventa",
    "doce punto cinco; trescientos; noventa", "doce coma cinco; trescientos; noventa",
    "mi cédula es uno dos tres cuatro cinco", "uno dos tres cuatro equis", "constructor; doce; trescientos",
    "doce;; trescientos; noventa", ";doce; trescientos; noventa", "doce; trescientos; noventa;",
    "doce,; trescientos; noventa", "doce. trescientos. noventa", "doce / trescientos / noventa",
  ]) assert.equal(parse(raw), null, raw);
});

test("input and output bounds reject unknown types, controls, invisible characters and oversized documents", () => {
  for (const raw of [null, undefined, 12345678, {}, [], true, "", " ", "12345\n678", "12345\u0000678",
    "12345\u200b678", "１２３４５６７８", "x".repeat(241), " ".repeat(236) + "12345"]) {
    assert.equal(parse(raw), null);
  }
  assert.equal(parse(" ".repeat(235) + "12345"), "12345"); // Exactly 240 input characters.
  assert.equal(parse("cero cero cero cero cero cero cero cero cero cero cero cero cero cero cero"), "0".repeat(15));
  assert.equal(parse("cero cero cero cero cero cero cero cero cero cero cero cero cero cero cero cero"), null);
});

test("dictation without its literal completion control retains the strict parser result and stays incomplete", () => {
  for (const [raw, document] of [
    ["Uno.", null], ["00123456", "00123456"],
    ["cero cero uno dos tres cuatro cinco", "0012345"],
    ["doce; trescientos cuarenta y cinco; 678", "12345678"],
    ["Uno doble cero dos cuatro cuarenta y tres uno diez.", "1002443110"],
    ["treinta seis; uno dos tres cuatro", null],
  ]) assert.deepEqual(dictation(raw), { document, complete: false }, raw);
});

test("dictation recognizes only the separate final termine control and preserves actual leading zeroes and blocks", () => {
  for (const [raw, document] of [
    ["cero cero uno dos tres cuatro cinco terminé", "0012345"],
    ["doce; trescientos cuarenta y cinco; 678, terminé.", "12345678"],
    ["Uno doble cero dos cuatro cuarenta y tres uno diez; TERMINE!", "1002443110"],
    ["00123456. terminé?", "00123456"],
    ["12345,terminé", "12345"], ["12345; termine…", "12345"],
    [" 12345  TERMINÉ!? ", "12345"], ["12345 termine\u0301.", "12345"],
    ["12345 terminé,;", "12345"],
  ]) {
    assert.deepEqual(dictation(raw), { document, complete: true }, raw);
    assert.equal(parse(raw), null, "The strict parser itself must not accept the control marker");
  }
});

test("a final control cannot make a short, ambiguous, repeated, malformed or foreign document valid", () => {
  for (const raw of [
    "Uno. terminé", "uno dos tres cuatro terminé", "treinta seis; uno dos tres cuatro terminé",
    "cien uno; doscientos; noventa terminé", "12345 terminé terminé",
    "terminé 12345 terminé", "uno dos terminé tres cuatro cinco terminé",
    "12345;; terminé", "12345,; terminé", "uno doble; cero tres cuatro cinco terminé",
    "12345.67 terminé", "12345,67 terminé", "+12345 terminé", "-12345 terminé",
    "mi documento es 12345 terminé", "uno dos tres cuatro equis terminé",
    "uno dos tres cuatro cinco / terminé", "12345: terminé", "12345 / terminé", "1234567890123456 terminé",
    "１２３４５ terminé", "12345\u200b terminé", "12345\n terminé",
  ]) assert.equal(dictation(raw).document, null, raw);
});

test("initial, embedded, attached and nonliteral finish words never establish a valid completed document", () => {
  for (const raw of [
    "terminé", "terminé 12345", "terminé, 12345", "123 terminé 45",
    "12345 terminé seis", "12345 terminé, seis", "12345termine",
    "12345termine.", "12345 terminamos", "12345 finalicé", "12345 terminé ya",
    "12345 termíne", "12345-terminé",
  ]) {
    assert.equal(dictation(raw).document, null, raw);
    assert.equal(dictation(raw).complete, false, raw);
  }
});

test("dictation bounds cover the complete raw input before removing its control marker", () => {
  for (const raw of [null, undefined, 12345, {}, [], true, "", " ", "12345\u0000 terminé",
    "12345\u200d terminé", " ".repeat(241), " ".repeat(228) + "12345 terminé"]) {
    assert.deepEqual(dictation(raw), { document: null, complete: false });
  }
  const exactLimit = " ".repeat(240 - "12345 terminé".length) + "12345 terminé";
  assert.equal(exactLimit.length, 240);
  assert.deepEqual(dictation(exactLimit), { document: "12345", complete: true });
  assert.deepEqual(dictation(" " + exactLimit), { document: null, complete: false });
});
