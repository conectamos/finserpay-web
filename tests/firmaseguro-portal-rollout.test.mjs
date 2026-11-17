import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

function enabled(env, id = 22) {
  return loadReissueModule("lib/firmaseguro-portal-rollout.ts", {}, { process: { env } })
    .isFirmaSeguroPortalResendEnabled(id);
}
test("portal resend is off by default and requires the exact activation value", () => {
  for (const value of [undefined, "false", "TRUE", "1", " true ", ""]) {
    assert.equal(enabled({ FIRMASEGURO_PORTAL_RESEND_ENABLED: value }), false);
  }
  assert.equal(enabled({ FIRMASEGURO_PORTAL_RESEND_ENABLED: "true" }), true);
});
test("optional pilot scope only admits exact positive safe draft ids", () => {
  const base = { FIRMASEGURO_PORTAL_RESEND_ENABLED: "true" };
  assert.equal(enabled({ ...base, FIRMASEGURO_PORTAL_RESEND_DRAFT_IDS: "12, 22" }), true);
  assert.equal(enabled({ ...base, FIRMASEGURO_PORTAL_RESEND_DRAFT_IDS: "122" }), false);
  for (const scope of ["", "22,", "22,bad", "0,22", "-1,22", "2.2,22", "9007199254740992,22"]) {
    assert.equal(enabled({ ...base, FIRMASEGURO_PORTAL_RESEND_DRAFT_IDS: scope }), false);
  }
  for (const id of [0, -1, 1.5, NaN, Infinity, 9007199254740992]) {
    assert.equal(enabled(base, id), false);
  }
});
