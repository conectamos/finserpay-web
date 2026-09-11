import assert from "node:assert/strict";
import test from "node:test";
import { completeApprovalDetail, service, approvalFixture, approvalDatabase, plain, pdf } from "./credit-approval-test-loader.mjs";

const idle = { available: true, blocked: false, operation: null };
const blockedStatuses = ["PREPARING", "DISPATCHING", "AWAITING_SIGNATURE", "UNCERTAIN"];
const actor = { id: 7, nombre: "Analista de prueba" };
const details = (fixture, reissue = idle) => completeApprovalDetail(fixture, reissue);

function reissueState(status, changes = {}) {
  const blocked = blockedStatuses.includes(status);
  return {
    available: !blocked, blocked,
    operation: {
      id: "operation-test", status, reason: "Correccion solicitada",
      requestedAt: "2026-09-10T17:00:00.000Z", lastCheckedAt: null,
      completedAt: status === "COMPLETED" ? "2026-09-10T18:00:00.000Z" : null,
      canRefresh: blocked, message: "Estado de prueba",
    },
    ...changes,
  };
}

function withApprovedReview(fixture) {
  fixture.review = {
    status: "APPROVED", revision: 1, approvedRevision: 1,
    approvedAt: new Date("2026-09-10T16:00:00.000Z"), approvedByName: actor.nombre,
    reviewHash: details(fixture).review.reviewHash,
  };
  return fixture;
}

function databaseWithReissue(status, overrides = {}) {
  const fixture = approvalDatabase(overrides);
  const query = fixture.db.$queryRawUnsafe.bind(fixture.db);
  fixture.db.$queryRawUnsafe = async (sql, ...params) => {
    if (sql.includes('FROM "CreditApprovalReissue"')) {
      fixture.state.queries.push({ sql, params });
      assert.equal(params[0], fixture.state.credit.id);
      return [{
        id: "operation-test", status, reason: "Correccion solicitada",
        requestedAt: new Date("2026-09-10T17:00:00.000Z"), lastCheckedAt: null,
        completedAt: status === "COMPLETED" ? new Date("2026-09-10T18:00:00.000Z") : null,
        newProcessUuid: "new-process-81",
      }];
    }
    return query(sql, ...params);
  };
  return fixture;
}

test("expediente nuevo completo habilita correcciones y conserva la fuente de FirmaSeguro", () => {
  const fixture = approvalFixture();
  const item = details(fixture);
  assert.equal(item.canApprove, true);
  assert.deepEqual(plain(item.capabilities), {
    canCorrectEvidence: true, canReissueSignature: true, canCreateNovelty: true, correctionBlockedReason: null,
  });
  assert.equal(item.document.processUuid, fixture.document.processUuid);
  assert.equal(item.document.fileName, fixture.document.signedDocumentFileName);
  assert.equal(item.document.href, "/api/aprobaciones/81/documento");
  assert.equal(item.document.available, true);
  assert.ok(!("signedDocumentBase64" in item.document));
  assert.deepEqual(plain(item.reissue), idle);
});

test("cada foto faltante bloquea el OK pero permite corregir el expediente", async (t) => {
  for (const { field, label } of service.APPROVAL_EVIDENCE) await t.test(label, () => {
    const fixture = approvalFixture();
    fixture.credit[field] = null;
    const item = details(fixture);
    assert.equal(item.canApprove, false);
    assert.equal(item.capabilities.canCorrectEvidence, true);
    assert.equal(item.capabilities.correctionBlockedReason, null);
    assert.ok(item.blockingReasons.some(reason => reason.includes(label)));
    assert.equal(item.evidence.filter(evidence => !evidence.available).length, 1);
  });
});

test("la refirma exige PDF firmado valido sin impedir corregir fotografias", () => {
  for (const document of [
    null,
    { ...approvalFixture().document, signedDocumentBase64: null },
    { ...approvalFixture().document, signedDocumentBase64: Buffer.from("<html>invalid</html>").toString("base64") },
    { ...approvalFixture().document, status: "PENDING", completedAt: null },
  ]) {
    const fixture = { ...approvalFixture(), document };
    const item = details(fixture);
    assert.equal(item.canApprove, false);
    assert.equal(item.document.available, false);
    assert.equal(item.capabilities.canReissueSignature, false);
    assert.equal(item.capabilities.canCorrectEvidence, true);
    assert.equal(item.document.processUuid, document?.processUuid || null);
  }
});

test("un PDF firmado sin identificador de proceso no habilita el reenvio", () => {
  for (const processUuid of [null, "", "   "]) {
    const fixture = approvalFixture();
    fixture.document.processUuid = processUuid;
    const item = details(fixture);
    assert.equal(item.document.available, true);
    assert.equal(item.capabilities.canCorrectEvidence, true);
    assert.equal(item.capabilities.canReissueSignature, false);
  }
});

test("historicos, pagados y anulados no permiten correccion, refirma ni nuevo OK", async (t) => {
  for (const [name, changes, reason] of [
    ["historico", { required: false }, /reglas anteriores/],
    ["pagado", { paid: true }, /liquidaci.n pagada/],
    ...["ANULADO", "ANULADA", "CANCELADO", "CANCELADA", " cancelado "].map(estado => [estado, { estado }, /anulado o cancelado/]),
  ]) await t.test(name, () => {
    const fixture = approvalFixture();
    Object.assign(fixture.credit, changes);
    const before = plain(fixture);
    const item = details(fixture);
    assert.equal(item.canApprove, false);
    assert.equal(item.capabilities.canCorrectEvidence, false);
    assert.equal(item.capabilities.canReissueSignature, false);
    assert.match(item.capabilities.correctionBlockedReason, reason);
    assert.deepEqual(plain(fixture), before);
  });
});

test("todas las refirmas en curso bloquean capacidades aunque el PDF anterior siga firmado", () => {
  for (const status of blockedStatuses) {
    const fixture = approvalFixture();
    const item = details(fixture, reissueState(status));
    assert.equal(item.document.available, true, "el PDF anterior no prueba la finalizacion de la nueva firma");
    assert.equal(item.canApprove, false, status);
    assert.equal(item.capabilities.canCorrectEvidence, false, status);
    assert.equal(item.capabilities.canReissueSignature, false, status);
    assert.match(item.capabilities.correctionBlockedReason, /firma en curso/);
    assert.ok(item.blockingReasons.some(reason => /firma en curso/.test(reason)));
    assert.equal(item.reissue.operation.status, status);
  }
});

test("estado de firma no verificable falla cerrado incluso sin operacion bloqueada", () => {
  const item = details(approvalFixture(), { available: false, blocked: false, operation: null });
  assert.equal(item.canApprove, false);
  assert.equal(item.capabilities.canCorrectEvidence, false);
  assert.equal(item.capabilities.canReissueSignature, false);
  assert.match(item.capabilities.correctionBlockedReason, /No se pudo verificar/);
  assert.ok(item.blockingReasons.some(reason => /No se pudo verificar/.test(reason)));
});

test("fin de refirma no otorga OK automatico y la firma nueva cambia la huella revisada", () => {
  const fixture = approvalFixture();
  const before = details(fixture);
  fixture.document = { ...fixture.document, id: 92, processUuid: "new-process-81",
    signedDocumentBase64: Buffer.from("%PDF-1.4\nNueva firma\n%%EOF").toString("base64") };
  for (const status of ["COMPLETED", "FAILED_SAFE"]) {
    const item = details(fixture, reissueState(status));
    assert.equal(item.review.status, "PENDING");
    assert.equal(item.canApprove, true);
    assert.equal(item.capabilities.canCorrectEvidence, true);
    assert.equal(item.capabilities.canReissueSignature, true);
    assert.equal(item.document.processUuid, "new-process-81");
    assert.notEqual(item.review.reviewHash, before.review.reviewHash);
  }
  fixture.document = { ...fixture.document, signedDocumentBase64: pdf, status: "PENDING", completedAt: null };
  const unsigned = details(fixture, reissueState("COMPLETED"));
  assert.equal(unsigned.canApprove, false, "el estado COMPLETED de operacion no sustituye un documento firmado valido");
  assert.equal(unsigned.capabilities.canReissueSignature, false);
});

test("corregir un credito ya aprobado sigue permitido sin sobrescribir su auditoria al consultar", () => {
  const fixture = withApprovedReview(approvalFixture());
  const before = plain(fixture);
  const item = details(fixture);
  assert.equal(item.review.status, "APPROVED");
  assert.equal(item.canApprove, false);
  assert.equal(item.capabilities.canCorrectEvidence, true);
  assert.equal(item.capabilities.canReissueSignature, true);
  assert.equal(item.review.approvedByName, actor.nombre);
  assert.deepEqual(plain(fixture), before);
});

test("el servicio de OK rechaza refirma pendiente antes de escribir o tratar el envio como reintento", async (t) => {
  for (const status of blockedStatuses) await t.test(status, async () => {
    for (const alreadyApproved of [false, true]) {
      const snapshot = alreadyApproved ? withApprovedReview(approvalFixture()) : approvalFixture();
      const expected = details(snapshot);
      const { db, state } = databaseWithReissue(status, snapshot);
      const before = plain({ credit: state.credit, review: state.review, document: state.document });
      await assert.rejects(service.approveCredit(db, state.credit.id,
        { revision: expected.review.revision, reviewHash: expected.review.reviewHash }, actor),
      { code: "SIGNATURE_REISSUE_PENDING", status: 409 });
      assert.equal(state.writes.length, 0);
      assert.equal(state.events.length, 0);
      assert.deepEqual(plain({ credit: state.credit, review: state.review, document: state.document }), before);
    }
  });
});

test("consultar capacidades no cambia condiciones financieras, contrato firmado ni revision", () => {
  const fixture = withApprovedReview(approvalFixture());
  const before = plain(fixture);
  const baseline = details(fixture);
  for (const state of [idle, { available: false, blocked: false, operation: null },
    ...[...blockedStatuses, "COMPLETED", "FAILED_SAFE"].map(status => reissueState(status))]) {
    const item = details(fixture, state);
    for (const field of ["valorVenta", "cuotaInicial", "creditoAutorizado", "approvedLimit", "score", "initialPaymentPercentage"]) {
      assert.equal(item[field], baseline[field]);
    }
    assert.deepEqual(plain(item.review), plain(baseline.review));
    assert.deepEqual(plain(fixture), before);
  }
});
