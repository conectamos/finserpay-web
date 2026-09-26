import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { buildCreditAccessWhere } from "@/lib/credit-route-lookup";
import prisma from "@/lib/prisma";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { creditCajaConcept, creditCajaDescription, normalizePaymentMethod, sanitizeText } from "@/lib/credit-factory";
import { CapitalPaymentValidationError, createPrincipalPaymentQuote } from "@/lib/credit-principal-payment";
import { resolvePrincipalPaymentContext } from "@/lib/credit-principal-payment-context";
import { findPrincipalPaymentRevision, hashPrincipalPayment, persistPrincipalPaymentRevision } from "@/lib/credit-principal-payment-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
type PaymentBody = {
  accion: "PREVISUALIZAR" | "CONFIRMAR";
  valor: number;
  conciliacion?: Parameters<typeof createPrincipalPaymentQuote>[0]["conciliacion"];
  quoteHash?: string;
  idempotencyKey?: string;
  metodoPago?: string;
  observacion?: string;
};
class PrincipalPaymentError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const creditSelect = {
  id: true, folio: true, clienteNombre: true, sedeId: true,
  estado: true, pazYSalvoEmitidoAt: true, saldoBaseFinanciado: true,
  montoCredito: true, valorCuota: true, plazoMeses: true, frecuenciaPago: true,
  fechaPrimerPago: true, fechaProximoPago: true, planCapitalVigente: true,
  contratoSnapshot: true, observacionAdmin: true, equalityService: true,
  amortizacion: { include: { cuotas: { orderBy: { numero: "asc" } } } },
} satisfies Prisma.CreditoSelect;

async function requireAccess(context: Context) {
  const user = await getSessionUser();
  if (!user) throw new PrincipalPaymentError("No autenticado", 401);
  if (!isAdminRole(user.rolNombre) || !isFinserPayCentralAlly(user.aliadoAccesoCodigo)) {
    throw new PrincipalPaymentError("Solo el administrador central FINSER PAY puede registrar abonos a capital.", 403);
  }
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new PrincipalPaymentError("Crédito inválido.", 400);
  return {
    id, user,
    where: { AND: [{ id }, buildCreditAccessWhere({
      admin: true, adminCentral: true, aliadoId: user.aliadoAccesoId, sedeId: user.sedeId,
    })] } satisfies Prisma.CreditoWhereInput,
  };
}

async function loadState(db: Prisma.TransactionClient | typeof prisma, where: Prisma.CreditoWhereInput) {
  const credit = await db.credito.findFirst({ where, select: creditSelect });
  if (!credit) throw new PrincipalPaymentError("Crédito no encontrado.", 404);
  const abonos = await db.creditoAbono.findMany({
    where: { creditoId: credit.id, estado: { not: "ANULADO" } },
    select: { id: true, valor: true, fechaAbono: true },
    orderBy: { id: "asc" },
  });
  const plan = buildCreditPaymentPlan({
    ...credit, planCapitalVigente: credit.planCapitalVigente,
    fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    abonos, settled: Boolean(credit.pazYSalvoEmitidoAt),
  });
  return { credit, abonos, plan };
}

function handleError(error: unknown) {
  if (error instanceof PrincipalPaymentError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof CapitalPaymentValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
  // Do not print raw database errors: query parameters may contain financial or identity data.
  console.error("ERROR ABONO EXTRAORDINARIO A CAPITAL", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "No se pudo procesar el abono a capital. Ningún cambio parcial fue registrado." }, { status: 500 });
}

export async function GET(_req: Request, context: Context) {
  try {
    const access = await requireAccess(context);
    const { credit, plan } = await loadState(prisma, access.where);
    const financialContext = resolvePrincipalPaymentContext({ credit, plan });
    return NextResponse.json({
      ok: true, creditoId: credit.id, folio: credit.folio, cuotaHabitual: credit.valorCuota,
      saldoPendiente: plan.saldoPendiente, proximaCuota: plan.nextInstallment,
      requiereConciliacion: financialContext.requiereConciliacion,
      modoConciliacion: financialContext.modoConciliacion,
      motivoConciliacion: financialContext.motivoConciliacion,
      capitalPendiente: financialContext.capitalPendiente,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return handleError(error); }
}

export async function POST(req: Request, context: Context) {
  try {
    const access = await requireAccess(context);
    if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new PrincipalPaymentError("La solicitud debe usar JSON.", 400);
    }
    let body: PaymentBody;
    try { body = await req.json() as PaymentBody; }
    catch { throw new PrincipalPaymentError("Solicitud inválida.", 400); }
    if (!body || !["PREVISUALIZAR", "CONFIRMAR"].includes(body.accion)) throw new PrincipalPaymentError("Acción inválida.", 400);
    if (typeof body.valor !== "number" || !Number.isFinite(body.valor) || body.valor <= 0) throw new PrincipalPaymentError("Indica un valor de capital válido.", 400);
    const confirming = body.accion === "CONFIRMAR";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    const providedHash = typeof body.quoteHash === "string" ? body.quoteHash : "";
    if (confirming && (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey) || !/^[a-f0-9]{64}$/.test(providedHash))) {
      throw new PrincipalPaymentError("Previsualiza el abono antes de confirmarlo.", 400);
    }
    const metodoPago = normalizePaymentMethod(body.metodoPago);
    const observacion = sanitizeText(body.observacion).slice(0, 2000);
    const requestValues = { valor: body.valor, conciliacion: body.conciliacion ?? null, metodoPago, observacion };
    const requestHash = hashPrincipalPayment({ ...requestValues, quoteHash: providedHash, usuarioId: access.user.id });
    await ensureCreditAbonoAuditColumns();

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Credito" WHERE "id"=${access.id} FOR UPDATE`;
      // Scoped read precedes idempotent replay: a successful retry never authorizes another credit.
      const state = await loadState(tx, access.where);
      if (confirming) {
        const existing = await findPrincipalPaymentRevision(tx, access.id, idempotencyKey);
        if (existing) {
          if (existing.requestHash !== requestHash) throw new PrincipalPaymentError("La clave de confirmación ya se usó con otros datos.", 409);
          return { ...existing.resultado, alreadyApplied: true };
        }
      }
      const { credit, abonos, plan } = state;
      if (credit.planCapitalVigente && body.conciliacion !== undefined && body.conciliacion !== null) {
        throw new PrincipalPaymentError("El crédito ya tiene una conciliación vigente. Los siguientes abonos conservan esos términos; omite la nueva conciliación.", 400);
      }
      if (credit.estado === "ANULADO" || credit.pazYSalvoEmitidoAt || plan.saldoPendiente <= 0) {
        throw new PrincipalPaymentError("Este crédito está finalizado o no permite nuevos recaudos.", 409);
      }
      if (plan.overdueCount > 0) throw new PrincipalPaymentError("Primero paga las cuotas vencidas; el abono a capital no reemplaza esas cuotas.", 409);
      const pending = await tx.wompiPaymentIntent.findFirst({
        where: { creditoId: credit.id, status: "PENDING", processedAbonoId: null }, select: { id: true },
      });
      if (pending) throw new PrincipalPaymentError("Hay un pago electrónico pendiente. Confirma su estado antes de modificar el plan.", 409);
      // Resolve from persisted origination terms under the same credit lock as the
      // payment. The browser cannot choose or replace the automatic reconciliation.
      const financialContext = resolvePrincipalPaymentContext({ credit, plan });
      if (financialContext.modoConciliacion === "AUTOMATICA" && body.conciliacion != null) {
        throw new PrincipalPaymentError("Este crédito utiliza su amortización original. Actualiza el formulario y omite la conciliación manual.", 409);
      }
      if (financialContext.requiereConciliacion && body.conciliacion == null) {
        throw new PrincipalPaymentError(financialContext.motivoConciliacion || "Este crédito requiere conciliación documentada. Actualiza el formulario.", 400);
      }
      const quote = createPrincipalPaymentQuote({
        plan, planCapitalVigente: credit.planCapitalVigente,
        conciliacion: financialContext.modoConciliacion === "AUTOMATICA" ? financialContext.conciliacion : body.conciliacion,
        valor: body.valor,
        capitalOriginal: Number(credit.saldoBaseFinanciado),
        cuotaHabitual: Math.round(Number(credit.valorCuota) * 100) / 100,
        abonos: abonos.map(({ id, valor }) => ({ id, valor })),
      });
      const quoteHash = hashPrincipalPayment({
        creditoId: credit.id, usuarioId: access.user.id,
        // Prisma Decimal instances serialize to exact decimal strings, not their
        // internal implementation fields. Bind every persisted source to preview.
        financiero: JSON.parse(JSON.stringify(credit)), abonos, request: requestValues, quote,
      });
      if (!confirming) return { ok: true, quote, quoteHash };
      if (providedHash !== quoteHash) throw new PrincipalPaymentError("El crédito o el abono cambió. Previsualiza nuevamente antes de confirmar.", 409);

      const paymentObservation = ["ABONO EXTRAORDINARIO A CAPITAL - REDUCCIÓN DE PLAZO", observacion].filter(Boolean).join(" | ");
      const payment = await tx.creditoAbono.create({ data: {
        creditoId: credit.id, usuarioId: access.user.id, sedeId: access.user.sedeId,
        valor: quote.abonoCapital, metodoPago, observacion: paymentObservation,
      } });
      const snapshot = {
        ...quote.planCapitalVigente,
        abonosAlCorte: [...quote.planCapitalVigente.abonosAlCorte, { id: payment.id, valor: quote.abonoCapital }],
      };
      const nextPlan = buildCreditPaymentPlan({
        ...credit, montoCredito: quote.montoCreditoActualizado,
        planCapitalVigente: snapshot, fechaProximoPago: null,
        abonos: [...abonos, { id: payment.id, valor: quote.abonoCapital, fechaAbono: payment.fechaAbono }],
      });
      await tx.credito.update({ where: { id: credit.id }, data: {
        planCapitalVigente: snapshot as unknown as Prisma.InputJsonValue,
        montoCredito: quote.montoCreditoActualizado,
        fechaProximoPago: nextPlan.nextInstallment ? new Date(`${nextPlan.nextInstallment.fechaVencimiento}T12:00:00.000Z`) : null,
      } });
      await tx.cajaMovimiento.create({ data: {
        tipo: "INGRESO", concepto: creditCajaConcept(metodoPago), valor: quote.abonoCapital,
        sedeId: access.user.sedeId,
        descripcion: creditCajaDescription({
          id: payment.id, creditoFolio: credit.folio, clienteNombre: credit.clienteNombre,
          metodoPago, observacion: paymentObservation,
        }),
      } });
      const response = {
        ok: true, quote: { ...quote, planCapitalVigente: snapshot }, quoteHash,
        abonoId: payment.id, item: {
          id: payment.id, creditoId: payment.creditoId, valor: payment.valor,
          metodoPago: payment.metodoPago, fechaAbono: payment.fechaAbono.toISOString(),
          observacion: payment.observacion,
        },
      };
      await persistPrincipalPaymentRevision(tx, {
        creditoId: credit.id, abonoId: payment.id, revision: snapshot.revision,
        idempotencyKey, requestHash, previewHash: quoteHash,
        snapshotBefore: credit.planCapitalVigente,
        snapshotAfter: snapshot, conciliacion: snapshot.parametros,
        resultado: response, usuarioId: access.user.id,
      });
      return response;
    }, { timeout: 20_000 });
    return NextResponse.json(result);
  } catch (error) { return handleError(error); }
}
