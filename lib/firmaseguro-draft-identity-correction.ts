import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { getUnresolvedDraftDispatch } from "@/lib/firmaseguro-draft-dispatch-ledger";
import {
  ensureFirmaSeguroSchema,
  lockSolicitudOperationMutation,
  markFirmaSeguroDraftProcessesSuperseded,
} from "@/lib/firmaseguro-storage";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import { isCurrentDraftCorrectionProcess } from "@/lib/firmaseguro-draft-correction-version";
import {
  isVeriffApproved,
  serializeVeriffValidation,
  type VeriffValidationRow,
} from "@/lib/veriff-storage";

type Database = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type DraftRow = {
  id: number; estado: string; creditoId: number | null; currentStep: number;
  clienteNombre: string | null; clienteDocumento: string | null; payload: unknown;
  createdAt: Date; expiresAt: Date | null;
};
type ProcessRow = {
  processUuid: string; draftPayload: unknown; signedDocumentBase64: string | null;
  completedAt: Date | null; status: string;
};
export type IdentityCorrectionEvidenceType = "VERIFF" | "CEDULA";
export type SignedDraftIdentityCorrection = {
  correlationId: string; draftId: number; previousName: string; newName: string;
  firstNames: string; firstSurname: string; secondSurname: string;
  previousProcessUuid: string; sourceSealChecksum: string;
};
type AuditRow = SignedDraftIdentityCorrection & {
  reason: string; evidenceType: IdentityCorrectionEvidenceType;
  actorUserId: number; newProcessUuid: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u;
const DELIVERY_FIELDS = [
  "fotoRemisionDataUrl", "fotoRemisionCapturedAt", "fotoRemisionSource",
  "fotoEntregaDataUrl", "fotoEntregaCapturedAt", "fotoEntregaSource",
] as const;

export class SignedDraftIdentityCorrectionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "SignedDraftIdentityCorrectionError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function name(value: unknown, min = 2, max = 120) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized.length >= min && normalized.length <= max && NAME.test(normalized)
    ? normalized.toLocaleUpperCase("es-CO") : "";
}
function compare(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().replace(/\s+/g, " ").toUpperCase();
}
function digits(value: unknown) { return String(value ?? "").replace(/\D/g, ""); }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function evidenceImage(value: unknown) {
  return typeof value === "string" && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]{100,}$/i.test(value)
    ? value : "";
}
function correctionError(code: string, message: string, status = 409) {
  return new SignedDraftIdentityCorrectionError(code, message, status);
}

let schemaReady: Promise<void> | null = null;
export function ensureSignedDraftIdentityCorrectionSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SolicitudNombreCorrectionAudit" (
        "id" UUID PRIMARY KEY, "correlationId" UUID NOT NULL, "draftId" INTEGER NOT NULL,
        "eventType" TEXT NOT NULL CHECK ("eventType" IN ('CORRECTED','REISSUED')),
        "previousName" TEXT NOT NULL, "newName" TEXT NOT NULL,
        "firstNames" TEXT NOT NULL, "firstSurname" TEXT NOT NULL, "secondSurname" TEXT NOT NULL,
        "documentSha256" TEXT NOT NULL, "evidenceType" TEXT NOT NULL CHECK ("evidenceType" IN ('VERIFF','CEDULA')),
        "evidenceSha256" TEXT NOT NULL, "sourceSealChecksum" TEXT NOT NULL,
        "reason" TEXT NOT NULL, "actorUserId" INTEGER NOT NULL, "actorName" TEXT NOT NULL,
        "previousProcessUuid" TEXT NOT NULL, "newProcessUuid" TEXT,
        "archivedEvidence" JSONB, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SolicitudNombreCorrectionAudit_reason_check" CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500)
      )`);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "SolicitudNombreCorrectionAudit_event_key"
        ON "SolicitudNombreCorrectionAudit" ("correlationId","eventType")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SolicitudNombreCorrectionAudit_draft_idx"
        ON "SolicitudNombreCorrectionAudit" ("draftId","createdAt" DESC)`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "FinserRejectNombreCorrectionAuditMutation"()
        RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'Signed-draft name correction audit records are immutable'; END; $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='SolicitudNombreCorrectionAudit_immutable'
          AND tgrelid='"SolicitudNombreCorrectionAudit"'::regclass AND NOT tgisinternal) THEN
          CREATE TRIGGER "SolicitudNombreCorrectionAudit_immutable"
          BEFORE UPDATE OR DELETE ON "SolicitudNombreCorrectionAudit"
          FOR EACH ROW EXECUTE FUNCTION "FinserRejectNombreCorrectionAuditMutation"();
        END IF;
      END $$`);
    })().catch((error) => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

async function draft(db: Database, draftId: number, lock = false) {
  const rows = await db.$queryRawUnsafe<DraftRow[]>(`SELECT "id","estado","creditoId","currentStep",
    "clienteNombre","clienteDocumento","payload","createdAt","expiresAt"
    FROM "CreditoBorrador" WHERE "id"=$1 ${lock ? "FOR UPDATE" : ""}`, draftId);
  return rows[0] || null;
}
async function activeProcess(db: Database, draftId: number, lock = false) {
  const rows = await db.$queryRawUnsafe<ProcessRow[]>(`SELECT "processUuid","draftPayload",
    "signedDocumentBase64","completedAt","status" FROM "FirmaSeguroProcess"
    WHERE "draftId"=$1 AND "creditoId" IS NULL AND "supersededAt" IS NULL
    ORDER BY "createdAt" DESC,"id" DESC ${lock ? "FOR UPDATE" : ""}`, draftId);
  if (rows.length > 1) throw correctionError("FIRMA_AMBIGUA", "Hay varias firmas vigentes. Requiere revisión técnica.");
  return rows[0] || null;
}
async function verifiedVeriff(db: Database, draftId: number, document: string, expectedName?: string) {
  const rows = await db.$queryRawUnsafe<VeriffValidationRow[]>(`SELECT * FROM "VeriffIdentityValidation"
    WHERE "draftId"=$1 AND "creditoId" IS NULL ORDER BY "id" DESC LIMIT 1`, draftId);
  const validation = rows[0];
  if (!validation || !isVeriffApproved(validation)) return null;
  const verified = serializeVeriffValidation(validation);
  if (verified?.identityDocumentStatus !== "match" ||
      digits(verified.identityDocumentNumber) !== digits(document)) return null;
  const providerName = verified.identityData?.fullName || "";
  if (expectedName && compare(providerName) !== compare(expectedName)) return null;
  if (!providerName) return null;
  return { id: validation.id, name: providerName,
    evidenceSha256: sha256(JSON.stringify({ id: validation.id, name: providerName,
      document: digits(document), decidedAt: validation.decidedAt })) };
}

export async function getSignedDraftIdentityCorrectionDetail(draftId: number) {
  await Promise.all([ensureSolicitudSchema(), ensureFirmaSeguroSchema(), ensureSignedDraftIdentityCorrectionSchema()]);
  const row = await draft(prisma, draftId);
  if (!row) throw correctionError("BORRADOR_NO_ENCONTRADO", "Borrador no encontrado.", 404);
  const payload = record(row.payload);
  const process = await activeProcess(prisma, draftId);
  const signedBytes = process?.signedDocumentBase64
    ? Buffer.from(process.signedDocumentBase64, "base64") : null;
  const seal = readFinancingTermsSeal(record(process?.draftPayload).financialTermsSeal);
  const firstSurname = name(payload.clientePrimerApellido, 2, 90);
  const front = evidenceImage(payload.contratoCedulaFrenteDataUrl || payload.cedulaFrenteDataUrl);
  const back = evidenceImage(payload.contratoCedulaRespaldoDataUrl || payload.cedulaRespaldoDataUrl);
  const veriff = await verifiedVeriff(prisma, draftId, row.clienteDocumento || "");
  const availableEvidenceTypes: IdentityCorrectionEvidenceType[] = [
    ...(veriff ? ["VERIFF" as const] : []), ...(front && back ? ["CEDULA" as const] : []),
  ];
  const open = row.estado === "ABIERTO" && row.creditoId === null &&
    (row.expiresAt || new Date(new Date(row.createdAt).getTime() + 15 * 86_400_000)) > new Date();
  const pending = payload.firmaSeguroCorrectionPending === true ||
    payload.firmaSeguroIdentityCorrectionPending === true ||
    payload.firmaSeguroFinancialCorrectionPending === true ||
    payload.firmaSeguroContactCorrectionPending === true ||
    Boolean(await getUnresolvedDraftDispatch(draftId));
  const canCorrect = Boolean(open && [3, 4, 5].includes(row.currentStep) && firstSurname &&
    process && signedBytes?.subarray(0, 5).toString() === "%PDF-" &&
    process.completedAt && seal && compare(seal.snapshot.clienteNombre) === compare(row.clienteNombre) &&
    digits(seal.snapshot.documento) === digits(row.clienteDocumento) &&
    availableEvidenceTypes.length && !pending);
  return { draftId, clienteNombre: row.clienteNombre, clienteDocumento: row.clienteDocumento,
    clientePrimerNombre: String(payload.clientePrimerNombre || ""),
    clientePrimerApellido: firstSurname,
    clienteSegundoApellido: String(payload.clienteSegundoApellido || ""),
    expectedProcessUuid: process?.processUuid || null, canCorrect,
    availableEvidenceTypes,
    reason: canCorrect ? null : !open ? "La solicitud ya no está abierta para corrección."
      : pending ? "Hay una corrección o un envío de firma pendiente."
      : !process?.completedAt || !signedBytes ? "No hay un contrato firmado vigente verificable."
      : !availableEvidenceTypes.length ? "Adjunta la cédula por ambas caras o verifica la identidad con Veriff."
      : "El contrato firmado no coincide con los datos del borrador. Requiere revisión técnica." };
}

export function parseSignedDraftIdentityCorrection(value: unknown) {
  const body = record(value);
  if (Object.keys(body).sort().join(",") !==
      "attestation,evidenceType,expectedCurrentName,expectedProcessUuid,firstNames,idempotencyKey,reason,secondSurname") {
    throw correctionError("DATOS_INVALIDOS", "Actualiza el caso y confirma todos los datos de identidad.", 400);
  }
  const firstNames = name(body.firstNames, 2, 100);
  const secondSurname = body.secondSurname === "" ? "" : name(body.secondSurname, 2, 90);
  const expectedCurrentName = name(body.expectedCurrentName, 2, 180);
  const reason = typeof body.reason === "string" ? body.reason.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
  if (!firstNames || (body.secondSurname !== "" && !secondSurname) || !expectedCurrentName ||
      typeof body.expectedProcessUuid !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(body.expectedProcessUuid) ||
      typeof body.idempotencyKey !== "string" || !UUID.test(body.idempotencyKey) ||
      !["VERIFF", "CEDULA"].includes(String(body.evidenceType)) || body.attestation !== true ||
      reason.length < 5 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw correctionError("DATOS_INVALIDOS", "Verifica el nombre, la evidencia y el motivo antes de guardar.", 400);
  }
  return { firstNames, secondSurname, expectedCurrentName, expectedProcessUuid: body.expectedProcessUuid,
    idempotencyKey: body.idempotencyKey.toLowerCase(), evidenceType: body.evidenceType as IdentityCorrectionEvidenceType,
    reason };
}

export async function correctSignedDraftIdentity(input: {
  draftId: number; actorUserId: number; actorName: string;
  correction: ReturnType<typeof parseSignedDraftIdentityCorrection>;
}) {
  if (!Number.isSafeInteger(input.draftId) || input.draftId < 1 ||
      !Number.isSafeInteger(input.actorUserId) || input.actorUserId < 1) {
    throw correctionError("BORRADOR_INVALIDO", "El borrador no es válido.", 400);
  }
  await Promise.all([ensureSolicitudSchema(), ensureFirmaSeguroSchema(), ensureSignedDraftIdentityCorrectionSchema()]);
  const { correction } = input;
  return prisma.$transaction(async (db) => {
    await lockSolicitudOperationMutation(db, input.draftId);
    const row = await draft(db, input.draftId, true);
    if (!row || row.estado !== "ABIERTO" || row.creditoId !== null ||
        ![3, 4, 5].includes(row.currentStep) ||
        (row.expiresAt || new Date(new Date(row.createdAt).getTime() + 15 * 86_400_000)) <= new Date()) {
      throw correctionError("BORRADOR_NO_DISPONIBLE", "La solicitud ya no está abierta o fue convertida en crédito.");
    }
    const replay = await db.$queryRawUnsafe<AuditRow[]>(`SELECT * FROM "SolicitudNombreCorrectionAudit"
      WHERE "correlationId"=$1::uuid AND "eventType"='CORRECTED' LIMIT 1`, correction.idempotencyKey);
    if (replay[0]) {
      const expected = [replay[0].draftId === input.draftId,
        replay[0].actorUserId === input.actorUserId,
        replay[0].firstNames === correction.firstNames,
        replay[0].secondSurname === correction.secondSurname,
        replay[0].previousName === correction.expectedCurrentName,
        replay[0].previousProcessUuid === correction.expectedProcessUuid,
        replay[0].reason === correction.reason, replay[0].evidenceType === correction.evidenceType];
      if (expected.some((item) => !item)) throw correctionError("CORRECCION_REPETIDA", "Esta confirmación corresponde a otra corrección.");
      return { correctionId: correction.idempotencyKey, clienteNombre: replay[0].newName,
        requiresNewSignature: !replay[0].newProcessUuid, replayed: true };
    }
    if (await getUnresolvedDraftDispatch(input.draftId, db)) {
      throw correctionError("FIRMA_EN_CURSO", "Hay un envío de firma sin resultado confirmado.");
    }
    const payload = record(row.payload);
    if (payload.firmaSeguroCorrectionPending === true ||
        payload.firmaSeguroIdentityCorrectionPending === true ||
        payload.firmaSeguroFinancialCorrectionPending === true ||
        payload.firmaSeguroContactCorrectionPending === true) {
      throw correctionError("CORRECCION_PENDIENTE", "Termina la corrección pendiente antes de modificar el nombre.");
    }
    const firstSurname = name(payload.clientePrimerApellido, 2, 90);
    if (!firstSurname || !digits(row.clienteDocumento) ||
        compare(row.clienteNombre) !== compare(correction.expectedCurrentName)) {
      throw correctionError("IDENTIDAD_CAMBIO", "El nombre o la cédula cambió. Actualiza el caso.");
    }
    const newName = [correction.firstNames, firstSurname, correction.secondSurname].filter(Boolean).join(" ");
    if (compare(newName) === compare(row.clienteNombre)) {
      throw correctionError("SIN_CAMBIOS", "El nombre indicado ya está guardado.");
    }
    const process = await activeProcess(db, input.draftId, true);
    const signedBytes = process?.signedDocumentBase64
      ? Buffer.from(process.signedDocumentBase64, "base64") : null;
    const seal = readFinancingTermsSeal(record(process?.draftPayload).financialTermsSeal);
    if (!process || process.processUuid !== correction.expectedProcessUuid || !process.completedAt ||
        !signedBytes || signedBytes.subarray(0, 5).toString() !== "%PDF-" || !seal ||
        compare(seal.snapshot.clienteNombre) !== compare(row.clienteNombre) ||
        digits(seal.snapshot.documento) !== digits(row.clienteDocumento) ||
        compare(record(process.draftPayload).clientePrimerApellido) !== compare(firstSurname)) {
      throw correctionError("CONTRATO_NO_VERIFICADO", "El contrato firmado ya no coincide con esta solicitud. Requiere revisión técnica.");
    }
    let evidenceSha256: string;
    if (correction.evidenceType === "VERIFF") {
      const verified = await verifiedVeriff(db, input.draftId, row.clienteDocumento || "", newName);
      if (!verified) throw correctionError("VERIFF_NO_COINCIDE", "Veriff no confirmó esta cédula y este nombre. Revisa el documento oficial.");
      evidenceSha256 = verified.evidenceSha256;
    } else {
      const front = evidenceImage(payload.contratoCedulaFrenteDataUrl || payload.cedulaFrenteDataUrl);
      const back = evidenceImage(payload.contratoCedulaRespaldoDataUrl || payload.cedulaRespaldoDataUrl);
      if (!front || !back) throw correctionError("CEDULA_NO_DISPONIBLE", "Adjunta ambas caras de la cédula antes de corregir el nombre.");
      evidenceSha256 = sha256(`${sha256(front)}:${sha256(back)}`);
    }
    const archivedEvidence = Object.fromEntries(DELIVERY_FIELDS.flatMap((key) =>
      Object.hasOwn(payload, key) ? [[key, payload[key]]] : []));
    const next: Record<string, unknown> = { ...payload, clientePrimerNombre: correction.firstNames,
      clientePrimerApellido: firstSurname, clienteSegundoApellido: correction.secondSurname,
      clienteNombre: newName, wizardStep: 4,
      firmaSeguroCorrectionPending: true,
      firmaSeguroIdentityCorrectionPending: true,
      firmaSeguroIdentityCorrectionId: correction.idempotencyKey,
      entregaValidada: false, deliverableReady: false };
    for (const key of DELIVERY_FIELDS) delete next[key];
    delete next.financialTermsSeal;
    // La versión contractual corregida recibe un folio propio; el anterior
    // permanece asociado exclusivamente al PDF firmado que se archivó.
    delete next.firmaSeguroDraftFolio;
    const updated = await db.$queryRawUnsafe<Array<{ id: number }>>(`UPDATE "CreditoBorrador"
      SET "clienteNombre"=$2,"currentStep"=4,"payload"=$3::jsonb,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
        AND "clienteNombre"=$4 RETURNING "id"`, input.draftId, newName, JSON.stringify(next), row.clienteNombre);
    if (updated.length !== 1) throw correctionError("IDENTIDAD_CAMBIO", "La solicitud cambió durante la corrección.");
    const superseded = await markFirmaSeguroDraftProcessesSuperseded(db, {
      draftId: input.draftId, actorUserId: input.actorUserId, reason: correction.reason,
    });
    if (superseded.length !== 1 || superseded[0].processUuid !== process.processUuid) {
      throw correctionError("FIRMA_CAMBIO", "La firma cambió durante la corrección.");
    }
    await db.$executeRawUnsafe(`INSERT INTO "SolicitudNombreCorrectionAudit"
      ("id","correlationId","draftId","eventType","previousName","newName",
       "firstNames","firstSurname","secondSurname","documentSha256","evidenceType","evidenceSha256",
       "sourceSealChecksum","reason","actorUserId","actorName","previousProcessUuid","archivedEvidence")
      VALUES ($1::uuid,$2::uuid,$3,'CORRECTED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      randomUUID(), correction.idempotencyKey, input.draftId, correction.expectedCurrentName,
      newName, correction.firstNames, firstSurname, correction.secondSurname,
      sha256(digits(row.clienteDocumento)), correction.evidenceType, evidenceSha256,
      seal.checksum, correction.reason, input.actorUserId,
      input.actorName.normalize("NFKC").trim().slice(0, 160), process.processUuid,
      Object.keys(archivedEvidence).length ? JSON.stringify(archivedEvidence) : null);
    return { correctionId: correction.idempotencyKey, clienteNombre: newName,
      requiresNewSignature: true, replayed: false };
  }, { timeout: 15000 });
}

export async function getPendingSignedDraftIdentityCorrection(
  draftId: number, correctionId: unknown, sourceProcessUuid: string,
): Promise<SignedDraftIdentityCorrection | null> {
  if (typeof correctionId !== "string" || !UUID.test(correctionId)) return null;
  await ensureSignedDraftIdentityCorrectionSchema();
  const rows = await prisma.$queryRawUnsafe<SignedDraftIdentityCorrection[]>(`SELECT
    "correlationId"::text,"draftId","previousName","newName","firstNames","firstSurname",
    "secondSurname","previousProcessUuid","sourceSealChecksum"
    FROM "SolicitudNombreCorrectionAudit" WHERE "draftId"=$1 AND "correlationId"=$2::uuid
    AND "eventType"='CORRECTED' AND "previousProcessUuid"=$3
    AND NOT EXISTS (SELECT 1 FROM "SolicitudNombreCorrectionAudit" sent
      WHERE sent."correlationId"=$2::uuid AND sent."eventType"='REISSUED') LIMIT 1`,
    draftId, correctionId, sourceProcessUuid);
  return rows[0] || null;
}

export async function recordSignedDraftIdentityCorrectionReissue(
  draftId: number,
  process: { processUuid: string; draftId: number | null; supersededAt: Date | null;
    draftPayload: unknown; signedDocumentBase64: string | null; completedAt: Date | null } | null,
) {
  if (!process || process.draftId !== draftId || process.supersededAt) return false;
  const correctionId = record(process.draftPayload).firmaSeguroIdentityCorrectionId;
  if (typeof correctionId !== "string" || !UUID.test(correctionId)) return false;
  // El recibo del envío no es una firma. Conservar la corrección pendiente
  // permite reintentar con seguridad si el proveedor falla antes de firmar.
  const signedBytes = process.signedDocumentBase64
    ? Buffer.from(process.signedDocumentBase64, "base64") : null;
  if (!process.completedAt || !signedBytes || signedBytes.subarray(0, 5).toString() !== "%PDF-") {
    return true;
  }
  const signedSeal = readFinancingTermsSeal(record(process.draftPayload).financialTermsSeal);
  if (!signedSeal) return false;
  await ensureSignedDraftIdentityCorrectionSchema();
  return prisma.$transaction(async (db) => {
    await lockSolicitudOperationMutation(db, draftId);
    if (!await isCurrentDraftCorrectionProcess(db, draftId, process.processUuid)) return false;
    const row = await draft(db, draftId, true);
    if (!row) return false;
    const payload = record(row.payload);
    const rows = await db.$queryRawUnsafe<AuditRow[]>(`SELECT * FROM "SolicitudNombreCorrectionAudit"
      WHERE "draftId"=$1 AND "correlationId"=$2::uuid AND "eventType"='CORRECTED' LIMIT 1`,
      draftId, correctionId);
    const corrected = rows[0];
    if (!corrected || compare(corrected.newName) !== compare(row.clienteNombre) ||
        compare(record(process.draftPayload).clienteNombre) !== compare(corrected.newName) ||
        compare(signedSeal.snapshot.clienteNombre) !== compare(corrected.newName)) return false;
    const prior = await db.$queryRawUnsafe<Array<{ newProcessUuid: string | null }>>(
      `SELECT "newProcessUuid" FROM "SolicitudNombreCorrectionAudit"
       WHERE "correlationId"=$1::uuid AND "eventType"='REISSUED' LIMIT 1`, correctionId);
    if (prior[0] && prior[0].newProcessUuid !== process.processUuid) {
      throw correctionError("FIRMA_VERSION_CAMBIO", "La corrección ya fue vinculada a otra firma. Requiere revisión técnica.");
    }
    await db.$executeRawUnsafe(`INSERT INTO "SolicitudNombreCorrectionAudit"
      ("id","correlationId","draftId","eventType","previousName","newName","firstNames",
       "firstSurname","secondSurname","documentSha256","evidenceType","evidenceSha256",
       "sourceSealChecksum","reason","actorUserId","actorName","previousProcessUuid","newProcessUuid")
      SELECT $1::uuid,"correlationId","draftId",'REISSUED',"previousName","newName",
        "firstNames","firstSurname","secondSurname","documentSha256","evidenceType",
        "evidenceSha256","sourceSealChecksum","reason","actorUserId","actorName",
        "previousProcessUuid",$2 FROM "SolicitudNombreCorrectionAudit"
      WHERE "correlationId"=$3::uuid AND "eventType"='CORRECTED'
      ON CONFLICT ("correlationId","eventType") DO NOTHING`, randomUUID(), process.processUuid, correctionId);
    if (payload.firmaSeguroIdentityCorrectionId === correctionId) {
      await db.$executeRawUnsafe(`UPDATE "CreditoBorrador" SET "payload"=
        ("payload"-'firmaSeguroCorrectionPending'-'firmaSeguroIdentityCorrectionPending'-'firmaSeguroIdentityCorrectionId') ||
        jsonb_build_object('firmaSeguroIdentityReissuedAt',CURRENT_TIMESTAMP::text,
          'firmaSeguroIdentityReissueProcessUuid',$2::text),"updatedAt"=CURRENT_TIMESTAMP
        WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
          AND "payload"->>'firmaSeguroIdentityCorrectionId'=$3`,
        draftId, process.processUuid, correctionId);
    }
    return true;
  });
}
