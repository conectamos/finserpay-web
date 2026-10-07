/** Pure guards shared by the operational writer and its tests. */
export function operationalCreditEligibility(credit: {
  estado: unknown; paidToAlly: boolean; finishedDraft: boolean;
  platform: unknown; referenciaEquipo?: unknown; equipoMarca?: unknown; equipoModelo?: unknown;
}) {
  const state = String(credit.estado ?? "").trim().toUpperCase();
  if (["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(state)) return "CANCELLED" as const;
  if (!credit.paidToAlly) return "NOT_SETTLED" as const;
  // Older settled credits may predate CreditoBorrador. Only an explicit closed
  // credit state can replace that origin marker; the writer still verifies the
  // signed PDF and frozen financial seal before allowing an operation.
  if (!credit.finishedDraft && !["FINALIZADO", "PAGADO", "PAZ_Y_SALVO"].includes(state))
    return "NOT_FINALIZED" as const;
  const product = [credit.platform, credit.referenciaEquipo, credit.equipoMarca, credit.equipoModelo]
    .map((value) => String(value ?? "").trim().toUpperCase()).join(" ");
  if (!product.includes("IPHONE")) return "IPHONE_REQUIRED" as const;
  return null;
}

/** The IMEI workflow also serves signed iPhone credits awaiting ally settlement. */
export function operationalImeiEligibility(credit: {
  estado: unknown; paidToAlly: boolean; finishedDraft: boolean; hasApprovalReview?: boolean;
  platform: unknown; referenciaEquipo?: unknown; equipoMarca?: unknown; equipoModelo?: unknown;
}) {
  const gate = operationalCreditEligibility({ ...credit, paidToAlly: true });
  if (gate) return gate;
  if (!credit.paidToAlly && (!credit.finishedDraft || !credit.hasApprovalReview))
    return "PRE_SETTLEMENT_REVIEW_REQUIRED" as const;
  return null;
}

export function exactImei(value: unknown): value is string {
  return typeof value === "string" && /^\d{15}$/.test(value);
}

export function signedPdfBytes(value: string | null | undefined) {
  if (!value) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length >= 8 && bytes.length <= 32 * 1024 * 1024
    && bytes.subarray(0, 5).toString() === "%PDF-" ? bytes : null;
}

export function hasVerifiedDraftSignature(value: string | null | undefined, completed: boolean) {
  return completed && signedPdfBytes(value) !== null;
}

export function operationalDraftCorrectionStatus(enrollmentReapprovalRequired: boolean) {
  return enrollmentReapprovalRequired ? "PENDING_REAPPROVAL" : "PENDING_REISSUE";
}

/** PREPARING has not claimed the provider POST. All later states forbid retrying it. */
export function canDispatchReservedVersion(status: string) {
  return status === "PREPARING";
}

/** A fresh provider process response must be unambiguously terminal before retry. */
export function isVerifiedTerminalSignatureFailure(status: unknown) {
  const normalized = String(status ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toUpperCase();
  return new Set([
    "ABORTADA", "ABORTADO", "ABORTED", "ANULADA", "ANULADO",
    "CANCELADA", "CANCELADO", "CANCELED", "CANCELLED",
    "DECLINADA", "DECLINADO", "DECLINED", "EXPIRED", "EXPIRADA", "EXPIRADO",
    "RECHAZADA", "RECHAZADO", "REJECTED", "REVOKED",
  ]).has(normalized);
}

/** A corrected IMEI may be resent only after the provider definitively ended the
 * latest unsigned request. The persisted process pointer ties the retry to the
 * acknowledged correction, rather than to an unrelated failed signature. */
export function isVerifiedTerminalDraftImeiRetry(draftPayload: unknown, process: {
  processUuid: string | null; status: unknown; draftPayload: unknown;
  completedAt: unknown; signedDocumentBase64?: unknown; hasSignedDocument?: boolean;
} | null) {
  if (!process || process.completedAt || process.hasSignedDocument || process.signedDocumentBase64 ||
      !isVerifiedTerminalSignatureFailure(process.status)) return false;
  const draft = draftPayload && typeof draftPayload === "object" && !Array.isArray(draftPayload)
    ? draftPayload as Record<string, unknown> : {};
  const signedRequest = process.draftPayload && typeof process.draftPayload === "object" &&
    !Array.isArray(process.draftPayload)
    ? process.draftPayload as Record<string, unknown> : {};
  const correctionId = String(signedRequest.firmaSeguroCorrectionId || "").trim();
  const draftImei = String(draft.imei || draft.deviceUid || "").replace(/\D/g, "");
  const processImei = String(signedRequest.imei || signedRequest.deviceUid || "").replace(/\D/g, "");
  return Boolean(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(correctionId)
    && draftImei && draftImei === processImei
    && process.processUuid && draft.firmaSeguroReissueProcessUuid === process.processUuid);
}

/** Only explicit provider states that mean an unsigned request is still in progress. */
export function isVerifiedPendingSignatureStatus(status: unknown) {
  const normalized = String(status ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return new Set([
    "CREATED", "CREADO", "PENDING", "WAITING", "SENT", "IN_PROGRESS", "IN_PROCESS",
    "INITIATED", "STARTED", "AWAITING_SIGNATURE", "PENDING_SIGNATURE", "EN_PROCESO", "ENVIADO",
    "PROCESS_CREATED", "PROCESS_PENDING", "PROCESS_WAITING", "PROCESS_SENT",
  ]).has(normalized);
}
export function isVerifiedTerminalOperationalRetry(version: {
  status: string; newProcessUuid: string | null; lastCheckedAt: Date | null;
} | null, process: {
  processUuid: string; status: string; completedAt: Date | null;
  signedDocumentBase64: string | null;
} | null) {
  return Boolean(version?.status === "TECHNICAL_ERROR" && version.lastCheckedAt && process
    && version.newProcessUuid === process.processUuid && !process.completedAt
    && !process.signedDocumentBase64 && isVerifiedTerminalSignatureFailure(process.status));
}

/** Keep the signed source immutable while separately identifying the failed process being archived. */
export function operationalSignatureLineage(currentProcessUuid: string,
  signedSourceProcessUuid: string, terminalRetry: boolean) {
  return terminalRetry
    ? { previousProcessUuid: signedSourceProcessUuid, supersededProcessUuid: currentProcessUuid }
    : { previousProcessUuid: currentProcessUuid, supersededProcessUuid: null };
}

export function operationalProcessToSupersede(version: {
  previousProcessUuid: string; supersededProcessUuid: string | null;
}) {
  return version.supersededProcessUuid || version.previousProcessUuid;
}

/** Only identity/contact may differ from the verified signed financial source. */
export function operationalFrozenCredit<T extends { imei?: string | null; deviceUid?: string | null;
  clienteTelefono?: string | null; clienteCorreo?: string | null }>(
  source: T, imei: string, phone: string | null, email: string | null,
) {
  if (!exactImei(imei)) throw new Error("OPERATIONAL_IMEI_INVALID");
  return { ...source, imei, deviceUid: imei, clienteTelefono: phone || "", clienteCorreo: email || "" };
}
