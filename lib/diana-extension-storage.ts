import "server-only";
import { randomUUID } from "node:crypto";
import { AttentionError, attentionUuid } from "./atencion-core";
import { attentionCreditIsRegistered, attentionDocumentKey, attentionPhoneOrNull, attentionPhoneSql, resolveAttentionCreditIdentity } from "./atencion-classification";
import { extensionEligibility, financialDay, financialPlan } from "./atencion-financial-core";
import { assertDaptaEventScope, daptaEventTimestamp, type DaptaEventScope } from "./atencion-dapta-events";
import { colombiaDateKey } from "./colombia-date";
import { CreditApprovalError } from "./credit-approval-errors";
import { DIANA_EXTENSION_PROPOSAL_MS, dianaExtensionDigest, dianaExtensionFollowUp, dianaExtensionMessageCode, dianaExtensionOffer, newDianaExtensionCode, parseDianaExtensionCode, parseDianaExtensionProposal } from "./diana-extension-core";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import type { DianaExtensionMessageResult, DianaExtensionProposalInput, DianaExtensionProposalStatus, DianaExtensionProposalView, DianaExtensionVerifiedMessage } from "./diana-extension-types";
import { dianaExtensionSchemaCheckSql } from "@/scripts/diana-extension-schema.mjs";

type Credit = {
  id: number; folio: string; clienteDocumento: string | null; clienteTipoDocumento: string | null; clienteTelefono: string | null;
  estado: string; montoCredito: number; valorCuota: number; plazoMeses: number | null; frecuenciaPago: string | null;
  fechaPrimerPago: Date | string | null; fechaProximoPago: Date | string | null; pazYSalvoEmitidoAt: Date | string | null; planCapitalVigente: unknown;
};
type Payment = { id: number; valor: number; fechaAbono: Date | string };
type Proposal = {
  id: string; code: string; creditoId: number; status: DianaExtensionProposalStatus; phone: string; identityHash: string;
  inputHash: string; creditFingerprint: string; scope: DaptaEventScope; folio: string; days: 1 | 2 | 3 | 4;
  installmentNumber: number; installmentDueDate: Date | string; expiresOn: Date | string; promiseAmount: number | string;
  promiseDate: Date | string; reason: string; offerText: string; offerDigest: string; createdAt: Date | string;
  expiresAt: Date | string; conversationId: string | null; externalConversationId: string | null; contactId: string | null;
  offerMessageId: string | null; offeredAt: Date | string | null; confirmationMessageId: string | null;
  confirmedAt: Date | string | null; extensionId: string | null; managementId: string | null;
};
const txOptions = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const creditSelect = `c.id,c.folio,c."clienteDocumento",to_jsonb(c)->>'clienteTipoDocumento' AS "clienteTipoDocumento",c."clienteTelefono",c.estado,
  c."montoCredito",c."valorCuota",c."plazoMeses",c."frecuenciaPago",c."fechaPrimerPago",c."fechaProximoPago",c."pazYSalvoEmitidoAt",to_jsonb(c)->'planCapitalVigente' AS "planCapitalVigente"`;
const scopeKeys = ["workspaceId", "agentId", "agentChannelId", "phoneNumberId", "wabaId"] as const;
const iso = (value: Date | string) => new Date(value).toISOString();
function sameScope(left: DaptaEventScope, right: DaptaEventScope) { return Boolean(left && right) && scopeKeys.every(key => left[key] === right[key]); }
function normalizedCredit(row: Credit): Credit { return { ...row, montoCredito: Number(row.montoCredito), valorCuota: Number(row.valorCuota) }; }
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function creditFingerprint(credit: Credit, payments: Payment[]) { return dianaExtensionDigest(stable({ credit, payments })); }
function view(proposal: Proposal, approved = false): DianaExtensionProposalView {
  return { code: proposal.code, status: proposal.status, offerText: proposal.offerText, expiresAt: iso(proposal.expiresAt), days: proposal.days,
    installmentNumber: proposal.installmentNumber, installmentDueDate: financialDay(proposal.installmentDueDate), expiresOn: financialDay(proposal.expiresOn),
    promiseAmount: Number(proposal.promiseAmount), promiseDate: financialDay(proposal.promiseDate), approved };
}
async function ready(db: AttentionDb) {
  const [result] = await db.$queryRawUnsafe<{ ready: boolean }[]>(dianaExtensionSchemaCheckSql());
  if (!result?.ready) throw new AttentionError("La preparación de las prórrogas automáticas está pendiente.", 503);
}
async function readPayments(db: AttentionDb, creditId: number) {
  const rows = await db.$queryRawUnsafe<Payment[]>(`SELECT id,valor,"fechaAbono" FROM "CreditoAbono"
    WHERE "creditoId"=$1 AND upper(trim(estado))='ACTIVO' AND "anuladoAt" IS NULL AND valor>0 ORDER BY id FOR SHARE`, creditId);
  return rows.map(row => ({ ...row, valor: Number(row.valor) }));
}
function exactIdentity(credit: Credit, conversation: { phone: string | null; linkedCreditId: number | null }, candidates: Credit[]) {
  const phone = attentionPhoneOrNull(credit.clienteTelefono), document = attentionDocumentKey(credit);
  if (!phone || !document || conversation.phone !== phone || !attentionCreditIsRegistered(credit)
    || ["PAGADO", "PAZ_Y_SALVO"].includes(credit.estado.trim().toUpperCase()) || credit.pazYSalvoEmitidoAt) throw new AttentionError("El crédito requiere revisión de identidad o ya está pagado.", 409);
  const resolution = resolveAttentionCreditIdentity(conversation, candidates);
  if (candidates.length > 100 || !resolution.creditIds.includes(credit.id)) throw new AttentionError("No hay un vínculo único y verificado entre este teléfono y el crédito.", 409);
  return { phone, identityHash: dianaExtensionDigest(document) };
}
async function lockedIdentityCredits(db: AttentionDb, creditId: number, phone: string) {
  // Same order as the human CRM: lock every exact-phone identity candidate in
  // ascending credit ID before touching the proposal, payments or protections.
  // Including the immutable target also detects a concurrent phone correction.
  return db.$queryRawUnsafe<Credit[]>(`SELECT ${creditSelect} FROM "Credito" c
    WHERE c.id=$1 OR ${attentionPhoneSql("c")}=$2 ORDER BY c.id LIMIT 102 FOR UPDATE OF c`, creditId, phone);
}
async function eligibility(db: AttentionDb, credit: Credit, clock: Date) {
  const payments = await readPayments(db, credit.id);
  const open = await db.$queryRawUnsafe<{ id: string; type: string; status: string; expiresOn: Date | string | null }[]>(`SELECT id,type,status,"expiresOn" FROM "CreditMoraExceptionRequest"
    WHERE "creditoId"=$1 AND status IN ('PENDING','APPROVED') FOR SHARE`, credit.id);
  if (open.length > 1) throw new AttentionError("El crédito requiere revisar sus protecciones vigentes.", 409);
  const planCredit = { ...credit, abonos: payments }, result = extensionEligibility(planCredit, open[0] || null, clock);
  return { payments, planCredit, result };
}
function verifiedProof(proof: DianaExtensionVerifiedMessage, scope: DaptaEventScope, clock: Date) {
  if (!proof || !sameScope(proof.scope, scope) || !["outbound", "inbound"].includes(proof.direction)
    || typeof proof.contactId !== "string" || !/^[1-9][0-9]{7,14}$/.test(proof.contactId) || proof.phone !== `+${proof.contactId}`
    || typeof proof.text !== "string" || proof.text.length > 10000 || typeof proof.deliveryId !== "string" || proof.deliveryId.length < 1 || proof.deliveryId.length > 200) throw new AttentionError("No se pudo validar el mensaje de confirmación.", 403);
  [proof.conversationId, proof.externalConversationId, proof.messageId].forEach(attentionUuid);
  const messageAt = daptaEventTimestamp(proof.messageAt);
  if (Date.parse(messageAt) > clock.getTime() + 300000 || Date.parse(messageAt) < clock.getTime() - 86400000) throw new AttentionError("El mensaje de confirmación está fuera de vigencia.", 409);
}

/** Financial writes are reachable only through a freshly verified native message, never an APIAction body. */
export function createDianaExtensionStore(database: AttentionDatabase, settings: { scope: DaptaEventScope; enabled: boolean; now?: () => Date }) {
  const now = settings.now || (() => new Date()), scope = { ...settings.scope };
  const enabled = () => { if (!settings.enabled) throw new AttentionError("Las prórrogas automáticas todavía no están activas.", 503); assertDaptaEventScope(scope); };
  const transaction = <T>(fn: (db: AttentionDb) => Promise<T>) => database.$transaction(fn, txOptions);
  return {
    async propose(raw: DianaExtensionProposalInput): Promise<DianaExtensionProposalView> {
      enabled(); const input = parseDianaExtensionProposal(raw), inputHash = dianaExtensionDigest(input);
      await ready(database);
      const [key] = await database.$queryRawUnsafe<{ id: number; clienteTelefono: string | null }[]>(`SELECT c.id,c."clienteTelefono" FROM "Credito" c WHERE c.folio=$1 AND c."clienteDocumento"=$2`, input.folio, input.cedula);
      const expectedPhone = key && attentionPhoneOrNull(key.clienteTelefono);
      if (!key) throw new AttentionError("No se encontró el crédito consultado.", 404);
      if (!expectedPhone) throw new AttentionError("El crédito requiere revisar el teléfono de su titular.", 409);
      return transaction(async db => {
        await ready(db);
        const candidates = await lockedIdentityCredits(db, key.id, expectedPhone), row = candidates.find(item => item.id === key.id), clock = now();
        if (!row || row.folio !== input.folio || row.clienteDocumento !== input.cedula) throw new AttentionError("Cambió el crédito consultado. Consulta de nuevo.", 409);
        const credit = normalizedCredit(row), identity = exactIdentity(credit, { phone: expectedPhone, linkedCreditId: null }, candidates);
        await db.$queryRawUnsafe(`UPDATE "DianaExtensionProposal" SET status='EXPIRED',"updatedAt"=$2::timestamptz WHERE "creditoId"=$1 AND status IN ('PENDING','OFFERED') AND "expiresAt"<=$2::timestamptz RETURNING id`, credit.id, clock);
        const [prior] = await db.$queryRawUnsafe<Proposal[]>(`SELECT * FROM "DianaExtensionProposal" WHERE "creditoId"=$1 AND status IN ('PENDING','OFFERED') FOR UPDATE`, credit.id);
        const check = await eligibility(db, credit, clock), choice = check.result.choices.find(item => item.days === input.days);
        if (!check.result.canGrant || !choice || !check.result.installmentNumber || !check.result.dueDate) throw new AttentionError(check.result.blockedReason || "La prórroga no está disponible.", 409);
        const plan = financialPlan(check.planCredit, clock)!;
        if (input.promiseAmount > plan.saldoPendiente || input.promiseDate < colombiaDateKey(clock) || input.promiseDate > choice.expiresOn) throw new AttentionError("El compromiso debe estar vigente, dentro de la prórroga y no superar el saldo.", 409);
        const fingerprint = creditFingerprint(credit, check.payments);
        if (prior) {
          if (prior.inputHash !== inputHash || prior.creditFingerprint !== fingerprint || !sameScope(prior.scope, scope)) throw new AttentionError("Existe otra propuesta pendiente. Revísala o espera a que venza antes de solicitar una nueva.", 409);
          return view(prior);
        }
        const expiresAt = new Date(clock.getTime() + DIANA_EXTENSION_PROPOSAL_MS).toISOString();
        const proposal = { id: randomUUID(), code: newDianaExtensionCode(), creditoId: credit.id, status: "PENDING" as const,
          ...identity, inputHash, creditFingerprint: fingerprint, scope, folio: credit.folio, days: input.days,
          installmentNumber: check.result.installmentNumber, installmentDueDate: check.result.dueDate, expiresOn: choice.expiresOn,
          promiseAmount: input.promiseAmount, promiseDate: input.promiseDate, reason: input.reason, expiresAt,
          createdAt: clock, conversationId: null, externalConversationId: null, contactId: null, offerMessageId: null,
          offeredAt: null, confirmationMessageId: null, confirmedAt: null, extensionId: null, managementId: null };
        const offerText = dianaExtensionOffer(proposal), offerDigest = dianaExtensionDigest(offerText);
        await db.$queryRawUnsafe(`INSERT INTO "DianaExtensionProposal"
          (id,code,"creditoId",phone,"identityHash","inputHash","creditFingerprint",scope,folio,days,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,"offerText","offerDigest","createdAt","expiresAt","updatedAt")
          VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::date,$13::date,$14,$15::date,$16,$17,$18,$19::timestamptz,$20::timestamptz,$19::timestamptz) RETURNING id`,
        proposal.id, proposal.code, credit.id, identity.phone, identity.identityHash, inputHash, fingerprint, JSON.stringify(scope), credit.folio,
        proposal.days, proposal.installmentNumber, proposal.installmentDueDate, proposal.expiresOn, input.promiseAmount, input.promiseDate,
        input.reason, offerText, offerDigest, clock, expiresAt);
        return view({ ...proposal, offerText, offerDigest });
      });
    },
    async status(rawCode: string): Promise<DianaExtensionProposalView> {
      enabled(); const code = parseDianaExtensionCode(rawCode), clock = now();
      await ready(database);
      const [proposal] = await database.$queryRawUnsafe<Proposal[]>(`SELECT * FROM "DianaExtensionProposal" WHERE code=$1`, code);
      if (!proposal || !sameScope(proposal.scope, scope)) throw new AttentionError("Propuesta no encontrada.", 404);
      let approved = false;
      if (proposal.status === "GRANTED" && proposal.extensionId) {
        const [record] = await database.$queryRawUnsafe<{ status: string; expiresOn: Date | string }[]>(`SELECT status,"expiresOn" FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid AND "creditoId"=$2 AND source='SYSTEM_DIANA' AND "createdBySystemKey"='SYSTEM_DIANA'`, proposal.extensionId, proposal.creditoId);
        approved = record?.status === "APPROVED" && financialDay(record.expiresOn) >= colombiaDateKey(clock);
      }
      return view(proposal.status !== "GRANTED" && new Date(proposal.expiresAt).getTime() <= clock.getTime() ? { ...proposal, status: "EXPIRED" } : proposal, approved);
    },
    async consumeVerifiedMessage(proof: DianaExtensionVerifiedMessage): Promise<DianaExtensionMessageResult> {
      enabled(); verifiedProof(proof, scope, now());
      const code = dianaExtensionMessageCode(proof.text, proof.direction);
      if (!code) return { outcome: "ignored" };
      await ready(database);
      // Read only the immutable credit key before locking. All financial callers
      // acquire conversation -> credit -> proposal, never the reverse order.
      const [key] = await database.$queryRawUnsafe<{ creditoId: number; phone: string }[]>(`SELECT "creditoId",phone FROM "DianaExtensionProposal" WHERE code=$1`, code);
      if (!key) return { outcome: "ignored" };
      return transaction(async db => {
        const [conversation] = await db.$queryRawUnsafe<{ id: string; channel: string; phone: string | null; externalId: string | null; linkedCreditId: number | null }[]>(`SELECT id,channel,phone,"externalId","linkedCreditId" FROM "AttentionConversation" WHERE id=$1::uuid FOR UPDATE`, proof.conversationId);
        if (!conversation || conversation.channel !== "whatsapp" || conversation.phone !== proof.phone || conversation.externalId !== proof.externalConversationId) return { outcome: "ignored" };
        const bindings = await db.$queryRawUnsafe<{ phoneNumberId: string; wabaId: string; contactId: string }[]>(`SELECT "phoneNumberId","wabaId","contactId" FROM "AttentionMetaBinding" WHERE "conversationId"=$1::uuid FOR SHARE`, conversation.id);
        if (!bindings.length || bindings.some(binding => binding.phoneNumberId !== scope.phoneNumberId || binding.wabaId !== scope.wabaId || binding.contactId !== proof.contactId)) return { outcome: "ignored" };
        const candidates = await lockedIdentityCredits(db, key.creditoId, key.phone), rawCredit = candidates.find(item => item.id === key.creditoId);
        const [proposal] = await db.$queryRawUnsafe<Proposal[]>(`SELECT * FROM "DianaExtensionProposal" WHERE code=$1 FOR UPDATE`, code);
        let clock = now();
        if (!proposal || !rawCredit || proposal.creditoId !== key.creditoId || proposal.phone !== proof.phone || !sameScope(proposal.scope, scope)) return { outcome: "ignored" };
        const reject = async (message: string, expired = false): Promise<DianaExtensionMessageResult> => {
          await db.$queryRawUnsafe(`UPDATE "DianaExtensionProposal" SET status=$2,"rejectedReason"=$3,"updatedAt"=$4::timestamptz WHERE id=$1::uuid AND status IN ('PENDING','OFFERED') RETURNING id`, proposal.id, expired ? "EXPIRED" : "REJECTED", message.slice(0, 500), clock);
          return { outcome: "rejected", code, reason: message };
        };
        if (proposal.status === "GRANTED") return { outcome: "already_granted", code, creditId: proposal.creditoId, extensionId: proposal.extensionId!, managementId: proposal.managementId! };
        if (["EXPIRED", "REJECTED"].includes(proposal.status)) return { outcome: "rejected", code, reason: "La propuesta ya no está vigente." };
        const messageAt = new Date(proof.messageAt).getTime();
        if (clock.getTime() >= new Date(proposal.expiresAt).getTime() || messageAt >= new Date(proposal.expiresAt).getTime()) return reject("La propuesta venció. Es necesario consultar una nueva.", true);
        if (messageAt < new Date(proposal.createdAt).getTime()) return { outcome: "ignored" };
        const credit = normalizedCredit(rawCredit);
        let identity;
        try { identity = exactIdentity(credit, conversation, candidates); }
        catch (error) { if (error instanceof AttentionError) return reject(error.message); throw error; }
        if (identity.phone !== proposal.phone || identity.identityHash !== proposal.identityHash || credit.folio !== proposal.folio) return reject("Cambió la identidad vinculada al crédito. Solicita revisión con un analista.");
        if (proof.direction === "outbound") {
          if (proof.text !== proposal.offerText || dianaExtensionDigest(proof.text) !== proposal.offerDigest) return { outcome: "ignored" };
          if (proposal.status === "OFFERED") return { outcome: "offered", code };
          await db.$queryRawUnsafe(`UPDATE "DianaExtensionProposal" SET status='OFFERED',"conversationId"=$2::uuid,"externalConversationId"=$3::uuid,"contactId"=$4,"offerMessageId"=$5::uuid,"offeredAt"=$6::timestamptz,"updatedAt"=$7::timestamptz WHERE id=$1::uuid AND status='PENDING' RETURNING id`,
          proposal.id, conversation.id, proof.externalConversationId, proof.contactId, proof.messageId, proof.messageAt, clock);
          return { outcome: "offered", code };
        }
        if (proposal.status === "PENDING") return { outcome: "pending_offer", code };
        if (proposal.conversationId !== conversation.id || proposal.externalConversationId !== proof.externalConversationId || proposal.contactId !== proof.contactId
          || !proposal.offeredAt || messageAt <= new Date(proposal.offeredAt).getTime() || proof.messageId === proposal.offerMessageId) return { outcome: "ignored" };
        // Expiration is administrative only; no protection may survive its date
        // merely because the read-only assistant queried it before a human did.
        const today = colombiaDateKey(clock);
        const expired = await db.$queryRawUnsafe<{ id: string; version: number }[]>(`UPDATE "CreditMoraExceptionRequest" SET status='EXPIRED',version=version+1,"updatedAt"=$3::timestamptz
          WHERE "creditoId"=$1 AND status='APPROVED' AND "expiresOn"<$2::date RETURNING id,version`, credit.id, today, clock);
        for (const record of expired) {
          const payload = { source: "DIANA", expiredBefore: today };
          await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"(id,"requestId","creditoId",version,action,"fromStatus","toStatus",payload,"actorSystemKey","actorName","requestHash")
            VALUES($1::uuid,$2::uuid,$3,$4,'EXPIRED','APPROVED','EXPIRED',$5::jsonb,'SYSTEM_DIANA','Diana',$6) RETURNING id`, randomUUID(), record.id, credit.id, record.version, JSON.stringify(payload), dianaExtensionDigest(payload));
        }
        const check = await eligibility(db, credit, clock);
        if (creditFingerprint(credit, check.payments) !== proposal.creditFingerprint) return reject("El crédito o los pagos cambiaron. Consulta y confirma una nueva propuesta.");
        const choice = check.result.choices.find(item => item.days === proposal.days), promiseAmount = Number(proposal.promiseAmount), promiseDate = financialDay(proposal.promiseDate);
        if (!check.result.canGrant || !choice || !check.result.installmentNumber || !check.result.dueDate
          || check.result.installmentNumber !== proposal.installmentNumber || check.result.dueDate !== financialDay(proposal.installmentDueDate)
          || choice.expiresOn !== financialDay(proposal.expiresOn)) return reject(check.result.blockedReason || "Cambió la cuota o el plazo disponible. Consulta una nueva propuesta.");
        const plan = financialPlan(check.planCredit, clock)!;
        if (promiseAmount > plan.saldoPendiente || promiseDate < today || promiseDate > choice.expiresOn) return reject("El compromiso de pago dejó de estar vigente.");
        const { evaluateMoraExceptionRule } = await import("./mora-exception-requests");
        try { evaluateMoraExceptionRule(check.planCredit, { type: "PRORROGA", expiresOn: choice.expiresOn, promiseAmount, promiseDate }, clock); }
        catch (error) { if (error instanceof CreditApprovalError) return reject(error.message); throw error; }
        clock = now();
        if (clock.getTime() >= new Date(proposal.expiresAt).getTime()) return reject("La propuesta venció. Es necesario consultar una nueva.", true);
        if (colombiaDateKey(clock) !== today) return reject("Cambió la fecha de gestión. Consulta y confirma una nueva propuesta.");
        const nextFollowUpAt = dianaExtensionFollowUp(promiseDate);
        if (nextFollowUpAt <= clock) return reject("El compromiso de pago dejó de estar vigente.");
        const extensionId = randomUUID(), managementId = randomUUID(), eventId = randomUUID();
        const proofHash = dianaExtensionDigest({ proposalId: proposal.id, conversationId: conversation.id, scope, offerMessageId: proposal.offerMessageId, confirmationMessageId: proof.messageId, confirmationAt: proof.messageAt });
        const observation = "El cliente confirmó por WhatsApp las condiciones exactas de la propuesta de Diana.";
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionRequest"
          (id,"creditoId",type,status,version,source,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,observation,"createdByUserId","createdBySystemKey","createdByName","decidedByUserId","decidedBySystemKey","decidedByName","decidedAt","decisionReason","createIdempotencyKey","createRequestHash")
          VALUES($1::uuid,$2,'PRORROGA','APPROVED',1,'SYSTEM_DIANA',$3,$4::date,$5::date,$6,$7::date,$8,$9,NULL,'SYSTEM_DIANA','Diana',NULL,'SYSTEM_DIANA','Diana',$10::timestamptz,$8,$11::uuid,$12) RETURNING id`,
        extensionId, credit.id, proposal.installmentNumber, check.result.dueDate, choice.expiresOn, promiseAmount, promiseDate, proposal.reason, observation, clock, proposal.id, proofHash);
        const amount = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(promiseAmount);
        const label = (date: string) => date.split("-").reverse().join("/");
        const result = `Prórroga aprobada · ${proposal.days} ${proposal.days === 1 ? "día" : "días"} · cuota ${proposal.installmentNumber} · vencimiento ${label(check.result.dueDate)} · hasta ${label(choice.expiresOn)} · compromiso ${amount} el ${label(promiseDate)}`;
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraManagementEvent"
          (id,"creditoId",action,"actedAt","responsibleUserId","responsibleSystemKey","responsibleName",result,comment,"nextFollowUpAt","managementStatus","actorUserId","actorSystemKey","actorName","idempotencyKey","requestHash","resultCode","agreementDate","agreementAmount")
          VALUES($1::uuid,$2,'MSJ_TEXTO',$3::timestamptz,NULL,'SYSTEM_DIANA','Diana',$4,$5,$6::timestamptz,'ACUERDO_PAGO',NULL,'SYSTEM_DIANA','Diana',$7::uuid,$8,'ACUERDO_PAGO',$9::date,$10) RETURNING id`,
        managementId, credit.id, clock, result, `Desde Diana\nMotivo: ${proposal.reason}\n${observation}`, nextFollowUpAt, proposal.id, proofHash, promiseDate, promiseAmount);
        const payload = { source: "DIANA", policy: "DIANA_EXTENSION_1_4", proposalId: proposal.id, conversationId: conversation.id,
          days: proposal.days, expiresOn: choice.expiresOn, installmentNumber: proposal.installmentNumber, installmentDueDate: check.result.dueDate,
          promiseAmount, promiseDate, offerMessageId: proposal.offerMessageId, confirmationMessageId: proof.messageId, confirmationAt: proof.messageAt, managementId };
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"(id,"requestId","creditoId",version,action,"fromStatus","toStatus",payload,"actorUserId","actorSystemKey","actorName","idempotencyKey","requestHash")
          VALUES($1::uuid,$2::uuid,$3,1,'APPROVED',NULL,'APPROVED',$4::jsonb,NULL,'SYSTEM_DIANA','Diana',$5::uuid,$6) RETURNING id`, eventId, extensionId, credit.id, JSON.stringify(payload), proposal.id, proofHash);
        await db.$queryRawUnsafe(`UPDATE "DianaExtensionProposal" SET status='GRANTED',"confirmationMessageId"=$2::uuid,"confirmedAt"=$3::timestamptz,"extensionId"=$4::uuid,"managementId"=$5::uuid,"updatedAt"=$6::timestamptz WHERE id=$1::uuid AND status='OFFERED' RETURNING id`,
        proposal.id, proof.messageId, proof.messageAt, extensionId, managementId, clock);
        await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET version=version+1,"updatedAt"=$2::timestamptz WHERE id=$1::uuid RETURNING version`, conversation.id, clock);
        await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","sellerId",action,metadata,"actorKind","actorKey")
          VALUES($1::uuid,NULL,NULL,'EXTENSION_GRANTED',$2::jsonb,'system','SYSTEM_DIANA') RETURNING id`, conversation.id, JSON.stringify({ creditId: credit.id, extensionId, managementId, proposalId: proposal.id, policy: "DIANA_EXTENSION_1_4", actorName: "Diana" }));
        const committedAt = now();
        if (committedAt.getTime() >= new Date(proposal.expiresAt).getTime() || colombiaDateKey(committedAt) !== today) {
          // Throwing here rolls back ALL financial writes and preserves the
          // durable inbound job so a retry can report expiry without a grant.
          throw new AttentionError("La propuesta venció antes de finalizar el registro. Consulta una nueva propuesta.", 409);
        }
        return { outcome: "granted", code, creditId: credit.id, extensionId, managementId };
      });
    },
  };
}
