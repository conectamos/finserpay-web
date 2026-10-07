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
  saveDraft,
}: {
  draftId: number | null;
  loadDraft: (id: number) => Promise<DraftLookupResult<T>>;
  saveDraft: () => Promise<number>;
}): Promise<{ draftId: number; correctionDraft: T | null }> {
  if (!draftId) {
    return { draftId: await saveDraft(), correctionDraft: null };
  }

  const result = await loadDraft(draftId);
  const draft = result.item;
  if (!result.ok || !draft || draft.id !== draftId || draft.estado !== "ABIERTO") {
    throw new Error(result.error || "No se pudo verificar la solicitud vigente. Actualiza el caso e intenta de nuevo.");
  }

  if (draft.payload?.firmaSeguroCorrectionPending === true) {
    return { draftId, correctionDraft: draft };
  }

  return { draftId: await saveDraft(), correctionDraft: null };
}
