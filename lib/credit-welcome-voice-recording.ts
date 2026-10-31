import "server-only";

type RecordingReader = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};
type RecordingDatabase = RecordingReader & {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/** Human case results remain human evidence; never synthesize a provider call. */
export async function readSavedHumanWelcomeOutcome(db: RecordingReader, creditId: number): Promise<"HUMAN_CONTACT" | "OPT_OUT" | null> {
  if (!Number.isSafeInteger(creditId) || creditId < 1 || creditId > 2_147_483_647) return null;
  const [schema] = await db.$queryRawUnsafe<Array<{ ready: boolean }>>(`SELECT
    to_regclass('public."AttentionWorkRequest"') IS NOT NULL AND to_regclass('public."AttentionAudit"') IS NOT NULL AS ready`);
  if (!schema?.ready) return null;
  const [result] = await db.$queryRawUnsafe<Array<{ outcome: string }>>(`SELECT a.metadata->'result'->>'outcome' AS outcome
    FROM "AttentionWorkRequest" w JOIN "AttentionAudit" a ON a."conversationId"=w."conversationId"
    WHERE w.kind='welcome' AND w."targetSource"='C' AND w."targetId"=$1 AND a.action='WORK_WORKFLOW'
      AND a.metadata->'result'->>'action'='WELCOME_RESULT' AND a.metadata->'result'->>'mode'='human'
      AND a.metadata->'result'->>'outcome' IN ('HUMAN_CONTACT','OPT_OUT')
    ORDER BY CASE WHEN a.metadata->'result'->>'outcome'='OPT_OUT' THEN 0 ELSE 1 END LIMIT 1`, creditId);
  return result?.outcome === "OPT_OUT" || result?.outcome === "HUMAN_CONTACT" ? result.outcome : null;
}

/** A manually saved approval recording is evidence even after a review changes. */
export async function hasSavedCreditApprovalCallRecording(db: RecordingReader, creditId: number): Promise<boolean> {
  if (!Number.isSafeInteger(creditId) || creditId < 1 || creditId > 2_147_483_647) return false;
  const [table] = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('public."CreditApprovalCallRecording"') IS NOT NULL AS "present"`,
  );
  if (!table?.present) return false;
  const [saved] = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM "CreditApprovalCallRecording" WHERE "creditoId"=$1) AS "present"`, creditId,
  );
  return saved?.present === true;
}

/**
 * Runs in the caller's transaction. Uploads already hold the credit lock, while
 * claimers can hold queue rows first; SKIP LOCKED prevents that inverse order
 * from deadlocking. Every automatic claimant also checks the saved recording.
 * Never relabel a request that might already have reached the provider.
 */
export async function stopAutomaticCreditWelcomeCallsForRecording(
  db: RecordingDatabase, creditId: number, now: Date,
): Promise<void> {
  if (!await hasSavedCreditApprovalCallRecording(db, creditId)) return;
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid recording stop time");
  const [tables] = await db.$queryRawUnsafe<Array<{ followup: boolean; members: boolean; events: boolean }>>(
    `SELECT to_regclass('public."CreditWelcomeVoiceFollowup"') IS NOT NULL AS "followup",
      to_regclass('public."VoiceReviewCampaignMember"') IS NOT NULL AS "members",
      to_regclass('public."CreditWelcomeVoiceEvent"') IS NOT NULL AS "events"`,
  );
  if (tables?.followup) await db.$executeRawUnsafe(`WITH targets AS (
      SELECT "creditoId" FROM "CreditWelcomeVoiceFollowup"
      WHERE "creditoId"=$1 AND "phase" IN ('FAST','PENDING','HELD') FOR UPDATE SKIP LOCKED
    ) UPDATE "CreditWelcomeVoiceFollowup" f SET "phase"='STOPPED',"reason"='CALL_RECORDING_SAVED',
      "nextAttemptAt"=NULL,"updatedAt"=$2 FROM targets t WHERE f."creditoId"=t."creditoId"`, creditId, now);
  if (tables?.members) await db.$executeRawUnsafe(`WITH targets AS (
      SELECT "campaignId","creditoId" FROM "VoiceReviewCampaignMember"
      WHERE "creditoId"=$1 AND "state" IN ('ACTIVE','HELD')
        AND "stopReason" IS DISTINCT FROM 'OPERATOR_EXCLUDED' ORDER BY "campaignId" FOR UPDATE SKIP LOCKED
    ) UPDATE "VoiceReviewCampaignMember" m SET "state"='STOPPED',"stopReason"='CALL_RECORDING_SAVED',
      "updatedAt"=$2 FROM targets t WHERE m."campaignId"=t."campaignId" AND m."creditoId"=t."creditoId"`, creditId, now);
  if (tables?.events) await db.$executeRawUnsafe(`WITH targets AS (
      SELECT "id" FROM "CreditWelcomeVoiceEvent" WHERE "creditoId"=$1 AND "status"='PENDING'
        AND "source" IN ('NORMAL','INDIVIDUAL_IMPORT','AUTOMATIC_RETRY','SCHEDULED_CAMPAIGN')
      ORDER BY "id" FOR UPDATE SKIP LOCKED
    ) UPDATE "CreditWelcomeVoiceEvent" e SET "status"='CANCELLED',"resultCode"='CALL_RECORDING_SAVED',
      "updatedAt"=$2 FROM targets t WHERE e."id"=t."id"`, creditId, now);
}
