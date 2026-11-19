import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { buildCreditAccessWhere } from "@/lib/credit-route-lookup";
import { isMassImportedCredit } from "@/lib/credit-import-flags";
import prisma from "@/lib/prisma";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { splitOutstandingBalance } from "@/lib/credit-outstanding-balance";
import { hashPrincipalPayment } from "@/lib/credit-principal-payment-storage";
import { createHistoricalPlanCorrectionQuote, HistoricalPlanCorrectionError, parseHistoricalPlanCorrectionTerms } from "@/lib/credit-historical-plan-correction";
import {
  ensureHistoricalPlanCorrectionSchema, findHistoricalPlanCorrection, persistHistoricalPlanCorrection,
} from "@/lib/credit-historical-plan-correction-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
class CorrectionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const creditSelect = {
  id: true, folio: true, clienteNombre: true, clienteDocumento: true, sedeId: true,
  estado: true, pazYSalvoEmitidoAt: true, montoCredito: true, valorCuota: true,
  plazoMeses: true, frecuenciaPago: true, fechaPrimerPago: true, fechaProximoPago: true,
  saldoBaseFinanciado: true, valorEquipoTotal: true, cuotaInicial: true,
  valorFianza: true, valorInteres: true, tasaInteresEa: true,
  contratoSnapshot: true, equalityService: true, observacionAdmin: true,
  planCapitalVigente: true, updatedAt: true, amortizacion: { select: { id: true } },
} satisfies Prisma.CreditoSelect;

async function requireAccess(context: Context) {
  const user = await getSessionUser();
  if (!user) throw new CorrectionError("No autenticado", 401);
  if (!isAdminRole(user.rolNombre) || !isFinserPayCentralAlly(user.aliadoAccesoCodigo) ||
      !Number.isSafeInteger(user.id) || !String(user.nombre || "").trim()) {
    throw new CorrectionError("Solo el administrador central FINSER PAY puede corregir planes históricos.", 403);
  }
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new CorrectionError("Crédito inválido.", 400);
  return { id, user, where: { AND: [{ id }, buildCreditAccessWhere({
    admin: true, adminCentral: true, aliadoId: user.aliadoAccesoId, sedeId: user.sedeId,
  })] } satisfies Prisma.CreditoWhereInput };
}

async function loadState(db: Prisma.TransactionClient | typeof prisma, where: Prisma.CreditoWhereInput) {
  const credit = await db.credito.findFirst({ where, select: creditSelect });
  if (!credit) throw new CorrectionError("Crédito no encontrado.", 404);
  const abonos = await db.creditoAbono.findMany({
    where: { creditoId: credit.id, estado: { not: "ANULADO" } }, orderBy: { id: "asc" },
    select: { id: true, valor: true, fechaAbono: true, createdAt: true, metodoPago: true, estado: true, observacion: true },
  });
  const plan = buildCreditPaymentPlan({ ...credit, abonos,
    fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    settled: Boolean(credit.pazYSalvoEmitidoAt),
  });
  return { credit, abonos, plan };
}

function eligibility({ credit, abonos, plan }: Awaited<ReturnType<typeof loadState>>) {
  if (!isMassImportedCredit(credit) || credit.amortizacion) return "Esta corrección está limitada a créditos históricos importados sin amortización aprobada.";
  if (!credit.fechaPrimerPago || !Number.isFinite(new Date(credit.fechaPrimerPago).getTime())) return "Falta la fecha contractual histórica del primer pago. Debe documentarse antes de corregir el plan.";
  if (credit.planCapitalVigente) return "El crédito ya tiene un plan revisado; requiere una revisión independiente.";
  if (credit.pazYSalvoEmitidoAt || /ANUL|CANCEL|PAGADO|CERRADO/.test(credit.estado) || plan.saldoPendiente <= 0) return "El crédito está cerrado o no tiene saldo pendiente.";
  if (!abonos.length) return "Se requiere un historial de recibos existente para reconocer el corte de cuotas pagadas.";
  return null;
}

function errorResponse(error: unknown) {
  if (error instanceof CorrectionError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof HistoricalPlanCorrectionError) return NextResponse.json({ error: error.message }, { status: 400 });
  console.error("ERROR CORRECCION PLAN HISTORICO", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "No se pudo corregir el plan. Ningún cambio parcial fue guardado." }, { status: 500 });
}

export async function GET(_req: Request, context: Context) {
  try {
    const access = await requireAccess(context);
    await ensureCreditAbonoAuditColumns();
    const state = await loadState(prisma, access.where);
    const { credit, plan } = state;
    return NextResponse.json({ ok: true, eligible: !eligibility(state), motivo: eligibility(state),
      creditoId: credit.id, folio: credit.folio, clienteNombre: credit.clienteNombre, documento: credit.clienteDocumento,
      plazoMeses: credit.plazoMeses, frecuenciaPago: credit.frecuenciaPago, valorCuota: credit.valorCuota,
      proximaCuota: plan.nextInstallment, totalAbonado: plan.totalPaid,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request, context: Context) {
  try {
    const access = await requireAccess(context);
    const origin = req.headers.get("origin");
    const publicHost = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host");
    if (!origin || (origin !== new URL(req.url).origin && origin !== `https://${publicHost}`)) {
      throw new CorrectionError("Origen inválido.", 403);
    }
    if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new CorrectionError("La solicitud debe usar JSON.", 400);
    const raw = await req.text();
    if (raw.length > 12_000) throw new CorrectionError("Solicitud demasiado grande.", 400);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { throw new CorrectionError("Solicitud inválida.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || !["PREVISUALIZAR", "CONFIRMAR"].includes(String(body.accion))) throw new CorrectionError("Acción inválida.", 400);
    const values = parseHistoricalPlanCorrectionTerms(body);
    const confirming = body.accion === "CONFIRMAR";
    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    const providedHash = typeof body.quoteHash === "string" ? body.quoteHash : "";
    if (confirming && (!/^[A-Za-z0-9_-]{16,100}$/.test(key) || !/^[a-f0-9]{64}$/.test(providedHash))) throw new CorrectionError("Previsualiza la corrección antes de confirmarla.", 400);
    const requestHash = hashPrincipalPayment({ values, quoteHash: providedHash, usuarioId: access.user.id });
    await ensureCreditAbonoAuditColumns();
    await ensureHistoricalPlanCorrectionSchema();
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE', access.id);
      const state = await loadState(tx, access.where);
      if (confirming) {
        const prior = await findHistoricalPlanCorrection(tx, access.id, key);
        if (prior) {
          if (prior.requestHash !== requestHash) throw new CorrectionError("La confirmación ya fue usada con otros datos.", 409);
          return { ...prior.resultado, alreadyApplied: true };
        }
      }
      const reason = eligibility(state);
      if (reason) throw new CorrectionError(reason, 409);
      const pending = await tx.wompiPaymentIntent.findFirst({ where: {
        creditoId: access.id, processedAbonoId: null,
        status: { in: ["APPROVED", "APPROVED_REVIEW_REQUIRED", "APPROVED_DUPLICATE_REVIEW_REQUIRED", "AMOUNT_MISMATCH", "CHECKOUT_FALLBACK", "CREATING_NEQUI", "PENDING", "PROCESSING_APPROVED"] },
      }, select: { id: true } });
      if (pending) throw new CorrectionError("Hay un pago electrónico pendiente. Confirma su estado antes de corregir el plan.", 409);
      const { credit, abonos, plan } = state;
      const components = splitOutstandingBalance({ ...credit, totalAbonado: plan.totalPaid, saldoPendiente: plan.saldoPendiente });
      const quote = createHistoricalPlanCorrectionQuote({ ...values, abonos, planActual: plan, componentesPendientesAlCorte: components });
      const quoteHash = hashPrincipalPayment({ usuarioId: access.user.id, credit: JSON.parse(JSON.stringify(credit)), abonos, values, quote });
      if (!confirming) return { ok: true, quote, quoteHash };
      if (providedHash !== quoteHash) throw new CorrectionError("El crédito o sus recibos cambiaron. Previsualiza nuevamente antes de confirmar.", 409);
      const update = {
        montoCredito: quote.montoCreditoActualizado, plazoMeses: quote.plazoMeses,
        valorCuota: quote.valorCuota, frecuenciaPago: quote.frecuenciaPago,
        fechaPrimerPago: new Date(`${quote.fechaPrimerPago}T12:00:00.000Z`),
        fechaProximoPago: new Date(`${quote.proximaCuota.fechaVencimiento}T12:00:00.000Z`),
        planCapitalVigente: quote.planCapitalVigente as unknown as Prisma.InputJsonValue,
      };
      await tx.credito.update({ where: { id: access.id }, data: update });
      const response = { ok: true, aplicado: true, quote, quoteHash };
      await persistHistoricalPlanCorrection(tx, {
        creditoId: credit.id, usuarioId: access.user.id, nombreUsuario: access.user.nombre,
        motivo: quote.motivo, idempotencyKey: key, requestHash, previewHash: quoteHash,
        beforeSnapshot: { credit, abonos },
        afterSnapshot: { credit: { ...credit, ...update }, planCapitalVigente: quote.planCapitalVigente, quote },
        resultado: response,
      });
      return response;
    }, { isolationLevel: "Serializable", timeout: 20_000 });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
