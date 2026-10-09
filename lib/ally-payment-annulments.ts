import "server-only";

import type { Prisma } from "@/app/generated/prisma/client";
import type { AllyPaymentPlatform } from "@/lib/ally-payments-core";

type AnnulmentDbClient = Pick<
  Prisma.TransactionClient,
  "$queryRawUnsafe" | "$executeRawUnsafe"
>;

type AnnulmentAdjustmentRow = {
  id: number;
  creditoId: number;
  aliadoId: number;
  aliadoNombre: string;
  fechaAnulacion: Date;
  fechaAnulacionFuente: string;
  folio: string;
  numeroCreditoVisible?: string;
  clienteNombre: string;
  clienteDocumento: string;
  imei: string;
  equipo: string;
  plataforma: string;
  sedeId: number;
  sedeNombre: string;
  liquidacionOrigenId: number;
  valorDescuento: unknown;
  motivo: string;
};

type PaidCreditSnapshotRow = {
  liquidacionCreditoOrigenId: number;
  creditoId: number;
  aliadoId: number;
  aliadoNombre: string;
  liquidacionOrigenId: number;
  estadoLiquidacion: string;
  estadoCreditoPagado: string;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string;
  imei: string;
  equipo: string;
  plataforma: string;
  sedeId: number;
  sedeNombre: string;
  valorPagar: unknown;
};

export type AllyPaymentAnnulmentAdjustmentLine = {
  id: number;
  ajusteId: number;
  creditoId: number;
  fechaAnulacion: string;
  fechaAnulacionFuente: string;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string;
  imei: string;
  equipo: string;
  plataforma: AllyPaymentPlatform;
  sedeId: number;
  sedeNombre: string;
  sede: { id: number; nombre: string };
  aliadoId: number;
  aliadoNombre: string;
  aliado: { id: number; nombre: string };
  liquidacionOrigenId: number;
  valorDescuento: number;
  motivo: string;
  estado: "PENDIENTE_DESCUENTO" | "DESCONTADO";
};

type StoredAnnulmentApplication = {
  id: number;
  ajusteId: number;
  valorDescuento: unknown;
  ajuste: {
    creditoId: number;
    aliadoId: number;
    aliadoNombre: string;
    fechaAnulacion: Date;
    fechaAnulacionFuente: string;
    folio: string;
    clienteNombre: string;
    clienteDocumento: string;
    imei: string;
    equipo: string;
    plataforma: string;
    sedeId: number;
    sedeNombre: string;
    liquidacionOrigenId: number;
    motivo: string;
  };
};

function compactText(value: unknown, fallback: string, max: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, max);
}

function money(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.round((parsed + Number.EPSILON) * 100) / 100)
    : 0;
}

function platform(value: unknown): AllyPaymentPlatform {
  return String(value ?? "").trim().toUpperCase() === "IPHONE"
    ? "IPHONE"
    : "ANDROID";
}

function serializePendingRow(
  row: AnnulmentAdjustmentRow
): AllyPaymentAnnulmentAdjustmentLine {
  return {
    id: row.id,
    ajusteId: row.id,
    creditoId: row.creditoId,
    fechaAnulacion: new Date(row.fechaAnulacion).toISOString(),
    fechaAnulacionFuente: row.fechaAnulacionFuente,
    folio: row.folio,
    clienteNombre: row.clienteNombre,
    clienteDocumento: row.clienteDocumento,
    imei: row.imei,
    equipo: row.equipo,
    plataforma: platform(row.plataforma),
    sedeId: row.sedeId,
    sedeNombre: row.sedeNombre,
    sede: { id: row.sedeId, nombre: row.sedeNombre },
    aliadoId: row.aliadoId,
    aliadoNombre: row.aliadoNombre,
    aliado: { id: row.aliadoId, nombre: row.aliadoNombre },
    liquidacionOrigenId: row.liquidacionOrigenId,
    valorDescuento: money(row.valorDescuento),
    motivo: row.motivo,
    estado: "PENDIENTE_DESCUENTO",
  };
}

/**
 * Every path that can create or consume an ally adjustment takes this lock first.
 * The credit row may only be locked afterwards, which keeps lock ordering stable.
 */
export async function lockAllyPaymentAlly(
  transaction: AnnulmentDbClient,
  allyId: number
) {
  await transaction.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    "ALLY_PAYMENT_ALLY:" + allyId
  );
}

export async function resolvePaidCreditAllyId(
  transaction: AnnulmentDbClient,
  creditoId: number
) {
  const rows = await transaction.$queryRawUnsafe<Array<{ aliadoId: number }>>(
    `
      SELECT settlement."aliadoId"
      FROM public."LiquidacionAliadoCredito" paid_credit
      INNER JOIN public."LiquidacionAliado" settlement
        ON settlement."id" = paid_credit."liquidacionId"
      WHERE paid_credit."creditoId" = $1
      LIMIT 1
    `,
    creditoId
  );
  return rows[0]?.aliadoId ?? null;
}

/**
 * Records the immutable value that was actually paid for a credit. If the credit
 * was never paid to an ally there is no financial adjustment to create.
 */
export async function registerPaidCreditAnnulmentAdjustment(
  transaction: AnnulmentDbClient,
  input: {
    creditoId: number;
    aliadoId: number | null;
    fechaAnulacion: Date;
    motivo: string;
    creadoPorUsuarioId: number | null;
    creadoPorNombre: string;
    fechaAnulacionFuente?: string;
  }
) {
  const snapshots = await transaction.$queryRawUnsafe<PaidCreditSnapshotRow[]>(
    `
      SELECT
        paid_credit."id" AS "liquidacionCreditoOrigenId",
        paid_credit."creditoId",
        settlement."aliadoId",
        ally."nombre" AS "aliadoNombre",
        settlement."id" AS "liquidacionOrigenId",
        settlement."estado" AS "estadoLiquidacion",
        paid_credit."estado" AS "estadoCreditoPagado",
        paid_credit."folio",
        paid_credit."clienteNombre",
        paid_credit."clienteDocumento",
        paid_credit."imei",
        paid_credit."equipo",
        paid_credit."plataforma",
        credit."sedeId",
        site."nombre" AS "sedeNombre",
        paid_credit."valorPagar"
      FROM public."LiquidacionAliadoCredito" paid_credit
      INNER JOIN public."LiquidacionAliado" settlement
        ON settlement."id" = paid_credit."liquidacionId"
      INNER JOIN public."Aliado" ally
        ON ally."id" = settlement."aliadoId"
      INNER JOIN public."Credito" credit
        ON credit."id" = paid_credit."creditoId"
      INNER JOIN public."Sede" site
        ON site."id" = credit."sedeId"
      WHERE paid_credit."creditoId" = $1
      FOR UPDATE OF paid_credit
    `,
    input.creditoId
  );
  const snapshot = snapshots[0];

  if (!snapshot) return null;
  if (input.aliadoId !== null && snapshot.aliadoId !== input.aliadoId) {
    throw new Error("El credito pagado pertenece a otro aliado.");
  }
  if (String(snapshot.estadoLiquidacion).trim().toUpperCase() !== "PAGADA") {
    return null;
  }
  if (String(snapshot.estadoCreditoPagado).trim().toUpperCase() !== "PAGADO") {
    return null;
  }

  const valorDescuento = money(snapshot.valorPagar);
  if (valorDescuento <= 0) return null;

  const inserted = await transaction.$queryRawUnsafe<Array<{ id: number }>>(
    `
      INSERT INTO public."AjusteAnulacionCreditoAliado" (
        "creditoId", "liquidacionCreditoOrigenId", "aliadoId", "aliadoNombre",
        "fechaAnulacion", "fechaAnulacionFuente", "folio", "clienteNombre",
        "clienteDocumento", "imei", "equipo", "plataforma", "sedeId",
        "sedeNombre", "liquidacionOrigenId", "valorDescuento", "motivo",
        "creadoPorUsuarioId", "creadoPorNombre", "createdAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, CURRENT_TIMESTAMP
      )
      ON CONFLICT ("creditoId") DO NOTHING
      RETURNING "id"
    `,
    snapshot.creditoId,
    snapshot.liquidacionCreditoOrigenId,
    snapshot.aliadoId,
    compactText(snapshot.aliadoNombre, "Aliado", 180),
    input.fechaAnulacion,
    compactText(input.fechaAnulacionFuente, "OPERACION_EN_LINEA", 32),
    compactText(snapshot.folio, "Credito " + snapshot.creditoId, 80),
    compactText(snapshot.clienteNombre, "Cliente", 180),
    compactText(snapshot.clienteDocumento, "Sin documento", 80),
    compactText(snapshot.imei, "Sin IMEI", 80),
    compactText(snapshot.equipo, "Equipo sin referencia", 240),
    platform(snapshot.plataforma),
    snapshot.sedeId,
    compactText(snapshot.sedeNombre, "Sede sin nombre", 180),
    snapshot.liquidacionOrigenId,
    valorDescuento.toFixed(2),
    compactText(input.motivo, "Anulado por administrador", 500),
    input.creadoPorUsuarioId,
    compactText(input.creadoPorNombre, "Administrador FINSER PAY", 160)
  );

  if (inserted[0]) return inserted[0];

  const existing = await transaction.$queryRawUnsafe<
    Array<{
      id: number;
      creditoId: number;
      liquidacionCreditoOrigenId: number;
      aliadoId: number;
      valorDescuento: unknown;
    }>
  >(
    `
      SELECT "id", "creditoId", "liquidacionCreditoOrigenId", "aliadoId", "valorDescuento"
      FROM public."AjusteAnulacionCreditoAliado"
      WHERE "creditoId" = $1 OR "liquidacionCreditoOrigenId" = $2
      ORDER BY "id" ASC
      LIMIT 1
    `,
    snapshot.creditoId,
    snapshot.liquidacionCreditoOrigenId
  );
  const event = existing[0];
  if (
    !event ||
    event.creditoId !== snapshot.creditoId ||
    event.liquidacionCreditoOrigenId !== snapshot.liquidacionCreditoOrigenId ||
    event.aliadoId !== snapshot.aliadoId ||
    money(event.valorDescuento) !== valorDescuento
  ) {
    throw new Error("Conflicto al registrar el ajuste por anulacion del credito.");
  }

  return { id: event.id };
}

/**
 * Pending adjustments carry forward: a period lower bound never hides an older
 * undiscounted event. The end bound prevents a historical preview from seeing a
 * cancellation that had not happened yet.
 */
export async function loadPendingAllyPaymentAnnulmentAdjustments(
  database: AnnulmentDbClient,
  input: {
    allyId: number | null;
    start?: Date;
    endExclusive?: Date;
    lock?: boolean;
  }
): Promise<AllyPaymentAnnulmentAdjustmentLine[]> {
  const values: unknown[] = [];
  const conditions = ['application."id" IS NULL'];

  if (input.allyId !== null) {
    values.push(input.allyId);
    conditions.push(`adjustment."aliadoId" = $${values.length}`);
  }
  if (input.endExclusive) {
    values.push(input.endExclusive);
    conditions.push(`adjustment."fechaAnulacion" < $${values.length}`);
  }

  const rows = await database.$queryRawUnsafe<AnnulmentAdjustmentRow[]>(
    `
      SELECT
        adjustment."id", adjustment."creditoId", adjustment."aliadoId",
        adjustment."aliadoNombre", adjustment."fechaAnulacion",
        adjustment."fechaAnulacionFuente", adjustment."folio",
        adjustment."clienteNombre", adjustment."clienteDocumento",
        adjustment."imei", adjustment."equipo", adjustment."plataforma",
        adjustment."sedeId", adjustment."sedeNombre",
        adjustment."liquidacionOrigenId", adjustment."valorDescuento",
        adjustment."motivo"
      FROM public."AjusteAnulacionCreditoAliado" adjustment
      LEFT JOIN public."LiquidacionAliadoAjusteAnulacion" application
        ON application."ajusteId" = adjustment."id"
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY adjustment."fechaAnulacion" ASC, adjustment."id" ASC
      ${input.lock ? 'FOR UPDATE OF adjustment' : ''}
    `,
    ...values
  );

  return rows.map(serializePendingRow);
}

export function serializeStoredAllyPaymentAnnulmentAdjustment(
  application: StoredAnnulmentApplication
): AllyPaymentAnnulmentAdjustmentLine {
  const adjustment = application.ajuste;
  return {
    id: application.id,
    ajusteId: application.ajusteId,
    creditoId: adjustment.creditoId,
    fechaAnulacion: adjustment.fechaAnulacion.toISOString(),
    fechaAnulacionFuente: adjustment.fechaAnulacionFuente,
    folio: adjustment.folio,
    clienteNombre: adjustment.clienteNombre,
    clienteDocumento: adjustment.clienteDocumento,
    imei: adjustment.imei,
    equipo: adjustment.equipo,
    plataforma: platform(adjustment.plataforma),
    sedeId: adjustment.sedeId,
    sedeNombre: adjustment.sedeNombre,
    sede: { id: adjustment.sedeId, nombre: adjustment.sedeNombre },
    aliadoId: adjustment.aliadoId,
    aliadoNombre: adjustment.aliadoNombre,
    aliado: { id: adjustment.aliadoId, nombre: adjustment.aliadoNombre },
    liquidacionOrigenId: adjustment.liquidacionOrigenId,
    valorDescuento: money(application.valorDescuento),
    motivo: adjustment.motivo,
    estado: "DESCONTADO",
  };
}

export function totalAllyPaymentAnnulmentAdjustments(
  adjustments: readonly Pick<AllyPaymentAnnulmentAdjustmentLine, "valorDescuento">[]
) {
  return adjustments.reduce(
    (total, adjustment) =>
      Math.round((total + money(adjustment.valorDescuento) + Number.EPSILON) * 100) /
      100,
    0
  );
}
