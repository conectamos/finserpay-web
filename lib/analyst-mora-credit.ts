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

type MoraReferencePhones = {
  referenciaFamiliar1Telefono: string | null;
  referenciaFamiliar2Telefono: string | null;
};

type MoraCreditSummarySource = Prisma.CreditoGetPayload<{ select: typeof moraCreditSelect }> & Partial<MoraReferencePhones>;
export type MoraCredit = Awaited<ReturnType<typeof readMoraCredit>>;

function referencePhone(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function snapshotReferencePhones(snapshot: unknown): MoraReferencePhones {
  const root = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown> : {};
  const client = root.cliente && typeof root.cliente === "object" && !Array.isArray(root.cliente)
    ? root.cliente as Record<string, unknown> : {};
  const references = Array.isArray(client.referenciasFamiliares) ? client.referenciasFamiliares : [];
  const at = (index: number) => {
    const item = references[index];
    return item && typeof item === "object" && !Array.isArray(item)
      ? referencePhone((item as Record<string, unknown>).telefono) : null;
  };
  return { referenciaFamiliar1Telefono: at(0), referenciaFamiliar2Telefono: at(1) };
}

export async function readMoraCredit(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new CreditApprovalError("INVALID_CREDIT", "Crédito inválido.");
  // The portfolio does not load contract snapshots or reference contacts. Only
  // an authorized detail request reads the two references for this credit.
  const credit = await prisma.credito.findUnique({ where: { id }, select: { ...moraCreditSelect, contratoSnapshot: true } });
  if (!credit || ["ANULADO","ANULADA","CANCELADO","CANCELADA"].includes(credit.estado.trim().toUpperCase()))
    throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  const references = snapshotReferencePhones(credit.contratoSnapshot);
  if (!references.referenciaFamiliar1Telefono || !references.referenciaFamiliar2Telefono) {
    const drafts = await prisma.$queryRawUnsafe<MoraReferencePhones[]>(`SELECT
      CASE WHEN jsonb_typeof("payload"->'referenciaFamiliar1Telefono')='string'
        THEN "payload"->>'referenciaFamiliar1Telefono' END AS "referenciaFamiliar1Telefono",
      CASE WHEN jsonb_typeof("payload"->'referenciaFamiliar2Telefono')='string'
        THEN "payload"->>'referenciaFamiliar2Telefono' END AS "referenciaFamiliar2Telefono"
      FROM "CreditoBorrador" WHERE "creditoId"=$1 ORDER BY "updatedAt" DESC,"id" DESC LIMIT 1`, id);
    references.referenciaFamiliar1Telefono ||= referencePhone(drafts[0]?.referenciaFamiliar1Telefono);
    references.referenciaFamiliar2Telefono ||= referencePhone(drafts[0]?.referenciaFamiliar2Telefono);
  }
  const { contratoSnapshot: _snapshot, ...detail } = credit;
  void _snapshot;
  return { ...detail, ...references };
}

export function moraCreditSummary(credit: MoraCreditSummarySource, now = new Date()) {
  const numeroSadmin = confirmedSadminNumber(credit.registroSadmin);
  const plan = buildCreditPaymentPlan({ ...credit, settled: Boolean(credit.pazYSalvoEmitidoAt), today: now });
  const overdue = plan.installments.filter(row => row.estaEnMora);
  const first = overdue.map(row => row.fechaVencimiento).sort()[0];
  const today = colombiaDateKey(now);
  return {
    id: credit.id, folio: credit.folio, numeroSadmin, numeroCreditoVisible: numeroSadmin || credit.folio,
    clienteNombre: credit.clienteNombre, clienteDocumento: credit.clienteDocumento,
    clienteTelefono: credit.clienteTelefono,
    referenciaFamiliar1Telefono: referencePhone(credit.referenciaFamiliar1Telefono),
    referenciaFamiliar2Telefono: referencePhone(credit.referenciaFamiliar2Telefono),
    aliadoId: credit.sede.aliado?.id || 0, aliadoNombre: credit.sede.aliado?.nombre || "Sin aliado",
    equipo: credit.referenciaEquipo?.trim() || [credit.equipoMarca, credit.equipoModelo].filter(Boolean).join(" "),
    imei: credit.imei || credit.deviceUid || null,
    valorVencido: Math.round(overdue.reduce((total, row) => total + row.saldoPendiente, 0)),
    diasMora: first ? Math.max(0, Math.round((Date.parse(today+"T00:00:00Z")-Date.parse(first+"T00:00:00Z"))/86400000)) : 0,
    ultimoPago: credit.abonos.at(-1)?.fechaAbono.toISOString() || null,
    fechaCredito: credit.fechaCredito.toISOString(), enMora: overdue.length > 0,
  };
}
