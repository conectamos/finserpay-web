import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { resolveActivationFirstPaymentDate } from "@/lib/credit-factory";
import { creditRemissionFromSignedSnapshot } from "@/lib/credit-remission";
import { serializeFirmaSeguroProcess } from "@/lib/firmaseguro-credit";
import { readFrozenCorrectionDateSource } from "@/lib/firmaseguro-draft-frozen";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function name(value: unknown) { return text(value).normalize("NFKC").replace(/\s+/g, " ").toUpperCase(); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A stored pending marker may lag a webhook. Only this exact signed, sealed revision can satisfy it. */
export function resolveStoredDraftCorrectionPending(input: {
  draftId: number;
  documentNumber: string | null;
  clientName: string | null;
  imei: string | null;
  payload: unknown;
  process: (FirmaSeguroProcessRow & { signedPdfVerified?: boolean }) | null;
}) {
  const payload = object(input.payload);
  const process = input.process;
  const processPayload = object(process?.draftPayload);
  const seal = readFinancingTermsSeal(processPayload.financialTermsSeal);
  const currentSigned = Boolean(process?.draftId === input.draftId && !process.supersededAt &&
    process.completedAt && process.signedPdfVerified === true && seal &&
    seal.snapshot.documento === text(input.documentNumber) &&
    seal.snapshot.imei === text(input.imei) && name(seal.snapshot.clienteNombre) === name(input.clientName));
  const matchesCorrection = (key: string) => {
    const id = text(payload[key]);
    return currentSigned && uuid.test(id) && id.toLowerCase() === text(processPayload[key]).toLowerCase();
  };
  const lineage = readFrozenCorrectionDateSource(processPayload.firmaSeguroFrozenCorrectionDateSource, seal);
  const identitySatisfied = matchesCorrection("firmaSeguroIdentityCorrectionId") && Boolean(
    lineage && lineage.processUuid !== process?.processUuid);
  const previousFinancialProcess = text(payload.firmaSeguroFinancialCorrectionPreviousProcessUuid);
  const financialSatisfied = matchesCorrection("firmaSeguroFinancialCorrectionId") && Boolean(
    previousFinancialProcess && previousFinancialProcess !== process?.processUuid &&
    previousFinancialProcess === text(processPayload.firmaSeguroFinancialCorrectionPreviousProcessUuid) &&
    Number(payload.valorEquipoTotal) === Number(seal?.snapshot.valorVenta) &&
    Number(payload.cuotaInicial) === Number(seal?.snapshot.cuotaInicial) &&
    Number(payload.plazoMeses) === seal?.snapshot.numeroCuotas);
  const imeiSatisfied = matchesCorrection("firmaSeguroCorrectionId");
  const identityCorrectionPending = payload.firmaSeguroIdentityCorrectionPending === true && !identitySatisfied;
  const financialCorrectionPending = payload.firmaSeguroFinancialCorrectionPending === true && !financialSatisfied;
  const imeiCorrectionPending = payload.firmaSeguroCorrectionPending === true &&
    !(identitySatisfied || imeiSatisfied);
  return { identityCorrectionPending, financialCorrectionPending, imeiCorrectionPending };
}

/** Uses the sealed contract, including the same calendar rules as the signing route. */
export function serializeStoredDraftSignature(process: FirmaSeguroProcessRow | null) {
  const serialized = serializeFirmaSeguroProcess(process, { includeDraftImei: true });
  if (!serialized) return null;
  const payload = process?.draftPayload && typeof process.draftPayload === "object" && !Array.isArray(process.draftPayload)
    ? process.draftPayload as Record<string, unknown> : {};
  const seal = readFinancingTermsSeal(payload.financialTermsSeal);
  const firstPaymentDate = resolveActivationFirstPaymentDate({
    frequency: seal?.snapshot.frecuenciaPago || payload.frecuenciaPago,
    activatedAt: new Date(),
    signedFirstPaymentDate: seal?.snapshot.fechaPrimerPago || payload.fechaPrimerPago,
  });
  const frozenCorrectionReissue = Boolean(readFrozenCorrectionDateSource(payload.firmaSeguroFrozenCorrectionDateSource, seal));
  return {
    ...serialized,
    firstPaymentDate: firstPaymentDate.signedDateKey,
    canonicalFirstPaymentDate: firstPaymentDate.dateKey,
    frozenCorrectionReissue,
    requiresFirstPaymentDateReissue: !seal || (!frozenCorrectionReissue && !firstPaymentDate.signedDateMatches),
    financialTermsChecksum: seal?.checksum || null,
    financialCorrectionReissue: Boolean(payload.firmaSeguroFinancialCorrectionId),
    remission: seal ? creditRemissionFromSignedSnapshot(seal.snapshot) : null,
  };
}
