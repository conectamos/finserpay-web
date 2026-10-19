function campaignSchema(campaign) {
  if (campaign !== "CUOTAVENCIDA" && campaign !== "BLOQUEO") throw new Error("Invalid portfolio campaign");
  const prefix = campaign === "BLOQUEO" ? "BloqueoWhatsApp" : "CuotaVencidaWhatsApp";
  return { prefix, statements: [
  `CREATE TABLE IF NOT EXISTS public."CuotaVencidaWhatsAppBatch" (
    "id" UUID PRIMARY KEY,"requestId" UUID NOT NULL UNIQUE,"actorId" INTEGER NOT NULL CHECK ("actorId">0),
    "campaignDate" DATE NOT NULL UNIQUE,"stats" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("id","campaignDate")
  )`,
  `CREATE TABLE IF NOT EXISTS public."CuotaVencidaWhatsAppEvent" (
    "id" UUID PRIMARY KEY,"batchId" UUID NOT NULL,"campaignDate" DATE NOT NULL,
    "debtorKey" VARCHAR(64) NOT NULL,"recipientKey" VARCHAR(64) NOT NULL,
    "phone" VARCHAR(13) NOT NULL,"name" VARCHAR(100) NOT NULL,
    "representativeCreditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','CLAIMED','ACCEPTED','FAILED','UNKNOWN','CANCELLED')),
    "claimExpiresAt" TIMESTAMPTZ(3),"claimedAt" TIMESTAMPTZ(3),"finishedAt" TIMESTAMPTZ(3),
    "resultCode" VARCHAR(60),"providerMessageId" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("batchId","campaignDate") REFERENCES public."CuotaVencidaWhatsAppBatch"("id","campaignDate") ON DELETE RESTRICT,
    UNIQUE ("campaignDate","debtorKey"),UNIQUE ("campaignDate","recipientKey")
  )`,
  `CREATE INDEX IF NOT EXISTS "CuotaVencidaWhatsAppEvent_status_date_idx" ON public."CuotaVencidaWhatsAppEvent"("status","campaignDate","createdAt")`,
  `CREATE INDEX IF NOT EXISTS "CuotaVencidaWhatsAppEvent_recipient_status_idx" ON public."CuotaVencidaWhatsAppEvent"("recipientKey","status")`,
  `CREATE INDEX IF NOT EXISTS "CuotaVencidaWhatsAppEvent_debtor_status_idx" ON public."CuotaVencidaWhatsAppEvent"("debtorKey","status")`,
  `CREATE TABLE IF NOT EXISTS public."CuotaVencidaWhatsAppCoverage" (
    "eventId" UUID NOT NULL REFERENCES public."CuotaVencidaWhatsAppEvent"("id") ON DELETE RESTRICT,
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    PRIMARY KEY ("eventId","creditoId")
  )`,
  ].map(sql => sql.replaceAll("CuotaVencidaWhatsApp", prefix)) };
}

export const cuotaVencidaWhatsAppSchemaStatements = campaignSchema("CUOTAVENCIDA").statements;
export const bloqueoWhatsAppSchemaStatements = campaignSchema("BLOQUEO").statements;

export async function installCuotaVencidaWhatsAppSchema(client, campaign = "CUOTAVENCIDA") {
  const { statements } = campaignSchema(campaign);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["finserpay-" + campaign.toLowerCase() + "-whatsapp-schema"]);
    for (const sql of statements) await client.query(sql);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
