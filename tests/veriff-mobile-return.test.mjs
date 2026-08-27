import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildVeriffCompletionUrl,
  VERIFF_COMPLETION_PATH,
} from "../lib/veriff-callback.ts";
import {
  compareDataCreditoVeriffIdentityEvidence,
  compareStrictIdentityDocuments,
  getDataCreditoVeriffIdentityRejectionCode,
  normalizeIdentityDocumentNumber,
  veriffIdentityMatchesExpectedDocument,
} from "../lib/veriff-identity.ts";
import {
  extractVeriffIdentityDocumentEvidence,
  resolveVeriffStatusEvidence,
} from "../lib/veriff.ts";

const veriffRoute = readFileSync(
  new URL("../app/api/creditos/veriff/route.ts", import.meta.url),
  "utf8"
);
const creditRoute = readFileSync(
  new URL("../app/api/creditos/route.ts", import.meta.url),
  "utf8"
);
const veriffStorage = readFileSync(
  new URL("../lib/veriff-storage.ts", import.meta.url),
  "utf8"
);
const veriffRetryPolicy = readFileSync(
  new URL("../lib/veriff-retry-policy.ts", import.meta.url),
  "utf8"
);
const factoryConsole = readFileSync(
  new URL(
    "../app/dashboard/creditos/credit-factory-console.tsx",
    import.meta.url
  ),
  "utf8"
);
const completionPage = readFileSync(
  new URL(
    "../app/validacion-identidad/completada/page.tsx",
    import.meta.url
  ),
  "utf8"
);
const deploymentGuide = readFileSync(
  new URL("../DEPLOYMENT-RAILWAY.md", import.meta.url),
  "utf8"
);

function sourceBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  assert.notEqual(startIndex, -1, `No se encontró el inicio: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("el callback de Veriff siempre termina en una pantalla pública", () => {
  const configured = buildVeriffCompletionUrl(
    new Request("http://localhost:3000/api/creditos/veriff"),
    { NEXT_PUBLIC_APP_URL: "https://finserpay.com/" }
  );
  const forwarded = buildVeriffCompletionUrl(
    new Request("http://internal:3000/api/creditos/veriff", {
      headers: {
        host: "internal:3000",
        "x-forwarded-host": "ventas.finserpay.com",
        "x-forwarded-proto": "https",
      },
    }),
    {}
  );

  assert.equal(VERIFF_COMPLETION_PATH, "/validacion-identidad/completada");
  assert.equal(
    configured,
    "https://finserpay.com/validacion-identidad/completada"
  );
  assert.equal(
    forwarded,
    "https://ventas.finserpay.com/validacion-identidad/completada"
  );
  assert.doesNotMatch(configured, /\/dashboard|\/login/);
});

test("la creación de la sesión sobreescribe cualquier callback administrativo antiguo", () => {
  assert.match(
    veriffRoute,
    /callbackUrl:\s*buildVeriffCompletionUrl\(request\)/
  );
  assert.match(completionPage, /Ya puedes cerrar esta pestaña y volver con el asesor/);
  assert.match(completionPage, /No necesitas iniciar sesión en este celular/);
  assert.doesNotMatch(
    deploymentGuide,
    /VERIFF_CALLBACK_URL=https:\/\/finserpay\.com\/dashboard/
  );
});

test("la identidad conserva los campos ancla de DataCrédito y no reinicia el asistente", () => {
  assert.equal(normalizeIdentityDocumentNumber("1.110.178.524"), "1110178524");
  assert.equal(
    veriffIdentityMatchesExpectedDocument("1.110.178.524", "1110178524"),
    true
  );
  assert.equal(
    veriffIdentityMatchesExpectedDocument("999999999", "1110178524"),
    false
  );
  assert.equal(veriffIdentityMatchesExpectedDocument(null, "1110178524"), true);

  const applyIdentity = sourceBlock(
    factoryConsole,
    "const applyVeriffIdentityData",
    "const veriffMissingIdentityMessage"
  );

  assert.match(
    applyIdentity,
    /const dataCreditoIdentityLocked =\s*Boolean\(options\.lockDataCreditoIdentity\) \|\|\s*Boolean\(dataCreditoApproval\) \|\|\s*Boolean\(dataCreditoAssessmentId\)/
  );
  assert.match(applyIdentity, /lastName && !dataCreditoIdentityLocked/);
  assert.match(applyIdentity, /documentNumber && !dataCreditoIdentityLocked/);
  assert.match(applyIdentity, /identity\.documentType && !dataCreditoIdentityLocked/);
  assert.doesNotMatch(applyIdentity, /setClienteFechaExpedicion/);
  assert.doesNotMatch(applyIdentity, /setWizardStep\(1\)/);
  assert.doesNotMatch(
    factoryConsole,
    /veriffApprovalCanUnlockClient\(\s*veriffValidation,\s*veriffExpectedDraftId\s*\)/
  );
  assert.doesNotMatch(
    factoryConsole,
    /veriffApprovalCanUnlockClient\(\s*validation,\s*veriffExpectedDraftId\s*\)/
  );
});

test("la comparación estricta exige que Veriff entregue exactamente la cédula consultada", () => {
  assert.deepEqual(
    compareStrictIdentityDocuments("1.110.178.524", "1110178524"),
    {
      ok: true,
      status: "match",
      received: "1110178524",
      expected: "1110178524",
    }
  );
  assert.equal(
    compareStrictIdentityDocuments("1 110-178.524", "1.110.178.524").ok,
    true
  );

  assert.deepEqual(compareStrictIdentityDocuments(null, "1110178524"), {
    ok: false,
    status: "missing",
    field: "veriff",
  });
  assert.deepEqual(compareStrictIdentityDocuments("1110178524", "  "), {
    ok: false,
    status: "missing",
    field: "expected",
  });
  assert.deepEqual(compareStrictIdentityDocuments(undefined, null), {
    ok: false,
    status: "missing",
    field: "both",
  });

  for (const invalid of [
    "CC 1110178524",
    "1110178524 CC",
    "1110178524A",
    "+1110178524",
    "1..110.178.524",
    "1110178524/1",
  ]) {
    assert.deepEqual(compareStrictIdentityDocuments(invalid, "1110178524"), {
      ok: false,
      status: "invalid-format",
      field: "veriff",
    });
  }

  assert.deepEqual(
    compareStrictIdentityDocuments("111017852", "1110178524"),
    {
      ok: false,
      status: "mismatch",
      received: "111017852",
      expected: "1110178524",
    }
  );
  assert.deepEqual(
    compareStrictIdentityDocuments("11101785240", "1110178524"),
    {
      ok: false,
      status: "mismatch",
      received: "11101785240",
      expected: "1110178524",
    }
  );

  // El helper anterior conserva su semántica permisiva para otros flujos.
  assert.equal(veriffIdentityMatchesExpectedDocument(null, "1110178524"), true);
});

test("la evidencia Veriff compara todos los campos y exige el documento capturado", () => {
  const expectedDocument = "1110178524";
  const matchingEvidence = extractVeriffIdentityDocumentEvidence({
    verification: {
      person: { idNumber: expectedDocument, firstName: "Ana" },
      document: {
        number: "1.110.178.524",
        type: "ID_CARD",
        country: "CO",
      },
    },
  });

  assert.deepEqual(matchingEvidence.personNumbers, [expectedDocument]);
  assert.equal(matchingEvidence.documents[0]?.number, "1.110.178.524");
  assert.deepEqual(
    compareDataCreditoVeriffIdentityEvidence(
      matchingEvidence,
      expectedDocument
    ),
    { ok: true, status: "match", documentNumber: expectedDocument }
  );

  const internalConflict = extractVeriffIdentityDocumentEvidence({
    verification: {
      person: { idNumber: expectedDocument, firstName: "Ana" },
      document: { number: "9999999999", type: "ID_CARD", country: "CO" },
    },
  });
  assert.equal(
    compareDataCreditoVeriffIdentityEvidence(
      internalConflict,
      expectedDocument
    ).status,
    "mismatch"
  );

  const requestEchoOnly = extractVeriffIdentityDocumentEvidence({
    verification: {
      person: { idNumber: expectedDocument, firstName: "Ana" },
    },
    requestPayload: {
      document: { number: expectedDocument, type: "ID_CARD", country: "CO" },
    },
  });
  assert.equal(requestEchoOnly.documents.length, 0);
  assert.equal(
    compareDataCreditoVeriffIdentityEvidence(
      requestEchoOnly,
      expectedDocument
    ).status,
    "missing"
  );

  for (const externalWrapper of [
    "originalRequest",
    "originalRequestPayload",
    "inputData",
    "initData",
    "clientData",
    "sourceData",
    "prefilledData",
    "userProvidedIdentity",
  ]) {
    const wrappedRequestEcho = extractVeriffIdentityDocumentEvidence({
      verification: {
        person: { idNumber: expectedDocument, firstName: "Ana" },
      },
      [externalWrapper]: {
        document: { number: expectedDocument, type: "ID_CARD", country: "CO" },
      },
    });

    assert.equal(
      wrappedRequestEcho.documents.length,
      0,
      `${externalWrapper} no puede convertirse en evidencia documental de Veriff`
    );
    assert.equal(
      compareDataCreditoVeriffIdentityEvidence(
        wrappedRequestEcho,
        expectedDocument
      ).status,
      "missing"
    );
  }
});

test("la evidencia rechaza conflictos entre fuentes, tipo distinto o país distinto", () => {
  const expectedDocument = "1110178524";
  const decision = extractVeriffIdentityDocumentEvidence({
    verification: {
      person: { idNumber: expectedDocument, firstName: "Ana" },
      document: { number: expectedDocument, type: "ID_CARD", country: "COL" },
    },
  });
  const conflictingWebhook = extractVeriffIdentityDocumentEvidence({
    verification: {
      person: { idNumber: expectedDocument, firstName: "Ana" },
      document: { number: "9999999999", type: "ID_CARD", country: "CO" },
    },
  });

  assert.equal(
    compareDataCreditoVeriffIdentityEvidence(
      [decision, conflictingWebhook],
      expectedDocument
    ).status,
    "mismatch"
  );
  assert.equal(
    compareDataCreditoVeriffIdentityEvidence(
      {
        ...decision,
        documents: [{ number: expectedDocument, type: "PASSPORT", country: "CO" }],
      },
      expectedDocument
    ).status,
    "invalid-document-type"
  );
  assert.equal(
    compareDataCreditoVeriffIdentityEvidence(
      {
        ...decision,
        documents: [{ number: expectedDocument, type: "ID_CARD", country: "US" }],
      },
      expectedDocument
    ).status,
    "invalid-document-country"
  );
});

test("el cierre DataCrédito rechaza la identidad facial ausente, inválida o diferente antes del claim", () => {
  const strictRouteGuard = sourceBlock(
    creditRoute,
    "const decisionIdentity = extractVeriffIdentityData(",
    "      } else {"
  );

  assert.match(strictRouteGuard, /veriffValidation\.decisionPayload/);
  assert.match(strictRouteGuard, /veriffValidation\.webhookPayload/);
  assert.match(
    strictRouteGuard,
    /compareDataCreditoVeriffIdentityEvidence/
  );
  assert.match(
    strictRouteGuard,
    /getDataCreditoVeriffIdentityRejectionCode/
  );
  assert.match(strictRouteGuard, /DATACREDITO_VERIFF_SOLICITUD_MISMATCH/);
  assert.match(strictRouteGuard, /DATACREDITO_VERIFF_ALREADY_LINKED/);
  assert.doesNotMatch(strictRouteGuard, /veriffValidation\.clienteDocumento/);
  assert.ok(
    creditRoute.indexOf("compareDataCreditoVeriffIdentityEvidence(") <
      creditRoute.indexOf("claimDataCreditoAssessment("),
    "La cédula debe rechazarse antes de reclamar o consumir la consulta DataCrédito"
  );
});

test("la fábrica bloquea navegación, autocompletado y creación cuando las cédulas no coinciden", () => {
  const unlockGuard = sourceBlock(
    factoryConsole,
    "function veriffApprovalCanUnlockClient",
    "function getDataCreditoVeriffDocumentRejectionMessage"
  );

  assert.match(unlockGuard, /compareStrictIdentityDocuments/);
  assert.match(
    factoryConsole,
    /targetStep > 1 && dataCreditoVeriffDocumentRejected/
  );
  assert.match(
    factoryConsole,
    /if \(dataCreditoVeriffDocumentRejected\) \{[\s\S]*?return null;/
  );
  assert.match(factoryConsole, /Crédito rechazado/);
  assert.match(
    factoryConsole,
    /La cédula de la validación facial no coincide con la cédula consultada en DataCrédito/
  );
});

test("la respuesta pública de Veriff expone el resultado integral sin alterar identityData legado", () => {
  const serializer = sourceBlock(
    veriffStorage,
    "const decisionIdentity = extractVeriffIdentityData(row.decisionPayload)",
    "  return {"
  );

  assert.match(serializer, /const identityData = decisionIdentity \|\| webhookIdentity/);
  assert.match(serializer, /compareDataCreditoVeriffIdentityEvidence/);
  assert.match(veriffStorage, /identityDocumentStatus/);
  assert.match(veriffStorage, /identityDocumentNumber/);
  assert.match(veriffStorage, /identityData: serialized\?\.identityData \|\| null/);
});

test("un conflicto documental cierra la solicitud DataCrédito y bloquea nuevos intentos", () => {
  const identityEnforcement = sourceBlock(
    veriffRetryPolicy,
    "  if (row?.draftId) {",
    "    serialized?.status === \"DECLINED\" &&"
  );

  assert.match(veriffRetryPolicy, /rejectVeriffDraftForIdentityFailure/);
  assert.match(veriffRetryPolicy, /SET "estado" = 'CERRADO'/);
  assert.match(veriffRetryPolicy, /"closedReason" = 'RECHAZADA'/);
  assert.match(veriffRetryPolicy, /UPDATE "DataCreditoAssessment"/);
  assert.match(veriffRetryPolicy, /"expiresAt" = LEAST/);
  assert.match(
    veriffRetryPolicy,
    /NULLIF\("payload"->>'dataCreditoAssessmentId', ''\)/
  );
  assert.match(veriffRetryPolicy, /identityComparison\.status !== "missing"/);
  assert.match(veriffRetryPolicy, /veriffIdentityRejectionCode/);
  assert.match(veriffRetryPolicy, /applicationRejected: true/);
  assert.match(creditRoute, /SOLICITUD_DATACREDITO_NO_VINCULADA/);
  assert.match(identityEnforcement, /compareDataCreditoVeriffIdentityEvidence/);
  assert.doesNotMatch(identityEnforcement, /serialized\?\.approved/);
});

test("los estados finales contradictorios de Veriff fallan de forma conservadora", () => {
  const declinedConflict = resolveVeriffStatusEvidence([
    "APPROVED",
    "DECLINED",
  ]);
  const errorConflict = resolveVeriffStatusEvidence(["ERROR", "APPROVED"]);
  const approvedWithPending = resolveVeriffStatusEvidence([
    "APPROVED",
    "PENDING",
  ]);
  const approvedWithReview = resolveVeriffStatusEvidence([
    "APPROVED",
    "REVIEW",
  ]);
  const approvedWithResubmission = resolveVeriffStatusEvidence([
    "APPROVED",
    "RESUBMISSION",
  ]);

  assert.equal(declinedConflict.status, "DECLINED");
  assert.equal(declinedConflict.conflict, true);
  assert.equal(errorConflict.status, "ERROR");
  assert.equal(errorConflict.conflict, true);
  assert.equal(approvedWithPending.status, "APPROVED");
  assert.equal(approvedWithPending.conflict, false);
  assert.equal(approvedWithReview.status, "REVIEW");
  assert.equal(approvedWithReview.conflict, true);
  assert.equal(approvedWithResubmission.status, "RESUBMISSION");
  assert.equal(approvedWithResubmission.conflict, true);
  assert.match(veriffStorage, /resolveVeriffStatusEvidence/);
  assert.match(
    veriffRetryPolicy,
    /serialized\?\.status === "DECLINED"[\s\S]*?UPDATE "VeriffIdentityValidation"/
  );
});

test("un APPROVED parcial sigue consultando hasta recibir el documento", () => {
  assert.match(
    factoryConsole,
    /validation\.identityDocumentStatus === "missing"\) \{\s*return "";/
  );
  assert.match(factoryConsole, /const veriffIdentityEvidencePending = Boolean/);
  assert.match(
    factoryConsole,
    /veriffValidation\?\.approved && !veriffIdentityEvidencePending/
  );
  assert.match(
    factoryConsole,
    /veriffRefreshing \|\|\s*veriffIdentityEvidencePending/
  );
});

test("todos los caminos persisten los mismos códigos de rechazo documental", () => {
  assert.equal(
    getDataCreditoVeriffIdentityRejectionCode("missing"),
    "DATACREDITO_VERIFF_DOCUMENT_MISSING"
  );
  assert.equal(
    getDataCreditoVeriffIdentityRejectionCode("invalid-format"),
    "DATACREDITO_VERIFF_DOCUMENT_INVALID"
  );
  assert.equal(
    getDataCreditoVeriffIdentityRejectionCode("mismatch"),
    "DATACREDITO_VERIFF_DOCUMENT_MISMATCH"
  );
  assert.equal(
    getDataCreditoVeriffIdentityRejectionCode("invalid-document-type"),
    "DATACREDITO_VERIFF_DOCUMENT_TYPE_INVALID"
  );
  assert.equal(
    getDataCreditoVeriffIdentityRejectionCode("invalid-document-country"),
    "DATACREDITO_VERIFF_DOCUMENT_COUNTRY_INVALID"
  );
  assert.match(veriffRetryPolicy, /getDataCreditoVeriffIdentityRejectionCode/);
  assert.match(creditRoute, /getDataCreditoVeriffIdentityRejectionCode/);
});
