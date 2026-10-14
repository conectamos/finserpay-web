import "server-only";

import type { Prisma } from "@/app/generated/prisma/client";

type AdjustmentDbClient = Pick<
  Prisma.TransactionClient,
  "$queryRawUnsafe" | "$executeRawUnsafe"
>;

type PendingCentralCollectionAdjustmentRow = {
  id: number;
  abonoId: number;
  creditoId: number;
  aliadoId: number;
  aliadoNombre: string;
  fechaRecaudo: Date;
  fechaAjuste: Date;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string;
  sedeId: number;
  sedeNombre: string;
  metodoPago: string;
  liquidacionOrigenId: number;
  valorAjuste: unknown;
  motivo: string;
  usuarioRecaudoId: number;
  usuarioRecaudoNombre: string;
  usuarioRecaudoLogin: string;
};

export type AllyPaymentCentralCollectionAdjustmentLine = {
  id?: number;
  ajusteId: number;
  abonoId: number;
  creditoId: number;
  aliadoId: number;
  aliado: { id: number; nombre: string };
  fechaAbono: string;
  fechaAjuste: string;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string;
  sedeId: number;
  sedeNombre: string;
  metodoPago: string;
  liquidacionOrigenId: number;
  valorAjuste: number;
  motivo: string;
  usuarioRecaudoId: number;
  usuarioRecaudoNombre: string;
  usuarioRecaudoLogin: string;
  estado: "PENDIENTE_APLICACION" | "ACREDITADO";
};

type StoredCentralCollectionApplication = {
  id: number;
  valorAjuste: unknown;
  estado: string;
  ajuste: {
    id: number;
    abonoId: number;
    creditoId: number;
    aliadoId: number;
    aliadoNombre: string;
    fechaRecaudo: Date;
    fechaAjuste: Date;
    folio: string;
    clienteNombre: string;
    clienteDocumento: string;
    sedeId: number;
    sedeNombre: string;
    metodoPago: string;
    liquidacionOrigenId: number;
    motivo: string;
    usuarioRecaudoId: number;
    usuarioRecaudoNombre: string;
    usuarioRecaudoLogin: string;
  };
};

function money(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round((numeric + Number.EPSILON) * 100) / 100) : 0;
}

function serializePending(
  row: PendingCentralCollectionAdjustmentRow
): AllyPaymentCentralCollectionAdjustmentLine {
  return {
    ajusteId: row.id,
    abonoId: row.abonoId,
    creditoId: row.creditoId,
    aliadoId: row.aliadoId,
    aliado: { id: row.aliadoId, nombre: row.aliadoNombre },
    fechaAbono: new Date(row.fechaRecaudo).toISOString(),
    fechaAjuste: new Date(row.fechaAjuste).toISOString(),
    folio: row.folio,
    clienteNombre: row.clienteNombre,
    clienteDocumento: row.clienteDocumento,
    sedeId: row.sedeId,
    sedeNombre: row.sedeNombre,
    metodoPago: row.metodoPago,
    liquidacionOrigenId: row.liquidacionOrigenId,
    valorAjuste: money(row.valorAjuste),
    motivo: row.motivo,
    usuarioRecaudoId: row.usuarioRecaudoId,
    usuarioRecaudoNombre: row.usuarioRecaudoNombre,
    usuarioRecaudoLogin: row.usuarioRecaudoLogin,
    estado: "PENDIENTE_APLICACION",
  };
}

export async function loadPendingAllyPaymentCentralCollectionAdjustments(
  db: AdjustmentDbClient,
  input: {
    allyId: number | null;
    endExclusive?: Date;
    lock?: boolean;
  }
): Promise<AllyPaymentCentralCollectionAdjustmentLine[]> {
  const values: unknown[] = [];
  const conditions = ['application."id" IS NULL'];

  if (input.allyId !== null) {
    values.push(input.allyId);
    conditions.push(`adjustment."aliadoId" = $${values.length}`);
  }
  // Carry pending credits forward into the next settlement. The upper bound
  // prevents a correction from appearing in a period that ended before the
  // adjustment existed; deliberately there is no lower bound.
  if (input.endExclusive) {
    values.push(input.endExclusive);
    conditions.push(`adjustment."fechaAjuste" < $${values.length}`);
  }

  const rows = await db.$queryRawUnsafe<PendingCentralCollectionAdjustmentRow[]>(`
    SELECT
      adjustment."id",
      adjustment."abonoId",
      adjustment."creditoId",
      adjustment."aliadoId",
      adjustment."aliadoNombre",
      adjustment."fechaRecaudo",
      adjustment."fechaAjuste",
      adjustment."folio",
      adjustment."clienteNombre",
      adjustment."clienteDocumento",
      adjustment."sedeId",
      adjustment."sedeNombre",
      adjustment."metodoPago",
      adjustment."liquidacionOrigenId",
      adjustment."valorAjuste",
      adjustment."motivo",
      adjustment."usuarioRecaudoId",
      adjustment."usuarioRecaudoNombre",
      adjustment."usuarioRecaudoLogin"
    FROM public."AjusteRecaudoCentralAliado" adjustment
    LEFT JOIN public."LiquidacionAliadoAjusteRecaudoCentral" application
      ON application."ajusteId" = adjustment."id"
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY adjustment."fechaAjuste" ASC, adjustment."id" ASC
    ${input.lock ? 'FOR UPDATE OF adjustment' : ''}
  `, ...values);

  return rows.map(serializePending);
}

export function serializeStoredAllyPaymentCentralCollectionAdjustment(
  application: StoredCentralCollectionApplication
): AllyPaymentCentralCollectionAdjustmentLine {
  const adjustment = application.ajuste;
  return {
    id: application.id,
    ajusteId: adjustment.id,
    abonoId: adjustment.abonoId,
    creditoId: adjustment.creditoId,
    aliadoId: adjustment.aliadoId,
    aliado: { id: adjustment.aliadoId, nombre: adjustment.aliadoNombre },
    fechaAbono: adjustment.fechaRecaudo.toISOString(),
    fechaAjuste: adjustment.fechaAjuste.toISOString(),
    folio: adjustment.folio,
    clienteNombre: adjustment.clienteNombre,
    clienteDocumento: adjustment.clienteDocumento,
    sedeId: adjustment.sedeId,
    sedeNombre: adjustment.sedeNombre,
    metodoPago: adjustment.metodoPago,
    liquidacionOrigenId: adjustment.liquidacionOrigenId,
    valorAjuste: money(application.valorAjuste),
    motivo: adjustment.motivo,
    usuarioRecaudoId: adjustment.usuarioRecaudoId,
    usuarioRecaudoNombre: adjustment.usuarioRecaudoNombre,
    usuarioRecaudoLogin: adjustment.usuarioRecaudoLogin,
    estado: "ACREDITADO",
  };
}

export function totalAllyPaymentCentralCollectionAdjustments(
  items: readonly AllyPaymentCentralCollectionAdjustmentLine[]
) {
  return items.reduce(
    (total, item) => Math.round((total + money(item.valorAjuste) + Number.EPSILON) * 100) / 100,
    0
  );
}
