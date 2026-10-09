import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { matchesRegisteredWelcomeVoiceName: matches } = await jiti.import("../lib/credit-welcome-voice-name.ts");

test("exact registered name matches, and extra names or surnames preserve registered tokens in order", () => {
  assert.equal(matches("luz hernandez", "luz hernandez"), true);
  assert.equal(matches("luz estela hernandez gili", "luz hernandez"), true);
  assert.equal(matches("ana maria perez lopez", "ana perez"), true);
  assert.equal(matches("ana maria del pilar perez de lopez", "ana maria perez lopez"), true);
  assert.equal(matches("ana", "ana"), true); // Existing exact equality remains valid.
});

test("wrong surname, partial tokens, reordered or missing registered names cannot match", () => {
  for (const [provided, registered] of [
    ["luz estela fernandez gili", "luz hernandez"],
    ["luz hernandezgarcia", "luz hernandez"],
    ["lucia hernandez", "luz hernandez"],
    ["luz hernande", "luz hernandez"],
    ["luz hernandez estela gili", "luz estela hernandez gili"],
    ["ana perez", "ana maria perez lopez"],
    ["ana maria lopez perez", "ana maria perez lopez"],
    ["luz", "luz hernandez"],
    ["hernandez luz", "luz hernandez"],
  ]) assert.equal(matches(provided, registered), false, `${provided} / ${registered}`);
});

test("the supplied name starts with the first registered token and one registered token grants no tolerance", () => {
  assert.equal(matches("otra luz hernandez", "luz hernandez"), false);
  assert.equal(matches("maria ana perez", "ana perez"), false);
  assert.equal(matches("luz estela", "luz"), false);
  assert.equal(matches("ana perez", "ana"), false);
  assert.equal(matches("luz estela hernandez", "luz hernandez"), true);
});

test("each registered occurrence needs a different supplied occurrence in the same order", () => {
  assert.equal(matches("juan perez", "juan juan perez"), false);
  assert.equal(matches("juan carlos juan perez", "juan juan perez"), true);
  assert.equal(matches("ana maria perez ana lopez", "ana perez ana lopez"), true);
  assert.equal(matches("ana maria perez lopez", "ana perez ana lopez"), false);
});

test("inputs must already have accents, case and separators normalized by the caller", () => {
  assert.equal(matches("ana maria perez", "ana maria perez"), true);
  for (const [provided, registered] of [
    ["Ana María Pérez", "ana maria perez"],
    ["ana maria perez", "Ana María Pérez"],
    ["ana  maria perez", "ana maria perez"],
    [" ana maria perez", "ana maria perez"],
    ["ana maria-perez", "ana maria perez"],
    ["ana maria perez.", "ana maria perez"],
    ["ana maria perez\n", "ana maria perez"],
  ]) assert.equal(matches(provided, registered), false);
});

test("limits apply to both inputs, including exact equality, and empty or malformed input fails closed", () => {
  const twenty = ["ana", ...Array(18).fill("maria"), "perez"].join(" ");
  const twentyOne = ["ana", ...Array(19).fill("maria"), "perez"].join(" ");
  assert.equal(matches(twenty, "ana perez"), true);
  assert.equal(matches(twenty, twenty), true);
  assert.equal(matches(twentyOne, "ana perez"), false);
  assert.equal(matches(twentyOne, twentyOne), false);
  const twoForty = "a".repeat(120) + " " + "b".repeat(119);
  assert.equal(matches(twoForty, twoForty), true);
  assert.equal(matches(twoForty + "c", twoForty + "c"), false);
  for (const value of ["", " ", null, undefined, {}, 123, "ana  perez", "ana\u0000perez", "ana\u200bperez"]) {
    assert.equal(matches(value, "ana perez"), false);
    assert.equal(matches("ana perez", value), false);
    assert.equal(matches(value, value), false);
  }
});

test("strict name matching does not inherit private welcome pronunciation equivalences", () => {
  for (const [provided, registered] of [["cindy", "sindy"], ["sesar", "cesar"], ["lus", "luz"], ["ana crus", "ana cruz"]]) {
    assert.equal(matches(provided, registered), false);
  }
});
