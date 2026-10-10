import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontro ${start}`);
  assert.notEqual(endIndex, -1, `No se encontro ${end}`);
  return source.slice(startIndex, endIndex);
}

const [
  correctionSource,
  storageSource,
  routeSource,
  firmaCreditSource,
  enrollmentSource,
  solicitudesSource,
  closeRouteSource,
  draftsRouteSource,
] = await Promise.all([
  readProjectFile("lib/firmaseguro-imei-correction.ts"),
  readProjectFile("lib/firmaseguro-storage.ts"),
  readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
  readProjectFile("lib/firmaseguro-credit.ts"),
  readProjectFile("lib/iphone-enrollment-storage.ts"),
  readProjectFile("lib/solicitudes-storage.ts"),
  readProjectFile("app/api/creditos/route.ts"),
  readProjectFile("app/api/creditos/borradores/route.ts"),
]);

test("PATCH de correccion respeta el contrato y es exclusivo del admin central", () => {
  const patch = sourceBetween(
    routeSource,
    "export async function PATCH",
    "export async function POST"
  );

  assert.match(patch, /body\?\.action[\s\S]*"CORREGIR_IMEI"/);
  assert.match(patch, /isAdminRole\(user\.rolNombre\)/);
  assert.match(patch, /isFinserPayCentralAlly\(user\.aliadoAccesoCodigo\)/);
  assert.match(patch, /CORRECCION_IMEI_NO_AUTORIZADA/);
  assert.match(
    patch,
    /correctFirmaSeguroDraftImei\(\{[\s\S]*draftId,[\s\S]*imei: body\?\.imei,[\s\S]*reason: body\?\.reason,[\s\S]*expectedCurrentImei: body\?\.expectedCurrentImei,[\s\S]*expectedProcessUuid: body\?\.expectedProcessUuid,[\s\S]*expectedEnrollmentReviewId: body\?\.expectedEnrollmentReviewId,[\s\S]*actorUserId: user\.id,[\s\S]*actorName: user\.nombre/
  );
  assert.match(patch, /NextResponse\.json\(\{ ok: true, \.\.\.result \}\)/);
  assert.match(routeSource, /stage: "imei_correction"/);
});

test("la correccion valida solicitud, IMEI, motivo y serializa con locks", () => {
  assert.match(correctionSource, /IMEI_CORRECCION_INVALIDO/);
  assert.match(correctionSource, /\/\^\\d\{15\}\$\//);
  assert.match(correctionSource, /reason\.length < 5/);
  assert.match(correctionSource, /MOTIVO_CORRECCION_REQUERIDO/);
  assert.match(correctionSource, /IMEI_ACTUAL_ESPERADO_INVALIDO/);
  assert.match(correctionSource, /FIRMASEGURO_PROCESO_ESPERADO_REQUERIDO/);
  assert.match(correctionSource, /ENROLAMIENTO_ESPERADO_INVALIDO/);
  assert.match(correctionSource, /row\.estado !== "ABIERTO"/);
  assert.match(correctionSource, /row\.creditoId !== null/);
  assert.match(correctionSource, /COALESCE\("expiresAt", "createdAt" \+ INTERVAL '15 days'\)/);

  const enrollmentLock = correctionSource.indexOf(
    "iphone-enrollment:${input.draftId}"
  );
  const operationLock = correctionSource.indexOf(
    "await lockSolicitudOperationMutation(transaction, input.draftId)"
  );
  const identityLocks = correctionSource.indexOf(
    'lockSolicitudIdentityMutation(transaction, "imei", identityImei)'
  );
  const rowLock = correctionSource.indexOf(
    "readDraft(transaction, input.draftId, true)"
  );
  const update = correctionSource.indexOf('UPDATE "CreditoBorrador"');
  assert.ok(enrollmentLock >= 0);
  assert.ok(operationLock > enrollmentLock);
  assert.ok(identityLocks > operationLock);
  assert.ok(rowLock > identityLocks);
  assert.ok(update > rowLock);
  assert.match(correctionSource, /FOR UPDATE/);
});

test("el control optimista liga la correccion al IMEI y firma observados", () => {
  const operationLock = correctionSource.indexOf(
    "await lockSolicitudOperationMutation(transaction, input.draftId)"
  );
  const draftComparison = correctionSource.indexOf(
    "previousImei !== expectedCurrentImei"
  );
  const processLookup = correctionSource.indexOf(
    'SELECT "processUuid", "status", "draftPayload", "signedDocumentBase64", "completedAt"'
  );
  const processLock = correctionSource.indexOf("FOR UPDATE", processLookup);
  const processComparison = correctionSource.indexOf(
    "activeProcess.processUuid !== expectedProcessUuid"
  );
  const draftUpdate = correctionSource.indexOf('UPDATE "CreditoBorrador"');

  assert.ok(operationLock >= 0);
  assert.ok(draftComparison > operationLock);
  assert.ok(processLookup > draftComparison);
  assert.ok(processLock > processLookup);
  assert.ok(processComparison > processLock);
  assert.ok(draftUpdate > processComparison);
  assert.match(
    correctionSource,
    /activeProcessImei !== expectedCurrentImei/
  );
  assert.match(correctionSource, /FIRMASEGURO_PROCESO_REQUERIDO/);
  assert.match(correctionSource, /FIRMASEGURO_PROCESO_EN_CURSO/);
  assert.match(
    correctionSource,
    /activeProcessSigned[\s\S]*isFirmaSeguroFailedStatus\(activeProcess\.status\)[\s\S]*!activeProcessSigned && !activeProcessFailed/
  );
  assert.doesNotMatch(correctionSource, /FIRMASEGURO_FIRMADO_REQUERIDO/);
  assert.match(correctionSource, /CORRECCION_IMEI_CONFLICTO/);
  assert.match(
    correctionSource,
    /activeEnrollmentReview\?\.id \|\| null\) !== expectedEnrollmentReviewId[\s\S]*ENROLAMIENTO_CORRECCION_CONFLICTO/
  );
});

test("rechaza IMEI ocupado o vendido y reemplaza el enrolamiento aprobado con auditoria", () => {
  assert.match(
    correctionSource,
    /plataformaDispositivo[\s\S]*platform !== "IPHONE"[\s\S]*CORRECCION_IMEI_SOLO_IPHONE/
  );
  assert.match(
    correctionSource,
    /FROM "CreditoBorrador"[\s\S]*"id" <> \$1[\s\S]*"estado" = 'ABIERTO'[\s\S]*"creditoId" IS NULL[\s\S]*IMEI_EN_OTRA_SOLICITUD/
  );
  assert.match(
    correctionSource,
    /FROM "Credito"[\s\S]*UPPER\(COALESCE\("estado", ''\)\) <> 'ANULADO'[\s\S]*COALESCE\("imei"[\s\S]*COALESCE\("deviceUid"[\s\S]*IMEI_YA_VENDIDO/
  );
  assert.match(
    correctionSource,
    /FROM "IphoneEnrollmentReview"[\s\S]*WHERE "solicitudId" = \$1[\s\S]*"supersededAt" IS NULL[\s\S]*FOR UPDATE/
  );
  assert.match(
    correctionSource,
    /UPDATE "IphoneEnrollmentReview"[\s\S]*"supersededAt" = CURRENT_TIMESTAMP[\s\S]*"supersededByUserId" = \$2[\s\S]*"supersededReason" = \$4[\s\S]*"supersededCorrelationId" = \$5::uuid/
  );
  assert.match(correctionSource, /enrollmentReapprovalRequired: Boolean\(activeEnrollmentReview\)/);
  assert.doesNotMatch(correctionSource, /ENROLAMIENTO_YA_APROBADO/);
  assert.doesNotMatch(correctionSource, /DELETE FROM "IphoneEnrollmentReview"/);
});

test("actualiza el IMEI canonico, rebobina al paso interno 4 y regenera desde sello firmado", () => {
  assert.match(
    correctionSource,
    /UPDATE "CreditoBorrador"[\s\S]*SET "imei" = \$2,[\s\S]*"currentStep" = 4,[\s\S]*"payload" = \$3::jsonb/
  );
  assert.match(correctionSource, /imei,[\s\S]*deviceUid: imei,[\s\S]*wizardStep: 4/);
  assert.match(correctionSource, /delete nextPayload\.firmaSeguroDraftFolio/);
  assert.match(correctionSource, /delete nextPayload\.financialTermsSeal/);
  assert.match(routeSource, /const draftFolio = lockedCurrent\?\.draftFolio \|\|/);
  assert.match(routeSource, /const frozen = buildFrozenDraftCorrection\(/);
  assert.match(routeSource, /const priorProcess = await prisma\.\$queryRawUnsafe/);
  assert.match(routeSource, /FIRMASEGURO_SIGNED_SOURCE_UNAVAILABLE/);
  assert.match(routeSource, /createFinancingTermsSeal\([\s\S]*imei: credit\.imei \|\| credit\.deviceUid/);
  assert.match(routeSource, /recordFirmaSeguroImeiCorrectionReissue\(draftId, process\)/);
  assert.match(correctionSource, /reissueRequired: true as const/);
  assert.match(correctionSource, /currentStep: 4 as const/);
});

test("reintento terminal conserva el origen firmado y archiva el proceso fallido", () => {
  assert.match(routeSource, /const imeiTerminalRetry = isVerifiedTerminalDraftImeiRetry\(currentPayload, current\)/);
  assert.match(routeSource, /const imeiRetryProcess = isVerifiedTerminalDraftImeiRetry\(sourcePayload, lockedCurrent\)/);
  assert.match(routeSource, /const sourceRows = correctionPending \? await prisma\.\$queryRawUnsafe/);
  assert.match(routeSource, /financialRetryProcess \|\| identityRetryProcess \|\| imeiRetryProcess/);
  assert.match(routeSource, /supersedeActive:[\s\S]*imeiRetryProcess/);
  assert.match(routeSource, /firmaSeguroDraftPayload\.firmaSeguroCorrectionId =[\s\S]*lockedCurrent\?\.draftPayload/);
  assert.match(correctionSource, /firmaSeguroReissueProcessUuid/);
  assert.match(correctionSource, /processPayload\.firmaSeguroReissueProcessUuid/);
});

test("dos reintentos de IMEI avanzan el proceso vigente sin duplicar la auditoría", async () => {
  const start = correctionSource.indexOf("export async function recordFirmaSeguroImeiCorrectionReissue(");
  assert.ok(start >= 0);
  const source = correctionSource.slice(start).replace(/^export /, "");
  const executable = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const correctionId = "10000000-0000-4000-8000-000000000001";
  const imei = "490154203237518";
  let currentPayload = { imei, firmaSeguroCorrectionPending: true,
    firmaSeguroCorrectionId: correctionId };
  const audit = { correlationId: correctionId, draftId: 22, previousImei: "111111111111111",
    newImei: imei, reason: "Garantía", actorUserId: 7, actorName: "Analista",
    previousProcessUuid: "original-signed" };
  let auditInsertions = 0;
  const db = {
    $queryRawUnsafe: async sql => {
      if (sql.includes('FROM "SolicitudImeiCorrectionAudit" corrected')) return [audit];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    $executeRawUnsafe: async (sql, ...params) => {
      if (sql.includes('INSERT INTO "SolicitudImeiCorrectionAudit"')) {
        if (auditInsertions === 0) auditInsertions++;
        return 1;
      }
      if (sql.includes('UPDATE "CreditoBorrador"')) {
        const [, newProcessUuid, nextImei, id, previousProcessUuid] = params;
        const matches = nextImei === imei && id === correctionId &&
          (currentPayload.firmaSeguroCorrectionId === id ||
            Boolean(previousProcessUuid && currentPayload.firmaSeguroReissueProcessUuid === previousProcessUuid));
        if (!matches) return 0;
        currentPayload = { ...currentPayload, firmaSeguroReissueProcessUuid: newProcessUuid };
        delete currentPayload.firmaSeguroCorrectionPending;
        delete currentPayload.firmaSeguroCorrectionId;
        return 1;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const record = new Function("prisma", "ensureFirmaSeguroSchema", "normalizeImei",
    "normalizeCorrectionId", "payloadObject", "randomUUID", "lockSolicitudOperationMutation", "isCurrentDraftCorrectionProcess",
    `${executable}\nreturn recordFirmaSeguroImeiCorrectionReissue;`)(
    { $transaction: async callback => callback(db) }, async () => {},
    value => String(value || "").replace(/\D/g, ""),
    value => String(value || "").trim(),
    value => value && typeof value === "object" ? value : {},
    () => "20000000-0000-4000-8000-000000000002", async () => {}, async () => true,
  );
  let previousProcessUuid = null;
  for (const processUuid of ["process-2", "process-3", "process-4"]) {
    const process = { draftId: 22, processUuid, supersededAt: null,
      draftPayload: { imei, firmaSeguroCorrectionId: correctionId,
        ...(previousProcessUuid ? { firmaSeguroReissueProcessUuid: previousProcessUuid } : {}) } };
    assert.equal(await record(22, process), true);
    assert.equal(currentPayload.firmaSeguroReissueProcessUuid, processUuid);
    previousProcessUuid = processUuid;
  }
  assert.equal(auditInsertions, 1, "la corrección conserva un solo evento REISSUED");
});

test("archiva las evidencias del equipo anterior antes de limpiar el payload activo", () => {
  for (const field of [
    "fotoEntregaDataUrl",
    "fotoEntregaCapturedAt",
    "fotoEntregaSource",
    "fotoRemisionDataUrl",
    "fotoRemisionCapturedAt",
    "fotoRemisionSource",
    "iphoneEnrolamientoVerificado",
    "iphoneEnrolamientoConfirmadoAt",
  ]) {
    assert.match(correctionSource, new RegExp(`"${field}"`));
  }
  const archive = correctionSource.indexOf("archiveEquipmentDependentPayload(");
  const cleanup = correctionSource.indexOf(
    "for (const field of EQUIPMENT_DEPENDENT_PAYLOAD_FIELDS)",
    archive + 1
  );
  const update = correctionSource.indexOf('UPDATE "CreditoBorrador"', cleanup);
  const auditInsert = correctionSource.indexOf(
    'INSERT INTO "SolicitudImeiCorrectionAudit"',
    update
  );
  assert.ok(archive >= 0);
  assert.ok(cleanup > archive);
  assert.ok(update > cleanup);
  assert.ok(auditInsert > update);
  assert.match(correctionSource, /"archivedEvidence"[\s\S]*\$10::jsonb/);
  assert.match(
    correctionSource,
    /enrollmentReview:[\s\S]*id: enrollmentReview\.id[\s\S]*analystName: enrollmentReview\.analystName[\s\S]*correlationId: enrollmentReview\.correlationId/
  );
  assert.match(storageSource, /"archivedEvidence" JSONB/);
  assert.match(
    storageSource,
    /ALTER TABLE "SolicitudImeiCorrectionAudit"[\s\S]*ADD COLUMN IF NOT EXISTS "archivedEvidence" JSONB/
  );
});

test("la auditoria es append-only y conserva los dos eventos correlacionados", () => {
  assert.match(storageSource, /CREATE TABLE IF NOT EXISTS "SolicitudImeiCorrectionAudit"/);
  assert.match(storageSource, /CHECK \("eventType" IN \('CORRECTED', 'REISSUED'\)\)/);
  assert.match(
    storageSource,
    /UNIQUE INDEX IF NOT EXISTS "SolicitudImeiCorrectionAudit_event_key"[\s\S]*"correlationId", "eventType"/
  );
  assert.match(storageSource, /BEFORE UPDATE OR DELETE ON "SolicitudImeiCorrectionAudit"/);
  assert.match(storageSource, /pg_advisory_xact_lock/);
  assert.doesNotMatch(
    storageSource,
    /DROP TRIGGER IF EXISTS "SolicitudImeiCorrectionAudit_immutable"/
  );
  assert.match(storageSource, /RAISE EXCEPTION 'Solicitud IMEI correction audit records are immutable'/);
  assert.match(correctionSource, /'CORRECTED'/);
  assert.match(correctionSource, /'REISSUED'/);
  assert.doesNotMatch(correctionSource, /UPDATE "SolicitudImeiCorrectionAudit"/);
  assert.doesNotMatch(correctionSource, /DELETE FROM "SolicitudImeiCorrectionAudit"/);
});

test("el proceso anterior solo se marca reemplazado y conserva PDF y estado", () => {
  const supersede = sourceBetween(
    storageSource,
    "export async function markFirmaSeguroDraftProcessesSuperseded",
    "export async function updateFirmaSeguroProcess"
  );
  assert.match(supersede, /SET "supersededAt" = CURRENT_TIMESTAMP/);
  assert.match(supersede, /"supersededByUserId" = \$2/);
  assert.match(supersede, /"supersededReason" = \$3/);
  assert.match(supersede, /"creditoId" IS NULL/);
  assert.doesNotMatch(
    supersede,
    /SET[\s\S]*(?:"status"|"signedDocumentBase64"|"signedDocumentFileName"|"completedAt"|"lastError")\s*=/
  );
  assert.match(
    storageSource,
    /ON CONFLICT \("processUuid"\) DO UPDATE SET[\s\S]*"FirmaSeguroProcess"\."supersededAt" IS NULL[\s\S]*"draftId" IS NOT DISTINCT FROM EXCLUDED\."draftId"[\s\S]*"creditoId" IS NOT DISTINCT FROM EXCLUDED\."creditoId"/
  );
  assert.match(
    firmaCreditSource,
    /if \(!row\)[\s\S]*UUID que ya pertenece a otro expediente o a una firma reemplazada/
  );
  const callbackUpdateStart = storageSource.indexOf(
    "export async function updateFirmaSeguroProcess"
  );
  assert.ok(callbackUpdateStart >= 0);
  const callbackUpdate = storageSource.slice(callbackUpdateStart);
  assert.match(
    callbackUpdate,
    /"signedDocumentBase64" = CASE WHEN "supersededAt" IS NOT NULL AND "creditoId" IS NOT NULL[\s\S]*THEN "signedDocumentBase64" ELSE COALESCE\(NULLIF\("signedDocumentBase64", ''\), \$6\) END/
  );
  assert.match(
    callbackUpdate,
    /"completedAt" = CASE WHEN "supersededAt" IS NOT NULL AND "creditoId" IS NOT NULL[\s\S]*THEN "completedAt" ELSE COALESCE\("completedAt", \$9\) END/
  );
});

test("getters, cierre, muro y enrolamiento ignoran procesos reemplazados", () => {
  for (const functionName of [
    "getLatestFirmaSeguroProcessByCredit",
    "getLatestSignedFirmaSeguroProcessByCredit",
    "getLatestFirmaSeguroProcessByDraft",
    "getFirmaSeguroProcessByUuid",
  ]) {
    const start = storageSource.indexOf(`export async function ${functionName}`);
    const next = storageSource.indexOf("\nexport async function ", start + 1);
    const source = storageSource.slice(start, next < 0 ? undefined : next);
    assert.match(source, /"supersededAt" IS NULL/, functionName);
  }
  assert.match(
    storageSource,
    /linkFirmaSeguroProcessToCredit[\s\S]*"supersededAt" IS NULL/
  );
  assert.match(
    closeRouteSource,
    /await getFirmaSeguroProcessByUuid\(firmaSeguroProcessUuid\)/
  );
  assert.match(
    enrollmentSource,
    /latest_firma\."supersededAt" IS NULL[\s\S]*firma\."supersededAt" IS NULL/
  );
  assert.match(
    solicitudesSource,
    /FROM "FirmaSeguroProcess"[\s\S]{0,160}WHERE "draftId" = \$1[\s\S]{0,100}"supersededAt" IS NULL/
  );
  assert.match(
    solicitudesSource,
    /FROM "FirmaSeguroProcess" process[\s\S]{0,140}process\."supersededAt" IS NULL/
  );
  assert.match(
    draftsRouteSource,
    /FROM "FirmaSeguroProcess" process[\s\S]{0,140}process\."supersededAt" IS NULL/
  );
});

test("la reemision usa el correlationId exacto y no limpia una correccion posterior", () => {
  assert.match(
    solicitudesSource,
    /storedCorrectionId[\s\S]*firmaSeguroCorrectionPending === true[\s\S]*isUuid\(storedCorrectionId\)[\s\S]*preservePendingImeiCorrectionAutosave\([\s\S]*storedCorrectionId/
  );
  assert.match(
    correctionSource,
    /processPayload\.firmaSeguroCorrectionId/
  );
  assert.match(
    correctionSource,
    /corrected\."correlationId" = \$3::uuid/
  );
  assert.match(
    correctionSource,
    /"payload"->>'firmaSeguroCorrectionId'[\s\S]*= \$4/
  );
  assert.doesNotMatch(
    correctionSource,
    /ORDER BY corrected\."createdAt" DESC/
  );
});

test("el autosave no cambia el contrato ni restaura la remisión antigua durante la corrección de IMEI", () => {
  const fieldsSource = sourceBetween(
    solicitudesSource,
    "const FIRMASEGURO_SIGNED_DRAFT_FIELDS = [",
    "] as const;"
  );
  const fields = [...fieldsSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(fields.includes("dataCreditoAssessmentId"));
  const helper = sourceBetween(
    solicitudesSource,
    "function preservePendingImeiCorrectionAutosave(",
    "export async function lockSolicitudIdentityMutation"
  );
  const protect = new Function(
    "FIRMASEGURO_SIGNED_DRAFT_FIELDS", "isOmittedSignedDraftAutosaveValue",
    "comparableSignedDraftValue", "SolicitudCanonicalMutationError",
    `${ts.transpileModule(helper, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn preservePendingImeiCorrectionAutosave;`
  )(
    fields,
    (value) => value == null || (typeof value === "string" && value.trim() === ""),
    (value) => value == null ? "" : typeof value === "string" ? value.trim() : String(value),
    class extends Error { constructor(code) { super(code); this.code = code; } }
  );
  const correctionId = "75b29e9e-2e63-4e11-9841-1fad4c3b07f3";
  const stored = {
    clienteNombre: "CLIENTE FIRMADO", clienteCorreo: "cliente@example.com",
    dataCreditoAssessmentId: "97e38d16-8360-47f2-8256-301e333735fb",
    equipoCatalogoId: 31, valorEquipoTotal: 2_000_000, cuotaInicial: 600_000,
    imei: "358000000000021", deviceUid: "358000000000021",
    firmaSeguroCorrectionPending: true, firmaSeguroCorrectionId: correctionId,
  };
  const result = protect(stored, {
    ...stored, valorEquipoTotal: "2000000", clienteCorreo: "",
    wizardStep: 5, fotoRemisionDataUrl: "data:image/png;base64,FOTO_ANTIGUA",
    firmaSeguroDraftFolio: "FOLIO_ANTERIOR", financialTermsSeal: { old: true },
  }, correctionId);
  assert.equal(result.valorEquipoTotal, 2_000_000);
  assert.equal(result.clienteCorreo, "cliente@example.com");
  assert.equal(result.wizardStep, 4);
  assert.equal(result.firmaSeguroCorrectionId, correctionId);
  assert.equal(result.fotoRemisionDataUrl, undefined);
  assert.equal(result.firmaSeguroDraftFolio, undefined);
  assert.equal(result.financialTermsSeal, undefined);
  for (const change of [
    { valorEquipoTotal: 2_100_000 },
    { dataCreditoAssessmentId: "e291e6df-69cf-45c8-9cf4-30d8ae42b338" },
    { imei: "358000000000099" },
    { clienteNombre: "OTRO CLIENTE" },
    { clienteCorreo: "otro@example.com" },
  ]) {
    assert.throws(() => protect(stored, { ...stored, ...change }, correctionId),
      { code: "SOLICITUD_TERMINOS_FIRMADOS_INMUTABLE" });
  }
  assert.match(solicitudesSource,
    /const persistedStep = (?:clientCorrectionPending \|\| )?financialCorrectionPending \|\| identityCorrectionPending \|\| imeiCorrectionPending \|\| imeiReissueAwaitingSignature\s*\? 4/);
  assert.match(solicitudesSource,
    /payloadJson,\s*(?:clientCorrectionPending \|\| )?financialCorrectionPending \|\| identityCorrectionPending \|\| imeiCorrectionPending \|\| imeiReissueAwaitingSignature/);
});

test("el callback puede seguir archivando el estado remoto del proceso historico", () => {
  assert.match(storageSource, /getFirmaSeguroProcessByUuidIncludingSuperseded/);
  assert.match(
    firmaCreditSource,
    /getFirmaSeguroProcessForCallback[\s\S]*getFirmaSeguroProcessByUuidIncludingSuperseded\(processUuid\)/
  );
  assert.doesNotMatch(
    sourceBetween(
      storageSource,
      "export async function getFirmaSeguroProcessByUuidIncludingSuperseded",
      "export async function markFirmaSeguroDraftProcessesSuperseded"
    ),
    /"supersededAt" IS NULL/
  );
});
