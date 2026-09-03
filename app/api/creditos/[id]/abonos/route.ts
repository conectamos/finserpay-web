import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import {
  creditCajaConcept,
  creditCajaDescription,
  normalizePaymentMethod,
  resolveCreditState,
  resolveCreditPaymentSummary,
  sanitizeText,
  toNumber,
} from "@/lib/credit-factory";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { resolveNextPaymentDateAfterPayment } from "@/lib/credit-next-payment-date";
import {
  EARLY_PAYOFF_PAYMENT_TYPE,
  buildEarlyPayoffObservation,
  calculateCreditEarlyPayoff,
} from "@/lib/credit-early-payoff";
import {
  getEqualityDeviceMeta,
  getPayloadSummary,
} from "@/lib/equality-device-meta";
import {
  isEqualityApiError,
  isEqualityConfigured,
  lockEqualityDevice,
  queryEqualityDevices,
  unlockEqualityDevice,
} from "@/lib/equality-zero-touch";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { buildMoraLockMessage } from "@/lib/credit-lock-message";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { buildCreditAccessWhere } from "@/lib/credit-route-lookup";
import { isMassImportedCredit } from "@/lib/credit-import-flags";
import {
  enqueueUnlockForCurrentCredit,
  processDeviceUnlockCommand,
} from "@/lib/device-unlock-queue";
import { resolveSelectedPaymentAmount } from "@/lib/manual-payment-amount";
import { hasActivePadlockBindingForCredit } from "@/lib/padlock/equality-exclusion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreditPaymentBody = {
  cuotaNumero?: number | string | null;
  cuotaNumeros?: Array<number | string> | string | null;
  liquidacionAnticipada?: boolean;
  metodoPago?: string;
  observacion?: string;
  tipoAbono?: string;
  valor?: number | string;
};

class CreditPaymentConflictError extends Error {}

const copCurrencyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function parseId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function isAnnulledCreditState(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase() === "ANULADO";
}

function currency(value: number) {
  return copCurrencyFormatter.format(Math.round(Number(value || 0)));
}

function parseMoneyValue(value: CreditPaymentBody["valor"]) {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return 0;
    }

    if (/^\d+([.,]\d+)?$/.test(trimmed)) {
      const normalized = Number(trimmed.replace(",", "."));
      return Number.isFinite(normalized) ? normalized : 0;
    }

    const digitsOnly = trimmed.replace(/\D/g, "");
    return digitsOnly ? Number(digitsOnly) : 0;
  }

  return toNumber(value);
}

function parseInstallmentNumbers(value: CreditPaymentBody["cuotaNumeros"]) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const numbers = rawItems
    .map((item) => Math.trunc(toNumber(item)))
    .filter((item) => item > 0);

  return [...new Set(numbers)].sort((a, b) => a - b);
}

function safeIsoDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const parsed = new Date(String(value || ""));

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

type PaymentWithRelations = {
  createdAt: Date;
  creditoId: number;
  fechaAbono: Date;
  id: number;
  metodoPago: string;
  observacion: string | null;
  estado?: string;
  anuladoAt?: Date | null;
  anulacionMotivo?: string | null;
  anuladoPorUsuarioId?: number | null;
  sede?: {
    id: number;
    nombre: string;
  } | null;
  usuario?: {
    id: number;
    nombre: string;
    usuario: string;
  } | null;
  valor: number | string;
  vendedor?: {
    documento: string | null;
    id: number;
    nombre: string;
  } | null;
};

type RawPaymentItem = {
  anuladoAt: Date | null;
  anulacionMotivo: string | null;
  anuladoPorUsuarioId: number | null;
  createdAt: Date;
  creditoId: number;
  estado: string;
  fechaAbono: Date;
  id: number;
  metodoPago: string;
  observacion: string | null;
  sedeId: number;
  usuarioId: number;
  valor: number | string;
  vendedorId: number | null;
};

function serializePayment(item: PaymentWithRelations) {
  return {
    id: item.id,
    creditoId: item.creditoId,
    valor: Number(item.valor || 0),
    metodoPago: item.metodoPago,
    observacion: item.observacion,
    estado: item.estado || "ACTIVO",
    anuladoAt: safeIsoDate(item.anuladoAt),
    anulacionMotivo: item.anulacionMotivo || null,
    anuladoPorUsuarioId: item.anuladoPorUsuarioId || null,
    fechaAbono: safeIsoDate(item.fechaAbono) || safeIsoDate(item.createdAt) || "",
    createdAt: safeIsoDate(item.createdAt) || "",
    usuario: {
      id: item.vendedor?.id || item.usuario?.id || 0,
      nombre: item.vendedor?.nombre || item.usuario?.nombre || "Sin usuario",
      usuario: item.vendedor?.documento || item.usuario?.usuario || "",
    },
    vendedor: item.vendedor
      ? {
          id: item.vendedor.id,
          nombre: item.vendedor.nombre,
          documento: item.vendedor.documento,
        }
      : null,
    sede: {
      id: item.sede?.id || 0,
      nombre: item.sede?.nombre || "Sin sede",
    },
  };
}

async function hydratePaymentRelations(items: RawPaymentItem[]) {
  const usuarioIds = [...new Set(items.map((item) => item.usuarioId).filter(Boolean))];
  const vendedorIds = [
    ...new Set(
      items
        .map((item) => item.vendedorId)
        .filter((item): item is number => typeof item === "number" && item > 0)
    ),
  ];
  const sedeIds = [...new Set(items.map((item) => item.sedeId).filter(Boolean))];
  const [usuarios, vendedores, sedes] = await Promise.all([
    usuarioIds.length
      ? prisma.usuario.findMany({
          where: { id: { in: usuarioIds } },
          select: { id: true, nombre: true, usuario: true },
        })
      : [],
    vendedorIds.length
      ? prisma.vendedor.findMany({
          where: { id: { in: vendedorIds } },
          select: { id: true, nombre: true, documento: true },
        })
      : [],
    sedeIds.length
      ? prisma.sede.findMany({
          where: { id: { in: sedeIds } },
          select: { id: true, nombre: true },
        })
      : [],
  ]);
  const usuarioMap = new Map(usuarios.map((item) => [item.id, item]));
  const vendedorMap = new Map(vendedores.map((item) => [item.id, item]));
  const sedeMap = new Map(sedes.map((item) => [item.id, item]));

  return items.map((item) => ({
    ...item,
    usuario: usuarioMap.get(item.usuarioId) || {
      id: item.usuarioId,
      nombre: "Sin usuario",
      usuario: "",
    },
    vendedor: item.vendedorId ? vendedorMap.get(item.vendedorId) || null : null,
    sede: sedeMap.get(item.sedeId) || {
      id: item.sedeId,
      nombre: "Sin sede",
    },
  }));
}

async function loadCredit(
  creditId: number,
  accessWhere: Prisma.CreditoWhereInput
) {
  return prisma.credito.findFirst({
    where: {
      AND: [{ id: creditId }, accessWhere],
    },
    select: {
      id: true,
      folio: true,
      clienteNombre: true,
      clienteDocumento: true,
      clienteTelefono: true,
      saldoBaseFinanciado: true,
      montoCredito: true,
      cuotaInicial: true,
      valorInteres: true,
      valorFianza: true,
      valorCuota: true,
      plazoMeses: true,
      frecuenciaPago: true,
      fechaPrimerPago: true,
      fechaProximoPago: true,
      referenciaPago: true,
      estado: true,
      deviceUid: true,
      deliverableLabel: true,
      deliverableReady: true,
      equalityState: true,
      equalityService: true,
      equalityPayload: true,
      equalityLastCheckAt: true,
      bloqueoRobo: true,
      bloqueoRoboAt: true,
      bloqueoMora: true,
      bloqueoMoraAt: true,
      pazYSalvoEmitidoAt: true,
      observacionAdmin: true,
      sedeId: true,
    },
  });
}

async function loadPaymentSummary(creditId: number, montoCredito: number, cuotaInicial: number) {
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
  const paymentSummary = resolveCreditPaymentSummary({
    montoCredito,
    cuotaInicial,
    totalAbonado: Number(current?._sum.valor || 0),
    abonosCount: current?._count._all || 0,
  });

  return {
    ...paymentSummary,
    ultimoAbonoAt: current?._max.fechaAbono?.toISOString() || null,
  };
}

async function loadPaymentPlan(credit: Awaited<ReturnType<typeof loadCredit>>) {
  if (!credit) {
    return null;
  }

  const abonos = await prisma.creditoAbono.findMany({
    where: {
      creditoId: credit.id,
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

  return buildCreditPaymentPlan({
    montoCredito: Number(credit.montoCredito || 0),
    valorCuota: Number(credit.valorCuota || 0),
    plazoMeses: Number(credit.plazoMeses || 1),
    frecuenciaPago: credit.frecuenciaPago,
    fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    fechaProximoPago: credit.fechaProximoPago,
    abonos: abonos.map((item) => ({
      valor: Number(item.valor || 0),
      fechaAbono: item.fechaAbono,
    })),
    settled: Boolean(credit.pazYSalvoEmitidoAt),
  });
}

type LoadedCredit = NonNullable<Awaited<ReturnType<typeof loadCredit>>>;
type PaymentPlan = NonNullable<Awaited<ReturnType<typeof loadPaymentPlan>>>;

function safeEqualityPayload(payload: unknown) {
  return payload && typeof payload === "object"
    ? (payload as Prisma.InputJsonValue)
    : undefined;
}

function serializeAutomationResult(result: {
  action: string;
  message: string;
  remote: unknown;
}) {
  return {
    action: result.action,
    message: result.message,
    remote: result.remote
      ? {
          ...getPayloadSummary(result.remote),
          ...getEqualityDeviceMeta(result.remote),
        }
      : null,
  };
}

async function syncMoraAutomation(credit: LoadedCredit, plan: PaymentPlan) {
  const isInMora = plan.estadoPago === "MORA";

  if (isAnnulledCreditState(credit.estado)) {
    return {
      action: "SKIPPED" as const,
      credit,
      message: "Credito anulado; no se sincroniza mora.",
      remote: null as unknown,
    };
  }

  if (credit.pazYSalvoEmitidoAt) {
    return {
      action: "SKIPPED" as const,
      credit,
      message: "Credito con paz y salvo emitido.",
      remote: null as unknown,
    };
  }

  if (isMassImportedCredit(credit)) {
    return {
      action: "SKIPPED" as const,
      credit,
      message: "Credito importado sin gestion de bloqueo; mora solo informativa.",
      remote: null as unknown,
    };
  }

  if (await hasActivePadlockBindingForCredit(credit.id)) {
    return {
      action: "SKIPPED" as const,
      credit,
      message: "Credito vinculado a Padlock; Equality no controla este dispositivo.",
      remote: null as unknown,
    };
  }

  if (isInMora && credit.bloqueoRobo) {
    return {
      action: "SKIPPED" as const,
      credit,
      message: "El equipo tiene bloqueo manual por robo; no se modifica por mora.",
      remote: null as unknown,
    };
  }

  if (isInMora && credit.bloqueoMora) {
    return {
      action: "UNCHANGED" as const,
      credit,
      message: "El equipo ya esta bloqueado por mora.",
      remote: null as unknown,
    };
  }

  if (!isInMora && !credit.bloqueoMora) {
    return {
      action: "UNCHANGED" as const,
      credit,
      message: "El credito no tiene mora activa.",
      remote: null as unknown,
    };
  }

  if (!isEqualityConfigured()) {
    return {
      action: "SKIPPED" as const,
      credit,
      message: "Equality no esta configurado; no se pudo sincronizar el bloqueo.",
      remote: null as unknown,
    };
  }

  try {
    const remotePayload = isInMora
      ? await lockEqualityDevice(credit.deviceUid, {
          lockMsgTitle: "Pago vencido",
          lockMsgContent: buildMoraLockMessage(credit.clienteDocumento),
        })
      : credit.bloqueoRobo
        ? null
        : await unlockEqualityDevice(credit.deviceUid);
    const remoteQuery = await queryEqualityDevices(credit.deviceUid).catch(() => null);
    const payloadSource = remoteQuery || remotePayload || credit.equalityPayload;
    const deviceMeta = getEqualityDeviceMeta(payloadSource);

    const updated = await prisma.credito.update({
      where: { id: credit.id },
      data: {
        estado: resolveCreditState({
          bloqueoRobo: credit.bloqueoRobo,
          bloqueoMora: isInMora,
          deliverable: deviceMeta.deliveryStatus || null,
          pazYSalvoEmitidoAt: credit.pazYSalvoEmitidoAt,
        }),
        deliverableLabel:
          deviceMeta.deliveryStatus?.label || credit.deliverableLabel,
        deliverableReady:
          typeof deviceMeta.deliveryStatus?.ready === "boolean"
            ? deviceMeta.deliveryStatus.ready
            : credit.deliverableReady,
        equalityState: deviceMeta.deviceState || credit.equalityState,
        equalityService: deviceMeta.serviceDetails || credit.equalityService,
        equalityPayload: safeEqualityPayload(payloadSource),
        equalityLastCheckAt: payloadSource ? new Date() : credit.equalityLastCheckAt,
        bloqueoMora: isInMora,
        bloqueoMoraAt: isInMora ? new Date() : null,
      },
      select: {
        id: true,
        folio: true,
        clienteNombre: true,
        clienteDocumento: true,
        clienteTelefono: true,
        saldoBaseFinanciado: true,
        montoCredito: true,
        cuotaInicial: true,
        valorInteres: true,
        valorFianza: true,
        valorCuota: true,
        plazoMeses: true,
        frecuenciaPago: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
        referenciaPago: true,
        estado: true,
        deviceUid: true,
        deliverableLabel: true,
        deliverableReady: true,
        equalityState: true,
        equalityService: true,
        equalityPayload: true,
        equalityLastCheckAt: true,
        bloqueoRobo: true,
        bloqueoRoboAt: true,
        bloqueoMora: true,
        bloqueoMoraAt: true,
        pazYSalvoEmitidoAt: true,
        observacionAdmin: true,
        sedeId: true,
      },
    });

    return {
      action: isInMora ? ("LOCKED" as const) : ("UNLOCKED" as const),
      credit: updated,
      message: isInMora
        ? "Bloqueo automatico por mora aplicado en Equality."
        : "Mora pagada: desbloqueo automatico enviado a Equality.",
      remote: payloadSource,
    };
  } catch (error) {
    console.error("ERROR SINCRONIZANDO BLOQUEO POR MORA:", error);

    return {
      action: "FAILED" as const,
      credit,
      message: isEqualityApiError(error)
        ? `Equality no confirmo el bloqueo automatico: ${error.message}`
        : "No se pudo sincronizar el bloqueo automatico con Equality.",
      remote: isEqualityApiError(error) ? error.payload : null,
    };
  }
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    await ensureCreditAbonoAuditColumns();

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

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    if (!admin && !supervisor) {
      return NextResponse.json(
        { error: "Solo el supervisor o administrador puede consultar abonos" },
        { status: 403 }
      );
    }

    const creditAccessWhere = buildCreditAccessWhere({
      admin,
      adminCentral,
      aliadoId: user.aliadoAccesoId,
      sedeId: user.sedeId,
      sellerSedeId: sellerSession?.sedeId,
      supervisor,
    });
    const credit = await loadCredit(creditId, creditAccessWhere);

    if (!credit) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const rawItems = await prisma.creditoAbono.findMany({
      where: {
        creditoId: credit.id,
      },
      select: {
        anuladoAt: true,
        anulacionMotivo: true,
        anuladoPorUsuarioId: true,
        createdAt: true,
        creditoId: true,
        estado: true,
        fechaAbono: true,
        id: true,
        metodoPago: true,
        observacion: true,
        sedeId: true,
        usuarioId: true,
        valor: true,
        vendedorId: true,
      },
      orderBy: {
        fechaAbono: "desc",
      },
      take: 50,
    });
    const items = await hydratePaymentRelations(rawItems);

    const summary = await loadPaymentSummary(
      credit.id,
      Number(credit.montoCredito || 0),
      Number(credit.cuotaInicial || 0)
    );
    const plan = await loadPaymentPlan(credit);
    const activePaymentItems = items.filter(
      (item) => String(item.estado || "ACTIVO").toUpperCase() !== "ANULADO"
    );
    const earlyPayoff = calculateCreditEarlyPayoff({
      saldoBaseFinanciado: Number(credit.saldoBaseFinanciado || 0),
      montoCredito: Number(credit.montoCredito || 0),
      valorInteres: Number(credit.valorInteres || 0),
      valorFianza: Number(credit.valorFianza || 0),
      valorCuota: Number(credit.valorCuota || 0),
      plazoMeses: Number(credit.plazoMeses || 1),
      frecuenciaPago: credit.frecuenciaPago,
      fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
      fechaProximoPago: credit.fechaProximoPago,
      abonos: activePaymentItems.map((item) => ({
        valor: Number(item.valor || 0),
        fechaAbono: item.fechaAbono,
      })),
    });
    const automation = plan
      ? await syncMoraAutomation(credit, plan)
      : {
          action: "UNCHANGED" as const,
          credit,
          message: "Sin plan de pagos para sincronizar.",
          remote: null,
        };
    const syncedCredit = automation.credit;

    return NextResponse.json({
      ok: true,
      credito: {
        ...syncedCredit,
        fechaPrimerPago: syncedCredit.fechaPrimerPago?.toISOString() || null,
        fechaProximoPago: syncedCredit.fechaProximoPago?.toISOString() || null,
        equalityLastCheckAt: syncedCredit.equalityLastCheckAt?.toISOString() || null,
        bloqueoRoboAt: syncedCredit.bloqueoRoboAt?.toISOString() || null,
        bloqueoMoraAt: syncedCredit.bloqueoMoraAt?.toISOString() || null,
        pazYSalvoEmitidoAt: syncedCredit.pazYSalvoEmitidoAt?.toISOString() || null,
        ...summary,
        estadoPago: plan?.estadoPago || "AL_DIA",
        nextInstallment: plan?.nextInstallment || null,
        overdueCount: plan?.overdueCount || 0,
        paidCount: plan?.paidCount || 0,
        pendingCount: plan?.pendingCount || 0,
        plan: plan?.installments || [],
        liquidacionAnticipada: {
          disponible: earlyPayoff.eligible,
          motivo: earlyPayoff.reason,
          capitalPendiente: earlyPayoff.capitalPendiente,
          condonacion: earlyPayoff.interesFianzaCondonado,
          saldoObligacion: earlyPayoff.saldoObligacion,
        },
      },
      automation: serializeAutomationResult(automation),
      items: items.map(serializePayment),
    });
  } catch (error) {
    console.error("ERROR LISTANDO ABONOS DE CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudieron cargar los abonos del credito" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    await ensureCreditAbonoAuditColumns();

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

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    if (!admin && !supervisor) {
      return NextResponse.json(
        { error: "Solo el supervisor o administrador puede registrar abonos" },
        { status: 403 }
      );
    }

    const creditAccessWhere = buildCreditAccessWhere({
      admin,
      adminCentral,
      aliadoId: user.aliadoAccesoId,
      sedeId: user.sedeId,
      sellerSedeId: sellerSession?.sedeId,
      supervisor,
    });
    const credit = await loadCredit(creditId, creditAccessWhere);

    if (!credit) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    if (isAnnulledCreditState(credit.estado)) {
      return NextResponse.json(
        { error: "No se pueden registrar abonos sobre un credito anulado" },
        { status: 400 }
      );
    }

    const body = (await req.json()) as CreditPaymentBody;
    let valor = parseMoneyValue(body.valor);
    const metodoPago = normalizePaymentMethod(body.metodoPago);
    const observacion = sanitizeText(body.observacion);
    const earlyPayoffRequested =
      Boolean(body.liquidacionAnticipada) ||
      sanitizeText(body.tipoAbono).toUpperCase() === EARLY_PAYOFF_PAYMENT_TYPE;
    const cuotaNumeros = parseInstallmentNumbers(body.cuotaNumeros);
    const cuotaNumero = Math.trunc(toNumber(body.cuotaNumero));
    let selectedNumbers = cuotaNumeros.length
      ? cuotaNumeros
      : cuotaNumero > 0
        ? [cuotaNumero]
        : [];
    const currentPlan = await loadPaymentPlan(credit);
    let earlyPayoff = null as ReturnType<typeof calculateCreditEarlyPayoff> | null;

    if (earlyPayoffRequested) {
      const currentAbonos = await prisma.creditoAbono.findMany({
        where: {
          creditoId: credit.id,
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
      earlyPayoff = calculateCreditEarlyPayoff({
        saldoBaseFinanciado: Number(credit.saldoBaseFinanciado || 0),
        montoCredito: Number(credit.montoCredito || 0),
        valorInteres: Number(credit.valorInteres || 0),
        valorFianza: Number(credit.valorFianza || 0),
        valorCuota: Number(credit.valorCuota || 0),
        plazoMeses: Number(credit.plazoMeses || 1),
        frecuenciaPago: credit.frecuenciaPago,
        fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
        fechaProximoPago: credit.fechaProximoPago,
        abonos: currentAbonos.map((item) => ({
          valor: Number(item.valor || 0),
          fechaAbono: item.fechaAbono,
        })),
      });

      if (!earlyPayoff.eligible) {
        return NextResponse.json(
          { error: earlyPayoff.reason || "No se puede liquidar este credito hoy" },
          { status: 400 }
        );
      }

      valor = earlyPayoff.capitalPendiente;
      selectedNumbers = [];
    }
    const selectedInstallments = selectedNumbers
      .map(
        (numero) =>
          currentPlan?.installments.find((item) => item.numero === numero) || null
      )
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const selectedTotal = selectedInstallments.reduce(
      (sum, item) => sum + Math.max(0, Number(item.saldoPendiente || 0)),
      0
    );

    if (selectedNumbers.length && selectedInstallments.length !== selectedNumbers.length) {
      return NextResponse.json(
        { error: "Una o mas cuotas seleccionadas no existen en el plan" },
        { status: 400 }
      );
    }

    if (selectedInstallments.length) {
      const paidInstallment = selectedInstallments.find((item) => item.saldoPendiente <= 0);
      const roundedSelectedTotal = Math.round(selectedTotal);

      if (paidInstallment) {
        return NextResponse.json(
          { error: `La cuota ${paidInstallment.numero} ya esta pagada` },
          { status: 400 }
        );
      }

      if (valor <= 0) {
        valor = roundedSelectedTotal;
      }

      if (Math.round(valor) < roundedSelectedTotal) {
        return NextResponse.json(
          {
            error: `El abono no alcanza para las cuotas seleccionadas (${currency(roundedSelectedTotal)})`,
          },
          { status: 400 }
        );
      }

      valor = resolveSelectedPaymentAmount(valor, selectedTotal);
    }

    if (valor <= 0) {
      return NextResponse.json(
        { error: "Debes indicar un valor de abono mayor a 0" },
        { status: 400 }
      );
    }

    const currentSummary = await loadPaymentSummary(
      credit.id,
      Number(credit.montoCredito || 0),
      Number(credit.cuotaInicial || 0)
    );

    if (currentSummary.saldoPendiente <= 0) {
      return NextResponse.json(
        { error: "Este credito ya no tiene saldo pendiente" },
        { status: 400 }
      );
    }

    if (valor > currentSummary.saldoPendiente) {
      return NextResponse.json(
        {
          error: `El abono supera el saldo pendiente actual (${currency(currentSummary.saldoPendiente)})`,
        },
        { status: 400 }
      );
    }

    const paymentResult = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id"
        FROM "Credito"
        WHERE "id" = ${credit.id}
        FOR UPDATE
      `;
      const lockedCredit = await tx.credito.findUnique({
        where: { id: credit.id },
        select: {
          clienteNombre: true,
          estado: true,
          fechaPrimerPago: true,
          fechaProximoPago: true,
          folio: true,
          frecuenciaPago: true,
          id: true,
          montoCredito: true,
          observacionAdmin: true,
          pazYSalvoEmitidoAt: true,
          plazoMeses: true,
          saldoBaseFinanciado: true,
          valorCuota: true,
          valorFianza: true,
          valorInteres: true,
        },
      });

      let transactionValue = valor;

      if (
        !lockedCredit ||
        isAnnulledCreditState(lockedCredit.estado) ||
        lockedCredit.pazYSalvoEmitidoAt
      ) {
        throw new CreditPaymentConflictError(
          "Este credito ya fue finalizado o no permite mas recaudos."
        );
      }

      const lockedAbonos = await tx.creditoAbono.findMany({
        where: {
          creditoId: lockedCredit.id,
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
      const lockedPlan = buildCreditPaymentPlan({
        montoCredito: Number(lockedCredit.montoCredito || 0),
        valorCuota: Number(lockedCredit.valorCuota || 0),
        plazoMeses: Number(lockedCredit.plazoMeses || 1),
        frecuenciaPago: lockedCredit.frecuenciaPago,
        fechaPrimerPago:
          lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
        fechaProximoPago: lockedCredit.fechaProximoPago,
        abonos: lockedAbonos.map((item) => ({
          valor: Number(item.valor || 0),
          fechaAbono: item.fechaAbono,
        })),
      });
      const lockedBalanceInCents = Math.max(
        0,
        Math.round(lockedPlan.saldoPendiente * 100)
      );

      if (lockedBalanceInCents <= 0) {
        throw new CreditPaymentConflictError(
          "Este credito ya no tiene saldo pendiente."
        );
      }

      const earlyPayoffInTx = earlyPayoffRequested
        ? calculateCreditEarlyPayoff({
            saldoBaseFinanciado: Number(
              lockedCredit.saldoBaseFinanciado || 0
            ),
            montoCredito: Number(lockedCredit.montoCredito || 0),
            valorInteres: Number(lockedCredit.valorInteres || 0),
            valorFianza: Number(lockedCredit.valorFianza || 0),
            valorCuota: Number(lockedCredit.valorCuota || 0),
            plazoMeses: Number(lockedCredit.plazoMeses || 1),
            frecuenciaPago: lockedCredit.frecuenciaPago,
            fechaPrimerPago:
              lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
            fechaProximoPago: lockedCredit.fechaProximoPago,
            abonos: lockedAbonos.map((item) => ({
              valor: Number(item.valor || 0),
              fechaAbono: item.fechaAbono,
            })),
          })
        : null;

      if (earlyPayoffInTx && !earlyPayoffInTx.eligible) {
        throw new CreditPaymentConflictError(
          earlyPayoffInTx.reason || "La liquidacion anticipada ya no aplica."
        );
      }

      if (
        earlyPayoffInTx &&
        Math.round(earlyPayoffInTx.capitalPendiente) !== Math.round(valor)
      ) {
        throw new CreditPaymentConflictError(
          "El valor de liquidacion cambio. Consulta de nuevo el credito."
        );
      }

      if (earlyPayoffInTx) {
        transactionValue = earlyPayoffInTx.capitalPendiente;
      }

      if (!earlyPayoffInTx) {
        const lockedSelectedInstallments = selectedNumbers
          .map(
            (numero) =>
              lockedPlan.installments.find((item) => item.numero === numero) ||
              null
          )
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
        const lockedSelectedBalance = lockedSelectedInstallments.reduce(
          (sum, item) => sum + Math.max(0, Number(item.saldoPendiente || 0)),
          0
        );
        transactionValue = resolveSelectedPaymentAmount(
          transactionValue,
          lockedSelectedBalance
        );
        const selectedBalanceInCents = Math.round(lockedSelectedBalance * 100);

        if (
          selectedNumbers.length &&
          (lockedSelectedInstallments.length !== selectedNumbers.length ||
            selectedBalanceInCents <= 0 ||
            Math.round(transactionValue * 100) < selectedBalanceInCents)
        ) {
          throw new CreditPaymentConflictError(
            "Las cuotas seleccionadas cambiaron. Consulta de nuevo el credito."
          );
        }

        if (Math.round(transactionValue * 100) > lockedBalanceInCents) {
          throw new CreditPaymentConflictError(
            "El abono supera el saldo pendiente actualizado."
          );
        }
      }

      const abonoObservation =
        earlyPayoffInTx
          ? [
              buildEarlyPayoffObservation(earlyPayoffInTx),
              observacion,
            ]
              .filter(Boolean)
              .join(" - ")
          : [
              selectedInstallments.length
                ? `Cuotas ${selectedInstallments.map((item) => item.numero).join(", ")}`
                : "",
              observacion,
            ]
              .filter(Boolean)
              .join(" - ") || null;

      const created = await tx.creditoAbono.create({
        data: {
          creditoId: credit.id,
          usuarioId: user.id,
          vendedorId: sellerSession?.id || null,
          sedeId: user.sedeId,
          valor: transactionValue,
          metodoPago,
          observacion: abonoObservation,
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

      const txAbonos = await tx.creditoAbono.findMany({
        where: {
          creditoId: credit.id,
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
      const txPlan = earlyPayoffInTx
        ? null
        : buildCreditPaymentPlan({
            montoCredito: Number(lockedCredit.montoCredito || 0),
            valorCuota: Number(lockedCredit.valorCuota || 0),
            plazoMeses: Number(lockedCredit.plazoMeses || 1),
            frecuenciaPago: lockedCredit.frecuenciaPago,
            fechaPrimerPago:
              lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
            abonos: txAbonos.map((item) => ({
              valor: Number(item.valor || 0),
              fechaAbono: item.fechaAbono,
            })),
          });
      const paymentCompletesCredit = Boolean(
        earlyPayoffInTx || (txPlan && txPlan.saldoPendiente <= 0)
      );
      const settlementIssuedAt = paymentCompletesCredit ? new Date() : null;
      const nextPaymentDate = paymentCompletesCredit
        ? null
        : resolveNextPaymentDateAfterPayment({
            afterPayment: txPlan?.nextInstallment || null,
            beforePayment: lockedPlan.nextInstallment,
            currentNextPaymentDate: lockedCredit.fechaProximoPago,
          });

      await tx.credito.update({
        where: { id: credit.id },
        data: earlyPayoffInTx
          ? {
              bloqueoMora: false,
              bloqueoMoraAt: null,
              estado: resolveCreditState({
                pazYSalvoEmitidoAt: settlementIssuedAt,
              }),
              fechaProximoPago: null,
              montoCredito: earlyPayoffInTx.montoCreditoLiquidado,
              observacionAdmin: [
                lockedCredit.observacionAdmin,
                `Liquidacion anticipada manual. Condonado intereses/fianza ${earlyPayoffInTx.interesFianzaCondonado}.`,
              ]
                .filter(Boolean)
                .join("\n"),
              pazYSalvoEmitidoAt: settlementIssuedAt,
              valorFianza: earlyPayoffInTx.valorFianzaReconocida,
              valorInteres: earlyPayoffInTx.valorInteresReconocido,
            }
          : paymentCompletesCredit
            ? {
                bloqueoMora: false,
                bloqueoMoraAt: null,
                estado: resolveCreditState({
                  pazYSalvoEmitidoAt: settlementIssuedAt,
                }),
                fechaProximoPago: null,
                pazYSalvoEmitidoAt: settlementIssuedAt,
              }
          : {
              fechaProximoPago: nextPaymentDate,
            },
      });

      await tx.cajaMovimiento.create({
        data: {
          tipo: "INGRESO",
          concepto: creditCajaConcept(metodoPago),
          valor: transactionValue,
          descripcion: creditCajaDescription({
            id: created.id,
            creditoFolio: lockedCredit.folio,
            clienteNombre: lockedCredit.clienteNombre,
            metodoPago,
            observacion: abonoObservation || observacion,
          }),
          sedeId: user.sedeId,
        },
      });

      return {
        finalized: paymentCompletesCredit,
        payment: created,
        plan: txPlan,
      };
    });

    const payment = paymentResult.payment;
    let finalizationUnlock: Awaited<
      ReturnType<typeof processDeviceUnlockCommand>
    > | null = null;

    if (paymentResult.finalized) {
      try {
        const unlockCommand = await enqueueUnlockForCurrentCredit({
          commandKey: `MANUAL_PAYMENT:${credit.id}:${payment.id}`,
          creditoId: credit.id,
          source: earlyPayoffRequested ? "MANUAL_PAYOFF" : "MANUAL_PAYMENT",
          sourceReference: credit.folio,
        });

        if (unlockCommand && unlockCommand.status !== "CONFIRMED") {
          finalizationUnlock = await processDeviceUnlockCommand(unlockCommand.id);
        }
      } catch (error) {
        console.error("ERROR ENCOLANDO DESBLOQUEO DE CREDITO FINALIZADO:", error);
      }
    }

    let updatedCredit: LoadedCredit | null = null;
    let summary: Awaited<ReturnType<typeof loadPaymentSummary>> | null = null;
    let plan: PaymentPlan | null = null;

    try {
      updatedCredit = await loadCredit(credit.id, creditAccessWhere);
    } catch (error) {
      console.error("ERROR RECARGANDO CREDITO DESPUES DEL ABONO:", error);
    }

    try {
      summary = await loadPaymentSummary(
        credit.id,
        Number((updatedCredit || credit).montoCredito || 0),
        Number((updatedCredit || credit).cuotaInicial || 0)
      );
    } catch (error) {
      console.error("ERROR RECARGANDO RESUMEN DESPUES DEL ABONO:", error);
    }

    try {
      plan = await loadPaymentPlan(updatedCredit || credit);
    } catch (error) {
      console.error("ERROR RECARGANDO PLAN DESPUES DEL ABONO:", error);
    }

    const responsePlan = plan || paymentResult.plan;
    const paymentValue = Number(payment.valor || 0);
    const fallbackTotalPaid = Number(currentSummary.totalAbonado || 0) + paymentValue;
    const responseSummary = summary || {
      ...currentSummary,
      abonosCount: Number(currentSummary.abonosCount || 0) + 1,
      saldoPendiente: paymentResult.finalized
        ? 0
        : Math.max(0, Number(currentSummary.saldoPendiente || 0) - paymentValue),
      totalAbonado: fallbackTotalPaid,
      totalRecaudado: fallbackTotalPaid,
      ultimoAbonoAt: safeIsoDate(payment.fechaAbono),
    };
    const automation = paymentResult.finalized
      ? {
          action: finalizationUnlock?.confirmed ? "UNLOCKED" : "QUEUED",
          credit: updatedCredit || credit,
          message: finalizationUnlock?.confirmed
            ? "Credito finalizado y desbloqueo confirmado."
            : "Credito finalizado; el desbloqueo quedo en conciliacion automatica.",
          remote: null,
        }
      : updatedCredit && responsePlan
        ? await syncMoraAutomation(updatedCredit, responsePlan)
        : {
            action: "UNCHANGED" as const,
            credit: updatedCredit || credit,
            message:
              "Abono confirmado; la actualizacion operativa se conciliara en la siguiente consulta.",
            remote: null,
          };

    return NextResponse.json({
      ok: true,
      message:
        paymentResult.finalized
          ? "Pago registrado. El credito quedo finalizado y con paz y salvo."
          : automation.action === "UNLOCKED"
            ? "Abono registrado y mora desbloqueada automaticamente."
            : "Abono registrado correctamente.",
      item: serializePayment(payment),
      summary: {
        ...responseSummary,
        estadoPago: responsePlan?.estadoPago || "AL_DIA",
        nextInstallment: responsePlan?.nextInstallment || null,
        overdueCount: responsePlan?.overdueCount || 0,
        paidCount: responsePlan?.paidCount || 0,
        pendingCount: responsePlan?.pendingCount || 0,
        plan: responsePlan?.installments || [],
      },
      automation: serializeAutomationResult(automation),
    });
  } catch (error) {
    console.error("ERROR REGISTRANDO ABONO DE CREDITO:", error);

    if (error instanceof CreditPaymentConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    return NextResponse.json(
      { error: "No se pudo registrar el abono del credito" },
      { status: 500 }
    );
  }
}
