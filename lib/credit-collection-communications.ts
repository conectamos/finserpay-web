import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { assertMoraActor, type MoraActor } from "@/lib/analyst-mora-access";
import { moraCreditSelect } from "@/lib/analyst-mora-credit";
import { getCreditManagement } from "@/lib/analyst-mora-management";
import { ensureAnalystMoraSchema } from "@/lib/analyst-mora-schema";
import { readActiveMoraExtensions } from "@/lib/analyst-mora-extension";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import { getCreditDueReminder, type CreditDueReminderCampaign } from "@/lib/credit-due-reminder-policy";
import { creditDueReminderConfiguration, sendCreditDueReminderOnce } from "@/lib/credit-due-reminders";
import { collectionCallingAllowed, colombiaClock } from "@/lib/collection-voice-policy";
import { ensureCollectionVoiceSchema, runCollectionVoice } from "@/lib/collection-voice-runtime";
import type { CreditCommunicationInput, CreditCommunicationItem, CreditCommunicationStatus, CreditCommunicationState } from "@/lib/credit-collection-communication-types";

const campaigns: CreditDueReminderCampaign[] = ["two_days_before_due", "before_due", "due_today"];
const labels = { two_days_before_due: "Recordatorio: faltan 2 días", before_due: "Recordatorio: vence mañana", due_today: "Recordatorio: vence hoy" };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type StoredEvent = {
  id: string; requestId: string; creditoId: number; action: CreditCommunicationInput["action"];
  stage: CreditCommunicationStatus; phone: string; actorUserId: number; actorName: string;
  requestHash: string; message: string; providerReference: string | null; createdAt: Date | string;
};
type Result = { status: Exclude<CreditCommunicationStatus, "REQUESTED">; message: string; providerReference?: string | null };
const iso = (value: Date | string) => new Date(value).toISOString();
function validCredit(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new CreditApprovalError("INVALID_CREDIT", "Crédito inválido.");
}
export function parseCreditCommunication(value: unknown): CreditCommunicationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreditApprovalError("INVALID_REQUEST", "Solicitud no válida.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["action", "expectedPhone", "idempotencyKey"].includes(key)) ||
    !["REMINDER", "CALL"].includes(String(body.action)) || !uuid.test(String(body.idempotencyKey)) ||
    typeof body.expectedPhone !== "string" || !/^573\d{9}$/.test(body.expectedPhone)) {
    throw new CreditApprovalError("INVALID_REQUEST", "Selecciona una acción y un celular registrado válidos.");
  }
  return { action: body.action as CreditCommunicationInput["action"], expectedPhone: body.expectedPhone, idempotencyKey: String(body.idempotencyKey).toLowerCase() };
}
function voiceConfigured(env: NodeJS.ProcessEnv) {
  if (env.DAPTA_COBRANZA_ENABLED !== "true" || env.DAPTA_COBRANZA_LIVE_READY !== "true" ||
    (env.FINSERPAY_COBRANZA_API_TOKEN || "").length < 32 || !env.FINSERPAY_COBRANZA_AGENT_ID ||
    !Number.isSafeInteger(Number(env.FINSERPAY_COBRANZA_ACTOR_ID)) || Number(env.FINSERPAY_COBRANZA_ACTOR_ID) < 1) return false;
  try {
    const url = new URL(env.DAPTA_COBRANZA_CALL_WEBHOOK_URL || "");
    return url.protocol === "https:" && url.hostname === "api.dapta.ai" && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function createCreditCommunicationService(deps: {
  database?: typeof prisma; now?: () => Date; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch;
  read?: typeof getCreditManagement; schema?: typeof ensureAnalystMoraSchema;
  call?: typeof runCollectionVoice;
} = {}) {
  const database = deps.database ?? prisma;
  const now = deps.now ?? (() => new Date());
  const env = () => deps.env ?? process.env;
  const schema = deps.schema ?? (async () => { await ensureAnalystMoraSchema(); await ensureCollectionVoiceSchema(); });
  const read = deps.read ?? getCreditManagement;

  async function list(id: number): Promise<CreditCommunicationItem[]> {
    validCredit(id); await schema();
    const rows = await database.$queryRawUnsafe<StoredEvent[]>(`SELECT * FROM "CreditCollectionCommunicationEvent" WHERE "creditoId"=$1 ORDER BY "createdAt","id"`, id);
    const attempts = new Map<string, CreditCommunicationItem>();
    // Stages are immutable. Resolve the latest terminal stage independently of timestamp ties.
    for (const row of rows) {
      const current = attempts.get(row.requestId);
      const requestedAt = row.stage === "REQUESTED" ? iso(row.createdAt) : current?.requestedAt || iso(row.createdAt);
      if (current && row.stage === "REQUESTED" && current.status !== "REQUESTED") {
        attempts.set(row.requestId, { ...current, requestedAt });
        continue;
      }
      attempts.set(row.requestId, { id: row.id, requestId: row.requestId, creditoId: row.creditoId,
        action: row.action, status: row.stage, phone: row.phone, actorName: row.actorName,
        requestedAt, createdAt: iso(row.createdAt), message: row.message, providerReference: row.providerReference });
    }
    return [...attempts.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.requestId.localeCompare(a.requestId));
  }
  async function reminderCandidate(id: number, date = now()) {
    const credit = await database.credito.findUnique({ where: { id }, select: moraCreditSelect });
    if (!credit) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
    for (const campaign of campaigns) {
      const reminder = getCreditDueReminder(credit, date, campaign);
      if (reminder) return { campaign, reminder, config: creditDueReminderConfiguration(campaign, env()) };
    }
    return null;
  }
  async function state(id: number): Promise<CreditCommunicationState> {
    validCredit(id); await schema();
    const detail = await read(id, now());
    const candidate = await reminderCandidate(id);
    const phone = normalizeColombianMobile(detail.credit.clienteTelefono);
    const open = collectionCallingAllowed(now());
    const inactive = ["PAGADO", "ANULADO"].includes(detail.credit.estadoCartera);
    const reminderReason = !phone ? "El cliente no tiene un celular colombiano válido." : inactive ? "Este crédito está pagado o anulado." :
      detail.credit.prorrogaActiva ? "El crédito tiene una prórroga activa; el recordatorio está suspendido." : !candidate ?
        "Las plantillas disponibles aplican 2 días antes, 1 día antes y el día del vencimiento." : !candidate.config ?
          "La plantilla de recordatorio correspondiente no está habilitada." : !open ? "Fuera del horario de contacto configurado." : null;
    const callReason = !phone ? "El cliente no tiene un celular colombiano válido." : !detail.credit.enMora || inactive ?
      "La llamada automática de cobranza aplica a créditos en mora. Puedes llamar desde tu teléfono y registrar la gestión." :
      detail.credit.prorrogaActiva ? "El crédito tiene una prórroga activa; la cobranza automática está suspendida." :
      !voiceConfigured(env()) ? "El agente de llamadas no está habilitado." : !open ? "Fuera del horario de contacto configurado." : null;
    const message = `Hola ${detail.credit.clienteNombre}. Te contactamos de FINSER PAY para el seguimiento de tu crédito ${detail.credit.numeroCreditoVisible}. ¿Podemos ayudarte con tu próximo pago?`;
    const whatsappHref = phone && !inactive ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : null;
    return { capabilities: { phone, whatsappHref, reminder: { available: reminderReason === null, reason: reminderReason,
      label: candidate ? labels[candidate.campaign] : "Enviar recordatorio por WhatsApp" },
      call: { available: callReason === null, reason: callReason } }, history: await list(id) };
  }
  async function append(request: StoredEvent, result: Result) {
    await database.$executeRawUnsafe(`INSERT INTO "CreditCollectionCommunicationEvent"
      ("id","requestId","creditoId","action","stage","phone","actorUserId","actorName","requestHash","message","providerReference")
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT("requestId","stage") DO NOTHING`,
    randomUUID(), request.requestId, request.creditoId, request.action, result.status, request.phone,
    request.actorUserId, request.actorName, request.requestHash, result.message, result.providerReference || null);
  }
  async function validateCurrent(id: number, phone: string, actor: MoraActor) {
    const detail = await read(id, now());
    if (normalizeColombianMobile(detail.credit.clienteTelefono) !== phone) throw new CreditApprovalError("CONTACT_CHANGED", "El celular cambió. Actualiza el crédito antes de enviar.", 409);
    if (["PAGADO", "ANULADO"].includes(detail.credit.estadoCartera) || detail.credit.prorrogaActiva)
      throw new CreditApprovalError("CONTACT_SUSPENDED", "El crédito ya no admite este contacto automático.", 409);
    await database.$transaction(async db => { await assertMoraActor(db, actor); });
    return detail;
  }
  async function reminder(request: StoredEvent, actor: MoraActor): Promise<Result> {
    const candidate = await reminderCandidate(request.creditoId);
    if (!candidate?.config || candidate.reminder.phone !== request.phone || !collectionCallingAllowed(now()))
      return { status: "SKIPPED", message: "El recordatorio ya no corresponde a la fecha o al contacto actual." };
    const claimId = randomUUID();
    const claim = await database.$transaction(async db => {
      await assertMoraActor(db, actor);
      const identity = await db.credito.findUnique({ where: { id: request.creditoId }, select: { clienteDocumento: true } });
      const document = (identity?.clienteDocumento || "").replace(/\D/g, "");
      if (!/^\d{5,15}$/.test(document)) return false;
      await db.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text`, "collections:" + createHash("sha256").update(document).digest("hex"));
      await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, request.creditoId);
      const credit = await db.credito.findUnique({ where: { id: request.creditoId }, select: moraCreditSelect });
      const current = credit && getCreditDueReminder(credit, now(), candidate.campaign);
      if (!current || current.phone !== request.phone || current.installmentNumber !== candidate.reminder.installmentNumber || current.dueDate !== candidate.reminder.dueDate ||
        (await readActiveMoraExtensions([request.creditoId], now(), db)).has(request.creditoId)) return false;
      const held = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(`SELECT EXISTS(
        SELECT 1 FROM "CollectionVoiceAttempt" v WHERE v."debtorKey"=$1 AND (v."optOut" OR v."status" IN ('DISPATCHING','DIALING','ACCEPTED','UNKNOWN')
          OR (v."contactedAt" AT TIME ZONE 'America/Bogota')::date=$3::date OR v."outcome"->>'pago_informado'='true'
          OR (v."managementId" IS NULL AND v."outcome"->>'acuerdo_confirmado'='true'))
        UNION ALL SELECT 1 FROM "CreditMoraManagementEvent" m JOIN "Credito" c ON c."id"=m."creditoId"
          WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$2
          AND m."actedAt">=date_trunc('week',$4::timestamptz AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'
          AND ((m."action"='MSJ_TEXTO' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA') OR
            (m."action"='LLAMADA' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA' AND (m."actedAt" AT TIME ZONE 'America/Bogota')::date=$3::date))
        UNION ALL SELECT 1 FROM "Credito" c WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$2 AND (
          EXISTS(SELECT 1 FROM "CreditDueReminder" r WHERE r."creditoId"=c."id" AND r."status" IN ('CLAIMED','UNKNOWN') AND r."claimedAt">=$4::timestamptz-interval '7 days') OR
          EXISTS(SELECT 1 FROM "CreditOverdueDataAttempt" r WHERE r."creditoId"=c."id" AND r."status" IN ('CLAIMED','UNKNOWN') AND r."claimedAt">=$4::timestamptz-interval '7 days') OR
          EXISTS(SELECT 1 FROM "CreditWelcomeVoiceEvent" r WHERE r."creditoId"=c."id" AND (r."status" IN ('DISPATCHING','ACCEPTED','UNKNOWN') OR (r."identityVerifiedAt" AT TIME ZONE 'America/Bogota')::date=$3::date)))) AS blocked`,
      createHash("sha256").update(document).digest("hex"), document, colombiaClock(now()).day, now());
      if (held[0]?.blocked) return false;
      const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO "CreditDueReminder"
        ("id","creditoId","numeroCuota","templateKey","fechaVencimiento","status","claimedAt","claimExpiresAt")
        VALUES($1::uuid,$2,$3,$4,$5::date,'CLAIMED',$6,$7)
        ON CONFLICT("creditoId","numeroCuota","templateKey") DO NOTHING RETURNING "id"`,
      claimId, request.creditoId, current.installmentNumber, candidate.config!.templateKey, current.dueDate, now(), new Date(+now() + 90_000));
      return rows.length > 0;
    });
    if (!claim) return { status: "SKIPPED", message: "Esta cuota ya tiene un recordatorio registrado o pendiente de conciliación; no se repitió el envío." };
    let started = false;
    try {
      await validateCurrent(request.creditoId, request.phone, actor);
      const sent = await database.$transaction(async db => {
        await assertMoraActor(db, actor);
        await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, request.creditoId);
        const credit = await db.credito.findUnique({ where: { id: request.creditoId }, select: moraCreditSelect });
        const current = credit && getCreditDueReminder(credit, now(), candidate.campaign);
        if (!current || current.phone !== request.phone || current.installmentNumber !== candidate.reminder.installmentNumber || current.dueDate !== candidate.reminder.dueDate || !collectionCallingAllowed(now()) ||
          (await readActiveMoraExtensions([request.creditoId], now(), db)).has(request.creditoId)) return null;
        started = true;
        return sendCreditDueReminderOnce(candidate.config!.webhook, current, deps.fetcher ?? fetch);
      }, { timeout: 15_000 });
      if (!sent) {
        await database.$executeRawUnsafe(`DELETE FROM "CreditDueReminder" WHERE "id"=$1::uuid AND "status"='CLAIMED'`, claimId);
        return { status: "SKIPPED", message: "El crédito cambió antes del envío. No se envió el mensaje." };
      }
      await database.$executeRawUnsafe(`UPDATE "CreditDueReminder" SET "status"=$2,"resultCode"=$3,"httpStatus"=$4,"finishedAt"=$5,"updatedAt"=$5 WHERE "id"=$1::uuid AND "status"='CLAIMED'`,
        claimId, sent.status, sent.code, sent.httpStatus, now());
      return { status: sent.status, providerReference: claimId, message: sent.status === "ACCEPTED" ?
        "Dapta aceptó el recordatorio por WhatsApp. La aceptación no confirma entrega ni lectura." : sent.status === "FAILED" ?
          "El proveedor rechazó el recordatorio. El intento quedó registrado." : "No se pudo confirmar el envío por WhatsApp. Revisa el proveedor antes de repetir." };
    } catch {
      if (!started) {
        await database.$executeRawUnsafe(`DELETE FROM "CreditDueReminder" WHERE "id"=$1::uuid AND "status"='CLAIMED'`, claimId);
        return { status: "SKIPPED", message: "El crédito o los permisos cambiaron antes del envío. No se envió el mensaje." };
      }
      await database.$executeRawUnsafe(`UPDATE "CreditDueReminder" SET "status"='UNKNOWN',"resultCode"='MANUAL_OUTCOME_UNKNOWN',"finishedAt"=$2,"updatedAt"=$2 WHERE "id"=$1::uuid AND "status"='CLAIMED'`, claimId, now());
      return { status: "UNKNOWN", message: "El envío quedó sin confirmación. Revisa el proveedor; no se enviará de nuevo automáticamente." };
    }
  }
  async function call(request: StoredEvent, actor: MoraActor): Promise<Result> {
    await validateCurrent(request.creditoId, request.phone, actor);
    await (deps.call ?? runCollectionVoice)({ immediate: true, limit: 1, creditId: request.creditoId, requestId: request.requestId,
      beforeDispatch: async () => { await validateCurrent(request.creditoId, request.phone, actor); } });
    const rows = await database.$queryRawUnsafe<Array<{ status: string; providerCallId: string | null }>>(`SELECT "status","providerCallId" FROM "CollectionVoiceAttempt" WHERE "id"=$1::uuid AND "creditoId"=$2`, request.requestId, request.creditoId);
    const attempt = rows[0];
    if (attempt?.providerCallId) return { status: "ACCEPTED", providerReference: attempt.providerCallId, message: "Dapta aceptó la llamada de cobranza. El resultado se registrará cuando responda el proveedor." };
    if (attempt && ["UNKNOWN", "DISPATCHING", "DIALING", "ACCEPTED"].includes(attempt.status))
      return { status: "UNKNOWN", message: "No se confirmó el inicio de la llamada. Revisa el proveedor antes de repetir." };
    return { status: "SKIPPED", message: "No se inició la llamada: el crédito tiene un contacto, acuerdo o intento previo protegido, o dejó de cumplir las condiciones." };
  }
  async function dispatch(id: number, input: CreditCommunicationInput, actor: MoraActor) {
    validCredit(id); await schema();
    // Re-parse even callers other than the HTTP route; destination is never arbitrary.
    input = parseCreditCommunication(input);
    const hash = createHash("sha256").update(JSON.stringify({ id, input, actorId: actor.id })).digest("hex");
    const claimed = await database.$transaction(async db => {
      const verified = await assertMoraActor(db, actor);
      await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, id);
      const prior = await db.$queryRawUnsafe<StoredEvent[]>(`SELECT * FROM "CreditCollectionCommunicationEvent" WHERE "requestId"=$1::uuid AND "stage"='REQUESTED'`, input.idempotencyKey);
      if (prior[0]) {
        if (prior[0].requestHash !== hash || prior[0].creditoId !== id) throw new CreditApprovalError("IDEMPOTENCY_CONFLICT", "Este intento ya corresponde a otra acción.", 409);
        return { request: prior[0], replay: true };
      }
      const credit = await db.credito.findUnique({ where: { id }, select: { id: true, clienteTelefono: true } });
      if (!credit) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
      if (normalizeColombianMobile(credit.clienteTelefono) !== input.expectedPhone) throw new CreditApprovalError("CONTACT_CHANGED", "El celular cambió. Actualiza el crédito antes de enviar.", 409);
      const rows = await db.$queryRawUnsafe<StoredEvent[]>(`INSERT INTO "CreditCollectionCommunicationEvent"
        ("id","requestId","creditoId","action","stage","phone","actorUserId","actorName","requestHash","message")
        VALUES($1::uuid,$2::uuid,$3,$4,'REQUESTED',$5,$6,$7,$8,$9) RETURNING *`,
      randomUUID(), input.idempotencyKey, id, input.action, input.expectedPhone, verified.id, verified.nombre, hash, "Solicitud registrada; pendiente de confirmación del proveedor.");
      return { request: rows[0], replay: false };
    });
    if (claimed.replay) return { unchanged: true, state: await state(id) };
    let outcome: Result;
    try {
      const current = await state(id);
      const capability = input.action === "REMINDER" ? current.capabilities.reminder : current.capabilities.call;
      outcome = !capability.available ? { status: "SKIPPED", message: capability.reason || "La comunicación no está disponible." } :
        await (input.action === "REMINDER" ? reminder(claimed.request, actor) : call(claimed.request, actor));
    } catch {
      // Once a request has been reserved, a failure is not permission to replay HTTP.
      outcome = { status: "UNKNOWN", message: "No se pudo confirmar la operación. Consulta el proveedor antes de intentar otro contacto." };
    }
    await append(claimed.request, outcome);
    return { unchanged: false, state: await state(id) };
  }
  return { state, list, dispatch };
}
const service = createCreditCommunicationService();
export const getCreditCommunicationState = service.state;
export const listCreditCommunications = service.list;
export const dispatchCreditCommunication = service.dispatch;
