import { createHash } from "node:crypto";
import { AttentionError } from "./atencion-core";
import { financialDate } from "./atencion-financial-core";
import type { DaptaEventScope } from "./atencion-dapta-events";
import type { DianaExtensionRequestIntent, DianaExtensionVerifiedRequest } from "./diana-extension-request-types";

export const DIANA_REQUEST_SOURCE = "SYSTEM_DIANA_REQUEST";
export const DIANA_REQUEST_MAX_AGE_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scopeKeys = ["workspaceId", "agentId", "agentChannelId", "phoneNumberId", "wabaId"] as const;
export const dianaRequestDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function dianaRequestScopeMatches(left: DaptaEventScope, right: DaptaEventScope) {
  return Boolean(left && right) && scopeKeys.every(key => left[key] === right[key]);
}
export function validateDianaRequestProof(proof: DianaExtensionVerifiedRequest, scope: DaptaEventScope, activatedAt: Date | string, clock: Date) {
  const floor = typeof activatedAt === "string" ? Date.parse(activatedAt) : activatedAt.getTime();
  const at = Date.parse(proof?.messageAt), observed = Date.parse(proof?.observedAt);
  if (!Number.isFinite(floor)) throw new AttentionError("La activación de las prórrogas directas está pendiente.", 503);
  if (!proof || !dianaRequestScopeMatches(proof.scope, scope) || proof.latest !== true
    || ![proof.conversationId, proof.externalConversationId, proof.messageId].every(value => typeof value === "string" && UUID.test(value))
    || !/^[1-9][0-9]{7,14}$/.test(proof.contactId) || proof.phone !== `+${proof.contactId}`
    || typeof proof.textDigest !== "string" || !/^[a-f0-9]{64}$/.test(proof.textDigest)
    || typeof proof.deliveryId !== "string" || !proof.deliveryId || proof.deliveryId.length > 200)
    throw new AttentionError("No fue posible verificar la solicitud real del cliente.", 403);
  if (!Number.isFinite(at) || !Number.isFinite(observed) || at < floor || at > clock.getTime()
    || clock.getTime() - at >= DIANA_REQUEST_MAX_AGE_MS || observed < at || observed > clock.getTime() + 5000
    || clock.getTime() - observed > 30000)
    throw new AttentionError("La solicitud debe verificarse nuevamente en el chat del cliente.", 409);
  const intent = proof.intent;
  if (!intent || !["days", "date"].includes(intent.kind)
    || (intent.kind === "days" && ![1, 2, 3, 4].includes(intent.days))
    || (intent.folio !== undefined && (typeof intent.folio !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(intent.folio))))
    throw new AttentionError("La solicitud no precisa una prórroga válida.", 409);
  if (intent.kind === "date" || intent.date !== undefined) financialDate(intent.date);
}
export function dianaRequestChoice(intent: DianaExtensionRequestIntent, choices: readonly { days: number; expiresOn: string }[]) {
  return choices.find(choice => intent.kind === "date" ? choice.expiresOn === intent.date
    : choice.days === intent.days && (intent.date === undefined || choice.expiresOn === intent.date)) || null;
}
export function dianaRequestHash(proof: DianaExtensionVerifiedRequest) {
  // Neither model arguments, read timestamps nor provider delivery retries can change the authority.
  return dianaRequestDigest({ scope: proof.scope, conversationId: proof.conversationId,
    externalConversationId: proof.externalConversationId, phone: proof.phone, contactId: proof.contactId,
    messageId: proof.messageId, messageAt: proof.messageAt, textDigest: proof.textDigest, intent: proof.intent });
}
export function dianaRequestFollowUp(expiresOn: string) {
  const result = new Date(`${financialDate(expiresOn)}T13:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result;
}
