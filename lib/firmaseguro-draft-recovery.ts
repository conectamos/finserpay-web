import "server-only";

import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import {
  ensureDraftDispatchSchema, finalizeDraftDispatch, getDraftDispatch, getDraftDispatchReceipt,
} from "@/lib/firmaseguro-draft-dispatch-ledger";
import {
  discoverDraftDispatchEvidenceFromProvider, reconcileDraftDispatchFromProviderAsSystem,
} from "@/lib/firmaseguro-draft-reconciliation";
import { getFirmaSeguroProcessForCallback, refreshFirmaSeguroProcess } from "@/lib/firmaseguro-credit";
import { recordVerifiedDraftCorrectionReissues } from "@/lib/firmaseguro-draft-correction-complete";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ATTEMPTS = 12;
const RETRYABLE_CODES = new Set(["PROVIDER_UNAVAILABLE", "EVIDENCE_INSUFFICIENT", "STATUS_MISSING", "STATUS_UNSUPPORTED", "STATUS_CONFLICT", "LOCAL_UNAVAILABLE", "REFRESH_UNAVAILABLE", "CORRELATION_MISSING"]);
type Source = "CALLBACK" | "LOCATOR" | "RECEIPT";
type RecoveryJob = {
  id: string; processUuid: string; dispatchId: string | null; attempts: number; leaseToken: string;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function failure(code: string): never {
  throw Object.assign(new Error(code), { recoveryCode: code });
}

function safeErrorCode(error: unknown) {
  const item = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (typeof item.recoveryCode === "string" && /^[A-Z_]{1,60}$/.test(item.recoveryCode)) return item.recoveryCode;
  const code = typeof item.code === "string" ? item.code : "";
  const remote = code.replace(/^DRAFT_DISPATCH_RECONCILIATION_/, "");
  if (remote !== code && /^[A-Z_]{1,60}$/.test(remote)) return remote;
  return code.startsWith("DRAFT_DISPATCH_") ? "LOCAL_CONFLICT" : "LOCAL_UNAVAILABLE";
}

async function enqueue(input: {
  processUuid: string; dispatchId?: string | null; payloadSha256: string; source: Source;
}) {
  const processUuid = String(input.processUuid || "").trim().toLowerCase();
  const dispatchId = input.dispatchId ? String(input.dispatchId).trim().toLowerCase() : null;
  if (!PROVIDER_UUID.test(processUuid) || (dispatchId && !UUID.test(dispatchId)) || !SHA256.test(input.payloadSha256)) {
    throw new Error("INVALID_SIGNATURE_RECOVERY_CANDIDATE");
  }
  await ensureDraftDispatchSchema();
  return prisma.$transaction(async (db) => {
    const dedupeKey = digest(`${processUuid}:${dispatchId || ""}`);
    const inserted = await db.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO "FirmaSeguroDraftRecovery"
      ("id","dedupeKey","processUuid","dispatchId","payloadSha256","lastDeliverySha256","source","receiptObserved")
      VALUES ($1::uuid,$2,$3,$4::uuid,$5,$5,$6,$7) ON CONFLICT ("dedupeKey") DO NOTHING RETURNING "id"`,
    randomUUID(), dedupeKey, processUuid, dispatchId, input.payloadSha256, input.source, input.source === "RECEIPT");
    const rows = inserted.length ? inserted : await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "FirmaSeguroDraftRecovery" WHERE "dedupeKey"=$1 FOR UPDATE`, dedupeKey);
    const id = rows[0].id;
    if (!inserted.length) {
      // A fresh callback/receipt can wake exhausted transient reads. Permanent
      // correlation conflicts and completed jobs stay closed; original evidence stays immutable.
      await db.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftRecovery" SET
        "status"=CASE WHEN "status" IN ('RETRY','NEEDS_REVIEW') AND "retryable" AND
          ("lastDeliverySha256" IS DISTINCT FROM $2 OR ($3::boolean AND NOT "receiptObserved")) THEN 'RETRY' ELSE "status" END,
        "nextAttemptAt"=CASE WHEN "status" IN ('RETRY','NEEDS_REVIEW') AND "retryable" AND
          ("lastDeliverySha256" IS DISTINCT FROM $2 OR ($3::boolean AND NOT "receiptObserved")) THEN CURRENT_TIMESTAMP ELSE "nextAttemptAt" END,
        "lastDeliverySha256"=$2,"receiptObserved"="receiptObserved" OR $3::boolean,"updatedAt"=CURRENT_TIMESTAMP
        WHERE "id"=$1::uuid`, id, input.payloadSha256, input.source === "RECEIPT");
    }
    await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroDraftRecoveryEvent"("recoveryId","eventType","payloadSha256")
      VALUES ($1::uuid,$2,$3)`, id, inserted.length ? "QUEUED" : "CANDIDATE_RECEIVED", input.payloadSha256);
    return { queued: true, id };
  });
}

/** Caller must authenticate the callback before persisting a candidate. A
 * callback supplies a locator only; linkage always requires fresh provider proof. */
export function enqueueDraftSignatureRecovery(input: {
  processUuid: string; dispatchId?: string | null; payloadSha256: string;
}) {
  return enqueue({ ...input, source: "CALLBACK" });
}

async function seedAcknowledgements(limit: number) {
  const rows = await prisma.$queryRawUnsafe<Array<{ dispatchId: string; processUuid: string; hasReceipt: boolean }>>(
    `SELECT dispatch."id"::text AS "dispatchId", COALESCE(receipt."processUuid",dispatch."processUuid") AS "processUuid",
      receipt."dispatchId" IS NOT NULL AS "hasReceipt"
      FROM "FirmaSeguroDraftDispatch" dispatch LEFT JOIN "FirmaSeguroDraftDispatchReceipt" receipt ON receipt."dispatchId"=dispatch."id"
      WHERE dispatch."status" IN ('DISPATCHING','UNCERTAIN') AND COALESCE(receipt."processUuid",dispatch."processUuid") IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "FirmaSeguroDraftRecovery" job
          WHERE job."dispatchId"=dispatch."id" AND lower(job."processUuid")=lower(COALESCE(receipt."processUuid",dispatch."processUuid"))
            AND NOT (receipt."dispatchId" IS NOT NULL AND NOT job."receiptObserved" AND job."retryable" AND job."status" IN ('RETRY','NEEDS_REVIEW')))
      ORDER BY (receipt."dispatchId" IS NOT NULL) DESC,dispatch."createdAt",dispatch."id" LIMIT $1`, limit);
  for (const row of rows) await enqueue({ ...row, source: row.hasReceipt ? "RECEIPT" : "LOCATOR",
    payloadSha256: digest(`durable-provider-locator:${row.dispatchId}:${row.processUuid}`) });
}

async function claim(): Promise<RecoveryJob | null> {
  return prisma.$transaction(async (db) => {
    const token = randomUUID();
    const rows = await db.$queryRawUnsafe<RecoveryJob[]>(`WITH candidate AS (
      SELECT "id" FROM "FirmaSeguroDraftRecovery" WHERE
        (("status" IN ('QUEUED','RETRY') AND "nextAttemptAt"<=CURRENT_TIMESTAMP)
          OR ("status"='PROCESSING' AND "leaseUntil"<CURRENT_TIMESTAMP))
      ORDER BY "receiptObserved" DESC,"nextAttemptAt","createdAt","id"
      FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE "FirmaSeguroDraftRecovery" job SET "status"='PROCESSING',"leaseToken"=$1::uuid,
        "leaseUntil"=CURRENT_TIMESTAMP+INTERVAL '2 minutes',"attempts"="attempts"+1,"updatedAt"=CURRENT_TIMESTAMP
      FROM candidate WHERE job."id"=candidate."id" RETURNING job."id"::text,job."processUuid",job."dispatchId"::text,job."attempts",job."leaseToken"::text`, token);
    if (!rows[0]) return null;
    await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroDraftRecoveryEvent"("recoveryId","eventType") VALUES ($1::uuid,'CLAIMED')`, rows[0].id);
    return rows[0];
  });
}

async function complete(job: RecoveryJob, input: { dispatchId?: string; errorCode?: string }) {
  const retryable = Boolean(input.errorCode && RETRYABLE_CODES.has(input.errorCode));
  const status = !input.errorCode ? "RECOVERED" : retryable && job.attempts < MAX_ATTEMPTS ? "RETRY" : "NEEDS_REVIEW";
  const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(job.attempts - 1, 7));
  return prisma.$transaction(async (db) => {
    const updated = await db.$queryRawUnsafe<Array<{ id: string }>>(`UPDATE "FirmaSeguroDraftRecovery" SET
      "status"=$3,"retryable"=$4,"lastErrorCode"=$5,"resolvedDispatchId"=COALESCE($6::uuid,"resolvedDispatchId"),
      "nextAttemptAt"=CURRENT_TIMESTAMP+($7::integer*INTERVAL '1 second'),"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1::uuid AND "leaseToken"=$2::uuid AND "status"='PROCESSING' RETURNING "id"`,
    job.id, job.leaseToken, status, retryable, input.errorCode || null, input.dispatchId || null, delaySeconds);
    if (updated.length) await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroDraftRecoveryEvent"("recoveryId","eventType","errorCode")
      VALUES ($1::uuid,$2,$3)`, job.id, status, input.errorCode || null);
    return updated.length ? status : null;
  });
}

async function resolveDispatch(job: RecoveryJob) {
  if (job.dispatchId) return job.dispatchId;
  const evidence = await discoverDraftDispatchEvidenceFromProvider(job.processUuid);
  if (evidence.dispatchId) return evidence.dispatchId;
  if (!evidence.originalPdfHashes.length) failure("CORRELATION_MISSING");
  const matches = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id"::text FROM "FirmaSeguroDraftDispatch"
    WHERE "status" IN ('DISPATCHING','UNCERTAIN','AWAITING_SIGNATURE') AND "documentHash"=ANY($1::text[]) LIMIT 2`, evidence.originalPdfHashes);
  if (matches.length > 1) failure("CONFLICT");
  if (!matches[0]) failure("CORRELATION_MISSING");
  return matches[0].id;
}

async function recover(job: RecoveryJob) {
  const dispatchId = await resolveDispatch(job);
  const row = await getDraftDispatch(dispatchId);
  if (!row) failure("NOT_FOUND");
  if (row.processUuid && row.processUuid.toLowerCase() !== job.processUuid) failure("UUID_MISMATCH");
  const receipt = await getDraftDispatchReceipt(dispatchId);
  if (receipt && receipt.processUuid.toLowerCase() !== job.processUuid) failure("UUID_MISMATCH");
  const result = receipt ? await finalizeDraftDispatch(dispatchId)
    : await reconcileDraftDispatchFromProviderAsSystem({ dispatchId, processUuid: job.processUuid });
  if (!["AWAITING_SIGNATURE", "FAILED_SAFE"].includes(result.status)) failure("LOCAL_CONFLICT");
  if (result.status === "AWAITING_SIGNATURE") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const process = await getFirmaSeguroProcessForCallback(result.processUuid || receipt?.processUuid || row.processUuid || job.processUuid);
      if (!process) failure("LOCAL_UNAVAILABLE");
      const refreshed = await Promise.race([
        refreshFirmaSeguroProcess(process, { providerTimeoutMs: 10_000,
          documentReadBudgetMs: 25_000, maxDocumentCandidates: 1 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("REFRESH_UNAVAILABLE")), 45_000);
        }),
      ]);
      if (!refreshed || refreshed.lastError) failure("REFRESH_UNAVAILABLE");
      await recordVerifiedDraftCorrectionReissues(refreshed);
    } catch { failure("REFRESH_UNAVAILABLE"); }
    finally { if (timer) clearTimeout(timer); }
  }
  return dispatchId;
}

/** Local writes plus authenticated provider GETs only. This worker has no path
 * to prepare/send/create a signature, including expired leases and failed reads. */
export async function runDraftSignatureRecovery(options: { limit?: number } = {}) {
  const limit = Math.min(20, Math.max(1, Math.trunc(options.limit || 5)));
  await ensureDraftDispatchSchema();
  await seedAcknowledgements(limit);
  const summary = { selected: 0, recovered: 0, deferred: 0, needsReview: 0 };
  for (let index = 0; index < limit; index++) {
    const job = await claim();
    if (!job) break;
    summary.selected += 1;
    try {
      const dispatchId = await recover(job);
      if (await complete(job, { dispatchId })) summary.recovered += 1;
    } catch (error) {
      const status = await complete(job, { errorCode: safeErrorCode(error) });
      if (status === "NEEDS_REVIEW") summary.needsReview += 1;
      else if (status) summary.deferred += 1;
    }
  }
  return summary;
}
