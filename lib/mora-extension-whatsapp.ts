import "server-only";
import { randomUUID } from "node:crypto";
import { assertMoraActor, type MoraActor } from "@/lib/analyst-mora-access";
import type { AttentionDatabase, AttentionDb } from "@/lib/atencion-storage";
import { colombiaDateKey } from "@/lib/colombia-date";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import type { MoraExtensionWhatsApp } from "@/lib/mora-exception-types";
import { normalizeWhatsAppRecipient } from "@/lib/whatsapp";
import { isMetaAutomationConfigured, sendMetaAutomation, type MetaAutomationSender } from "@/lib/whatsapp-automation-provider";

type Notification = Omit<MoraExtensionWhatsApp, "canRetry"> & {
  name: string | null; phone: string | null; operationKey: string | null;
  nextAttemptAt: string | null; leaseToken: string | null; leaseUntil: string | null;
};
type RequestRow = {
  id: string; creditoId: number; status: string; expiresOn: Date | string | null;
  activationWhatsApp: Notification | null;
};
type Receipt = { status: string; wamid: string | null; acceptedAt: Date | string | null; errorCode: string | null };
type Options = {
  database: AttentionDatabase; env?: NodeJS.ProcessEnv; now?: () => Date; sendMeta?: MetaAutomationSender;
  authorize?: typeof assertMoraActor;
};
const transactionOptions = { isolationLevel: "ReadCommitted" as const, timeout: 30_000, maxWait: 10_000 };
const accepted = new Set(["accepted", "sent", "delivered", "read"]);
const ambiguous = new Set(["queued", "sending", "uncertain"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const iso = (value: Date | string) => new Date(value).toISOString();
const day = (value: Date | string) => value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
const cleanName = (value: string | null) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

function message(code: string | null) {
  if (!code) return null;
  if (code === "MISSING_EXTENSION_EXPIRY") return "La prórroga no tiene fecha de vencimiento para calcular los días.";
  if (code === "INVALID_EXTENSION_PHONE") return "Revisa el teléfono de WhatsApp registrado en el crédito.";
  if (code === "MISSING_EXTENSION_NAME") return "El crédito no tiene un nombre de cliente válido.";
  if (code === "EXTENSION_NOT_ACTIVE") return "La prórroga ya no está activa; el mensaje no se enviará.";
  if (code === "EXTENSION_CHANGED") return "La fecha de la prórroga cambió antes del envío. Revisa y reintenta.";
  if (code === "EXTENSION_CONTACT_CHANGED") return "Los datos de contacto del crédito cambiaron antes del envío. Revisa y reintenta.";
  if (code === "META_CONFIRMATION_PENDING") return "WhatsApp aún no confirma el resultado. Se conciliará sin duplicar el envío.";
  if (code === "META_AUTOMATION_DISABLED") return "La integración de WhatsApp está pendiente de configuración.";
  if (code.startsWith("TEMPLATE_")) return "La plantilla de prórroga debe estar aprobada en Meta y conservar el texto configurado.";
  return `No se confirmó el envío de WhatsApp (${code}).`;
}

/** Uses the existing Meta outbox and signed delivery webhook. The request row
 * holds only the transactional activation intent and the current attempt key. */
export function createMoraExtensionWhatsAppService(options: Options) {
  const database = options.database, now = options.now ?? (() => new Date());
  const env = options.env ?? process.env, sendMeta = options.sendMeta ?? sendMetaAutomation;
  const transact = <T>(run: (db: AttentionDb) => Promise<T>) => database.$transaction(run, transactionOptions);

  async function receipt(db: AttentionDb, notification: Notification): Promise<Receipt | null> {
    if (!notification.operationKey) return null;
    return (await db.$queryRawUnsafe<Receipt[]>(`SELECT status,wamid,"acceptedAt","errorCode"
      FROM "WhatsAppAutomationMetaOutbox" WHERE "operationKey"=$1`, notification.operationKey))[0] || null;
  }
  function active(row: RequestRow) {
    return row.status === "APPROVED" && row.expiresOn !== null && day(row.expiresOn) >= colombiaDateKey(now());
  }
  function view(row: RequestRow, outbox: Receipt | null): MoraExtensionWhatsApp | null {
    const notification = row.activationWhatsApp;
    if (!notification) return null;
    const status = outbox && accepted.has(outbox.status) ? "SENT" : outbox?.status === "failed" ? "FAILED" : notification.status;
    const error = outbox && ambiguous.has(outbox.status) ? "META_CONFIRMATION_PENDING" : outbox?.errorCode || notification.error;
    const busy = notification.leaseUntil && new Date(notification.leaseUntil) > now();
    return { status, activatedAt: iso(notification.activatedAt), approvedDays: notification.approvedDays,
      expiresAt: notification.expiresAt ? iso(notification.expiresAt) : null, authorizedByName: notification.authorizedByName,
      sentAt: outbox?.acceptedAt ? iso(outbox.acceptedAt) : notification.sentAt, attempts: notification.attempts,
      error: status === "SENT" ? null : message(error),
      canRetry: status === "FAILED" && row.status === "APPROVED" && !busy
        && (!outbox || outbox.status === "failed")
        && (row.expiresOn === null || day(row.expiresOn) >= colombiaDateKey(now())) };
  }
  async function read(id: string): Promise<MoraExtensionWhatsApp | null> {
    if (!uuid.test(id)) throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND", "Solicitud no encontrada.", 404);
    const [row] = await database.$queryRawUnsafe<RequestRow[]>(`SELECT id,"creditoId",status,"expiresOn","activationWhatsApp"
      FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, id);
    return row?.activationWhatsApp ? view(row, await receipt(database, row.activationWhatsApp)) : null;
  }
  async function save(row: RequestRow, patch: Partial<Notification>) {
    return database.$queryRawUnsafe(`UPDATE "CreditMoraExceptionRequest"
      SET "activationWhatsApp"="activationWhatsApp"||$3::jsonb
      WHERE id=$1::uuid AND "activationWhatsApp"->>'leaseToken'=$2 RETURNING id`,
    row.id, row.activationWhatsApp!.leaseToken, JSON.stringify({ ...patch, leaseToken: null, leaseUntil: null }));
  }
  async function claim(): Promise<RequestRow | null> {
    const at = now(), token = randomUUID();
    const [row] = await database.$queryRawUnsafe<RequestRow[]>(`WITH candidate AS (
      SELECT id FROM "CreditMoraExceptionRequest" WHERE "activationWhatsApp" IS NOT NULL
        AND "activationWhatsApp"->>'status'<>'SENT'
        AND ("activationWhatsApp"->>'nextAttemptAt')::timestamptz<=$1::timestamptz
        AND ("activationWhatsApp"->>'leaseUntil' IS NULL OR ("activationWhatsApp"->>'leaseUntil')::timestamptz<=$1::timestamptz)
      ORDER BY "activationWhatsApp"->>'nextAttemptAt',id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE "CreditMoraExceptionRequest" r SET "activationWhatsApp"=r."activationWhatsApp"||jsonb_build_object(
      'leaseToken',$2::text,'leaseUntil',$3::text,
      'attempts',COALESCE((r."activationWhatsApp"->>'attempts')::int,0)+CASE WHEN r."activationWhatsApp"->>'operationKey' IS NULL THEN 1 ELSE 0 END,
      'operationKey',COALESCE(r."activationWhatsApp"->>'operationKey','prorroga_activada:'||r.id::text||':a'||
        (COALESCE((r."activationWhatsApp"->>'attempts')::int,0)+1)::text))
      FROM candidate WHERE r.id=candidate.id RETURNING r.id,r."creditoId",r.status,r."expiresOn",r."activationWhatsApp"`,
    at.toISOString(), token, new Date(at.getTime() + 120_000).toISOString());
    return row || null;
  }
  async function retry(id: string, actor: MoraActor): Promise<MoraExtensionWhatsApp | null> {
    if (!uuid.test(id)) throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND", "Solicitud no encontrada.", 404);
    await transact(async db => {
      await (options.authorize ?? assertMoraActor)(db as Parameters<typeof assertMoraActor>[0], actor);
      const [location] = await db.$queryRawUnsafe<{ creditoId: number }[]>(`SELECT "creditoId" FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, id);
      if (!location) throw new CreditApprovalError("MORA_EXCEPTION_NOT_FOUND", "Solicitud no encontrada.", 404);
      const [credit] = await db.$queryRawUnsafe<{ name: string | null; phone: string | null; state: string | null }[]>(
        `SELECT "clienteNombre" AS name,"clienteTelefono" AS phone,estado AS state FROM "Credito" WHERE id=$1 FOR UPDATE`, location.creditoId);
      const [row] = await db.$queryRawUnsafe<RequestRow[]>(`SELECT id,"creditoId",status,"expiresOn","activationWhatsApp" FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid FOR UPDATE`, id);
      if (!row.activationWhatsApp || !view(row, await receipt(db, row.activationWhatsApp))?.canRetry
        || !credit || /^(ANULAD[OA]|CANCELAD[OA])$/i.test(credit.state || ""))
        throw new CreditApprovalError("WHATSAPP_RETRY_UNAVAILABLE", "Este envío no admite reintento. Actualiza el historial para consultar su estado.", 409);
      const notification = row.activationWhatsApp;
      const days = row.expiresOn === null ? null : Math.max(1, Math.round((Date.parse(`${day(row.expiresOn)}T00:00:00Z`)
        - Date.parse(`${colombiaDateKey(new Date(notification.activatedAt))}T00:00:00Z`)) / 86_400_000));
      const expiresAt = row.expiresOn === null ? null : new Date(`${day(row.expiresOn)}T23:59:59.999-05:00`).toISOString();
      const next = { ...notification, name: credit.name, phone: credit.phone, approvedDays: days, expiresAt,
        status: "PENDING", error: null, operationKey: null, nextAttemptAt: now().toISOString(), leaseToken: null, leaseUntil: null };
      await db.$queryRawUnsafe(`UPDATE "CreditMoraExceptionRequest" SET "activationWhatsApp"=$2::jsonb WHERE id=$1::uuid RETURNING id`, id, JSON.stringify(next));
    });
    return read(id);
  }
  async function run({ limit = 5 }: { limit?: number } = {}) {
    const report = { configured: isMetaAutomationConfigured(env, "prorroga_activada"), selected: 0, sent: 0, failed: 0, pending: 0 };
    if (!report.configured) return report;
    const deadline = now().getTime() + 25_000;
    for (let index = 0; index < Math.min(10, Math.max(1, limit)); index++) {
      if (deadline - now().getTime() < 13_000) break;
      const row = await claim();
      if (!row) break;
      report.selected++;
      const notification = row.activationWhatsApp!;
      // A receipt survives expiry/cancellation and worker crashes. Reconcile it
      // before checking whether a *new* network submission is still allowed.
      const prior = await receipt(database, notification);
      if (prior && accepted.has(prior.status)) {
        await save(row, { status: "SENT", sentAt: prior.acceptedAt ? iso(prior.acceptedAt) : now().toISOString(), error: null, nextAttemptAt: null });
        report.sent++; continue;
      }
      if (prior?.status === "failed" && prior.wamid) {
        await save(row, { status: "FAILED", error: prior.errorCode || "META_DELIVERY_FAILED", nextAttemptAt: null });
        report.failed++; continue;
      }
      const name = cleanName(notification.name), phone = normalizeWhatsAppRecipient(notification.phone);
      const invalid = !active(row) ? "EXTENSION_NOT_ACTIVE" : !notification.expiresAt || !notification.approvedDays ? "MISSING_EXTENSION_EXPIRY"
        : !name ? "MISSING_EXTENSION_NAME" : !/^573\d{9}$/.test(phone) ? "INVALID_EXTENSION_PHONE" : null;
      if (invalid && !(prior && ambiguous.has(prior.status))) {
        await save(row, { status: "FAILED", error: invalid, nextAttemptAt: null, operationKey: null });
        report.failed++; continue;
      }
      let guardCode: string | null = null;
      try {
        const result = await sendMeta({ operationKey: notification.operationKey!, template: "prorroga_activada", phone,
          body: [name, String(notification.approvedDays)] }, { database, env, deadlineAt: deadline, withSendGuard: send => transact(async db => {
          // Same credit/request lock order as activation, amendment and cancellation.
          const [credit] = await db.$queryRawUnsafe<{ estado: string; clienteNombre: string | null; clienteTelefono: string | null }[]>(
            `SELECT estado,"clienteNombre","clienteTelefono" FROM "Credito" WHERE id=$1 FOR UPDATE`, row.creditoId);
          const [current] = await db.$queryRawUnsafe<RequestRow[]>(`SELECT id,"creditoId",status,"expiresOn","activationWhatsApp"
            FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid FOR UPDATE`, row.id);
          if (!credit || /^(ANULAD[OA]|CANCELAD[OA])$/i.test(credit.estado) || !current || !active(current)
            || current.activationWhatsApp?.leaseToken !== notification.leaseToken
            || !current.activationWhatsApp.leaseUntil || new Date(current.activationWhatsApp.leaseUntil) <= now()) {
            guardCode = "EXTENSION_NOT_ACTIVE";
            throw new CreditApprovalError(guardCode, "La prórroga ya no está activa.", 409);
          }
          if (normalizeWhatsAppRecipient(credit.clienteTelefono) !== phone || cleanName(credit.clienteNombre) !== name) {
            guardCode = "EXTENSION_CONTACT_CHANGED";
            throw new CreditApprovalError(guardCode, "El contacto del crédito cambió antes del envío.", 409);
          }
          if (new Date(`${day(current.expiresOn!)}T23:59:59.999-05:00`).toISOString() !== iso(notification.expiresAt!)) {
            guardCode = "EXTENSION_CHANGED";
            throw new CreditApprovalError("EXTENSION_CHANGED", "El vencimiento cambió antes del envío.", 409);
          }
          return send();
        }) });
        // Re-read the durable receipt: webhooks and an ACK can race the worker.
        const outbox = await receipt(database, notification);
        if (result.status === "accepted" || (outbox && accepted.has(outbox.status))) {
          await save(row, { status: "SENT", sentAt: outbox?.acceptedAt ? iso(outbox.acceptedAt) : now().toISOString(), error: null, nextAttemptAt: null });
          report.sent++;
        } else if (result.status === "unknown" || (outbox && ambiguous.has(outbox.status))) {
          await save(row, { status: "PENDING", error: "META_CONFIRMATION_PENDING", nextAttemptAt: new Date(now().getTime() + 60_000).toISOString() });
          report.pending++;
        } else {
          const delay = Math.min(3600, 60 * 2 ** Math.min(notification.attempts, 6));
          await save(row, { status: "FAILED", error: guardCode || result.code, operationKey: outbox?.wamid ? notification.operationKey : null,
            nextAttemptAt: outbox?.wamid || guardCode ? null : new Date(now().getTime() + delay * 1000).toISOString() });
          report.failed++;
          console.error("MORA_EXTENSION_WHATSAPP_FAILED", { requestId: row.id, code: result.code });
        }
      } catch {
        // Keep the attempt key if persistence/network outcome is not known.
        await save(row, { status: "PENDING", error: "META_CONFIRMATION_PENDING", nextAttemptAt: new Date(now().getTime() + 60_000).toISOString() });
        report.pending++;
        console.error("MORA_EXTENSION_WHATSAPP_PENDING", { requestId: row.id });
      }
    }
    return report;
  }
  return { read, retry, run };
}

async function service() {
  const { ensureMoraExceptionRequestSchema } = await import("@/lib/mora-exception-schema");
  await ensureMoraExceptionRequestSchema();
  const { default: database } = await import("@/lib/prisma");
  return createMoraExtensionWhatsAppService({ database });
}
export async function getMoraExtensionWhatsApp(id: string) { return (await service()).read(id); }
export async function retryMoraExtensionWhatsApp(id: string, actor: MoraActor) { return (await service()).retry(id, actor); }
export async function runMoraExtensionWhatsApp(options: { limit?: number } = {}) { return (await service()).run(options); }
