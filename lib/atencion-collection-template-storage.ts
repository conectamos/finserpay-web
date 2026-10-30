import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AttentionError, attentionUuid } from "./atencion-core";
import type { AttentionActor } from "./atencion-types";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import { attentionFinancialScope, attentionFinancialCredits, attentionFinancialPayments, attentionFinancialCreditNumbers } from "./atencion-financial-storage";
import { hasActiveMoraMessageProtection } from "./mora-message-protection";
import { colombiaDateKey } from "./colombia-date";
import { documentKey } from "./cuotavencida-whatsapp-policy";
import { attentionDocumentKey, attentionPhoneSql } from "./atencion-classification";
import { attentionCollectionCandidate, attentionCollectionReview, attentionCollectionReminderKey, attentionCollectionTemplateNames,
  isAttentionCollectionTemplateName, type AttentionCollectionReview, type AttentionCollectionOption,
  type AttentionCollectionTemplateList, type AttentionCollectionTemplateName } from "./atencion-collection-template-policy";

export type AttentionCollectionReservation = AttentionCollectionReview & {
  requestId: string; conversationId: string; actorKey: string; claimId: string; kind: "reminder" | "data"; version: number;
};
export type AttentionCollectionClaimInput = {
  requestId: string; version: number; creditId: number; templateName: AttentionCollectionTemplateName; reviewHash: string;
};
type Communication = { requestId: string; creditoId: number; actorUserId: number; actorName: string; phone: string; requestHash: string; stage: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const dataKey = (phone: string) => hash("finserpay-datos:" + phone.replace(/^\+/, ""));
const options = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const requiredColumns = {
  CreditDueReminder: ["id","creditoId","numeroCuota","templateKey","fechaVencimiento","status","claimedAt","claimExpiresAt","finishedAt","resultCode","updatedAt"],
  CreditOverdueDataRecipient: ["recipientKey"],
  CreditOverdueDataAttempt: ["id","recipientKey","creditoId","campaignDate","daysPastDue","status","claimedAt","claimExpiresAt","finishedAt","resultCode"],
  CreditOverdueDataCoverage: ["creditoId","attemptId","createdAt"],
  CreditMoraExceptionRequest: ["creditoId","status","expiresOn"], ExcepcionBloqueoMora: ["documento","activa","fechaFin"],
  CreditMoraManagementEvent: ["creditoId","actedAt","action","resultCode"],
  CreditCollectionCommunicationEvent: ["id","requestId","creditoId","action","stage","phone","actorUserId","actorName","requestHash","message","providerReference"],
  CollectionVoiceAttempt: ["debtorKey","optOut","status","contactedAt","outcome","managementId"],
  CreditWelcomeVoiceEvent: ["creditoId","status","identityVerifiedAt"],
};
function validate(input: AttentionCollectionClaimInput) {
  attentionUuid(input.requestId);
  if (!Number.isSafeInteger(input.version) || input.version < 1 || !Number.isSafeInteger(input.creditId) || input.creditId < 1
    || !isAttentionCollectionTemplateName(input.templateName) || !/^[a-f0-9]{64}$/.test(input.reviewHash)) throw new AttentionError("Revisa el crédito y la plantilla antes de confirmar.");
}
async function schema(db: AttentionDb) {
  const expected=Object.entries(requiredColumns).flatMap(([table,columns])=>columns.map(column=>({table,column})));
  const [row] = await db.$queryRawUnsafe<{ ready: boolean }[]>(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS expected("table" text,"column" text)
    WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=expected."table" AND c.column_name=expected."column")) AS ready`, JSON.stringify(expected));
  if (!row?.ready) throw new AttentionError("La preparación de los controles de comunicaciones de cartera está pendiente.", 503);
}
async function audit(db: AttentionDb, actor: AttentionActor, conversationId: string, action: string, metadata: object) {
  await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","actorKey",action,metadata) VALUES($1::uuid,$2,$3,$4,$5::jsonb) RETURNING id`, conversationId, actor.userId, actor.key, action, JSON.stringify(metadata));
}
function reservationHash(reservation: AttentionCollectionReservation) {
  return hash(JSON.stringify({ source: "ATTENTION_COLLECTION_TEMPLATE", ...reservation }));
}
/** The same debtor contact holds used by the selected-credit communications flow.
 * Own claim is excluded, so revalidation never treats its reservation as a competitor.
 */
async function contactHeld(db: AttentionDb, document: string, at: Date, own: string | null) {
  const [row] = await db.$queryRawUnsafe<{ blocked: boolean }[]>(`SELECT EXISTS(
    SELECT 1 FROM "CollectionVoiceAttempt" v WHERE v."debtorKey"=$1 AND (v."optOut" OR v.status IN ('DISPATCHING','DIALING','ACCEPTED','UNKNOWN')
      OR (v."contactedAt" AT TIME ZONE 'America/Bogota')::date=$3::date OR v.outcome->>'pago_informado'='true'
      OR (v."managementId" IS NULL AND v.outcome->>'acuerdo_confirmado'='true'))
    UNION ALL SELECT 1 FROM "CreditMoraManagementEvent" m JOIN "Credito" c ON c.id=m."creditoId"
      WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$2
      AND m."actedAt">=date_trunc('week',$4::timestamptz AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'
      AND ((m.action='MSJ_TEXTO' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA') OR
        (m.action='LLAMADA' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA' AND (m."actedAt" AT TIME ZONE 'America/Bogota')::date=$3::date))
    UNION ALL SELECT 1 FROM "Credito" c WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$2 AND (
      EXISTS(SELECT 1 FROM "CreditDueReminder" r WHERE r."creditoId"=c.id AND ($5::uuid IS NULL OR r.id<>$5::uuid) AND r.status IN ('CLAIMED','UNKNOWN') AND r."claimedAt">=$4::timestamptz-interval '7 days') OR
      EXISTS(SELECT 1 FROM "CreditOverdueDataAttempt" r WHERE r."creditoId"=c.id AND ($5::uuid IS NULL OR r.id<>$5::uuid) AND r.status IN ('CLAIMED','UNKNOWN') AND r."claimedAt">=$4::timestamptz-interval '7 days') OR
      EXISTS(SELECT 1 FROM "CreditWelcomeVoiceEvent" r WHERE r."creditoId"=c.id AND (r.status IN ('DISPATCHING','ACCEPTED','UNKNOWN') OR (r."identityVerifiedAt" AT TIME ZONE 'America/Bogota')::date=$3::date)))) AS blocked`,
    hash(document), document, colombiaDateKey(at), at, own);
  return row?.blocked === true;
}

/** Financial persistence only. No provider calls except the caller's final, bounded POST callback. */
export function createAttentionCollectionTemplateStore(database: AttentionDatabase, settings: { now?: () => Date } = {}) {
  const now = settings.now ?? (() => new Date());
  const transact = <T>(fn: (db: AttentionDb) => Promise<T>) => database.$transaction(fn, options);

  async function load(db: AttentionDb, actor: AttentionActor, conversationId: string, input?: AttentionCollectionClaimInput, guarding = false) {
    const scope = await attentionFinancialScope(db, actor, conversationId, Boolean(input));
    await schema(db);
    if (input) {
      if (scope.conversation.version !== input.version) throw new AttentionError("La conversación cambió. Revisa nuevamente la plantilla.", 409);
      const [identity] = await db.$queryRawUnsafe<{ clienteDocumento: string | null }[]>(`SELECT "clienteDocumento" FROM "Credito" WHERE id=$1`, input.creditId);
      const document = documentKey(identity?.clienteDocumento);
      if (!document) throw new AttentionError("El documento registrado no permite verificar las protecciones de contacto.", 409);
      await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtext($1))`, "collections:" + hash(document));
      if (input.templateName === "data") {
        const key = dataKey(scope.conversation.phone || "");
        if (!guarding) await db.$queryRawUnsafe(`INSERT INTO "CreditOverdueDataRecipient"("recipientKey") VALUES($1) ON CONFLICT DO NOTHING RETURNING "recipientKey"`, key);
        // Match the existing data worker: recipient, attempt, then ascending credits.
        await db.$queryRawUnsafe(`SELECT "recipientKey" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1 FOR UPDATE`, key);
        if (guarding) await db.$queryRawUnsafe(`SELECT id FROM "CreditOverdueDataAttempt" WHERE id=$1::uuid FOR UPDATE`, input.requestId);
      }
    }
    const match = await attentionFinancialCredits(db, scope.conversation, Boolean(input));
    const active = await attentionFinancialPayments(db, match.credits.map(c => c.id), Boolean(input));
    const labels = await attentionFinancialCreditNumbers(db, match.credits);
    const credits = match.credits.map(c => ({ ...c, frecuenciaPago: c.frecuenciaPago || "", abonos: active.filter(p => p.creditoId === c.id) }));
    const owners=scope.conversation.phone?await db.$queryRawUnsafe<{id:number;clienteDocumento:string|null;clienteTipoDocumento:string|null}[]>(`SELECT c.id,c."clienteDocumento",to_jsonb(c)->>'clienteTipoDocumento' AS "clienteTipoDocumento" FROM "Credito" c WHERE ${attentionPhoneSql("c")}=$1 ORDER BY c.id LIMIT 101`,scope.conversation.phone):[];
    const dataIdentityAmbiguous=owners.length>100||new Set(owners.map(c=>attentionDocumentKey(c)||`unverified:${c.id}`)).size>1;
    return { ...scope, credits, labels, dataIdentityAmbiguous, blockedReason: match.blockedReason };
  }
  type Context = Awaited<ReturnType<typeof load>>;
  async function eligibility(db: AttentionDb, context: Context, own: string | null = null): Promise<AttentionCollectionTemplateList> {
    const at = now(), protectedIds = new Set<number>(), contactReasons = new Map<string, boolean>();
    for (const credit of context.credits) {
      if (await hasActiveMoraMessageProtection(credit.id, credit.clienteDocumento, db as Parameters<typeof hasActiveMoraMessageProtection>[2])) protectedIds.add(credit.id);
      const document = documentKey(credit.clienteDocumento);
      if (document && !contactReasons.has(document)) contactReasons.set(document, await contactHeld(db, document, at, own));
    }
    const ids = context.credits.map(c => c.id);
    const covered = ids.length ? await db.$queryRawUnsafe<{ creditoId: number }[]>(`SELECT "creditoId" FROM "CreditOverdueDataCoverage" WHERE "creditoId"=ANY($1::int[]) AND ($2::uuid IS NULL OR "attemptId"<>$2::uuid)
      UNION SELECT "creditoId" FROM "CreditOverdueDataAttempt" WHERE "creditoId"=ANY($1::int[]) AND ($2::uuid IS NULL OR id<>$2::uuid)`, ids, own) : [];
    const alreadyCovered = new Set(covered.map(c => c.creditoId));
    const cohort = context.credits.filter(c => !protectedIds.has(c.id) && !alreadyCovered.has(c.id) && attentionCollectionCandidate(c, "data", at));
    const coveredCredits = cohort.map(c => ({ id: c.id, number: context.labels.get(c.id)! }));
    const credits: AttentionCollectionTemplateList["credits"] = [];
    for (const credit of context.credits) {
      const document = documentKey(credit.clienteDocumento);
      const common = !document ? "El documento registrado no permite verificar las protecciones de contacto."
        : protectedIds.has(credit.id) ? "El crédito tiene una prórroga o excepción vigente; los mensajes de cartera están suspendidos."
          : contactReasons.get(document) ? "Existe un contacto, acuerdo o envío pendiente que impide repetir la gestión de cartera." : null;
      const options: AttentionCollectionOption[] = [];
      for (const templateName of attentionCollectionTemplateNames) {
        let reason = common;
        if (!reason && templateName === "data" && context.dataIdentityAmbiguous) reason = "El teléfono está compartido por distintas identidades; el aviso Datos requiere verificar un único titular para todos los créditos cubiertos.";
        if (!reason && templateName === "data" && alreadyCovered.has(credit.id)) reason = "Este crédito ya tiene un aviso Datos registrado o pendiente de conciliación.";
        if (!reason) {
          const duplicate = templateName === "data" ? await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "CreditOverdueDataAttempt" WHERE "recipientKey"=$1 AND "campaignDate"=$2::date AND ($3::uuid IS NULL OR id<>$3::uuid) LIMIT 1`, dataKey(context.conversation.phone || ""), colombiaDateKey(at), own)
            : await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "CreditDueReminder" WHERE "creditoId"=$1 AND "numeroCuota"=$2 AND "templateKey"=$3 AND ($4::uuid IS NULL OR id<>$4::uuid) LIMIT 1`, credit.id, attentionCollectionCandidate(credit, templateName, at)?.installmentNumber ?? -1, attentionCollectionReminderKey(templateName), own);
          if (duplicate.length) reason = "Esta cuota o destinatario ya tiene la comunicación registrada; no se repetirá el envío del cron o del CRM.";
        }
        const option = reason ? { templateName, eligible: false, reason, review: null } : attentionCollectionReview(credit, {
          templateName, phone: context.conversation.phone || "", creditNumber: context.labels.get(credit.id)!, now: at,
          coveredCredits: templateName === "data" ? coveredCredits : [{ id: credit.id, number: context.labels.get(credit.id)! }],
          financialSnapshot: templateName === "data" ? cohort : credit,
        });
        options.push(option);
      }
      credits.push({ id: credit.id, number: context.labels.get(credit.id)!, options });
    }
    return { credits, version: context.conversation.version, blockedReason: context.blockedReason };
  }
  async function reviewed(db: AttentionDb, context: Context, input: AttentionCollectionClaimInput) {
    const data = await eligibility(db, context, input.requestId);
    const option = data.credits.find(c => c.id === input.creditId)?.options.find(o => o.templateName === input.templateName);
    if (!option?.eligible || !option.review) throw new AttentionError(option?.reason || data.blockedReason || "El crédito no corresponde a este chat.", 409);
    if (option.review.reviewHash !== input.reviewHash) throw new AttentionError("El crédito, sus pagos o la fecha cambiaron. Revisa la plantilla actualizada antes de enviar.", 409);
    return option.review;
  }
  async function requestRow(db: AttentionDb, reservation: AttentionCollectionReservation) {
    const [row] = await db.$queryRawUnsafe<Communication[]>(`SELECT * FROM "CreditCollectionCommunicationEvent" WHERE "requestId"=$1::uuid AND stage='REQUESTED'`, reservation.requestId);
    if (!row || row.requestHash !== reservationHash(reservation) || row.creditoId !== reservation.creditId || `+${row.phone}` !== reservation.phone) throw new AttentionError("La reserva de cartera no coincide con la solicitud autorizada.", 409);
    return row;
  }
  return {
    async list(actor: AttentionActor, conversationId: string): Promise<AttentionCollectionTemplateList> {
      return transact(async db => {
        const context = await load(db, actor, conversationId), result = await eligibility(db, context);
        await audit(db, context.actor, conversationId, "COLLECTION_TEMPLATES_READ", { creditIds: result.credits.map(c => c.id) });
        return result;
      });
    },
    async claim(actor: AttentionActor, conversationId: string, input: AttentionCollectionClaimInput): Promise<AttentionCollectionReservation> {
      validate(input);
      return transact(async db => {
        const context = await load(db, actor, conversationId, input), review = await reviewed(db, context, input);
        const reservation: AttentionCollectionReservation = { ...review, requestId: input.requestId, claimId: input.requestId,
          conversationId, actorKey: actor.key, version: input.version, kind: input.templateName === "data" ? "data" : "reminder" };
        const [outbox] = await db.$queryRawUnsafe<{ actorKey: string; userId: number; conversationId: string; contactId: string; conversationVersion: number; status: string; template: {financial?:{creditId:number;templateName:string;reviewHash:string};parameters?:Record<string,string>}|null }[]>(`SELECT "actorKey","userId","conversationId","contactId","conversationVersion",status,template FROM "AttentionMetaOutbox" WHERE id=$1::uuid`, input.requestId);
        if (!outbox || outbox.actorKey !== actor.key || outbox.userId !== actor.userId || outbox.conversationId !== conversationId || `+${outbox.contactId}` !== review.phone || outbox.conversationVersion !== input.version || outbox.status !== "queued") throw new AttentionError("Falta una intención de envío propia y vigente para reservar la comunicación.", 409);
        if(outbox.template?.financial?.creditId!==review.creditId||outbox.template.financial.templateName!==review.templateName||outbox.template.financial.reviewHash!==review.reviewHash
          || JSON.stringify(Object.entries(outbox.template.parameters||{}).sort())!==JSON.stringify(Object.entries(review.parameters).sort()))throw new AttentionError("La intención de envío no contiene la revisión financiera confirmada.",409);
        const prior = await db.$queryRawUnsafe<Communication[]>(`SELECT * FROM "CreditCollectionCommunicationEvent" WHERE "requestId"=$1::uuid`, input.requestId);
        if (prior.length) {
          if (prior.some(p => p.stage !== "REQUESTED" || p.requestHash !== reservationHash(reservation) || p.actorUserId !== actor.userId)) throw new AttentionError("Esta reserva ya terminó o corresponde a otros datos.", 409);
          return reservation;
        }
        const at = now(), expires = new Date(at.getTime() + 120000);
        if (reservation.kind === "data") {
          const inserted = await db.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "CreditOverdueDataAttempt"(id,"recipientKey","creditoId","campaignDate","daysPastDue",status,"claimedAt","claimExpiresAt") VALUES($1::uuid,$2,$3,$4::date,20,'CLAIMED',$5,$6) ON CONFLICT DO NOTHING RETURNING id`, input.requestId, dataKey(review.phone), review.creditId, review.day, at, expires);
          if (!inserted.length) throw new AttentionError("El destinatario ya tiene un aviso Datos reservado. Actualiza antes de continuar.", 409);
          await db.$queryRawUnsafe(`INSERT INTO "CreditOverdueDataCoverage"("creditoId","attemptId","createdAt") SELECT id,$1::uuid,$3 FROM unnest($2::int[]) AS id RETURNING "creditoId"`, input.requestId, review.coveredCredits.map(c => c.id), at);
        } else {
          const inserted = await db.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "CreditDueReminder"(id,"creditoId","numeroCuota","templateKey","fechaVencimiento",status,"claimedAt","claimExpiresAt") VALUES($1::uuid,$2,$3,$4,$5::date,'CLAIMED',$6,$7) ON CONFLICT DO NOTHING RETURNING id`, input.requestId, review.creditId, review.installmentNumber, attentionCollectionReminderKey(input.templateName as Exclude<AttentionCollectionTemplateName,"data">), review.dueDate, at, expires);
          if (!inserted.length) throw new AttentionError("La cuota ya tiene un recordatorio reservado. Actualiza antes de continuar.", 409);
        }
        await db.$queryRawUnsafe(`INSERT INTO "CreditCollectionCommunicationEvent"(id,"requestId","creditoId",action,stage,phone,"actorUserId","actorName","requestHash",message,"providerReference") VALUES($1::uuid,$2::uuid,$3,'REMINDER','REQUESTED',$4,$5,$6,$7,$8,$9) RETURNING id`,
          randomUUID(), input.requestId, review.creditId, review.phone.slice(1), context.actor.userId, context.actor.name, reservationHash(reservation), `Desde Atención: plantilla ${review.templateName}; cuota ${review.installmentNumber}; vencimiento ${review.dueDate}.`, input.requestId);
        await audit(db, context.actor, conversationId, "COLLECTION_TEMPLATE_RESERVED", { outboxId: input.requestId, creditIds: review.coveredCredits.map(c => c.id), templateName: review.templateName, reviewHash: review.reviewHash });
        return reservation;
      });
    },
    async withSendGuard<T>(actor: AttentionActor, conversationId: string, reservation: AttentionCollectionReservation, send: () => Promise<T>): Promise<T> {
      validate(reservation);
      if (reservation.conversationId !== conversationId || reservation.actorKey !== actor.key || typeof send !== "function") throw new AttentionError("La reserva pertenece a otra gestión.", 409);
      return transact(async db => {
        const context = await load(db, actor, conversationId, reservation, true);
        const request = await requestRow(db, reservation);
        if (request.actorUserId !== actor.userId) throw new AttentionError("La reserva pertenece a otro usuario.", 403);
        const review = await reviewed(db, context, reservation);
        if (JSON.stringify(review) !== JSON.stringify(Object.fromEntries(Object.keys(review).map(key => [key, reservation[key as keyof AttentionCollectionReview]])))) throw new AttentionError("Los datos de la plantilla cambiaron.", 409);
        const table = reservation.kind === "data" ? "CreditOverdueDataAttempt" : "CreditDueReminder";
        const [claim] = await db.$queryRawUnsafe<{ status: string; claimExpiresAt: Date | string }[]>(`SELECT status,"claimExpiresAt" FROM "${table}" WHERE id=$1::uuid FOR UPDATE`, reservation.claimId);
        if (!claim || claim.status !== "CLAIMED" || new Date(claim.claimExpiresAt) <= now()) throw new AttentionError("La reserva de cartera venció o ya fue utilizada.", 409);
        const [terminal] = await db.$queryRawUnsafe<{ present: boolean }[]>(`SELECT EXISTS(SELECT 1 FROM "CreditCollectionCommunicationEvent" WHERE "requestId"=$1::uuid AND stage<>'REQUESTED') AS present`, reservation.requestId);
        if (terminal?.present) throw new AttentionError("La comunicación ya tiene un resultado registrado.", 409);
        await audit(db, context.actor, conversationId, "COLLECTION_TEMPLATE_SENDING", { outboxId: reservation.requestId, creditIds: review.coveredCredits.map(c => c.id), templateName: review.templateName });
        // This callback must contain only the final Graph POST; the Meta outbox
        // is committed before entering and acknowledged after this transaction.
        return send();
      });
    },
    async finish(reservation: AttentionCollectionReservation, result: { status: "ACCEPTED" | "FAILED" | "UNKNOWN"; providerReference?: string | null; code?: string; started: boolean }): Promise<void> {
      validate(reservation);
      await transact(async db => {
        const request = await requestRow(db, reservation), table = reservation.kind === "data" ? "CreditOverdueDataAttempt" : "CreditDueReminder";
        if (reservation.kind === "data") await db.$queryRawUnsafe(`SELECT "recipientKey" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1 FOR UPDATE`, dataKey(reservation.phone));
        const [claim] = await db.$queryRawUnsafe<{ status: string }[]>(`SELECT status FROM "${table}" WHERE id=$1::uuid FOR UPDATE`, reservation.claimId);
        if (!result.started && result.status !== "FAILED") throw new AttentionError("Un resultado sin envío no puede confirmar una entrega.", 409);
        const terminal=await db.$queryRawUnsafe<{stage:string}[]>(`SELECT stage FROM "CreditCollectionCommunicationEvent" WHERE "requestId"=$1::uuid AND stage<>'REQUESTED'`,reservation.requestId);
        // A repeated cleanup must not rewrite an accepted/uncertain operation as
        // "not sent", nor create contradictory terminal entries in its wall.
        if(terminal.length || !result.started && claim && claim.status!=='CLAIMED')return;
        const stage = !result.started ? "SKIPPED" : result.status;
        if (!result.started && claim?.status === "CLAIMED") {
          if (reservation.kind === "data") await db.$queryRawUnsafe(`DELETE FROM "CreditOverdueDataCoverage" WHERE "attemptId"=$1::uuid RETURNING "creditoId"`, reservation.claimId);
          await db.$queryRawUnsafe(`DELETE FROM "${table}" WHERE id=$1::uuid AND status='CLAIMED' RETURNING id`, reservation.claimId);
        } else if (result.started && claim?.status === "CLAIMED") {
          const code = typeof result.code === "string" && /^[A-Z0-9_]{1,40}$/.test(result.code) ? result.code : `ATTENTION_${result.status}`;
          await db.$queryRawUnsafe(`UPDATE "${table}" SET status=$2,"resultCode"=$3,"finishedAt"=$4${reservation.kind === "reminder" ? ',"updatedAt"=$4' : ''} WHERE id=$1::uuid AND status='CLAIMED' RETURNING id`, reservation.claimId, result.status, code, now());
        }
        await db.$queryRawUnsafe(`INSERT INTO "CreditCollectionCommunicationEvent"(id,"requestId","creditoId",action,stage,phone,"actorUserId","actorName","requestHash",message,"providerReference") VALUES($1::uuid,$2::uuid,$3,'REMINDER',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT("requestId",stage) DO NOTHING RETURNING id`,
          randomUUID(), reservation.requestId, reservation.creditId, stage, request.phone, request.actorUserId, request.actorName, request.requestHash,
          stage === "SKIPPED" ? "La elegibilidad cambió antes del POST; no se envió la plantilla desde Atención." : stage === "ACCEPTED" ? "Meta aceptó la plantilla de cartera desde Atención; no confirma entrega ni lectura." : stage === "UNKNOWN" ? "El resultado del envío es incierto; no se repetirá automáticamente." : "El proveedor rechazó la plantilla de cartera. El intento quedó registrado.",
          result.providerReference && /^[A-Za-z0-9_.:+/=-]{1,180}$/.test(result.providerReference) ? result.providerReference : reservation.requestId);
      });
    },
  };
}
