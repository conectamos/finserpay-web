import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { ALIADO_FINSER_PAY, resolveRedescuentoPercentageByPlatform } from "@/lib/aliados";
import {
  ALLY_PAYMENTS_AVAILABLE_FROM,
  calculateAllyPaymentAmounts,
  normalizeBankApprovalNumber,
  resolveAllyPaymentPlatform,
  resolveAvailableAllyPaymentPeriod,
  resolveColombiaPaymentPeriod,
  summarizeAllyPayments,
  type AllyPaymentPlatform,
  type AllyPaymentSummary,
} from "@/lib/ally-payments-core";
import { colombiaDateKey } from "@/lib/colombia-date";
import { isDataCreditoUniqueViolation } from "@/lib/datacredito/database-errors";
import prisma from "@/lib/prisma";

const PAYMENT_CALCULATION_VERSION = "ALLY_INTERMEDIATION_V1";
const CANCELLED_STATES = ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"] as const;
const PAYMENT_AVAILABILITY_START = resolveColombiaPaymentPeriod(
  ALLY_PAYMENTS_AVAILABLE_FROM,
  ALLY_PAYMENTS_AVAILABLE_FROM
).start;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;

type DbClient = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

type EligibleCreditRow = {
  id: number;
  fechaCredito: Date;
  folio: string;
  clienteNombre: string;
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
  valorEquipoTotal: number;
  cuotaInicial: number;
  contratoSnapshot: unknown;
  aliadoId: number;
  aliadoNombre: string;
  redescuentoPorcentaje: number;
  redescuentoAndroidPorcentaje: number;
  redescuentoIphonePorcentaje: number;
};

export type AllyPaymentLine = {
  id?: number;
  creditoId: number;
  fechaCredito: string;
  folio: string;
  clienteNombre: string;
  equipo: string;
  plataforma: AllyPaymentPlatform;
  valorVenta: number;
  creditoAutorizado: number;
  cuotaInicial: number;
  porcentajeIntermediacion: number;
  valorIntermediacion: number;
  valorPagar: number;
  estado: "PENDIENTE" | "PAGADO";
  aliado: {
    id: number;
    nombre: string;
  };
};

export type AllyPaymentSummaryPayload = {
  ANDROID: ReturnType<typeof serializeSummaryBucket>;
  IPHONE: ReturnType<typeof serializeSummaryBucket>;
  total: ReturnType<typeof serializeSummaryBucket>;
};

export class AllyPaymentValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues[0] || "Los datos de la liquidacion no son validos.");
    this.name = "AllyPaymentValidationError";
    this.issues = issues;
  }
}

export class AllyPaymentConflictError extends Error {
  readonly code:
    | "ALLY_PAYMENT_PREVIEW_CHANGED"
    | "ALLY_PAYMENT_MUTATION_CONFLICT"
    | "ALLY_PAYMENT_DUPLICATE"
    | "ALLY_PAYMENT_EMPTY";

  constructor(code: AllyPaymentConflictError["code"], message: string) {
    super(message);
    this.name = "AllyPaymentConflictError";
    this.code = code;
  }
}

export class AllyPaymentNotFoundError extends Error {
  constructor(message = "La liquidacion solicitada no existe.") {
    super(message);
    this.name = "AllyPaymentNotFoundError";
  }
}

function positiveId(value: unknown, label: string) {
  const id = Number(String(value ?? "").trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AllyPaymentValidationError([label + " no es valido."]);
  }
  return id;
}

export function parseAllyPaymentMutationId(value: unknown) {
  const mutationId = String(value ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(mutationId)) {
    throw new AllyPaymentValidationError(["mutationId debe ser un UUID valido."]);
  }
  return mutationId;
}

export function parseAllyPaymentPreviewToken(value: unknown) {
  const token = String(value ?? "").trim().toLowerCase();
  if (!HASH_PATTERN.test(token)) {
    throw new AllyPaymentValidationError([
      "Debes generar una previsualizacion vigente antes de registrar el pago.",
    ]);
  }
  return token;
}

function parseApproval(value: unknown) {
  const display = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  const normalized = normalizeBankApprovalNumber(display);

  if (!normalized || normalized.length > 120) {
    throw new AllyPaymentValidationError([
      "El numero de aprobacion bancaria es obligatorio y admite hasta 120 caracteres.",
    ]);
  }

  return { display, normalized };
}

function dateOnly(value: Date | string) {
  if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (match) return match[1];
  }
  return new Date(value).toISOString().slice(0, 10);
}

function dateForDatabase(value: string) {
  return new Date(value + "T00:00:00.000Z");
}

function parsePaymentPeriod(startDate: unknown, endDate: unknown) {
  try {
    return resolveAvailableAllyPaymentPeriod(startDate, endDate);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AllyPaymentValidationError([error.message]);
    }
    throw error;
  }
}

function creditDateForDatabase(value: string) {
  return new Date(value + "T12:00:00.000Z");
}

function compactText(value: unknown, fallback: string, max: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, max);
}

function equipmentLabel(row: EligibleCreditRow) {
  return compactText(
    row.referenciaEquipo ||
      [row.equipoMarca, row.equipoModelo].filter(Boolean).join(" "),
    "Equipo sin referencia",
    240
  );
}

function serializeSummaryBucket(bucket: AllyPaymentSummary["total"]) {
  return {
    plataforma: bucket.plataforma,
    numeroCreditos: bucket.numeroCreditos,
    totalValorVenta: bucket.valorVenta,
    totalCreditoAutorizado: bucket.creditoAutorizado,
    totalCuotaInicial: bucket.cuotaInicial,
    totalIntermediacion: bucket.valorIntermediacion,
    totalPagar: bucket.valorPagar,
    porcentajeIntermediacion: bucket.porcentajeIntermediacion,
  };
}

function serializeSummary(summary: AllyPaymentSummary): AllyPaymentSummaryPayload {
  return {
    ANDROID: serializeSummaryBucket(summary.ANDROID),
    IPHONE: serializeSummaryBucket(summary.IPHONE),
    total: serializeSummaryBucket(summary.total),
  };
}

function buildLine(row: EligibleCreditRow): AllyPaymentLine | null {
  const plataforma = resolveAllyPaymentPlatform(
    row.contratoSnapshot,
    row.equipoMarca
  );

  if (!plataforma) {
    return null;
  }

  const porcentajeIntermediacion = resolveRedescuentoPercentageByPlatform(
    row,
    plataforma
  );
  const amounts = calculateAllyPaymentAmounts({
    valorVenta: row.valorEquipoTotal,
    cuotaInicial: row.cuotaInicial,
    porcentajeIntermediacion,
  });

  if (amounts.creditoAutorizado <= 0) {
    return null;
  }

  return {
    creditoId: row.id,
    fechaCredito: colombiaDateKey(row.fechaCredito),
    folio: compactText(row.folio, "Credito " + row.id, 80),
    clienteNombre: compactText(row.clienteNombre, "Cliente", 180),
    equipo: equipmentLabel(row),
    plataforma,
    ...amounts,
    estado: "PENDIENTE",
    aliado: {
      id: row.aliadoId,
      nombre: row.aliadoNombre,
    },
  };
}

async function loadEligibleCreditRows(
  db: DbClient,
  input: {
    allyId: number | null;
    start?: Date;
    endExclusive?: Date;
    lock?: boolean;
  }
) {
  const lockClause = input.lock ? " FOR UPDATE OF credit" : "";
  const query =
    `
      SELECT credit."id", credit."fechaCredito", credit."folio",
        credit."clienteNombre", credit."referenciaEquipo", credit."equipoMarca",
        credit."equipoModelo", credit."valorEquipoTotal", credit."cuotaInicial",
        credit."contratoSnapshot", ally."id" AS "aliadoId",
        ally."nombre" AS "aliadoNombre",
        ally."redescuentoPorcentaje",
        ally."redescuentoAndroidPorcentaje",
        ally."redescuentoIphonePorcentaje"
      FROM "Credito" credit
      JOIN "Sede" site ON site."id" = credit."sedeId"
      JOIN "Aliado" ally ON ally."id" = site."aliadoId"
      LEFT JOIN "LiquidacionAliadoCredito" paid
        ON paid."creditoId" = credit."id"
      WHERE paid."id" IS NULL
        AND UPPER(BTRIM(COALESCE(credit."estado", ''))) <> ALL($4::text[])
        AND UPPER(BTRIM(COALESCE(ally."codigo", ''))) <> $5
        AND ($1::integer IS NULL OR ally."id" = $1)
        AND credit."fechaCredito" >= $6
        AND ($2::timestamp IS NULL OR credit."fechaCredito" >= $2)
        AND ($3::timestamp IS NULL OR credit."fechaCredito" < $3)
      ORDER BY credit."fechaCredito" ASC, credit."id" ASC` + lockClause;

  return db.$queryRawUnsafe<EligibleCreditRow[]>(
    query,
    input.allyId,
    input.start || null,
    input.endExclusive || null,
    [...CANCELLED_STATES],
    ALIADO_FINSER_PAY.codigo,
    PAYMENT_AVAILABILITY_START
  );
}

async function loadEligibleLines(
  db: DbClient,
  input: {
    allyId: number | null;
    start?: Date;
    endExclusive?: Date;
    lock?: boolean;
  }
) {
  const rows = await loadEligibleCreditRows(db, input);
  return rows.map(buildLine).filter((item): item is AllyPaymentLine => Boolean(item));
}

const SETTLEMENT_INCLUDE = {
  aliado: {
    select: {
      id: true,
      nombre: true,
    },
  },
  creditos: {
    orderBy: [{ fechaCredito: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.LiquidacionAliadoInclude;

type StoredSettlement = Prisma.LiquidacionAliadoGetPayload<{
  include: typeof SETTLEMENT_INCLUDE;
}>;

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function previewFingerprint(
  allyId: number,
  period: ReturnType<typeof resolveColombiaPaymentPeriod>,
  lines: readonly AllyPaymentLine[]
) {
  return sha256({
    version: PAYMENT_CALCULATION_VERSION,
    aliadoId: allyId,
    periodoInicio: period.startDate,
    periodoFin: period.endDate,
    creditos: lines.map((line) => ({
      creditoId: line.creditoId,
      fechaCredito: line.fechaCredito,
      plataforma: line.plataforma,
      valorVenta: line.valorVenta,
      cuotaInicial: line.cuotaInicial,
      creditoAutorizado: line.creditoAutorizado,
      porcentajeIntermediacion: line.porcentajeIntermediacion,
      valorIntermediacion: line.valorIntermediacion,
      valorPagar: line.valorPagar,
    })),
  });
}

function requestFingerprint(input: {
  allyId: number;
  startDate: string;
  endDate: string;
  approval: string;
  previewToken: string;
}) {
  return sha256({
    version: PAYMENT_CALCULATION_VERSION,
    aliadoId: input.allyId,
    periodoInicio: input.startDate,
    periodoFin: input.endDate,
    numeroAprobacionNormalizado: input.approval,
    previewToken: input.previewToken,
  });
}

function serializeStoredLine(
  detail: StoredSettlement["creditos"][number],
  ally: StoredSettlement["aliado"]
): AllyPaymentLine {
  return {
    id: detail.id,
    creditoId: detail.creditoId,
    fechaCredito: dateOnly(detail.fechaCredito),
    folio: detail.folio,
    clienteNombre: detail.clienteNombre,
    equipo: detail.equipo,
    plataforma: detail.plataforma === "IPHONE" ? "IPHONE" : "ANDROID",
    valorVenta: Number(detail.valorVenta),
    creditoAutorizado: Number(detail.creditoAutorizado),
    cuotaInicial: Number(detail.cuotaInicial),
    porcentajeIntermediacion: Number(detail.porcentajeIntermediacion),
    valorIntermediacion: Number(detail.valorIntermediacion),
    valorPagar: Number(detail.valorPagar),
    estado: "PAGADO",
    aliado: ally,
  };
}

function serializeSettlement(settlement: StoredSettlement) {
  const items = settlement.creditos.map((detail) =>
    serializeStoredLine(detail, settlement.aliado)
  );

  return {
    id: settlement.id,
    mutationId: settlement.mutationId,
    aliado: settlement.aliado,
    periodoInicio: dateOnly(settlement.periodoInicio),
    periodoFin: dateOnly(settlement.periodoFin),
    numeroAprobacionBancaria: settlement.numeroAprobacionBancaria,
    estado: settlement.estado,
    numeroCreditos: settlement.numeroCreditos,
    totalValorVenta: Number(settlement.totalValorVenta),
    totalCreditoAutorizado: Number(settlement.totalCreditoAutorizado),
    totalCuotaInicial: Number(settlement.totalCuotaInicial),
    totalIntermediacion: Number(settlement.totalIntermediacion),
    totalPagar: Number(settlement.totalPagar),
    registradoPorNombre: settlement.registradoPorNombre,
    pagadoAt: settlement.pagadoAt.toISOString(),
    createdAt: settlement.createdAt.toISOString(),
    summary: serializeSummary(summarizeAllyPayments(items)),
    items,
  };
}

async function requirePayableAlly(
  db: Pick<Prisma.TransactionClient, "aliado">,
  allyId: number
) {
  const ally = await db.aliado.findUnique({
    where: { id: allyId },
    select: {
      id: true,
      nombre: true,
      codigo: true,
      activo: true,
      redescuentoAndroidPorcentaje: true,
      redescuentoIphonePorcentaje: true,
    },
  });

  if (
    !ally ||
    String(ally.codigo || "").trim().toUpperCase() === ALIADO_FINSER_PAY.codigo
  ) {
    throw new AllyPaymentValidationError([
      "El aliado seleccionado no es valido para liquidaciones.",
    ]);
  }

  return ally;
}

export async function listAllyPaymentAllies() {
  const allies = await prisma.aliado.findMany({
    select: {
      id: true,
      nombre: true,
      codigo: true,
      activo: true,
      redescuentoAndroidPorcentaje: true,
      redescuentoIphonePorcentaje: true,
    },
    orderBy: [{ activo: "desc" }, { nombre: "asc" }],
  });

  return allies
    .filter(
      (ally) =>
        String(ally.codigo || "").trim().toUpperCase() !==
        ALIADO_FINSER_PAY.codigo
    )
    .map((ally) => ({
      id: ally.id,
      nombre: ally.nombre,
      activo: ally.activo,
      redescuentoAndroidPorcentaje: ally.redescuentoAndroidPorcentaje,
      redescuentoIphonePorcentaje: ally.redescuentoIphonePorcentaje,
    }));
}

export async function listAllyPaymentPending(input: {
  allyId: number | null;
}) {
  const allyId = input.allyId === null ? null : positiveId(input.allyId, "El aliado");
  const items = await loadEligibleLines(prisma, { allyId });

  return {
    items,
    summary: serializeSummary(summarizeAllyPayments(items)),
  };
}

export async function getAllyPaymentPreview(input: {
  allyId: unknown;
  startDate: unknown;
  endDate: unknown;
}) {
  const allyId = positiveId(input.allyId, "El aliado");
  const period = parsePaymentPeriod(input.startDate, input.endDate);
  const ally = await requirePayableAlly(prisma, allyId);
  const items = await loadEligibleLines(prisma, {
    allyId,
    start: period.start,
    endExclusive: period.endExclusive,
  });

  return {
    token: previewFingerprint(allyId, period, items),
    aliado: {
      id: ally.id,
      nombre: ally.nombre,
    },
    periodoInicio: period.startDate,
    periodoFin: period.endDate,
    items,
    summary: serializeSummary(summarizeAllyPayments(items)),
  };
}

export async function listAllyPaymentHistory(input: {
  allyId: number | null;
  limit?: number;
}) {
  const allyId = input.allyId === null ? null : positiveId(input.allyId, "El aliado");
  const requestedLimit = Number(input.limit ?? 100);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 200))
    : 100;
  const settlements = await prisma.liquidacionAliado.findMany({
    where: {
      periodoInicio: { gte: dateForDatabase(ALLY_PAYMENTS_AVAILABLE_FROM) },
      ...(allyId === null ? {} : { aliadoId: allyId }),
    },
    include: SETTLEMENT_INCLUDE,
    orderBy: [{ pagadoAt: "desc" }, { id: "desc" }],
    take: limit,
  });

  return settlements.map(serializeSettlement);
}

export async function getAllyPaymentDetail(input: {
  id: unknown;
  allyId: number | null;
}) {
  const id = positiveId(input.id, "La liquidacion");
  const allyId = input.allyId === null ? null : positiveId(input.allyId, "El aliado");
  const settlement = await prisma.liquidacionAliado.findFirst({
    where: {
      id,
      periodoInicio: { gte: dateForDatabase(ALLY_PAYMENTS_AVAILABLE_FROM) },
      ...(allyId === null ? {} : { aliadoId: allyId }),
    },
    include: SETTLEMENT_INCLUDE,
  });

  if (!settlement) {
    throw new AllyPaymentNotFoundError();
  }

  return serializeSettlement(settlement);
}

function moneyForDatabase(value: number) {
  return value.toFixed(2);
}

function percentageForDatabase(value: number) {
  return value.toFixed(4);
}

function hasDatabaseCode(error: unknown, expected: ReadonlySet<string>) {
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];

  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;

    visited.add(current);
    const record = current as Record<string, unknown>;
    const code = String(record.code || record.originalCode || "").toUpperCase();
    if (expected.has(code)) return true;

    for (const key of ["cause", "meta", "driverAdapterError", "originalError"]) {
      if (record[key]) pending.push(record[key]);
    }
  }

  return false;
}

export async function createAllyPayment(input: {
  mutationId: unknown;
  allyId: unknown;
  startDate: unknown;
  endDate: unknown;
  numeroAprobacionBancaria: unknown;
  previewToken: unknown;
  registradoPorUsuarioId: unknown;
  registradoPorNombre: unknown;
}) {
  const mutationId = parseAllyPaymentMutationId(input.mutationId);
  const allyId = positiveId(input.allyId, "El aliado");
  const actorUserId = positiveId(
    input.registradoPorUsuarioId,
    "El usuario que registra el pago"
  );
  const actorName = compactText(
    input.registradoPorNombre,
    "Administrador FINSER PAY",
    160
  );
  const period = parsePaymentPeriod(input.startDate, input.endDate);
  const approval = parseApproval(input.numeroAprobacionBancaria);
  const previewToken = parseAllyPaymentPreviewToken(input.previewToken);
  const requestHash = requestFingerprint({
    allyId,
    startDate: period.startDate,
    endDate: period.endDate,
    approval: approval.normalized,
    previewToken,
  });

  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          "ALLY_PAYMENT_MUTATION:" + mutationId
        );

        const existing = await tx.liquidacionAliado.findUnique({
          where: { mutationId },
          include: SETTLEMENT_INCLUDE,
        });

        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new AllyPaymentConflictError(
              "ALLY_PAYMENT_MUTATION_CONFLICT",
              "El identificador de esta operacion ya fue usado con otros datos."
            );
          }

          return {
            ...serializeSettlement(existing),
            idempotent: true,
          };
        }

        await tx.$queryRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          "ALLY_PAYMENT_ALLY:" + allyId
        );
        const ally = await requirePayableAlly(tx, allyId);
        const approvalAlreadyUsed = await tx.liquidacionAliado.findUnique({
          where: {
            numeroAprobacionNormalizado: approval.normalized,
          },
          select: { id: true },
        });

        if (approvalAlreadyUsed) {
          throw new AllyPaymentConflictError(
            "ALLY_PAYMENT_DUPLICATE",
            "El numero de aprobacion bancaria ya fue registrado."
          );
        }

        const items = await loadEligibleLines(tx, {
          allyId,
          start: period.start,
          endExclusive: period.endExclusive,
          lock: true,
        });

        if (!items.length) {
          throw new AllyPaymentConflictError(
            "ALLY_PAYMENT_EMPTY",
            "Ya no hay creditos pendientes para el aliado y periodo seleccionados."
          );
        }

        const currentPreviewToken = previewFingerprint(allyId, period, items);
        if (currentPreviewToken !== previewToken) {
          throw new AllyPaymentConflictError(
            "ALLY_PAYMENT_PREVIEW_CHANGED",
            "Los creditos o porcentajes cambiaron. Actualiza la previsualizacion antes de pagar."
          );
        }

        const summary = summarizeAllyPayments(items);
        const created = await tx.liquidacionAliado.create({
          data: {
            mutationId,
            requestHash,
            periodoInicio: dateForDatabase(period.startDate),
            periodoFin: dateForDatabase(period.endDate),
            numeroAprobacionBancaria: approval.display,
            numeroAprobacionNormalizado: approval.normalized,
            estado: "PAGADA",
            numeroCreditos: summary.total.numeroCreditos,
            totalValorVenta: moneyForDatabase(summary.total.valorVenta),
            totalCreditoAutorizado: moneyForDatabase(
              summary.total.creditoAutorizado
            ),
            totalCuotaInicial: moneyForDatabase(summary.total.cuotaInicial),
            totalIntermediacion: moneyForDatabase(
              summary.total.valorIntermediacion
            ),
            totalPagar: moneyForDatabase(summary.total.valorPagar),
            registradoPorNombre: actorName,
            aliado: { connect: { id: ally.id } },
            registradoPor: { connect: { id: actorUserId } },
            creditos: {
              create: items.map((item) => ({
                fechaCredito: creditDateForDatabase(item.fechaCredito),
                folio: item.folio,
                clienteNombre: item.clienteNombre,
                equipo: item.equipo,
                plataforma: item.plataforma,
                valorVenta: moneyForDatabase(item.valorVenta),
                creditoAutorizado: moneyForDatabase(item.creditoAutorizado),
                cuotaInicial: moneyForDatabase(item.cuotaInicial),
                porcentajeIntermediacion: percentageForDatabase(
                  item.porcentajeIntermediacion
                ),
                valorIntermediacion: moneyForDatabase(
                  item.valorIntermediacion
                ),
                valorPagar: moneyForDatabase(item.valorPagar),
                estado: "PAGADO",
                credito: { connect: { id: item.creditoId } },
              })),
            },
          },
          include: SETTLEMENT_INCLUDE,
        });

        return {
          ...serializeSettlement(created),
          idempotent: false,
        };
      },
      {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 20_000,
      }
    );
  } catch (error) {
    if (
      error instanceof AllyPaymentValidationError ||
      error instanceof AllyPaymentConflictError
    ) {
      throw error;
    }

    if (isDataCreditoUniqueViolation(error)) {
      throw new AllyPaymentConflictError(
        "ALLY_PAYMENT_DUPLICATE",
        "El pago, la aprobacion bancaria o alguno de sus creditos ya fue registrado."
      );
    }

    if (hasDatabaseCode(error, new Set(["P2034", "40001", "40P01"]))) {
      throw new AllyPaymentConflictError(
        "ALLY_PAYMENT_PREVIEW_CHANGED",
        "La informacion cambio mientras se registraba el pago. Actualiza la previsualizacion e intenta de nuevo."
      );
    }

    throw error;
  }
}
