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
  | "conflict"
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
  if (status === "conflict") {
    return "DATACREDITO_VERIFF_DOCUMENT_CONFLICT";
  }
  return "DATACREDITO_VERIFF_DOCUMENT_MISMATCH";
}

/**
 * Evalúa toda la evidencia de identidad devuelta por Veriff para un crédito
 * originado en DataCrédito. Exige evidencia tanto de `person` como del documento
 * capturado. `person.idNumber`/`idCode` representa la identificación nacional;
 * `document.number` puede ser un serial físico distinto de la identificación
 * nacional y por eso no participa en la comparación de la cédula.
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
  const expected = parseStrictIdentityDocument(expectedDocumentNumber);
  if (expected.status !== "valid") {
    return {
      ok: false,
      status: expected.status,
      documentNumber: null,
    };
  }

  const personNumbers = Array.from(
    new Set(
      evidenceItems
        .flatMap((item) => item?.personNumbers || [])
        .map(compactEvidenceText)
        .filter(Boolean)
    )
  );

  // Un número presente únicamente bajo `document` no basta para identificar a
  // la persona: Veriff puede devolver allí el serial físico de la cédula.
  if (!personNumbers.length) {
    return { ok: false, status: "missing", documentNumber: null };
  }

  const parsedPersonNumbers = personNumbers.map(parseStrictIdentityDocument);
  const validPersonNumbers = parsedPersonNumbers
    .filter(
      (
        candidate
      ): candidate is Extract<
        ParsedStrictIdentityDocument,
        { status: "valid" }
      > => candidate.status === "valid"
    )
    .map((candidate) => candidate.normalized);
  const hasInvalidPersonNumber = parsedPersonNumbers.some(
    (candidate) => candidate.status !== "valid"
  );

  if (hasInvalidPersonNumber) {
    return {
      ok: false,
      status: "conflict",
      documentNumber: null,
    };
  }

  const distinctPersonNumbers = new Set(validPersonNumbers);
  if (distinctPersonNumbers.size !== 1) {
    return { ok: false, status: "conflict", documentNumber: null };
  }

  const authoritativePersonNumber = validPersonNumbers[0];
  if (authoritativePersonNumber !== expected.normalized) {
    return {
      ok: false,
      status: "mismatch",
      documentNumber: authoritativePersonNumber,
    };
  }

  const documents = evidenceItems.flatMap((item) => item?.documents || []);
  const documentNumbers = documents
    .map((document) => compactEvidenceText(document.number))
    .filter(Boolean);
  if (!documentNumbers.length) {
    return { ok: false, status: "missing", documentNumber: null };
  }

  for (const document of documents) {
    const documentNumber = compactEvidenceText(document.number);
    if (!documentNumber) {
      continue;
    }

    const documentType = normalizeEvidenceMetadata(document.type);
    if (
      documentType &&
      !COLOMBIAN_IDENTITY_DOCUMENT_TYPES.has(documentType)
    ) {
      return {
        ok: false,
        status: "invalid-document-type",
        documentNumber,
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
        documentNumber,
      };
    }
  }

  const hasCompleteColombianIdentityDocument = documents.some((document) => {
    const documentNumber = compactEvidenceText(document.number);
    const documentType = normalizeEvidenceMetadata(document.type);
    const documentCountry = normalizeEvidenceMetadata(document.country);
    return Boolean(
      documentNumber &&
        COLOMBIAN_IDENTITY_DOCUMENT_TYPES.has(documentType) &&
        COLOMBIAN_DOCUMENT_COUNTRIES.has(documentCountry)
    );
  });
  if (!hasCompleteColombianIdentityDocument) {
    return { ok: false, status: "missing", documentNumber: null };
  }

  return {
    ok: true,
    status: "match",
    documentNumber: expected.normalized,
  };
}
