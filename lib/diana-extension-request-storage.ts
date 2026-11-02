import "server-only";
import { randomUUID } from "node:crypto";
import { AttentionError } from "./atencion-core";
import { attentionCreditIsRegistered, attentionDocumentKey, attentionPhoneOrNull, attentionPhoneSql, resolveAttentionCreditIdentity } from "./atencion-classification";
import { extensionEligibility, financialDay, financialPlan } from "./atencion-financial-core";
import { assertDaptaEventScope, type DaptaEventScope } from "./atencion-dapta-events";
import { colombiaDateKey } from "./colombia-date";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import { dianaExtensionRequestSchemaCheckSql } from "@/scripts/diana-extension-request-schema.mjs";
import { DIANA_REQUEST_SOURCE, DIANA_REQUEST_MAX_AGE_MS, dianaRequestChoice, dianaRequestDigest, dianaRequestFollowUp, dianaRequestHash, dianaRequestScopeMatches, validateDianaRequestProof } from "./diana-extension-request-core";
import type { DianaExtensionRequestConsumeResult, DianaExtensionRequestView, DianaExtensionVerifiedRequest } from "./diana-extension-request-types";

type Credit = { id: number; folio: string; clienteDocumento: string | null; clienteTipoDocumento: string | null; clienteTelefono: string | null;
  estado: string; montoCredito: number; valorCuota: number; plazoMeses: number | null; frecuenciaPago: string | null;
  fechaPrimerPago: Date | string | null; fechaProximoPago: Date | string | null; pazYSalvoEmitidoAt: Date | string | null; planCapitalVigente: unknown };
type Ledger = { id: string; messageId: string; conversationId: string; scope: DaptaEventScope; requestHash: string; messageAt: Date | string;
  outcome: "GRANTED" | "REJECTED" | "NEEDS_CREDIT"; reason: string | null; creditoId: number | null; days: 1 | 2 | 3 | 4 | null;
  installmentNumber: number | null; installmentDueDate: Date | string | null; expiresOn: Date | string | null;
  extensionId: string | null; managementId: string | null };
type Protection = { id: string; type: string; status: string; source: string; expiresOn: Date | string | null; installmentNumber: number | null; installmentDueDate: Date | string | null };
const creditSelect = `c.id,c.folio,c."clienteDocumento",to_jsonb(c)->>'clienteTipoDocumento' AS "clienteTipoDocumento",c."clienteTelefono",c.estado,
  c."montoCredito",c."valorCuota",c."plazoMeses",c."frecuenciaPago",c."fechaPrimerPago",c."fechaProximoPago",c."pazYSalvoEmitidoAt",to_jsonb(c)->'planCapitalVigente' AS "planCapitalVigente"`;
const txOptions = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const isActiveCredit = (credit: Credit) => attentionCreditIsRegistered(credit) && !["PAGADO", "PAZ_Y_SALVO"].includes(credit.estado.trim().toUpperCase()) && !credit.pazYSalvoEmitidoAt;
const emptyView = (status: DianaExtensionRequestView["status"], reason: string | null): DianaExtensionRequestView => ({ status, approved: false, existing: false,
  days: null, installmentNumber: null, installmentDueDate: null, expiresOn: null, reason });
const day = (value: Date | string | null) => value === null ? null : financialDay(value);
async function ready(db: AttentionDb) {
  const [result] = await db.$queryRawUnsafe<{ ready: boolean }[]>(dianaExtensionRequestSchemaCheckSql());
  if (!result?.ready) throw new AttentionError("La preparación de las prórrogas directas está pendiente.", 503);
}

/** Only a fresh native customer request reaches this writer. Model tools only read status(). */
export function createDianaExtensionRequestStore(database: AttentionDatabase, settings: { scope: DaptaEventScope; enabled: boolean; activatedAt: Date | string; now?: () => Date }) {
  const scope = { ...settings.scope }, now = settings.now || (() => new Date());
  const enabled = () => { if (!settings.enabled || !Number.isFinite(typeof settings.activatedAt === "string" ? Date.parse(settings.activatedAt) : settings.activatedAt.getTime())) throw new AttentionError("Las prórrogas directas todavía no están activas.", 503); assertDaptaEventScope(scope); };
  return {
    async consumeVerifiedRequest(proof: DianaExtensionVerifiedRequest): Promise<DianaExtensionRequestConsumeResult> {
      enabled(); validateDianaRequestProof(proof, scope, settings.activatedAt, now()); await ready(database);
      const requestHash = dianaRequestHash(proof);
      return database.$transaction(async db => {
        const [conversation] = await db.$queryRawUnsafe<{ id: string; channel: string; phone: string | null; externalId: string | null; linkedCreditId: number | null }[]>(
          `SELECT id,channel,phone,"externalId","linkedCreditId" FROM "AttentionConversation" WHERE id=$1::uuid FOR UPDATE`, proof.conversationId);
        if (!conversation || conversation.channel !== "whatsapp" || conversation.phone !== proof.phone || conversation.externalId !== proof.externalConversationId) return { outcome: "ignored" };
        const bindings = await db.$queryRawUnsafe<{ phoneNumberId: string; wabaId: string; contactId: string }[]>(`SELECT "phoneNumberId","wabaId","contactId" FROM "AttentionMetaBinding" WHERE "conversationId"=$1::uuid FOR SHARE`, conversation.id);
        if (!bindings.length || bindings.some(binding => binding.phoneNumberId !== scope.phoneNumberId || binding.wabaId !== scope.wabaId || binding.contactId !== proof.contactId)) return { outcome: "ignored" };
        const candidates = await db.$queryRawUnsafe<Credit[]>(`SELECT ${creditSelect} FROM "Credito" c WHERE ${attentionPhoneSql("c")}=$1 ORDER BY c.id LIMIT 102 FOR UPDATE OF c`, proof.phone);
        const [prior] = await db.$queryRawUnsafe<Ledger[]>(`SELECT * FROM "DianaExtensionRequest" WHERE "messageId"=$1::uuid`, proof.messageId);
        if (prior) {
          if (prior.requestHash !== requestHash || !dianaRequestScopeMatches(prior.scope, scope) || prior.conversationId !== conversation.id) return { outcome: "ignored" };
          return { outcome: prior.outcome === "GRANTED" ? "already_granted" : prior.outcome === "NEEDS_CREDIT" ? "needs_credit" : "rejected",
            ...(prior.creditoId ? { creditId: prior.creditoId } : {}), ...(prior.extensionId ? { extensionId: prior.extensionId } : {}), ...(prior.managementId ? { managementId: prior.managementId } : {}) };
        }
        let clock = now(); validateDianaRequestProof(proof, scope, settings.activatedAt, clock);
        const [newer] = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "DianaExtensionRequest" WHERE "conversationId"=$1::uuid AND "messageAt">$2::timestamptz LIMIT 1`, conversation.id, proof.messageAt);
        if (newer) return { outcome: "ignored" };
        const save = async (outcome: Ledger["outcome"], reason: string | null, credit: Credit | null = null,
          facts?: { days: number; installmentNumber: number; dueDate: string; expiresOn: string; extensionId: string; managementId: string }) => {
          await db.$queryRawUnsafe(`INSERT INTO "DianaExtensionRequest"
            (id,"messageId","conversationId","externalConversationId","contactId",phone,scope,"messageAt","observedAt","textDigest","requestHash",intent,outcome,reason,"creditoId",days,"installmentNumber","installmentDueDate","expiresOn","extensionId","managementId","createdAt")
            VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8::timestamptz,$9::timestamptz,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::date,$19::date,$20::uuid,$21::uuid,$22::timestamptz) RETURNING id`,
          randomUUID(), proof.messageId, conversation.id, proof.externalConversationId, proof.contactId, proof.phone, JSON.stringify(scope), proof.messageAt, proof.observedAt,
          proof.textDigest, requestHash, JSON.stringify(proof.intent), outcome, reason, credit?.id ?? null, facts?.days ?? null, facts?.installmentNumber ?? null,
          facts?.dueDate ?? null, facts?.expiresOn ?? null, facts?.extensionId ?? null, facts?.managementId ?? null, clock);
        };
        const reject = async (reason: string, credit: Credit | null = null): Promise<DianaExtensionRequestConsumeResult> => { await save("REJECTED", reason.slice(0, 500), credit); return { outcome: "rejected", ...(credit ? { creditId: credit.id } : {}) }; };
        if (candidates.length > 100) return reject("El teléfono requiere revisión de identidad.");
        // A manually linked chat must never choose between different people who share a phone.
        const identity = resolveAttentionCreditIdentity({ ...conversation, linkedCreditId: null }, candidates);
        const resolution = resolveAttentionCreditIdentity(conversation, candidates);
        if (identity.classification.status !== "finserpay" || resolution.classification.status !== "finserpay") return reject("No se pudo verificar un vínculo único entre este teléfono y el crédito.");
        const active = candidates.filter(credit => resolution.creditIds.includes(credit.id) && isActiveCredit(credit));
        const matches = proof.intent.folio ? active.filter(credit => credit.folio === proof.intent.folio) : active;
        if (matches.length > 1 && !proof.intent.folio) { await save("NEEDS_CREDIT", "Indica el crédito para el que solicitas la prórroga."); return { outcome: "needs_credit" }; }
        if (matches.length !== 1) return reject(proof.intent.folio ? "El crédito indicado no corresponde al titular o ya está pagado." : "El titular no tiene un crédito activo verificable.");
        const credit = { ...matches[0], montoCredito: Number(matches[0].montoCredito), valorCuota: Number(matches[0].valorCuota) };
        if (attentionPhoneOrNull(credit.clienteTelefono) !== proof.phone || !attentionDocumentKey(credit)) return reject("Revisa la identidad y el teléfono del titular.", credit);
        const [used] = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "CreditMoraExceptionRequest" WHERE "createIdempotencyKey"=$1::uuid`, proof.messageId);
        if (used) return reject("El mensaje ya se utilizó en otra gestión.", credit);
        const today = colombiaDateKey(clock);
        const expired = await db.$queryRawUnsafe<{ id: string; version: number }[]>(`UPDATE "CreditMoraExceptionRequest" SET status='EXPIRED',version=version+1,"updatedAt"=$3::timestamptz WHERE "creditoId"=$1 AND status='APPROVED' AND "expiresOn"<$2::date RETURNING id,version`, credit.id, today, clock);
        for (const record of expired) await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"(id,"requestId","creditoId",version,action,"fromStatus","toStatus",payload,"actorSystemKey","actorName","requestHash")
          VALUES($1::uuid,$2::uuid,$3,$4,'EXPIRED','APPROVED','EXPIRED',$5::jsonb,'SYSTEM_DIANA','Diana',$6) RETURNING id`, randomUUID(), record.id, credit.id, record.version, JSON.stringify({ source: DIANA_REQUEST_SOURCE, expiredBefore: today }), dianaRequestDigest({ id: record.id, today }));
        const payments = await db.$queryRawUnsafe<{ id: number; valor: number | string; fechaAbono: Date | string }[]>(`SELECT id,valor,"fechaAbono" FROM "CreditoAbono" WHERE "creditoId"=$1 AND upper(trim(estado))='ACTIVO' AND "anuladoAt" IS NULL AND valor>0 ORDER BY id FOR SHARE`, credit.id);
        const protections = await db.$queryRawUnsafe<Protection[]>(`SELECT id,type,status,source,"expiresOn","installmentNumber","installmentDueDate" FROM "CreditMoraExceptionRequest" WHERE "creditoId"=$1 AND status IN ('PENDING','APPROVED') FOR SHARE`, credit.id);
        if (protections.length > 1) return reject("El crédito requiere revisar sus protecciones vigentes.", credit);
        const planCredit = { ...credit, abonos: payments.map(payment => ({ ...payment, valor: Number(payment.valor) })) };
        const eligibility = extensionEligibility(planCredit, protections[0] || null, clock), choice = dianaRequestChoice(proof.intent, eligibility.choices);
        if (!eligibility.canGrant || !choice || !eligibility.installmentNumber || !eligibility.dueDate) return reject(eligibility.blockedReason || "El plazo solicitado no coincide con las opciones vigentes del crédito.", credit);
        const { evaluateMoraExtensionWindow } = await import("./mora-exception-requests");
        const rule = evaluateMoraExtensionWindow(planCredit, { expiresOn: choice.expiresOn }, clock);
        if (rule.installmentNumber !== eligibility.installmentNumber || rule.installmentDueDate !== eligibility.dueDate) return reject("Cambió la cuota que se debe revisar.", credit);
        clock = now(); validateDianaRequestProof(proof, scope, settings.activatedAt, clock);
        if (colombiaDateKey(clock) !== today) throw new AttentionError("Cambió la fecha de gestión. Verifica nuevamente la solicitud.", 409);
        const extensionId = randomUUID(), managementId = randomUUID();
        const reason = "Solicitud de prórroga del cliente por WhatsApp";
        const observation = "Se verificó la petición real del cliente en su WhatsApp registrado. No se registró una promesa de pago.";
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionRequest"
          (id,"creditoId",type,status,version,source,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,observation,"createdByUserId","createdBySystemKey","createdByName","decidedByUserId","decidedBySystemKey","decidedByName","decidedAt","decisionReason","createIdempotencyKey","createRequestHash")
          VALUES($1::uuid,$2,'PRORROGA','APPROVED',1,'SYSTEM_DIANA_REQUEST',$3,$4::date,$5::date,NULL,NULL,$6,$7,NULL,'SYSTEM_DIANA','Diana',NULL,'SYSTEM_DIANA','Diana',$8::timestamptz,$6,$9::uuid,$10) RETURNING id`,
        extensionId, credit.id, eligibility.installmentNumber, eligibility.dueDate, choice.expiresOn, reason, observation, clock, proof.messageId, requestHash);
        const result = `Prórroga aprobada · ${choice.days} ${choice.days === 1 ? "día" : "días"} · cuota ${eligibility.installmentNumber} · hasta ${choice.expiresOn}`;
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraManagementEvent"
          (id,"creditoId",action,"actedAt","responsibleUserId","responsibleSystemKey","responsibleName",result,comment,"nextFollowUpAt","managementStatus","actorUserId","actorSystemKey","actorName","idempotencyKey","requestHash","resultCode","agreementDate","agreementAmount")
          VALUES($1::uuid,$2,'MSJ_TEXTO',$3::timestamptz,NULL,'SYSTEM_DIANA','Diana',$4,$5,$6::timestamptz,'SEGUIMIENTO',NULL,'SYSTEM_DIANA','Diana',$7::uuid,$8,'PRORROGA_APROBADA',NULL,NULL) RETURNING id`,
        managementId, credit.id, clock, result, `${reason}. ${observation}`, dianaRequestFollowUp(choice.expiresOn), proof.messageId, requestHash);
        const payload = { source: DIANA_REQUEST_SOURCE, policy: "DIANA_NATIVE_REQUEST_1_4", messageId: proof.messageId, messageAt: proof.messageAt,
          textDigest: proof.textDigest, conversationId: conversation.id, scope, days: choice.days, expiresOn: choice.expiresOn,
          installmentNumber: eligibility.installmentNumber, installmentDueDate: eligibility.dueDate, managementId, hasPaymentPromise: false };
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"(id,"requestId","creditoId",version,action,"fromStatus","toStatus",payload,"actorSystemKey","actorName","idempotencyKey","requestHash") VALUES($1::uuid,$2::uuid,$3,1,'APPROVED',NULL,'APPROVED',$4::jsonb,'SYSTEM_DIANA','Diana',$5::uuid,$6) RETURNING id`,
        randomUUID(), extensionId, credit.id, JSON.stringify(payload), proof.messageId, requestHash);
        await save("GRANTED", null, credit, { days: choice.days, installmentNumber: eligibility.installmentNumber, dueDate: eligibility.dueDate, expiresOn: choice.expiresOn, extensionId, managementId });
        await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET version=version+1,"updatedAt"=$2::timestamptz WHERE id=$1::uuid RETURNING version`, conversation.id, clock);
        await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","sellerId",action,metadata,"actorKind","actorKey") VALUES($1::uuid,NULL,NULL,'EXTENSION_GRANTED',$2::jsonb,'system','SYSTEM_DIANA') RETURNING id`, conversation.id, JSON.stringify({ creditId: credit.id, extensionId, managementId, messageId: proof.messageId, policy: "DIANA_NATIVE_REQUEST_1_4", actorName: "Diana" }));
        const finalClock = now();
        validateDianaRequestProof(proof, scope, settings.activatedAt, finalClock);
        if (colombiaDateKey(finalClock) !== today) throw new AttentionError("Cambió la fecha antes de finalizar el registro.", 409);
        return { outcome: "granted", creditId: credit.id, extensionId, managementId };
      }, txOptions);
    },
    async status(input: { cedula: string; folio: string }): Promise<DianaExtensionRequestView> {
      enabled(); await ready(database);
      if (!/^\d{5,15}$/.test(input.cedula) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.folio)) throw new AttentionError("Cédula o folio no válido.", 400);
      const [credit] = await database.$queryRawUnsafe<Credit[]>(`SELECT ${creditSelect} FROM "Credito" c WHERE c.folio=$1 AND c."clienteDocumento"=$2`, input.folio, input.cedula);
      if (!credit) throw new AttentionError("No se encontró el crédito consultado.", 404);
      if (!isActiveCredit(credit)) return emptyView("REJECTED", "El crédito ya está pagado o no está activo.");
      const phone = attentionPhoneOrNull(credit.clienteTelefono);
      if (!phone) return emptyView("REJECTED", "El teléfono del titular requiere revisión.");
      const clock = now(), today = colombiaDateKey(clock);
      const payments = await database.$queryRawUnsafe<{ valor: number | string; fechaAbono: Date | string }[]>(`SELECT valor,"fechaAbono" FROM "CreditoAbono" WHERE "creditoId"=$1 AND upper(trim(estado))='ACTIVO' AND "anuladoAt" IS NULL AND valor>0 ORDER BY id`, credit.id);
      const plan = financialPlan({ ...credit, montoCredito: Number(credit.montoCredito), valorCuota: Number(credit.valorCuota), abonos: payments.map(payment => ({ ...payment, valor: Number(payment.valor) })) }, clock);
      const installment = plan?.installments.find(item => !item.eliminada && item.saldoPendiente > 0);
      if (!plan || !installment) return emptyView("REJECTED", plan ? "El crédito no tiene una cuota regular pendiente." : "El crédito no tiene un calendario completo verificado.");
      const [latest] = await database.$queryRawUnsafe<Ledger[]>(`SELECT * FROM "DianaExtensionRequest" WHERE phone=$1 AND scope=$2::jsonb AND ("creditoId"=$3 OR "creditoId" IS NULL) ORDER BY "messageAt" DESC,id DESC LIMIT 1`, phone, JSON.stringify(scope), credit.id);
      const active = await database.$queryRawUnsafe<Protection[]>(`SELECT id,type,status,source,"expiresOn","installmentNumber","installmentDueDate" FROM "CreditMoraExceptionRequest" WHERE "creditoId"=$1 AND (status='PENDING' OR (status='APPROVED' AND ("expiresOn" IS NULL OR "expiresOn">=$2::date)))`, credit.id, today);
      if (active.length > 1) return emptyView("REJECTED", "El crédito requiere revisar sus protecciones vigentes.");
      const protection = active[0];
      if (protection?.status === "APPROVED" && protection.type === "PRORROGA") {
        const due = day(protection.installmentDueDate), expiry = day(protection.expiresOn);
        if (!due || !expiry || !Number.isFinite(Date.parse(`${due}T12:00:00Z`)) || !Number.isFinite(Date.parse(`${expiry}T12:00:00Z`))
          || due !== installment.fechaVencimiento || protection.installmentNumber !== installment.numero || expiry <= due)
          return { ...emptyView("REJECTED", "La protección vigente requiere revisar la cuota y el vencimiento con un analista."), existing: true };
        const difference = due && expiry ? Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86400000) : null;
        // A later human amendment remains real protection, not fulfillment of the original request's terms.
        const exactGrant = latest?.outcome === "GRANTED" && latest.extensionId === protection.id
          && latest.installmentNumber === protection.installmentNumber && day(latest.installmentDueDate) === due
          && day(latest.expiresOn) === expiry && latest.days === difference;
        return { status: exactGrant ? "GRANTED" : "ACTIVE", approved: true, existing: !exactGrant,
          days: difference !== null && [1, 2, 3, 4].includes(difference) ? difference as 1 | 2 | 3 | 4 : null,
          installmentNumber: protection.installmentNumber, installmentDueDate: due, expiresOn: expiry, reason: null };
      }
      if (protection) return { ...emptyView("REJECTED", "El crédito tiene otra protección o gestión pendiente. Solicita revisión con un analista."), existing: true };
      if (latest && dianaRequestScopeMatches(latest.scope, scope) && new Date(latest.messageAt).getTime() >= clock.getTime() - DIANA_REQUEST_MAX_AGE_MS) {
        return emptyView(latest.outcome === "NEEDS_CREDIT" ? "NEEDS_CREDIT" : "REJECTED", latest.reason || "La prórroga registrada ya no está activa.");
      }
      const activationFloor = typeof settings.activatedAt === "string" ? Date.parse(settings.activatedAt) : settings.activatedAt.getTime();
      const floor = new Date(Math.max(clock.getTime() - DIANA_REQUEST_MAX_AGE_MS, activationFloor));
      const [pending] = await database.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "AttentionDaptaEvent" WHERE event='new_message_received' AND status='pending' AND phone=$1 AND "workspaceId"=$2 AND "agentId"=$3 AND "agentChannelId"=$4 AND "phoneNumberId"=$5 AND "wabaId"=$6 AND "messageAt">=$7::timestamptz AND "messageAt"<=$8::timestamptz LIMIT 1`,
      phone, scope.workspaceId, scope.agentId, scope.agentChannelId, scope.phoneNumberId, scope.wabaId, floor, clock);
      return emptyView(pending ? "PENDING" : "NO_REQUEST", pending ? "La solicitud del cliente se está verificando." : "No hay una solicitud reciente y verificada para aplicar automáticamente.");
    },
  };
}
