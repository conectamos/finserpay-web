export function normalizeIdentityDocumentNumber(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

export function veriffIdentityMatchesExpectedDocument(
  veriffDocumentNumber: unknown,
  expectedDocumentNumber?: unknown
) {
  const expected = normalizeIdentityDocumentNumber(expectedDocumentNumber);

  if (!expected) {
    return true;
  }

  const received = normalizeIdentityDocumentNumber(veriffDocumentNumber);
  return !received || received === expected;
}

type IdentityDocumentComparisonSide = "veriff" | "expected" | "both";

export type StrictIdentityDocumentComparison =
  | {
      ok: true;
      status: "match";
      received: string;
      expected: string;
    }
  | {
      ok: false;
      status: "missing" | "invalid-format";
      field: IdentityDocumentComparisonSide;
    }
  | {
      ok: false;
      status: "mismatch";
      received: string;
      expected: string;
    };

export type VeriffIdentityDocumentEvidenceInput = {
  personNumbers?: readonly unknown[];
  documents?: ReadonlyArray<{
    number?: unknown;
    type?: unknown;
    country?: unknown;
  }>;
  allNumbers?: readonly unknown[];
};

export type DataCreditoVeriffIdentityFailureStatus =
  | "missing"
  | "invalid-format"
  | "mismatch"
  | "invalid-document-type"
  | "invalid-document-country";

export type DataCreditoVeriffIdentityComparison =
  | {
      ok: true;
      status: "match";
      documentNumber: string;
    }
  | {
      ok: false;
      status: DataCreditoVeriffIdentityFailureStatus;
      documentNumber: string | null;
    };

type ParsedStrictIdentityDocument =
  | { status: "valid"; normalized: string }
  | { status: "missing" | "invalid-format" };

function parseStrictIdentityDocument(value: unknown): ParsedStrictIdentityDocument {
  if (value === null || value === undefined) {
    return { status: "missing" };
  }

  const raw = typeof value === "string" ? value.trim() : String(value).trim();
  if (!raw) {
    return { status: "missing" };
  }

  // Las cédulas pueden llegar sin formato o agrupadas con separadores visuales.
  // Cualquier otro carácter (incluidos prefijos como "CC") invalida la prueba.
  if (!/^\d+(?:[ .-]\d+)*$/.test(raw)) {
    return { status: "invalid-format" };
  }

  const normalized = raw.replace(/[ .-]/g, "");
  if (!/^\d{3,13}$/.test(normalized)) {
    return { status: "invalid-format" };
  }

  return { status: "valid", normalized };
}

/**
 * Compara de forma estricta el documento extraído por Veriff con el consultado.
 * A diferencia del helper permisivo histórico, un documento ausente nunca valida.
 */
export function compareStrictIdentityDocuments(
  veriffDocumentNumber: unknown,
  expectedDocumentNumber: unknown
): StrictIdentityDocumentComparison {
  const received = parseStrictIdentityDocument(veriffDocumentNumber);
  const expected = parseStrictIdentityDocument(expectedDocumentNumber);

  if (received.status !== "valid" || expected.status !== "valid") {
    if (received.status === "missing" || expected.status === "missing") {
      const field =
        received.status === "missing" && expected.status === "missing"
          ? "both"
          : received.status === "missing"
            ? "veriff"
            : "expected";
      return { ok: false, status: "missing", field };
    }

    const field =
      received.status === "invalid-format" && expected.status === "invalid-format"
        ? "both"
        : received.status === "invalid-format"
          ? "veriff"
          : "expected";
    return { ok: false, status: "invalid-format", field };
  }

  if (received.normalized !== expected.normalized) {
    return {
      ok: false,
      status: "mismatch",
      received: received.normalized,
      expected: expected.normalized,
    };
  }

  return {
    ok: true,
    status: "match",
    received: received.normalized,
    expected: expected.normalized,
  };
}

function compactEvidenceText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEvidenceMetadata(value: unknown) {
  return compactEvidenceText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

const COLOMBIAN_IDENTITY_DOCUMENT_TYPES = new Set([
  "ID",
  "IDCARD",
  "IDENTITYCARD",
  "IDENTITYDOCUMENT",
  "NATIONALID",
  "NATIONALIDENTITYCARD",
  "CITIZENID",
  "CEDULA",
  "CEDULADECIUDADANIA",
]);

const COLOMBIAN_DOCUMENT_COUNTRIES = new Set(["CO", "COL", "COLOMBIA"]);

export function getDataCreditoVeriffIdentityRejectionCode(
  status: DataCreditoVeriffIdentityFailureStatus
) {
  if (status === "missing") return "DATACREDITO_VERIFF_DOCUMENT_MISSING";
  if (status === "invalid-format") {
    return "DATACREDITO_VERIFF_DOCUMENT_INVALID";
  }
  if (status === "invalid-document-type") {
    return "DATACREDITO_VERIFF_DOCUMENT_TYPE_INVALID";
  }
  if (status === "invalid-document-country") {
    return "DATACREDITO_VERIFF_DOCUMENT_COUNTRY_INVALID";
  }
  return "DATACREDITO_VERIFF_DOCUMENT_MISMATCH";
}

/**
 * Evalúa toda la evidencia de identidad devuelta por Veriff para un crédito
 * originado en DataCrédito. Exige al menos un número proveniente del documento
 * capturado y rechaza si cualquier candidato de person/document difiere.
 */
export function compareDataCreditoVeriffIdentityEvidence(
  evidenceInput:
    | VeriffIdentityDocumentEvidenceInput
    | readonly VeriffIdentityDocumentEvidenceInput[],
  expectedDocumentNumber: unknown
): DataCreditoVeriffIdentityComparison {
  const evidenceItems = Array.isArray(evidenceInput)
    ? evidenceInput
    : [evidenceInput];
  const documents = evidenceItems.flatMap((item) => item?.documents || []);
  const documentNumbers = documents
    .map((document) => compactEvidenceText(document.number))
    .filter(Boolean);

  if (!documentNumbers.length) {
    return { ok: false, status: "missing", documentNumber: null };
  }

  for (const document of documents) {
    const documentType = normalizeEvidenceMetadata(document.type);
    if (
      documentType &&
      !COLOMBIAN_IDENTITY_DOCUMENT_TYPES.has(documentType)
    ) {
      return {
        ok: false,
        status: "invalid-document-type",
        documentNumber: compactEvidenceText(document.number) || null,
      };
    }

    const documentCountry = normalizeEvidenceMetadata(document.country);
    if (
      documentCountry &&
      !COLOMBIAN_DOCUMENT_COUNTRIES.has(documentCountry)
    ) {
      return {
        ok: false,
        status: "invalid-document-country",
        documentNumber: compactEvidenceText(document.number) || null,
      };
    }
  }

  const candidates = Array.from(
    new Set(
      evidenceItems
        .flatMap((item) => [
          ...(item?.allNumbers || []),
          ...(item?.personNumbers || []),
          ...(item?.documents || []).map(
            (document: { number?: unknown }) => document.number
          ),
        ])
        .map(compactEvidenceText)
        .filter(Boolean)
    )
  );
  const primaryDocumentComparison = compareStrictIdentityDocuments(
    documentNumbers[0],
    expectedDocumentNumber
  );

  if (!primaryDocumentComparison.ok) {
    return {
      ok: false,
      status: primaryDocumentComparison.status,
      documentNumber: documentNumbers[0] || null,
    };
  }

  for (const candidate of candidates) {
    const comparison = compareStrictIdentityDocuments(
      candidate,
      expectedDocumentNumber
    );
    if (!comparison.ok) {
      return {
        ok: false,
        status: comparison.status,
        documentNumber: primaryDocumentComparison.received,
      };
    }
  }

  return {
    ok: true,
    status: "match",
    documentNumber: primaryDocumentComparison.received,
  };
}
