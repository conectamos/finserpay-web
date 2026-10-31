import assert from "node:assert/strict";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url);
const { attentionWelcomeCreditWallHref } = await jiti.import("../lib/atencion-work-links.ts");
const detail = (overrides = {}) => ({ canManage: true, item: { kind: "welcome", target: "C-101" }, operationHref: "/dashboard/aprobaciones?credito=101", ...overrides });

test("el muro se vincula exclusivamente al crédito canónico autorizado", () => {
  assert.equal(attentionWelcomeCreditWallHref(detail()), "/dashboard/aprobaciones?credito=101");
  assert.equal(attentionWelcomeCreditWallHref(detail({ canManage: false })), null);
  for (const item of [
    { kind: "enrollment", target: "C-101" }, { kind: "welcome", target: "D-101" },
    { kind: "welcome", target: "C-0" }, { kind: "welcome", target: "C-0101" },
    { kind: "welcome", target: "C-9007199254740992" }, { kind: "welcome", target: "C-101/otro" },
  ]) assert.equal(attentionWelcomeCreditWallHref(detail({ item })), null);
  for (const operationHref of [null, "/dashboard/aprobaciones?credito=102", "/dashboard/aprobaciones", "/dashboard/aprobaciones?credito=101&credito=102", "https://otro.invalid/dashboard/aprobaciones?credito=101", "//otro.invalid", "javascript:void(0)"]) {
    assert.equal(attentionWelcomeCreditWallHref(detail({ operationHref })), null);
  }
});
