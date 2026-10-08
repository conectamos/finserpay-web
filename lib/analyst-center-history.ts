import "server-only";
import prisma from "@/lib/prisma";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import type { AnalystCenterManagement, AnalystCenterManagementResponse } from "@/lib/analyst-center-types";

type Database = Pick<typeof prisma, "$queryRawUnsafe">;
const requiredTables = ["Credito", "CreditoBorrador", "CreditSadminRegistration", "CreditApprovalEvent", "CreditSadminEvent"];
const optionalTables = ["ApprovalOperationalAction", "ApprovalOperationalContractVersion",
  "CreditApprovalInitialSignature", "CreditApprovalReissue",
  "CreditApprovalNoveltyEvent", "CreditApprovalNovelty", "CreditApprovalDataCorrection",
  "CreditMoraManagementEvent", "CreditMoraExceptionEvent", "DataCreditoAdminAccessAudit", "DataCreditoAssessment",
  "SolicitudImeiCorrectionAudit", "SolicitudNombreCorrectionAudit", "FirmaSeguroDraftDispatch",
  "CreditApprovalCallRecording", "CreditDeviceReplacementRemissionEvent", "CreditDeviceReplacementRemission",
  "CreditDeviceReplacement", "CreditApprovalEvidenceRevision", "CreditMoraSupport"];

function pageValue(value: unknown, fallback: number, maximum: number) {
  if (value === undefined || value === null) return fallback;
  const raw = String(value);
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new CreditApprovalError("INVALID_PAGE", "La página o cantidad de registros no es válida.", 400);
  }
  return parsed;
}

export function analystCenterPagination(page: unknown, pageSize: unknown) {
  return { page: pageValue(page, 1, 100_000), pageSize: pageValue(pageSize, 20, 100) };
}

/** All SQL fragments come from this fixed source whitelist, never from query parameters. */
function historySources(present: Set<string>) {
  // The operational writer explicitly inserts Action and ContractVersion with
  // the same id. Other ledgers have no such link and must not be deduplicated by guesswork.
  const signatureDuplicate = present.has("ApprovalOperationalContractVersion")
    ? ` AND NOT EXISTS (SELECT 1 FROM "ApprovalOperationalContractVersion" version WHERE version."id"=event."id"
        AND version."actorUserId"=event."actorUserId" AND event."targetKind"='CREDIT'
        AND event."eventType"='SIGNATURE_REQUESTED'
        AND version."creditoId"=COALESCE(event."creditId",event."targetId"))` : "";
  const sources = [
    `SELECT 'aprobacion:'||event."id"::text AS "id",event."createdAt" AT TIME ZONE 'UTC' AS "at",
      'CREDIT'::text AS "kind",event."creditoId"::text AS "targetId",event."creditoId" AS "creditId",
      event."eventType"::text AS "action",event."eventType"::text AS "result",'APROBACION'::text AS "source"
      FROM "CreditApprovalEvent" event WHERE event."actorUserId"=$1 AND event."actorKind"='USER'`,
    `SELECT 'sadmin:'||event."id"::text,event."createdAt" AT TIME ZONE 'UTC','CREDIT',event."creditoId"::text,event."creditoId",
      'SADMIN_'||COALESCE(NULLIF(event."payload"->>'field',''),'REGISTRO'),
      COALESCE(NULLIF(event."payload" #>> '{after,estadoCreacion}',''),NULLIF(event."payload"->>'estadoCreacion',''),
        CASE WHEN event."payload" #>> '{after,estado}'='CREADO_SADMIN'
          OR event."payload"->>'confirmation'='ADMIN_EXISTING_SADMIN' THEN 'CREADO_CORRECTAMENTE' END),'SADMIN'
      FROM "CreditSadminEvent" event WHERE event."actorUserId"=$1 AND event."actorKind"='USER'`,
  ];
  if (present.has("ApprovalOperationalAction")) sources.push(
    `SELECT 'operativo:'||event."id"::text,event."createdAt" AT TIME ZONE 'UTC',event."targetKind",event."targetId"::text,
      COALESCE(event."creditId",CASE WHEN event."targetKind"='CREDIT' THEN event."targetId" END),
      event."eventType",event."status",'OPERATIVO'
      FROM "ApprovalOperationalAction" event WHERE event."actorUserId"=$1${signatureDuplicate}`);
  if (present.has("ApprovalOperationalContractVersion")) sources.push(
    `SELECT 'firma:'||version."id"::text,version."requestedAt" AT TIME ZONE 'UTC','CREDIT',version."creditoId"::text,
      version."creditoId",'SIGNATURE_REQUESTED',version."status",'FIRMA'
      FROM "ApprovalOperationalContractVersion" version WHERE version."actorUserId"=$1`);
  if (present.has("CreditApprovalInitialSignature")) sources.push(
    `SELECT 'firma-inicial:'||operation."id"::text,operation."requestedAt" AT TIME ZONE 'UTC','CREDIT',operation."creditoId"::text,
      operation."creditoId",'INITIAL_SIGNATURE_REQUESTED',operation."status",'FIRMA'
      FROM "CreditApprovalInitialSignature" operation WHERE operation."actorUserId"=$1`);
  if (present.has("CreditApprovalReissue")) sources.push(
    `SELECT 'firma-aprobacion:'||operation."id"::text,operation."requestedAt" AT TIME ZONE 'UTC','CREDIT',operation."creditoId"::text,
      operation."creditoId",'SIGNATURE_REISSUED',operation."status",'FIRMA'
      FROM "CreditApprovalReissue" operation WHERE operation."requestedByUserId"=$1 AND operation."requestedByKind"='USER'`);
  if (present.has("FirmaSeguroDraftDispatch")) sources.push(
    `SELECT 'firma-solicitud:'||dispatch."id"::text,dispatch."createdAt" AT TIME ZONE 'UTC','DRAFT',dispatch."draftId"::text,
      NULL::integer,'DRAFT_SIGNATURE_REQUESTED',dispatch."status",'FIRMA'
      FROM "FirmaSeguroDraftDispatch" dispatch WHERE dispatch."actorUserId"=$1`);
  if (present.has("CreditApprovalCallRecording")) sources.push(
    `SELECT 'grabacion:'||recording."id"::text,recording."createdAt" AT TIME ZONE 'UTC','CREDIT',recording."creditoId"::text,
      recording."creditoId",'CALL_RECORDING_UPLOADED',NULL::text,'GRABACION'
      FROM "CreditApprovalCallRecording" recording WHERE recording."actorUserId"=$1 AND recording."actorKind"='USER'`);
  if (["CreditDeviceReplacementRemissionEvent", "CreditDeviceReplacementRemission", "CreditDeviceReplacement"]
    .every(table => present.has(table))) sources.push(
    `SELECT 'remision:'||event."id"::text,event."createdAt",'CREDIT',replacement."creditId"::text,
      replacement."creditId",'REMISSION_'||event."eventType",event."eventType",'REMISION_GARANTIA'
      FROM "CreditDeviceReplacementRemissionEvent" event
      JOIN "CreditDeviceReplacementRemission" remission ON remission."id"=event."remissionId"
      JOIN "CreditDeviceReplacement" replacement ON replacement."id"=remission."replacementId"
      WHERE event."actorUserId"=$1`);
  if (present.has("CreditApprovalNoveltyEvent") && present.has("CreditApprovalNovelty")) sources.push(
    `SELECT 'novedad:'||event."id"::text,event."createdAt" AT TIME ZONE 'UTC','CREDIT',novelty."creditoId"::text,
      novelty."creditoId",event."type",event."type",'NOVEDAD'
      FROM "CreditApprovalNoveltyEvent" event JOIN "CreditApprovalNovelty" novelty ON novelty."id"=event."noveltyId"
      WHERE event."actorUserId"=$1 AND event."actorKind"='USER'`);
  if (present.has("CreditApprovalDataCorrection")) sources.push(
    `SELECT 'correccion:'||event."id"::text,event."createdAt" AT TIME ZONE 'UTC','CREDIT',event."creditoId"::text,
      event."creditoId",'DATA_CORRECTED','REVISION_'||event."resultingRevision"::text,'CORRECCION'
      FROM "CreditApprovalDataCorrection" event WHERE event."actorUserId"=$1 AND event."actorKind"='USER'`);
  if (present.has("CreditApprovalEvidenceRevision")) sources.push(
    `SELECT 'evidencia:'||event."id"::text,event."createdAt" AT TIME ZONE 'UTC','CREDIT',event."creditoId"::text,
      event."creditoId",'EVIDENCE_CORRECTED:'||event."evidenceKey",NULL::text,'CORRECCION'
      FROM "CreditApprovalEvidenceRevision" event WHERE event."actorUserId"=$1 AND event."actorKind"='USER'`);
  if (present.has("CreditMoraManagementEvent")) sources.push(
    `SELECT 'mora:'||event."id"::text,event."actedAt",'CREDIT',event."creditoId"::text,
      event."creditoId",event."action",event."result",'MORA'
      FROM "CreditMoraManagementEvent" event WHERE event."actorUserId"=$1`);
  if (present.has("CreditMoraSupport")) sources.push(
    `SELECT 'soporte-mora:'||support."id"::text,support."createdAt",'CREDIT',support."creditoId"::text,
      support."creditoId",'MORA_SUPPORT_UPLOADED',NULL::text,'MORA'
      FROM "CreditMoraSupport" support WHERE support."actorUserId"=$1`);
  if (present.has("CreditMoraExceptionEvent")) sources.push(
    `SELECT 'excepcion:'||event."id"::text,event."createdAt",'CREDIT',event."creditoId"::text,
      event."creditoId",event."action",event."toStatus",'EXCEPCION_MORA'
      FROM "CreditMoraExceptionEvent" event WHERE event."actorUserId"=$1`);
  if (present.has("DataCreditoAdminAccessAudit") && present.has("DataCreditoAssessment")) sources.push(
    `SELECT 'liberacion:'||audit."id"::text,audit."createdAt" AT TIME ZONE 'UTC',
      CASE WHEN assessment."creditId" IS NULL THEN 'ASSESSMENT' ELSE 'CREDIT' END,
      COALESCE(assessment."creditId"::text,assessment."id"::text),assessment."creditId",audit."action",audit."outcome",'DATACREDITO_LIBERACION'
      FROM "DataCreditoAdminAccessAudit" audit JOIN "DataCreditoAssessment" assessment ON assessment."id"=audit."assessmentId"
      WHERE audit."actorUserId"=$1 AND audit."action"='OPS_TX06_RETRY_AUTHORIZED'`);
  for (const [table, source, prefix] of [
    ["SolicitudImeiCorrectionAudit", "IMEI_SOLICITUD", "imei-solicitud"],
    ["SolicitudNombreCorrectionAudit", "NOMBRE_SOLICITUD", "nombre-solicitud"],
  ]) if (present.has(table)) sources.push(
    `SELECT '${prefix}:'||event."id"::text,event."createdAt",'DRAFT',event."draftId"::text,
      NULL::integer,event."eventType",event."eventType",'${source}'
      FROM "${table}" event WHERE event."actorUserId"=$1`);
  return sources;
}

const actionLabels: Record<string, string> = {
  APPROVED: "Aprobación de crédito", INVALIDATED: "Revisión de aprobación",
  IMEI_REQUESTED: "Solicitud de cambio de IMEI", IMEI_APPLIED: "Aplicación de cambio de IMEI",
  IMEI_CORRECTED: "Corrección de IMEI", CONTACT_UPDATED: "Actualización de contacto",
  SIGNATURE_REQUESTED: "Solicitud de firma", DATA_CORRECTED: "Corrección de datos",
  INITIAL_SIGNATURE_REQUESTED: "Primer envío de firma", SIGNATURE_REISSUED: "Nueva firma por Aprobaciones",
  DRAFT_SIGNATURE_REQUESTED: "Firma de solicitud", CALL_RECORDING_UPLOADED: "Carga de grabación",
  REMISSION_REQUESTED: "Solicitud de remisión de garantía", REMISSION_UPLOADED: "Carga de remisión de garantía",
  REMISSION_VERIFIED: "Verificación de remisión de garantía", REMISSION_REJECTED: "Rechazo de remisión de garantía",
  MORA_SUPPORT_UPLOADED: "Carga de soporte de mora",
  REPORTED: "Reporte de novedad", ANALYST_VERIFIED: "Verificación de novedad",
  GENERAL_RESPONDED: "Respuesta a novedad", PHOTO_RESPONDED: "Respuesta documental",
  APPROVED_RESOLVED: "Resolución de novedad", OPS_TX06_RETRY_AUTHORIZED: "Liberación DataCrédito",
};

function actionLabel(row: AnalystCenterManagement) {
  if (row.source === "CORRECCION" && row.action.startsWith("EVIDENCE_CORRECTED:")) {
    const evidenceLabels: Record<string, string> = {
      "cedula-frente": "Cédula frontal", "cedula-posterior": "Cédula posterior",
      "selfie-cedula": "Selfie con cédula", "foto-entrega": "Foto de entrega", "foto-remision": "Foto de remisión",
    };
    const label = evidenceLabels[row.action.slice("EVIDENCE_CORRECTED:".length)];
    return label ? `Corrección de evidencia · ${label}` : "Corrección de evidencia";
  }
  if (row.source === "SADMIN") return "Gestión Sadmin";
  if (row.source === "IMEI_SOLICITUD") return row.action === "REISSUED" ? "Nueva firma por IMEI" : "Corrección de IMEI";
  if (row.source === "NOMBRE_SOLICITUD") return row.action === "REISSUED" ? "Nueva firma por nombre" : "Corrección de nombre";
  if (row.source === "EXCEPCION_MORA") return `Excepción de mora · ${row.action}`;
  return actionLabels[row.action] || row.action;
}

/** Current nominal actor id is supplied by the route's session, never by the browser. */
export async function getAnalystCenterManagements(actorUserId: number,
  input: { page?: unknown; pageSize?: unknown } = {}, db: Database = prisma): Promise<AnalystCenterManagementResponse> {
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw new CreditApprovalError("UNAUTHORIZED", "Inicia sesión con tu cuenta personal de analista.", 401);
  }
  const { page, pageSize } = analystCenterPagination(input.page, input.pageSize);
  const relations = await db.$queryRawUnsafe<Array<{ name: string; present: boolean }>>(
    `SELECT name,to_regclass(format('public.%I',name)) IS NOT NULL AS present
     FROM unnest($1::text[]) AS names(name)`, [...requiredTables, ...optionalTables]);
  const present = new Set(relations.filter(row => row.present).map(row => row.name));
  if (requiredTables.some(table => !present.has(table))) {
    throw new CreditApprovalError("HISTORY_UNAVAILABLE", "El historial no está disponible. Requiere revisión técnica.", 503);
  }
  // Count and page share one statement/snapshot, including every enabled source.
  const sql = `WITH history AS (${historySources(present).join(" UNION ALL ")}), enriched AS (
    SELECT history."id",history."at",history."kind",history."targetId",
      COALESCE(history."creditId",draft."creditoId") AS "creditId",
      COALESCE(NULLIF(BTRIM(sadmin."numeroCredito"),''),credit."folio",
        CASE WHEN history."kind"='DRAFT' THEN 'SOL-'||LPAD(history."targetId",6,'0') END) AS "creditNumber",
      history."action",history."result",history."source"
    FROM history
    LEFT JOIN "CreditoBorrador" draft ON history."kind"='DRAFT' AND draft."id"::text=history."targetId"
    LEFT JOIN "Credito" credit ON credit."id"=COALESCE(history."creditId",draft."creditoId")
    LEFT JOIN "CreditSadminRegistration" sadmin ON sadmin."creditoId"=credit."id" AND sadmin."numeroCreditoConfirmado"
  ) SELECT (SELECT COUNT(*)::text FROM enriched) AS "total",
    COALESCE((SELECT jsonb_agg(row_to_json(paged) ORDER BY paged."at" DESC,paged."id" DESC) FROM
      (SELECT * FROM enriched ORDER BY "at" DESC,"id" DESC LIMIT $2 OFFSET $3) paged),'[]'::jsonb) AS "items"`;
  const rows = await db.$queryRawUnsafe<Array<{ total: string; items: AnalystCenterManagement[] }>>(
    sql, actorUserId, pageSize, (page - 1) * pageSize);
  const total = Number(rows[0]?.total);
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(rows[0]?.items)) {
    throw new CreditApprovalError("HISTORY_UNAVAILABLE", "No fue posible consultar el historial completo.", 503);
  }
  const items = rows[0].items.map(row => ({ ...row,
    at: new Date(row.at).toISOString(),
    targetId: row.kind === "ASSESSMENT" ? String(row.targetId) : Number(row.targetId),
    action: actionLabel(row),
    result: row.result || null,
  }));
  return { ok: true, items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
