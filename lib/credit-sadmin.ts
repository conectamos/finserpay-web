import "server-only";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/app/generated/prisma/client";
import { assertApprovalActorActive, approvalActorAudit, type ApprovalActor } from "@/lib/credit-approval-actor";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { getPaymentFrequencyLabel } from "@/lib/credit-factory";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { splitOutstandingBalance } from "@/lib/credit-outstanding-balance";
import { calendarDateKey, getColombiaDateParts } from "@/lib/colombia-date";
import { isExcludedCarteraCreditState, resolveCarteraExportRates } from "@/lib/cartera-export";
import { applySadminChange, parseSadminChange, sadminRegistration, type StoredSadminRegistration } from "@/lib/credit-sadmin-state";
import type { SadminCreditRow, SadminPage, SadminStatusFilter } from "@/lib/credit-sadmin-types";

type Database = Pick<PrismaClient, "$transaction">;
type Payment = { fechaAbono: string; metodoPago: string | null; valor: number };
type CreditRow = {
  id: number; folio: string; createdAt: Date; fechaCredito: Date;
  clienteNombre: string; clienteDocumento: string | null; clienteTelefono: string | null;
  clienteDireccion: string | null; clienteFechaNacimiento: Date | null; clienteCorreo: string | null; clienteGenero: string | null;
  imei: string; referenciaEquipo: string | null; equipoMarca: string | null; equipoModelo: string | null;
  plazoMeses: number | null; frecuenciaPago: string; valorEquipoTotal: number; cuotaInicial: number;
  saldoBaseFinanciado: number; valorCuota: number; montoCredito: number; valorFianza: number; valorInteres: number;
  tasaInteresEa: number; fianzaPorcentaje: number; contratoSnapshot: unknown;
  amortizacion: { tasaInteresEaPorcentaje: number; fianzaCuotaPorcentaje: number; seguroCuotaPorcentaje: number; numeroCuotas: number } | null;
  aliadoNombre: string; sedeNombre: string; fechaPrimerPago: Date | null; fechaProximoPago: Date | null;
  pazYSalvoEmitidoAt: Date | null; abonos: Payment[]; registration: StoredSadminRegistration | null;
};

// SADMIN intentionally covers the complete historical cartera, as requested.
// Its separate registration never changes credit or approval state.
const visibleCreditSql = `UPPER(BTRIM(COALESCE(credit."estado",''))) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')`;
const searchSql = `($1::text IS NULL OR
  strpos(lower(COALESCE(credit."clienteNombre",'')),lower($1))>0 OR
  strpos(lower(COALESCE(credit."clienteDocumento",'')),lower($1))>0 OR
  strpos(lower(COALESCE(credit."folio",'')),lower($1))>0 OR
  strpos(lower(COALESCE(ally."nombre",'')),lower($1))>0 OR
  strpos(lower(COALESCE(registration."numeroCredito",'')),lower($1))>0)`;
const createdSadminSql = `(registration."codeudorCreado" IS TRUE
  AND registration."creditoCreado" IS TRUE
  AND registration."numeroCreditoConfirmado" IS TRUE
  AND NULLIF(BTRIM(COALESCE(registration."numeroCredito",'')),'') IS NOT NULL)`;
const statusSql = `($2::text='all'
  OR ($2::text='pending' AND NOT ${createdSadminSql})
  OR ($2::text='created' AND ${createdSadminSql}))`;
const baseSql = `FROM "Credito" credit
  JOIN "Sede" site ON site."id"=credit."sedeId"
  JOIN "Aliado" ally ON ally."id"=site."aliadoId"
  LEFT JOIN "CreditSadminRegistration" registration ON registration."creditoId"=credit."id"
  WHERE ${visibleCreditSql} AND ${searchSql}`;

function parseSadminStatus(value: unknown): SadminStatusFilter {
  if (value === null || value === undefined || value === "") return "all";
  if (value === "all" || value === "pending" || value === "created") return value;
  throw new CreditApprovalError("INVALID_SADMIN_STATUS", "Selecciona un estado SADMIN v\u00e1lido.");
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}
function calendar(value: Date | string | null) { return iso(value)?.slice(0, 10) ?? null; }
const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });

export function buildSadminCreditRow(credit: CreditRow, today = new Date()): SadminCreditRow {
  const plan = buildCreditPaymentPlan({
    montoCredito: credit.montoCredito, valorCuota: credit.valorCuota, plazoMeses: credit.plazoMeses,
    frecuenciaPago: credit.frecuenciaPago, fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    fechaProximoPago: credit.fechaProximoPago, abonos: credit.abonos, today, settled: Boolean(credit.pazYSalvoEmitidoAt),
  });
  const balances = splitOutstandingBalance({ ...credit, saldoPendiente: plan.saldoPendiente });
  const rates = resolveCarteraExportRates(credit);
  const todayKey = calendarDateKey(getColombiaDateParts(today));
  const pending = plan.installments.filter(item => item.saldoPendiente > 0);
  const days = pending.map(item => Math.floor((Date.parse(todayKey) - Date.parse(item.fechaVencimiento)) / 86_400_000));
  const lastPayment = credit.abonos.at(-1);
  return {
    id: credit.id, folio: credit.folio,
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
    sadmin: sadminRegistration(credit.registration),
  };
}

export async function listSadminCredits(db: Database, actor: ApprovalActor, input: { page?: unknown; q?: unknown; status?: unknown } = {}): Promise<SadminPage> {
  const requestedPage = input.page === null || input.page === undefined || input.page === "" ? 1 : Number(input.page);
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 100_000_000) {
    throw new CreditApprovalError("INVALID_PAGE", "Selecciona una página válida.");
  }
  if (input.q != null && (typeof input.q !== "string" || input.q.length > 100 || /[\u0000-\u001f\u007f]/.test(input.q))) {
    throw new CreditApprovalError("INVALID_SEARCH", "La búsqueda admite hasta 100 caracteres.");
  }
  const query = typeof input.q === "string" ? input.q.trim() || null : null;
  const status = parseSadminStatus(input.status);
  return db.$transaction(async tx => {
    await assertApprovalActorActive(tx, actor);
    const countRows = await tx.$queryRawUnsafe<Array<SadminPage["counts"]>>(`SELECT
      COUNT(*)::integer AS "all",
      (COUNT(*) FILTER (WHERE NOT ${createdSadminSql}))::integer AS "pending",
      (COUNT(*) FILTER (WHERE ${createdSadminSql}))::integer AS "created"
      ${baseSql}`, query);
    const counts = countRows[0] ?? { all: 0, pending: 0, created: 0 };
    const total = counts[status];
    const totalPages = Math.max(1, Math.ceil(total / 20));
    const page = Math.min(requestedPage, totalPages);
    const credits = await tx.$queryRawUnsafe<CreditRow[]>(`WITH selected AS (
      SELECT credit."id" ${baseSql} AND ${statusSql}
      ORDER BY credit."fechaCredito" DESC,credit."id" DESC LIMIT 20 OFFSET $3::integer
    ) SELECT credit."id",credit."folio",credit."createdAt",credit."fechaCredito",
      credit."clienteNombre",credit."clienteDocumento",credit."clienteTelefono",credit."clienteDireccion",
      credit."clienteFechaNacimiento",credit."clienteCorreo",credit."clienteGenero",credit."imei",
      credit."referenciaEquipo",credit."equipoMarca",credit."equipoModelo",credit."plazoMeses",credit."frecuenciaPago",
      credit."valorEquipoTotal",credit."cuotaInicial",credit."saldoBaseFinanciado",credit."valorCuota",credit."montoCredito",
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
      ORDER BY credit."fechaCredito" DESC,credit."id" DESC`, query, status, (page - 1) * 20);
    const today = new Date();
    return { items: credits.map(credit => buildSadminCreditRow(credit, today)), page, pageSize: 20, total, totalPages, counts };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}

function duplicateNumber(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; meta?: { code?: string } };
  return value.code === "23505" || value.code === "P2002" || value.meta?.code === "23505";
}

export async function updateSadminRegistration(db: Database, actor: ApprovalActor, rawId: unknown, body: unknown) {
  if (!/^[1-9]\d*$/.test(String(rawId ?? "")) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) > 2147483647) {
    throw new CreditApprovalError("INVALID_CREDIT", "Selecciona un crédito válido.");
  }
  const id = Number(rawId);
  const change = parseSadminChange(body);
  try {
    return await db.$transaction(async tx => {
      await assertApprovalActorActive(tx, actor);
      const credits = await tx.$queryRawUnsafe<Array<{ estado: string }>>('SELECT "estado" FROM "Credito" WHERE "id"=$1 FOR UPDATE', id);
      if (!credits.length || isExcludedCarteraCreditState(credits[0].estado)) {
        throw new CreditApprovalError("CREDIT_NOT_FOUND", "Este crédito ya no está disponible en Cartera.", 404);
      }
      const rows = await tx.$queryRawUnsafe<StoredSadminRegistration[]>('SELECT * FROM "CreditSadminRegistration" WHERE "creditoId"=$1 FOR UPDATE', id);
      const current = sadminRegistration(rows[0]);
      const next = applySadminChange(current, change);
      if (current.codeudorCreado === next.codeudorCreado && current.creditoCreado === next.creditoCreado &&
          current.numeroCreditoConfirmado === next.numeroCreditoConfirmado && current.numeroCredito === next.numeroCredito) return current;
      const now = new Date();
      const completedAt = next.estado === "CREADO_SADMIN" ? current.completedAt ? new Date(current.completedAt) : now : null;
      const saved = await tx.$queryRawUnsafe<StoredSadminRegistration[]>(`INSERT INTO "CreditSadminRegistration"
        ("creditoId","version","codeudorCreado","creditoCreado","numeroCreditoConfirmado","numeroCredito","completedAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT ("creditoId") DO UPDATE SET "version"=EXCLUDED."version","codeudorCreado"=EXCLUDED."codeudorCreado",
          "creditoCreado"=EXCLUDED."creditoCreado","numeroCreditoConfirmado"=EXCLUDED."numeroCreditoConfirmado",
          "numeroCredito"=EXCLUDED."numeroCredito","completedAt"=EXCLUDED."completedAt","updatedAt"=EXCLUDED."updatedAt"
        RETURNING *`, id, current.version + 1, next.codeudorCreado, next.creditoCreado, next.numeroCreditoConfirmado, next.numeroCredito, completedAt, now);
      const result = sadminRegistration(saved[0]);
      const audit = approvalActorAudit(actor);
      await tx.$executeRawUnsafe(`INSERT INTO "CreditSadminEvent"
        ("id","creditoId","version","actorKind","actorUserId","actorName","actorGrantId","actorSessionId","payload")
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9::jsonb)`,
        randomUUID(), id, result.version, audit.actorKind, audit.actorUserId, audit.actorName, audit.actorGrantId, audit.actorSessionId,
        JSON.stringify({ field: change.field, before: current, after: result }));
      return result;
    }, { timeout: 15_000 });
  } catch (error) {
    if (duplicateNumber(error)) throw new CreditApprovalError("SADMIN_NUMBER_EXISTS", "Ese número de SADMIN ya está registrado en otro crédito.", 409);
    throw error;
  }
}
