import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { colombiaDateKey } from "@/lib/colombia-date";
import {
  getCreditOverdueDataCandidate,
  groupCreditOverdueDataCandidates,
  isCreditOverdueDataWindow,
  type CreditOverdueDataCandidate,
} from "@/lib/credit-overdue-data-policy";

export const CREDIT_OVERDUE_DATA_TEMPLATE_KEY = "datos_mora_20_cada_3_dias";
const PAGE_SIZE = 250;
const CLAIM_LIFETIME_MS = 90_000;
const SEND_TIMEOUT_MS = 8_000;
const creditSelect = {
  id: true, clienteNombre: true, clienteTelefono: true, estado: true,
  pazYSalvoEmitidoAt: true, planCapitalVigente: true, montoCredito: true,
  valorCuota: true, plazoMeses: true, frecuenciaPago: true,
  fechaPrimerPago: true, fechaProximoPago: true,
  abonos: { where: { estado: { not: "ANULADO" } }, select: { valor: true, fechaAbono: true, estado: true } },
} as const;

export type CreditOverdueDataOptions = { dryRun?: boolean; previewDate?: Date | string };
export type CreditOverdueDataReport = {
  campaign: "datos"; templateKey: string; ok: boolean; dryRun: boolean;
  enabled: boolean; configured: boolean; inWindow: boolean; startsOn: string | null;
  initialBatchDate: string | null; generatedAt: string; today: string;
  summary: { scanned: number; eligibleCredits: number; eligibleClients: number; excluded: number;
    waiting: number; ready: number; claimed: number; accepted: number; failed: number;
    unknown: number; duplicates: number; staleClaims: number; revalidatedOut: number };
};
type Recipient = { nextEligibleDate: Date | string | null };
type DispatchResult = { status: "ACCEPTED" | "FAILED" | "UNKNOWN"; code: string; httpStatus: number | null };

function recipientKey(phone: string) {
  return createHash("sha256").update("finserpay-datos:" + phone).digest("hex");
}
function dateKey(value: Date | string) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
function nextCampaignDate(today: string) {
  const date = new Date(today + "T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + 3);
  return date.toISOString().slice(0, 10);
}
function validStartDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function configuredWebhook(value: string | undefined) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && url.hostname === "api.dapta.ai"
      && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}
function hasExecutionError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasExecutionError);
  const record = value as Record<string, unknown>;
  if (record.ok === false || record.success === false || record.error === true
    || (typeof record.error === "string" && record.error.trim())
    || (record.error && typeof record.error === "object" && Object.keys(record.error).length)) return true;
  return Object.values(record).some(hasExecutionError);
}
async function dispatch(webhook: URL, candidate: CreditOverdueDataCandidate, fetcher: typeof fetch): Promise<DispatchResult> {
  try {
    const response = await fetcher(webhook, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credito_id: String(candidate.creditId), telefono: candidate.phone,
        nombre: candidate.name, dias_mora: String(candidate.daysPastDue) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS), cache: "no-store", redirect: "error",
    });
    if (!response.ok) return { status: "FAILED", code: "HTTP_REJECTED", httpStatus: response.status };
    let payload: unknown;
    try { payload = await response.json(); }
    catch { return { status: "UNKNOWN", code: "UNREADABLE_RESPONSE", httpStatus: response.status }; }
    if (hasExecutionError(payload)) return { status: "FAILED", code: "FLOW_REJECTED", httpStatus: response.status };
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const body = record?.response && typeof record.response === "object" ? record.response as Record<string, unknown> : null;
    return record?.ok === true || body?.ok === true
      ? { status: "ACCEPTED", code: "FLOW_ACCEPTED", httpStatus: response.status }
      : { status: "UNKNOWN", code: "UNCONFIRMED_RESPONSE", httpStatus: response.status };
  } catch { return { status: "UNKNOWN", code: "NETWORK_OUTCOME_UNKNOWN", httpStatus: null }; }
}

export function createCreditOverdueDataRunner(deps: {
  database?: typeof prisma; now?: () => Date; fetcher?: typeof fetch;
  enabled?: () => boolean; webhookUrl?: () => string | undefined;
} = {}) {
  const database = deps.database ?? prisma;
  const now = deps.now ?? (() => new Date());
  return async function run(options: CreditOverdueDataOptions = {}): Promise<CreditOverdueDataReport> {
    const liveNow = now();
    const dryRun = options.dryRun !== false;
    const today = dryRun && options.previewDate ? options.previewDate : liveNow;
    const todayKey = colombiaDateKey(today);
    const enabled = deps.enabled ? deps.enabled() : process.env.DAPTA_DATOS_ENABLED === "true";
    const webhook = configuredWebhook(deps.webhookUrl ? deps.webhookUrl() : process.env.DAPTA_DATOS_WEBHOOK_URL);
    const startDate = String(process.env.DAPTA_DATOS_START_DATE || "").trim();
    const initialDate = String(process.env.DAPTA_DATOS_INITIAL_BATCH_DATE || "").trim();
    const validStart = (!startDate || validStartDate(startDate)) && (!initialDate || validStartDate(initialDate));
    // A server-side date, set only for the explicitly authorized first batch,
    // lets that batch finish today even if deployment crosses the daily window.
    // The exception expires at Bogotá midnight and never bypasses recipient cadence.
    const isSendingAllowed = (date: Date) => validStart && (!startDate || colombiaDateKey(date) >= startDate)
      && (isCreditOverdueDataWindow(date) || (Boolean(initialDate) && colombiaDateKey(date) === initialDate));
    const report: CreditOverdueDataReport = {
      campaign: "datos", templateKey: CREDIT_OVERDUE_DATA_TEMPLATE_KEY, ok: true, dryRun,
      enabled, configured: Boolean(webhook) && validStart,
      inWindow: isSendingAllowed(liveNow),
      startsOn: startDate && validStart ? startDate : null,
      initialBatchDate: initialDate && validStart ? initialDate : null,
      generatedAt: liveNow.toISOString(), today: todayKey,
      summary: { scanned: 0, eligibleCredits: 0, eligibleClients: 0, excluded: 0,
        waiting: 0, ready: 0, claimed: 0, accepted: 0, failed: 0, unknown: 0,
        duplicates: 0, staleClaims: 0, revalidatedOut: 0 },
    };
    if (!dryRun && (!enabled || !webhook || !report.inWindow)) return report;
    if (!dryRun) {
      report.summary.staleClaims = await database.$executeRawUnsafe(
        `UPDATE "CreditOverdueDataAttempt" SET "status"='UNKNOWN', "resultCode"='CLAIM_EXPIRED', "finishedAt"=$1
         WHERE "status"='CLAIMED' AND "claimExpiresAt" <= $1`, liveNow,
      );
    }
    const groups = new Map<string, CreditOverdueDataCandidate[]>();
    let cursor = 0;
    for (;;) {
      const credits = await database.credito.findMany({
        where: { id: { gt: cursor } }, orderBy: { id: "asc" }, select: creditSelect, take: PAGE_SIZE,
      });
      if (!credits.length) break;
      for (const credit of credits) {
        if (!Number.isSafeInteger(credit.id) || credit.id <= cursor) throw new Error("Invalid Datos scan cursor");
        cursor = credit.id;
        report.summary.scanned += 1;
        const candidate = getCreditOverdueDataCandidate(credit, today);
        if (!candidate) { report.summary.excluded += 1; continue; }
        report.summary.eligibleCredits += 1;
        const group = groups.get(candidate.phone) || [];
        group.push(candidate);
        groups.set(candidate.phone, group);
      }
    }
    report.summary.eligibleClients = groups.size;
    for (const [phone, candidates] of groups) {
      const key = recipientKey(phone);
      const [recipient] = await database.$queryRawUnsafe<Recipient[]>(
        `SELECT "nextEligibleDate" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1`, key,
      );
      if (recipient?.nextEligibleDate && dateKey(recipient.nextEligibleDate) > todayKey) {
        report.summary.waiting += 1;
        continue;
      }
      report.summary.ready += 1;
      if (dryRun) continue;
      const claimId = randomUUID();
      const ids = candidates.map(candidate => candidate.creditId).sort((a, b) => a - b);
      const claim = await database.$transaction(async tx => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "CreditOverdueDataRecipient" ("recipientKey") VALUES ($1) ON CONFLICT DO NOTHING`, key,
        );
        const [currentRecipient] = await tx.$queryRawUnsafe<Recipient[]>(
          `SELECT "nextEligibleDate" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1 FOR UPDATE`, key,
        );
        const claimedAt = now();
        const claimDate = colombiaDateKey(claimedAt);
        if (!isSendingAllowed(claimedAt) || claimDate !== todayKey) return { status: "ineligible" as const };
        if (currentRecipient?.nextEligibleDate && dateKey(currentRecipient.nextEligibleDate) > claimDate) return { status: "duplicate" as const };
        const currentCandidates: CreditOverdueDataCandidate[] = [];
        for (const id of ids) {
          await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, id);
          const current = await tx.credito.findUnique({ where: { id }, select: creditSelect });
          const candidate = current && getCreditOverdueDataCandidate(current, claimedAt);
          if (candidate && candidate.phone === phone) currentCandidates.push(candidate);
        }
        const candidate = groupCreditOverdueDataCandidates(currentCandidates)[0];
        if (!candidate) return { status: "ineligible" as const };
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO "CreditOverdueDataAttempt"
           ("id","recipientKey","creditoId","campaignDate","daysPastDue","status","claimedAt","claimExpiresAt")
           VALUES ($1::uuid,$2,$3,$4::date,$5,'CLAIMED',$6,$7)
           ON CONFLICT ("recipientKey","campaignDate") DO NOTHING RETURNING "id"`,
          claimId, key, candidate.creditId, claimDate, candidate.daysPastDue,
          claimedAt, new Date(claimedAt.getTime() + CLAIM_LIFETIME_MS),
        );
        if (!rows.length) return { status: "duplicate" as const };
        const nextDate = nextCampaignDate(claimDate);
        await tx.$executeRawUnsafe(
          `UPDATE "CreditOverdueDataRecipient" SET "nextEligibleDate"=$2::date,"updatedAt"=$3 WHERE "recipientKey"=$1`,
          key, nextDate, claimedAt,
        );
        return { status: "claimed" as const, nextDate,
          previousDate: currentRecipient?.nextEligibleDate ? dateKey(currentRecipient.nextEligibleDate) : null };
      });
      if (claim.status === "ineligible") { report.summary.revalidatedOut += 1; continue; }
      if (claim.status === "duplicate") { report.summary.duplicates += 1; continue; }
      report.summary.claimed += 1;
      const releaseKnownUnsent = () => database.$transaction(async tx => {
        await tx.$queryRawUnsafe(`SELECT "recipientKey" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1 FOR UPDATE`, key);
        const removed = await tx.$executeRawUnsafe(
          `DELETE FROM "CreditOverdueDataAttempt" WHERE "id"=$1::uuid AND "status"='CLAIMED'`, claimId,
        );
        if (removed) await tx.$executeRawUnsafe(
          `UPDATE "CreditOverdueDataRecipient" SET "nextEligibleDate"=$2::date,"updatedAt"=$3
           WHERE "recipientKey"=$1 AND "nextEligibleDate"=$4::date`, key, claim.previousDate, now(), claim.nextDate,
        );
        return removed;
      });
      const [active] = await database.$queryRawUnsafe<Array<{ claimExpiresAt: Date | string }>>(
        `SELECT "claimExpiresAt" FROM "CreditOverdueDataAttempt" WHERE "id"=$1::uuid AND "status"='CLAIMED' AND "claimExpiresAt">$2`,
        claimId, now(),
      );
      let result: DispatchResult;
      if (!active) {
        report.summary.revalidatedOut += 1;
        // This worker has not begun HTTP, even if its own lease just elapsed.
        // A competing worker's UNKNOWN result is never removed.
        if (!await releaseKnownUnsent()) report.summary.unknown += 1;
        continue;
      }
      else {
        const currentCandidates: CreditOverdueDataCandidate[] = [];
        for (const id of ids) {
          const current = await database.credito.findUnique({ where: { id }, select: creditSelect });
          const candidate = current && getCreditOverdueDataCandidate(current, now());
          if (candidate && candidate.phone === phone) currentCandidates.push(candidate);
        }
        const candidate = groupCreditOverdueDataCandidates(currentCandidates)[0];
        const dispatchAt = now();
        if (!candidate || !isSendingAllowed(dispatchAt) || colombiaDateKey(dispatchAt) !== todayKey
          || new Date(active.claimExpiresAt).getTime() <= dispatchAt.getTime()) {
          report.summary.revalidatedOut += 1;
          // Only this owner can prove no HTTP started. Release its claim and cooldown together.
          if (!await releaseKnownUnsent()) report.summary.unknown += 1;
          continue;
        }
        // A payment may change which of this client's credits has the highest
        // mora. Keep the audit identity aligned with the fresh outgoing payload.
        const updated = await database.$executeRawUnsafe(
          `UPDATE "CreditOverdueDataAttempt" SET "creditoId"=$2,"daysPastDue"=$3
           WHERE "id"=$1::uuid AND "status"='CLAIMED' AND "claimExpiresAt">$4`,
          claimId, candidate.creditId, candidate.daysPastDue, dispatchAt,
        );
        if (!updated || !isSendingAllowed(now()) || new Date(active.claimExpiresAt).getTime() <= now().getTime()) {
          report.summary.revalidatedOut += 1;
          if (!await releaseKnownUnsent()) report.summary.unknown += 1;
          continue;
        }
        result = await dispatch(webhook!, candidate, deps.fetcher ?? fetch);
      }
      const finalized = await database.$executeRawUnsafe(
        `UPDATE "CreditOverdueDataAttempt" SET "status"=$2,"resultCode"=$3,"httpStatus"=$4,"finishedAt"=$5
         WHERE "id"=$1::uuid AND "status"='CLAIMED'`, claimId, result.status, result.code, result.httpStatus, now(),
      );
      if (!finalized || result.status === "UNKNOWN") report.summary.unknown += 1;
      else if (result.status === "ACCEPTED") report.summary.accepted += 1;
      else report.summary.failed += 1;
    }
    report.ok = report.summary.failed === 0 && report.summary.unknown === 0;
    return report;
  };
}

export const runCreditOverdueDataCampaign = createCreditOverdueDataRunner();
