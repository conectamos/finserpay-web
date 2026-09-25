import assert from "node:assert/strict";
import test from "node:test";
import { load, routeFixture, catalogs, sample, call } from "./mass-credit-sadmin-fixture.mjs";
const { readImportImei } = load("lib/mass-credit-imei.ts");
const emptyDb = { ...catalogs, $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0, $transaction: async work => work(emptyDb), credito: { findMany: async () => [], create: async () => { assert.fail("Un IMEI inválido no puede crear créditos"); } } };

test("IMEI is exact text: no truncation, rounding or stripped characters", () => {
  for (const input of ["001234567890123", "999999999999999", "123456789012345", 123456789012345]) {
    const result = readImportImei(input);
    assert.equal(result.error, null); assert.equal(result.value, String(input));
  }
  assert.equal(readImportImei(" '001234567890123 ").value, "001234567890123");
  for (const input of ["1E+15", "1,23456789012345e14", "1.23456789012345E+14", "1E15", "1234567890123456", "01234567890123", "123456789012345.0", "IMEI:123456789012345", "12345678 9012345", null, {}]) {
    assert.ok(readImportImei(input).error, JSON.stringify(input));
  }
  assert.match(readImportImei("1E+15").error, /notación científica/);
});

test("API reports every damaged IMEI before creation, retaining the original value for correction", async () => {
  const values = ["1E+15", "1.23456789012345E+14", "1234567890123456", "IMEI:123456789012345", "001234567890123"];
  const rows = values.map((imei, i) => sample(i + 1, { imei }));
  const { data } = await call(routeFixture(emptyDb), rows);
  assert.equal(data.summary.invalid, 4); assert.equal(data.summary.valid, 1);
  values.forEach((imei, i) => assert.equal(data.rows[i].normalized.imei, imei));
  assert.match(data.rows[0].errors.join(" "), /notación científica/);
  assert.match(data.rows[2].errors.join(" "), /exactamente 15/);
  const result = await call(routeFixture(emptyDb), rows, { commit: true, sadminConfirmed: true, requestId: "63493896-cb49-48fb-a2ce-ef3cb3144bbd" });
  assert.equal(result.data.commit, false); assert.equal(result.data.summary.invalid, 4);
});

test("single creation rejects malformed IMEI and exact duplicate detection remains", async () => {
  assert.equal((await call(routeFixture(emptyDb), [sample(1, { imei: "1E+15" })])).data.summary.invalid, 1);
  const { data } = await call(routeFixture(emptyDb), [sample(1, { imei: "001234567890123" }), sample(2, { imei: "'001234567890123" })]);
  assert.equal(data.summary.invalid, 2);
  assert.ok(data.rows.every(row => row.errors.includes("IMEI repetido en la carga")));
});
