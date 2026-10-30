import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AttentionError, assertAttentionActor, attentionUuid } from "./atencion-core";
import { attentionPhoneSql, resolveAttentionCreditIdentity } from "./atencion-classification";
import { extensionEligibility, financialDay, financialPlan, parseAttentionExtension } from "./atencion-financial-core";
import { colombiaDateKey } from "./colombia-date";
import { readAuditedReceiptAllocation } from "./credit-audit-receipt";
import { isWompiEarlyPayoffIntent } from "./wompi-early-payoff-intent";
import type { ClientPaymentReceiptPdfInput } from "./client-payment-receipt-pdf";
import type { AttentionActor } from "./atencion-types";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import type { MetaReply } from "./atencion-meta-storage";
import type { AttentionExtensionInput, AttentionExtensionResult, AttentionFinancial, AttentionFinancialCredit } from "./atencion-financial-types";
import { CreditApprovalError } from "./credit-approval-errors";

type Conversation = { id: string; phone: string | null; linkedCreditId: number | null; version: number };
type Credit = { id: number; folio: string; clienteNombre: string; clienteDocumento: string | null; clienteTipoDocumento: string | null; clienteTelefono: string | null; estado: string;
  montoCredito: number; valorCuota: number; plazoMeses: number | null; frecuenciaPago: string | null; fechaPrimerPago: Date | string | null;
  fechaProximoPago: Date | string | null; planCapitalVigente: unknown; pazYSalvoEmitidoAt: Date | string | null };
type Payment = { id: number; creditoId: number; valor: number; fechaAbono: Date | string; createdAt: Date | string; metodoPago: string; observacion: string | null };
type OpenExtension = { id: string; creditoId: number; type: string; status: string; version: number; expiresOn: Date | string | null };
type PrincipalQuote = { saldoCapitalAntes: number; saldoCapitalDespues: number; abonoCapital: number; cuotasEliminadas: number };
const options = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (value: Date | string) => new Date(value).toISOString();
const optionalTable = async (db: AttentionDb, name: string) => (await db.$queryRawUnsafe<{ ready: boolean }[]>(`SELECT to_regclass($1) IS NOT NULL AS ready`, `public."${name}"`))[0]?.ready === true;

/** The financial capability is only for the actor's current conversation, never an arbitrary credit lookup. */
async function scoped(db: AttentionDb, actor: AttentionActor, id: string, lock = false) {
  assertAttentionActor(actor); attentionUuid(id);
  const [user] = await db.$queryRawUnsafe<{ name: string; role: string }[]>(`SELECT u.nombre AS name,upper(trim(r.nombre)) AS role FROM "Usuario" u
    JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE u.id=$1 AND u.activo=true AND s.activa=true AND a.activo=true AND upper(trim(a.codigo))='FINSERPAY'
      AND u."sedeId"=$2 AND s."aliadoId"=$3 FOR SHARE OF u,r,s,a`, actor.userId, actor.sedeId, actor.aliadoId);
  if (user?.role !== (actor.central ? "ADMIN" : "ANALISTA_APROBACION")) throw new AttentionError("La cuenta de atención ya no está autorizada.", 403);
  const [conversation] = await db.$queryRawUnsafe<Conversation[]>(`SELECT c.id,c.phone,c."linkedCreditId",c.version FROM "AttentionConversation" c
    WHERE c.id=$1::uuid AND ($2::boolean OR (c."assigneeUserId"=$3 AND c."assigneeKey"=$4 AND c."assigneeSellerId" IS NULL))
    ${lock ? "FOR UPDATE OF c" : "FOR SHARE OF c"}`, id, actor.central, actor.userId, actor.key);
  if (!conversation) throw new AttentionError("Conversación no encontrada o no autorizada.", 404);
  return { conversation, actor: { ...actor, name: user.name } };
}
async function matchedCredits(db: AttentionDb, conversation: Conversation, lock = false) {
  const records = conversation.phone ? await db.$queryRawUnsafe<Credit[]>(`SELECT c.id,c.folio,c."clienteNombre",c."clienteDocumento",c."clienteTelefono",to_jsonb(c)->>'clienteTipoDocumento' AS "clienteTipoDocumento",c.estado,
    c."montoCredito",c."valorCuota",c."plazoMeses",c."frecuenciaPago",c."fechaPrimerPago",c."fechaProximoPago",c."pazYSalvoEmitidoAt",to_jsonb(c)->'planCapitalVigente' AS "planCapitalVigente"
    FROM "Credito" c WHERE ${attentionPhoneSql("c")}=$1 ORDER BY c.id LIMIT 101 ${lock ? "FOR UPDATE OF c" : "FOR SHARE OF c"}`, conversation.phone) : [];
  if (records.length > 100) return { credits: [], blockedReason: "Hay demasiadas coincidencias. Administración debe verificar el vínculo del crédito." };
  const identity = resolveAttentionCreditIdentity(conversation, records);
  const credits = records.filter(row => identity.creditIds.includes(row.id)).map(row => ({ ...row, montoCredito: Number(row.montoCredito), valorCuota: Number(row.valorCuota) }));
  const blockedReason = credits.length ? null : identity.classification.status === "ambiguous" ? "El teléfono corresponde a varias identidades. Administración debe verificar el vínculo del crédito."
    : identity.classification.status === "unverified" ? "No se pudo verificar un crédito para este contacto." : "Este contacto no tiene un crédito asociado.";
  return { credits, blockedReason };
}
async function payments(db: AttentionDb, ids: number[], lock = false) {
  if (!ids.length) return [];
  const rows = await db.$queryRawUnsafe<Payment[]>(`SELECT id,"creditoId",valor,"fechaAbono","createdAt","metodoPago",observacion FROM "CreditoAbono"
    WHERE "creditoId"=ANY($1::integer[]) AND upper(trim(estado))='ACTIVO' AND "anuladoAt" IS NULL AND valor>0
    ORDER BY "fechaAbono" DESC,id DESC ${lock ? "FOR SHARE" : ""}`, ids);
  return rows.map(row => ({ ...row, valor: Number(row.valor) }));
}
async function numbers(db: AttentionDb, credits: Credit[]) {
  const result = new Map(credits.map(c => [c.id, c.folio]));
  if (credits.length && await optionalTable(db, "CreditSadminRegistration")) {
    const rows = await db.$queryRawUnsafe<{ creditoId: number; numeroCredito: string }[]>(`SELECT "creditoId","numeroCredito" FROM "CreditSadminRegistration" WHERE "creditoId"=ANY($1::int[]) AND "numeroCreditoConfirmado"=true AND "numeroCredito" IS NOT NULL`, credits.map(c => c.id));
    for (const row of rows) if (row.numeroCredito.trim()) result.set(row.creditoId, row.numeroCredito.trim());
  }
  return result;
}
async function financialAudit(db: AttentionDb, actor: AttentionActor, conversationId: string, action: string, metadata: object) {
  await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","sellerId",action,metadata) VALUES($1::uuid,$2,NULL,$3,$4::jsonb) RETURNING id`, conversationId, actor.userId, action, JSON.stringify(metadata));
}
async function requireMoraSchema(db: AttentionDb) {
  if (!await optionalTable(db, "CreditMoraExceptionRequest") || !await optionalTable(db, "CreditMoraExceptionEvent")) throw new AttentionError("La preparación de prórrogas está pendiente.", 503);
}
async function receiptData(db: AttentionDb, actor: AttentionActor, conversationId: string, creditId: number, expectedPaymentId?: number, expectedVersion?: number) {
  const scope = await scoped(db, actor, conversationId);
  if (expectedVersion !== undefined && scope.conversation.version !== expectedVersion) throw new AttentionError("La conversación cambió. Actualiza antes de enviar.", 409);
  const match = await matchedCredits(db, scope.conversation);
  const credit = match.credits.find(c => c.id === creditId);
  if (!credit) throw new AttentionError("El crédito no corresponde a la identidad verificada de este chat.", 404);
  const active = await payments(db, [creditId], true), payment = active[0];
  if (!payment) throw new AttentionError("Este crédito no tiene un pago válido para generar el recibo.", 404);
  if (expectedPaymentId !== undefined && payment.id !== expectedPaymentId) throw new AttentionError("El último pago cambió. Revisa el recibo actualizado antes de enviarlo.", 409);
  return { ...scope, credit, payment, active };
}

export function createAttentionFinancialStore(database: AttentionDatabase, settings: { now?: () => Date } = {}) {
  const now = settings.now ?? (() => new Date());
  const transact = <T>(fn: (db: AttentionDb) => Promise<T>) => database.$transaction(fn, options);
  return {
    async get(actor: AttentionActor, conversationId: string): Promise<AttentionFinancial> {
      return transact(async db => {
        const scope = await scoped(db, actor, conversationId), match = await matchedCredits(db, scope.conversation);
        await requireMoraSchema(db);
        const allPayments = await payments(db, match.credits.map(c => c.id)), labels = await numbers(db, match.credits);
        const open = match.credits.length ? await db.$queryRawUnsafe<OpenExtension[]>(`SELECT id,"creditoId",type,status,version,"expiresOn" FROM "CreditMoraExceptionRequest" WHERE "creditoId"=ANY($1::int[]) AND status IN ('PENDING','APPROVED')`, match.credits.map(c => c.id)) : [];
        const credits: AttentionFinancialCredit[] = match.credits.map(credit => {
          const abonos = allPayments.filter(p => p.creditoId === credit.id), planCredit = { ...credit, abonos };
          const plan = financialPlan(planCredit, now());
          const state = !plan ? "NO_VERIFICADO" : plan.saldoPendiente <= 0 ? "PAGADO" : plan.estadoPago === "MORA" ? "EN_MORA" : "AL_DIA";
          const payment = abonos[0];
          return { id: credit.id, number: labels.get(credit.id)!, state, extension: extensionEligibility(planCredit, open.find(e => e.creditoId === credit.id) || null, now()),
            lastPayment: payment ? { id: payment.id, date: iso(payment.fechaAbono), amount: payment.valor, method: payment.metodoPago, receiptAvailable: true } : null };
        });
        await financialAudit(db, scope.actor, conversationId, "FINANCIAL_VIEWED", { creditIds: credits.map(c => c.id) });
        return { credits, version: scope.conversation.version, blockedReason: match.blockedReason };
      });
    },
    async grant(actor: AttentionActor, conversationId: string, raw: AttentionExtensionInput): Promise<AttentionExtensionResult> {
      const input = parseAttentionExtension(raw as unknown as Record<string, unknown>), fingerprint = digest({ conversationId, input, actorKey: actor.key });
      return transact(async db => {
        const scope = await scoped(db, actor, conversationId, true); await requireMoraSchema(db);
        // Conversation then credit is the global financial lock order. The credit lock also serializes payments and other extensions.
        const match = await matchedCredits(db, scope.conversation, true), credit = match.credits.find(c => c.id === input.creditId);
        if (!credit) throw new AttentionError("El crédito no corresponde a la identidad verificada de este chat.", 404);
        // Share the message/cancellation request lock so the same UUID cannot
        // race into a financial operation and an outbox on different chats.
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`, `attention:meta:request:${actor.key}:${input.requestId}`);
        const [ledger] = await db.$queryRawUnsafe<{ fingerprint: string; resultId: string | null }[]>(`SELECT fingerprint,"resultId" FROM "AttentionRequest" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`, actor.key, input.requestId);
        if (ledger) {
          if (ledger.fingerprint !== fingerprint || !ledger.resultId) throw new AttentionError("La solicitud ya se utilizó con otros datos.", 409);
          const [prior] = await db.$queryRawUnsafe<{ id: string; status: AttentionExtensionResult["extension"]["status"]; expiresOn: Date | string; installmentNumber: number; installmentDueDate: Date | string }[]>(`SELECT id,status,"expiresOn","installmentNumber","installmentDueDate" FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid AND "creditoId"=$2`, ledger.resultId, input.creditId);
          if (!prior) throw new AttentionError("No se pudo recuperar la prórroga registrada.", 409);
          const status = prior.status === "APPROVED" && financialDay(prior.expiresOn) < colombiaDateKey(now()) ? "EXPIRED" : prior.status;
          return { extension: { id: prior.id, creditId: input.creditId, status, expiresOn: financialDay(prior.expiresOn), installmentNumber: prior.installmentNumber, installmentDueDate: financialDay(prior.installmentDueDate) }, version: scope.conversation.version, unchanged: true };
        }
        if (await optionalTable(db, "AttentionMetaOutbox")) {
          const existing = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "AttentionMetaOutbox" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`, actor.key, input.requestId);
          if (existing.length) throw new AttentionError("La solicitud ya corresponde a un mensaje.", 409);
        }
        if (scope.conversation.version !== input.version) throw new AttentionError("La conversación cambió. Actualiza antes de conceder la prórroga.", 409);
        const today = colombiaDateKey(now());
        const expired = await db.$queryRawUnsafe<{ id: string; version: number }[]>(`UPDATE "CreditMoraExceptionRequest" SET status='EXPIRED',version=version+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "creditoId"=$1 AND status='APPROVED' AND "expiresOn"<$2::date RETURNING id,version`, input.creditId, today);
        for (const row of expired) {
          const payload = { expiredOnReadAt: now().toISOString(), expiresBefore: today };
          await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"(id,"requestId","creditoId",version,action,"fromStatus","toStatus",payload,"actorName","requestHash") VALUES($1::uuid,$2::uuid,$3,$4,'EXPIRED','APPROVED','EXPIRED',$5::jsonb,'Sistema',$6) RETURNING id`, randomUUID(), row.id, input.creditId, row.version, JSON.stringify(payload), digest(payload));
        }
        const [open] = await db.$queryRawUnsafe<OpenExtension[]>(`SELECT id,"creditoId",type,status,version,"expiresOn" FROM "CreditMoraExceptionRequest" WHERE "creditoId"=$1 AND status IN ('PENDING','APPROVED') FOR UPDATE`, input.creditId);
        const planCredit = { ...credit, abonos: await payments(db, [credit.id], true) }, eligibility = extensionEligibility(planCredit, open || null, now());
        const choice = eligibility.choices.find(c => c.days === input.days);
        if (!eligibility.canGrant || !choice || !eligibility.dueDate || !eligibility.installmentNumber) throw new AttentionError(eligibility.blockedReason || "El plazo solicitado ya venció.", 409);
        const plan = financialPlan(planCredit, now())!;
        if (input.promiseAmount > plan.saldoPendiente || input.promiseDate < today || input.promiseDate > choice.expiresOn) throw new AttentionError("El compromiso debe ser vigente, no superar el saldo y vencer dentro de la prórroga.", 409);
        // The portfolio evaluator remains the authoritative policy at commit time.
        // Eligibility above is only a bounded UI projection and a completeness check.
        const { evaluateMoraExceptionRule } = await import("./mora-exception-requests");
        try {
          evaluateMoraExceptionRule(planCredit, { type: "PRORROGA", expiresOn: choice.expiresOn, promiseAmount: input.promiseAmount, promiseDate: input.promiseDate }, now());
        } catch (error) {
          if (error instanceof CreditApprovalError) throw new AttentionError(error.message, error.status);
          throw error;
        }
        const id = randomUUID(), eventId = randomUUID();
        // This narrowly scoped permission never impersonates ADMIN or uses CENTRAL_DIRECT.
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionRequest"(id,"creditoId",type,status,version,source,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,observation,
          "createdByUserId","createdByName","decidedByUserId","decidedByName","decidedAt","decisionReason","createIdempotencyKey","createRequestHash")
          VALUES($1::uuid,$2,'PRORROGA','APPROVED',1,'ANALYST_REQUEST',$3,$4::date,$5::date,$6,$7::date,$8,$9,$10,$11,$10,$11,$12::timestamptz,$8,$13::uuid,$14) RETURNING id`,
        id, credit.id, eligibility.installmentNumber, eligibility.dueDate, choice.expiresOn, input.promiseAmount, input.promiseDate, input.reason, input.observation, actor.userId, scope.actor.name, now(), input.requestId, fingerprint);
        const payload = { source: "ATTENTION", policy: "ASSIGNED_ANALYST_EXTENSION_1_4", conversationId, days: input.days, expiresOn: choice.expiresOn,
          installmentNumber: eligibility.installmentNumber, installmentDueDate: eligibility.dueDate, promiseAmount: input.promiseAmount, promiseDate: input.promiseDate, reason: input.reason, observation: input.observation };
        await db.$queryRawUnsafe(`INSERT INTO "CreditMoraExceptionEvent"(id,"requestId","creditoId",version,action,"fromStatus","toStatus",payload,"actorUserId","actorName","idempotencyKey","requestHash")
          VALUES($1::uuid,$2::uuid,$3,1,'APPROVED',NULL,'APPROVED',$4::jsonb,$5,$6,$7::uuid,$8) RETURNING id`, eventId, id, credit.id, JSON.stringify(payload), actor.userId, scope.actor.name, input.requestId, fingerprint);
        await db.$queryRawUnsafe(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint,"resultId") VALUES($1,$2::uuid,$3,$4::uuid) RETURNING "requestId"`, actor.key, input.requestId, fingerprint, id);
        const [updated] = await db.$queryRawUnsafe<{ version: number }[]>(`UPDATE "AttentionConversation" SET version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING version`, conversationId);
        await financialAudit(db, scope.actor, conversationId, "EXTENSION_GRANTED", { creditId: credit.id, extensionId: id, requestId: input.requestId, expiresOn: choice.expiresOn, days: input.days });
        return { extension: { id, creditId: credit.id, status: "APPROVED", expiresOn: choice.expiresOn, installmentNumber: eligibility.installmentNumber, installmentDueDate: eligibility.dueDate }, version: updated.version, unchanged: false };
      });
    },
    async receipt(actor: AttentionActor, conversationId: string, creditId: number, expectedPaymentId?: number, expectedVersion?: number) {
      return transact(async db => {
        const { credit, payment, active, actor: currentActor, conversation } = await receiptData(db, actor, conversationId, creditId, expectedPaymentId, expectedVersion);
        let principal: PrincipalQuote | null = null;
        if (await optionalTable(db, "CreditPrincipalPaymentRevision")) {
          const [revision] = await db.$queryRawUnsafe<{ resultado: { quote?: PrincipalQuote } }[]>(`SELECT resultado FROM "CreditPrincipalPaymentRevision" WHERE "creditoId"=$1 AND "abonoId"=$2 LIMIT 1`, credit.id, payment.id);
          if (revision) {
            principal = revision.resultado?.quote || null;
            if (!principal || ![principal.saldoCapitalAntes, principal.saldoCapitalDespues, principal.abonoCapital, principal.cuotasEliminadas].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0) || Math.round(principal.abonoCapital * 100) !== Math.round(payment.valor * 100)) throw new AttentionError("El recibo de capital requiere revisar su desglose registrado.", 409);
          }
        }
        const audited = await readAuditedReceiptAllocation(db as Parameters<typeof readAuditedReceiptAllocation>[0], credit.id, payment.id, active.map(p => ({ id: p.id, valor: p.valor, fechaAbono: new Date(p.fechaAbono) })));
        let earlyPayoff = /LIQUIDACI(?:O|Ó)N\s+ANTICIPADA/i.test(payment.observacion || "");
        if (!earlyPayoff && await optionalTable(db, "WompiPaymentIntent")) {
          const [intent] = await db.$queryRawUnsafe<{ cuotaNumeros: unknown; reference: string }[]>(`SELECT "cuotaNumeros",reference FROM "WompiPaymentIntent" WHERE "creditoId"=$1 AND "processedAbonoId"=$2 ORDER BY "createdAt" DESC LIMIT 1`, credit.id, payment.id);
          earlyPayoff = !!intent && isWompiEarlyPayoffIntent(intent.cuotaNumeros, intent.reference);
        }
        const pdf: ClientPaymentReceiptPdfInput = {
          receiptNumber: `RP-${credit.folio}-${payment.id}`, documentCreatedAt: new Date(payment.createdAt), paymentDate: new Date(payment.fechaAbono), paymentMethod: payment.metodoPago, paymentAmount: payment.valor,
          clientName: credit.clienteNombre, clientDocument: credit.clienteDocumento || "", creditFolio: credit.folio, numeroCreditoVisible: (await numbers(db, [credit])).get(credit.id),
          totalPaidThroughPayment: active.reduce((sum, p) => sum + p.valor, 0), paymentSequence: active.length,
          paymentType: principal ? "PRINCIPAL" : audited ? "AUDITED_RECONCILIATION" : earlyPayoff ? "EARLY_PAYOFF" : "PAYMENT",
          principalPayment: principal ? { capitalBefore: principal.saldoCapitalAntes, capitalAfter: principal.saldoCapitalDespues, capitalApplied: principal.abonoCapital, eliminatedInstallments: principal.cuotasEliminadas } : undefined,
          auditedPayment: audited ? { document: audited.document, ordinaryInstallment: audited.ordinaryInstallment, extraordinaryPrincipal: audited.extraordinaryPrincipal,
            additionalInterest: audited.additionalInterest, lateFee: audited.lateFee, otherCharges: audited.otherCharges, sourceType: audited.sourceType, sourceComponents: audited.sourceComponents } : undefined,
          creditClosed: Boolean(credit.pazYSalvoEmitidoAt), settledAt: credit.pazYSalvoEmitidoAt ? new Date(credit.pazYSalvoEmitidoAt) : null,
        };
        await financialAudit(db, currentActor, conversationId, "PAYMENT_RECEIPT_VIEWED", { creditId: credit.id, paymentId: payment.id });
        return { pdf, paymentId: payment.id, version: conversation.version, fileName: `recibo-pago-${credit.id}-${payment.id}.pdf` };
      });
    },
    async revalidateReceiptSend(db: AttentionDb, actor: AttentionActor, row: MetaReply, creditId: number, paymentId: number) {
      const current = await receiptData(db, actor, row.conversationId, creditId, paymentId, row.conversationVersion);
      if (current.conversation.phone !== `+${row.contactId}` || row.attachment?.fileName !== `recibo-pago-${creditId}-${paymentId}.pdf` || row.attachment.kind !== "document") throw new AttentionError("El recibo no corresponde al destinatario verificado.", 409);
      await financialAudit(db, current.actor, row.conversationId, "PAYMENT_RECEIPT_SENDING", { creditId, paymentId, outboxId: row.id, requestId: row.requestId });
    },
  };
}
