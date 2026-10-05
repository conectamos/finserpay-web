import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { sanitizeIphoneDeliveryEvidenceDataUrl } from "@/lib/iphone-delivery-evidence";

type Database = typeof prisma | Prisma.TransactionClient;
export type RemissionStatus = "PENDING_UPLOAD" | "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
type RemissionRow = {
  id: string; replacementId: string; version: number; status: RemissionStatus;
  photoMime: string | null; photoSha256: string | null; requestedAt: Date;
  uploadedAt: Date | null; reviewedAt: Date | null; uploadedByName: string | null;
};
export type RemissionActor = { id: number; nombre: string };
export type AllyRemissionActor = RemissionActor & { aliadoId: number };

export class ReplacementRemissionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "ReplacementRemissionError";
  }
}

let schemaPromise: Promise<void> | null = null;
export async function ensureReplacementRemissionSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ remission: string | null; events: string | null }>>(
      `SELECT to_regclass('public."CreditDeviceReplacementRemission"')::text AS remission,
        to_regclass('public."CreditDeviceReplacementRemissionEvent"')::text AS events`);
    if (!rows[0]?.remission || !rows[0]?.events) throw new ReplacementRemissionError("SCHEMA_NOT_READY",
      "La solicitud de remisión aún no está disponible.", 503);
  })().catch(error => { schemaPromise = null; throw error; });
  await schemaPromise;
}

function publicRow(row: RemissionRow) {
  return {
    id: row.id, replacementId: row.replacementId, version: row.version, status: row.status,
    photoSha256: row.photoSha256, requestedAt: row.requestedAt.toISOString(),
    uploadedAt: row.uploadedAt?.toISOString() || null, reviewedAt: row.reviewedAt?.toISOString() || null,
    uploadedByName: row.uploadedByName,
  };
}

async function event(db: Database, rowId: string, type: "REQUESTED" | "UPLOADED" | "VERIFIED" | "REJECTED",
  actor: RemissionActor, hash: string | null = null, note: string | null = null) {
  await db.$executeRawUnsafe(`INSERT INTO "CreditDeviceReplacementRemissionEvent"
    ("id","remissionId","eventType","actorUserId","actorName","photoSha256","note")
    VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)`,
    randomUUID(), rowId, type, actor.id, actor.nombre.slice(0, 160), hash, note);
}

export async function requestReplacementRemission(db: Database, replacementId: string, actor: RemissionActor) {
  const id = randomUUID();
  await db.$executeRawUnsafe(`INSERT INTO "CreditDeviceReplacementRemission"
    ("id","replacementId","version","status","requestedByUserId","requestedByName")
    VALUES ($1::uuid,$2::uuid,1,'PENDING_UPLOAD',$3,$4)`,
    id, replacementId, actor.id, actor.nombre.slice(0, 160));
  await event(db, id, "REQUESTED", actor);
  return id;
}

async function latest(db: Pick<typeof prisma, "$queryRawUnsafe">, replacementId: string,
  lock = false): Promise<RemissionRow | null> {
  const rows = await db.$queryRawUnsafe<RemissionRow[]>(`SELECT
    "id"::text,"replacementId"::text,"version","status","photoMime","photoSha256",
    "requestedAt","uploadedAt","reviewedAt","uploadedByName"
    FROM "CreditDeviceReplacementRemission"
    WHERE "replacementId"=$1::uuid ORDER BY "version" DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`, replacementId);
  return rows[0] || null;
}

export async function getReplacementRemission(replacementId: string,
  db: Pick<typeof prisma, "$queryRawUnsafe"> = prisma) {
  await ensureReplacementRemissionSchema();
  const row = await latest(db, replacementId);
  return row ? publicRow(row) : null;
}

export async function isReplacementRemissionVerified(db: Database, replacementId: string) {
  const row = await latest(db, replacementId, true);
  return row === null || row.status === "VERIFIED"; // Existing requests before this feature remain valid.
}

export async function listAllyReplacementRemissions(actor: AllyRemissionActor) {
  await ensureReplacementRemissionSchema();
  const rows = await prisma.$queryRawUnsafe<Array<RemissionRow & {
    creditId: number; creditNumber: string; clientName: string; newImeiMasked: string;
  }>>(`SELECT remission."id"::text,remission."replacementId"::text,remission."version",
    remission."status",remission."photoMime",remission."photoSha256",remission."requestedAt",
    remission."uploadedAt",remission."reviewedAt",remission."uploadedByName",
    replacement."creditId",COALESCE(NULLIF(BTRIM(sadmin."numeroCredito"),''),credit."folio") AS "creditNumber",
    credit."clienteNombre" AS "clientName",CONCAT('•••• ',RIGHT(replacement."newImei",4)) AS "newImeiMasked"
    FROM "CreditDeviceReplacementRemission" remission
    JOIN "CreditDeviceReplacement" replacement ON replacement."id"=remission."replacementId"
    JOIN "Credito" credit ON credit."id"=replacement."creditId"
    JOIN "Sede" site ON site."id"=credit."sedeId"
    LEFT JOIN "CreditSadminRegistration" sadmin ON sadmin."creditoId"=credit."id" AND sadmin."numeroCreditoConfirmado"
    WHERE site."aliadoId"=$1
      AND replacement."source"='APPROVAL_OPERATIONS'
      AND replacement."status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED')
      AND remission."version"=(SELECT MAX(r2."version") FROM "CreditDeviceReplacementRemission" r2
        WHERE r2."replacementId"=replacement."id")
      AND EXISTS (SELECT 1 FROM "Usuario" account JOIN "Rol" role ON role."id"=account."rolId"
        JOIN "Sede" actor_site ON actor_site."id"=account."sedeId"
        WHERE account."id"=$2 AND account."activo" AND UPPER(BTRIM(role."nombre"))='ADMIN'
          AND actor_site."aliadoId"=$1 AND actor_site."activa")
    ORDER BY remission."requestedAt" DESC LIMIT 100`, actor.aliadoId, actor.id);
  return rows.map(row => ({ ...publicRow(row), creditId: row.creditId, creditNumber: row.creditNumber,
    clientName: row.clientName, newImeiMasked: row.newImeiMasked }));
}

export async function uploadReplacementRemission(replacementId: string, actor: AllyRemissionActor,
  input: { imageDataUrl: unknown }) {
  await ensureReplacementRemissionSchema();
  const image = await sanitizeIphoneDeliveryEvidenceDataUrl(input.imageDataUrl);
  if (!image) throw new ReplacementRemissionError("INVALID_PHOTO",
    "Sube una foto legible de la nueva remisión firmada en JPG o PNG.", 400);
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(image)!;
  const mime = match[1].toLowerCase() === "png" ? "image/png" : "image/jpeg";
  const bytes = Buffer.from(match[2], "base64");
  const hash = createHash("sha256").update(bytes).digest("hex");
  return prisma.$transaction(async db => {
    const replacement = await db.$queryRawUnsafe<Array<{ id: string; originalPhoto: string | null }>>(
      `SELECT replacement."id"::text,credit."fotoRemisionDataUrl" AS "originalPhoto"
      FROM "CreditDeviceReplacement" replacement
      JOIN "Credito" credit ON credit."id"=replacement."creditId"
      JOIN "Sede" site ON site."id"=credit."sedeId"
      WHERE replacement."id"=$1::uuid AND site."aliadoId"=$2
        AND replacement."status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED')
        AND EXISTS (SELECT 1 FROM "Usuario" account JOIN "Rol" role ON role."id"=account."rolId"
          JOIN "Sede" actor_site ON actor_site."id"=account."sedeId"
          WHERE account."id"=$3 AND account."activo" AND UPPER(BTRIM(role."nombre"))='ADMIN'
            AND actor_site."aliadoId"=$2 AND actor_site."activa")
      FOR UPDATE OF replacement`, replacementId, actor.aliadoId, actor.id);
    if (!replacement[0]) throw new ReplacementRemissionError("NOT_FOUND",
      "La solicitud de remisión no está disponible para tu aliado.", 404);
    const originalBase64 = /^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/]+={0,2})$/i
      .exec(replacement[0].originalPhoto || "")?.[1];
    if (originalBase64 && createHash("sha256").update(Buffer.from(originalBase64, "base64")).digest("hex") === hash)
      throw new ReplacementRemissionError("OLD_PHOTO",
        "Esta es la foto anterior. Sube la nueva remisión firmada para el equipo de reemplazo.", 400);
    const row = await latest(db, replacementId, true);
    if (!row) throw new ReplacementRemissionError("NOT_FOUND", "La solicitud de remisión no existe.", 404);
    const rejected = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id"::text FROM "CreditDeviceReplacementRemission"
       WHERE "replacementId"=$1::uuid AND "photoSha256"=$2 AND "status"='REJECTED' LIMIT 1`,
      replacementId, hash);
    if (rejected[0]) throw new ReplacementRemissionError("REJECTED_PHOTO",
      "Esta foto ya fue devuelta. Sube una nueva remisión firmada y legible.", 400);
    if (row.status !== "PENDING_UPLOAD") {
      if (row.photoSha256 === hash) return { ...publicRow(row), unchanged: true };
      throw new ReplacementRemissionError("ALREADY_UPLOADED",
        "Ya se recibió una foto. Espera la revisión antes de enviar otra.", 409);
    }
    await db.$executeRawUnsafe(`UPDATE "CreditDeviceReplacementRemission" SET
      "status"='PENDING_REVIEW',"photoMime"=$2,"photoData"=$3,"photoSha256"=$4,
      "uploadedByUserId"=$5,"uploadedByName"=$6,"uploadedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1::uuid AND "status"='PENDING_UPLOAD'`,
      row.id, mime, bytes, hash, actor.id, actor.nombre.slice(0, 160));
    await event(db, row.id, "UPLOADED", actor, hash);
    const updated = await latest(db, replacementId);
    return { ...publicRow(updated!), unchanged: false };
  }, { timeout: 15000 });
}

export async function reviewReplacementRemission(creditId: number, replacementId: string, actor: RemissionActor,
  action: "VERIFY" | "REJECT", note: string | null = null) {
  await ensureReplacementRemissionSchema();
  if (action === "REJECT" && (!note || note.trim().length < 5 || note.length > 500))
    throw new ReplacementRemissionError("INVALID_NOTE", "Describe por qué debe corregirse la foto.", 400);
  return prisma.$transaction(async db => {
    const replacement = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id"::text FROM "CreditDeviceReplacement"
      WHERE "id"=$1::uuid AND "creditId"=$2 AND "status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED')
      FOR UPDATE`, replacementId, creditId);
    if (!replacement[0]) throw new ReplacementRemissionError("NOT_FOUND",
      "El cambio de equipo ya no está pendiente.", 404);
    const row = await latest(db, replacementId, true);
    if (!row || row.status !== "PENDING_REVIEW")
      throw new ReplacementRemissionError("NOT_READY", "La foto aún no está pendiente de revisión.");
    const photo = await db.$queryRawUnsafe<Array<{ data: Uint8Array; hash: string }>>(
      `SELECT "photoData" AS data,"photoSha256" AS hash
       FROM "CreditDeviceReplacementRemission" WHERE "id"=$1::uuid`, row.id);
    if (!photo[0]?.data || createHash("sha256").update(Buffer.from(photo[0].data)).digest("hex") !== photo[0].hash)
      throw new ReplacementRemissionError("PHOTO_CORRUPTED",
        "La foto no superó la verificación de integridad.", 503);
    const next = action === "VERIFY" ? "VERIFIED" : "REJECTED";
    await db.$executeRawUnsafe(`UPDATE "CreditDeviceReplacementRemission" SET "status"=$2,
      "reviewedByUserId"=$3,"reviewedByName"=$4,"reviewedAt"=CURRENT_TIMESTAMP,"reviewNote"=$5
      WHERE "id"=$1::uuid AND "status"='PENDING_REVIEW'`,
      row.id, next, actor.id, actor.nombre.slice(0, 160), note?.trim() || null);
    await event(db, row.id, next, actor, row.photoSha256, note?.trim() || null);
    if (action === "REJECT") {
      const newId = randomUUID();
      await db.$executeRawUnsafe(`INSERT INTO "CreditDeviceReplacementRemission"
        ("id","replacementId","version","status","requestedByUserId","requestedByName")
        VALUES ($1::uuid,$2::uuid,$3,'PENDING_UPLOAD',$4,$5)`,
        newId, replacementId, row.version + 1, actor.id, actor.nombre.slice(0, 160));
      await event(db, newId, "REQUESTED", actor, null, "Nueva foto solicitada tras revisión.");
    }
    return publicRow((await latest(db, replacementId))!);
  }, { timeout: 15000 });
}

export async function getReplacementRemissionPhoto(creditId: number, replacementId: string) {
  await ensureReplacementRemissionSchema();
  const rows = await prisma.$queryRawUnsafe<Array<{ mime: string; data: Uint8Array; hash: string }>>(`SELECT
    "photoMime" AS mime,"photoData" AS data,"photoSha256" AS hash
    FROM "CreditDeviceReplacementRemission" remission
    JOIN "CreditDeviceReplacement" replacement ON replacement."id"=remission."replacementId"
    WHERE remission."replacementId"=$1::uuid AND replacement."creditId"=$2
      AND remission."photoData" IS NOT NULL ORDER BY remission."version" DESC LIMIT 1`,
    replacementId, creditId);
  const row = rows[0];
  if (!row) throw new ReplacementRemissionError("PHOTO_NOT_FOUND", "Todavía no hay foto para revisar.", 404);
  const data = Buffer.from(row.data);
  if (createHash("sha256").update(data).digest("hex") !== row.hash)
    throw new ReplacementRemissionError("PHOTO_CORRUPTED", "La foto no superó la verificación de integridad.", 503);
  return { mime: row.mime, data };
}
