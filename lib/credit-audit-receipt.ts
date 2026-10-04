import type { Prisma } from "@/app/generated/prisma/client";
import { parseCapitalPlanSnapshot, type CapitalPlanSnapshot } from "@/lib/credit-principal-payment";

type ReceiptDb = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;
type Payment = { id: number; valor: number; fechaAbono: Date };
type StoredAudit = {
  abonoId: number;
  sourceReceipt: string;
  allocations: unknown;
  snapshotAfter: unknown;
};

export type AuditedSourceComponents = {
  capital: number;
  interes: number;
  mora: number;
  otros: number;
  seguro: number;
};

export type AuditedReceiptAllocation = {
  document: string;
  ordinaryInstallment: number;
  extraordinaryPrincipal: number;
  additionalInterest: number;
  lateFee: number;
  otherCharges: number;
  sourceComponents?: AuditedSourceComponents;
  sourceType?: "CUOTA" | "CUOTAS" | "CAPITAL" | "MIXTO";
  isCutReceipt: boolean;
  isSourceReceipt: boolean;
  snapshotAfter: CapitalPlanSnapshot;
};

function fail(): never {
  throw new Error("La distribución auditada del recaudo no concilia.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail();
  return value;
}

function cents(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e12) fail();
  const rounded = Math.round(value * 100);
  if (!Number.isSafeInteger(rounded) || rounded / 100 !== value || (positive && rounded === 0)) fail();
  return rounded;
}

function dateKey(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail();
  return value;
}

function paymentDateMatches(value: Date, sourceDate: string): boolean {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail();
  if (value.toISOString().slice(0, 10) === sourceDate) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const get = (name: string) => parts.find((part) => part.type === name)?.value;
  return `${get("year")}-${get("month")}-${get("day")}` === sourceDate;
}

/** Map documented source receipts to live payments; ambiguous matches fail closed. */
export function parseAuditedReceiptAllocation(
  audit: StoredAudit,
  paymentId: number,
  payments: Payment[],
): AuditedReceiptAllocation | null {
  positiveId(paymentId);
  const sourcePaymentId = positiveId(audit.abonoId);
  const sourceReceipt = typeof audit.sourceReceipt === "string" ? audit.sourceReceipt.trim() : "";
  if (!sourceReceipt || sourceReceipt.length > 100) fail();
  const snapshotAfter = parseCapitalPlanSnapshot(audit.snapshotAfter);
  if (!snapshotAfter) fail();
  const rawReceipts = record(audit.allocations).receipts;
  if (!Array.isArray(rawReceipts) || rawReceipts.length < 1 || rawReceipts.length > 50 ||
      snapshotAfter.abonosAlCorte.length !== rawReceipts.length) fail();
  const receipts = rawReceipts.map((value) => {
    const row = record(value);
    const document = typeof row.document === "string" ? row.document.trim() : "";
    if (!document || document.length > 100) fail();
    const date = dateKey(row.date);
    const received = cents(row.received, true);
    const ordinaryInstallment = cents(row.ordinaryInstallment);
    const extraordinaryPrincipal = cents(row.extraordinaryPrincipal);
    const additionalInterest = cents(row.additionalInterest);
    const lateFee = cents(row.lateFee);
    const otherCharges = row.otherCharges === undefined ? 0 : cents(row.otherCharges);
    if (received !== ordinaryInstallment + extraordinaryPrincipal +
        additionalInterest + lateFee + otherCharges) fail();
    let sourceComponents: AuditedSourceComponents | undefined;
    let sourceType: AuditedReceiptAllocation["sourceType"];
    if (row.sourceComponents !== undefined) {
      sourceType = row.sourceType as AuditedReceiptAllocation["sourceType"];
      if (sourceType !== "CUOTA" && sourceType !== "CUOTAS" &&
          sourceType !== "CAPITAL" && sourceType !== "MIXTO") fail();
      const components = record(row.sourceComponents);
      const keys = ["capital", "interes", "mora", "otros", "seguro"] as const;
      if (Object.keys(components).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(components, key))) fail();
      const amounts = keys.map((key) => cents(components[key]));
      if (received !== amounts.reduce((sum, amount) => sum + amount, 0)) fail();
      sourceComponents = {
        capital: amounts[0] / 100, interes: amounts[1] / 100,
        mora: amounts[2] / 100, otros: amounts[3] / 100, seguro: amounts[4] / 100,
      };
    } else if (row.sourceType !== undefined) {
      fail();
    }
    return { document, date, received, ordinaryInstallment, extraordinaryPrincipal,
      additionalInterest, lateFee, otherCharges, sourceComponents, sourceType };
  });
  if (new Set(receipts.map((receipt) => receipt.document)).size !== receipts.length ||
      receipts.filter((receipt) => receipt.document === sourceReceipt).length !== 1 ||
      receipts.some((receipt, index) => index > 0 && receipt.date < receipts[index - 1].date) ||
      receipts.reduce((sum, receipt) => sum + receipt.received, 0) !==
        cents(snapshotAfter.totalAbonadoAlCorte)) fail();

  const livePayments = new Map(payments.map((payment) => [positiveId(payment.id), payment]));
  if (livePayments.size !== payments.length) fail();
  const included = new Map(snapshotAfter.abonosAlCorte.map((payment) => [payment.id, payment]));
  for (const payment of included.values()) {
    const live = livePayments.get(payment.id);
    if (!live || cents(live.valor, true) !== cents(payment.valor, true)) fail();
  }
  const source = receipts.find((receipt) => receipt.document === sourceReceipt)!;
  const sourcePayment = livePayments.get(sourcePaymentId);
  if (!included.has(sourcePaymentId) || !sourcePayment ||
      cents(sourcePayment.valor) !== source.received ||
      !paymentDateMatches(sourcePayment.fechaAbono, source.date)) fail();
  const byDocument = new Map<string, number>([[sourceReceipt, sourcePaymentId]]);
  const used = new Set<number>([sourcePaymentId]);
  for (const receipt of receipts) {
    if (receipt.document === sourceReceipt) continue;
    const candidates = [...included.keys()].filter((id) => {
      const payment = livePayments.get(id)!;
      return !used.has(id) && cents(payment.valor) === receipt.received &&
        paymentDateMatches(payment.fechaAbono, receipt.date);
    });
    if (candidates.length !== 1) fail();
    used.add(candidates[0]);
    byDocument.set(receipt.document, candidates[0]);
  }
  if (used.size !== included.size) fail();
  const index = receipts.findIndex((receipt) => byDocument.get(receipt.document) === paymentId);
  if (index < 0) return null;
  const receipt = receipts[index];
  return {
    document: receipt.document,
    ordinaryInstallment: receipt.ordinaryInstallment / 100,
    extraordinaryPrincipal: receipt.extraordinaryPrincipal / 100,
    additionalInterest: receipt.additionalInterest / 100,
    lateFee: receipt.lateFee / 100,
    otherCharges: receipt.otherCharges / 100,
    ...(receipt.sourceComponents ? { sourceComponents: receipt.sourceComponents,
      sourceType: receipt.sourceType } : {}),
    isCutReceipt: index === receipts.length - 1,
    isSourceReceipt: receipt.document === sourceReceipt,
    snapshotAfter,
  };
}

export function auditedReceiptPlanView(receipt: AuditedReceiptAllocation): {
  snapshot: CapitalPlanSnapshot | null;
  notice: string | null;
} {
  return receipt.isCutReceipt
    ? { snapshot: receipt.snapshotAfter, notice: null }
    : { snapshot: null,
        notice: "Recaudo histórico conciliado. Consulta el plan vigente para los próximos pagos." };
}

export async function readAuditedReceiptAllocation(
  db: ReceiptDb,
  creditId: number,
  paymentId: number,
  payments: Payment[],
): Promise<AuditedReceiptAllocation | null> {
  positiveId(creditId);
  positiveId(paymentId);
  const registry = await db.$queryRawUnsafe<Array<{ name: string | null }>>(
    "SELECT to_regclass($1)::text AS name", 'public."CreditAresReconciliation"',
  );
  if (!registry[0]?.name) return null;
  const audits = await db.$queryRawUnsafe<StoredAudit[]>(
    'SELECT "abonoId","sourceReceipt","allocations","snapshotAfter" ' +
      'FROM "CreditAresReconciliation" WHERE "creditoId"=$1 AND ' +
      '("abonoId"=$2 OR ("snapshotAfter"->\'abonosAlCorte\') @> $3::jsonb) LIMIT 2',
    creditId, paymentId, JSON.stringify([{ id: paymentId }]),
  );
  if (audits.length > 1) fail();
  return audits[0] ? parseAuditedReceiptAllocation(audits[0], paymentId, payments) : null;
}
