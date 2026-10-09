import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseWelcomeVoiceSpokenDocument: parse } = await jiti.import("../lib/credit-welcome-voice-document.ts");

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
    "treinta y ocho ciento cuarenta y cuatro cero noventa y dos",
    "treinta ocho; ciento cuarenta cuatro; noventa dos",
    "treinta y cero; ciento cuarenta y cuatro; noventa y dos",
    "ciento; cuarenta; cuatro", "cien uno; doscientos; noventa",
    "ciento cero; ciento cuarenta; noventa", "dos cientos; ciento cuarenta; noventa",
    "mil; ciento cuarenta; noventa", "menos doce; trescientos cuarenta; noventa",
    "doce punto cinco; trescientos; noventa", "doce coma cinco; trescientos; noventa",
    "mi cédula es uno dos tres cuatro cinco", "uno dos tres cuatro equis", "constructor; doce; trescientos",
    "doce;; trescientos; noventa", ";doce; trescientos; noventa", "doce; trescientos; noventa;",
    "doce,; trescientos; noventa", "doce. trescientos. noventa", "doce / trescientos / noventa",
    "cero uno noventa y dos; ciento cuarenta; treinta", "diez once doce",
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
