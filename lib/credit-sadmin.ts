import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import { assertApprovalActorActive, approvalActorAudit } from "@/lib/credit-approval-actor";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { getPaymentFrequencyLabel } from "@/lib/credit-factory";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { splitOutstandingBalance } from "@/lib/credit-outstanding-balance";
import { calendarDateKey, getColombiaDateParts } from "@/lib/colombia-date";
import { isExcludedCarteraCreditState, resolveCarteraExportRates } from "@/lib/cartera-export";
import { applySadminChange, parseSadminChange, sadminRegistration, type StoredSadminRegistration } from "@/lib/credit-sadmin-state";
import type {
  SadminActor, SadminCreationStatus, SadminCreditRow, SadminHistoryEntry,
  SadminPage, SadminStatusFilter, SadminSummary,
} from "@/lib/credit-sadmin-types";

type Database = Pick<PrismaClient, "$transaction">;
type Transaction = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Payment = { fechaAbono: string; metodoPago: string | null; valor: number };
type CreditRow = {
  id: number; folio: string; createdAt: Date; fechaCredito: Date;
  canEditSadmin: boolean;
  clienteNombre: string; clienteDocumento: string | null; clienteTelefono: string | null;
  clienteDireccion: string | null; clienteFechaNacimiento: Date | null; clienteCorreo: string | null; clienteGenero: string | null;
  imei: string; referenciaEquipo: string | null; equipoMarca: string | null; equipoModelo: string | null;
  plazoMeses: number | null; frecuenciaPago: string; valorEquipoTotal: number; cuotaInicial: number;
  saldoBaseFinanciado: number; valorCuota: number; montoCredito: number; valorFianza: number; valorInteres: number;
  planCapitalVigente?: unknown;
  tasaInteresEa: number; fianzaPorcentaje: number; contratoSnapshot: unknown;
  amortizacion: { tasaInteresEaPorcentaje: number; fianzaCuotaPorcentaje: number; seguroCuotaPorcentaje: number; numeroCuotas: number } | null;
  aliadoNombre: string; sedeNombre: string; fechaPrimerPago: Date | null; fechaProximoPago: Date | null;
  pazYSalvoEmitidoAt: Date | null; abonos: Payment[]; registration: StoredSadminRegistration | null;
};
type SadminEventRow = {
  version: number; actorName: string; payload: unknown; createdAt: Date | string;
};

// Both nominal roles can consult and complete the full historical cartera.
// SADMIN tracking is independent from the approval required for settlement.
// The separate SADMIN registration never changes credit or financial state.
const visibleCreditSql = `UPPER(BTRIM(COALESCE(credit."estado",''))) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')`;
const searchSql = `($1::text IS NULL OR
  strpos(lower(COALESCE(credit."clienteNombre",'')),lower($1))>0 OR
  strpos(lower(COALESCE(credit."clienteDocumento",'')),lower($1))>0 OR
  strpos(lower(COALESCE(credit."folio",'')),lower($1))>0 OR
  strpos(lower(COALESCE(ally."nombre",'')),lower($1))>0 OR
  strpos(lower(COALESCE(registration."numeroCredito",'')),lower($1))>0)`;
const createdSadminSql = `(COALESCE(registration."estadoCreacion",'PENDIENTE_CREAR')='CREADO_CORRECTAMENTE')`;
const statusSql = `($2::text='all'
  OR ($2::text='pending' AND NOT ${createdSadminSql})
  OR ($2::text='created' AND ${createdSadminSql}))`;
function actorCreditScopeSql(actor: SadminActor, operation: "read" | "write" = "read") {
  const scope = operation === "write" ? actor.sadminWriteScope ?? actor.sadminScope : actor.sadminScope;
  if (scope === "HISTORICAL") return "TRUE";
  throw new CreditApprovalError("FORBIDDEN", "No tienes permiso para consultar la creación SADMIN.", 403);
}
function baseSql(actor: SadminActor) { return `FROM "Credito" credit
  JOIN "Sede" site ON site."id"=credit."sedeId"
  JOIN "Aliado" ally ON ally."id"=site."aliadoId"
  LEFT JOIN "CreditSadminRegistration" registration ON registration."creditoId"=credit."id"
  WHERE ${visibleCreditSql} AND ${actorCreditScopeSql(actor)} AND ${searchSql}`; }

const creditDetailsSql = `SELECT credit."id",credit."folio",credit."createdAt",credit."fechaCredito",selected."canEditSadmin",
  credit."clienteNombre",credit."clienteDocumento",credit."clienteTelefono",credit."clienteDireccion",
  credit."clienteFechaNacimiento",credit."clienteCorreo",credit."clienteGenero",credit."imei",
  credit."referenciaEquipo",credit."equipoMarca",credit."equipoModelo",credit."plazoMeses",credit."frecuenciaPago",
  credit."valorEquipoTotal",credit."cuotaInicial",credit."saldoBaseFinanciado",credit."valorCuota",credit."montoCredito",
  credit."planCapitalVigente",
  credit."valorFianza",credit."valorInteres",credit."tasaInteresEa",credit."fianzaPorcentaje",
  jsonb_build_object('financiero',credit."contratoSnapshot"->'financiero') AS "contratoSnapshot",
  CASE WHEN amort."id" IS NULL THEN NULL ELSE jsonb_build_object(
    'tasaInteresEaPorcentaje',amort."tasaInteresEaPorcentaje",'fianzaCuotaPorcentaje',amort."fianzaCuotaPorcentaje",
    'seguroCuotaPorcentaje',amort."seguroCuotaPorcentaje",'numeroCuotas',amort."numeroCuotas") END AS amortizacion,
  ally."nombre" AS "aliadoNombre",site."nombre" AS "sedeNombre",credit."fechaPrimerPago",credit."fechaProximoPago",
  credit."pazYSalvoEmitidoAt",COALESCE(payments.items,'[]'::jsonb) AS abonos,
  CASE WHEN registration."creditoId" IS NULL THEN NULL ELSE to_jsonb(registration) END AS registration
  FROM selected JOIN "Credito" credit ON credit."id"=selected."id"
  JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
  LEFT JOIN "CreditSadminRegistration" registration ON registration."creditoId"=credit."id"
  LEFT JOIN "CreditoAmortizacion" amort ON amort."creditoId"=credit."id"
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('fechaAbono',abono."fechaAbono",'valor',abono."valor",
    'metodoPago',abono."metodoPago") ORDER BY abono."fechaAbono",abono."id") AS items FROM "CreditoAbono" abono
    WHERE abono."creditoId"=credit."id" AND abono."estado"<>'ANULADO') payments ON true
  ORDER BY credit."fechaCredito" DESC,credit."id" DESC`;
// ExcelJS builds the non-streaming workbook in memory. Keep enough headroom for
// Next.js, Prisma and concurrent requests on the 512 MB production container.
export const SADMIN_EXPORT_MAX_ROWS = 2_000;

function parseSadminStatus(value: unknown): SadminStatusFilter {
  if (value === null || value === undefined || value === "") return "all";
  if (value === "all" || value === "pending" || value === "created") return value;
  throw new CreditApprovalError("INVALID_SADMIN_STATUS", "Selecciona un estado SADMIN v\u00e1lido.");
}

function parseSadminFilters(input: { q?: unknown; status?: unknown }) {
  if (input.q != null && (typeof input.q !== "string" || input.q.length > 100 || /[\u0000-\u001f\u007f]/.test(input.q))) {
    throw new CreditApprovalError("INVALID_SEARCH", "La búsqueda admite hasta 100 caracteres.");
  }
  return {
    query: typeof input.q === "string" ? input.q.trim() || null : null,
    status: parseSadminStatus(input.status),
  };
}

async function countSadminCredits(tx: Transaction, actor: SadminActor, query: string | null) {
  const rows = await tx.$queryRawUnsafe<Array<SadminPage["counts"]>>(`SELECT
    COUNT(*)::integer AS "all",
    (COUNT(*) FILTER (WHERE NOT ${createdSadminSql}))::integer AS "pending",
    (COUNT(*) FILTER (WHERE ${createdSadminSql}))::integer AS "created"
    ${baseSql(actor)}`, query);
  return rows[0] ?? { all: 0, pending: 0, created: 0 };
}

function loadSadminCreditRows(
  tx: Transaction,
  actor: SadminActor,
  query: string | null,
  status: SadminStatusFilter,
  limit: number,
  offset: number,
) {
  return tx.$queryRawUnsafe<CreditRow[]>(`WITH selected AS (
    SELECT credit."id",${actorCreditScopeSql(actor, "write")} AS "canEditSadmin" ${baseSql(actor)} AND ${statusSql}
    ORDER BY credit."fechaCredito" DESC,credit."id" DESC LIMIT $3::integer OFFSET $4::integer
  ) ${creditDetailsSql}`, query, status, limit, offset);
}
function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}
function calendar(value: Date | string | null) { return iso(value)?.slice(0, 10) ?? null; }
const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function eventCreationStatus(payload: unknown): SadminCreationStatus {
  const value = record(payload);
  const after = record(value.after);
  const status = String(after.estadoCreacion || value.estadoCreacion || "");
  if (["PENDIENTE_CREAR", "CREADO_CORRECTAMENTE", "ERROR_CREACION", "REQUIERE_REVISION"].includes(status)) {
    return status as SadminCreationStatus;
  }
  if (after.estado === "CREADO_SADMIN" || value.confirmation === "ADMIN_EXISTING_SADMIN") {
    return "CREADO_CORRECTAMENTE";
  }
  return "PENDIENTE_CREAR";
}
function eventNumber(payload: unknown) {
  const value = record(payload);
  const after = record(value.after);
  const number = after.numeroCredito ?? value.numeroCredito;
  return typeof number === "string" && number.trim() ? number.trim() : null;
}
function eventReason(payload: unknown) {
  const value = record(payload);
  const after = record(value.after);
  const reason = after.motivoEstado ?? value.motivoEstado;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}
async function loadSadminHistory(tx: Transaction, creditId: number): Promise<SadminHistoryEntry[]> {
  const events = await tx.$queryRawUnsafe<SadminEventRow[]>(`SELECT "version","actorName","payload","createdAt"
    FROM "CreditSadminEvent" WHERE "creditoId"=$1 ORDER BY "version" DESC`, creditId);
  return events.map(event => ({
    version: event.version,
    actor: event.actorName,
    fechaHora: iso(event.createdAt)!,
    numeroCredito: eventNumber(event.payload),
    resultado: eventCreationStatus(event.payload),
    motivo: eventReason(event.payload),
  }));
}

export function buildSadminCreditRow(credit: CreditRow, today = new Date()): SadminCreditRow {
  const plan = buildCreditPaymentPlan({
    planCapitalVigente: credit.planCapitalVigente,
    montoCredito: credit.montoCredito, valorCuota: credit.valorCuota, plazoMeses: credit.plazoMeses,
    frecuenciaPago: credit.frecuenciaPago, fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    fechaProximoPago: credit.fechaProximoPago, abonos: credit.abonos, today, settled: Boolean(credit.pazYSalvoEmitidoAt),
  });
  const balances = splitOutstandingBalance({
    ...credit,
    saldoPendiente: plan.saldoPendiente,
    totalAbonado: plan.totalPaid,
  });
  const rates = resolveCarteraExportRates(credit);
  const todayKey = calendarDateKey(getColombiaDateParts(today));
  const pending = plan.installments.filter(item => item.saldoPendiente > 0);
  const days = pending.map(item => Math.floor((Date.parse(todayKey) - Date.parse(item.fechaVencimiento)) / 86_400_000));
  const lastPayment = credit.abonos.at(-1);
  return {
    id: credit.id, folio: credit.folio, canEditSadmin: credit.canEditSadmin === true,
    numeroCreditoVisible: credit.registration?.numeroCreditoConfirmado && credit.registration.numeroCredito?.trim() || credit.folio,
    createdAt: credit.createdAt.toISOString(), fechaCredito: calendar(credit.fechaCredito),
    clienteNombre: credit.clienteNombre, clienteDocumento: credit.clienteDocumento || "", clienteTelefono: credit.clienteTelefono || "",
    clienteDireccion: credit.clienteDireccion || "", clienteFechaNacimiento: calendar(credit.clienteFechaNacimiento),
    clienteCorreo: credit.clienteCorreo || "", clienteGenero: credit.clienteGenero || "", imei: credit.imei,
    referenciaEquipo: credit.referenciaEquipo || [credit.equipoMarca, credit.equipoModelo].filter(Boolean).join(" "),
    numeroCuotas: credit.plazoMeses || 0, frecuenciaPago: getPaymentFrequencyLabel(credit.frecuenciaPago),
    valorVenta: credit.valorEquipoTotal, cuotaInicial: credit.cuotaInicial,
    creditoAutorizado: credit.saldoBaseFinanciado || Math.max(0, credit.valorEquipoTotal - credit.cuotaInicial),
    valorCuota: credit.valorCuota, ...rates, aliadoNombre: credit.aliadoNombre, sedeNombre: credit.sedeNombre,
    fechaProximoPago: pending.length ? plan.nextInstallment?.fechaVencimiento ?? null : null,
    cuotasPagadas: plan.paidCount, cuotasPendientes: plan.pendingCount, saldoObligacion: plan.saldoPendiente, ...balances,
    diasVencidos: Math.max(0, ...days),
    ultimoPago: lastPayment ? [calendar(lastPayment.fechaAbono), money.format(Number(lastPayment.valor)), lastPayment.metodoPago].filter(Boolean).join(" · ") : null,
    registroLocalHref: `/dashboard/aprobaciones?credito=${credit.id}`,
    sadmin: sadminRegistration(credit.registration),
  };
}

export async function listSadminCredits(db: Database, actor: SadminActor, input: { page?: unknown; q?: unknown; status?: unknown } = {}): Promise<SadminPage> {
  const requestedPage = input.page === null || input.page === undefined || input.page === "" ? 1 : Number(input.page);
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 100_000_000) {
    throw new CreditApprovalError("INVALID_PAGE", "Selecciona una página válida.");
  }
  const { query, status } = parseSadminFilters(input);
  return db.$transaction(async tx => {
    await assertApprovalActorActive(tx, actor);
    const counts = await countSadminCredits(tx, actor, query);
    const total = counts[status];
    const totalPages = Math.max(1, Math.ceil(total / 20));
    const page = Math.min(requestedPage, totalPages);
    const credits = await loadSadminCreditRows(tx, actor, query, status, 20, (page - 1) * 20);
    const today = new Date();
    return { items: credits.map(credit => buildSadminCreditRow(credit, today)), page, pageSize: 20, total, totalPages, counts };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}

export async function exportSadminCredits(
  db: Database,
  actor: SadminActor,
  input: { q?: unknown; status?: unknown } = {},
): Promise<{ items: SadminCreditRow[]; status: SadminStatusFilter }> {
  const { query, status } = parseSadminFilters(input);
  return db.$transaction(async tx => {
    await assertApprovalActorActive(tx, actor);
    const counts = await countSadminCredits(tx, actor, query);
    const total = counts[status];
    if (total > SADMIN_EXPORT_MAX_ROWS) {
      throw new CreditApprovalError(
        "SADMIN_EXPORT_TOO_LARGE",
        `La exportación supera ${SADMIN_EXPORT_MAX_ROWS.toLocaleString("es-CO")} registros. Usa la búsqueda o el filtro de estado para reducirla.`,
        413,
      );
    }
    const credits = total ? await loadSadminCreditRows(tx, actor, query, status, total, 0) : [];
    const today = new Date();
    return { items: credits.map(credit => buildSadminCreditRow(credit, today)), status };
  }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
}

export async function getSadminCreditSummary(
  db: Database,
  actor: SadminActor,
  rawId: unknown,
): Promise<SadminSummary> {
  if (!/^[1-9]\d*$/.test(String(rawId ?? "")) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) > 2147483647) {
    throw new CreditApprovalError("INVALID_CREDIT", "Selecciona un crédito válido.");
  }
  const id = Number(rawId);
  return db.$transaction(async tx => {
    await assertApprovalActorActive(tx, actor);
    const rows = await tx.$queryRawUnsafe<Array<{
      id: number; folio: string; canEditSadmin: boolean; registration: StoredSadminRegistration | null;
    }>>(`SELECT credit."id",credit."folio",${actorCreditScopeSql(actor, "write")} AS "canEditSadmin",
      CASE WHEN registration."creditoId" IS NULL THEN NULL ELSE to_jsonb(registration) END AS registration
      FROM "Credito" credit
      LEFT JOIN "CreditSadminRegistration" registration ON registration."creditoId"=credit."id"
      WHERE credit."id"=$1 AND ${visibleCreditSql} AND ${actorCreditScopeSql(actor)} FOR SHARE OF credit`, id);
    const credit = rows[0];
    if (!credit) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
    const sadmin = sadminRegistration(credit.registration);
    return {
      creditoId: credit.id,
      canEditSadmin: credit.canEditSadmin === true,
      folio: credit.folio,
      numeroCreditoVisible: sadmin.numeroCreditoConfirmado && sadmin.numeroCredito || credit.folio,
      registroLocalHref: `/dashboard/aprobaciones?credito=${credit.id}`,
      sadmin,
      historial: await loadSadminHistory(tx, credit.id),
    };
  }, { isolationLevel: "RepeatableRead", timeout: 15_000 });
}

function duplicateNumber(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; meta?: { code?: string } };
  return value.code === "23505" || value.code === "P2002" || value.meta?.code === "23505";
}

export async function updateSadminRegistration(db: Database, actor: SadminActor, rawId: unknown, body: unknown) {
  if (!/^[1-9]\d*$/.test(String(rawId ?? "")) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) > 2147483647) {
    throw new CreditApprovalError("INVALID_CREDIT", "Selecciona un crédito válido.");
  }
  const id = Number(rawId);
  const change = parseSadminChange(body);
  try {
    return await db.$transaction(async tx => {
      await assertApprovalActorActive(tx, actor);
      const credits = await tx.$queryRawUnsafe<Array<{ estado: string }>>(`SELECT credit."estado" FROM "Credito" credit
        WHERE credit."id"=$1 AND ${actorCreditScopeSql(actor, "write")} FOR UPDATE`, id);
      if (!credits.length || isExcludedCarteraCreditState(credits[0].estado)) {
        throw new CreditApprovalError("CREDIT_NOT_FOUND", "Este crédito ya no está disponible en Cartera.", 404);
      }
      const rows = await tx.$queryRawUnsafe<StoredSadminRegistration[]>('SELECT * FROM "CreditSadminRegistration" WHERE "creditoId"=$1 FOR UPDATE', id);
      const current = sadminRegistration(rows[0]);
      const next = applySadminChange(current, change);
      if (current.codeudorCreado === next.codeudorCreado && current.creditoCreado === next.creditoCreado &&
          current.numeroCreditoConfirmado === next.numeroCreditoConfirmado && current.numeroCredito === next.numeroCredito &&
          current.estadoCreacion === next.estadoCreacion && current.motivoEstado === next.motivoEstado) return current;
      const now = new Date();
      const completedAt = next.estado === "CREADO_SADMIN" ? current.completedAt ? new Date(current.completedAt) : now : null;
      const saved = await tx.$queryRawUnsafe<StoredSadminRegistration[]>(`INSERT INTO "CreditSadminRegistration"
        ("creditoId","version","codeudorCreado","creditoCreado","numeroCreditoConfirmado","numeroCredito","estadoCreacion","motivoEstado","completedAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT ("creditoId") DO UPDATE SET "version"=EXCLUDED."version","codeudorCreado"=EXCLUDED."codeudorCreado",
          "creditoCreado"=EXCLUDED."creditoCreado","numeroCreditoConfirmado"=EXCLUDED."numeroCreditoConfirmado",
          "numeroCredito"=EXCLUDED."numeroCredito","estadoCreacion"=EXCLUDED."estadoCreacion","motivoEstado"=EXCLUDED."motivoEstado",
          "completedAt"=EXCLUDED."completedAt","updatedAt"=EXCLUDED."updatedAt"
        RETURNING *`, id, current.version + 1, next.codeudorCreado, next.creditoCreado, next.numeroCreditoConfirmado,
        next.numeroCredito, next.estadoCreacion, next.motivoEstado, completedAt, now);
      const result = sadminRegistration(saved[0]);
      const audit = approvalActorAudit(actor);
      await tx.$executeRawUnsafe(`INSERT INTO "CreditSadminEvent"
        ("id","creditoId","version","actorKind","actorUserId","actorName","actorGrantId","actorSessionId","payload")
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9::jsonb)`,
        randomUUID(), id, result.version, audit.actorKind, audit.actorUserId, audit.actorName, audit.actorGrantId, audit.actorSessionId,
        JSON.stringify({ field: change.field, numeroCredito: result.numeroCredito,
          estadoCreacion: result.estadoCreacion, motivoEstado: result.motivoEstado, before: current, after: result }));
      return result;
    }, { timeout: 15_000 });
  } catch (error) {
    if (duplicateNumber(error)) throw new CreditApprovalError("SADMIN_NUMBER_EXISTS", "Ese número de SADMIN ya está registrado en otro crédito.", 409);
    throw error;
  }
}
