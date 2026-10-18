import { NextResponse } from "next/server";
import { readMassCreditComponents } from "@/lib/mass-credit-financial-components";
import { resolveCreditSellerDisplay } from "@/lib/credit-assigned-seller";
import { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import {
  CREDIT_ABONO_CAJA_MARKER,
  calculateCreditCharges,
  extendDays,
  extendFromNow,
  generatePaymentReference,
  getDefaultFirstPaymentDateObject,
  getPaymentFrequencyLabel,
  MAX_CREDIT_INSTALLMENTS,
  PAYMENT_FREQUENCY_OPTIONS,
  normalizeCreditInstallments,
  normalizePaymentFrequency,
  resolveCreditPaymentSummary,
  resolveCreditState,
  sanitizeText,
  toNullableDate,
  type CreditAdminCommand,
} from "@/lib/credit-factory";
import {
  getEqualityDeviceMeta,
  getPayloadSummary,
} from "@/lib/equality-device-meta";
import {
  isEqualityApiError,
  lockEqualityDevice,
  queryEqualityDevices,
  unlockEqualityDevice,
} from "@/lib/equality-zero-touch";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { extractCreditFactorySnapshotDetails } from "@/lib/credit-factory-snapshot";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { buildMoraLockMessage } from "@/lib/credit-lock-message";
import { getCreditAmortizationByCreditId, hasCreditAmortization } from "@/lib/credit-amortization-storage";
import {
  createAdministrativeAmortization,
  ensureCreditPlanRevisionSchema,
  getLatestCreditPlanAmortization,
  insertCreditPlanRevision,
} from "@/lib/credit-plan-revision";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isMassImportedCredit } from "@/lib/credit-import-flags";
import {
  lockAllyPaymentAlly,
  registerPaidCreditAnnulmentAdjustment,
  resolvePaidCreditAllyId,
} from "@/lib/ally-payment-annulments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CommandBody = {
  command?: CreditAdminCommand;
  fechaProximoPago?: string;
  fechaPrimerPago?: string;
  frecuenciaPago?: string;
  observacionAdmin?: string;
  plazoMeses?: number | string;
  expectedUpdatedAt?: string;
};

class CreditPlanAdjustmentError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const SUPERVISOR_COMMANDS: CreditAdminCommand[] = [
  "consult-device",
  "payment-reference",
  "toggle-stolen-lock",
  "toggle-mora-lock",
  "remove-lock",
];
const DEVICE_CONTROL_COMMANDS = new Set<CreditAdminCommand>([
  "consult-device",
  "extend-1h",
  "extend-24h",
  "extend-48h",
  "remove-lock",
  "toggle-mora-lock",
  "toggle-stolen-lock",
  "warranty-15d",
  "warranty-20d",
]);

function parseId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

type PaymentSummary = {
  abonosCount: number;
  totalAbonado: number;
  ultimoAbonoAt: Date | null;
};

const CREDIT_DELIVERY_PHOTO_OMIT = {
  iphoneSelfieCedulaDataUrl: true,
  fotoEntregaDataUrl: true,
  fotoRemisionDataUrl: true,
} as const;

type SerializedCreditSource = Prisma.CreditoGetPayload<{
  omit: typeof CREDIT_DELIVERY_PHOTO_OMIT;
  include: {
    usuario: {
      select: {
        id: true;
        nombre: true;
        usuario: true;
      };
    };
    vendedor: {
      select: {
        id: true;
        nombre: true;
        documento: true;
      };
    };
    sede: {
      select: {
        id: true;
        nombre: true;
        aliadoId: true;
      };
    };
  };
}>;

function extractFamilyReferences(snapshot: unknown) {
  if (typeof snapshot !== "object" || snapshot === null) {
    return [];
  }

  const root = snapshot as Record<string, unknown>;
  const cliente =
    typeof root.cliente === "object" && root.cliente !== null
      ? (root.cliente as Record<string, unknown>)
      : null;
  const references = Array.isArray(cliente?.referenciasFamiliares)
    ? cliente.referenciasFamiliares
    : [];

  return references
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return null;
      }

      const record = item as Record<string, unknown>;

      return {
        nombre: typeof record.nombre === "string" ? record.nombre : "",
        parentesco:
          typeof record.parentesco === "string" ? record.parentesco : "",
        telefono: typeof record.telefono === "string" ? record.telefono : "",
      };
    })
    .filter(
      (item): item is { nombre: string; parentesco: string; telefono: string } =>
        Boolean(item?.nombre || item?.parentesco || item?.telefono)
    );
}

function serializeCredit(
  item: SerializedCreditSource,
  payment?: PaymentSummary,
  canViewSensitive = false
) {
  const summary = resolveCreditPaymentSummary({
    montoCredito: item.montoCredito,
    cuotaInicial: item.cuotaInicial,
    totalAbonado: Number(payment?.totalAbonado || 0),
    abonosCount: Number(payment?.abonosCount || 0),
  });
  const paymentPlan = buildCreditPaymentPlan({
    planCapitalVigente: item.planCapitalVigente,
    montoCredito: Number(item.montoCredito || 0),
    valorCuota: Number(item.valorCuota || 0),
    plazoMeses: Number(item.plazoMeses || 1),
    frecuenciaPago: item.frecuenciaPago,
    fechaPrimerPago: item.fechaPrimerPago || item.fechaProximoPago,
    fechaProximoPago: item.fechaProximoPago,
    abonos: summary.totalAbonado > 0 ? [{ valor: summary.totalAbonado }] : [],
    settled: Boolean(item.pazYSalvoEmitidoAt),
  });
  const factorySnapshotDetails = extractCreditFactorySnapshotDetails(
    item.contratoSnapshot,
    { imei: item.imei, deviceUid: item.deviceUid }
  );

  const massComponents = readMassCreditComponents(item.contratoSnapshot, item);

  return {
    ...(massComponents ? { valorSeguro: massComponents.seguro, seguroCuotaPorcentaje: massComponents.seguroCuotaPorcentaje } : {}),
    id: item.id,
    folio: item.folio,
    clienteNombre: item.clienteNombre,
    clientePrimerNombre: item.clientePrimerNombre,
    clientePrimerApellido: item.clientePrimerApellido,
    clienteTipoDocumento: item.clienteTipoDocumento,
    clienteDireccion: item.clienteDireccion,
    clienteDocumento: item.clienteDocumento,
    clienteFechaNacimiento: item.clienteFechaNacimiento?.toISOString() || null,
    clienteFechaExpedicion: item.clienteFechaExpedicion?.toISOString() || null,
    clienteTelefono: item.clienteTelefono,
    clienteCorreo: item.clienteCorreo,
    clienteDepartamento: item.clienteDepartamento,
    clienteCiudad: item.clienteCiudad,
    clienteGenero: item.clienteGenero,
    clienteEstadoCivil: canViewSensitive
      ? factorySnapshotDetails.clienteEstadoCivil
      : null,
    clienteEstrato: canViewSensitive
      ? factorySnapshotDetails.clienteEstrato
      : null,
    imei: item.imei,
    deviceUid: item.deviceUid,
    referenciaEquipo: item.referenciaEquipo,
    equipoMarca: item.equipoMarca,
    equipoModelo: item.equipoModelo,
    plataformaDispositivo:
      factorySnapshotDetails.paso2.plataformaDispositivo,
    resumenFabrica: {
      paso2: factorySnapshotDetails.paso2,
    },
    valorEquipoTotal: item.valorEquipoTotal,
    saldoBaseFinanciado: item.saldoBaseFinanciado,
    montoCredito: item.montoCredito,
    cuotaInicial: item.cuotaInicial,
    plazoMeses: item.plazoMeses,
    frecuenciaPago: item.frecuenciaPago,
    tasaInteresEa: item.tasaInteresEa,
    valorInteres: item.valorInteres,
    fianzaPorcentaje: item.fianzaPorcentaje,
    valorFianza: item.valorFianza,
    valorCuota: item.valorCuota,
    fechaCredito: item.fechaCredito.toISOString(),
    fechaPrimerPago: item.fechaPrimerPago?.toISOString() || null,
    fechaProximoPago: item.fechaProximoPago?.toISOString() || null,
    referenciaPago: item.referenciaPago,
    estado: item.estado,
    deliverableLabel: item.deliverableLabel,
    deliverableReady: item.deliverableReady,
    equalityState: item.equalityState,
    equalityService: item.equalityService,
    equalityPayload: item.equalityPayload,
    equalityLastCheckAt: item.equalityLastCheckAt?.toISOString() || null,
    graceUntil: item.graceUntil?.toISOString() || null,
    warrantyUntil: item.warrantyUntil?.toISOString() || null,
    bloqueoRobo: item.bloqueoRobo,
    bloqueoRoboAt: item.bloqueoRoboAt?.toISOString() || null,
    bloqueoMora: item.bloqueoMora,
    bloqueoMoraAt: item.bloqueoMoraAt?.toISOString() || null,
    pazYSalvoEmitidoAt: item.pazYSalvoEmitidoAt?.toISOString() || null,
    observacionAdmin: item.observacionAdmin,
    contratoAceptadoAt: item.contratoAceptadoAt?.toISOString() || null,
    pagareAceptadoAt: item.pagareAceptadoAt?.toISOString() || null,
    contratoIp: item.contratoIp,
    contratoFotoDataUrl: item.contratoFotoDataUrl,
    contratoSelfieDataUrl: item.contratoSelfieDataUrl,
    contratoListo: Boolean(
      item.contratoAceptadoAt &&
        item.contratoFirmaDataUrl &&
        (item.contratoSelfieDataUrl || item.contratoFotoDataUrl) &&
        item.contratoCedulaFrenteDataUrl &&
        item.contratoCedulaRespaldoDataUrl
    ),
    contratoSelfieLista: Boolean(item.contratoSelfieDataUrl || item.contratoFotoDataUrl),
    contratoCedulaLista: Boolean(
      item.contratoCedulaFrenteDataUrl && item.contratoCedulaRespaldoDataUrl
    ),
    contratoOtpCanal: item.contratoOtpCanal,
    contratoOtpDestino: item.contratoOtpDestino,
    contratoOtpVerificadoAt: item.contratoOtpVerificadoAt?.toISOString() || null,
    referenciasFamiliares: extractFamilyReferences(item.contratoSnapshot),
    totalAbonado: summary.totalAbonado,
    saldoPendiente: summary.saldoPendiente,
    totalRecaudado: summary.totalRecaudado,
    porcentajeRecaudado: summary.porcentajeRecaudado,
    estadoPago: paymentPlan.estadoPago,
    cuotasPagadas: paymentPlan.paidCount,
    cuotasPendientes: paymentPlan.pendingCount,
    cuotasEnMora: paymentPlan.overdueCount,
    abonosCount: summary.abonosCount,
    ultimoAbonoAt: payment?.ultimoAbonoAt?.toISOString() || null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    usuario: resolveCreditSellerDisplay(item),
    vendedor: item.vendedor
      ? {
          id: item.vendedor.id,
          nombre: item.vendedor.nombre,
          documento: item.vendedor.documento,
        }
      : null,
    sede: {
      id: item.sede.id,
      nombre: item.sede.nombre,
    },
  };
}

async function loadCredit(
  id: number,
  transaction?: Prisma.TransactionClient
) {
  const args = {
    where: { id },
    omit: CREDIT_DELIVERY_PHOTO_OMIT,
    include: {
      usuario: {
        select: {
          id: true,
          nombre: true,
          usuario: true,
        },
      },
      vendedor: {
        select: {
          id: true,
          nombre: true,
          documento: true,
        },
      },
      sede: {
        select: {
          id: true,
          nombre: true,
          aliadoId: true,
        },
      },
    },
  } satisfies Prisma.CreditoFindUniqueArgs;

  return transaction
    ? transaction.credito.findUnique(args)
    : prisma.credito.findUnique(args);
}

async function loadPaymentSummary(creditId: number) {
  await ensureCreditAbonoAuditColumns();

  const grouped = await prisma.creditoAbono.groupBy({
    by: ["creditoId"],
    where: {
      creditoId: creditId,
      estado: {
        not: "ANULADO",
      },
    },
    _count: {
      _all: true,
    },
    _sum: {
      valor: true,
    },
    _max: {
      fechaAbono: true,
    },
  });

  const current = grouped[0];

  return {
    abonosCount: current?._count._all || 0,
    totalAbonado: Number(current?._sum.valor || 0),
    ultimoAbonoAt: current?._max.fechaAbono || null,
  };
}

/** Administrative revisions never replace the signed amortization or its documents. */
async function adjustCentralAmortizedPlan(
  creditId: number,
  body: CommandBody,
  user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>
) {
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || !String(user.nombre || "").trim()) {
    throw new CreditPlanAdjustmentError(403, "No se pudo verificar el administrador responsable del ajuste.");
  }
  const installments = Number(body.plazoMeses);
  const frequency = String(body.frecuenciaPago || "").trim().toUpperCase();
  const firstPayment = String(body.fechaPrimerPago || "").trim();
  const reason = String(body.observacionAdmin || "").trim();
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(firstPayment)
    ? new Date(`${firstPayment}T12:00:00.000Z`) : null;
  if (!(typeof body.plazoMeses === "number" || (typeof body.plazoMeses === "string" && /^\d+$/.test(body.plazoMeses))) ||
      !Number.isSafeInteger(installments) || installments < 1 || installments > MAX_CREDIT_INSTALLMENTS) {
    throw new CreditPlanAdjustmentError(400, `Indica entre 1 y ${MAX_CREDIT_INSTALLMENTS} cuotas enteras.`);
  }
  if (!PAYMENT_FREQUENCY_OPTIONS.some(option => option.value === frequency)) {
    throw new CreditPlanAdjustmentError(400, "Selecciona una frecuencia de pago válida.");
  }
  if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== firstPayment) {
    throw new CreditPlanAdjustmentError(400, "Indica una fecha válida para el primer pago.");
  }
  if (reason.length < 10 || reason.length > 1000) {
    throw new CreditPlanAdjustmentError(400, "Indica el motivo del ajuste del plan (10 a 1000 caracteres).");
  }
  if (!body.expectedUpdatedAt || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) {
    throw new CreditPlanAdjustmentError(409, "Consulta nuevamente el crédito antes de ajustar su plan.");
  }

  await ensureCreditPlanRevisionSchema();
  await ensureCreditAbonoAuditColumns();
  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT "id" FROM public."Credito" WHERE "id" = $1 FOR UPDATE', creditId);
    const current = await loadCredit(creditId, tx);
    if (!current) throw new CreditPlanAdjustmentError(404, "Crédito no encontrado.");
    if (current.updatedAt.toISOString() !== new Date(body.expectedUpdatedAt!).toISOString()) {
      throw new CreditPlanAdjustmentError(409, "El crédito cambió. Actualiza el expediente y revisa el plan antes de confirmar nuevamente.");
    }
    if (current.planCapitalVigente) {
      throw new CreditPlanAdjustmentError(409, "El plan reducido por abono a capital requiere una revisión financiera específica.");
    }
    if (current.pazYSalvoEmitidoAt || /ANUL|CANCEL/.test(current.estado)) {
      throw new CreditPlanAdjustmentError(409, "Este crédito está cerrado o anulado y no admite ajustes de plan.");
    }
    const original = await getCreditAmortizationByCreditId(creditId, tx);
    if (!original) throw new CreditPlanAdjustmentError(409, "No se encontró la amortización aprobada. Actualiza el expediente.");
    const source = await getLatestCreditPlanAmortization(creditId, tx) || original;
    const calendarOnly = installments === current.plazoMeses && frequency === current.frecuenciaPago;
    let amortization;
    try {
      amortization = createAdministrativeAmortization(source, {
        numeroCuotas: installments, frecuenciaPago: frequency, fechaPrimerPago: firstPayment,
      });
    } catch (error) {
      throw new CreditPlanAdjustmentError(409, error instanceof Error ? error.message : "No se pudo verificar el plan financiero guardado.");
    }
    const abonos = await tx.creditoAbono.findMany({
      where: { creditoId: creditId, estado: { not: "ANULADO" } },
      select: { valor: true, fechaAbono: true }, orderBy: { fechaAbono: "asc" },
    });
    const currentPlan = buildCreditPaymentPlan({ ...current, abonos });
    if (currentPlan.saldoPendiente <= 0) {
      throw new CreditPlanAdjustmentError(409, "Este crédito ya está pagado y no admite ajustes de plan.");
    }
    const pendingPayment = await tx.wompiPaymentIntent.findFirst({
      where: {
        creditoId: creditId, processedAbonoId: null,
        status: { in: ["APPROVED", "APPROVED_REVIEW_REQUIRED", "APPROVED_DUPLICATE_REVIEW_REQUIRED", "AMOUNT_MISMATCH", "CHECKOUT_FALLBACK", "CREATING_NEQUI", "PENDING", "PROCESSING_APPROVED"] },
      }, select: { id: true },
    });
    if (pendingPayment) {
      throw new CreditPlanAdjustmentError(409, "Hay un pago electrónico pendiente. Confirma su estado antes de modificar el plan.");
    }
    const amount = calendarOnly ? current.montoCredito : Number(amortization.totalPagar);
    const quota = calendarOnly ? current.valorCuota : Number(
      amortization.calculoVersion === "ARES_FRANCES_V2" ? amortization.cuotaComercial : amortization.cuotaTotalExacta
    );
    const totalPaid = abonos.reduce((sum, item) => sum + Number(item.valor || 0), 0);
    if (totalPaid >= amount - 0.005) {
      throw new CreditPlanAdjustmentError(409, "El plan propuesto no tiene saldo pendiente. Revisa los abonos y el plazo antes de ajustar.");
    }
    const plan = buildCreditPaymentPlan({
      montoCredito: amount, valorCuota: quota, plazoMeses: installments,
      frecuenciaPago: frequency, fechaPrimerPago: parsedDate, abonos,
    });
    const data = {
      plazoMeses: installments, frecuenciaPago: frequency, fechaPrimerPago: parsedDate,
      fechaProximoPago: plan.nextInstallment ? new Date(`${plan.nextInstallment.fechaVencimiento}T12:00:00.000Z`) : null,
      ...(!calendarOnly ? {
        montoCredito: amount, valorCuota: quota,
        tasaInteresEa: Number(amortization.tasaInteresEaPorcentaje),
        valorInteres: Number(amortization.totalInteres), valorFianza: Number(amortization.totalFianza),
      } : {}),
    };
    const beforeSnapshot = {
      plazoMeses: current.plazoMeses, frecuenciaPago: current.frecuenciaPago,
      fechaPrimerPago: current.fechaPrimerPago?.toISOString() || null,
      fechaProximoPago: current.fechaProximoPago?.toISOString() || null,
      montoCredito: current.montoCredito, valorCuota: current.valorCuota,
      valorInteres: current.valorInteres, valorFianza: current.valorFianza,
      tasaInteresEa: current.tasaInteresEa, amortizationChecksum: source.checksum,
      originalAmortizationChecksum: original.checksum,
      abonos: abonos.map(item => ({ valor: item.valor, fechaAbono: item.fechaAbono.toISOString() })),
    };
    const revision = await insertCreditPlanRevision(tx, {
      creditoId: creditId, usuarioId: user.id, nombreUsuario: user.nombre,
      motivo: reason, beforeSnapshot, afterSnapshot: { ...beforeSnapshot, ...data },
      amortizationSnapshot: amortization,
    });
    await tx.credito.update({
      where: { id: creditId, updatedAt: current.updatedAt, planCapitalVigente: { equals: Prisma.DbNull } },
      data: {
        ...data,
        observacionAdmin: [current.observacionAdmin,
          `[${new Date().toISOString()}] AJUSTE PLAN CENTRAL #${revision.id}: ${user.nombre} (usuario ${user.id}). ${current.plazoMeses} ${getPaymentFrequencyLabel(current.frecuenciaPago)} -> ${installments} ${getPaymentFrequencyLabel(frequency)}. ${reason}`,
        ].filter(Boolean).join("\n"),
      },
    });
    return (await loadCredit(creditId, tx))!;
  });
  return NextResponse.json({
    ok: true, remote: null,
    message: "Plan ajustado por Administración Central. Se conservaron los abonos y el contrato original; el cambio quedó registrado.",
    item: serializeCredit(updated, await loadPaymentSummary(creditId), true),
  });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const supervisor = sellerSession?.tipoPerfil === "SUPERVISOR";

    const params = await context.params;
    const creditId = parseId(params.id);

    if (!creditId) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    const body = (await req.json()) as CommandBody;
    const command = String(body.command || "").trim() as CreditAdminCommand;
    const fechaProximoPago = toNullableDate(body.fechaProximoPago);
    const observacionAdmin = sanitizeText(body.observacionAdmin);

    const current = await loadCredit(creditId);

    if (!current) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    if (!adminCentral && current.sede.aliadoId !== Number(user.aliadoAccesoId || 0)) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const sellerCanConsultOwnCredit =
      Boolean(sellerSession) &&
      command === "consult-device" &&
      [sellerSession?.sedeId, sellerSession?.accesoSedeId].includes(current.sede.id);

    if (!admin && !supervisor && !sellerCanConsultOwnCredit) {
      return NextResponse.json(
        { error: "Solo supervisor o administrador puede ejecutar estos comandos" },
        { status: 403 }
      );
    }

    if (!admin && !sellerCanConsultOwnCredit && !SUPERVISOR_COMMANDS.includes(command)) {
      return NextResponse.json(
        { error: "El supervisor solo puede consultar, bloquear o desbloquear el equipo" },
        { status: 403 }
      );
    }

    if (current.estado === "ANULADO") {
      return NextResponse.json(
        { error: "Este credito ya esta anulado" },
        { status: 400 }
      );
    }

    if (current.planCapitalVigente && (command === "update-plan" || command === "update-due-date" || command === "annul-credit")) {
      return NextResponse.json({
        error: "El plan reducido por abono a capital conserva sus fechas y valores auditados. Un cambio o anulación requiere una revisión financiera específica.",
      }, { status: 409 });
    }

    if (isMassImportedCredit(current) && DEVICE_CONTROL_COMMANDS.has(command)) {
      return NextResponse.json(
        {
          error:
            "Este credito fue importado como historico sin gestion de bloqueo.",
        },
        { status: 400 }
      );
    }

    let adminMessage = "Comando aplicado";
    let remotePayload: unknown = null;
    let remoteQuery: unknown = null;

    switch (command) {
      case "consult-device":
        remoteQuery = await queryEqualityDevices(current.deviceUid);
        adminMessage = "Consulta remota actualizada";
        break;
      case "payment-reference":
        await prisma.credito.update({
          where: { id: current.id },
          data: {
            referenciaPago:
              current.referenciaPago ||
              generatePaymentReference(current.folio, current.clienteDocumento || ""),
            observacionAdmin: observacionAdmin || current.observacionAdmin,
          },
        });
        adminMessage = "Referencia de pago actualizada";
        break;
      case "toggle-stolen-lock":
      case "toggle-mora-lock": {
        const controlsMora = command === "toggle-mora-lock";
        const { ensureMoraBlockProtectionTables, hasActiveMoraBlockProtection } = await import("@/lib/mora-block-protection");
        await ensureMoraBlockProtectionTables();
        const result = await prisma.$transaction(async db => {
          await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, current.id);
          const latest = await loadCredit(current.id, db);
          if (!latest || latest.estado === "ANULADO") return { error: "Crédito no disponible para bloquear.", status: 409 as const };
          if (controlsMora && latest.bloqueoRobo) return { error: "El bloqueo por robo se conserva. Gestiona ese bloqueo desde su acción correspondiente.", status: 409 as const };
          if (controlsMora && !latest.bloqueoMora && await hasActiveMoraBlockProtection(latest.id, latest.clienteDocumento, db)) {
            return { error: "El crédito tiene una excepción de mora o prórroga vigente. No se puede bloquear por mora.", status: 409 as const };
          }
          const blocking = controlsMora ? !latest.bloqueoMora : !latest.bloqueoRobo;
          const nextMora = controlsMora ? blocking : latest.bloqueoMora;
          const nextTheft = controlsMora ? latest.bloqueoRobo : blocking;
          const operationSignal = AbortSignal.timeout(15_000);
          const remote = blocking
            ? await lockEqualityDevice(latest.deviceUid, { signal: operationSignal,
                lockMsgTitle: controlsMora ? "Pago vencido" : "Equipo protegido",
                lockMsgContent: controlsMora ? buildMoraLockMessage(latest.clienteDocumento) : "Equipo bloqueado por reporte de robo." })
            : nextMora || nextTheft ? null : await unlockEqualityDevice(latest.deviceUid, { signal: operationSignal });
          const query = await queryEqualityDevices(latest.deviceUid, {
            signal: AbortSignal.any([operationSignal, AbortSignal.timeout(3_000)]),
          }).catch(() => null);
          const payload = query || remote || latest.equalityPayload;
          const meta = getEqualityDeviceMeta(payload);
          await db.credito.update({ where: { id: latest.id }, data: {
            bloqueoMora: nextMora, bloqueoMoraAt: controlsMora ? (blocking ? new Date() : null) : latest.bloqueoMoraAt,
            bloqueoRobo: nextTheft, bloqueoRoboAt: controlsMora ? latest.bloqueoRoboAt : (blocking ? new Date() : null),
            estado: resolveCreditState({ bloqueoRobo: nextTheft, bloqueoMora: nextMora,
              deliverable: meta.deliveryStatus || null, pazYSalvoEmitidoAt: latest.pazYSalvoEmitidoAt }),
            deliverableLabel: meta.deliveryStatus?.label || latest.deliverableLabel,
            deliverableReady: typeof meta.deliveryStatus?.ready === "boolean" ? meta.deliveryStatus.ready : latest.deliverableReady,
            equalityState: meta.deviceState || latest.equalityState,
            equalityService: meta.serviceDetails || latest.equalityService,
            equalityPayload: payload && typeof payload === "object" ? payload as Prisma.InputJsonValue : undefined,
            equalityLastCheckAt: payload ? new Date() : latest.equalityLastCheckAt,
            observacionAdmin: observacionAdmin || latest.observacionAdmin,
          } });
          const updated = await loadCredit(latest.id, db);
          return { updated, payload, blocking };
        }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
        if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
        if (!result.updated) return NextResponse.json({ error: "No se pudo recargar el crédito." }, { status: 500 });
        return NextResponse.json({ ok: true, message: controlsMora
          ? result.blocking ? "Bloqueo por mora aplicado" : "Bloqueo por mora retirado"
          : result.blocking ? "Bloqueo por robo aplicado" : "Bloqueo por robo retirado",
          item: serializeCredit(result.updated, await loadPaymentSummary(current.id), admin),
          remote: result.payload ? { payload: result.payload, ...getPayloadSummary(result.payload), ...getEqualityDeviceMeta(result.payload) } : null });
      }
      case "update-due-date":
        if (!admin) {
          return NextResponse.json(
            { error: "Solo el administrador puede actualizar la fecha de pago" },
            { status: 403 }
          );
        }

        if (!fechaProximoPago) {
          return NextResponse.json(
            { error: "Debes indicar la nueva fecha de pago" },
            { status: 400 }
          );
        }
        await prisma.credito.update({
          where: { id: current.id, planCapitalVigente: { equals: Prisma.DbNull } },
          data: {
            fechaProximoPago,
            observacionAdmin: observacionAdmin || current.observacionAdmin,
          },
        });
        adminMessage = "Fecha de pago actualizada";
        break;
      case "update-plan": {
        if (!admin) {
          return NextResponse.json(
            { error: "Solo el administrador puede ajustar el plan del credito" },
            { status: 403 }
          );
        }

        if (await hasCreditAmortization(current.id)) {
          if (adminCentral) return await adjustCentralAmortizedPlan(current.id, body, user);
          return NextResponse.json(
            {
              error:
                "El plan aprobado usa amortizacion francesa inmutable. Para reestructurarlo se requiere un nuevo proceso contractual.",
            },
            { status: 409 }
          );
        }

        const nextInstallments = normalizeCreditInstallments(
          body.plazoMeses,
          current.plazoMeses || 1,
          MAX_CREDIT_INSTALLMENTS
        );
        const nextFrequency = normalizePaymentFrequency(
          body.frecuenciaPago || current.frecuenciaPago
        );
        const nextFirstPayment =
          toNullableDate(body.fechaPrimerPago) ||
          current.fechaPrimerPago ||
          current.fechaProximoPago ||
          getDefaultFirstPaymentDateObject(nextFrequency, current.fechaCredito);
        const calendarOnly =
          nextInstallments === Math.max(1, current.plazoMeses || 1) &&
          nextFrequency === normalizePaymentFrequency(current.frecuenciaPago);

        if (!calendarOnly && isMassImportedCredit(current)) {
          return NextResponse.json(
            {
              error:
                "El crédito histórico conserva la cuota y los cargos importados. Puedes corregir su primer pago sin cambiar plazo o frecuencia; una reestructuración requiere un proceso específico.",
              code: "HISTORICAL_PLAN_RESTRUCTURING_UNSUPPORTED",
            },
            { status: 409 }
          );
        }

        // A calendar correction must not replace the agreed installment or
        // embedded charges, which cannot be reconstructed from a historic rate.
        const financialPlan = calendarOnly ? null : calculateCreditCharges({
          saldoBaseFinanciado: current.saldoBaseFinanciado,
          cuotas: nextInstallments,
          tasaInteresEa: current.tasaInteresEa,
          fianzaPorcentaje: current.fianzaPorcentaje,
          frecuenciaPago: nextFrequency,
        });
        const currentSnapshot = current.contratoSnapshot;
        const snapshotRoot =
          typeof currentSnapshot === "object" && currentSnapshot !== null &&
          !Array.isArray(currentSnapshot)
            ? currentSnapshot as Record<string, unknown>
            : null;
        const snapshotFinancial = snapshotRoot?.financiero;
        const unsignedSnapshot =
          !current.contratoAceptadoAt && !current.pagareAceptadoAt &&
          !current.contratoFirmaDataUrl && !current.contratoOtpVerificadoAt &&
          !snapshotRoot?.firma &&
          !(typeof snapshotFinancial === "object" && snapshotFinancial !== null &&
            "selloFinanciero" in snapshotFinancial && snapshotFinancial.selloFinanciero);
        const calendarSnapshot =
          calendarOnly && unsignedSnapshot && snapshotRoot &&
          typeof snapshotFinancial === "object" &&
          snapshotFinancial !== null && !Array.isArray(snapshotFinancial)
            ? {
                ...snapshotRoot,
                financiero: {
                  ...snapshotFinancial,
                  fechaPrimerPago: nextFirstPayment.toISOString(),
                },
              } as Prisma.InputJsonValue
            : undefined;

        await ensureCreditAbonoAuditColumns();
        const abonos = await prisma.creditoAbono.findMany({
          where: {
            creditoId: current.id,
            estado: {
              not: "ANULADO",
            },
          },
          select: {
            valor: true,
            fechaAbono: true,
          },
          orderBy: {
            fechaAbono: "asc",
          },
        });
        const paymentPlan = buildCreditPaymentPlan({
          planCapitalVigente: current.planCapitalVigente,
          montoCredito: financialPlan?.montoCreditoTotal ?? current.montoCredito,
          valorCuota: financialPlan?.valorCuota ?? current.valorCuota,
          plazoMeses: nextInstallments,
          frecuenciaPago: nextFrequency,
          fechaPrimerPago: nextFirstPayment,
          abonos,
        });
        const nextDueDate = paymentPlan.nextInstallment?.saldoPendiente
          ? toNullableDate(`${paymentPlan.nextInstallment.fechaVencimiento}T12:00:00`)
          : null;
        const timestamp = new Date().toISOString();
        const nextObservation = [
          current.observacionAdmin,
          `[${timestamp}] AJUSTE PLAN: ${current.plazoMeses || 1} ${getPaymentFrequencyLabel(current.frecuenciaPago)} -> ${nextInstallments} ${getPaymentFrequencyLabel(nextFrequency)}. ${observacionAdmin || "Correccion administrativa"}`,
        ]
          .filter(Boolean)
          .join("\n");

        const updated = await prisma.credito.update({
          where: { id: current.id, planCapitalVigente: { equals: Prisma.DbNull } },
          data: {
            plazoMeses: nextInstallments,
            frecuenciaPago: nextFrequency,
            fechaPrimerPago: nextFirstPayment,
            fechaProximoPago: nextDueDate,
            ...(financialPlan ? {
              tasaInteresEa: financialPlan.tasaInteresEa,
              valorInteres: financialPlan.valorInteres,
              fianzaPorcentaje: financialPlan.fianzaPorcentaje,
              valorFianza: financialPlan.valorFianza,
              montoCredito: financialPlan.montoCreditoTotal,
              valorCuota: financialPlan.valorCuota,
            } : {}),
            ...(calendarSnapshot ? { contratoSnapshot: calendarSnapshot } : {}),
            observacionAdmin: nextObservation,
          },
          omit: CREDIT_DELIVERY_PHOTO_OMIT,
          include: {
            usuario: {
              select: {
                id: true,
                nombre: true,
                usuario: true,
              },
            },
            vendedor: {
              select: {
                id: true,
                nombre: true,
                documento: true,
              },
            },
            sede: {
              select: {
                id: true,
                nombre: true,
                aliadoId: true,
              },
            },
          },
        });
        const paymentSummary = await loadPaymentSummary(updated.id);

        return NextResponse.json({
          ok: true,
          message: calendarOnly
            ? "Fecha del primer pago actualizada. La cuota y los valores del crédito se conservaron."
            : `Plan actualizado a ${nextInstallments} cuotas ${getPaymentFrequencyLabel(nextFrequency).toLowerCase()}`,
          item: serializeCredit(updated, paymentSummary, admin),
          remote: null,
        });
      }
      case "extend-1h":
      case "extend-24h":
      case "extend-48h": {
        const hours =
          command === "extend-1h" ? 1 : command === "extend-24h" ? 24 : 48;
        await prisma.credito.update({
          where: { id: current.id },
          data: {
            graceUntil: extendFromNow(hours, current.graceUntil),
            observacionAdmin: observacionAdmin || current.observacionAdmin,
          },
        });
        adminMessage = `Ventana extendida ${hours} hora${hours === 1 ? "" : "s"}`;
        break;
      }
      case "warranty-15d":
      case "warranty-20d": {
        const days = command === "warranty-15d" ? 15 : 20;
        await prisma.credito.update({
          where: { id: current.id },
          data: {
            warrantyUntil: extendDays(days, current.warrantyUntil),
            observacionAdmin: observacionAdmin || current.observacionAdmin,
          },
        });
        adminMessage = `Garantia extendida ${days} dias`;
        break;
      }
      case "remove-lock":
        remotePayload = await unlockEqualityDevice(current.deviceUid);
        remoteQuery = await queryEqualityDevices(current.deviceUid);
        adminMessage = "Candado removido";
        break;
      case "annul-credit": {
        if (!admin) {
          return NextResponse.json(
            { error: "Solo el administrador puede anular creditos" },
            { status: 403 }
          );
        }

        const result = await prisma.$transaction(
          async (tx) => {
            // Lock ordering is deliberate: ally first, then the credit row. The
            // settlement transaction uses the same ally lock before consuming
            // pending adjustments, so an annulment cannot be missed or doubled.
            const paidAllyId = await resolvePaidCreditAllyId(tx, current.id);
            const allyLockId = paidAllyId ?? current.sede.aliadoId;
            if (allyLockId !== null) {
              await lockAllyPaymentAlly(tx, allyLockId);
            }
            await tx.$queryRawUnsafe<Array<{ id: number }>>(
              'SELECT "id" FROM public."Credito" WHERE "id" = $1 FOR UPDATE',
              current.id
            );

            const locked = await loadCredit(current.id, tx);
            if (!locked) {
              return {
                status: 404 as const,
                error: "Credito no encontrado",
                updated: null,
              };
            }
            if (locked.sede.aliadoId !== current.sede.aliadoId) {
              return {
                status: 409 as const,
                error:
                  "El aliado del credito cambio durante la operacion. Intenta nuevamente.",
                updated: null,
              };
            }
            if (
              !adminCentral &&
              locked.sede.aliadoId !== Number(user.aliadoAccesoId || 0)
            ) {
              return {
                status: 404 as const,
                error: "Credito no encontrado",
                updated: null,
              };
            }
            if (
              ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(
                String(locked.estado || "").trim().toUpperCase()
              )
            ) {
              return {
                status: 400 as const,
                error: "Este credito ya esta anulado",
                updated: null,
              };
            }
            if (locked.planCapitalVigente) {
              return {
                status: 409 as const,
                error:
                  "El plan reducido por abono a capital conserva sus fechas y valores auditados. Un cambio o anulacion requiere una revision financiera especifica.",
                updated: null,
              };
            }

            const reason = observacionAdmin || "Anulado por administrador";
            const annulledAt = new Date();
            const nextObservation = [
              locked.observacionAdmin,
              `[${annulledAt.toISOString()}] ANULACION: ${reason}`,
            ]
              .filter(Boolean)
              .join("\n");

            // Create the financial event first in this transaction. The database
            // trigger installed during deployment is a compatibility safety net
            // for older application instances and becomes a no-op on this row.
            await registerPaidCreditAnnulmentAdjustment(tx, {
              creditoId: locked.id,
              aliadoId: allyLockId,
              fechaAnulacion: annulledAt,
              fechaAnulacionFuente: "OPERACION_EN_LINEA",
              motivo: reason,
              creadoPorUsuarioId: user.id,
              creadoPorNombre: user.nombre,
            });

            const updated = await tx.credito.update({
              where: {
                id: locked.id,
                planCapitalVigente: { equals: Prisma.DbNull },
              },
              data: {
                estado: "ANULADO",
                deliverableReady: false,
                deliverableLabel: "Anulado",
                bloqueoMora: false,
                bloqueoMoraAt: null,
                bloqueoRobo: false,
                bloqueoRoboAt: null,
                observacionAdmin: nextObservation,
              },
              omit: CREDIT_DELIVERY_PHOTO_OMIT,
              include: {
                usuario: {
                  select: {
                    id: true,
                    nombre: true,
                    usuario: true,
                  },
                },
                vendedor: {
                  select: {
                    id: true,
                    nombre: true,
                    documento: true,
                  },
                },
                sede: {
                  select: {
                    id: true,
                    nombre: true,
                    aliadoId: true,
                  },
                },
              },
            });

            return { status: 200 as const, error: null, updated };
          },
          {
            isolationLevel: "Serializable",
            maxWait: 5_000,
            timeout: 20_000,
          }
        );

        if (!result.updated) {
          return NextResponse.json(
            { error: result.error },
            { status: result.status }
          );
        }

        const updated = result.updated;
        const paymentSummary = await loadPaymentSummary(updated.id);

        return NextResponse.json({
          ok: true,
          message: "Credito anulado correctamente",
          item: serializeCredit(updated, paymentSummary, admin),
          remote: null,
        });
      }
      default:
        return NextResponse.json({ error: "Comando no valido" }, { status: 400 });
    }

    const reloaded = await loadCredit(current.id);

    if (!reloaded) {
      return NextResponse.json(
        { error: "No se pudo recargar el credito" },
        { status: 500 }
      );
    }

    const payloadSource = remoteQuery || remotePayload || reloaded.equalityPayload;
    const deviceMeta = getEqualityDeviceMeta(payloadSource);
    const summary = getPayloadSummary(payloadSource);
    const effectiveDeliveryStatus = deviceMeta.deliveryStatus || null;
    const nextPayload =
      payloadSource && typeof payloadSource === "object"
        ? (payloadSource as Prisma.InputJsonValue)
        : undefined;

    const updated = await prisma.credito.update({
      where: { id: reloaded.id },
      data: {
        estado: resolveCreditState({
          bloqueoRobo: command === "remove-lock" ? false : reloaded.bloqueoRobo,
          bloqueoMora:
            command === "remove-lock" ? false : reloaded.bloqueoMora,
          deliverable: effectiveDeliveryStatus,
          pazYSalvoEmitidoAt: reloaded.pazYSalvoEmitidoAt,
        }),
        deliverableLabel:
          effectiveDeliveryStatus?.label || reloaded.deliverableLabel,
        deliverableReady:
          typeof effectiveDeliveryStatus?.ready === "boolean"
            ? effectiveDeliveryStatus.ready
            : reloaded.deliverableReady,
        equalityState: deviceMeta.deviceState || reloaded.equalityState,
        equalityService: deviceMeta.serviceDetails || reloaded.equalityService,
        equalityPayload: nextPayload,
        equalityLastCheckAt: payloadSource
          ? new Date()
          : reloaded.equalityLastCheckAt,
        bloqueoRobo: command === "remove-lock" ? false : reloaded.bloqueoRobo,
        bloqueoRoboAt: command === "remove-lock" ? null : reloaded.bloqueoRoboAt,
        bloqueoMora:
          command === "remove-lock" ? false : reloaded.bloqueoMora,
        bloqueoMoraAt:
          command === "remove-lock" ? null : reloaded.bloqueoMoraAt,
        observacionAdmin: observacionAdmin || reloaded.observacionAdmin,
      },
      omit: CREDIT_DELIVERY_PHOTO_OMIT,
      include: {
        usuario: {
          select: {
            id: true,
            nombre: true,
            usuario: true,
          },
        },
        vendedor: {
          select: {
            id: true,
            nombre: true,
            documento: true,
          },
        },
        sede: {
          select: {
            id: true,
            nombre: true,
            aliadoId: true,
          },
        },
      },
    });
    const paymentSummary = await loadPaymentSummary(updated.id);

    return NextResponse.json({
      ok: true,
      message: adminMessage,
      item: serializeCredit(updated, paymentSummary, admin),
      remote: payloadSource
        ? {
            payload: payloadSource,
            ...summary,
            ...deviceMeta,
            deliveryStatus: effectiveDeliveryStatus,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof CreditPlanAdjustmentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json({ error: "El crédito cambió durante la operación. Consulta nuevamente su plan vigente." }, { status: 409 });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { error: "El credito cambio durante la anulacion. Intenta nuevamente." },
        { status: 409 }
      );
    }
    console.error("ERROR APLICANDO COMANDO DE CREDITO:", error);

    if (isEqualityApiError(error)) {
      return NextResponse.json(
        {
          error: error.message,
          remoteStatus: error.status,
          remotePayload: error.payload,
        },
        { status: error.status >= 500 ? 502 : error.status }
      );
    }

    return NextResponse.json(
      { error: "No se pudo ejecutar el comando administrativo" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const adminCentral =
      isAdminRole(user.rolNombre) && isFinserPayCentralAlly(user.aliadoAccesoCodigo);

    if (!adminCentral) {
      return NextResponse.json(
        { error: "Solo admin central FINSER PAY puede eliminar creditos" },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditId = parseId(params.id);

    if (!creditId) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Credito" WHERE "id"=${creditId} FOR UPDATE`;
      const current = await tx.credito.findUnique({
        where: { id: creditId },
        select: {
          id: true,
          folio: true,
          clienteNombre: true,
          planCapitalVigente: true,
        },
      });

      if (!current) {
        return {
          status: 404 as const,
          body: { error: "Credito no encontrado" },
        };
      }

      if (current.planCapitalVigente) {
        return {
          status: 409 as const,
          body: { error: "El crédito tiene revisiones de abono a capital y no se puede eliminar sin una reversa financiera auditada." },
        };
      }

      const abonos = await tx.creditoAbono.findMany({
        where: { creditoId: current.id },
        select: { id: true },
      });
      const abonoIds = abonos.map((item) => item.id);

      if (abonoIds.length) {
        await tx.cajaMovimiento.deleteMany({
          where: {
            OR: abonoIds.flatMap((abonoId) => [
              {
                descripcion: {
                  contains: `${CREDIT_ABONO_CAJA_MARKER}${abonoId}`,
                },
              },
              {
                descripcion: {
                  contains: `Anulacion de recaudo ${abonoId}`,
                },
              },
            ]),
          },
        });
      }

      await tx.efectyRecaudoImport.updateMany({
        where: {
          OR: [
            { creditoId: current.id },
            ...(abonoIds.length ? [{ abonoId: { in: abonoIds } }] : []),
          ],
        },
        data: {
          status: "ELIMINADO_ADMIN",
          message: `Credito ${current.folio} eliminado por admin FINSER PAY`,
          creditoId: null,
          abonoId: null,
        },
      });

      await tx.wompiPaymentIntent.deleteMany({
        where: { creditoId: current.id },
      });

      await tx.creditoAbono.deleteMany({
        where: { creditoId: current.id },
      });

      await tx.credito.delete({
        where: { id: current.id },
        select: { id: true },
      });

      return {
        status: 200 as const,
        body: {
          ok: true,
          message: `Credito ${current.folio} eliminado`,
          deletedId: current.id,
        },
      };
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("ERROR ELIMINANDO CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudo eliminar el credito" },
      { status: 500 }
    );
  }
}
