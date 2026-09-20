// Additive call evidence and continuity: existing decisions retain a null recording pointer.
function constraint(table, name, definition) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}' AND conrelid='public."${table}"'::regclass)
    THEN ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" ${definition}; END IF; END $$`;
}
function extensibleCheckConstraint(table, name, definition, requiredFragment) {
  return `DO $$ DECLARE current_definition TEXT; BEGIN
    SELECT pg_get_constraintdef(oid) INTO current_definition FROM pg_constraint
      WHERE conname='${name}' AND conrelid='public."${table}"'::regclass AND contype='c';
    IF current_definition IS NULL THEN
      ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" ${definition};
    ELSIF POSITION('${requiredFragment}' IN LOWER(current_definition))=0 THEN
      ALTER TABLE public."${table}" DROP CONSTRAINT "${name}";
      ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" ${definition};
    END IF;
  END $$`;
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
  extensibleCheckConstraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_file_check", `CHECK (LENGTH(BTRIM("fileName")) BETWEEN 1 AND 160 AND "mimeType" IN ('audio/mpeg','audio/mp4','audio/ogg','audio/wav'))`, "audio/ogg"),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_bytes_check", `CHECK ("sizeBytes" BETWEEN 1 AND 10485760 AND octet_length("bytes")="sizeBytes" AND encode(sha256("bytes"),'hex')="sha256")`),
  constraint("CreditApprovalCallRecording", "CreditApprovalCallRecording_actor_check", `CHECK (LENGTH(BTRIM("actorName"))>0 AND (
    ("actorKind"='USER' AND "actorUserId" IS NOT NULL AND "actorUserId">0 AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
    OR ("actorKind"='SHARED_LINK' AND "actorUserId" IS NULL AND "actorGrantId" IS NOT NULL AND "actorSessionId" IS NOT NULL)))`),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalCallRecording_idempotencyKey_key" ON public."CreditApprovalCallRecording"("idempotencyKey")`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalCallRecording_current_idx" ON public."CreditApprovalCallRecording"("creditoId","revision","reviewHash","createdAt" DESC,"id" DESC)`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalEvent_credit_type_revision_idx" ON public."CreditApprovalEvent"("creditoId","eventType","revision")`,
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalCallContinuation" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),"creditoId" INTEGER NOT NULL,"recordingId" UUID NOT NULL,
    "noveltyId" UUID NOT NULL,"noveltyEventId" UUID NOT NULL,"sourceRevision" INTEGER NOT NULL,
    "sourceReviewHash" VARCHAR(64) NOT NULL,"targetRevision" INTEGER NOT NULL,"targetReviewHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`,
  `ALTER TABLE public."CreditApprovalCallContinuation" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  constraint("CreditApprovalCallContinuation", "CreditApprovalCallContinuation_creditoId_fkey", `FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id") ON DELETE RESTRICT`),
  constraint("CreditApprovalCallContinuation", "CreditApprovalCallContinuation_recordingId_fkey", `FOREIGN KEY ("recordingId") REFERENCES public."CreditApprovalCallRecording"("id") ON DELETE RESTRICT`),
  constraint("CreditApprovalCallContinuation", "CreditApprovalCallContinuation_noveltyId_fkey", `FOREIGN KEY ("noveltyId") REFERENCES public."CreditApprovalNovelty"("id") ON DELETE RESTRICT`),
  constraint("CreditApprovalCallContinuation", "CreditApprovalCallContinuation_noveltyEventId_fkey", `FOREIGN KEY ("noveltyEventId") REFERENCES public."CreditApprovalNoveltyEvent"("id") ON DELETE RESTRICT`),
  constraint("CreditApprovalCallContinuation", "CreditApprovalCallContinuation_revision_check", `CHECK ("sourceRevision">0 AND "targetRevision">"sourceRevision")`),
  constraint("CreditApprovalCallContinuation", "CreditApprovalCallContinuation_hash_check", `CHECK ("sourceReviewHash" ~ '^[a-f0-9]{64}$' AND "targetReviewHash" ~ '^[a-f0-9]{64}$')`),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalCallContinuation_noveltyEvent_key" ON public."CreditApprovalCallContinuation"("noveltyEventId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalCallContinuation_target_key" ON public."CreditApprovalCallContinuation"("creditoId","targetRevision","targetReviewHash")`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalCallContinuation_recording_idx" ON public."CreditApprovalCallContinuation"("recordingId")`,
  `ALTER TABLE public."CreditApprovalReview" ADD COLUMN IF NOT EXISTS "callRecordingId" UUID`,
  `ALTER TABLE public."CreditApprovalEvent" ADD COLUMN IF NOT EXISTS "callRecordingId" UUID`,
  ...["CreditApprovalReview","CreditApprovalEvent"].map(table => constraint(table, `${table}_callRecordingId_fkey`, `FOREIGN KEY ("callRecordingId") REFERENCES public."CreditApprovalCallRecording"("id") ON DELETE RESTRICT`)),
  `CREATE OR REPLACE FUNCTION public.credit_approval_effective_call_recording(
      target_credit_id INTEGER, target_revision INTEGER, target_review_hash TEXT)
    RETURNS UUID LANGUAGE sql STABLE AS $$
      WITH candidates AS (
        SELECT recording."id",recording."createdAt"
        FROM public."CreditApprovalCallRecording" recording
        WHERE recording."creditoId"=target_credit_id
          AND recording."revision"=target_revision
          AND recording."reviewHash"=target_review_hash
        UNION ALL
        SELECT recording."id",recording."createdAt"
        FROM public."CreditApprovalCallContinuation" continuation
        JOIN public."CreditApprovalCallRecording" recording ON recording."id"=continuation."recordingId"
        WHERE continuation."creditoId"=target_credit_id
          AND continuation."targetRevision"=target_revision
          AND continuation."targetReviewHash"=target_review_hash
        UNION ALL
        SELECT recording."id",recording."createdAt"
        FROM public."CreditApprovalEvent" approval_event
        JOIN public."CreditApprovalCallRecording" recording ON recording."id"=approval_event."callRecordingId"
        WHERE approval_event."creditoId"=target_credit_id
          AND approval_event."eventType"='APPROVED'
          AND approval_event."revision"=target_revision
          AND approval_event."reviewHash"=target_review_hash
        UNION ALL
        SELECT recording."id",recording."createdAt"
        FROM public."CreditApprovalCallRecording" recording
        WHERE recording."creditoId"=target_credit_id
          AND recording."reviewHash"=target_review_hash
          AND recording."revision"<target_revision
          AND (
            SELECT COUNT(*)=(target_revision-recording."revision")::bigint
              AND COUNT(DISTINCT event."revision")=(target_revision-recording."revision")::bigint
              AND COUNT(*) FILTER (WHERE event."eventType"='INVALIDATED' AND event."reason"='NOVELTY_CHANGED')
                =(target_revision-recording."revision")::bigint
            FROM public."CreditApprovalEvent" event
            WHERE event."creditoId"=target_credit_id
              AND event."revision">recording."revision" AND event."revision"<=target_revision
          )
      ), deduplicated AS (
        SELECT "id",MAX("createdAt") AS "createdAt" FROM candidates GROUP BY "id"
      )
      SELECT "id" FROM deduplicated ORDER BY "createdAt" DESC,"id" DESC LIMIT 1
    $$`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_call_continuation_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      current_review public."CreditApprovalReview"%ROWTYPE;
      event_type TEXT; event_item_id UUID; event_payload JSONB; event_credit_id INTEGER;
      item_key TEXT; item_status TEXT; item_version INTEGER; item_response_text TEXT;
      item_photo_hash TEXT; snapshot_photo_hash TEXT; current_photo_value TEXT; current_photo_hash TEXT;
      invalidation_count BIGINT; allowed_invalidation_count BIGINT; distinct_revision_count BIGINT;
    BEGIN
      -- The lock order remains Credit, then Review, matching upload, approval and settlement.
      PERFORM 1 FROM public."Credito" WHERE "id"=NEW."creditoId" FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CALL_CONTINUATION_INVALID' USING ERRCODE='23514'; END IF;
      SELECT * INTO current_review FROM public."CreditApprovalReview"
        WHERE "creditoId"=NEW."creditoId" FOR UPDATE;
      IF NOT FOUND OR current_review."status"<>'PENDING' OR current_review."revision"<>NEW."targetRevision"
        THEN RAISE EXCEPTION 'CALL_CONTINUATION_INVALID' USING ERRCODE='23514'; END IF;
      IF public.credit_approval_effective_call_recording(
          NEW."creditoId",NEW."sourceRevision",NEW."sourceReviewHash") IS DISTINCT FROM NEW."recordingId"
        THEN RAISE EXCEPTION 'CALL_CONTINUATION_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
      SELECT novelty."creditoId",event."type",event."itemId",event."payload"
        INTO event_credit_id,event_type,event_item_id,event_payload
      FROM public."CreditApprovalNoveltyEvent" event
      JOIN public."CreditApprovalNovelty" novelty ON novelty."id"=event."noveltyId"
      WHERE event."id"=NEW."noveltyEventId" AND event."noveltyId"=NEW."noveltyId";
      IF NOT FOUND OR event_credit_id IS DISTINCT FROM NEW."creditoId"
        OR event_type NOT IN ('REPORTED','GENERAL_RESPONDED','PHOTO_RESPONDED','ANALYST_VERIFIED')
        THEN RAISE EXCEPTION 'CALL_CONTINUATION_EVENT_INVALID' USING ERRCODE='23514'; END IF;

      SELECT COUNT(*),
        COUNT(*) FILTER (WHERE "eventType"='INVALIDATED' AND "reason"='NOVELTY_CHANGED'),
        COUNT(DISTINCT "revision")
      INTO invalidation_count,allowed_invalidation_count,distinct_revision_count
      FROM public."CreditApprovalEvent"
      WHERE "creditoId"=NEW."creditoId"
        AND "revision">NEW."sourceRevision" AND "revision"<=NEW."targetRevision";

      IF event_type IN ('REPORTED','GENERAL_RESPONDED') THEN
        IF NEW."sourceReviewHash"<>NEW."targetReviewHash"
          OR invalidation_count<>(NEW."targetRevision"-NEW."sourceRevision")
          OR allowed_invalidation_count<>invalidation_count
          OR distinct_revision_count<>invalidation_count
          THEN RAISE EXCEPTION 'CALL_CONTINUATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
        IF event_type='REPORTED' THEN
          IF event_item_id IS NOT NULL OR event_payload->>'reviewRevision' IS DISTINCT FROM NEW."sourceRevision"::text
            THEN RAISE EXCEPTION 'CALL_CONTINUATION_EVENT_INVALID' USING ERRCODE='23514'; END IF;
        ELSE
          IF NEW."targetRevision"<>NEW."sourceRevision"+1 OR event_item_id IS NULL
            THEN RAISE EXCEPTION 'CALL_CONTINUATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
          SELECT "key","status","responsePhotoHash" INTO item_key,item_status,item_photo_hash
          FROM public."CreditApprovalNoveltyItem"
          WHERE "id"=event_item_id AND "noveltyId"=NEW."noveltyId";
          IF NOT FOUND OR item_key<>'GENERAL' OR item_status<>'RESPONDED'
            OR event_payload->>'key' IS DISTINCT FROM 'GENERAL'
            THEN RAISE EXCEPTION 'CALL_CONTINUATION_EVENT_INVALID' USING ERRCODE='23514'; END IF;
        END IF;
      ELSIF event_type='ANALYST_VERIFIED' THEN
        IF NEW."targetRevision"<>NEW."sourceRevision"+1
          OR NEW."sourceReviewHash"<>NEW."targetReviewHash"
          OR invalidation_count<>1 OR allowed_invalidation_count<>1 OR distinct_revision_count<>1
          THEN RAISE EXCEPTION 'CALL_CONTINUATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
        IF event_item_id IS NULL
          OR NOT (event_payload ?& ARRAY['key','note','itemVersion','reviewRevision','reviewHash'])
          OR (SELECT COUNT(*) FROM jsonb_object_keys(event_payload))<>5
          THEN RAISE EXCEPTION 'CALL_CONTINUATION_EVENT_INVALID' USING ERRCODE='23514'; END IF;
        SELECT "key","status","version","responseText","responsePhotoHash"
          INTO item_key,item_status,item_version,item_response_text,item_photo_hash
        FROM public."CreditApprovalNoveltyItem"
        WHERE "id"=event_item_id AND "noveltyId"=NEW."noveltyId";
        IF NOT FOUND OR item_status<>'VERIFIED'
          OR event_payload->>'key' IS DISTINCT FROM item_key
          OR event_payload->>'note' IS DISTINCT FROM item_response_text
          OR event_payload->>'itemVersion' IS DISTINCT FROM (item_version-1)::text
          OR event_payload->>'reviewRevision' IS DISTINCT FROM NEW."sourceRevision"::text
          OR event_payload->>'reviewHash' IS DISTINCT FROM NEW."sourceReviewHash"
          OR (item_key='GENERAL' AND item_photo_hash IS NOT NULL)
          OR (item_key<>'GENERAL' AND (item_photo_hash IS NULL OR item_photo_hash !~ '^[a-f0-9]{64}$'))
          THEN RAISE EXCEPTION 'CALL_CONTINUATION_EVENT_INVALID' USING ERRCODE='23514'; END IF;
        IF item_key<>'GENERAL' THEN
          SELECT CASE item_key
            WHEN 'cedula-frente' THEN "contratoCedulaFrenteDataUrl"
            WHEN 'cedula-posterior' THEN "contratoCedulaRespaldoDataUrl"
            WHEN 'selfie-cedula' THEN "iphoneSelfieCedulaDataUrl"
            WHEN 'foto-entrega' THEN "fotoEntregaDataUrl"
            WHEN 'foto-remision' THEN "fotoRemisionDataUrl"
          END INTO current_photo_value FROM public."Credito" WHERE "id"=NEW."creditoId";
          IF current_photo_value IS NULL
            THEN RAISE EXCEPTION 'CALL_CONTINUATION_PHOTO_INVALID' USING ERRCODE='23514'; END IF;
          IF current_photo_value ~* '^data:image/(png|jpe?g|webp);base64,[A-Za-z0-9+/]*={0,2}$' THEN
            current_photo_hash:=encode(sha256(decode(split_part(current_photo_value,',',2),'base64')),'hex');
          ELSE
            current_photo_hash:=encode(sha256(convert_to(current_photo_value,'UTF8')),'hex');
          END IF;
          IF current_photo_hash IS DISTINCT FROM item_photo_hash
            THEN RAISE EXCEPTION 'CALL_CONTINUATION_PHOTO_INVALID' USING ERRCODE='23514'; END IF;
        END IF;
      ELSE
        IF NEW."targetRevision"<>NEW."sourceRevision"+2
          OR NEW."sourceReviewHash"=NEW."targetReviewHash"
          OR invalidation_count<>2 OR distinct_revision_count<>2
          OR NOT EXISTS (SELECT 1 FROM public."CreditApprovalEvent"
            WHERE "creditoId"=NEW."creditoId" AND "revision"=NEW."sourceRevision"+1
              AND "eventType"='INVALIDATED' AND "reason"='CREDIT_DOCUMENTATION_CHANGED')
          OR NOT EXISTS (SELECT 1 FROM public."CreditApprovalEvent"
            WHERE "creditoId"=NEW."creditoId" AND "revision"=NEW."targetRevision"
              AND "eventType"='INVALIDATED' AND "reason"='NOVELTY_CHANGED')
          THEN RAISE EXCEPTION 'CALL_CONTINUATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
        SELECT "key","status","responsePhotoHash" INTO item_key,item_status,item_photo_hash
        FROM public."CreditApprovalNoveltyItem"
        WHERE "id"=event_item_id AND "noveltyId"=NEW."noveltyId";
        IF NOT FOUND OR item_key='GENERAL' OR item_status<>'RESPONDED'
          OR item_photo_hash IS NULL OR event_payload->>'key' IS DISTINCT FROM item_key
          OR event_payload->>'nextSha256' IS DISTINCT FROM item_photo_hash
          THEN RAISE EXCEPTION 'CALL_CONTINUATION_EVENT_INVALID' USING ERRCODE='23514'; END IF;
        SELECT CASE item_key
          WHEN 'cedula-frente' THEN "contratoSnapshot" #>> '{evidencia,cedulaFrente,sha256}'
          WHEN 'cedula-posterior' THEN "contratoSnapshot" #>> '{evidencia,cedulaRespaldo,sha256}'
          WHEN 'selfie-cedula' THEN "contratoSnapshot" #>> '{evidencia,selfieConCedula,sha256}'
          WHEN 'foto-entrega' THEN "contratoSnapshot" #>> '{evidencia,fotoEntrega,sha256}'
          WHEN 'foto-remision' THEN "contratoSnapshot" #>> '{evidencia,fotoRemision,sha256}'
        END INTO snapshot_photo_hash FROM public."Credito" WHERE "id"=NEW."creditoId";
        IF snapshot_photo_hash IS DISTINCT FROM item_photo_hash
          THEN RAISE EXCEPTION 'CALL_CONTINUATION_PHOTO_INVALID' USING ERRCODE='23514'; END IF;
      END IF;
      NEW."createdAt":=CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalCallContinuation_insert_guard"
    BEFORE INSERT ON public."CreditApprovalCallContinuation"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_call_continuation_insert()`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalCallContinuation_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditApprovalCallContinuation"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalCallContinuation_no_truncate"
    BEFORE TRUNCATE ON public."CreditApprovalCallContinuation"
    FOR EACH STATEMENT EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
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
  `CREATE OR REPLACE FUNCTION public.credit_approval_actor_can_skip_call_recording(
      actor_kind TEXT, actor_user_id INTEGER)
    RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
    BEGIN
      IF actor_kind IS DISTINCT FROM 'USER' OR actor_user_id IS NULL THEN RETURN FALSE; END IF;
      PERFORM 1
      FROM public."Usuario" account
      JOIN public."Rol" user_role ON user_role."id"=account."rolId"
      JOIN public."Sede" site ON site."id"=account."sedeId"
      JOIN public."Aliado" ally ON ally."id"=site."aliadoId"
      WHERE account."id"=actor_user_id
        AND account."activo" IS TRUE
        AND site."activa" IS TRUE
        AND ally."activo" IS TRUE
        AND UPPER(BTRIM(user_role."nombre"))='ADMIN'
        AND UPPER(BTRIM(ally."codigo"))='FINSERPAY'
      FOR SHARE OF account,user_role,site,ally;
      RETURN FOUND;
    END $$`,
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
      SELECT public.credit_approval_effective_call_recording(
        NEW."creditoId",NEW."revision",NEW."reviewHash") INTO latest_id;
      IF latest_id IS NOT NULL THEN
        IF NEW."callRecordingId" IS NULL OR NEW."callRecordingId"<>latest_id
          THEN RAISE EXCEPTION 'CALL_RECORDING_REQUIRED' USING ERRCODE='23514'; END IF;
      ELSIF NEW."callRecordingId" IS NOT NULL
        OR NOT public.credit_approval_actor_can_skip_call_recording(
          NEW."approvedByKind",NEW."approvedByUserId") THEN
        RAISE EXCEPTION 'CALL_RECORDING_REQUIRED' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReview_call_required" BEFORE INSERT OR UPDATE ON public."CreditApprovalReview"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_require_call_recording()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_call_event() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE current_review public."CreditApprovalReview"%ROWTYPE;
    BEGIN
    IF NEW."eventType"='APPROVED' THEN
      SELECT * INTO current_review FROM public."CreditApprovalReview"
        WHERE "creditoId"=NEW."creditoId" AND "status"='APPROVED' AND "revision"=NEW."revision"
          AND "reviewHash"=NEW."reviewHash" AND "reviewHashVersion"=NEW."reviewHashVersion"
          AND "approvedHashVersion"=NEW."reviewHashVersion" FOR SHARE;
      IF NOT FOUND
        THEN RAISE EXCEPTION 'CALL_RECORDING_EVENT_REQUIRED' USING ERRCODE='23514'; END IF;
      IF NEW."callRecordingId" IS NULL THEN
        IF current_review."callRecordingId" IS NOT NULL
          OR NOT public.credit_approval_actor_can_skip_call_recording(
            current_review."approvedByKind",current_review."approvedByUserId")
          OR ROW(NEW."actorKind",NEW."actorUserId",NEW."actorName",NEW."actorGrantId",NEW."actorSessionId") IS DISTINCT FROM
            ROW(current_review."approvedByKind",current_review."approvedByUserId",current_review."approvedByName",
              current_review."approvedByGrantId",current_review."approvedBySessionId")
          THEN RAISE EXCEPTION 'CALL_RECORDING_EVENT_REQUIRED' USING ERRCODE='23514'; END IF;
      ELSIF current_review."callRecordingId" IS DISTINCT FROM NEW."callRecordingId" THEN
        RAISE EXCEPTION 'CALL_RECORDING_EVENT_REQUIRED' USING ERRCODE='23514';
      END IF;
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
