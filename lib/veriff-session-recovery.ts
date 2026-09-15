type VeriffDraftIdentity = {
  aliadoId: number | null;
  documentNumber: string;
  id: number;
  sedeId: number;
};

type VeriffReservationIdentity = {
  aliadoId: number | null;
  creditoId: number | null;
  decidedAt: Date | string | null;
  documentNumber: string | null;
  draftId: number | null;
  sedeId: number;
  sessionId: string | null;
  status: string | null | undefined;
};

function documentDigits(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "");
}

export function isRecoverableVeriffSessionReservation(input: {
  draft: VeriffDraftIdentity;
  validation: VeriffReservationIdentity | null | undefined;
}) {
  const validation = input.validation;
  if (!validation) return false;

  return Boolean(
    validation.draftId === input.draft.id &&
      !validation.creditoId &&
      validation.sedeId === input.draft.sedeId &&
      (validation.aliadoId || null) === (input.draft.aliadoId || null) &&
      documentDigits(validation.documentNumber) ===
        documentDigits(input.draft.documentNumber) &&
      !validation.sessionId &&
      !validation.decidedAt &&
      (validation.status === "PENDING" || validation.status === "ERROR")
  );
}
