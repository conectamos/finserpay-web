import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ensureApprovalOperationalSchema } from "@/lib/approval-operations-schema";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import { ensureFirmaSeguroSchema, lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";
import { ensureVeriffSchema, lockVeriffDraftAttempts } from "@/lib/veriff-storage";
import { normalizeCreditInstallmentLimit, resolveActivationFirstPaymentDate, resolveCreditEquipmentPlatform, sanitizeText } from "@/lib/credit-factory";
import { getEffectiveCreditSettings } from "@/lib/credit-settings";
import { resolveCreditPolicyFinancialSettings } from "@/lib/credit-policy-financial-settings";
import { findEquipmentCatalogItem, findEquipmentCatalogItemById } from "@/lib/equipment-catalog";
import { getDraftDataCreditoOffer, CreditValidationError, type DraftRow as FinancingDraftRow } from "@/lib/firmaseguro-draft-credit-builder";
import { resolveDataCreditoManualCreditLimit } from "@/lib/datacredito/manual-credit-limits";
import { requestEvidenceBytes, requestEvidenceHash } from "@/lib/approval-request-evidence-correction-core";
import { applyRequestFinancialCorrection, calculateRequestFinancialTerms, requestFinancialEligibility,
  requestFinancialRevision, requestFinancialValues, RequestFinancialCorrectionError,
  type RequestFinancialConfig, type RequestFinancialCorrectionInput } from "@/lib/approval-request-financial-correction-core";

type Database = Prisma.TransactionClient;
type Draft = FinancingDraftRow & { creditoId: number | null; expired: boolean };
type Actor = { id: number; nombre: string };
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function parseFinancialCorrectionDraftId(value: string) {
  const match = /^D-([1-9]\d*)$/.exec(value), id = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new RequestFinancialCorrectionError("REQUEST_NOT_FOUND", "Solicitud no disponible.", 404);
  return id;
}
async function ensureReadSchemas() {
  await Promise.all([ensureSolicitudSchema(), ensureFirmaSeguroSchema(), ensureVeriffSchema()]);
}
async function readDraft(db: Database, id: number, lock = false) {
  const rows = await db.$queryRawUnsafe<Draft[]>(`SELECT d.*,
    s."aliadoId" AS "sedeAliadoId",
    COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') <= CURRENT_TIMESTAMP AS "expired"
    FROM "CreditoBorrador" d LEFT JOIN "Sede" s ON s."id"=d."sedeId"
    WHERE d."id"=$1 LIMIT 1${lock ? " FOR UPDATE OF d" : ""}`, id);
  if (!rows[0]) throw new RequestFinancialCorrectionError("REQUEST_NOT_FOUND", "Solicitud no disponible.", 404);
  return { row: rows[0], payload: record(rows[0].payload) };
}
async function readEligibility(db: Database, id: number, row: Draft, payload: Record<string, unknown>) {
  const states = await db.$queryRawUnsafe<Array<{ started: boolean; dispatchTablePresent: boolean }>>(`SELECT
    EXISTS(SELECT 1 FROM "FirmaSeguroProcess" WHERE "draftId"=$1) AS "started",
    to_regclass('public."FirmaSeguroDraftDispatch"') IS NOT NULL AS "dispatchTablePresent"`, id);
  let signatureStarted = states[0]?.started === true;
  if (states[0]?.dispatchTablePresent) {
    const dispatches = await db.$queryRawUnsafe<Array<{ started: boolean }>>(`SELECT EXISTS(
      SELECT 1 FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$1) AS "started"`, id);
    signatureStarted ||= dispatches[0]?.started === true;
  }
  return requestFinancialEligibility({ open: row.estado === "ABIERTO" && row.creditoId === null,
    expired: row.expired, signatureStarted, correctionPending: payload.firmaSeguroCorrectionPending === true ||
      payload.firmaSeguroFinancialCorrectionPending === true || payload.firmaSeguroIdentityCorrectionPending === true ||
      payload.firmaSeguroContactCorrectionPending === true });
}

/** Resolve the authoritative approved offer with the original advisor, site and ally scope. */
async function readFinancialConfig(row: Draft, payload: Record<string, unknown>) {
  const catalogIdText = sanitizeText(payload.equipoCatalogoId);
  const catalogId = catalogIdText ? Number(catalogIdText) : null;
  if (catalogId !== null && (!Number.isSafeInteger(catalogId) || catalogId <= 0))
    throw new RequestFinancialCorrectionError("INVALID_EQUIPMENT", "El equipo de catálogo no es válido.", 422);
  const catalog = catalogId ? await findEquipmentCatalogItemById(catalogId)
    : sanitizeText(payload.equipoMarca) && sanitizeText(payload.equipoModelo)
      ? await findEquipmentCatalogItem({ marca: sanitizeText(payload.equipoMarca), modelo: sanitizeText(payload.equipoModelo) }) : null;
  const resolution = resolveCreditEquipmentPlatform({ requestedPlatform: payload.plataformaDispositivo,
    equipoMarca: payload.equipoMarca, equipoModelo: payload.equipoModelo, catalogItemId: catalogId, catalogItem: catalog });
  if (!resolution.ok) throw new RequestFinancialCorrectionError(resolution.code, resolution.message, 422);
  const platform = resolution.platform;
  const effective = await getEffectiveCreditSettings(undefined, platform);
  const offer = await getDraftDataCreditoOffer(row, payload, platform);
  const manualLimit = offer ? await resolveDataCreditoManualCreditLimit({ documento: sanitizeText(payload.clienteDocumento),
    policyMaxFinancedAmount: offer.maxFinancedAmount }) : null;
  const settings = effective.globalSettings;
  const installments = Number(payload.plazoMeses);
  const financialSettings = resolveCreditPolicyFinancialSettings({ globalSettings: settings,
    policyFinancialSettings: offer?.financialSettings, legacyOfferSuretyPercentage: offer?.suretyPercentage ?? null,
    numeroCuotas: Number.isSafeInteger(installments) && installments > 0 ? installments : settings.plazoCuotas });
  const config: RequestFinancialConfig = {
    platform, initialPaymentPercentage: offer?.initialPaymentPercentage ?? settings.cuotaInicialPorcentaje,
    catalogBasePrice: catalog?.activo ? catalog.precioBaseVenta : null,
    iphoneMaxFinancedAmount: settings.iphoneTopeFinanciado,
    maxFinancedAmount: offer ? manualLimit?.maxFinancedAmount ?? offer.maxFinancedAmount : null,
    maxInstallments: offer?.installmentCount ?? normalizeCreditInstallmentLimit(settings.plazoMaximoCuotas),
    maxInstallmentAmount: offer ? offer.maxInstallmentAmount : settings.iphoneTopeCuota,
    financialSettings, firstPaymentDateKey: resolveActivationFirstPaymentDate({ frequency: financialSettings.frecuenciaPago }).dateKey,
  };
  // Per-installment surety is derived from total and proposed term. Keep configuration stable when an advisor changes only the term.
  const configVersion = createHash("sha256").update(JSON.stringify({ ...config,
    financialSettings: { ...financialSettings, fianzaCuotaPorcentaje: financialSettings.fianzaModalidad === "TOTAL_CREDITO" ? null : financialSettings.fianzaCuotaPorcentaje },
    assessmentId: offer?.assessmentId ?? null, policyRevisionId: offer?.policyRevisionId ?? null,
  })).digest("hex");
  return { config, configVersion };
}
function policyError(error: unknown) {
  if (error instanceof CreditValidationError)
    return new RequestFinancialCorrectionError(error.code, error.message, error.status >= 500 ? error.status : 422);
  return error;
}
export async function getAnalystRequestFinancialCorrection(id: number) {
  await ensureReadSchemas();
  return prisma.$transaction(async (db) => {
    const { row, payload } = await readDraft(db, id);
    const eligibility = await readEligibility(db, id, row, payload);
    const base = { values: requestFinancialValues(payload), revision: requestFinancialRevision(payload), ...eligibility };
    if (!eligibility.editableFields.length)
      return { ...base, config: null, configVersion: "", preview: null, calculationError: null };
    let resolved;
    try { resolved = await readFinancialConfig(row, payload); }
    catch (error) {
      const known = policyError(error);
      if (!(known instanceof RequestFinancialCorrectionError)) throw known;
      return { ...base, editableFields: [], reason: known.message, config: null, configVersion: "", preview: null, calculationError: known.message };
    }
    try {
      const result = calculateRequestFinancialTerms(payload, resolved.config);
      return { ...base, ...resolved, values: { ...base.values, ...result.values,
        valorEquipoTotal: base.values.valorEquipoTotal, cuotaInicial: base.values.cuotaInicial,
        plazoMeses: base.values.plazoMeses }, preview: result.preview, calculationError: null };
    } catch (error) {
      if (!(error instanceof RequestFinancialCorrectionError)) throw error;
      return { ...base, ...resolved, preview: null, calculationError: error.message };
    }
  }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
}
export async function correctAnalystRequestFinancialConditions(id: number, input: RequestFinancialCorrectionInput, actor: Actor) {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !actor.nombre.trim())
    throw new RequestFinancialCorrectionError("UNAUTHORIZED", "Inicia sesión con tu cuenta de analista.", 401);
  await ensureReadSchemas(); await ensureApprovalOperationalSchema();
  return prisma.$transaction(async (db) => {
    await lockSolicitudOperationMutation(db, id); await lockVeriffDraftAttempts(db, id);
    const { row, payload } = await readDraft(db, id, true);
    const eligibility = await readEligibility(db, id, row, payload);
    if (!eligibility.editableFields.length)
      throw new RequestFinancialCorrectionError("REQUEST_LOCKED", eligibility.reason || "La solicitud no permite esta corrección.");
    let resolved;
    try { resolved = await readFinancialConfig(row, payload); } catch (error) { throw policyError(error); }
    const correction = applyRequestFinancialCorrection(payload, input, resolved.config, resolved.configVersion, actor.nombre);
    const previousRemission = sanitizeText(payload.fotoRemisionDataUrl);
    const archivedRemission = requestEvidenceBytes(previousRemission);
    if (previousRemission && (!archivedRemission || archivedRemission.bytes.length > 10_485_760))
      throw new RequestFinancialCorrectionError("ARCHIVE_UNAVAILABLE", "La remisión anterior requiere revisión para conservar su historial antes de corregir los valores.");
    const remissionHash = archivedRemission ? requestEvidenceHash(previousRemission) : null;
    const beforeFinancial = { ...correction.before, analystFinancialRevision: requestFinancialRevision(payload),
      ...(archivedRemission ? { archivedRemission: { mime: archivedRemission.mime, sha256: remissionHash,
        capturedAt: payload.fotoRemisionCapturedAt ?? null, source: payload.fotoRemisionSource ?? null } } : {}) };
    await db.$executeRawUnsafe(`UPDATE "CreditoBorrador" SET "payload"=$2::jsonb,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL`, id, JSON.stringify(correction.payload));
    await db.$executeRawUnsafe(`INSERT INTO "ApprovalOperationalAction"
      ("id","targetKind","targetId","eventType","actorUserId","actorName","reason",
        "evidenceMime","evidenceName","evidenceData","evidenceSha256","beforeContact","afterContact","status")
      VALUES ($1::uuid,'DRAFT',$2,'CONTACT_UPDATED',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,'FINANCIAL_CORRECTED')`,
      randomUUID(), id, actor.id, actor.nombre, input.reason,
      archivedRemission?.mime ?? null,
      archivedRemission ? `remision-anterior.${archivedRemission.mime === "image/png" ? "png" : archivedRemission.mime === "image/webp" ? "webp" : "jpg"}` : null,
      archivedRemission?.bytes ?? null, remissionHash,
      JSON.stringify(beforeFinancial),
      JSON.stringify({ ...correction.after, analystFinancialRevision: correction.revision }));
    return { values: requestFinancialValues(correction.payload), revision: correction.revision, ...eligibility,
      ...resolved, preview: correction.preview, calculationError: null, correction: correction.payload.analystFinancialCorrection };
  }, { isolationLevel: "ReadCommitted", timeout: 30_000 });
}
