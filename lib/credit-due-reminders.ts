import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { colombiaDateKey } from "@/lib/colombia-date";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import {
  getCreditDueReminder,
  isCreditDueReminderWindow,
  type CreditDueReminderCampaign,
} from "@/lib/credit-due-reminder-policy";

// The ledger identifies an installment/template, never a recipient or webhook credential.
export const CREDIT_DUE_REMINDER_TEMPLATE_KEY = "recordatorio_1_dia_falta_antescuota";
export const CREDIT_DUE_TODAY_REMINDER_TEMPLATE_KEY = "recordatorio_hoyvence_cuota";
const campaignConfig = {
  before_due: {
    templateKey: CREDIT_DUE_REMINDER_TEMPLATE_KEY,
    enabledEnv: "DAPTA_RECORDATORIO_1_DIA_ENABLED",
    webhookEnv: "DAPTA_RECORDATORIO_1_DIA_WEBHOOK_URL",
  },
  due_today: {
    templateKey: CREDIT_DUE_TODAY_REMINDER_TEMPLATE_KEY,
    enabledEnv: "DAPTA_HOYVENCE_ENABLED",
    webhookEnv: "DAPTA_HOYVENCE_WEBHOOK_URL",
  },
} as const;
const PAGE_SIZE = 250;
const CLAIM_LIFETIME_MS = 90_000;
const SEND_TIMEOUT_MS = 8_000;
const creditSelect = {
  id: true,
  clienteNombre: true,
  clienteTelefono: true,
  estado: true,
  pazYSalvoEmitidoAt: true,
  planCapitalVigente: true,
  montoCredito: true,
  valorCuota: true,
  plazoMeses: true,
  frecuenciaPago: true,
  fechaPrimerPago: true,
  fechaProximoPago: true,
  abonos: {
    where: { estado: { not: "ANULADO" } },
    select: { valor: true, fechaAbono: true, estado: true },
  },
} as const;

export type CreditDueReminderOptions = {
  campaign?: CreditDueReminderCampaign;
  dryRun?: boolean;
  // A preview may inspect another date. Real dispatch always uses the live clock.
  previewDate?: Date | string;
};
export type CreditDueReminderReport = {
  campaign: CreditDueReminderCampaign;
  ok: boolean;
  dryRun: boolean;
  enabled: boolean;
  configured: boolean;
  inWindow: boolean;
  generatedAt: string;
  today: string;
  templateKey: string;
  summary: {
    scanned: number;
    eligible: number;
    invalidPhone: number;
    excluded: number;
    claimed: number;
    accepted: number;
    failed: number;
    unknown: number;
    duplicates: number;
    staleClaims: number;
    revalidatedOut: number;
  };
};
type DispatchResult = {
  status: "ACCEPTED" | "FAILED" | "UNKNOWN";
  code: string;
  httpStatus: number | null;
};

function configuredWebhook(value: string | undefined) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && url.hostname === "api.dapta.ai"
      && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

function hasDaptaExecutionError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasDaptaExecutionError);
  const record = value as Record<string, unknown>;
  if (record.ok === false || record.success === false || record.error === true
    || (typeof record.error === "string" && record.error.trim())
    || (record.error && typeof record.error === "object" && Object.keys(record.error).length)) return true;
  return Object.values(record).some(hasDaptaExecutionError);
}

async function sendOnce(
  webhook: URL,
  reminder: NonNullable<ReturnType<typeof getCreditDueReminder>>,
  fetcher: typeof fetch,
): Promise<DispatchResult> {
  try {
    const response = await fetcher(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credito_id: String(reminder.creditId),
        telefono: reminder.phone,
        nombre: reminder.name,
        cuota_numero: String(reminder.installmentNumber),
        fecha_vencimiento: reminder.dueDate,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return { status: "FAILED", code: "HTTP_REJECTED", httpStatus: response.status };
    // HTTP 200 alone does not prove that Dapta executed its WhatsApp node.
    // An explicit {ok:true} (or Dapta's response wrapper) means acceptance, never delivery.
    let payload: unknown;
    try { payload = await response.json(); }
    catch { return { status: "UNKNOWN", code: "UNREADABLE_RESPONSE", httpStatus: response.status }; }
    if (hasDaptaExecutionError(payload)) return { status: "FAILED", code: "FLOW_REJECTED", httpStatus: response.status };
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const responseBody = record?.response && typeof record.response === "object"
      ? record.response as Record<string, unknown> : null;
    return record?.ok === true || responseBody?.ok === true
      ? { status: "ACCEPTED", code: "FLOW_ACCEPTED", httpStatus: response.status }
      : { status: "UNKNOWN", code: "UNCONFIRMED_RESPONSE", httpStatus: response.status };
  } catch {
    // The provider may already have received the request. Do not retry it.
    return { status: "UNKNOWN", code: "NETWORK_OUTCOME_UNKNOWN", httpStatus: null };
  }
}

export function createCreditDueReminderRunner(deps: {
  database?: typeof prisma;
  now?: () => Date;
  fetcher?: typeof fetch;
  enabled?: (campaign: CreditDueReminderCampaign) => boolean;
  webhookUrl?: (campaign: CreditDueReminderCampaign) => string | undefined;
} = {}) {
  const database = deps.database ?? prisma;
  const now = deps.now ?? (() => new Date());
  return async function run(options: CreditDueReminderOptions = {}): Promise<CreditDueReminderReport> {
    const campaign = options.campaign ?? "before_due";
    if (campaign !== "before_due" && campaign !== "due_today") throw new Error("Invalid reminder campaign");
    const config = campaignConfig[campaign];
    const liveNow = now();
    const dryRun = options.dryRun !== false;
    const today = dryRun && options.previewDate ? options.previewDate : liveNow;
    const enabled = deps.enabled ? deps.enabled(campaign) : process.env[config.enabledEnv] === "true";
    const webhook = configuredWebhook(deps.webhookUrl ? deps.webhookUrl(campaign) : process.env[config.webhookEnv]);
    const report: CreditDueReminderReport = {
      campaign, ok: true, dryRun, enabled, configured: Boolean(webhook), inWindow: isCreditDueReminderWindow(liveNow),
      generatedAt: liveNow.toISOString(), today: colombiaDateKey(today), templateKey: config.templateKey,
      summary: { scanned: 0, eligible: 0, invalidPhone: 0, excluded: 0, claimed: 0,
        accepted: 0, failed: 0, unknown: 0, duplicates: 0, staleClaims: 0, revalidatedOut: 0 },
    };
    if (!dryRun && (!enabled || !webhook || !report.inWindow)) return report;

    if (!dryRun) {
      // A crashed claimant can never be selected for another attempt.
      report.summary.staleClaims = await database.$executeRawUnsafe(
        `UPDATE "CreditDueReminder" SET "status"='UNKNOWN', "resultCode"='CLAIM_EXPIRED',
          "finishedAt"=$1, "updatedAt"=$1
          WHERE "status"='CLAIMED' AND "claimExpiresAt" <= $1 AND "templateKey"=$2`, liveNow, config.templateKey,
      );
    }
    let cursor = 0;
    for (;;) {
      const credits = await database.credito.findMany({
        where: { id: { gt: cursor } }, orderBy: { id: "asc" }, select: creditSelect, take: PAGE_SIZE,
      });
      if (!credits.length) break;
      for (const credit of credits) {
        // Keyset pagination must progress even when a database adapter misbehaves.
        if (!Number.isSafeInteger(credit.id) || credit.id <= cursor) throw new Error("Invalid reminder scan cursor");
        cursor = credit.id;
        report.summary.scanned += 1;
        const candidate = getCreditDueReminder(credit, today, campaign);
        if (!candidate) {
          // Count invalid contacts separately only when all financial conditions qualify.
          const financialCandidate = !normalizeColombianMobile(credit.clienteTelefono)
            ? getCreditDueReminder({ ...credit, clienteTelefono: "3000000000" }, today, campaign) : null;
          if (financialCandidate) report.summary.invalidPhone += 1;
          else report.summary.excluded += 1;
          continue;
        }
        report.summary.eligible += 1;
        if (dryRun) continue;

        const claimId = randomUUID();
        const claim = await database.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, credit.id);
          const current = await tx.credito.findUnique({ where: { id: credit.id }, select: creditSelect });
          const claimedAt = now();
          const reminder = current && isCreditDueReminderWindow(claimedAt) ? getCreditDueReminder(current, claimedAt, campaign) : null;
          if (!reminder || reminder.installmentNumber !== candidate.installmentNumber || reminder.dueDate !== candidate.dueDate) return "ineligible";
          const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO "CreditDueReminder" ("id","creditoId","numeroCuota","templateKey",
              "fechaVencimiento","status","claimedAt","claimExpiresAt")
             VALUES ($1::uuid,$2,$3,$4,$5::date,'CLAIMED',$6,$7)
             ON CONFLICT ("creditoId","numeroCuota","templateKey") DO NOTHING RETURNING "id"`,
            claimId, reminder.creditId, reminder.installmentNumber, config.templateKey,
            reminder.dueDate, claimedAt, new Date(claimedAt.getTime() + CLAIM_LIFETIME_MS),
          );
          return rows.length ? "claimed" : "duplicate";
        });
        if (claim === "ineligible") { report.summary.revalidatedOut += 1; continue; }
        if (claim === "duplicate") { report.summary.duplicates += 1; continue; }
        report.summary.claimed += 1;

        let result: DispatchResult;
        const active = await database.$queryRawUnsafe<Array<{ id: string; claimExpiresAt: Date | string }>>(
          `SELECT "id","claimExpiresAt" FROM "CreditDueReminder" WHERE "id"=$1::uuid
            AND "status"='CLAIMED' AND "claimExpiresAt">$2`, claimId, now(),
        );
        if (!active.length) result = { status: "UNKNOWN", code: "CLAIM_EXPIRED", httpStatus: null };
        else {
          // Re-read after all claim queries, as close to the network request as possible.
          const current = await database.credito.findUnique({ where: { id: credit.id }, select: creditSelect });
          const validatedAt = now();
          const reminder = current ? getCreditDueReminder(current, validatedAt, campaign) : null;
          const dispatchAt = now();
          if (!reminder || reminder.installmentNumber !== candidate.installmentNumber || reminder.dueDate !== candidate.dueDate
            || !isCreditDueReminderWindow(dispatchAt) || new Date(active[0].claimExpiresAt).getTime() <= dispatchAt.getTime()) {
            report.summary.revalidatedOut += 1;
            // This owner knows it never began HTTP. Release only its still-active
            // claim so a rescheduled/unpaid installment can qualify on its new eve.
            // Any UNKNOWN/ACCEPTED/provider-FAILED outcome remains permanently deduplicated.
            const released = await database.$executeRawUnsafe(
              `DELETE FROM "CreditDueReminder" WHERE "id"=$1::uuid AND "status"='CLAIMED'`, claimId,
            );
            if (!released) report.summary.unknown += 1;
            continue;
          }
          result = await sendOnce(webhook!, reminder, deps.fetcher ?? fetch);
        }
        const finishedAt = now();
        // A competing restart may have expired the claim. Keep UNKNOWN conservative.
        const finalized = await database.$executeRawUnsafe(
          `UPDATE "CreditDueReminder" SET "status"=$2,"resultCode"=$3,"httpStatus"=$4,
            "finishedAt"=$5,"updatedAt"=$5 WHERE "id"=$1::uuid AND "status"='CLAIMED'`,
          claimId, result.status, result.code, result.httpStatus, finishedAt,
        );
        if (!finalized || result.status === "UNKNOWN") report.summary.unknown += 1;
        else if (result.status === "ACCEPTED") report.summary.accepted += 1;
        else report.summary.failed += 1;
      }
    }
    report.ok = report.summary.failed === 0 && report.summary.unknown === 0;
    return report;
  };
}

export const runCreditDueReminders = createCreditDueReminderRunner();
