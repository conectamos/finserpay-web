import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { colombiaDateKey } from "@/lib/colombia-date";
import { ensureMoraMessageProtection, getActiveMoraMessageProtectionIds, hasActiveMoraMessageProtection } from "@/lib/mora-message-protection";
import { getCuotaVencidaWhatsAppCandidate, groupCuotaVencidaWhatsAppCandidates,
  type CuotaVencidaWhatsAppCandidate } from "@/lib/cuotavencida-whatsapp-policy";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 250;
const LEASE_MS = 90_000;
const creditSelect = { id: true, clienteNombre: true, clienteDocumento: true, clienteTelefono: true, estado: true,
  pazYSalvoEmitidoAt: true, planCapitalVigente: true, montoCredito: true, valorCuota: true, plazoMeses: true,
  frecuenciaPago: true, fechaPrimerPago: true, fechaProximoPago: true,
  abonos: { where: { estado: { not: "ANULADO" } }, select: { valor: true, fechaAbono: true, estado: true } },
} as const;
const digest = (value: string) => createHash("sha256").update("finserpay-cuotavencida:" + value).digest("hex");
type RawReader = Pick<typeof prisma, "$queryRawUnsafe">;
type EventRow = { id: string; batchId: string; campaignDate: string; debtorKey: string; recipientKey: string;
  phone: string; name: string; status: string; claimExpiresAt: Date | string | null };
type Stats = { scanned: number; eligibleCredits: number; clients: number; excludedCredits: number; sharedPhoneCredits: number; excludedActiveMoraProtection?: number };
export type CuotaVencidaWhatsAppSummary = {
  id: string; campaignDate: string; dateKey: string; createdAt: string; status: "QUEUED" | "RUNNING" | "COMPLETED";
  stats: Stats; total: number; pending: number; processing: number; accepted: number; failed: number; unknown: number; skipped: number;
};
export type CuotaVencidaWhatsAppClaim = { eventId: string; batchId: string };
export type CuotaVencidaWhatsAppPrepared = CuotaVencidaWhatsAppClaim & { phone: string; name: string; campaignDate: string };
export class CuotaVencidaWhatsAppError extends Error {
  constructor(public code: string) { super(code); this.name = "CuotaVencidaWhatsAppError"; }
}
function requireUuid(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new CuotaVencidaWhatsAppError("INVALID_REQUEST");
}
function safeStats(value: unknown): Stats {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (key: string) => Number.isSafeInteger(source[key]) && Number(source[key]) >= 0 ? Number(source[key]) : 0;
  return { scanned: number("scanned"), eligibleCredits: number("eligibleCredits"), clients: number("clients"),
    excludedCredits: number("excludedCredits"), sharedPhoneCredits: number("sharedPhoneCredits"),
    ...(Number.isSafeInteger(source.excludedActiveMoraProtection) && Number(source.excludedActiveMoraProtection) >= 0
      ? { excludedActiveMoraProtection: Number(source.excludedActiveMoraProtection) } : {}),
  };
}
async function summary(db: RawReader, batchId: string | null): Promise<CuotaVencidaWhatsAppSummary | null> {
  const [row] = await db.$queryRawUnsafe<Array<{ id: string; campaignDate: string; createdAt: Date | string; stats: unknown;
    total: number; pending: number; processing: number; accepted: number; failed: number; unknown: number; cancelled: number }>>(
    `SELECT b."id"::text,b."campaignDate"::text,b."createdAt",b."stats",count(e."id")::int AS total,
      count(e."id") FILTER (WHERE e."status"='PENDING')::int AS pending,
      count(e."id") FILTER (WHERE e."status"='CLAIMED')::int AS processing,
      count(e."id") FILTER (WHERE e."status"='ACCEPTED')::int AS accepted,
      count(e."id") FILTER (WHERE e."status"='FAILED')::int AS failed,
      count(e."id") FILTER (WHERE e."status"='UNKNOWN')::int AS unknown,
      count(e."id") FILTER (WHERE e."status"='CANCELLED')::int AS cancelled
     FROM "CuotaVencidaWhatsAppBatch" b LEFT JOIN "CuotaVencidaWhatsAppEvent" e ON e."batchId"=b."id"
     WHERE ($1::uuid IS NULL OR b."id"=$1::uuid) GROUP BY b."id" ORDER BY b."createdAt" DESC,b."id" DESC LIMIT 1`, batchId,
  );
  if (!row) return null;
  const { total, pending, processing, accepted, failed, unknown, cancelled } = row;
  return { id: row.id, campaignDate: row.campaignDate, dateKey: row.campaignDate, createdAt: new Date(row.createdAt).toISOString(),
    status: processing ? "RUNNING" : pending ? "QUEUED" : "COMPLETED", stats: safeStats(row.stats),
    total, pending: pending + processing, processing, accepted, failed, unknown, skipped: cancelled };
}

export function createCuotaVencidaWhatsAppStore(deps: {
  database?: typeof prisma; now?: () => Date; enabled?: () => boolean;
} = {}) {
  const database = deps.database ?? prisma, now = deps.now ?? (() => new Date());
  const enabled = deps.enabled ?? (() => process.env.DAPTA_CUOTAVENCIDA_ENABLED === "true");
  async function scan() {
    await ensureMoraMessageProtection();
    const at = now(), candidates: CuotaVencidaWhatsAppCandidate[] = [];
    let cursor = 0, scanned = 0, excludedActiveMoraProtection = 0;
    for (;;) {
      const credits = await database.credito.findMany({ where: { id: { gt: cursor } }, orderBy: { id: "asc" }, take: PAGE_SIZE, select: creditSelect });
      if (!credits.length) break;
      const protectedIds = await getActiveMoraMessageProtectionIds(credits, database);
      for (const credit of credits) {
        if (!Number.isSafeInteger(credit.id) || credit.id <= cursor) throw new CuotaVencidaWhatsAppError("INVALID_SCAN_CURSOR");
        cursor = credit.id; scanned++;
        const candidate = getCuotaVencidaWhatsAppCandidate(credit, at);
        if (candidate && protectedIds.has(credit.id)) { excludedActiveMoraProtection++; continue; }
        if (candidate) candidates.push(candidate);
      }
    }
    const grouped = groupCuotaVencidaWhatsAppCandidates(candidates);
    const stats: Stats = { scanned, eligibleCredits: candidates.length, clients: grouped.groups.length,
      excludedCredits: scanned - candidates.length, sharedPhoneCredits: grouped.sharedPhoneCredits, excludedActiveMoraProtection };
    return { ...grouped, stats, campaignDate: colombiaDateKey(at) };
  }
  async function previewCuotaVencidaWhatsApp() {
    const result = await scan(); return { campaignDate: result.campaignDate, stats: result.stats };
  }
  async function getCuotaVencidaWhatsAppBatch(input: { batchId?: string } = {}) {
    if (input.batchId !== undefined) requireUuid(input.batchId);
    return summary(database, input.batchId ?? null);
  }
  async function createCuotaVencidaWhatsAppBatch(input: { requestId: string; actorId: number }) {
    requireUuid(input.requestId);
    if (!Number.isSafeInteger(input.actorId) || input.actorId < 1 || input.actorId > 2_147_483_647) throw new CuotaVencidaWhatsAppError("INVALID_REQUEST");
    if (!enabled()) throw new CuotaVencidaWhatsAppError("DISABLED");
    const byRequest = await database.$queryRawUnsafe<Array<{ id: string; actorId: number }>>(
      `SELECT "id"::text,"actorId" FROM "CuotaVencidaWhatsAppBatch" WHERE "requestId"=$1::uuid`, input.requestId,
    );
    if (byRequest[0]) {
      if (byRequest[0].actorId !== input.actorId) throw new CuotaVencidaWhatsAppError("REQUEST_SCOPE_MISMATCH");
      return { created: false, batch: (await summary(database, byRequest[0].id))! };
    }
    const day = colombiaDateKey(now());
    const [existing] = await database.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id"::text FROM "CuotaVencidaWhatsAppBatch" WHERE "campaignDate"=$1::date`, day,
    );
    if (existing) return { created: false, batch: (await summary(database, existing.id))! };
    const selected = await scan();
    const result = await database.$transaction(async tx => {
      // A request UUID cannot acquire two dates across a midnight race.
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text`, "cuotavencida-request:" + input.requestId.toLowerCase());
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text`, "cuotavencida-date:" + selected.campaignDate);
      if (colombiaDateKey(now()) !== selected.campaignDate) throw new CuotaVencidaWhatsAppError("DAY_CHANGED");
      const [replayed] = await tx.$queryRawUnsafe<Array<{ id: string; actorId: number }>>(
        `SELECT "id"::text,"actorId" FROM "CuotaVencidaWhatsAppBatch" WHERE "requestId"=$1::uuid`, input.requestId,
      );
      if (replayed) {
        if (replayed.actorId !== input.actorId) throw new CuotaVencidaWhatsAppError("REQUEST_SCOPE_MISMATCH");
        return { id: replayed.id, created: false };
      }
      const [daily] = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id"::text FROM "CuotaVencidaWhatsAppBatch" WHERE "campaignDate"=$1::date`, selected.campaignDate);
      if (daily) return { id: daily.id, created: false };
      const id = randomUUID(), createdAt = now();
      await tx.$executeRawUnsafe(`INSERT INTO "CuotaVencidaWhatsAppBatch" ("id","requestId","actorId","campaignDate","stats","createdAt")
        VALUES($1::uuid,$2::uuid,$3,$4::date,$5::jsonb,$6)`, id, input.requestId, input.actorId, selected.campaignDate, JSON.stringify(selected.stats), createdAt);
      for (let offset = 0; offset < selected.groups.length; offset += PAGE_SIZE) {
        const rows = selected.groups.slice(offset, offset + PAGE_SIZE).map(group => ({ id: randomUUID(), batchId: id,
          campaignDate: selected.campaignDate, debtorKey: digest(group.identityKey), recipientKey: digest("phone:" + group.phone),
          phone: group.phone, name: group.name, representativeCreditoId: group.representativeCreditId, createdAt,
          creditIds: group.creditIds }));
        await tx.$executeRawUnsafe(`INSERT INTO "CuotaVencidaWhatsAppEvent"
          ("id","batchId","campaignDate","debtorKey","recipientKey","phone","name","representativeCreditoId","createdAt","updatedAt")
          SELECT x."id",x."batchId",x."campaignDate",x."debtorKey",x."recipientKey",x."phone",x."name",x."representativeCreditoId",x."createdAt",x."createdAt"
          FROM jsonb_to_recordset($1::jsonb) AS x("id" uuid,"batchId" uuid,"campaignDate" date,"debtorKey" text,"recipientKey" text,
            "phone" text,"name" text,"representativeCreditoId" int,"createdAt" timestamptz)`, JSON.stringify(rows));
        const coverage = rows.flatMap(row => row.creditIds.map(creditoId => ({ eventId: row.id, creditoId })));
        for (let start = 0; start < coverage.length; start += PAGE_SIZE) await tx.$executeRawUnsafe(
          `INSERT INTO "CuotaVencidaWhatsAppCoverage" ("eventId","creditoId") SELECT x."eventId",x."creditoId"
           FROM jsonb_to_recordset($1::jsonb) AS x("eventId" uuid,"creditoId" int)`, JSON.stringify(coverage.slice(start, start + PAGE_SIZE)));
      }
      return { id, created: true };
    }, { timeout: 120_000 });
    return { created: result.created, batch: (await summary(database, result.id))! };
  }
  async function claimCuotaVencidaWhatsApp(input: { limit?: number } = {}): Promise<CuotaVencidaWhatsAppClaim[]> {
    if (!enabled()) return [];
    const at = now(), day = colombiaDateKey(at), limit = Math.min(10, Math.max(1, Math.trunc(input.limit ?? 10)));
    if (!Number.isFinite(limit)) throw new CuotaVencidaWhatsAppError("INVALID_LIMIT");
    return database.$transaction(async tx => {
      await tx.$executeRawUnsafe(`UPDATE "CuotaVencidaWhatsAppEvent" SET "status"='UNKNOWN',"resultCode"='CLAIM_EXPIRED',"finishedAt"=$1,"updatedAt"=$1
        WHERE "status"='CLAIMED' AND "claimExpiresAt"<=$1`, at);
      await tx.$executeRawUnsafe(`UPDATE "CuotaVencidaWhatsAppEvent" SET "status"='CANCELLED',"resultCode"='BATCH_DAY_ENDED',"finishedAt"=$1,"updatedAt"=$1
        WHERE "status"='PENDING' AND "campaignDate"<$2::date`, at, day);
      await tx.$executeRawUnsafe(`UPDATE "CuotaVencidaWhatsAppEvent" e SET "status"='CANCELLED',"resultCode"='PREVIOUS_OUTCOME_UNRESOLVED',"finishedAt"=$1,"updatedAt"=$1
        WHERE e."status"='PENDING' AND e."campaignDate"=$2::date AND EXISTS (SELECT 1 FROM "CuotaVencidaWhatsAppEvent" other
          WHERE other."id"<>e."id" AND (other."debtorKey"=e."debtorKey" OR other."recipientKey"=e."recipientKey") AND other."status"='UNKNOWN')`, at, day);
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; batchId: string }>>(`SELECT e."id"::text,e."batchId"::text
        FROM "CuotaVencidaWhatsAppEvent" e WHERE e."status"='PENDING' AND e."campaignDate"=$1::date
        AND NOT EXISTS (SELECT 1 FROM "CuotaVencidaWhatsAppEvent" other WHERE other."id"<>e."id"
          AND (other."debtorKey"=e."debtorKey" OR other."recipientKey"=e."recipientKey") AND other."status" IN ('CLAIMED','UNKNOWN'))
        ORDER BY e."createdAt",e."id" LIMIT $2 FOR UPDATE OF e SKIP LOCKED`, day, limit);
      const claims: CuotaVencidaWhatsAppClaim[] = [];
      for (const row of rows) {
        await tx.$executeRawUnsafe(`UPDATE "CuotaVencidaWhatsAppEvent" SET "status"='CLAIMED',"claimedAt"=$2,"claimExpiresAt"=$3,"updatedAt"=$2 WHERE "id"=$1::uuid AND "status"='PENDING'`,
          row.id, at, new Date(at.getTime() + LEASE_MS));
        claims.push({ eventId: row.id, batchId: row.batchId });
      }
      return claims;
    }, { timeout: 30_000 });
  }
  async function prepareCuotaVencidaWhatsAppDispatch(eventId: string,
    dispatch?: (prepared: CuotaVencidaWhatsAppPrepared) => Promise<void>,
  ): Promise<CuotaVencidaWhatsAppPrepared | null> {
    requireUuid(eventId); if (!enabled()) return null;
    await ensureMoraMessageProtection();
    return database.$transaction(async tx => {
      const [event] = await tx.$queryRawUnsafe<EventRow[]>(`SELECT "id"::text,"batchId"::text,"campaignDate"::text,"debtorKey","recipientKey","phone","name","status","claimExpiresAt"
        FROM "CuotaVencidaWhatsAppEvent" WHERE "id"=$1::uuid FOR UPDATE`, eventId);
      if (!event || event.status !== "CLAIMED") return null;
      const cancel = async (code: string) => {
        await tx.$executeRawUnsafe(`UPDATE "CuotaVencidaWhatsAppEvent" SET "status"='CANCELLED',"resultCode"=$2,"finishedAt"=$3,"updatedAt"=$3
          WHERE "id"=$1::uuid AND "status"='CLAIMED'`, eventId, code, now()); return null;
      };
      if (event.campaignDate !== colombiaDateKey(now()) || !event.claimExpiresAt || new Date(event.claimExpiresAt).getTime() <= now().getTime()) return cancel("CLAIM_NOT_CURRENT");
      const coverage = await tx.$queryRawUnsafe<Array<{ creditoId: number }>>(`SELECT "creditoId" FROM "CuotaVencidaWhatsAppCoverage" WHERE "eventId"=$1::uuid ORDER BY "creditoId"`, eventId);
      const samePhone = await tx.$queryRawUnsafe<Array<{ id: number }>>(`SELECT "id" FROM "Credito"
        WHERE regexp_replace(COALESCE("clienteTelefono",''),'[^0-9]','','g') IN ($1,$2) ORDER BY "id"`, event.phone, event.phone.slice(2));
      const coverageIds = new Set(coverage.map(item => item.creditoId));
      const lockIds = [...new Set([...coverageIds, ...samePhone.map(item => item.id)])].sort((a, b) => a - b);
      for (const id of lockIds) await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, id);
      const candidates: CuotaVencidaWhatsAppCandidate[] = [];
      const currentOwners = new Set<string>();
      let protectedCoverage = false;
      for (const creditoId of lockIds) {
        const current = await tx.credito.findUnique({ where: { id: creditoId }, select: creditSelect });
        const candidate = current && getCuotaVencidaWhatsAppCandidate(current, now());
        if (candidate?.phone === event.phone && candidate.document) currentOwners.add(candidate.document);
        if (candidate && coverageIds.has(creditoId) && await hasActiveMoraMessageProtection(creditoId, current!.clienteDocumento, tx)) {
          protectedCoverage = true;
          continue;
        }
        if (candidate && coverageIds.has(creditoId)) candidates.push(candidate);
      }
      if (currentOwners.size > 1) return cancel("SHARED_PHONE");
      const group = groupCuotaVencidaWhatsAppCandidates(candidates).groups.find(item => digest(item.identityKey) === event.debtorKey && item.phone === event.phone);
      if (!group) return cancel(protectedCoverage ? "ACTIVE_MORA_PROTECTION" : "NO_LONGER_ELIGIBLE");
      const at = now();
      if (event.campaignDate !== colombiaDateKey(at) || new Date(event.claimExpiresAt).getTime() <= at.getTime()) return cancel("CLAIM_NOT_CURRENT");
      const [blocked] = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(`SELECT EXISTS(SELECT 1 FROM "CuotaVencidaWhatsAppEvent"
        WHERE "id"<>$1::uuid AND ("debtorKey"=$2 OR "recipientKey"=$3) AND "status" IN ('CLAIMED','UNKNOWN')) AS present`, eventId, event.debtorKey, event.recipientKey);
      if (blocked?.present) return cancel("PREVIOUS_OUTCOME_UNRESOLVED");
      await tx.$executeRawUnsafe(`UPDATE "CuotaVencidaWhatsAppEvent" SET "name"=$2,"representativeCreditoId"=$3,"updatedAt"=$4 WHERE "id"=$1::uuid AND "status"='CLAIMED'`, eventId, group.name, group.representativeCreditId, at);
      const prepared = { eventId: event.id, batchId: event.batchId, phone: event.phone, name: group.name, campaignDate: event.campaignDate };
      // Approval and sending serialize on the same credit row. Never release its
      // lock between checking a prórroga and starting the bounded HTTP request.
      if (dispatch) await dispatch(prepared);
      return prepared;
    }, { timeout: 30_000 });
  }
  async function releaseCuotaVencidaWhatsAppClaim(eventId: string) {
    requireUuid(eventId);
    return database.$executeRawUnsafe(`UPDATE "CuotaVencidaWhatsAppEvent" SET "status"='PENDING',"claimedAt"=NULL,"claimExpiresAt"=NULL,"updatedAt"=$2
      WHERE "id"=$1::uuid AND "status"='CLAIMED'`, eventId, now());
  }
  async function finish(eventId: string, status: "ACCEPTED" | "FAILED" | "UNKNOWN", code: string, providerMessageId: string | null = null) {
    requireUuid(eventId);
    return database.$executeRawUnsafe(`UPDATE "CuotaVencidaWhatsAppEvent" SET "status"=$2,"resultCode"=$3,"providerMessageId"=$4,"finishedAt"=$5,"updatedAt"=$5
      WHERE "id"=$1::uuid AND "status"='CLAIMED'`, eventId, status, code, providerMessageId, now());
  }
  const markCuotaVencidaWhatsAppAccepted = (eventId: string, providerMessageId: string) => {
    if (!safeCuotaVencidaProviderMessageId(providerMessageId)) throw new CuotaVencidaWhatsAppError("INVALID_RECEIPT");
    return finish(eventId, "ACCEPTED", "PROVIDER_ACCEPTED", providerMessageId);
  };
  const markCuotaVencidaWhatsAppFailed = (eventId: string) => finish(eventId, "FAILED", "PROVIDER_REJECTED");
  const markCuotaVencidaWhatsAppUnknown = (eventId: string) => finish(eventId, "UNKNOWN", "PROVIDER_OUTCOME_UNKNOWN");
  return { previewCuotaVencidaWhatsApp, getCuotaVencidaWhatsAppBatch, createCuotaVencidaWhatsAppBatch, claimCuotaVencidaWhatsApp,
    prepareCuotaVencidaWhatsAppDispatch, releaseCuotaVencidaWhatsAppClaim, markCuotaVencidaWhatsAppAccepted,
    markCuotaVencidaWhatsAppFailed, markCuotaVencidaWhatsAppUnknown };
}
export function safeCuotaVencidaProviderMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:+=/-]{0,199}$/.test(value);
}
const store = createCuotaVencidaWhatsAppStore();
export const { previewCuotaVencidaWhatsApp, getCuotaVencidaWhatsAppBatch, createCuotaVencidaWhatsAppBatch,
  claimCuotaVencidaWhatsApp, prepareCuotaVencidaWhatsAppDispatch, releaseCuotaVencidaWhatsAppClaim,
  markCuotaVencidaWhatsAppAccepted, markCuotaVencidaWhatsAppFailed, markCuotaVencidaWhatsAppUnknown } = store;
