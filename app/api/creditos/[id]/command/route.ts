import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
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
  type EqualityDeliveryStatus,
} from "@/lib/equality-device-meta";
import {
  isEqualityApiError,
  lockEqualityDevice,
  queryEqualityDevices,
  unlockEqualityDevice,
} from "@/lib/equality-zero-touch";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { buildMoraLockMessage } from "@/lib/credit-lock-message";
import { getEffectiveCreditSettings } from "@/lib/credit-settings";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isMassImportedCredit } from "@/lib/credit-import-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CommandBody = {
  command?: CreditAdminCommand;
  fechaProximoPago?: string;
  fechaPrimerPago?: string;
  frecuenciaPago?: string;
  observacionAdmin?: string;
  plazoMeses?: number | string;
};

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

type SerializedCreditSource = Prisma.CreditoGetPayload<{
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

function serializeCredit(item: SerializedCreditSource, payment?: PaymentSummary) {
  const summary = resolveCreditPaymentSummary({
    montoCredito: item.montoCredito,
    cuotaInicial: item.cuotaInicial,
    totalAbonado: Number(payment?.totalAbonado || 0),
    abonosCount: Number(payment?.abonosCount || 0),
  });
  const paymentPlan = buildCreditPaymentPlan({
    montoCredito: Number(item.montoCredito || 0),
    valorCuota: Number(item.valorCuota || 0),
    plazoMeses: Number(item.plazoMeses || 1),
    frecuenciaPago: item.frecuenciaPago,
    fechaPrimerPago: item.fechaPrimerPago || item.fechaProximoPago,
    abonos: summary.totalAbonado > 0 ? [{ valor: summary.totalAbonado }] : [],
  });

  return {
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
    imei: item.imei,
    deviceUid: item.deviceUid,
    referenciaEquipo: item.referenciaEquipo,
    equipoMarca: item.equipoMarca,
    equipoModelo: item.equipoModelo,
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
    usuario: {
      id: item.vendedor?.id || item.usuario.id,
      nombre: item.vendedor?.nombre || item.usuario.nombre,
      usuario: item.vendedor?.documento || item.usuario.usuario,
    },
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

async function loadCredit(id: number) {
  return prisma.credito.findUnique({
    where: { id },
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

    if (isMassImportedCredit(current) && DEVICE_CONTROL_COMMANDS.has(command)) {
      return NextResponse.json(
        {
          error:
            "Este credito fue importado como historico sin gestion de bloqueo.",
        },
        { status: 400 }
      );
    }

    const effectiveCreditSettings = await getEffectiveCreditSettings(
      current.clienteDocumento
    );
    const documentCanSkipDeliveryVerification = Boolean(
      effectiveCreditSettings.documentException?.permiteEntregaSinVerificacion
    );
    const shouldApplyDeliveryException =
      command === "consult-device" && documentCanSkipDeliveryVerification;

    let adminMessage = "Comando aplicado";
    let remotePayload: unknown = null;
    let remoteQuery: unknown = null;

    switch (command) {
      case "consult-device":
        if (shouldApplyDeliveryException) {
          adminMessage =
            "Entrega autorizada por excepcion administrativa sin verificar dispositivo";
        } else {
          remoteQuery = await queryEqualityDevices(current.deviceUid);
          adminMessage = "Consulta remota actualizada";
        }
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
        if (current.bloqueoRobo) {
          remotePayload = await unlockEqualityDevice(current.deviceUid);
          remoteQuery = await queryEqualityDevices(current.deviceUid);
          adminMessage = "Bloqueo por robo retirado";
        } else {
          remotePayload = await lockEqualityDevice(current.deviceUid, {
            lockMsgTitle: "Equipo protegido",
            lockMsgContent: "Equipo bloqueado por reporte de robo.",
          });
          remoteQuery = await queryEqualityDevices(current.deviceUid);
          adminMessage = "Bloqueo por robo aplicado";
        }
        break;
      case "toggle-mora-lock":
        if (current.bloqueoMora) {
          remotePayload = await unlockEqualityDevice(current.deviceUid);
          remoteQuery = await queryEqualityDevices(current.deviceUid);
          adminMessage = "Bloqueo por mora retirado";
        } else {
          remotePayload = await lockEqualityDevice(current.deviceUid, {
            lockMsgTitle: "Pago vencido",
            lockMsgContent: buildMoraLockMessage(current.clienteDocumento),
          });
          remoteQuery = await queryEqualityDevices(current.deviceUid);
          adminMessage = "Bloqueo por mora aplicado";
        }
        break;
      case "update-due-date":
        if (!fechaProximoPago) {
          return NextResponse.json(
            { error: "Debes indicar la nueva fecha de pago" },
            { status: 400 }
          );
        }
        await prisma.credito.update({
          where: { id: current.id },
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
        const financialPlan = calculateCreditCharges({
          saldoBaseFinanciado: current.saldoBaseFinanciado,
          cuotas: nextInstallments,
          tasaInteresEa: current.tasaInteresEa,
          fianzaPorcentaje: current.fianzaPorcentaje,
          frecuenciaPago: nextFrequency,
        });

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
          montoCredito: financialPlan.montoCreditoTotal,
          valorCuota: financialPlan.valorCuota,
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
          where: { id: current.id },
          data: {
            plazoMeses: nextInstallments,
            frecuenciaPago: nextFrequency,
            fechaPrimerPago: nextFirstPayment,
            fechaProximoPago: nextDueDate,
            tasaInteresEa: financialPlan.tasaInteresEa,
            valorInteres: financialPlan.valorInteres,
            fianzaPorcentaje: financialPlan.fianzaPorcentaje,
            valorFianza: financialPlan.valorFianza,
            montoCredito: financialPlan.montoCreditoTotal,
            valorCuota: financialPlan.valorCuota,
            observacionAdmin: nextObservation,
          },
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
          message: `Plan actualizado a ${nextInstallments} cuotas ${getPaymentFrequencyLabel(nextFrequency).toLowerCase()}`,
          item: serializeCredit(updated, paymentSummary),
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

        const reason = observacionAdmin || "Anulado por administrador";
        const timestamp = new Date().toISOString();
        const nextObservation = [
          current.observacionAdmin,
          `[${timestamp}] ANULACION: ${reason}`,
        ]
          .filter(Boolean)
          .join("\n");

        const updated = await prisma.credito.update({
          where: { id: current.id },
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
          message: "Credito anulado correctamente",
          item: serializeCredit(updated, paymentSummary),
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
    const administrativeDeliveryStatus: EqualityDeliveryStatus | null =
      shouldApplyDeliveryException && !deviceMeta.deliveryStatus?.ready
        ? {
            label: "Entrega autorizada",
            detail:
              "Entrega permitida sin verificar dispositivo por excepcion administrativa.",
            ready: true,
            tone: "emerald",
          }
        : null;
    const effectiveDeliveryStatus =
      administrativeDeliveryStatus || deviceMeta.deliveryStatus || null;
    const nextPayload =
      payloadSource && typeof payloadSource === "object"
        ? (payloadSource as Prisma.InputJsonValue)
        : undefined;

    const updated = await prisma.credito.update({
      where: { id: reloaded.id },
      data: {
        estado: resolveCreditState({
          bloqueoRobo:
            command === "toggle-stolen-lock"
              ? !current.bloqueoRobo
              : command === "remove-lock"
                ? false
                : reloaded.bloqueoRobo,
          bloqueoMora:
            command === "toggle-mora-lock"
              ? !current.bloqueoMora
              : command === "remove-lock"
                ? false
                : reloaded.bloqueoMora,
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
        equalityLastCheckAt:
          payloadSource || administrativeDeliveryStatus
            ? new Date()
            : reloaded.equalityLastCheckAt,
        bloqueoRobo:
          command === "toggle-stolen-lock"
            ? !current.bloqueoRobo
            : command === "remove-lock"
              ? false
              : reloaded.bloqueoRobo,
        bloqueoRoboAt:
          command === "toggle-stolen-lock"
            ? current.bloqueoRobo
              ? null
              : new Date()
            : command === "remove-lock"
              ? null
              : reloaded.bloqueoRoboAt,
        bloqueoMora:
          command === "toggle-mora-lock"
            ? !current.bloqueoMora
            : command === "remove-lock"
              ? false
              : reloaded.bloqueoMora,
        bloqueoMoraAt:
          command === "toggle-mora-lock"
            ? current.bloqueoMora
              ? null
              : new Date()
            : command === "remove-lock"
              ? null
              : reloaded.bloqueoMoraAt,
        observacionAdmin: observacionAdmin || reloaded.observacionAdmin,
      },
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
      item: serializeCredit(updated, paymentSummary),
      remote: payloadSource || administrativeDeliveryStatus
        ? {
            payload: payloadSource,
            ...summary,
            ...deviceMeta,
            deliveryStatus: effectiveDeliveryStatus,
          }
        : null,
    });
  } catch (error) {
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
      const current = await tx.credito.findUnique({
        where: { id: creditId },
        select: {
          id: true,
          folio: true,
          clienteNombre: true,
        },
      });

      if (!current) {
        return {
          status: 404 as const,
          body: { error: "Credito no encontrado" },
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
