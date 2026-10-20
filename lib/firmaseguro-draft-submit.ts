import type { DraftSignatureDispatchSummary } from "@/lib/firmaseguro-draft-dispatch-summary";

type DraftForFirmaSeguroSubmission = {
  id: number;
  estado: string;
  payload: Record<string, unknown> | null;
};

type DraftLookupResult<T> = {
  ok: boolean;
  item?: T | null;
  error?: string;
};

export type DraftSignatureStateLookupResult = {
  ok: boolean;
  draftId?: number;
  signatureDispatch?: unknown;
  error?: string;
};

/** Fail closed on unreadable status rather than treating it as an unsent contract. */
export function readPendingDraftSignatureDispatch(value: unknown): DraftSignatureDispatchSummary | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("No se pudo comprobar el envío de firma. Consulta el estado antes de continuar.");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id) ||
    !["PREPARING", "DISPATCHING", "UNCERTAIN"].includes(String(item.status)) || item.pending !== true ||
    typeof item.hasReceipt !== "boolean" || typeof item.canResume !== "boolean") {
    throw new Error("No se pudo comprobar el envío de firma. Consulta el estado antes de continuar.");
  }
  return { id: item.id, status: item.status as DraftSignatureDispatchSummary["status"], pending: true,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
    hasReceipt: item.hasReceipt,
    failureStage: item.failureStage === "provider_dispatch" || item.failureStage === "receipt_persistence" ? item.failureStage : null,
    hasProviderLocator: item.hasProviderLocator === true,
    canResume: item.canResume && item.status === "PREPARING" && !item.hasReceipt && item.hasProviderLocator === false };
}

export function pendingDraftSignatureMessage(dispatch: DraftSignatureDispatchSummary) {
  if (dispatch.canResume) return "El contrato ya está preparado. Continúa el mismo envío con los datos guardados en la solicitud.";
  if (dispatch.hasReceipt) return "El envío anterior tiene una confirmación pendiente de conciliar. Consulta su estado para recuperar la misma firma.";
  if (dispatch.status === "PREPARING") return "Hay un contrato preparado para esta solicitud. El usuario que lo preparó debe continuar el mismo envío; consulta su estado o solicita revisión.";
  return "Existe un envío anterior cuyo resultado aún no se ha confirmado. Consulta el estado o solicita revisión antes de volver a enviar.";
}

const CONTRACT_VIEW_FIELDS = [
  "clienteNombre",
  "clientePrimerNombre",
  "clientePrimerApellido",
  "clienteSegundoApellido",
  "clienteTipoDocumento",
  "clienteDocumento",
  "clienteTelefono",
  "clienteCorreo",
  "clienteDireccion",
  "equipoMarca",
  "equipoModelo",
  "imei",
  "plataformaDispositivo",
  "valorEquipoTotal",
  "cuotaInicial",
  "plazoMeses",
  "frecuenciaPago",
  "fechaPrimerPago",
] as const;

const CONTRACT_REVIEW_FIELDS = [
  ...CONTRACT_VIEW_FIELDS,
  "referenciaEquipo",
  "dataCreditoAssessmentId",
  "firmaSeguroCorrectionId",
  "firmaSeguroIdentityCorrectionId",
  "firmaSeguroContactCorrectionId",
  "firmaSeguroFinancialCorrectionId",
] as const;

/** Acknowledgement is valid only for the exact server contract being reviewed. */
export function firmaSeguroCorrectionReviewKey(
  draft: Pick<DraftForFirmaSeguroSubmission, "id" | "payload">,
): string {
  return JSON.stringify([
    draft.id,
    ...CONTRACT_REVIEW_FIELDS.map((field) =>
      String(draft.payload?.[field] ?? "").trim()
    ),
  ]);
}

export function hasFirmaSeguroCorrectionViewChanges(
  visible: Record<string, unknown>,
  authoritative: Record<string, unknown>
): boolean {
  return CONTRACT_VIEW_FIELDS.some((field) =>
    String(visible[field] ?? "").trim() !==
    String(authoritative[field] ?? "").trim()
  );
}

/** A corrected, signed draft must be sent from its audited server version. */
export async function resolveFirmaSeguroDraftForSubmission<
  T extends DraftForFirmaSeguroSubmission,
>({
  draftId,
  loadDraft,
  loadSignatureState,
  saveDraft,
}: {
  draftId: number | null;
  loadDraft: (id: number) => Promise<DraftLookupResult<T>>;
  loadSignatureState: (id: number) => Promise<DraftSignatureStateLookupResult>;
  saveDraft: () => Promise<number>;
}): Promise<{ draftId: number; correctionDraft: T | null; signatureDispatch: DraftSignatureDispatchSummary | null; dispatchDraft: T | null }> {
  if (!draftId) {
    return { draftId: await saveDraft(), correctionDraft: null, signatureDispatch: null, dispatchDraft: null };
  }

  const state = await loadSignatureState(draftId);
  if (!state.ok || state.draftId !== draftId || !Object.prototype.hasOwnProperty.call(state, "signatureDispatch")) {
    throw new Error(state.error || "No se pudo comprobar el envío de firma. Consulta el estado antes de continuar.");
  }
  const signatureDispatch = readPendingDraftSignatureDispatch(state.signatureDispatch);
  // Read after the reservation status so the displayed contract cannot predate
  // another tab's frozen preparation. A later reservation is still blocked by
  // the canonical save guard; this lookup never sends or mutates a contract.
  const result = await loadDraft(draftId);
  const draft = result.item;
  if (!result.ok || !draft || draft.id !== draftId || draft.estado !== "ABIERTO") {
    throw new Error(result.error || "No se pudo verificar la solicitud vigente. Actualiza el caso e intenta de nuevo.");
  }
  if (signatureDispatch) {
    return { draftId, correctionDraft: null, signatureDispatch, dispatchDraft: draft };
  }

  if (draft.payload?.firmaSeguroCorrectionPending === true) {
    return { draftId, correctionDraft: draft, signatureDispatch: null, dispatchDraft: null };
  }

  return { draftId: await saveDraft(), correctionDraft: null, signatureDispatch: null, dispatchDraft: null };
}
