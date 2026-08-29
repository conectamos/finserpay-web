import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    /correctFirmaSeguroDraftImei\(\{[\s\S]*draftId,[\s\S]*imei: body\?\.imei,[\s\S]*reason: body\?\.reason,[\s\S]*expectedCurrentImei: body\?\.expectedCurrentImei,[\s\S]*expectedProcessUuid: body\?\.expectedProcessUuid,[\s\S]*actorUserId: user\.id,[\s\S]*actorName: user\.nombre/
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
  assert.match(correctionSource, /row\.estado !== "ABIERTO"/);
  assert.match(correctionSource, /row\.creditoId !== null/);
  assert.match(correctionSource, /COALESCE\("expiresAt", "createdAt" \+ INTERVAL '15 days'\)/);

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
  assert.ok(operationLock >= 0);
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
    'SELECT "processUuid", "draftPayload", "signedDocumentBase64", "completedAt"'
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
  assert.match(correctionSource, /FIRMASEGURO_FIRMADO_REQUERIDO/);
  assert.match(correctionSource, /CORRECCION_IMEI_CONFLICTO/);
});

test("rechaza IMEI ocupado, vendido o con enrolamiento ya aprobado", () => {
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
    /FROM "IphoneEnrollmentReview"[\s\S]*WHERE "solicitudId" = \$1[\s\S]*ENROLAMIENTO_YA_APROBADO/
  );
});

test("actualiza el IMEI canonico, rebobina al paso interno 4 y fuerza folio nuevo", () => {
  assert.match(
    correctionSource,
    /UPDATE "CreditoBorrador"[\s\S]*SET "imei" = \$2,[\s\S]*"currentStep" = 4,[\s\S]*"payload" = \$3::jsonb/
  );
  assert.match(correctionSource, /imei,[\s\S]*deviceUid: imei,[\s\S]*wizardStep: 4/);
  assert.match(correctionSource, /delete nextPayload\.firmaSeguroDraftFolio/);
  assert.match(correctionSource, /delete nextPayload\.financialTermsSeal/);
  assert.match(routeSource, /const draftFolio = lockedCurrent\?\.draftFolio \|\| credit\.folio/);
  assert.match(routeSource, /createFinancingTermsSeal\([\s\S]*imei: credit\.imei \|\| credit\.deviceUid/);
  assert.match(routeSource, /recordFirmaSeguroImeiCorrectionReissue\(draftId, process\)/);
  assert.match(correctionSource, /reissueRequired: true as const/);
  assert.match(correctionSource, /currentStep: 4 as const/);
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
    /"signedDocumentBase64" = COALESCE\([\s\S]*NULLIF\("signedDocumentBase64", ''\),[\s\S]*\$6/
  );
  assert.match(
    callbackUpdate,
    /"completedAt" = COALESCE\("completedAt", \$9\)/
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
    /storedCorrectionId[\s\S]*firmaSeguroCorrectionPending === true[\s\S]*isUuid\(storedCorrectionId\)[\s\S]*canonicalPayload\.firmaSeguroCorrectionId = storedCorrectionId/
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
