// Additive call evidence: existing decisions retain a null recording pointer.
function constraint(table, name, definition) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}' AND conrelid='public."${table}"'::regclass)
    THEN ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" ${definition}; END IF; END $$`;
}
export const creditApprovalCallSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalCallRecording" (
    "id" UUID PRIMARY KEY,"creditoId" INTEGER NOT NULL,"revision" INTEGER NOT NULL,"reviewHash" VARCHAR(64) NOT NULL,
    "fileName" VARCHAR(160) NOT NULL,"mimeType" VARCHAR(32) NOT NULL,"sizeBytes" INTEGER NOT NULL,"sha256" VARCHAR(64) NOT NULL,
    "bytes" BYTEA NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "actorUserId" INTEGER,"actorName" VARCHAR(160) NOT NULL,"actorKind" VARCHAR(16) NOT NULL,
    "actorGrantId" UUID,"actorSessionId" UUID,"idempotencyKey" UUID NOT NULL)`,
  `ALTER TABLE public."CreditApprovalCallRecording" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_creditoId_fkey", `FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id") ON DELETE RESTRICT`),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_actorUserId_fkey", `FOREIGN KEY ("actorUserId") REFERENCES public."Usuario"("id") ON DELETE RESTRICT`),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_shared_actor_fkey", `FOREIGN KEY ("actorSessionId","actorGrantId") REFERENCES public."CreditApprovalSharedSession"("id","grantId") ON DELETE RESTRICT`),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_revision_check", `CHECK ("revision">0)`),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_hash_check", `CHECK ("reviewHash" ~ '^[a-f0-9]{64}$' AND "sha256" ~ '^[a-f0-9]{64}$')`),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_file_check", `CHECK (LENGTH(BTRIM("fileName")) BETWEEN 1 AND 160 AND "mimeType" IN ('audio/mpeg','audio/mp4','audio/wav'))`),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_bytes_check", `CHECK ("sizeBytes" BETWEEN 1 AND 10485760 AND octet_length("bytes")="sizeBytes" AND encode(sha256("bytes"),'hex')="sha256")`),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_actor_check", `CHECK (LENGTH(BTRIM("actorName"))>0 AND (
    ("actorKind"='USER' AND "actorUserId" IS NOT NULL AND "actorUserId">0 AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
    OR ("actorKind"='SHARED_LINK' AND "actorUserId" IS NULL AND "actorGrantId" IS NOT NULL AND "actorSessionId" IS NOT NULL)))`),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalCallRecording_idempotencyKey_key" ON public."CreditApprovalCallRecording"("idempotencyKey")`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalCallRecording_current_idx" ON public."CreditApprovalCallRecording"("creditoId","revision","reviewHash","createdAt" DESC,"id" DESC)`,
  `ALTER TABLE public."CreditApprovalReview" ADD COLUMN IF NOT EXISTS "callRecordingId" UUID`,
  `ALTER TABLE public."CreditApprovalEvent" ADD COLUMN IF NOT EXISTS "callRecordingId" UUID`,
  ...["CreditApprovalReview","CreditApprovalEvent"].map(table => constraint(table, `${table}_callRecordingId_fkey`, `FOREIGN KEY ("callRecordingId") REFERENCES public."CreditApprovalCallRecording"("id") ON DELETE RESTRICT`)),
  `CREATE OR REPLACE FUNCTION public.credit_approval_call_recording_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE current_review public."CreditApprovalReview"%ROWTYPE; previous_time TIMESTAMP(3);
    BEGIN
      PERFORM 1 FROM public."Credito" WHERE "id"=NEW."creditoId" FOR UPDATE;
      SELECT * INTO current_review FROM public."CreditApprovalReview" WHERE "creditoId"=NEW."creditoId" FOR UPDATE;
      IF NOT FOUND OR current_review."status"<>'PENDING' OR current_review."revision"<>NEW."revision"
        OR NOT public.credit_approval_is_required(NEW."creditoId")
        OR EXISTS (SELECT 1 FROM public."LiquidacionAliadoCredito" WHERE "creditoId"=NEW."creditoId")
        OR EXISTS (SELECT 1 FROM public."Credito" WHERE "id"=NEW."creditoId" AND UPPER(BTRIM(COALESCE("estado",''))) IN ('ANULADO','ANULADA','CANCELADO','CANCELADA'))
        OR EXISTS (SELECT 1 FROM public."Credito" credit JOIN public."Sede" site ON site."id"=credit."sedeId"
          JOIN public."Aliado" ally ON ally."id"=site."aliadoId" WHERE credit."id"=NEW."creditoId" AND UPPER(BTRIM(ally."codigo"))='FINSERPAY')
        OR EXISTS (SELECT 1 FROM public."CreditApprovalReissue" WHERE "creditoId"=NEW."creditoId"
          AND "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN'))
        THEN RAISE EXCEPTION 'CALL_RECORDING_NOT_ALLOWED' USING ERRCODE='23514'; END IF;
      SELECT MAX("createdAt") INTO previous_time FROM public."CreditApprovalCallRecording" WHERE "creditoId"=NEW."creditoId";
      -- Strict ordering survives millisecond precision and transactions started earlier.
      NEW."createdAt":=GREATEST(clock_timestamp() AT TIME ZONE 'UTC',previous_time+INTERVAL '1 millisecond');
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalCallRecording_insert_guard" BEFORE INSERT ON public."CreditApprovalCallRecording"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_call_recording_insert()`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalCallRecording_immutable" BEFORE UPDATE OR DELETE ON public."CreditApprovalCallRecording"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalCallRecording_no_truncate" BEFORE TRUNCATE ON public."CreditApprovalCallRecording"
    FOR EACH STATEMENT EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_require_call_recording() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE latest_id UUID;
    BEGIN
      IF NEW."status"='PENDING' THEN NEW."callRecordingId":=NULL; RETURN NEW; END IF;
      IF NEW."status"<>'APPROVED' THEN RETURN NEW; END IF;
      -- A neutral write cannot turn an existing approval into a new decision.
      IF TG_OP='UPDATE' AND OLD."status"='APPROVED' AND
        ROW(NEW."creditoId",NEW."revision",NEW."approvedRevision",NEW."approvedAt",NEW."reviewHash",NEW."approvedByUserId",NEW."approvedByName",
          NEW."approvedByKind",NEW."approvedByGrantId",NEW."approvedBySessionId",NEW."callRecordingId") IS NOT DISTINCT FROM
        ROW(OLD."creditoId",OLD."revision",OLD."approvedRevision",OLD."approvedAt",OLD."reviewHash",OLD."approvedByUserId",OLD."approvedByName",
          OLD."approvedByKind",OLD."approvedByGrantId",OLD."approvedBySessionId",OLD."callRecordingId") THEN RETURN NEW; END IF;
      SELECT "id" INTO latest_id FROM public."CreditApprovalCallRecording"
        WHERE "creditoId"=NEW."creditoId" AND "revision"=NEW."revision" AND "reviewHash"=NEW."reviewHash"
        ORDER BY "createdAt" DESC,"id" DESC LIMIT 1;
      IF NEW."callRecordingId" IS NULL OR latest_id IS NULL OR NEW."callRecordingId"<>latest_id
        THEN RAISE EXCEPTION 'CALL_RECORDING_REQUIRED' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReview_call_required" BEFORE INSERT OR UPDATE ON public."CreditApprovalReview"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_require_call_recording()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_call_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."eventType"='APPROVED' THEN
      IF NEW."callRecordingId" IS NULL OR NOT EXISTS (SELECT 1 FROM public."CreditApprovalReview"
        WHERE "creditoId"=NEW."creditoId" AND "status"='APPROVED' AND "revision"=NEW."revision"
          AND "reviewHash"=NEW."reviewHash" AND "callRecordingId"=NEW."callRecordingId")
        THEN RAISE EXCEPTION 'CALL_RECORDING_EVENT_REQUIRED' USING ERRCODE='23514'; END IF;
    ELSIF NEW."callRecordingId" IS NOT NULL THEN
      RAISE EXCEPTION 'CALL_RECORDING_EVENT_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalEvent_call_recording" BEFORE INSERT ON public."CreditApprovalEvent"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_call_event()`,
];
export async function installCreditApprovalCallSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-approval-call-schema'))");
    for (const statement of creditApprovalCallSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
