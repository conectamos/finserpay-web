import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { approvalActorAudit } from "@/lib/credit-approval-actor";
import type { ApprovalActor, ApprovalDatabase } from "@/lib/credit-approval";

export const evidenceSnapshotKeys: Record<string, string> = {
  "cedula-frente": "cedulaFrente", "cedula-posterior": "cedulaRespaldo",
  "selfie-cedula": "selfieConCedula", "foto-entrega": "fotoEntrega", "foto-remision": "fotoRemision",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function evidenceSha256(dataUrl: string | null) {
  if (dataUrl === null) return null;
  const match = dataUrl.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/]*={0,2})$/i);
  return createHash("sha256").update(match ? Buffer.from(match[1], "base64") : dataUrl).digest("hex");
}

export function correctedEvidenceSnapshot(snapshot: unknown, options: {
  key: string; field: string; previousSha256: string | null; nextSha256: string;
  correctedAt: string; actor: ApprovalActor & Record<string, unknown>; source: string;
}) {
  const root = record(snapshot);
  const evidence = record(root.evidencia);
  const snapshotKey = evidenceSnapshotKeys[options.key];
  if (!snapshotKey) throw new Error("Invalid evidence snapshot key");
  return {
    ...root,
    evidencia: { ...evidence, [snapshotKey]: {
      ...record(evidence[snapshotKey]), registrada: true, capturedAt: options.correctedAt,
      source: options.source, sha256: options.nextSha256,
    } },
    correccionesEvidencia: [
      ...(Array.isArray(root.correccionesEvidencia) ? root.correccionesEvidencia : []),
      { version: 1, evidenceKey: options.key, databaseField: options.field,
        correctedAt: options.correctedAt, actor: options.actor,
        previousSha256: options.previousSha256, nextSha256: options.nextSha256 },
    ],
  };
}

/** Called inside the same credit-locked transaction that replaces the image. */
export async function archiveEvidenceRevision(db: ApprovalDatabase, options: {
  creditId: number; key: string; previousDataUrl: string | null;
  previousSha256: string | null; nextSha256: string; actor: ApprovalActor;
  source: "ANALISTA_APROBACION" | "ADMIN_CENTRAL"; reviewRevision?: number | null;
  reviewHash?: string | null;
}) {
  const audit = approvalActorAudit(options.actor);
  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalEvidenceRevision"
    ("id", "creditoId", "evidenceKey", "previousDataUrl", "previousSha256", "nextSha256",
      "actorUserId", "actorName", "source", "reviewRevision", "reviewHash", "actorKind", "actorGrantId", "actorSessionId", "createdAt")
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, $14::uuid, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  randomUUID(), options.creditId, options.key, options.previousDataUrl, options.previousSha256,
  options.nextSha256, audit.actorUserId, audit.actorName, options.source,
  options.reviewRevision ?? null, options.reviewHash ?? null, audit.actorKind, audit.actorGrantId, audit.actorSessionId);
}
