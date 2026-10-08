import "server-only";
import prisma from "@/lib/prisma";
import { getSolicitudDetail } from "@/lib/solicitudes-storage";
import { normalizeSolicitudFilters } from "@/lib/solicitudes";
import { getOperationalCase, OperationalCaseReadError } from "@/lib/approval-operations-read";
import { isFirmaSeguroFailedStatus } from "@/lib/firmaseguro-status";
import { parseAnalystRequestId, projectRequestContact, projectRequestFinancial, requestIso, requestRecord, requestText } from "@/lib/approval-request-detail-model";
import type { AnalystRequestDetail } from "@/lib/approval-request-detail-types";

const CONTACT_AND_PLAN_KEYS = [
  "clienteTelefono", "clienteCorreo", "clienteDireccion", "clienteDepartamento", "clienteCiudad",
  "clienteFechaNacimiento", "clienteTipoDocumento", "equipoMarca", "equipoModelo", "referenciaEquipo",
  "valorEquipoTotal", "cuotaInicial", "saldoBaseFinanciado", "plazoMeses", "cuotaComercial",
  "valorCuota", "frecuenciaPago", "fechaPrimerPago", "financialTermsSeal", "analystDataCorrection",
  "analystFinancialCorrection", "analystEvidenceCorrection",
];
const DOCUMENTS = [
  { key: "cedula-frente", label: "Cédula frontal", fields: ["contratoCedulaFrenteDataUrl", "cedulaFrenteDataUrl"] },
  { key: "cedula-posterior", label: "Cédula posterior", fields: ["contratoCedulaRespaldoDataUrl", "cedulaRespaldoDataUrl"] },
  { key: "selfie-cedula", label: "Selfie con cédula", fields: ["iphoneSelfieCedulaDataUrl", "contratoSelfieDataUrl", "contratoFotoDataUrl"] },
  { key: "foto-entrega", label: "Foto de entrega", fields: ["fotoEntregaDataUrl"] },
  { key: "foto-remision", label: "Remisión", fields: ["fotoRemisionDataUrl"] },
];

type DetailRow = {
  data: unknown; media: unknown; seal: unknown; signatureStatus: string | null;
  signatureError: string | null; signedAt: Date | string | null; hasSignedDocument: boolean;
};

async function readRequestRow(source: "DRAFT" | "CREDIT", entityId: number) {
  if (source === "DRAFT") {
    const rows = await prisma.$queryRawUnsafe<DetailRow[]>(`
      SELECT COALESCE((SELECT jsonb_object_agg(entry.key,entry.value) FROM jsonb_each(draft."payload") entry
        WHERE entry.key=ANY($2::text[])),'{}'::jsonb) || jsonb_build_object(
          'clienteTelefono',COALESCE(NULLIF(draft."clienteTelefono",''),draft."payload"->>'clienteTelefono')) AS "data",
        (SELECT jsonb_object_agg(entry.key,TRUE) FROM jsonb_each(draft."payload") entry
          WHERE entry.key=ANY($3::text[]) AND entry.value <> 'null'::jsonb AND entry.value <> '""'::jsonb) AS "media",
        signature."draftPayload"->'financialTermsSeal' AS "seal", signature."status" AS "signatureStatus",
        signature."lastError" AS "signatureError", signature."completedAt" AS "signedAt",
        LEFT(COALESCE(signature."signedDocumentBase64",''),7)='JVBERi0' AS "hasSignedDocument"
      FROM "CreditoBorrador" draft LEFT JOIN LATERAL (
        SELECT "draftPayload","status","lastError","completedAt","signedDocumentBase64"
        FROM "FirmaSeguroProcess" WHERE "draftId"=draft."id" AND "supersededAt" IS NULL
        ORDER BY "id" DESC LIMIT 1
      ) signature ON TRUE WHERE draft."id"=$1 LIMIT 1`, entityId,
      CONTACT_AND_PLAN_KEYS, DOCUMENTS.flatMap((doc) => doc.fields));
    return rows[0] || null;
  }
  const rows = await prisma.$queryRawUnsafe<DetailRow[]>(`
    SELECT jsonb_build_object(
      'clienteTelefono',credit."clienteTelefono",'clienteCorreo',credit."clienteCorreo",
      'clienteDireccion',credit."clienteDireccion",'clienteDepartamento',credit."clienteDepartamento",
      'clienteCiudad',credit."clienteCiudad",'clienteFechaNacimiento',credit."clienteFechaNacimiento",
      'clienteTipoDocumento',credit."clienteTipoDocumento",'referenciaEquipo',credit."referenciaEquipo",
      'equipoMarca',credit."equipoMarca",'equipoModelo',credit."equipoModelo",
      'valorEquipoTotal',credit."valorEquipoTotal",'cuotaInicial',credit."cuotaInicial",
      'saldoBaseFinanciado',credit."saldoBaseFinanciado",'plazoMeses',credit."plazoMeses",
      'cuotaComercial',COALESCE(amortization."cuotaComercial"::text,credit."contratoSnapshot"->'financiero'->>'cuotaComercial'),'valorCuota',credit."valorCuota",
      'frecuenciaPago',credit."frecuenciaPago",'fechaPrimerPago',credit."fechaPrimerPago") AS "data",
      jsonb_build_object(
        'contratoCedulaFrenteDataUrl',NULLIF(credit."contratoCedulaFrenteDataUrl",'') IS NOT NULL,
        'contratoCedulaRespaldoDataUrl',NULLIF(credit."contratoCedulaRespaldoDataUrl",'') IS NOT NULL,
        'iphoneSelfieCedulaDataUrl',NULLIF(credit."iphoneSelfieCedulaDataUrl",'') IS NOT NULL,
        'fotoEntregaDataUrl',NULLIF(credit."fotoEntregaDataUrl",'') IS NOT NULL,
        'fotoRemisionDataUrl',NULLIF(credit."fotoRemisionDataUrl",'') IS NOT NULL) AS "media",
      NULL::jsonb AS "seal", signature."status" AS "signatureStatus",
      signature."lastError" AS "signatureError", signature."completedAt" AS "signedAt",
      LEFT(COALESCE(signature."signedDocumentBase64",''),7)='JVBERi0' AS "hasSignedDocument"
    FROM "Credito" credit LEFT JOIN "CreditoAmortizacion" amortization ON amortization."creditoId"=credit."id"
    LEFT JOIN LATERAL (SELECT "status","lastError","completedAt","signedDocumentBase64"
      FROM "FirmaSeguroProcess" WHERE "creditoId"=credit."id" AND "supersededAt" IS NULL
      ORDER BY "id" DESC LIMIT 1) signature ON TRUE WHERE credit."id"=$1 LIMIT 1`, entityId);
  return rows[0] || null;
}

export async function getAnalystRequestDetail(idValue: string, userId: number): Promise<AnalystRequestDetail | null> {
  const identity = parseAnalystRequestId(idValue);
  if (!identity || !Number.isSafeInteger(userId) || userId <= 0) return null;
  const item = await getSolicitudDetail({
    viewer: { kind: "APPROVAL_ANALYST", userId, aliadoId: null, sedeId: null, vendedorId: null },
    filters: normalizeSolicitudFilters({ id: identity.id }), readOnly: true,
  });
  if (!item) return null;
  const row = await readRequestRow(identity.source, identity.entityId);
  if (!row) return null;
  const data = requestRecord(row.data);
  const media = requestRecord(row.media);
  const locked = row.signedAt || row.hasSignedDocument ||
    (row.signatureStatus && !row.signatureError && !isFirmaSeguroFailedStatus(row.signatureStatus));
  const timeline: AnalystRequestDetail["timeline"] = item.timeline.flatMap((event) => event ? [{
    id: event.key, label: event.label, status: event.status, at: event.at, detail: null, actor: null,
  }] : []);
  const actions: AnalystRequestDetail["actions"] = [];
  if (identity.source === "DRAFT" && [data.analystDataCorrection, data.analystFinancialCorrection, data.analystEvidenceCorrection]
    .some(marker => Number(requestRecord(marker).revision) > 0)) {
    const corrections = await prisma.$queryRawUnsafe<Array<{
      id: string; createdAt: Date | string; actorName: string; reason: string; status: string;
    }>>(`SELECT "id"::text,"createdAt","actorName","reason","status" FROM "ApprovalOperationalAction"
      WHERE "targetKind"='DRAFT' AND "targetId"=$1 AND "eventType"='CONTACT_UPDATED'
        AND "status" IN ('DATA_CORRECTED','FINANCIAL_CORRECTED','EVIDENCE_CORRECTED') ORDER BY "createdAt" DESC LIMIT 50`, identity.entityId);
    for (const correction of corrections) {
      const at = requestIso(correction.createdAt);
      const label = correction.status === "FINANCIAL_CORRECTED" ? "Condiciones corregidas"
        : correction.status === "EVIDENCE_CORRECTED" ? "Evidencia corregida" : "Datos corregidos";
      if (at) timeline.push({ id: `operativo:${correction.id}`, label,
        status: correction.status, at, detail: requestText(correction.reason), actor: requestText(correction.actorName) });
    }
  }
  const active = !["RECHAZADA", "CANCELADA"].includes(item.estado) &&
    (identity.source === "CREDIT" || (item.rawState === "ABIERTO" && [3,4,5].includes(item.currentStep ?? 0) &&
      new Date(item.expiresAt || new Date(new Date(item.createdAt || 0).getTime() + 15*86400000)).getTime() > Date.now()));
  if (active) {
    try {
      const operation = await getOperationalCase(identity.source, identity.entityId);
      for (const event of operation.timeline) {
        if (!timeline.some((known) => known.at === event.at && known.label === event.label)) {
          timeline.push({ id: event.id, label: event.label, status: event.status ?? null,
            at: event.at, detail: event.detail, actor: event.actor });
        }
      }
      const query = new URLSearchParams({ caso: identity.id, buscar: item.documento || item.numero }).toString();
      const capabilities = operation.capabilities;
      if (capabilities.canChangeImei || capabilities.canConfirmReplacement || capabilities.canFinalizeImei || capabilities.canDispatchSignatureWithImei) {
        actions.push({ kind: "imei", label: "Cambiar IMEI", href: `/dashboard/aprobaciones/cambio-imei?${query}` });
      }
      if (capabilities.canUpdateContact || capabilities.canSendSignature || capabilities.canResendSignature || capabilities.canRedirectPendingSignature) {
        actions.push({ kind: "signature", label: "Gestionar firma", href: `/dashboard/aprobaciones/firma-seguro?${query}` });
      }
    } catch (error) {
      if (!(error instanceof OperationalCaseReadError) || error.code !== "CASE_NOT_FOUND") throw error;
    }
  }
  if (identity.source === "CREDIT" && !["RECHAZADA", "CANCELADA"].includes(item.estado)) {
    actions.unshift({ kind: "approval", label: "Ver expediente de aprobación", href: `/dashboard/aprobaciones?credito=${identity.entityId}` });
  }
  if (identity.source === "DRAFT" && item.technicalErrorCode === "TX06" && item.rawState === "ABIERTO" && item.documento &&
      new Date(item.expiresAt || new Date(new Date(item.createdAt || 0).getTime() + 15*86400000)).getTime() > Date.now()) {
    actions.push({ kind: "release", label: "Liberar consulta", href: `/dashboard/aprobaciones/liberar-consulta?buscar=${encodeURIComponent(item.documento)}` });
  }
  const documents: AnalystRequestDetail["documents"] = DOCUMENTS.map((doc) => {
    const available = doc.fields.some((field) => media[field] === true);
    return { key: doc.key, label: doc.label, available, pdf: false, href: available
      ? identity.source === "DRAFT" ? `/api/aprobaciones/solicitudes/${identity.id}/archivo/${doc.key}`
        : `/api/aprobaciones/${identity.entityId}/evidencias?tipo=${doc.key}` : null };
  });
  documents.push({ key: "documento-firmado", label: "Documento firmado", pdf: true,
    available: row.hasSignedDocument, href: row.hasSignedDocument
      ? identity.source === "DRAFT" ? `/api/aprobaciones/solicitudes/${identity.id}/archivo/documento-firmado`
        : `/api/aprobaciones/${identity.entityId}/documento` : null });
  timeline.sort((a,b) => (b.at || "").localeCompare(a.at || ""));
  return {
    ...identity, number: identity.source === "CREDIT" ? item.numeroCreditoVisible : item.numero,
    clientName: item.clienteNombre, document: item.documento, status: item.estado, statusLabel: item.estadoLabel,
    step: item.currentStep, createdAt: item.createdAt, updatedAt: item.updatedAt,
    expiresAt: item.expiresAt, closedAt: item.closedAt,
    client: projectRequestContact(data),
    assignment: { ally: item.aliado?.nombre ?? null, site: item.sede?.nombre ?? null,
      advisor: item.asesor?.nombre ?? null, createdBy: item.usuario.nombre },
    equipment: { reference: requestText(data.referenciaEquipo) || [requestText(data.equipoMarca),requestText(data.equipoModelo)].filter(Boolean).join(" ") || null,
      platform: item.plataforma || null, imei: item.imei },
    financial: projectRequestFinancial(data, locked ? row.seal : null),
    validations: item.timeline.flatMap((event) => event && ["DATACREDITO","VERIFF","CONTRATOS"].includes(event.key)
      ? [{ label: event.label, status: event.status }] : []),
    documents, timeline, actions,
  };
}
