import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { colombiaDateKey } from "@/lib/colombia-date";
import { confirmedSadminNumber } from "@/lib/credit-display-number";
import { CreditApprovalError } from "@/lib/credit-approval-errors";

export const moraCreditSelect = {
  id: true, folio: true, clienteNombre: true, clienteDocumento: true, clienteTelefono: true,
  imei: true, deviceUid: true, referenciaEquipo: true, equipoMarca: true, equipoModelo: true,
  estado: true, montoCredito: true, valorCuota: true, plazoMeses: true, frecuenciaPago: true,
  fechaPrimerPago: true, fechaProximoPago: true, planCapitalVigente: true, pazYSalvoEmitidoAt: true,
  createdAt: true, fechaCredito: true,
  sede: { select: { aliado: { select: { id: true, nombre: true } } } },
  registroSadmin: { select: { numeroCredito: true, numeroCreditoConfirmado: true } },
  abonos: { where: { estado: { not: "ANULADO" } }, select: { valor: true, fechaAbono: true }, orderBy: { fechaAbono: "asc" as const } },
} as const satisfies Prisma.CreditoSelect;

export type MoraCredit = Awaited<ReturnType<typeof readMoraCredit>>;

export async function readMoraCredit(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new CreditApprovalError("INVALID_CREDIT", "Crédito inválido.");
  const credit = await prisma.credito.findUnique({ where: { id }, select: moraCreditSelect });
  if (!credit || ["ANULADO","ANULADA","CANCELADO","CANCELADA"].includes(credit.estado.trim().toUpperCase()))
    throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  return credit;
}

export function moraCreditSummary(credit: Prisma.CreditoGetPayload<{ select: typeof moraCreditSelect }>, now = new Date()) {
  const plan = buildCreditPaymentPlan({ ...credit, settled: Boolean(credit.pazYSalvoEmitidoAt), today: now });
  const overdue = plan.installments.filter(row => row.estaEnMora);
  const first = overdue.map(row => row.fechaVencimiento).sort()[0];
  const today = colombiaDateKey(now);
  return {
    id: credit.id, folio: credit.folio, numeroCreditoVisible: confirmedSadminNumber(credit.registroSadmin) || credit.folio,
    clienteNombre: credit.clienteNombre, clienteDocumento: credit.clienteDocumento,
    clienteTelefono: credit.clienteTelefono, aliadoId: credit.sede.aliado?.id || 0, aliadoNombre: credit.sede.aliado?.nombre || "Sin aliado",
    equipo: credit.referenciaEquipo?.trim() || [credit.equipoMarca, credit.equipoModelo].filter(Boolean).join(" "),
    imei: credit.imei || credit.deviceUid || null,
    valorVencido: Math.round(overdue.reduce((total, row) => total + row.saldoPendiente, 0)),
    diasMora: first ? Math.max(0, Math.round((Date.parse(today+"T00:00:00Z")-Date.parse(first+"T00:00:00Z"))/86400000)) : 0,
    ultimoPago: credit.abonos.at(-1)?.fechaAbono.toISOString() || null,
    fechaCredito: credit.fechaCredito.toISOString(), enMora: overdue.length > 0,
  };
}
