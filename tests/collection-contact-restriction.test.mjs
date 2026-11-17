import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/collection-contact-restriction.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const runtimeEnvironment = {};
const module = { exports: {} };
runInNewContext(code, { module, exports: module.exports, process: { env: runtimeEnvironment }, require(name) {
  assert.equal(name, "server-only");
  return {};
} });
const { isCollectionContactRestricted: restricted, COLLECTION_CONTACT_RESTRICTION_REASON: reason } = module.exports;
const environment = value => ({ COLLECTION_CONTACT_EXCLUDED_DOCUMENTS: value });

test("empty configuration does not restrict any customer", () => {
  for (const env of [{}, environment(""), environment(" , ; \r\n\t ")]) {
    assert.equal(restricted("9000012345", env), false);
  }
});

test("formatted documents match exactly and preserve leading zeroes", () => {
  const env = environment("90.000.123-45; 00 001 2345");
  for (const document of ["9000012345", " 90.000.123-45 ", "90 000 123 45", "90\t000\u00a0123 45"]) {
    assert.equal(restricted(document, env), true, document);
  }
  assert.equal(restricted("000012345", env), true);
  for (const document of ["12345", "00012345", "900001234", "90000123450", "9000012346"]) {
    assert.equal(restricted(document, env), false, document);
  }
});

test("comma, semicolon and line breaks separate independent documents", () => {
  const env = environment("9000012345, 9000012346;9000012347\n9000012348\r\n9000012349\r9000012350;;9000012345,");
  for (const document of ["9000012345", "9000012346", "9000012347", "9000012348", "9000012349", "9000012350"]) {
    assert.equal(restricted(document, env), true, document);
  }
  assert.equal(restricted("9000012351", env), false);
});

test("invalid configured values cannot accidentally restrict another document", () => {
  for (const entry of ["CC9000012345", "90000x12345", "+9000012345", "-9000012345", "9000012345/", "9e9", "90000..12345", "90000--12345", "9000012345:9000012346"]) {
    assert.equal(restricted("9000012345", environment(entry)), false, entry);
  }
  assert.equal(restricted("9000012345", environment("CC9000012346;9000012345;invalid")), true);
  assert.equal(restricted("1234512345", environment("12345\n12345")), false);
});

test("non-text, invalid, signed or joined input documents never match", () => {
  const env = environment("9000012345;1234512345;00000;1234;1234567890123456");
  const invalid = [null, undefined, false, true, 9000012345, NaN, Infinity, {}, ["9000012345"],
    { toString: () => "9000012345" }, "", "00000", "1234", "1234567890123456", "CC9000012345",
    "+9000012345", "-9000012345", "90000/12345", "90000..12345", "90000--12345", "12345\n12345",
    "9000012345,9000012346", "9000012345;9000012346", "９００００１２３４５"];
  for (const value of invalid) assert.equal(restricted(value, env), false);
});

test("valid length boundaries and zero prefixes do not broaden identity", () => {
  const env = environment("01234;123456789012345");
  assert.equal(restricted("01234", env), true);
  assert.equal(restricted("1234", env), false);
  assert.equal(restricted("123456789012345", env), true);
  assert.equal(restricted("123456789012344", env), false);
});

test("every check uses the current configuration without caching or mutation", () => {
  const env = environment("9000012345");
  assert.equal(restricted("9000012345", env), true);
  env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = "9000012346";
  assert.equal(restricted("9000012345", env), false);
  assert.equal(restricted("9000012346", env), true);
  delete env.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS;
  assert.equal(restricted("9000012346", env), false);
  assert.equal(restricted("9000012345", Object.freeze(environment("9000012345"))), true);
});

test("default server environment is read at call time and reason stays customer-neutral", () => {
  assert.equal(restricted("9000012345"), false);
  runtimeEnvironment.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = "9000012345";
  assert.equal(restricted("9000012345"), true);
  runtimeEnvironment.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS = "9000012346";
  assert.equal(restricted("9000012345"), false);
  assert.equal(restricted("9000012346"), true);
  delete runtimeEnvironment.COLLECTION_CONTACT_EXCLUDED_DOCUMENTS;
  assert.equal(restricted("9000012346"), false);
  assert.equal(reason, "Este cliente tiene restringidos los contactos de cobro por WhatsApp y llamadas.");
});
