import type { CreditPaymentPlanInput } from "./credit-payment-plan";

export type CutStatus = "todos" | "pendiente" | "parcial" | "pagado";
export type CutFilters = { day: 2 | 17; month: number; year: number; aliadoId: number | null; sedeId: number | null; status: CutStatus };
export type CutPayment = { id: number; value: number; paidAt: string; createdAt: string; state: string; annulledAt: string | null; method: string };
export type CutCredit = {
  id: number; folio: string; clientName: string; document: string; aliadoId: number | null;
  aliado: string; sedeId: number; sede: string; state: string;
  plan: Omit<CreditPaymentPlanInput, "abonos" | "today">;
  payments: CutPayment[];
};
export type CutBaselineInstallment = {
  creditId: number; numero: number; fechaVencimiento: string; valorProgramado: number;
  valorAbonado: number; saldoPendiente: number; eliminada: boolean;
  applied: { id: number; value: number }[];
};
export type CutSnapshot = { version: 1; cutDate: string; capturedAt: string; credits: CutCredit[]; schedule: CutBaselineInstallment[] };
export type CutPaymentDetail = {
  id: number; paidAt: string; createdAt: string; method: string; state: string;
  amount: number; appliedBefore: number; appliedNow: number; received: number; previous: boolean;
};
export type CutRow = {
  key: string; creditId: number; installment: number; clientName: string; document: string; folio: string;
  aliadoId: number | null; aliado: string; sedeId: number; sede: string; dueDate: string;
  installmentAmount: number; priorPayments: number; expected: number; received: number; pending: number;
  priorReversals: number; lastPaymentAt: string | null; status: Exclude<CutStatus, "todos">;
  warning: string | null; payments: CutPaymentDetail[];
  sourcePayments?: { id: number; paidAt: string; createdAt: string; method: string; state: string; amount: number }[];
  previousRecovery?: number; futureAdvances?: number;
};
export type CutSummary = {
  expected: number; received: number; pending: number; completion: number | null; pendingClients: number;
  priorPayments: number; priorReversals: number; previousRecovery: number; futureAdvances: number;
};
export type CutHistory = { id: string; cutDate: string; createdAt: string; expected: number | null; received: number | null; pending: number | null; completion: number | null; rowCount: number | null; warning?: string };
export type CutReport = {
  ok: true; filters: CutFilters; cutDate: string; asOf: string;
  projection: { id: string; createdAt: string } | null;
  rows: CutRow[]; summary: CutSummary; history: CutHistory[];
  historyPage: number; historyHasMore: boolean;
  options: { aliados: { id: number; nombre: string }[]; sedes: { id: number; nombre: string; aliadoId: number | null }[] };
  warnings: string[];
};
