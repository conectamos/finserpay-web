import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  extendDays,
  extendFromNow,
  generatePaymentReference,
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
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CommandBody = {
  command?: CreditAdminCommand;
  fechaProximoPago?: string;
  observacionAdmin?: string;
};

function parseId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

type PaymentSummary = {
  abonosCount: number;
  totalAbonado: number;
  ultimoAbonoAt: Date | null;
};

function serializeCredit(item: any, payment?: PaymentSummary) {
  const summary = resolveCreditPaymentSummary({
    montoCredito: item.montoCredito,
    cuotaInicial: item.cuotaInicial,
    totalAbonado: Number(payment?.totalAbonado || 0),
    abonosCount: Number(payment?.abonosCount || 0),
  });

  return {
    id: item.id,
    folio: item.folio,
    clienteNombre: item.clienteNombre,
    clienteDireccion: item.clienteDireccion,
    clienteDocumento: item.clienteDocumento,
    clienteFechaNacimiento: item.clienteFechaNacimiento?.toISOString() || null,
    clienteFechaExpedicion: item.clienteFechaExpedicion?.toISOString() || null,
    clienteTelefono: item.clienteTelefono,
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
    pazYSalvoEmitidoAt: item.pazYSalvoEmitidoAt?.toISOString() || null,
    observacionAdmin: item.observacionAdmin,
    contratoAceptadoAt: item.contratoAceptadoAt?.toISOString() || null,
    pagareAceptadoAt: item.pagareAceptadoAt?.toISOString() || null,
    contratoIp: item.contratoIp,
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
    totalAbonado: summary.totalAbonado,
    saldoPendiente: summary.saldoPendiente,
    totalRecaudado: summary.totalRecaudado,
    porcentajeRecaudado: summary.porcentajeRecaudado,
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
        },
      },
    },
  });
}

async function loadPaymentSummary(creditId: number) {
  const grouped = await prisma.creditoAbono.groupBy({
    by: ["creditoId"],
    where: {
      creditoId: creditId,
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

    if (!isAdminRole(user.rolNombre)) {
      return NextResponse.json(
        { error: "Solo el administrador puede ejecutar estos comandos" },
        { status: 403 }
      );
    }

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
          deliverable: deviceMeta.deliveryStatus || null,
          pazYSalvoEmitidoAt: reloaded.pazYSalvoEmitidoAt,
        }),
        deliverableLabel:
          deviceMeta.deliveryStatus?.label || reloaded.deliverableLabel,
        deliverableReady:
          typeof deviceMeta.deliveryStatus?.ready === "boolean"
            ? deviceMeta.deliveryStatus.ready
            : reloaded.deliverableReady,
        equalityState: deviceMeta.deviceState || reloaded.equalityState,
        equalityService: deviceMeta.serviceDetails || reloaded.equalityService,
        equalityPayload: nextPayload,
        equalityLastCheckAt: payloadSource ? new Date() : reloaded.equalityLastCheckAt,
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
          },
        },
      },
    });
    const paymentSummary = await loadPaymentSummary(updated.id);

    return NextResponse.json({
      ok: true,
      message: adminMessage,
      item: serializeCredit(updated, paymentSummary),
      remote: payloadSource
        ? {
            payload: payloadSource,
            ...summary,
            ...deviceMeta,
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
