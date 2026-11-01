import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { isMetaPhoneRecipient, isMetaBusinessUserId, isMetaRecipient, metaRecipientPhone } = await createJiti(import.meta.url).import("../lib/atencion-meta-identity.ts");

test("Meta identity keeps canonical phones and ordinary BSUIDs distinct and opaque", () => {
  for (const value of ["12025550100", "1234567", "1".repeat(15)]) {
    assert.equal(isMetaPhoneRecipient(value), true); assert.equal(isMetaBusinessUserId(value), false);
    assert.equal(isMetaRecipient(value), true); assert.equal(metaRecipientPhone(value), `+${value}`);
  }
  for (const value of ["CO.A1b2C3", "US.12025550100", `CO.${"a".repeat(128)}`]) {
    assert.equal(isMetaBusinessUserId(value), true); assert.equal(isMetaPhoneRecipient(value), false);
    assert.equal(isMetaRecipient(value), true); assert.equal(metaRecipientPhone(value), null);
  }
});

test("invalid identifiers and unenabled parent IDs never become phone numbers", () => {
  for (const value of [undefined, null, 12025550100, "", "+12025550100", " 12025550100", "01234567", "123456", "1".repeat(16),
    "co.A1", "C.A1", "COL.A1", "CO.", "CO.A_B", "CO.A/B", "+CO.A1", "CO.A1 ", "CO.Á1", "CO.ENT.A1", `CO.${"a".repeat(129)}`]) {
    assert.equal(isMetaRecipient(value), false, String(value)); assert.equal(metaRecipientPhone(value), null, String(value));
  }
});
