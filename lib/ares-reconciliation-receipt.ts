import type { Prisma } from "@/app/generated/prisma/client";
import { parseCapitalPlanSnapshot, type CapitalPlanSnapshot } from "@/lib/credit-principal-payment";

type ReceiptDb = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;

export type AresReconciledReceipt = {
  document: string;
  ordinaryInstallment: number;
  extraordinaryPrincipal: number;
  additionalInterest: number;
  lateFee: number;
  snapshotAfter: CapitalPlanSnapshot;
};

/** The 18/09 receipt predates the post-03/10 snapshot; the 03/10 receipt closes it. */
export function aresReceiptPlanView(receipt: AresReconciledReceipt): {
  snapshot: CapitalPlanSnapshot | null;
  notice: string | null;
} {
  return receipt.extraordinaryPrincipal > 0
    ? {
        snapshot: null,
        notice: "Recaudo histórico ARES conciliado en FINSER. Consulta el plan vigente para los próximos pagos.",
      }
    : { snapshot: receipt.snapshotAfter, notice: null };
}

type StoredAudit = {
  abonoId: number;
  allocations: unknown;
  snapshotAfter: unknown;
};

const SOURCE_RECEIPT = "R0100001108";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("La auditoría ARES del recibo está incompleta.");
  }
  return value as Record<string, unknown>;
}

function exactMoney(value: unknown, expected: number): number {
  if (typeof value !== "number" || value !== expected) {
    throw new Error("La distribución auditada de ARES no concilia.");
  }
  return value;
}

/** Only the documented two-receipt repair can opt into this presentation. */
export function parseAresReconciledReceipt(
  audit: StoredAudit,
  paymentId: number,
  paymentAmount: number,
): AresReconciledReceipt | null {
  const snapshotAfter = parseCapitalPlanSnapshot(audit.snapshotAfter);
  if (!snapshotAfter || snapshotAfter.totalAbonadoAlCorte !== 560_000 ||
      snapshotAfter.abonosAlCorte.length !== 2) {
    throw new Error("El corte auditado de ARES no concilia.");
  }
  const capitalPaymentId = Number(audit.abonoId);
  const capitalPayment = snapshotAfter.abonosAlCorte.find((item) => item.id === capitalPaymentId);
  const ordinaryPayment = snapshotAfter.abonosAlCorte.find((item) => item.id !== capitalPaymentId);
  if (!Number.isSafeInteger(capitalPaymentId) ||
      capitalPayment?.valor !== 400_000 || ordinaryPayment?.valor !== 160_000) {
    throw new Error("Los pagos del corte ARES no concilian.");
  }
  if (paymentId !== capitalPaymentId && paymentId !== ordinaryPayment.id) return null;
  const expectedAmount = paymentId === capitalPaymentId ? 400_000 : 160_000;
  exactMoney(paymentAmount, expectedAmount);

  const receipts = object(audit.allocations).receipts;
  if (!Array.isArray(receipts) || receipts.length !== 2) {
    throw new Error("Faltan los recibos auditados de ARES.");
  }
  const first = object(receipts[0]);
  const second = object(receipts[1]);
  if (first.document !== SOURCE_RECEIPT || first.date !== "2026-09-18" ||
      second.document !== "R0100001393" || second.date !== "2026-10-03") {
    throw new Error("Los folios auditados de ARES no concilian.");
  }
  for (const [receipt, values] of [
    [first, [400_000, 158_500, 241_449, 0, 51]],
    [second, [160_000, 158_500, 0, 1_442, 58]],
  ] as const) {
    const keys = ["received", "ordinaryInstallment", "extraordinaryPrincipal", "additionalInterest", "lateFee"] as const;
    keys.forEach((key, index) => exactMoney(receipt[key], values[index]));
  }
  const source = paymentId === capitalPaymentId ? first : second;
  return {
    document: String(source.document),
    ordinaryInstallment: Number(source.ordinaryInstallment),
    extraordinaryPrincipal: Number(source.extraordinaryPrincipal),
    additionalInterest: Number(source.additionalInterest),
    lateFee: Number(source.lateFee),
    snapshotAfter,
  };
}

export async function readAresReconciledReceipt(
  db: ReceiptDb,
  creditId: number,
  paymentId: number,
  paymentAmount: number,
): Promise<AresReconciledReceipt | null> {
  const registry = await db.$queryRawUnsafe<Array<{ name: string | null }>>(
    "SELECT to_regclass($1) AS name", 'public."CreditAresReconciliation"',
  );
  if (!registry[0]?.name) return null;
  const audits = await db.$queryRawUnsafe<StoredAudit[]>(
    'SELECT "abonoId","allocations","snapshotAfter" FROM "CreditAresReconciliation" ' +
      'WHERE "creditoId"=$1 AND "sourceReceipt"=$2 LIMIT 1',
    creditId, SOURCE_RECEIPT,
  );
  return audits[0] ? parseAresReconciledReceipt(audits[0], paymentId, paymentAmount) : null;
}
