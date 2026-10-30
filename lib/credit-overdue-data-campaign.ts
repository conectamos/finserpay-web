import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { colombiaDateKey } from "@/lib/colombia-date";
import { hasActiveMoraMessageProtection } from "@/lib/mora-message-protection";
import { isMetaAutomationConfigured, sendMetaAutomation, whatsAppAutomationProvider, type MetaAutomationSender } from "@/lib/whatsapp-automation-provider";
import {
  getCreditOverdueDataCandidate,
  groupCreditOverdueDataCandidates,
  isCreditOverdueDataWindow,
  type CreditOverdueDataCandidate,
} from "@/lib/credit-overdue-data-policy";

// Retained as the historical audit identifier; delivery is now once per credit.
export const CREDIT_OVERDUE_DATA_TEMPLATE_KEY = "datos_mora_20_cada_3_dias";
const PAGE_SIZE = 250;
const CLAIM_LIFETIME_MS = 90_000;
const SEND_TIMEOUT_MS = 8_000;
const creditSelect = {
  id: true, clienteNombre: true, clienteTelefono: true, clienteDocumento: true, estado: true,
  pazYSalvoEmitidoAt: true, planCapitalVigente: true, montoCredito: true,
  valorCuota: true, plazoMeses: true, frecuenciaPago: true,
  fechaPrimerPago: true, fechaProximoPago: true,
  abonos: { where: { estado: { not: "ANULADO" } }, select: { valor: true, fechaAbono: true, estado: true } },
} as const;

export type CreditOverdueDataOptions = { dryRun?: boolean; previewDate?: Date | string };
export type CreditOverdueDataReport = {
  campaign: "datos"; templateKey: string; ok: boolean; dryRun: boolean;
  provider: "meta" | "dapta" | null;
  enabled: boolean; configured: boolean; inWindow: boolean; startsOn: string | null;
  initialBatchDate: string | null; generatedAt: string; today: string;
  summary: { scanned: number; eligibleCredits: number; eligibleClients: number; excluded: number;
    waiting: number; ready: number; claimed: number; accepted: number; failed: number;
    unknown: number; duplicates: number; staleClaims: number; revalidatedOut: number };
};
type DispatchResult = { status: "ACCEPTED" | "FAILED" | "UNKNOWN"; code: string; httpStatus: number | null };

function recipientKey(phone: string) {
  return createHash("sha256").update("finserpay-datos:" + phone).digest("hex");
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
  env?: NodeJS.ProcessEnv; sendMeta?: MetaAutomationSender;
} = {}) {
  const database = deps.database ?? prisma;
  const now = deps.now ?? (() => new Date());
  return async function run(options: CreditOverdueDataOptions = {}): Promise<CreditOverdueDataReport> {
    const env = { ...(deps.env ?? process.env) };
    const provider = whatsAppAutomationProvider(env);
    const liveNow = now();
    const dryRun = options.dryRun !== false;
    const today = dryRun && options.previewDate ? options.previewDate : liveNow;
    const todayKey = colombiaDateKey(today);
    const enabled = deps.enabled ? deps.enabled() : env.DAPTA_DATOS_ENABLED === "true";
    const webhook = configuredWebhook(deps.webhookUrl ? deps.webhookUrl() : env.DAPTA_DATOS_WEBHOOK_URL);
    const configured = provider === "meta" ? isMetaAutomationConfigured(env, "data") : provider === "dapta" && Boolean(webhook);
    const startDate = String(env.DAPTA_DATOS_START_DATE || "").trim();
    const initialDate = String(env.DAPTA_DATOS_INITIAL_BATCH_DATE || "").trim();
    const validStart = !startDate || validStartDate(startDate);
    // The old first-batch date is informational only. New day-20 notices must
    // respect the normal window, even when that legacy setting remains present.
    const isSendingAllowed = (date: Date) => validStart && (!startDate || colombiaDateKey(date) >= startDate)
      && isCreditOverdueDataWindow(date);
    const report: CreditOverdueDataReport = {
      campaign: "datos", provider, templateKey: CREDIT_OVERDUE_DATA_TEMPLATE_KEY, ok: true, dryRun,
      enabled, configured: Boolean(configured) && validStart,
      inWindow: isSendingAllowed(liveNow),
      startsOn: startDate && validStart ? startDate : null,
      initialBatchDate: initialDate && validStartDate(initialDate) ? initialDate : null,
      generatedAt: liveNow.toISOString(), today: todayKey,
      summary: { scanned: 0, eligibleCredits: 0, eligibleClients: 0, excluded: 0,
        waiting: 0, ready: 0, claimed: 0, accepted: 0, failed: 0, unknown: 0,
        duplicates: 0, staleClaims: 0, revalidatedOut: 0 },
    };
    if (!dryRun && (!enabled || !report.configured || !report.inWindow)) return report;
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
    const blockedCredits = async (client: Pick<typeof database, "$queryRawUnsafe">, ids: number[], ownAttemptId: string | null = null) => {
      if (!ids.length) return new Set<number>();
      // Legacy attempts recorded only the selected credit. Coverage records all
      // credits represented by a new grouped message, including failed/unknown sends.
      const rows = await client.$queryRawUnsafe<Array<{ creditoId: number }>>(
        `SELECT "creditoId" FROM "CreditOverdueDataCoverage"
         WHERE "creditoId"=ANY($1::int[]) AND ($2::uuid IS NULL OR "attemptId"<>$2::uuid)
         UNION SELECT "creditoId" FROM "CreditOverdueDataAttempt"
         WHERE "creditoId"=ANY($1::int[]) AND ($2::uuid IS NULL OR "id"<>$2::uuid)`, ids, ownAttemptId,
      );
      return new Set(rows.map(row => row.creditoId));
    };
    for (const [phone, candidates] of groups) {
      const key = recipientKey(phone);
      const previouslyCovered = await blockedCredits(database, candidates.map(candidate => candidate.creditId));
      const ids = candidates.filter(candidate => !previouslyCovered.has(candidate.creditId))
        .map(candidate => candidate.creditId).sort((a, b) => a - b);
      if (!ids.length) {
        report.summary.waiting += 1;
        continue;
      }
      report.summary.ready += 1;
      if (dryRun) continue;
      const claimId = randomUUID();
      const claim = await database.$transaction(async tx => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "CreditOverdueDataRecipient" ("recipientKey") VALUES ($1) ON CONFLICT DO NOTHING`, key,
        );
        await tx.$queryRawUnsafe(
          `SELECT "recipientKey" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1 FOR UPDATE`, key,
        );
        const claimedAt = now();
        const claimDate = colombiaDateKey(claimedAt);
        if (!isSendingAllowed(claimedAt) || claimDate !== todayKey) return { status: "ineligible" as const };
        // Credit locks make coverage a cross-phone guard when a contact changes.
        for (const id of ids) await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, id);
        const covered = await blockedCredits(tx, ids);
        const currentCandidates: CreditOverdueDataCandidate[] = [];
        for (const id of ids) {
          if (covered.has(id)) continue;
          const current = await tx.credito.findUnique({ where: { id }, select: creditSelect });
          const candidate = current && getCreditOverdueDataCandidate(current, claimedAt);
          if (candidate && candidate.phone === phone) currentCandidates.push(candidate);
        }
        const candidate = groupCreditOverdueDataCandidates(currentCandidates)[0];
        if (!candidate) return { status: covered.size === ids.length ? "duplicate" as const : "ineligible" as const };
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO "CreditOverdueDataAttempt"
           ("id","recipientKey","creditoId","campaignDate","daysPastDue","status","claimedAt","claimExpiresAt")
           VALUES ($1::uuid,$2,$3,$4::date,$5,'CLAIMED',$6,$7)
           ON CONFLICT ("recipientKey","campaignDate") DO NOTHING RETURNING "id"`,
          claimId, key, candidate.creditId, claimDate, candidate.daysPastDue,
          claimedAt, new Date(claimedAt.getTime() + CLAIM_LIFETIME_MS),
        );
        if (!rows.length) return { status: "duplicate" as const };
        await tx.$executeRawUnsafe(
          `INSERT INTO "CreditOverdueDataCoverage" ("creditoId","attemptId","createdAt")
           SELECT id,$1::uuid,$3 FROM unnest($2::int[]) AS id`,
          claimId, currentCandidates.map(item => item.creditId), claimedAt,
        );
        return { status: "claimed" as const };
      }, { timeout: 30_000 });
      if (claim.status === "ineligible") { report.summary.revalidatedOut += 1; continue; }
      if (claim.status === "duplicate") { report.summary.duplicates += 1; continue; }
      report.summary.claimed += 1;
      const releaseKnownUnsent = () => database.$transaction(async tx => {
        await tx.$queryRawUnsafe(`SELECT "recipientKey" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1 FOR UPDATE`, key);
        const [owned] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "CreditOverdueDataAttempt"
           WHERE "id"=$1::uuid AND "recipientKey"=$2 AND "status"='CLAIMED' FOR UPDATE`, claimId, key,
        );
        if (!owned) return 0;
        await tx.$executeRawUnsafe(`DELETE FROM "CreditOverdueDataCoverage" WHERE "attemptId"=$1::uuid`, claimId);
        return tx.$executeRawUnsafe(`DELETE FROM "CreditOverdueDataAttempt" WHERE "id"=$1::uuid AND "status"='CLAIMED'`, claimId);
      }, { timeout: 30_000 });
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
        const prepared = await database.$transaction(async tx => {
          await tx.$queryRawUnsafe(`SELECT "recipientKey" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1 FOR UPDATE`, key);
          const [owned] = await tx.$queryRawUnsafe<Array<{ claimExpiresAt: Date | string }>>(
            `SELECT "claimExpiresAt" FROM "CreditOverdueDataAttempt"
             WHERE "id"=$1::uuid AND "recipientKey"=$2 AND "status"='CLAIMED' FOR UPDATE`, claimId, key,
          );
          if (!owned) return null;
          const coverage = await tx.$queryRawUnsafe<Array<{ creditoId: number }>>(
            `SELECT "creditoId" FROM "CreditOverdueDataCoverage" WHERE "attemptId"=$1::uuid ORDER BY "creditoId"`, claimId,
          );
          const coveredIds = coverage.map(row => row.creditoId);
          for (const id of coveredIds) await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, id);
          const blocked = await blockedCredits(tx, coveredIds, claimId);
          const currentCandidates: CreditOverdueDataCandidate[] = [];
          for (const id of coveredIds) {
            if (blocked.has(id)) continue;
            const current = await tx.credito.findUnique({ where: { id }, select: creditSelect });
            const candidate = current && getCreditOverdueDataCandidate(current, now());
            if (candidate && candidate.phone === phone) currentCandidates.push(candidate);
          }
          const candidate = groupCreditOverdueDataCandidates(currentCandidates)[0];
          const dispatchAt = now();
          if (!candidate || !isSendingAllowed(dispatchAt) || colombiaDateKey(dispatchAt) !== todayKey
            || new Date(owned.claimExpiresAt).getTime() <= dispatchAt.getTime()) return null;
          // Only a still-valid credit already covered by this exact claim may
          // become the representative; never switch to a previously notified credit.
          const updated = await tx.$executeRawUnsafe(
            `UPDATE "CreditOverdueDataAttempt" SET "creditoId"=$2,"daysPastDue"=$3
             WHERE "id"=$1::uuid AND "status"='CLAIMED' AND "claimExpiresAt">$4`,
            claimId, candidate.creditId, candidate.daysPastDue, dispatchAt,
          );
          if (!updated) return null;
          // These credits received no HTTP and are no longer covered by this
          // phone's notice. Keep the remaining valid grouped coverage intact.
          await tx.$executeRawUnsafe(
            `DELETE FROM "CreditOverdueDataCoverage" WHERE "attemptId"=$1::uuid AND NOT ("creditoId"=ANY($2::int[]))`,
            claimId, currentCandidates.map(item => item.creditId),
          );
          return { candidate, claimExpiresAt: owned.claimExpiresAt };
        }, { timeout: 30_000 });
        const dispatchAt = now();
        if (!prepared || !isSendingAllowed(dispatchAt) || colombiaDateKey(dispatchAt) !== todayKey
          || new Date(prepared.claimExpiresAt).getTime() <= dispatchAt.getTime()) {
          report.summary.revalidatedOut += 1;
          // Only this owner can prove no HTTP started. UNKNOWN is never released.
          if (!await releaseKnownUnsent()) report.summary.unknown += 1;
          continue;
        }
        if (provider === "meta") {
          try {
            const native = await (deps.sendMeta ?? sendMetaAutomation)({
              operationKey: `data:${claimId}`, template: "data", phone: prepared.candidate.phone, body: [prepared.candidate.name],
            }, { env, fetcher: deps.fetcher, withSendGuard: async <T>(send: () => Promise<T>): Promise<T> => database.$transaction(async tx => {
              // Keep the established Datos order: recipient, own attempt, then
              // covered credits. No CRM/outbox transaction runs under these locks.
              await tx.$queryRawUnsafe(`SELECT "recipientKey" FROM "CreditOverdueDataRecipient" WHERE "recipientKey"=$1 FOR UPDATE`, key);
              const [owned] = await tx.$queryRawUnsafe<Array<{ claimExpiresAt: Date | string }>>(
                `SELECT "claimExpiresAt" FROM "CreditOverdueDataAttempt" WHERE "id"=$1::uuid AND "status"='CLAIMED' FOR UPDATE`, claimId);
              const coverage = await tx.$queryRawUnsafe<Array<{ creditoId: number }>>(
                `SELECT "creditoId" FROM "CreditOverdueDataCoverage" WHERE "attemptId"=$1::uuid ORDER BY "creditoId"`, claimId);
              for (const { creditoId } of coverage) await tx.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, creditoId);
              const currentCandidates: CreditOverdueDataCandidate[] = [];
              for (const { creditoId } of coverage) {
                const credit = await tx.credito.findUnique({ where: { id: creditoId }, select: creditSelect });
                const current = credit && getCreditOverdueDataCandidate(credit, now());
                if (!current || current.phone !== phone || await hasActiveMoraMessageProtection(creditoId, credit!.clienteDocumento, tx))
                  throw new Error("DATA_CREDIT_CHANGED_BEFORE_SEND");
                currentCandidates.push(current);
              }
              const at = now(); const current = groupCreditOverdueDataCandidates(currentCandidates)[0];
              if (!owned || new Date(owned.claimExpiresAt).getTime() <= at.getTime() || !isSendingAllowed(at)
                || colombiaDateKey(at) !== todayKey || !current || current.creditId !== prepared.candidate.creditId
                || current.name !== prepared.candidate.name || current.phone !== prepared.candidate.phone)
                throw new Error("DATA_CHANGED_BEFORE_SEND");
              return send();
            }, { timeout: 15_000 }) });
            result = { status: native.status === "accepted" ? "ACCEPTED" : native.status === "failed" ? "FAILED" : "UNKNOWN",
              code: native.code, httpStatus: native.httpStatus ?? null };
          } catch { result = { status: "UNKNOWN", code: "META_OUTCOME_UNKNOWN", httpStatus: null }; }
        } else result = await dispatch(webhook!, prepared.candidate, deps.fetcher ?? fetch);
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
