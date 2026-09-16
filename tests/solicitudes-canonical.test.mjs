import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SolicitudCanonicalMutationError,
  resolveSolicitudDraftCanonicalIdentity,
} from "../lib/solicitudes.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontro ${start}`);
  assert.notEqual(endIndex, -1, `No se encontro ${end}`);
  return source.slice(startIndex, endIndex);
}

test("solo la reserva de identidad materializa una solicitud nueva", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const reservation = sourceBetween(
    source,
    "export async function reserveSolicitudForIdentity",
    "export async function saveSolicitudDraft"
  );
  const autosave = sourceBetween(
    source,
    "export async function saveSolicitudDraft",
    "export async function attachDataCreditoToSolicitud"
  );

  assert.match(reservation, /INSERT INTO "CreditoBorrador"/);
  assert.doesNotMatch(autosave, /INSERT INTO "CreditoBorrador"/);
  assert.match(autosave, /SOLICITUD_REQUIERE_CONSULTA_DATACREDITO/);
  assert.match(autosave, /targetId = conflicting\.id/);
});

test("la propiedad canonica exige el mismo asesor y la misma sede", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const ownership = sourceBetween(
    source,
    "function sameOwner",
    "async function lockIdentity"
  );

  assert.match(
    ownership,
    /row\.vendedorId === input\.vendedorId\s*&&\s*row\.sedeId === input\.sedeId/
  );
  assert.match(
    ownership,
    /row\.vendedorId === null\s*&&\s*row\.usuarioId === input\.usuarioId\s*&&\s*row\.sedeId === input\.sedeId/
  );
  assert.doesNotMatch(
    ownership,
    /if \(input\.vendedorId\) return row\.vendedorId === input\.vendedorId;/
  );
});

test("la retoma canonica solo expone un conflicto propio, del mismo documento y de mayor prioridad", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const autosave = sourceBetween(
    source,
    "export async function saveSolicitudDraft",
    "export async function attachDataCreditoToSolicitud"
  );
  const identityConflict = sourceBetween(
    autosave,
    "if (mustCheckIdentity) {",
    "const incomingAssessmentId ="
  );
  const resumeGuard = sourceBetween(
    identityConflict,
    "const canResumeConflict = Boolean(",
    ");"
  );

  assert.match(resumeGuard, /targetId\s*&&\s*targetRow\s*&&\s*documentToLock/);
  assert.match(resumeGuard, /targetDocument === documentToLock/);
  assert.match(resumeGuard, /conflictingDocument === documentToLock/);
  assert.match(resumeGuard, /sameOwner\(conflicting, input\)/);
  assert.match(
    resumeGuard,
    /compareActiveSolicitudDraftPriority\(conflicting, targetRow\) > 0/
  );
  assert.doesNotMatch(resumeGuard, /imei/);
  assert.match(
    identityConflict,
    /new ActiveSolicitudConflictError\(\s*undefined,\s*canResumeConflict \? conflicting\.id : null\s*\)/
  );
  assert.equal(
    (identityConflict.match(/canResumeConflict \? conflicting\.id : null/g) || [])
      .length,
    1,
    "el id canónico no debe exponerse por una ruta alternativa"
  );
});

test("el id de retoma solo acepta identificadores positivos y seguros", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const conflictError = sourceBetween(
    source,
    "export class ActiveSolicitudConflictError",
    "let solicitudSchemaPromise"
  );

  assert.match(conflictError, /readonly resumeSolicitudId: number \| null/);
  assert.match(conflictError, /resumeSolicitudId: number \| null = null/);
  assert.match(conflictError, /Number\.isSafeInteger\(resumeSolicitudId\)/);
  assert.match(conflictError, /Number\(resumeSolicitudId\) > 0/);
  assert.match(conflictError, /:\s*null/);
});

test("la conciliacion limita propietario, aliado, prioridad y evidencia", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const reconciliation = sourceBetween(
    source,
    "async function supersedeLowerPrioritySameOwnerDrafts",
    "type FirmaSeguroDraftTermsRow"
  );

  assert.match(reconciliation, /"closedReason" = 'DUPLICADA'/);
  assert.match(reconciliation, /'supersededBySolicitudId'/);
  assert.match(reconciliation, /'supersededByUserId'/);
  assert.match(reconciliation, /'supersededBySellerId'/);
  assert.match(
    reconciliation,
    /duplicate_sede\."aliadoId" = target_sede\."aliadoId"/
  );
  assert.match(
    reconciliation,
    /duplicate_draft\."vendedorId" = target_draft\."vendedorId"[\s\S]*duplicate_draft\."usuarioId" = target_draft\."usuarioId"[\s\S]*duplicate_draft\."sedeId" = target_draft\."sedeId"/
  );
  assert.match(
    reconciliation,
    /duplicate_draft\."currentStep"[\s\S]*target_draft\."currentStep"[\s\S]*duplicate_draft\."createdAt" < target_draft\."createdAt"[\s\S]*duplicate_draft\."id" < target_draft\."id"/
  );
  assert.match(reconciliation, /target_draft\."dataCreditoAssessmentId" IS NOT NULL/);
  assert.match(reconciliation, /duplicate_draft\."dataCreditoAssessmentId" IS NOT NULL/);
  assert.match(reconciliation, /FROM "VeriffIdentityValidation"/);
  assert.match(reconciliation, /FROM "FirmaSeguroProcess"/);
  assert.doesNotMatch(reconciliation, /process\."supersededAt" IS NULL/);
});

test("la conciliacion descarta solo reservas Veriff tecnicas sin evidencia remota", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const reconciliation = sourceBetween(
    source,
    "async function supersedeLowerPrioritySameOwnerDrafts",
    "type FirmaSeguroDraftTermsRow"
  );
  const veriffGuard = sourceBetween(
    reconciliation,
    'FROM "VeriffIdentityValidation" validation',
    'FROM "FirmaSeguroProcess" process'
  );

  assert.match(
    veriffGuard,
    /COALESCE\(UPPER\(BTRIM\(validation\."status"\)\), ''\) NOT IN \(\s*'ERROR',\s*'ABANDONED',\s*'EXPIRED',\s*'PENDING'\s*\)/
  );
  const evidenceColumns = [
    'validation."creditoId" IS NOT NULL',
    'NULLIF(BTRIM(validation."veriffSessionId"), \'\') IS NOT NULL',
    'NULLIF(BTRIM(validation."attemptId"), \'\') IS NOT NULL',
    'validation."createPayload" IS NOT NULL',
    'validation."mediaPayload" IS NOT NULL',
    'validation."submitPayload" IS NOT NULL',
    'validation."decisionPayload" IS NOT NULL',
    'validation."webhookPayload" IS NOT NULL',
    'validation."submittedAt" IS NOT NULL',
    'validation."decidedAt" IS NOT NULL',
    'NULLIF(BTRIM(validation."decision"), \'\') IS NOT NULL',
    'NULLIF(BTRIM(validation."code"), \'\') IS NOT NULL',
    'NULLIF(BTRIM(validation."reason"), \'\') IS NOT NULL',
    'NULLIF(BTRIM(validation."reasonCode"), \'\') IS NOT NULL',
  ];
  for (const evidenceColumn of evidenceColumns) {
    assert.ok(
      veriffGuard.includes(`OR ${evidenceColumn}`),
      `La evidencia ${evidenceColumn} debe conservar la solicitud`
    );
  }
  assert.doesNotMatch(
    veriffGuard,
    /NOT IN \([\s\S]*'(?:APPROVED|DECLINED|REVIEW|RESUBMISSION)'/
  );
  assert.doesNotMatch(veriffGuard, /UPDATE "VeriffIdentityValidation"/);
});

test("la conciliacion conserva cualquier proceso de FirmaSeguro", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const reconciliation = sourceBetween(
    source,
    "async function supersedeLowerPrioritySameOwnerDrafts",
    "type FirmaSeguroDraftTermsRow"
  );

  assert.match(
    reconciliation,
    /AND NOT EXISTS \(\s*SELECT 1\s*FROM "FirmaSeguroProcess" process\s*WHERE process\."draftId" = duplicate_draft\."id"\s*\)/
  );
  assert.doesNotMatch(reconciliation, /process\."status"/);
  assert.doesNotMatch(reconciliation, /process\."supersededAt"/);
});

test("la conciliacion se ejecuta solo en autosave y respeta locks operativos", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const reconciliation = sourceBetween(
    source,
    "async function supersedeLowerPrioritySameOwnerDrafts",
    "type FirmaSeguroDraftTermsRow"
  );
  const reservation = sourceBetween(
    source,
    "export async function reserveSolicitudForIdentity",
    "export async function saveSolicitudDraft"
  );
  const autosave = sourceBetween(
    source,
    "export async function saveSolicitudDraft",
    "export class SolicitudDataCreditoLinkError"
  );

  assert.match(reconciliation, /ORDER BY duplicate_draft\."id" ASC/);
  assert.match(reconciliation, /pg_try_advisory_xact_lock/);
  assert.match(reconciliation, /SOLICITUD_OPERATION_LOCK_NAMESPACE/);
  assert.ok(
    reconciliation.indexOf("pg_try_advisory_xact_lock") <
      reconciliation.indexOf('UPDATE "CreditoBorrador" duplicate_draft')
  );
  assert.doesNotMatch(reservation, /supersedeLowerPrioritySameOwnerDrafts/);

  const operationLock = autosave.indexOf("await lockSolicitudOperationMutation");
  const targetSelect = autosave.indexOf("LIMIT 1 FOR UPDATE", operationLock);
  const ownerRecheck = autosave.indexOf(
    "!rows[0] || !sameOwner(rows[0], input)",
    targetSelect
  );
  const autosaveReconcile = autosave.indexOf(
    "await supersedeLowerPrioritySameOwnerDrafts",
    ownerRecheck
  );
  const autosaveConflictCheck = autosave.indexOf(
    "const conflicting = await findActiveByIdentity",
    autosaveReconcile
  );
  assert.equal(
    (autosave.match(/await supersedeLowerPrioritySameOwnerDrafts/g) || []).length,
    1
  );
  assert.ok(operationLock >= 0);
  assert.ok(targetSelect > operationLock);
  assert.ok(ownerRecheck > targetSelect);
  assert.ok(autosaveReconcile > ownerRecheck);
  assert.ok(autosaveConflictCheck > autosaveReconcile);
  assert.match(autosave, /findActiveByIdentity\(\s*transaction,\s*documentToLock,/);
});

test("los fantasmas historicos sin DataCredito no bloquean una identidad", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const finder = sourceBetween(
    source,
    "async function findActiveByIdentity",
    "export async function reserveSolicitudForIdentity"
  );

  assert.match(finder, /"dataCreditoAssessmentId" IS NOT NULL/);
  assert.match(
    finder,
    /UPPER\(COALESCE\("payload"->>'solicitudOrigen', ''\)\) = 'DATACREDITO'/
  );
  assert.match(
    finder,
    /NULLIF\("payload"->>'dataCreditoStatus', ''\) IS NOT NULL/
  );
  assert.match(
    finder,
    /NULLIF\("payload"->>'dataCreditoAssessmentId', ''\) IS NOT NULL/
  );

  const materializedPredicate = finder.indexOf(
    '"dataCreditoAssessmentId" IS NOT NULL'
  );
  const identityPredicate = finder.indexOf(
    "regexp_replace(COALESCE(\"clienteDocumento\", ''), '[^0-9]', '', 'g') = $1"
  );
  assert.ok(materializedPredicate >= 0);
  assert.ok(identityPredicate > materializedPredicate);
});

test("el muro usa columnas livianas de DataCredito y no abre el payload de cada borrador", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const draftQuery = sourceBetween(
    source,
    "async function readDraftRows",
    "async function readCreditRows"
  );

  assert.match(
    draftQuery,
    /d\."dataCreditoAssessmentId" IS NOT NULL[\s\S]*?OR NULLIF\(d\."dataCreditoStatus", ''\) IS NOT NULL/
  );
  assert.match(
    draftQuery,
    /COALESCE\(dc\."status", NULLIF\(d\."dataCreditoStatus", ''\)\) AS "dataCreditoStatus"/
  );
  assert.match(
    draftQuery,
    /COALESCE\(dc\."errorCode", NULLIF\(d\."dataCreditoErrorCode", ''\)\) AS "dataCreditoErrorCode"/
  );
  assert.match(
    draftQuery,
    /WHERE assessment\."id" = d\."dataCreditoAssessmentId"/
  );
  assert.doesNotMatch(draftQuery, /assessment\."id"::text/);
  assert.doesNotMatch(draftQuery, /d\."payload"/);
  assert.match(source, /solicitudOrigen: "DATACREDITO"/);
  assert.match(source, /dataCreditoStatus: "PENDING"/);
  assert.match(source, /markSolicitudDataCreditoTechnicalError/);
  assert.match(
    source,
    /markSolicitudDataCreditoTechnicalError[\s\S]*?"dataCreditoStatus" = 'NO_EVALUADO'[\s\S]*?"dataCreditoErrorCode" = \$3::text/
  );
});

test("las salidas tecnicas posteriores a la reserva permanecen visibles y gestionables", async () => {
  const route = await readProjectFile(
    "app/api/creditos/datacredito/evaluaciones/route.ts"
  );
  const reservation = route.indexOf(
    "const solicitudReservation = await reserveSolicitudForIdentity"
  );
  const trackedResponse = route.indexOf(
    "return solicitudTechnicalResponse",
    reservation
  );

  assert.ok(reservation >= 0);
  assert.ok(trackedResponse > reservation);
  assert.match(route, /markSolicitudDataCreditoTechnicalError/);
  assert.match(route, /errorCode: response\.code/);
});

test("los bloqueos recuperables conservan la solicitud pendiente sin crear ni reemplazar una consulta", async () => {
  const [storage, route] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
  ]);
  const recoverableMark = sourceBetween(
    storage,
    "export async function markSolicitudDataCreditoRecoverablePending",
    "export async function desistSolicitud"
  );
  const branches = [
    sourceBetween(
      route,
      'if (cached?.kind === "IDENTITY_MISMATCH")',
      'if (cached?.kind === "REQUIRES_REVIEW")'
    ),
    sourceBetween(
      route,
      'if (cached?.kind === "IN_PROGRESS")',
      "if (reuseOnly)"
    ),
    sourceBetween(
      route,
      "if (isDataCreditoUniqueViolation(error))",
      "throw error;"
    ),
    sourceBetween(
      route,
      'if (reservation.kind === "IDENTITY_MISMATCH")',
      'if (reservation.kind === "REQUIRES_REVIEW")'
    ),
    sourceBetween(
      route,
      'if (reservation.kind === "IN_PROGRESS")',
      'if (reservation.kind === "RATE_LIMITED")'
    ),
    sourceBetween(
      route,
      'if (reservation.kind === "RATE_LIMITED")',
      "const pending = reservation.assessment"
    ),
  ];

  assert.match(recoverableMark, /'dataCreditoStatus', 'PENDING'/);
  assert.match(recoverableMark, /'dataCreditoErrorCode', \$3::text/);
  assert.match(recoverableMark, /"dataCreditoAssessmentId" IS NULL/);
  assert.match(
    recoverableMark,
    /NULLIF\("payload"->>'dataCreditoAssessmentId', ''\) IS NULL/
  );
  assert.doesNotMatch(recoverableMark, /'dataCreditoStatus', 'NO_EVALUADO'/);
  for (const branch of branches) {
    assert.match(branch, /return solicitudRecoverableResponse\(\{/);
  }

  const rateLimit = branches.at(-1);
  const providerCall = route.indexOf("await queryDataCreditoNaturalPerson({");
  assert.ok(providerCall > route.indexOf(rateLimit));
  assert.doesNotMatch(rateLimit, /queryDataCreditoNaturalPerson/);
});

test("un fallo posterior al inicio del proveedor deja el mismo resultado ambiguo en assessment y solicitud", async () => {
  const route = await readProjectFile(
    "app/api/creditos/datacredito/evaluaciones/route.ts"
  );
  const failureTracking = sourceBetween(
    route,
    "if (pendingAssessmentId) {",
    "} else if (solicitudId && !financialTermsRefreshRequested) {"
  );
  const preDispatchCompensation = sourceBetween(
    failureTracking,
    "if (providerStartedAt === null && dailyQuotaReservation) {",
    "} else {"
  );
  const postDispatchMarker = "} else {";
  const postDispatchStart = failureTracking.indexOf(postDispatchMarker);
  assert.notEqual(postDispatchStart, -1, `No se encontro ${postDispatchMarker}`);
  const postDispatchFailureTracking = failureTracking.slice(postDispatchStart);

  assert.match(
    failureTracking,
    /const trackedErrorCode = providerStartedAt[\s\S]*?"PROVIDER_OUTCOME_AMBIGUOUS"/
  );
  assert.equal(
    (preDispatchCompensation.match(/errorCode: trackedErrorCode/g) || []).length,
    2
  );
  assert.equal(
    (postDispatchFailureTracking.match(/errorCode: trackedErrorCode/g) || []).length,
    3
  );
  assert.doesNotMatch(failureTracking, /errorCode: code/);
});

test("DataCredito nunca confirma un resultado que no pudo vincular al borrador vigente", async () => {
  const [storage, route] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
  ]);
  const attachment = sourceBetween(
    storage,
    "export async function attachDataCreditoToSolicitud",
    "export async function markSolicitudDataCreditoTechnicalError"
  );
  const technicalMark = sourceBetween(
    storage,
    "export async function markSolicitudDataCreditoTechnicalError",
    "export async function desistSolicitud"
  );
  const successAttachment = route.indexOf("await attachDataCreditoToSolicitud({",  route.indexOf("if (!completed)"));
  const successResponse = route.indexOf("ok: true", successAttachment);
  const linkFailureGuard = route.indexOf(
    "error instanceof SolicitudDataCreditoLinkError"
  );

  for (const mutation of [attachment, technicalMark]) {
    assert.match(mutation, /"estado" = 'ABIERTO'/);
    assert.match(mutation, /"creditoId" IS NULL/);
    assert.match(
      mutation,
      /COALESCE\("expiresAt", "createdAt" \+ INTERVAL '15 days'\) >/
    );
    assert.match(mutation, /RETURNING "id"/);
    assert.match(mutation, /rows\.length !== 1/);
    assert.match(mutation, /SolicitudDataCreditoLinkError/);
  }
  assert.ok(successAttachment >= 0);
  assert.ok(successResponse > successAttachment);
  assert.ok(linkFailureGuard >= 0);
  assert.match(route, /code: error\.code[\s\S]{0,100}status: error\.status/);
});

test("la aprobacion enlaza el id canonico antes del autosave", async () => {
  const gate = await readProjectFile(
    "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
  );
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );

  assert.match(gate, /solicitudId: number \| null/);
  assert.match(gate, /readNumber\(payload\.solicitudId\)/);
  assert.match(factory, /deliveryMode \|\|[\s\S]{0,240}!draftId \|\|/);
  assert.match(factory, /setDraftId\(result\.solicitudId\)/);
  assert.match(factory, /replaceDraftInUrl\(result\.solicitudId\)/);
});

test("el autosave preserva documento, apellido y assessment canonicos de solicitudes materializadas", () => {
  const legacyAssessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const result = resolveSolicitudDraftCanonicalIdentity({
    materialized: true,
    storedDocument: "1.083.028.847",
    storedPayloadFirstSurname: "De La Cruz",
    storedAssessmentId: null,
    storedPayloadAssessmentId: legacyAssessmentId,
    incomingDocument: "1083028847",
    incomingFirstSurname: "  de   la cruz ",
    incomingAssessmentId: legacyAssessmentId.toUpperCase(),
    payload: {
      clienteNombre: "Cliente",
      clientePrimerApellido: "  de   la cruz ",
    },
  });

  assert.equal(result.clienteDocumento, "1.083.028.847");
  assert.equal(result.clientePrimerApellido, "De La Cruz");
  assert.equal(result.dataCreditoAssessmentId, legacyAssessmentId);
  assert.equal(result.payload.clienteDocumento, "1.083.028.847");
  assert.equal(result.payload.clientePrimerApellido, "De La Cruz");
  assert.equal(result.payload.dataCreditoAssessmentId, legacyAssessmentId);
  assert.equal(result.payload.clienteNombre, "Cliente");
});

test("el autosave rechaza cambios de cedula, apellido o assessment en solicitudes materializadas", () => {
  const canonicalAssessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const base = {
    materialized: true,
    storedDocument: "1083028847",
    storedPayloadFirstSurname: "Mendoza",
    storedAssessmentId: canonicalAssessmentId,
    payload: {},
  };

  assert.throws(
    () =>
      resolveSolicitudDraftCanonicalIdentity({
        ...base,
        incomingDocument: "1083028848",
        incomingAssessmentId: canonicalAssessmentId,
      }),
    (error) =>
      error instanceof SolicitudCanonicalMutationError &&
      error.code === "SOLICITUD_DOCUMENTO_INMUTABLE" &&
      error.status === 409
  );
  assert.throws(
    () =>
      resolveSolicitudDraftCanonicalIdentity({
        ...base,
        incomingDocument: "1083028847",
        incomingFirstSurname: "Mendoza Rojas",
        incomingAssessmentId: canonicalAssessmentId,
      }),
    (error) =>
      error instanceof SolicitudCanonicalMutationError &&
      error.code === "SOLICITUD_APELLIDO_INMUTABLE" &&
      error.status === 409
  );
  assert.throws(
    () =>
      resolveSolicitudDraftCanonicalIdentity({
        ...base,
        incomingDocument: "1083028847",
        incomingAssessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    (error) =>
      error instanceof SolicitudCanonicalMutationError &&
      error.code === "SOLICITUD_DATACREDITO_INMUTABLE" &&
      error.status === 409
  );
});

test("la restauracion de DataCredito compara cedula y primer apellido antes de mostrar aprobacion", async () => {
  const route = await readProjectFile(
    "app/api/creditos/datacredito/evaluaciones/[id]/route.ts"
  );
  const gate = await readProjectFile(
    "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
  );

  assert.match(route, /buildDataCreditoIdentityHashes/);
  assert.match(route, /identity\.documentHash !== row\.documentHash/);
  assert.match(route, /identity\.surnameHash !== row\.surnameHash/);
  assert.match(route, /ASSESSMENT_IDENTITY_MISMATCH/);
  assert.match(route, /requestedDraft\?\.clientePrimerApellido/);
  assert.match(gate, /assessmentParams\.set\("documentNumber"/);
  assert.match(gate, /assessmentParams\.set\("firstSurname"/);
});

test("la reserva inicial persiste el primer apellido consultado como identidad canonica", async () => {
  const storage = await readProjectFile("lib/solicitudes-storage.ts");
  const evaluationRoute = await readProjectFile(
    "app/api/creditos/datacredito/evaluaciones/route.ts"
  );

  assert.match(storage, /clientePrimerApellido: string;/);
  assert.match(
    storage,
    /clientePrimerApellido: String\(input\.clientePrimerApellido \|\| ""\)/
  );
  assert.match(evaluationRoute, /clientePrimerApellido: firstSurname/);
});

test("una solicitud materializada sin assessment canonico no acepta uno del payload", () => {
  assert.throws(
    () =>
      resolveSolicitudDraftCanonicalIdentity({
        materialized: true,
        storedDocument: "1083028847",
        storedAssessmentId: null,
        storedPayloadAssessmentId: null,
        incomingDocument: "1083028847",
        incomingAssessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        payload: {},
      }),
    (error) =>
      error instanceof SolicitudCanonicalMutationError &&
      error.code === "SOLICITUD_DATACREDITO_INMUTABLE"
  );
});

test("la reserva generica bloquea y el autosave usa la identidad canonica", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const reservation = sourceBetween(
    source,
    "export async function reserveSolicitudForIdentity",
    "export async function saveSolicitudDraft"
  );
  const autosave = sourceBetween(
    source,
    "export async function saveSolicitudDraft",
    "export async function attachDataCreditoToSolicitud"
  );

  assert.match(
    reservation,
    /if \(input\.solicitudId\)[\s\S]*findBlockingSolicitudByDocument\([\s\S]*selected\[0\]\.id[\s\S]*return \{ id: selected\[0\]\.id, reused: true \}/
  );
  assert.match(reservation, /if \(blocker\)[\s\S]*solicitudConflictFromBlocker/);
  assert.doesNotMatch(reservation, /isSolicitudIdentityReleased/);
  assert.match(autosave, /resolveSolicitudDraftCanonicalIdentity/);
  assert.match(autosave, /targetRow\.payload\?\.dataCreditoAssessmentId/);
  assert.match(autosave, /canonical\.clienteDocumento/);
  assert.match(autosave, /canonical\.dataCreditoAssessmentId/);
});

test("cualquier credito o borrador no liberado bloquea globalmente la cedula", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const blocker = sourceBetween(
    source,
    "async function findBlockingSolicitudByDocument",
    "async function findActiveByIdentity"
  );
  const reservation = sourceBetween(
    source,
    "export async function reserveSolicitudForIdentity",
    "export async function saveSolicitudDraft"
  );

  assert.match(blocker, /FROM "CreditoBorrador" draft/);
  assert.match(blocker, /UNION ALL[\s\S]*FROM "Credito" credit/);
  assert.match(
    blocker,
    /NOT \([\s\S]*draft\."estado" = 'CERRADO'[\s\S]*'DESISTIDA'[\s\S]*'EXPIRADA_15_DIAS'[\s\S]*\)/
  );
  assert.match(
    blocker,
    /ORDER BY[\s\S]*candidate\."source" = 'CREDIT'[\s\S]*candidate\."createdAt" DESC/
  );
  assert.doesNotMatch(
    blocker,
    /FROM "Credito" credit[\s\S]*credit\."estado"\s*(?:=|IN)/
  );
  assert.match(reservation, /const blocker = await findBlockingSolicitudByDocument/);
  assert.match(reservation, /if \(blocker\)[\s\S]*solicitudConflictFromBlocker/);
  assert.match(blocker, /new ActiveSolicitudConflictError/);
  assert.match(blocker, /excludedDraftId\?: number \| null/);
  assert.match(blocker, /draft\."id" <> \$2/);
  assert.doesNotMatch(reservation, /isSolicitudIdentityReleased/);
  assert.match(blocker, /debe quedar desistida antes de iniciar otra/);
  assert.doesNotMatch(reservation, /closedReason[^\n]*RECHAZADA[^\n]*INSERT/);
});

test("solo las solicitudes abiertas vencen automaticamente a los 15 dias", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const expiration = sourceBetween(
    source,
    "async function expireStaleWith",
    "export async function expireStaleSolicitudes"
  );

  assert.match(
    expiration,
    /"closedReason" = (?:COALESCE\((?:draft\.)?"closedReason", )?'EXPIRADA_15_DIAS'\)?/
  );
  assert.match(expiration, /WHERE "estado" = 'ABIERTO'/);
  assert.match(expiration, /COALESCE\("expiresAt", "createdAt" \+ INTERVAL '15 days'\)/);
  assert.match(expiration, /WITH stale AS MATERIALIZED/);
  assert.match(expiration, /pg_try_advisory_xact_lock\(\$1::integer, stale\."id"\)/);
  assert.match(expiration, /SOLICITUD_OPERATION_LOCK_NAMESPACE/);
  assert.match(expiration, /RETURNING draft\."id"/);
  assert.doesNotMatch(expiration, /"closedReason"[^\n]*RECHAZADA/);
  assert.doesNotMatch(expiration, /NOT \([\s\S]*'FINALIZADA'/);
});

test("desistir libera de una vez los duplicados no finalizados de la misma cedula", async () => {
  const [source, draftRoute] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/api/creditos/borradores/route.ts"),
  ]);
  const sellerDesist = sourceBetween(
    source,
    "export async function desistSolicitud",
    "export async function desistSolicitudAsCentralAdmin"
  );
  const centralDesist = sourceBetween(
    source,
    "export async function desistSolicitudAsCentralAdmin",
    "export async function completeSolicitudForCredit"
  );

  for (const desist of [sellerDesist, centralDesist]) {
    assert.match(desist, /prisma\.\$transaction/);
    assert.match(
      desist,
      /SELECT (?:draft\.)?"id", (?:draft\.)?"clienteDocumento"[\s\S]*WHERE (?:draft\.)?"id" = \$1/
    );
    assert.match(desist, /const document = normalizeDigits\(target\[0\]\.clienteDocumento\)/);
    const targetScan = desist.indexOf("const operationTargets =");
    const orderedLock = desist.indexOf("await lockSolicitudOperationsInOrder(");
    const identityLock = desist.indexOf(
      'await lockIdentity(transaction, "document", document)'
    );
    const update = desist.indexOf('UPDATE "CreditoBorrador"');
    assert.ok(targetScan >= 0);
    assert.ok(orderedLock > targetScan);
    assert.ok(identityLock > orderedLock);
    assert.ok(update > identityLock);
    assert.match(desist, /ORDER BY (?:draft\.)?"id" ASC/);
    assert.match(desist, /operationTargets\.map\(\(row\) => row\.id\)/);
    assert.match(desist, /lockIdentity\(transaction, "document", document\)/);
    assert.match(desist, /UPDATE "CreditoBorrador"/);
    assert.match(
      desist,
      /regexp_replace\(COALESCE\((?:draft\.)?"clienteDocumento", ''\), '\[\^0-9\]', '', 'g'\) = \$\d/
    );
    assert.match(desist, /"creditoId" IS NULL/);
    assert.match(desist, /"closedReason" = 'DESISTIDA'/);
    assert.match(desist, /'EXPIRADA_15_DIAS'/);
    assert.match(desist, /findBlockingSolicitudByDocument\(transaction, document\)/);
    assert.match(desist, /identityReleased: changed && !blocker/);
  }

  assert.match(
    sellerDesist,
    /draft\."vendedorId" = \$3[\s\S]*SELECT sede\."id" FROM "Sede" sede WHERE sede\."aliadoId" = \$4/
  );
  const centralUpdate = centralDesist.slice(centralDesist.indexOf('UPDATE "CreditoBorrador"'));
  assert.doesNotMatch(centralUpdate, /"vendedorId"\s*=|"sedeId"\s*=/);
  assert.match(draftRoute, /ok: result\.changed/);
  assert.match(draftRoute, /identityReleased: result\.identityReleased/);
  assert.match(draftRoute, /status: result\.changed \? 200 : 409/);
  assert.doesNotMatch(draftRoute, /status: changed \? 200 : 409/);
});

test("la API devuelve 409 y codigo ante una mutacion de identidad canonica", async () => {
  const route = await readProjectFile("app/api/creditos/borradores/route.ts");
  const post = sourceBetween(route, "export async function POST", "export async function PATCH");
  const errorHandling = sourceBetween(post, "} catch (error) {", "const forbidden");

  assert.match(route, /import \{ SolicitudCanonicalMutationError \} from "@\/lib\/solicitudes"/);
  assert.match(errorHandling, /error instanceof SolicitudCanonicalMutationError/);
  assert.match(errorHandling, /error: error\.message/);
  assert.match(errorHandling, /code: error\.code/);
  assert.match(errorHandling, /\{ status: error\.status \}/);
  assert.ok(
    post.indexOf("SolicitudCanonicalMutationError") <
      post.indexOf("const forbidden")
  );
});

test("la API serializa resumeSolicitudId solo para un conflicto activo autorizado", async () => {
  const route = await readProjectFile("app/api/creditos/borradores/route.ts");
  const post = sourceBetween(route, "export async function POST", "export async function PATCH");
  const errorHandling = sourceBetween(post, "} catch (error) {", "const forbidden");

  assert.match(
    errorHandling,
    /\.\.\.\(error instanceof ActiveSolicitudConflictError\s*&&\s*error\.resumeSolicitudId\s*\?\s*\{ resumeSolicitudId: error\.resumeSolicitudId \}\s*:\s*\{\}\)/
  );
  assert.equal(
    (errorHandling.match(/\{ resumeSolicitudId: error\.resumeSolicitudId \}/g) || [])
      .length,
    1
  );
  assert.doesNotMatch(
    errorHandling,
    /error instanceof SolicitudCanonicalMutationError[\s\S]{0,120}\?\s*\{ resumeSolicitudId:/
  );
});

test("el autosave preconsulta responde como conflicto esperado y no como error tecnico", async () => {
  const [route, factory] = await Promise.all([
    readProjectFile("app/api/creditos/borradores/route.ts"),
    readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
  ]);
  const post = sourceBetween(
    route,
    "export async function POST",
    "export async function PATCH"
  );
  const postErrorHandling = sourceBetween(
    post,
    "} catch (error) {",
    "const forbidden"
  );
  const hydrationGuard = factory.indexOf(
    "if (draftResumeHydrationRef.current)"
  );
  const autosaveStart = factory.lastIndexOf("useEffect(() => {", hydrationGuard);
  const autosaveEnd = factory.indexOf(
    "const handleDataCreditoBypass",
    autosaveStart
  );
  assert.ok(hydrationGuard >= 0);
  assert.ok(autosaveStart >= 0);
  assert.ok(autosaveEnd > autosaveStart);
  const autosave = factory.slice(autosaveStart, autosaveEnd);

  assert.match(
    postErrorHandling,
    /error\.message === DRAFT_REQUIRES_DATACREDITO_CODE[\s\S]*code: DRAFT_REQUIRES_DATACREDITO_CODE[\s\S]*status: 409/
  );
  assert.ok(
    postErrorHandling.indexOf("DRAFT_REQUIRES_DATACREDITO_CODE") <
      postErrorHandling.indexOf('console.error("ERROR GUARDANDO BORRADOR:", error)')
  );

  assert.match(
    autosave,
    /!draftId[\s\S]*const canonicalDraftId = draftId;[\s\S]*if \(!canonicalDraftId\) \{[\s\S]*return;[\s\S]*id: canonicalDraftId/
  );
  assert.match(
    autosave,
    /result\.status === 409 &&[\s\S]*result\.data\?\.code === DRAFT_REQUIRES_DATACREDITO_CODE[\s\S]*setDraftStatus\("idle"\);[\s\S]*setDraftErrorMessage\(""\);[\s\S]*return;/
  );
  const conflictCondition = autosave.indexOf("result.status === 409");
  const conflictStart = autosave.lastIndexOf("if (", conflictCondition);
  const conflictEnd = autosave.indexOf(
    "if (!result.ok || !result.data?.item)",
    conflictCondition
  );
  assert.ok(conflictCondition >= 0);
  assert.ok(conflictStart >= 0);
  assert.ok(conflictEnd > conflictCondition);
  const expectedConflict = autosave.slice(conflictStart, conflictEnd);
  assert.doesNotMatch(expectedConflict, /setDraftId\(|setNotice\(|throw new Error/);
});
