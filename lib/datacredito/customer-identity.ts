import "server-only";
import prisma from "@/lib/prisma";
import { assertDataCreditoQueryIdentity, extractDataCreditoIdentity, resolveDataCreditoIdentity, resolveDataCreditoIncompleteDraftIdentity } from "./identity";
import { getDataCreditoAssessmentById, readDataCreditoIdentitySource, dataCreditoAssessmentMatchesScope, type DataCreditoAssessmentScope, type DataCreditoAssessmentRow } from "./storage";
let schema: Promise<unknown> | undefined;
function ensureSchema() {
  return schema ??= prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "DataCreditoIdentityCorrection" ("id" BIGSERIAL PRIMARY KEY, "assessmentId" UUID NOT NULL REFERENCES "DataCreditoAssessment"("id") ON DELETE CASCADE, "userId" INTEGER NOT NULL, "sellerId" INTEGER, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "original" JSONB NOT NULL, "previous" JSONB NOT NULL, "effective" JSONB NOT NULL)').catch((error: unknown) => { schema = undefined; throw error; });
}
function restoreFullNameOnlyIdentity(original: ReturnType<typeof extractDataCreditoIdentity>, effective: typeof original) {
  if (original.nameMode !== "FULL_NAME_ONLY") return effective;
  // Older administrative completions rebuilt fullName from incomplete parts.
  // Only an actual correction of names/secondSurname can replace the complete
  // provider name; filling a missing primary field must not reduce it to a surname.
  const hasAuditedNameCorrection = Boolean(effective.names) &&
    (effective.names !== original.names || effective.secondSurname !== original.secondSurname);
  return {
    ...effective,
    fullName: hasAuditedNameCorrection && effective.fullName ? effective.fullName : original.fullName,
    nameMode: original.nameMode,
    missing: [!effective.documentNumber && "Número de documento", !effective.documentType && "Tipo de documento"].filter(Boolean) as string[],
  };
}
export async function getDataCreditoCustomerIdentity(row: DataCreditoAssessmentRow) {
  const source = await readDataCreditoIdentitySource(row);
  if (!source) return null;
  const original = extractDataCreditoIdentity(source.providerPayload, source.documentNumber);
  await ensureSchema();
  const corrections = await prisma.$queryRawUnsafe<Array<{ effective: typeof original }>>('SELECT "effective" FROM "DataCreditoIdentityCorrection" WHERE "assessmentId" = $1 ORDER BY "id" DESC LIMIT 1', row.id);
  const effective = corrections[0]?.effective || original;
  const restored = restoreFullNameOnlyIdentity(original, effective);
  return { queryDocumentNumber: source.documentNumber, querySurname: source.firstSurname, original, effective: restored };
}
// Display recovery must never invalidate a completed credit evaluation or cause
// a paid retry. Signing and saving continue to use the strict reader above.
export async function getDataCreditoCustomerIdentityForDisplay(row: DataCreditoAssessmentRow) {
  try {
    return await getDataCreditoCustomerIdentity(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error("DATACREDITO_IDENTITY_RECOVERY_FAILED", {
      correlationId: row.correlationId,
      code: /^DATACREDITO_[A-Z_]+$/.test(message) ? message : "IDENTITY_READ_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}
export async function enforceDataCreditoCustomerIdentity(payload: Record<string, unknown>, scope: DataCreditoAssessmentScope, saveCorrection = true, actor = { userId: scope.userId, sellerId: scope.sellerId }) {
  const id = String(payload.dataCreditoAssessmentId || "");
  if (!id) return null;
  const row = await getDataCreditoAssessmentById(id);
  if (!row || !dataCreditoAssessmentMatchesScope(row, scope) || row.status !== "APROBADO") throw new Error("DATACREDITO_IDENTITY_UNAUTHORIZED");
  const identity = await getDataCreditoCustomerIdentity(row);
  if (!identity) throw new Error("DATACREDITO_IDENTITY_SOURCE_UNAVAILABLE");
  if (String(payload.clienteDocumento || "").replace(/\D/g, "") !== identity.queryDocumentNumber) throw new Error("DATACREDITO_IDENTITY_DOCUMENT_MISMATCH");
  // The integration sends tipoIdentificacion=1 for every query. This trusted
  // query binding permits absent provider metadata without marking it verified.
  const queryIdentity = { documentNumber: identity.queryDocumentNumber, documentType: "CEDULA_DE_CIUDADANIA" as const };
  assertDataCreditoQueryIdentity(identity.effective, payload, queryIdentity);
  if (identity.original.nameMode === "FULL_NAME_ONLY") {
    // Unsigned autosaves can come from legacy drafts or before display recovery
    // finishes. Always persist the server's effective whole name in that path.
    // Signing/creation still require the caller to submit that exact identity.
    const effective = resolveDataCreditoIdentity(identity.effective, saveCorrection
      ? { ...payload, clienteNombre: identity.effective.fullName }
      : payload, queryIdentity);
    payload.clienteNombre = effective.fullName;
    payload.clientePrimerNombre = effective.names;
    payload.clienteSegundoNombre = "";
    payload.clientePrimerApellido = effective.firstSurname;
    payload.clienteSegundoApellido = effective.secondSurname;
    return { querySurname: identity.querySurname, original: identity.original, effective };
  }
  // Incomplete autosaved drafts may retain missing values, but cannot reach signing/creation.
  const incomplete = identity.effective.missing.length > 0;
  if (saveCorrection && incomplete && (!identity.effective.firstSurname || !payload.clientePrimerNombre)) {
    const effective = resolveDataCreditoIncompleteDraftIdentity(identity.effective, payload, queryIdentity);
    if (identity.effective.names !== effective.names || identity.effective.secondSurname !== effective.secondSurname) {
      await prisma.$executeRawUnsafe('INSERT INTO "DataCreditoIdentityCorrection" ("assessmentId", "userId", "sellerId", "original", "previous", "effective") VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)', id, actor.userId, actor.sellerId, JSON.stringify(identity.original), JSON.stringify(identity.effective), JSON.stringify(effective));
    }
    payload.clientePrimerNombre = effective.names;
    payload.clientePrimerApellido = effective.firstSurname;
    payload.clienteSegundoApellido = effective.secondSurname;
    payload.clienteNombre = effective.fullName;
    return { querySurname: identity.querySurname, original: identity.original, effective };
  }
  const effective = resolveDataCreditoIdentity({ ...identity.original,
    firstSurname: identity.effective.firstSurname, documentNumber: identity.effective.documentNumber,
    documentType: identity.effective.documentType, manuallyCompleted: identity.effective.manuallyCompleted,
  }, payload, queryIdentity);
  if (saveCorrection && (identity.effective.names !== effective.names || identity.effective.secondSurname !== effective.secondSurname)) {
    await prisma.$executeRawUnsafe('INSERT INTO "DataCreditoIdentityCorrection" ("assessmentId", "userId", "sellerId", "original", "previous", "effective") VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)', id, actor.userId, actor.sellerId, JSON.stringify(identity.original), JSON.stringify(identity.effective), JSON.stringify(effective));
  }
  if (!saveCorrection && (identity.effective.names !== effective.names || identity.effective.secondSurname !== effective.secondSurname)) throw new Error("DATACREDITO_IDENTITY_SAVE_CORRECTION_FIRST");
  payload.clienteNombre = effective.fullName;
  return { querySurname: identity.querySurname, original: identity.original, effective };
}

export async function enforceDataCreditoCustomerIdentityForVeriff(payload: Record<string, unknown>, scope: DataCreditoAssessmentScope) {
  return enforceDataCreditoCustomerIdentity(payload, scope, false);
}

// Separate administrative procedure: only fills fields absent from the provider.
// It never changes a field returned by DataCrédito or marks manual values as verified.
export async function completeMissingDataCreditoIdentity(row: DataCreditoAssessmentRow, input: Record<string, unknown>, actor: { userId: number; sellerId: number | null }) {
  // Read the immutable provider record before holding a transactional connection.
  // All mutable identity reads and writes below use that same transaction client.
  const source = await readDataCreditoIdentitySource(row);
  if (!source) throw new Error("DATACREDITO_IDENTITY_SOURCE_UNAVAILABLE");
  const original = extractDataCreditoIdentity(source.providerPayload, source.documentNumber);
  await ensureSchema();

  return prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
      'SELECT * FROM "DataCreditoAssessment" WHERE "id" = $1 FOR UPDATE', row.id
    );
    if (!locked[0] || locked[0].status !== "APROBADO" || locked[0].consumedAt) {
      throw new Error("DATACREDITO_IDENTITY_UNAUTHORIZED");
    }
    const corrections = await transaction.$queryRawUnsafe<Array<{ effective: typeof original }>>(
      'SELECT "effective" FROM "DataCreditoIdentityCorrection" WHERE "assessmentId" = $1 ORDER BY "id" DESC LIMIT 1', row.id
    );
    const previous = restoreFullNameOnlyIdentity(original, corrections[0]?.effective || original);
    const effective = { ...previous, manuallyCompleted: [...(previous.manuallyCompleted || [])] };
    for (const field of ["firstSurname", "documentType", "documentNumber"] as const) {
      if (!input[field]) continue;
      if (original[field] || previous[field]) throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
      const value = String(input[field]).normalize("NFC").replace(/\s+/g, " ").trim();
      if (field === "documentNumber" && value !== source.documentNumber) throw new Error("DATACREDITO_IDENTITY_DOCUMENT_MISMATCH");
      if (field === "documentType" && value !== "CEDULA_DE_CIUDADANIA") throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
      if (field === "firstSurname" && (!/^[\p{L}\p{M} '’-]+$/u.test(value) || value.length > 90)) throw new Error("DATACREDITO_IDENTITY_INVALID_NAMES");
      effective[field] = value;
      effective.manuallyCompleted.push(field);
    }
    if (effective.manuallyCompleted.length === (previous.manuallyCompleted?.length || 0)) throw new Error("DATACREDITO_IDENTITY_INCOMPLETE");
    if (original.nameMode === "FULL_NAME_ONLY") effective.nameMode = original.nameMode;
    effective.missing = [original.nameMode !== "FULL_NAME_ONLY" && !effective.names && "Nombre(s)", original.nameMode !== "FULL_NAME_ONLY" && !effective.firstSurname && "Primer apellido", !effective.documentNumber && "Número de documento", !effective.documentType && "Tipo de documento"].filter(Boolean) as string[];
    effective.fullName = original.nameMode === "FULL_NAME_ONLY"
      ? previous.fullName
      : [effective.names, effective.firstSurname, effective.secondSurname].filter(Boolean).join(" ");
    await transaction.$executeRawUnsafe('INSERT INTO "DataCreditoIdentityCorrection" ("assessmentId", "userId", "sellerId", "original", "previous", "effective") VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)', row.id, actor.userId, actor.sellerId, JSON.stringify(original), JSON.stringify(previous), JSON.stringify(effective));
    return { original, effective };
  });
}

// A completed signature preserves its signed identity. The credit approval still
// has to match the encrypted query document and its owner, never the browser input.
export async function getScopedDataCreditoQueryIdentity(id: string, scope: DataCreditoAssessmentScope, expectedDocument: string) {
  const row = await getDataCreditoAssessmentById(id);
  if (!row || row.status !== "APROBADO" || !dataCreditoAssessmentMatchesScope(row, scope)) throw new Error("DATACREDITO_IDENTITY_UNAUTHORIZED");
  const source = await readDataCreditoIdentitySource(row);
  if (!source) throw new Error("DATACREDITO_IDENTITY_SOURCE_UNAVAILABLE");
  if (source.documentNumber !== expectedDocument.replace(/\D/g, "")) throw new Error("DATACREDITO_IDENTITY_DOCUMENT_MISMATCH");
  return { documentNumber: source.documentNumber, querySurname: source.firstSurname, assessment: row };
}

export async function getScopedDataCreditoCustomerIdentity(id: string, scope: DataCreditoAssessmentScope) {
  const row = await getDataCreditoAssessmentById(id);
  if (!row || !dataCreditoAssessmentMatchesScope(row, scope)) throw new Error("DATACREDITO_IDENTITY_UNAUTHORIZED");
  return getDataCreditoCustomerIdentity(row);
}
