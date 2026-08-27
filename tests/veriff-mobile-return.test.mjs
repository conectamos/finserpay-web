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
  shouldPreserveVeriffStatusTransition,
  summarizeVeriffRisk,
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
const veriffStatusRoute = readFileSync(
  new URL("../app/api/creditos/veriff/[id]/route.ts", import.meta.url),
  "utf8"
);
const globalStyles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8"
);
const draftRoute = readFileSync(
  new URL("../app/api/creditos/borradores/route.ts", import.meta.url),
  "utf8"
);
const solicitudesStorage = readFileSync(
  new URL("../lib/solicitudes-storage.ts", import.meta.url),
  "utf8"
);
const iphoneEnrollmentStorage = readFileSync(
  new URL("../lib/iphone-enrollment-storage.ts", import.meta.url),
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

  const physicalDocumentSerial = extractVeriffIdentityDocumentEvidence({
    verification: {
      person: { idNumber: expectedDocument, firstName: "Ana" },
      document: { number: "9999999999", type: "ID_CARD", country: "CO" },
    },
  });
  assert.equal(
    compareDataCreditoVeriffIdentityEvidence(
      physicalDocumentSerial,
      expectedDocument
    ).status,
    "match"
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

  for (const incompleteDocument of [
    { number: "SERIAL-A9X-123", type: null, country: "CO" },
    { number: "SERIAL-A9X-123", type: "ID_CARD", country: null },
  ]) {
    assert.equal(
      compareDataCreditoVeriffIdentityEvidence(
        {
          personNumbers: [expectedDocument],
          documents: [incompleteDocument],
        },
        expectedDocument
      ).status,
      "missing"
    );
  }

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

test("la evidencia separa conflictos técnicos de una identidad distinta consistente", () => {
  const expectedDocument = "1110178524";
  const decision = extractVeriffIdentityDocumentEvidence({
    verification: {
      person: { idNumber: expectedDocument, firstName: "Ana" },
      document: { number: expectedDocument, type: "ID_CARD", country: "COL" },
    },
  });
  const conflictingWebhook = extractVeriffIdentityDocumentEvidence({
    verification: {
      person: { idNumber: "9999999999", firstName: "Ana" },
      document: { number: "9999999999", type: "ID_CARD", country: "CO" },
    },
  });

  assert.equal(
    compareDataCreditoVeriffIdentityEvidence(
      [decision, conflictingWebhook],
      expectedDocument
    ).status,
    "conflict"
  );
  const consistentOtherIdentity = {
    personNumbers: ["9999999999"],
    documents: [
      { number: "9999999999", type: "ID_CARD", country: "CO" },
    ],
  };
  assert.deepEqual(
    compareDataCreditoVeriffIdentityEvidence(
      consistentOtherIdentity,
      expectedDocument
    ),
    {
      ok: false,
      status: "mismatch",
      documentNumber: "9999999999",
    }
  );
  assert.equal(
    compareDataCreditoVeriffIdentityEvidence(
      { personNumbers: ["9999999999"], documents: [] },
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

test("una CC autoritativa de 10 dígitos coincide aunque document traiga un serial físico", () => {
  const expectedDocument = "1234567890";
  const evidence = extractVeriffIdentityDocumentEvidence({
    verification: {
      status: "approved",
      person: { idNumber: expectedDocument },
      document: {
        number: "SERIAL-A9X-123",
        type: "ID_CARD",
        country: "CO",
      },
    },
  });

  assert.deepEqual(
    compareDataCreditoVeriffIdentityEvidence(evidence, expectedDocument),
    { ok: true, status: "match", documentNumber: expectedDocument }
  );
});

test("el cierre deja missing/conflict reintentables y solo rechaza identidad inválida o diferente antes del claim", () => {
  const strictRouteGuard = sourceBlock(
    creditRoute,
    "const decisionIdentity = extractVeriffIdentityData(",
    "      } else {"
  );
  const retryableIdentityBranch = sourceBlock(
    creditRoute,
    'if (\n              identityComparison.status === "conflict"',
    "            const rejectionMessage ="
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
  assert.match(retryableIdentityBranch, /identityComparison\.status === "missing"/);
  assert.match(retryableIdentityBranch, /retryable: true/);
  assert.doesNotMatch(
    retryableIdentityBranch,
    /rejectVeriffDraftForIdentityFailure/
  );
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

test("solo un fallo duro del intento vigente cierra la solicitud DataCrédito", () => {
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
  assert.match(veriffRetryPolicy, /identityComparison\.status !== "conflict"/);
  assert.match(
    veriffRetryPolicy,
    /SELECT MAX\(validation\."id"\)[\s\S]*?WHERE validation\."draftId" = \$1/
  );
  assert.match(veriffRetryPolicy, /veriffIdentityRejectionCode/);
  assert.match(veriffRetryPolicy, /applicationRejected: true/);
  assert.match(creditRoute, /SOLICITUD_DATACREDITO_NO_VINCULADA/);
  assert.match(identityEnforcement, /compareDataCreditoVeriffIdentityEvidence/);
  assert.doesNotMatch(identityEnforcement, /serialized\?\.approved/);
});

test("conflict y missing devuelven 409 reintentable sin llamar al rechazo", () => {
  const identityGuard = sourceBlock(
    creditRoute,
    "if (!identityComparison.ok) {",
    "            const rejectionMessage ="
  );

  assert.match(
    identityGuard,
    /identityComparison\.status === "conflict"[\s\S]*?identityComparison\.status === "missing"/
  );
  assert.match(identityGuard, /retryable: true/);
  assert.doesNotMatch(identityGuard, /rejectVeriffDraftForIdentityFailure/);
  assert.match(
    creditRoute,
    /const applicationRejected = await rejectVeriffDraftForIdentityFailure\([\s\S]*?if \(!applicationRejected\) \{[\s\S]*?DATACREDITO_VERIFF_STATE_CHANGED[\s\S]*?retryable: true/
  );
  assert.ok(
    creditRoute.indexOf("identityComparison.status === \"conflict\"") <
      creditRoute.indexOf("await rejectVeriffDraftForIdentityFailure(")
  );
});

test("la UI muestra conflicto o evidencia incompleta en ámbar y permite repetir", () => {
  assert.match(factoryConsole, /veriffTechnicalRetryRequired/);
  assert.match(factoryConsole, /Conflicto técnico/);
  assert.match(factoryConsole, /Evidencia incompleta/);
  assert.match(factoryConsole, /Repetir validación/);
  assert.match(factoryConsole, /La solicitud no fue rechazada y conserva la consulta DataCrédito/);
  assert.match(globalStyles, /\.fp-veriff-status\.is-conflict/);
  assert.match(globalStyles, /\.fp-veriff-status\.is-incomplete/);
  assert.match(globalStyles, /background: var\(--fp-amber-soft\)/);
  assert.match(globalStyles, /color: var\(--fp-amber\)/);
});

test("un webhook tardío no vuelve canónico un intento Veriff superado", () => {
  for (const source of [draftRoute, solicitudesStorage, iphoneEnrollmentStorage]) {
    assert.match(source, /ORDER BY validation\."id" DESC/);
  }
  assert.match(
    creditRoute,
    /DATACREDITO_VERIFF_ATTEMPT_SUPERSEDED/
  );
  assert.match(
    creditRoute,
    /SELECT validation\."id"[\s\S]*?ORDER BY validation\."id" DESC/
  );
  assert.match(
    veriffRetryPolicy,
    /AND \$3 = \([\s\S]*?SELECT MAX\(validation\."id"\)/
  );
});

test("una decisión vinculada queda congelada y los eventos tardíos son auditables", () => {
  assert.match(veriffStorage, /CREATE TABLE IF NOT EXISTS "VeriffIdentityValidationEvent"/);
  assert.match(veriffStorage, /"eventKey" VARCHAR\(64\) NOT NULL UNIQUE/);
  assert.match(veriffStorage, /createHash\("sha256"\)/);
  assert.match(veriffStorage, /redactVeriffPayload\(payload\)/);
  assert.match(veriffStorage, /ON CONFLICT \("eventKey"\) DO NOTHING/);
  assert.equal(
    summarizeVeriffRisk({ verification: { highRisk: true } }).blocked,
    true
  );
  assert.match(veriffStorage, /incomingRisk\.blocked/);
  assert.match(
    veriffStorage,
    /if \(current\.creditoId \|\| preserveCanonicalStatus\) \{[\s\S]*?VERIFF_POST_LINK_REVIEW_ERROR[\s\S]*?return reviewRows\[0\] \|\| current;/
  );
  assert.match(
    veriffStorage,
    /WHERE "id" = \$1[\s\S]*?AND "creditoId" IS NULL[\s\S]*?RETURNING \*/
  );
  assert.match(
    veriffStatusRoute,
    /if \(current\.creditoId\) \{[\s\S]*?serializeVeriffValidation\(current\)[\s\S]*?getVeriffRetryPolicy/
  );
});

test("crear QR y cerrar crédito se serializan por solicitud sin duplicar intentos", () => {
  const transactionalClose = sourceBlock(
    creditRoute,
    "const createCreditWithAmortization = async",
    "    let creationResult;"
  );

  assert.match(veriffStorage, /pg_advisory_xact_lock\(\$1, \$2\)/);
  assert.match(
    veriffStorage,
    /database\.\$executeRawUnsafe\(\s*`SELECT pg_advisory_xact_lock/
  );
  assert.doesNotMatch(
    veriffStorage,
    /database\.\$queryRawUnsafe\(\s*`SELECT pg_advisory_xact_lock/
  );
  assert.match(
    veriffStorage,
    /lockVeriffDraftAttempts\(transaction, input\.draftId\)/
  );
  assert.match(
    veriffStorage,
    /validation\."veriffSessionId" IS NOT NULL[\s\S]*?validation\."createPayload" IS NOT NULL[\s\S]*?INTERVAL '24 hours'[\s\S]*?validation\."veriffSessionId" IS NULL[\s\S]*?validation\."createPayload" IS NULL[\s\S]*?INTERVAL '2 minutes'/
  );
  assert.match(
    veriffStorage,
    /SELECT MAX\(latest\."id"\)[\s\S]*?WHERE latest\."draftId" = \$1/
  );
  assert.equal(
    [...veriffStorage.matchAll(/SELECT MAX\(latest\."id"\)/g)].length,
    2,
    "la reserva interna y la consulta rápida solo pueden reutilizar el intento más reciente"
  );
  assert.match(
    veriffRoute,
    /if \(!validationReservation\.created\)[\s\S]*?VERIFF_SESSION_PREPARING[\s\S]*?retryable: true/
  );
  assert.match(
    creditRoute,
    /lockVeriffDraftAttempts\(transaction, solicitudReservation\.id\);[\s\S]*?ORDER BY validation\."id" DESC/
  );
  assert.match(
    transactionalClose,
    /SELECT validation\.\*[\s\S]*?FOR UPDATE/
  );
  assert.match(transactionalClose, /isVeriffApproved\(lockedVeriffValidation\)/);
  assert.match(transactionalClose, /summarizeVeriffRisk\(/);
  assert.match(
    creditRoute,
    /lockedIdentityComparison[\s\S]*?getDataCreditoVeriffIdentityRejectionCode/
  );
  assert.ok(
    transactionalClose.indexOf("linkVeriffValidationToCredit(") <
      transactionalClose.indexOf("completeSolicitudForCredit("),
    "Veriff debe quedar vinculado dentro de la misma transacción antes de cerrar la solicitud"
  );
  assert.match(veriffStorage, /AND "creditoId" IS NULL/);
});

test("un DECLINED tardío de un intento superado no consume reintentos", () => {
  assert.match(
    veriffRetryPolicy,
    /newer\."id" > declined\."id"[\s\S]*?newer\."createdAt" < COALESCE\([\s\S]*?declined\."decidedAt"[\s\S]*?declined\."updatedAt"/
  );
  assert.match(
    veriffRetryPolicy,
    /AND \$3 = \([\s\S]*?SELECT MAX\(validation\."id"\)/
  );
  assert.ok(
    (veriffRetryPolicy.match(/lockVeriffDraftAttempts\(transaction, row\.draftId!\)/g) || [])
      .length >= 2,
    "rechazo de identidad y agotamiento deben compartir el lock con la creación de QR"
  );
  assert.match(
    veriffRetryPolicy,
    /if \(!applicationRejected\) \{[\s\S]*?return getVeriffRetryPolicy\(row\.draftId\)/
  );
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
  assert.equal(
    shouldPreserveVeriffStatusTransition(
      "DECLINED",
      "APPROVED",
      "webhookPayload"
    ),
    true,
    "un APPROVED tardío no puede sobrescribir un DECLINED canónico"
  );
  assert.equal(
    shouldPreserveVeriffStatusTransition(
      "ERROR",
      "APPROVED",
      "decisionPayload"
    ),
    true
  );
  assert.equal(
    shouldPreserveVeriffStatusTransition(
      "REVIEW",
      "APPROVED",
      "webhookPayload"
    ),
    true,
    "un APPROVED tardío del webhook no puede sacar la sesión de REVIEW"
  );
  assert.equal(
    shouldPreserveVeriffStatusTransition(
      "RESUBMISSION",
      "APPROVED",
      "webhookPayload"
    ),
    true,
    "un APPROVED tardío del webhook no puede sacar la sesión de RESUBMISSION"
  );
  assert.equal(
    shouldPreserveVeriffStatusTransition(
      "REVIEW",
      "APPROVED",
      "decisionPayload"
    ),
    false,
    "la consulta actual del proveedor sí puede resolver REVIEW como APPROVED"
  );
  assert.match(
    veriffStorage,
    /resolvesActiveBlockWithCurrentDecision[\s\S]*?source === "decisionPayload"[\s\S]*?currentStatus === "REVIEW"[\s\S]*?summary\.status === "APPROVED"/
  );
  assert.match(
    veriffStorage,
    /clearWebhookPayload: resolvesActiveBlockWithCurrentDecision/
  );
  assert.match(
    veriffStorage,
    /WHEN \$17::boolean THEN NULL[\s\S]*?ELSE COALESCE\(\$13::jsonb, "webhookPayload"\)/
  );
  assert.equal(
    shouldPreserveVeriffStatusTransition(
      "PENDING",
      "APPROVED",
      "webhookPayload"
    ),
    false,
    "PENDING debe poder avanzar a APPROVED desde cualquier fuente"
  );
  assert.match(veriffStorage, /resolveVeriffStatusEvidence/);
  assert.match(
    veriffStorage,
    /preserveCanonicalStatus[\s\S]*?VERIFF_DECISION_ORDER_REVIEW_ERROR/
  );
  assert.match(
    veriffStorage,
    /statusEvidence\.conflict[\s\S]*?incomingRisk\.blocked/
  );
  assert.match(
    veriffRetryPolicy,
    /serialized\?\.status === "DECLINED"[\s\S]*?UPDATE "VeriffIdentityValidation"[\s\S]*?AND "creditoId" IS NULL/
  );
});

test("un APPROVED sin evidencia no desbloquea y ofrece repetir la validación", () => {
  assert.match(
    factoryConsole,
    /validation\.identityDocumentStatus === "missing"\) \{\s*return "";/
  );
  assert.match(factoryConsole, /const veriffIdentityEvidencePending = Boolean/);
  assert.match(factoryConsole, /veriffIdentityEvidenceMissing/);
  assert.match(factoryConsole, /veriffTechnicalRetryRequired/);
  assert.match(factoryConsole, /VERIFF_IDENTITY_MISSING_MESSAGE/);
  assert.match(factoryConsole, /Repetir validación/);
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
    getDataCreditoVeriffIdentityRejectionCode("conflict"),
    "DATACREDITO_VERIFF_DOCUMENT_CONFLICT"
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
