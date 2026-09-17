import assert from "node:assert/strict";
import test from "node:test";
import { service, approvalFixture, completeApprovalDetail } from "./credit-approval-test-loader.mjs";

test("el número visible no cambia folio, hash de revisión ni documento firmado", () => {
  const original = approvalFixture();
  const before = completeApprovalDetail(original);
  const changed = { ...original, credit: { ...original.credit, numeroCreditoVisible: "000081-A" } };
  const after = completeApprovalDetail(changed);
  assert.equal(after.numeroCreditoVisible, "000081-A");
  assert.equal(after.folio, before.folio);
  assert.equal(after.review.reviewHash, before.review.reviewHash);
  assert.equal(after.document.href, before.document.href);
  assert.equal(after.document.fileName, before.document.fileName);
  assert.equal(after.document.processUuid, before.document.processUuid);
  assert.deepEqual(after.evidence, before.evidence);
  assert.equal(service.buildCreditApprovalDetail(original.credit, original.review, original.assessment, original.document).numeroCreditoVisible, original.credit.folio);
});
