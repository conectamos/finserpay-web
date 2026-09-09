import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { approvalActorAudit, type ApprovalActor } from "@/lib/credit-approval-actor";
import { CreditApprovalError } from "@/lib/credit-approval-errors";

export type NoveltyDatabase = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export const NOVELTY_PHOTOS = [
  { key: "cedula-frente", label: "Cédula frontal", field: "contratoCedulaFrenteDataUrl" },
  { key: "cedula-posterior", label: "Cédula posterior", field: "contratoCedulaRespaldoDataUrl" },
  { key: "selfie-cedula", label: "Selfie con cédula", field: "iphoneSelfieCedulaDataUrl" },
  { key: "foto-entrega", label: "Foto de entrega", field: "fotoEntregaDataUrl" },
  { key: "foto-remision", label: "Remisión", field: "fotoRemisionDataUrl" },
] as const;
export type NoveltyKey = typeof NOVELTY_PHOTOS[number]["key"] | "GENERAL";
export type NoveltyStatus = "WAITING_ALLY" | "RESPONDED" | "RESOLVED";
export type NoveltyItem = {
  id: string; key: NoveltyKey; label: string; status: "OPEN" | "RESPONDED"; version: number;
  reason: string; openedAt: string; respondedAt: string | null; responseText: string | null;
  responsePhotoHash: string | null;
};
export type CreditApprovalNoveltyState = {
  available: boolean; blocksApproval: boolean; blocksSettlement: boolean;
  pendingCount: number; answeredCount: number;
  novelty: null | { id: string; status: NoveltyStatus; version: number; pendingCount: number; answeredCount: number; items: NoveltyItem[] };
};
export const EMPTY_CREDIT_APPROVAL_NOVELTY_STATE: CreditApprovalNoveltyState = {
  available: true, blocksApproval: false, blocksSettlement: false, pendingCount: 0, answeredCount: 0, novelty: null,
};
export const noveltyUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const noveltyIso = (value: Date | string | null) => value ? new Date(value).toISOString() : null;
export function noveltyLabel(key: string) { return NOVELTY_PHOTOS.find(item => item.key === key)?.label || "Novedad general"; }
export function noveltyError(message: string, code = "NOVELTY_CHANGED", status = 409): never {
  throw new CreditApprovalError(code, message, status);
}
export function noveltyText(value: unknown, max: number) {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) noveltyError("Escribe un texto válido.", "INVALID_NOVELTY", 400);
  const text = value.trim();
  if (text.length < 5 || text.length > max) noveltyError(`El texto debe tener entre 5 y ${max} caracteres.`, "INVALID_NOVELTY", 400);
  return text;
}
export async function appendNoveltyEvent(db: NoveltyDatabase, input: {
  noveltyId: string; itemId?: string | null; type: string; actor: ApprovalActor; payload: Record<string, unknown>;
  requestKey?: string | null; requestHash?: string | null;
}) {
  const actor = approvalActorAudit(input.actor);
  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalNoveltyEvent"
    ("id","noveltyId","itemId","type","actorKind","actorUserId","actorName","actorGrantId","actorSessionId","payload","requestKey","requestHash","createdAt")
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9::uuid,$10::jsonb,$11::uuid,$12,CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
    randomUUID(), input.noveltyId, input.itemId || null, input.type, actor.actorKind, actor.actorUserId,
    actor.actorName, actor.actorGrantId, actor.actorSessionId, JSON.stringify(input.payload), input.requestKey || null, input.requestHash || null);
}
