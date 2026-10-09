import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { moraCreditSelect, moraCreditSummary } from "@/lib/analyst-mora-credit";
import { assertMoraActor, type MoraActor } from "@/lib/analyst-mora-access";
import { parseMoraManagement } from "@/lib/analyst-mora-management";
import { moraResultLabel } from "@/lib/analyst-mora-types";
import { collectionCallKey } from "@/lib/dapta-collections-http";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import { welcomeVoiceIntegerSpoken, welcomeVoiceMoneySpoken } from "@/lib/credit-welcome-voice-speech";
import { matchWelcomeVoiceIdentity, normalizeWelcomeVoiceDocument, normalizeWelcomeVoiceName } from "@/lib/credit-welcome-voice-core";
import { collectionsColombiaClock, collectionsUuid, collectionsVoiceResultDecision, getCollectionsVoiceSlot,
  type CollectionsVoiceCampaign, type CollectionsVoiceScope } from "@/lib/collections-voice-core";

export const collectionsVoiceSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS "CollectionsVoiceCampaign" ("id" text PRIMARY KEY,"config" jsonb NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS "CollectionsVoiceConsent" ("id" uuid PRIMARY KEY,"creditoId" integer NOT NULL REFERENCES "Credito"("id"),"phone" text NOT NULL,
    "sourceType" text NOT NULL CHECK ("sourceType" IN ('SIGNED_DOCUMENT','CUSTOMER_MESSAGE','RECORDED_CALL')),
    "sourceReference" text NOT NULL,"grantedAt" timestamptz NOT NULL,"recordedBy" integer NOT NULL REFERENCES "Usuario"("id"),
    "createdAt" timestamptz NOT NULL DEFAULT now(),"revokedAt" timestamptz,
    CHECK ("phone" ~ '^573[0-9]{9}$'),CHECK (length("sourceReference") BETWEEN 10 AND 500))`,
  `CREATE INDEX IF NOT EXISTS "CollectionsVoiceConsent_credit_phone" ON "CollectionsVoiceConsent"("creditoId","phone") WHERE "revokedAt" IS NULL`,
  `CREATE TABLE IF NOT EXISTS "CollectionsVoiceMember" ("campaignId" text NOT NULL REFERENCES "CollectionsVoiceCampaign"("id"),"creditoId" integer NOT NULL REFERENCES "Credito"("id"),
    "state" text NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','CONTACTED','STOPPED','HELD')),"reason" text,"lastEventId" uuid,
    PRIMARY KEY("campaignId","creditoId"))`,
  `CREATE TABLE IF NOT EXISTS "CollectionsVoiceEvent" ("id" uuid PRIMARY KEY,"campaignId" text REFERENCES "CollectionsVoiceCampaign"("id"),
    "creditoId" integer NOT NULL REFERENCES "Credito"("id"),"source" text NOT NULL CHECK ("source" IN ('CAMPAIGN','CONTROLLED_TEST')),
    "slot" text NOT NULL,"snapshot" jsonb NOT NULL,"phone" text NOT NULL,"status" text NOT NULL CHECK ("status" IN ('DISPATCHING','ACCEPTED','COMPLETED','FAILED','UNKNOWN','CANCELLED')),
    "providerCallId" text UNIQUE,"identityAttempts" integer NOT NULL DEFAULT 0,"identityVerifiedAt" timestamptz,"outcome" text,"resultCode" text,"resultHash" text,
    "createdAt" timestamptz NOT NULL,"acceptedAt" timestamptz,"completedAt" timestamptz,
    UNIQUE("campaignId","creditoId","slot"),UNIQUE("campaignId","phone","slot"))`,
  `CREATE INDEX IF NOT EXISTS "CollectionsVoiceEvent_credit_created" ON "CollectionsVoiceEvent"("creditoId","createdAt" DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CollectionsVoiceEvent_one_controlled_test" ON "CollectionsVoiceEvent"("creditoId") WHERE "source"='CONTROLLED_TEST'`,
];
type Db = Pick<typeof prisma, "$transaction" | "$queryRawUnsafe" | "$executeRawUnsafe" | "credito">;
type Tx = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe" | "credito">;
type Identity = { name: string; document: string; phone: string };
export type CollectionsVoiceClaim = CollectionsVoiceScope & { destination: string; snapshot: Identity; source: "CAMPAIGN" | "CONTROLLED_TEST" };
type Event = { id: string; creditoId: number; campaignId: string | null; source: "CAMPAIGN" | "CONTROLLED_TEST"; slot: string;
  snapshot: Identity; phone: string; status: string; providerCallId: string | null; identityAttempts: number;
  identityVerifiedAt: Date | null; outcome: string | null; resultCode: string | null; resultHash: string | null; createdAt: Date };
export type CollectionsVoiceResult = CollectionsVoiceScope & { providerCallId: string; outcome: "NO_ANSWER" | "HUMAN_CONTACT" | "OPT_OUT" | "UNCERTAIN";
  resultCode: string; completedAt: string | null };
export class CollectionsVoiceError extends Error { constructor(public code: string, public status = 409) { super(code); } }
const error = (code: string, status = 409): never => { throw new CollectionsVoiceError(code, status); };
const queryEvent = `SELECT * FROM "CollectionsVoiceEvent" WHERE "id"=$1::uuid FOR UPDATE`;
const callIdValid = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id);
function canonical(value: unknown): string {
  return JSON.stringify(value && typeof value === "object" ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(canonical(item))])) : value);
}
let ready: Promise<void> | null = null;
export async function ensureCollectionsVoiceSchema() {
  ready ??= prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='10s'");
    await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('finserpay-collections-voice-schema'))::text");
    for (const sql of collectionsVoiceSchemaStatements) await tx.$executeRawUnsafe(sql);
  }, { timeout: 30000 }).then(() => undefined).catch(e => { ready = null; throw e; });
  await ready;
}

export function createCollectionsVoiceStore(deps: { database?: Db; now?: () => Date; testPhone?: () => string | null; agentId?: () => string } = {}) {
  const db = deps.database ?? prisma, now = deps.now ?? (() => new Date());
  const testPhone = deps.testPhone ?? (() => normalizeColombianMobile(process.env.FINSERPAY_COLLECTIONS_VOICE_TEST_PHONE));
  const agentId = deps.agentId ?? (() => process.env.FINSERPAY_COBRANZA_AGENT_ID || "");

  async function eligible(tx: Tx, creditId: number, requireConsent = true) {
    const credit = await tx.credito.findUnique({ where: { id: creditId }, select: moraCreditSelect });
    if (!credit || /ANUL|CANCEL|PAGADO|PAZ_Y_SALVO/.test(credit.estado.toUpperCase()) || credit.pazYSalvoEmitidoAt
      || (!credit.fechaPrimerPago && !credit.fechaProximoPago && credit.planCapitalVigente == null)) return null;
    const name = normalizeWelcomeVoiceName(credit.clienteNombre), document = normalizeWelcomeVoiceDocument(credit.clienteDocumento);
    const phone = normalizeColombianMobile(credit.clienteTelefono);
    if (!name || !document || !phone) return null;
    let summary; try { summary = moraCreditSummary(credit, now()); } catch { return null; }
    if (!summary.enMora || summary.valorVencido <= 0) return null;
    const latest = await tx.$queryRawUnsafe<Array<{ managementStatus: string; resultCode: string | null }>>(
      `SELECT "managementStatus","resultCode" FROM "CreditMoraManagementEvent" WHERE "creditoId"=$1 ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, creditId);
    if (latest[0]?.managementStatus === "ACUERDO_PAGO" || latest[0]?.resultCode === "PAGO_REALIZADO") return null;
    if (requireConsent) {
      const consent = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "CollectionsVoiceConsent" WHERE "creditoId"=$1 AND "phone"=$2
        AND "revokedAt" IS NULL AND "grantedAt"<=$3 LIMIT 1 FOR SHARE`, creditId, phone, now());
      if (!consent.length) return null;
    }
    return { identity: { name, document, phone }, summary };
  }
  async function crossChannelHeld(tx: Tx, identity: Identity, ownEvent: string | null = null) {
    const p = collectionsColombiaClock(now()), date = new Date(p.date + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const week = date.toISOString().slice(0, 10) + "T00:00:00-05:00";
    const rows = await tx.$queryRawUnsafe<Array<{ blocked: boolean }>>(`WITH related AS (
      SELECT "id" FROM "Credito" WHERE regexp_replace(COALESCE("clienteDocumento",''),'[^0-9]','','g')=$1
        OR regexp_replace(COALESCE("clienteTelefono",''),'[^0-9]','','g') IN ($2,right($2,10)))
      SELECT (EXISTS(SELECT 1 FROM "CreditDueReminder" WHERE "creditoId" IN (SELECT "id" FROM related) AND "claimedAt">=$3::timestamptz AND "status" IN ('CLAIMED','ACCEPTED','UNKNOWN'))
      OR EXISTS(SELECT 1 FROM "CreditOverdueDataAttempt" WHERE "creditoId" IN (SELECT "id" FROM related) AND "claimedAt">=$3::timestamptz AND "status" IN ('CLAIMED','ACCEPTED','UNKNOWN'))
      OR EXISTS(SELECT 1 FROM "CreditMoraManagementEvent" WHERE "creditoId" IN (SELECT "id" FROM related) AND "actedAt">=$3::timestamptz AND COALESCE("resultCode",'')<>'SIN_RESPUESTA')
      OR EXISTS(SELECT 1 FROM "CreditWelcomeVoiceEvent" WHERE "creditoId" IN (SELECT "id" FROM related) AND "source"<>'CONTROLLED_TEST' AND "createdAt">=$3::timestamptz
        AND ("status" IN ('DISPATCHING','ACCEPTED','UNKNOWN') OR "communicationOutcome" IN ('HUMAN_CONTACT','OPT_OUT')))
      OR EXISTS(SELECT 1 FROM "CollectionsVoiceEvent" WHERE ("snapshot"->>'document'=$1 OR "phone"=$2) AND "source"='CAMPAIGN' AND ("id"<>$4::uuid OR $4 IS NULL)
        AND ("status" IN ('DISPATCHING','ACCEPTED','UNKNOWN') OR "outcome" IN ('HUMAN_CONTACT','OPT_OUT')))) AS blocked`,
      identity.document, identity.phone, week, ownEvent);
    return rows[0]?.blocked !== false;
  }
  const sameIdentity = (a: Identity, b: Identity) => a.name === b.name && a.document === b.document && a.phone === b.phone;
  const claimDto = (e: Event): CollectionsVoiceClaim => ({ eventId: e.id, creditId: e.creditoId, destination: e.phone, snapshot: e.snapshot, source: e.source });

  return {
    async recordConsent(input: { creditId: number; phone: string; sourceType: string; sourceReference: string; grantedAt: string }, actor: MoraActor) {
      const phone = normalizeColombianMobile(input.phone), grantedAt = new Date(input.grantedAt);
      if (!Number.isSafeInteger(input.creditId) || input.creditId < 1 || !phone || !Number.isFinite(grantedAt.getTime())
        || grantedAt > now() || !["SIGNED_DOCUMENT", "CUSTOMER_MESSAGE", "RECORDED_CALL"].includes(input.sourceType)
        || typeof input.sourceReference !== "string" || input.sourceReference.trim().length < 10
        || input.sourceReference.length > 500 || /[\p{Cc}\p{Cf}]/u.test(input.sourceReference)) return error("INVALID_CONSENT", 400);
      return db.$transaction(async tx => {
        const verified = await assertMoraActor(tx, actor, true);
        const current = await eligible(tx, input.creditId, false);
        if (!current || current.identity.phone !== phone) return error("CONTACT_CHANGED");
        const id = randomUUID();
        await tx.$executeRawUnsafe(`INSERT INTO "CollectionsVoiceConsent" ("id","creditoId","phone","sourceType","sourceReference","grantedAt","recordedBy") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
          id, input.creditId, phone, input.sourceType, input.sourceReference.trim(), grantedAt, verified.id);
        return { id, creditId: input.creditId };
      });
    },
    async ensureCampaign(config: CollectionsVoiceCampaign) {
      return db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "CollectionsVoiceCampaign" ("id","config") VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING`, config.id, JSON.stringify(config));
        const rows = await tx.$queryRawUnsafe<Array<{ config: CollectionsVoiceCampaign }>>(`SELECT "config" FROM "CollectionsVoiceCampaign" WHERE "id"=$1 FOR UPDATE`, config.id);
        if (canonical(rows[0]?.config) !== canonical(config)) return error("CAMPAIGN_CHANGED");
        for (const id of config.creditIds) await tx.$executeRawUnsafe(`INSERT INTO "CollectionsVoiceMember" ("campaignId","creditoId") VALUES ($1,$2) ON CONFLICT DO NOTHING`, config.id, id);
      });
    },
    async claim(config: CollectionsVoiceCampaign, slot: string, limit = 3) {
      if (getCollectionsVoiceSlot(config, now()) !== slot) return [];
      return db.$transaction(async tx => {
        const members = await tx.$queryRawUnsafe<Array<{ creditoId: number }>>(`SELECT m."creditoId" FROM "CollectionsVoiceMember" m WHERE m."campaignId"=$1 AND m."state"='ACTIVE'
          AND NOT EXISTS(SELECT 1 FROM "CollectionsVoiceEvent" e WHERE e."campaignId"=m."campaignId" AND e."creditoId"=m."creditoId" AND e."slot"=$2)
          AND NOT EXISTS(SELECT 1 FROM "CollectionsVoiceEvent" e WHERE e."campaignId"=m."campaignId" AND e."creditoId"=m."creditoId" AND e."status" IN ('DISPATCHING','ACCEPTED','UNKNOWN'))
          ORDER BY m."creditoId" FOR UPDATE OF m SKIP LOCKED LIMIT 500`, config.id, slot);
        const claims: CollectionsVoiceClaim[] = [];
        for (const m of members) {
          if (claims.length >= Math.max(1, Math.min(20, limit))) break;
          const prior = await tx.$queryRawUnsafe<Event[]>(`SELECT * FROM "CollectionsVoiceEvent" WHERE "campaignId"=$1 AND "creditoId"=$2 ORDER BY "createdAt" DESC,"id" DESC`, config.id, m.creditoId);
          if (prior.some(e => e.slot === slot)) continue;
          // A delayed callback can still prove NO_ANSWER. Keep the member active
          // while the event itself blocks dispatch; never redial an uncertain call.
          if (prior[0] && ["DISPATCHING", "ACCEPTED", "UNKNOWN"].includes(prior[0].status)) continue;
          const localNotSent = prior[0]?.status === "CANCELLED" && prior[0]?.resultCode === "WINDOW_CLOSED_BEFORE_DISPATCH";
          const decision = prior[0] && !localNotSent ? collectionsVoiceResultDecision(prior[0].outcome || "UNCERTAIN") : "RETRY";
          const attempted = prior.filter(e => !(e.status === "CANCELLED" && e.resultCode === "WINDOW_CLOSED_BEFORE_DISPATCH")).length;
          if (attempted >= config.maxAttempts || decision !== "RETRY") {
            await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceMember" SET "state"=$3,"reason"=$4 WHERE "campaignId"=$1 AND "creditoId"=$2`,
              config.id, m.creditoId, decision === "CONTACTED" ? "CONTACTED" : decision === "STOPPED" ? "STOPPED" : "HELD", attempted >= config.maxAttempts ? "ATTEMPT_LIMIT" : decision);
            continue;
          }
          await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, m.creditoId);
          const candidate = await eligible(tx, m.creditoId);
          if (!candidate) continue;
          await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text`, "finserpay-collections-phone:" + candidate.identity.phone);
          await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text`, "finserpay-collections:" + candidate.identity.document);
          if (await crossChannelHeld(tx, candidate.identity)) continue;
          const id = randomUUID(), rows = await tx.$queryRawUnsafe<Event[]>(`INSERT INTO "CollectionsVoiceEvent" ("id","campaignId","creditoId","source","slot","snapshot","phone","status","createdAt")
            VALUES ($1::uuid,$2,$3,'CAMPAIGN',$4,$5::jsonb,$6,'DISPATCHING',$7) ON CONFLICT DO NOTHING RETURNING *`, id, config.id, m.creditoId, slot, JSON.stringify(candidate.identity), candidate.identity.phone, now());
          if (!rows[0]) continue;
          await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceMember" SET "lastEventId"=$3::uuid WHERE "campaignId"=$1 AND "creditoId"=$2`, config.id, m.creditoId, id);
          claims.push(claimDto(rows[0]));
        }
        return claims;
      });
    },
    async prepare(eventId: string, campaign?: CollectionsVoiceCampaign) {
      if (!collectionsUuid.test(eventId)) return null;
      return db.$transaction(async tx => {
        const e = (await tx.$queryRawUnsafe<Event[]>(queryEvent, eventId))[0];
        if (!e || e.status !== "DISPATCHING") return null;
        if (e.source === "CAMPAIGN" && campaign?.id === e.campaignId && getCollectionsVoiceSlot(campaign, now()) !== e.slot) {
          await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceEvent" SET "status"='CANCELLED',"resultCode"='WINDOW_CLOSED_BEFORE_DISPATCH' WHERE "id"=$1::uuid`, e.id); return null;
        }
        const candidate = await eligible(tx, e.creditoId, e.source !== "CONTROLLED_TEST");
        const allowed = e.source === "CONTROLLED_TEST" ? testPhone() === e.phone
          : campaign?.id === e.campaignId && getCollectionsVoiceSlot(campaign, now()) === e.slot;
        if (!candidate || !sameIdentity(e.snapshot, candidate.identity) || !allowed
          || (e.source === "CAMPAIGN" && await crossChannelHeld(tx, candidate.identity, e.id))) {
          await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceEvent" SET "status"='CANCELLED',"resultCode"='REVALIDATION_FAILED' WHERE "id"=$1::uuid`, e.id); return null;
        }
        return claimDto(e);
      });
    },
    async prepareControlledTest(input: { creditId: number; expectedPhone: string; testPhone: string }) {
      const expectedPhone = normalizeColombianMobile(input.expectedPhone), destination = normalizeColombianMobile(input.testPhone);
      if (!expectedPhone || !destination || destination !== testPhone()) return error("TEST_DESTINATION_NOT_ALLOWED");
      return db.$transaction(async tx => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, input.creditId);
        const candidate = await eligible(tx, input.creditId, false);
        if (!candidate || candidate.identity.phone !== expectedPhone) return error("CONTACT_CHANGED");
        const rows = await tx.$queryRawUnsafe<Event[]>(`INSERT INTO "CollectionsVoiceEvent" ("id","creditoId","source","slot","snapshot","phone","status","createdAt")
          VALUES ($1::uuid,$2,'CONTROLLED_TEST','CONTROLLED_TEST',$3::jsonb,$4,'DISPATCHING',$5) ON CONFLICT DO NOTHING RETURNING *`, randomUUID(), input.creditId, JSON.stringify(candidate.identity), destination, now());
        if (!rows[0]) return error("TEST_ALREADY_ATTEMPTED"); return claimDto(rows[0]);
      });
    },
    async accepted(eventId: string, providerCallId: string) {
      if (!callIdValid(providerCallId)) return error("INVALID_CALL_ID", 400);
      await db.$transaction(async tx => {
        const e = (await tx.$queryRawUnsafe<Event[]>(queryEvent, eventId))[0];
        if (!e || (e.providerCallId && e.providerCallId !== providerCallId)) return error("CALL_CONFLICT");
        await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceEvent" SET "providerCallId"=$2,"acceptedAt"=COALESCE("acceptedAt",$3),
          "status"=CASE WHEN "status" IN ('DISPATCHING','UNKNOWN') THEN 'ACCEPTED' ELSE "status" END WHERE "id"=$1::uuid`, eventId, providerCallId, now());
      });
    },
    async unknown(eventId: string) { await db.$executeRawUnsafe(`UPDATE "CollectionsVoiceEvent" SET "status"='UNKNOWN' WHERE "id"=$1::uuid AND "status"='DISPATCHING'`, eventId); },
    // Only the dispatcher that has not invoked fetch may release this event.
    async windowClosedBeforeDispatch(eventId: string) {
      await db.$executeRawUnsafe(`UPDATE "CollectionsVoiceEvent" SET "status"='CANCELLED',"resultCode"='WINDOW_CLOSED_BEFORE_DISPATCH'
        WHERE "id"=$1::uuid AND "status"='DISPATCHING' AND "providerCallId" IS NULL AND "acceptedAt" IS NULL`, eventId);
    },
    async verifyIdentity(input: { eventId: string; creditId?: number; customerName: string; customerDocument: string }) {
      return db.$transaction(async tx => {
        const e = (await tx.$queryRawUnsafe<Event[]>(queryEvent, input.eventId))[0];
        if (!e || (input.creditId !== undefined && e.creditoId !== input.creditId) || !["DISPATCHING", "ACCEPTED", "UNKNOWN"].includes(e.status)
          || now().getTime() - new Date(e.createdAt).getTime() > 3600000 || e.identityAttempts >= 3) return { verificado: false };
        const current = await eligible(tx, e.creditoId, e.source !== "CONTROLLED_TEST");
        if (!current || !sameIdentity(e.snapshot, current.identity)) return { verificado: false };
        const matches = matchWelcomeVoiceIdentity(e.snapshot, { name: input.customerName, document: input.customerDocument });
        await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceEvent" SET "identityAttempts"="identityAttempts"+1,
          "identityVerifiedAt"=CASE WHEN $2 THEN COALESCE("identityVerifiedAt",$3) ELSE "identityVerifiedAt" END WHERE "id"=$1::uuid`, e.id, matches, now());
        return matches ? { verificado: true, credito: { creditId: e.creditoId, diasMora: current.summary.diasMora, valorVencido: current.summary.valorVencido,
          ultimoPago: current.summary.ultimoPago, moneda: "COP", speech: { valorVencido: welcomeVoiceMoneySpoken(current.summary.valorVencido),
            diasMora: `${welcomeVoiceIntegerSpoken(current.summary.diasMora)} días` } } } : { verificado: false };
      });
    },
    async saveResult(input: CollectionsVoiceResult) {
      if (!collectionsUuid.test(input.eventId) || !callIdValid(input.providerCallId)) return error("INVALID_RESULT", 400);
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      return db.$transaction(async tx => {
        const e = (await tx.$queryRawUnsafe<Event[]>(queryEvent, input.eventId))[0];
        if (!e || e.creditoId !== input.creditId || (e.providerCallId && e.providerCallId !== input.providerCallId)) return error("CALL_CONFLICT");
        if (e.resultHash) { if (e.resultHash !== hash) return error("RESULT_CONFLICT"); return { registrado: true, unchanged: true }; }
        if (!["DISPATCHING", "ACCEPTED", "UNKNOWN"].includes(e.status)) return error("RESULT_NOT_ALLOWED");
        const outcome = e.identityVerifiedAt && input.outcome === "NO_ANSWER" ? "UNCERTAIN" : input.outcome;
        const decision = collectionsVoiceResultDecision(outcome);
        await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceEvent" SET "status"='COMPLETED',"providerCallId"=$2,"outcome"=$3,"resultCode"=$4,
          "resultHash"=$5,"completedAt"=$6 WHERE "id"=$1::uuid`, e.id, input.providerCallId, outcome, input.resultCode, hash, input.completedAt ? new Date(input.completedAt) : now());
        if (e.campaignId && decision !== "RETRY") await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceMember" SET "state"=$3,"reason"=$4 WHERE "campaignId"=$1 AND "creditoId"=$2`,
          e.campaignId, e.creditoId, decision === "CONTACTED" ? "CONTACTED" : decision === "STOPPED" ? "STOPPED" : "HELD", decision);
        if (outcome === "OPT_OUT" && e.source === "CAMPAIGN") await tx.$executeRawUnsafe(`UPDATE "CollectionsVoiceConsent" SET "revokedAt"=$3 WHERE "creditoId"=$1 AND "phone"=$2 AND "revokedAt" IS NULL`, e.creditoId, e.snapshot.phone, now());
        return { registrado: true, unchanged: false };
      });
    },
    async recordManagement(scope: { eventId: string; creditId?: number }, input: { result: "MEDIOS_PAGO" | "PAGO_REALIZADO"; comment: string; nextFollowUpAt: string }) {
      // Agreements extracted by a model are deliberately not admitted. They need
      // a separate, evidenced confirmation workflow before being persisted.
      return db.$transaction(async tx => {
        const e = (await tx.$queryRawUnsafe<Event[]>(queryEvent, scope.eventId))[0];
        if (!e || (scope.creditId !== undefined && e.creditoId !== scope.creditId) || !e.identityVerifiedAt || !e.providerCallId
          || !["ACCEPTED", "COMPLETED"].includes(e.status) || e.source === "CONTROLLED_TEST"
          || now().getTime() - new Date(e.createdAt).getTime() > 3600000) return error("IDENTITY_REQUIRED");
        if (!collectionsUuid.test(agentId())) return error("INVALID_AGENT");
        const actor = await assertMoraActor(tx, { id: 51, nombre: "Integración cobranza", centralAdmin: false });
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, e.creditoId);
        const management = parseMoraManagement({ action: "LLAMADA", actedAt: new Date(e.createdAt).toISOString(), responsibleUserId: 51,
          result: input.result, comment: `[Solicitud herramienta cobranza; evento ${scope.eventId}] ${input.comment}`, nextFollowUpAt: input.nextFollowUpAt,
          managementStatus: input.result === "PAGO_REALIZADO" ? "SEGUIMIENTO" : "CONTACTADO",
          idempotencyKey: collectionCallKey(agentId(), e.providerCallId) }, now());
        const hash = createHash("sha256").update(JSON.stringify({ id: e.creditoId, input: management, actorId: actor.id })).digest("hex");
        const prior = await tx.$queryRawUnsafe<Array<{ id: string; requestHash: string }>>(`SELECT "id","requestHash" FROM "CreditMoraManagementEvent" WHERE "idempotencyKey"=$1::uuid`, management.idempotencyKey);
        if (prior[0]) { if (prior[0].requestHash !== hash) return error("RESULT_CONFLICT"); return { unchanged: true, id: prior[0].id }; }
        const current = await eligible(tx, e.creditoId);
        if (!current || !sameIdentity(e.snapshot, current.identity)) return error("CONTACT_CHANGED");
        const id = randomUUID();
        await tx.$executeRawUnsafe(`INSERT INTO "CreditMoraManagementEvent" ("id","creditoId","action","actedAt","responsibleUserId","responsibleName","result","comment",
          "nextFollowUpAt","managementStatus","actorUserId","actorName","idempotencyKey","requestHash","resultCode","agreementDate","agreementAmount")
          VALUES ($1::uuid,$2,'LLAMADA',$3,51,$4,$5,$6,$7,$8,51,$4,$9::uuid,$10,$11,NULL,NULL)`, id, e.creditoId,
          new Date(management.actedAt), actor.nombre, moraResultLabel(management.result, "LLAMADA"), management.comment,
          new Date(management.nextFollowUpAt), management.managementStatus, management.idempotencyKey, hash, management.result);
        return { unchanged: false, id };
      });
    },
  };
}
export const collectionsVoiceStore = createCollectionsVoiceStore();
