import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import {
  calculateCreditCharges,
  calculateFinancedBalance,
  calculateRequiredInitialPayment,
  calculateInstallmentValue,
  DEFAULT_CREDIT_INSTALLMENTS,
  extendDays,
  generateCreditFolio,
  generatePagareNumber,
  generatePaymentReference,
  getDefaultFirstPaymentDateObject,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  normalizePaymentFrequency,
  resolveCreditPaymentSummary,
  resolveCreditState,
  sanitizeDeviceValue,
  sanitizeImageDataUrl,
  sanitizeSearch,
  sanitizeText,
  sanitizeVideoDataUrl,
  toNullableDate,
  toNumber,
} from "@/lib/credit-factory";
import {
  getEqualityDeviceMeta,
  getPayloadSummary,
} from "@/lib/equality-device-meta";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  activateEqualityFinancingService,
  isEqualityApiError,
  isEqualityConfigured,
  queryEqualityDevices,
  uploadEqualityInventoryDevice,
} from "@/lib/equality-zero-touch";
import { getCreditSettings } from "@/lib/credit-settings";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { findEquipmentCatalogItem } from "@/lib/equipment-catalog";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOW_TEST_CREDIT_CLOSE_WITHOUT_DELIVERY_VALIDATION = false;

const CONTRACT_TEMPLATE_TITLE =
  "CONTRATO DE FINANCIACION DE EQUIPO MOVIL, AUTORIZACION DE TRATAMIENTO DE DATOS Y USO DE HERRAMIENTAS TECNOLOGICAS";
const CONTRACT_CLAUSE_LABELS = [
  "1. OBJETO",
  "2. CONDICIONES DEL CREDITO",
  "3. NATURALEZA DEL CONTRATO",
  "4. AUTORIZACION DE TRATAMIENTO DE DATOS",
  "5. AUTORIZACION DE HERRAMIENTAS TECNOLOGICAS",
  "6. DECLARACIONES DEL DEUDOR",
  "7. MERITO EJECUTIVO",
  "8. FIRMA ELECTRONICA",
  "9. JURISDICCION",
  "10. ACEPTACION",
];
const PAGARE_TEMPLATE_TITLE = "PAGARE";
const PAGARE_CLAUSE_LABELS = [
  "1. FORMA DE PAGO",
  "2. VENCIMIENTO ANTICIPADO",
  "3. INTERESES",
  "4. MERITO EJECUTIVO",
  "5. RENUNCIA A REQUERIMIENTOS",
  "6. GASTOS DE COBRANZA",
  "7. FIRMA ELECTRONICA",
  "8. LUGAR DE CUMPLIMIENTO",
  "9. FECHA DE EMISION",
];
const INSTRUCTION_LETTER_TITLE = "CARTA DE INSTRUCCIONES PARA DILIGENCIAMIENTO DE PAGARE";
const INSTRUCTION_LETTER_CLAUSE_LABELS = [
  "1. VALOR",
  "2. FECHAS",
  "3. VENCIMIENTO ANTICIPADO",
  "4. ESPACIOS EN BLANCO",
  "5. USO JUDICIAL",
  "6. IRREVOCABILIDAD",
  "7. ACEPTACION ELECTRONICA",
  "8. FECHA",
];
const DATA_AUTHORIZATION_TITLE =
  "AUTORIZACION PARA EL TRATAMIENTO DE DATOS PERSONALES";
const DATA_AUTHORIZATION_CLAUSE_LABELS = [
  "1. FINALIDAD DEL TRATAMIENTO",
  "2. DATOS TRATADOS",
  "3. CENTRALES DE RIESGO",
  "4. DERECHOS DEL TITULAR",
  "5. MEDIDAS DE SEGURIDAD",
  "6. TRANSFERENCIA Y TRANSMISION",
  "7. VIGENCIA",
  "8. ACEPTACION ELECTRONICA",
  "9. FECHA DE AUTORIZACION",
];

type CreditCreateBody = {
  clienteCiudad?: string;
  clienteCorreo?: string;
  clienteDepartamento?: string;
  clienteDireccion?: string;
  clienteDocumento?: string;
  clienteFechaExpedicion?: string;
  clienteFechaNacimiento?: string;
  clienteGenero?: string;
  clienteNombre?: string;
  clientePrimerApellido?: string;
  clientePrimerNombre?: string;
  clienteTelefono?: string;
  clienteTipoDocumento?: string;
  referenciaFamiliar1Nombre?: string;
  referenciaFamiliar1Parentesco?: string;
  referenciaFamiliar1Telefono?: string;
  referenciaFamiliar2Nombre?: string;
  referenciaFamiliar2Parentesco?: string;
  referenciaFamiliar2Telefono?: string;
  autorizacionDatosAceptada?: boolean;
  cartaAceptada?: boolean;
  contratoAceptado?: boolean;
  contratoCedulaFrenteCapturedAt?: string;
  contratoCedulaFrenteDataUrl?: string;
  contratoCedulaFrenteSource?: string;
  contratoCedulaRespaldoCapturedAt?: string;
  contratoCedulaRespaldoDataUrl?: string;
  contratoCedulaRespaldoSource?: string;
  contratoFirmaDataUrl?: string;
  contratoFotoDataUrl?: string;
  contratoOtpCanal?: string;
  contratoOtpDestino?: string;
  contratoOtpVerificadoAt?: string;
  contratoSelfieCapturedAt?: string;
  contratoSelfieDataUrl?: string;
  contratoSelfieSource?: string;
  contratoVideoAprobacionCapturedAt?: string;
  contratoVideoAprobacionDataUrl?: string;
  contratoVideoAprobacionDurationSeconds?: number | string;
  contratoVideoAprobacionSource?: string;
  cuotaInicial?: number | string;
  deviceUid?: string;
  equipoMarca?: string;
  equipoModelo?: string;
  equipoCatalogoId?: number | string;
  fianzaPorcentaje?: number | string;
  fechaPrimerPago?: string;
  frecuenciaPago?: string;
  imei?: string;
  montoCredito?: number | string;
  pagareAceptado?: boolean;
  plazoMeses?: number | string;
  referenciaEquipo?: string;
  tasaInteresEa?: number | string;
  valorEquipoTotal?: number | string;
};

type PaymentAggregate = {
  abonosCount: number;
  totalAbonado: number;
  ultimoAbonoAt: Date | null;
};

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

function serializeCredit(item: any, paymentMap?: Map<number, PaymentAggregate>) {
  const payment = paymentMap?.get(item.id) || {
    abonosCount: 0,
    totalAbonado: 0,
    ultimoAbonoAt: null,
  };
  const paymentSummary = resolveCreditPaymentSummary({
    montoCredito: item.montoCredito,
    cuotaInicial: item.cuotaInicial,
    totalAbonado: payment.totalAbonado,
    abonosCount: payment.abonosCount,
  });
  const paymentPlan = buildCreditPaymentPlan({
    montoCredito: Number(item.montoCredito || 0),
    valorCuota: Number(item.valorCuota || 0),
    plazoMeses: Number(item.plazoMeses || 1),
    frecuenciaPago: item.frecuenciaPago,
    fechaPrimerPago: item.fechaPrimerPago || item.fechaProximoPago,
    abonos: payment.totalAbonado > 0 ? [{ valor: payment.totalAbonado }] : [],
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
    totalAbonado: paymentSummary.totalAbonado,
    saldoPendiente: paymentSummary.saldoPendiente,
    totalRecaudado: paymentSummary.totalRecaudado,
    porcentajeRecaudado: paymentSummary.porcentajeRecaudado,
    estadoPago: paymentPlan.estadoPago,
    cuotasPagadas: paymentPlan.paidCount,
    cuotasPendientes: paymentPlan.pendingCount,
    cuotasEnMora: paymentPlan.overdueCount,
    abonosCount: paymentSummary.abonosCount,
    ultimoAbonoAt: payment.ultimoAbonoAt?.toISOString() || null,
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

function parseTake(value: string | null) {
  const numeric = Number(value || 15);

  if (!Number.isFinite(numeric)) {
    return 15;
  }

  return Math.max(1, Math.min(50, Math.trunc(numeric)));
}

function extractRequestIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for");

  if (forwarded) {
    const first = forwarded
      .split(",")
      .map((item) => item.trim())
      .find(Boolean);

    if (first) {
      return first;
    }
  }

  return req.headers.get("x-real-ip") || "No disponible";
}

async function buildPaymentSummaryMap(creditIds: number[]) {
  const map = new Map<number, PaymentAggregate>();
  await ensureCreditAbonoAuditColumns();

  if (!creditIds.length) {
    return map;
  }

  const grouped = await prisma.creditoAbono.groupBy({
    by: ["creditoId"],
    where: {
      creditoId: {
        in: creditIds,
      },
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

  for (const item of grouped) {
    map.set(item.creditoId, {
      abonosCount: item._count._all,
      totalAbonado: Number(item._sum.valor || 0),
      ultimoAbonoAt: item._max.fechaAbono || null,
    });
  }

  return map;
}

function getCreditPendingBalance(item: any, payment?: PaymentAggregate) {
  return resolveCreditPaymentSummary({
    montoCredito: item.montoCredito,
    cuotaInicial: item.cuotaInicial,
    totalAbonado: Number(payment?.totalAbonado || 0),
    abonosCount: Number(payment?.abonosCount || 0),
  }).saldoPendiente;
}

async function runBusinessSafe<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (isEqualityApiError(error) && [400, 404, 409].includes(error.status)) {
      return error.payload as T;
    }

    throw error;
  }
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const take = parseTake(searchParams.get("take"));
    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const search = sanitizeSearch(searchParams.get("search"));
    const searchDigits = search.replace(/\D/g, "");

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    if (!admin && sellerSession?.tipoPerfil !== "SUPERVISOR" && !search) {
      return NextResponse.json({
        canAdmin: false,
        scope: "vendedor",
        search,
        items: [],
      });
    }

    const scopeWhere: Prisma.CreditoWhereInput = admin ? {} : { sedeId: user.sedeId };
    const searchOr: Prisma.CreditoWhereInput[] = search
      ? [
          { clienteNombre: { contains: search, mode: "insensitive" } },
          { clienteDocumento: { contains: search, mode: "insensitive" } },
          { clienteTelefono: { contains: search, mode: "insensitive" } },
          { clienteDireccion: { contains: search, mode: "insensitive" } },
          { folio: { contains: search, mode: "insensitive" } },
          { imei: { contains: search, mode: "insensitive" } },
          { deviceUid: { contains: search, mode: "insensitive" } },
          { referenciaEquipo: { contains: search, mode: "insensitive" } },
          { equipoMarca: { contains: search, mode: "insensitive" } },
          { equipoModelo: { contains: search, mode: "insensitive" } },
          { vendedor: { nombre: { contains: search, mode: "insensitive" } } },
        ]
      : [];

    if (searchDigits.length >= 3 && searchDigits !== search) {
      searchOr.push(
        { clienteDocumento: { contains: searchDigits, mode: "insensitive" } },
        { clienteTelefono: { contains: searchDigits, mode: "insensitive" } },
        { imei: { contains: searchDigits, mode: "insensitive" } },
        { deviceUid: { contains: searchDigits, mode: "insensitive" } }
      );
    }
    const where: Prisma.CreditoWhereInput = search
      ? {
          AND: [
            scopeWhere,
            {
              OR: searchOr,
            },
          ],
        }
      : scopeWhere;

    const items = await prisma.credito.findMany({
      where,
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
      orderBy: {
        createdAt: "desc",
      },
      take,
    });
    const paymentMap = await buildPaymentSummaryMap(items.map((item) => item.id));

    return NextResponse.json({
      canAdmin: admin,
      scope: admin ? "global" : "sede",
      search,
      items: items.map((item) => serializeCredit(item, paymentMap)),
    });
  } catch (error) {
    console.error("ERROR LISTANDO CREDITOS:", error);
    return NextResponse.json(
      { error: "No se pudieron cargar los creditos" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    const body = (await req.json()) as CreditCreateBody;
    const clientePrimerNombre = sanitizeText(body.clientePrimerNombre);
    const clientePrimerApellido = sanitizeText(body.clientePrimerApellido);
    const clienteTipoDocumento = sanitizeText(body.clienteTipoDocumento);
    const clienteDireccion = sanitizeText(body.clienteDireccion);
    const clienteNombre = sanitizeText(body.clienteNombre);
    const clienteDocumento = sanitizeText(body.clienteDocumento);
    const clienteFechaNacimiento = toNullableDate(body.clienteFechaNacimiento);
    const clienteFechaExpedicion = toNullableDate(body.clienteFechaExpedicion);
    const clienteTelefono = sanitizeText(body.clienteTelefono);
    const clienteCorreo = sanitizeText(body.clienteCorreo);
    const clienteDepartamento = sanitizeText(body.clienteDepartamento);
    const clienteCiudad = sanitizeText(body.clienteCiudad);
    const clienteGenero = sanitizeText(body.clienteGenero);
    const referenciaFamiliar1Nombre = sanitizeText(body.referenciaFamiliar1Nombre);
    const referenciaFamiliar1Parentesco = sanitizeText(
      body.referenciaFamiliar1Parentesco
    );
    const referenciaFamiliar1Telefono = sanitizeText(body.referenciaFamiliar1Telefono);
    const referenciaFamiliar2Nombre = sanitizeText(body.referenciaFamiliar2Nombre);
    const referenciaFamiliar2Parentesco = sanitizeText(
      body.referenciaFamiliar2Parentesco
    );
    const referenciaFamiliar2Telefono = sanitizeText(body.referenciaFamiliar2Telefono);
    const clienteNombreFinal =
      sanitizeText([clientePrimerNombre, clientePrimerApellido].filter(Boolean).join(" ")) ||
      clienteNombre;
    const equipoMarca = sanitizeText(body.equipoMarca);
    const equipoModelo = sanitizeText(body.equipoModelo);
    const referenciaEquipo = sanitizeText(
      body.referenciaEquipo || [equipoMarca, equipoModelo].filter(Boolean).join(" ")
    );
    const imei = sanitizeDeviceValue(body.imei || body.deviceUid).replace(/\D/g, "").slice(0, 15);
    const deviceUid = sanitizeDeviceValue(body.deviceUid || body.imei)
      .replace(/\D/g, "")
      .slice(0, 15);
    const valorEquipoTotalInput = toNumber(body.valorEquipoTotal);
    const catalogItem =
      equipoMarca && equipoModelo
        ? await findEquipmentCatalogItem({ marca: equipoMarca, modelo: equipoModelo })
        : null;
    const precioBaseVentaCatalogo = catalogItem?.activo
      ? catalogItem.precioBaseVenta
      : null;
    const cuotaInicial = calculateRequiredInitialPayment(
      valorEquipoTotalInput,
      precioBaseVentaCatalogo
    );
    const creditSettings = await getCreditSettings();
    const plazoMesesInput = Math.trunc(toNumber(body.plazoMeses));
    const plazoMaximoCuotas = normalizeCreditInstallmentLimit(
      creditSettings.plazoMaximoCuotas
    );
    const plazoMeses = normalizeCreditInstallments(
      plazoMesesInput,
      creditSettings.plazoCuotas || DEFAULT_CREDIT_INSTALLMENTS,
      plazoMaximoCuotas
    );
    const frecuenciaPago = normalizePaymentFrequency(
      body.frecuenciaPago || creditSettings.frecuenciaPago
    );
    const fechaPrimerPago =
      toNullableDate(body.fechaPrimerPago) || getDefaultFirstPaymentDateObject(frecuenciaPago);
    const contratoAceptado = Boolean(body.contratoAceptado);
    const contratoFirmaDataUrl = sanitizeImageDataUrl(body.contratoFirmaDataUrl);
    const contratoFotoDataUrl = sanitizeImageDataUrl(
      body.contratoSelfieDataUrl || body.contratoFotoDataUrl
    );
    const contratoSelfieDataUrl = contratoFotoDataUrl;
    const contratoCedulaFrenteDataUrl = sanitizeImageDataUrl(
      body.contratoCedulaFrenteDataUrl
    );
    const contratoCedulaRespaldoDataUrl = sanitizeImageDataUrl(
      body.contratoCedulaRespaldoDataUrl
    );
    const contratoOtpCanal = sanitizeText(body.contratoOtpCanal);
    const contratoOtpDestino = sanitizeText(body.contratoOtpDestino || clienteTelefono);
    const contratoOtpVerificadoAt = toNullableDate(body.contratoOtpVerificadoAt);
    const contratoVideoAprobacionDataUrl = sanitizeVideoDataUrl(
      body.contratoVideoAprobacionDataUrl
    );
    const contratoVideoAprobacionDurationSeconds = Math.max(
      0,
      Math.round(toNumber(body.contratoVideoAprobacionDurationSeconds))
    );
    const pagareAceptado = Boolean(body.pagareAceptado);
    const cartaAceptada = Boolean(body.cartaAceptada);
    const autorizacionDatosAceptada = Boolean(body.autorizacionDatosAceptada);
    const montoCreditoInput = toNumber(body.montoCredito);
    const saldoBaseFinanciado = calculateFinancedBalance(valorEquipoTotalInput, cuotaInicial);
    const financialPlan = calculateCreditCharges({
      saldoBaseFinanciado:
        saldoBaseFinanciado > 0 ? saldoBaseFinanciado : montoCreditoInput,
      cuotas: plazoMeses,
      tasaInteresEa: creditSettings.tasaInteresEa,
      fianzaPorcentaje: creditSettings.fianzaPorcentaje,
      frecuenciaPago,
    });
    const montoCredito =
      financialPlan.montoCreditoTotal > 0
        ? financialPlan.montoCreditoTotal
        : calculateFinancedBalance(valorEquipoTotalInput, cuotaInicial);
    const valorEquipoTotal =
      valorEquipoTotalInput > 0
        ? valorEquipoTotalInput
        : financialPlan.saldoBaseFinanciado + cuotaInicial;
    const valorCuota =
      financialPlan.valorCuota > 0
        ? financialPlan.valorCuota
        : calculateInstallmentValue(montoCredito, plazoMeses);
    const folio = generateCreditFolio();
    const pagareNumero = generatePagareNumber(folio);
    const referenciaPago = generatePaymentReference(folio, clienteDocumento);
    const contratoAceptadoAt = new Date();
    const contratoIp = extractRequestIp(req);
    const contratoSelfieCapturedAt =
      toNullableDate(body.contratoSelfieCapturedAt)?.toISOString() ||
      contratoAceptadoAt.toISOString();
    const contratoSelfieSource =
      sanitizeText(body.contratoSelfieSource).toLowerCase() === "camera"
        ? "camera"
        : "upload";
    const contratoCedulaFrenteCapturedAt =
      toNullableDate(body.contratoCedulaFrenteCapturedAt)?.toISOString() ||
      contratoAceptadoAt.toISOString();
    const contratoCedulaFrenteSource =
      sanitizeText(body.contratoCedulaFrenteSource).toLowerCase() === "camera"
        ? "camera"
        : "upload";
    const contratoCedulaRespaldoCapturedAt =
      toNullableDate(body.contratoCedulaRespaldoCapturedAt)?.toISOString() ||
      contratoAceptadoAt.toISOString();
    const contratoCedulaRespaldoSource =
      sanitizeText(body.contratoCedulaRespaldoSource).toLowerCase() === "camera"
        ? "camera"
        : "upload";
    const contratoVideoAprobacionCapturedAt =
      toNullableDate(body.contratoVideoAprobacionCapturedAt)?.toISOString() ||
      contratoAceptadoAt.toISOString();
    const contratoVideoAprobacionSource =
      sanitizeText(body.contratoVideoAprobacionSource).toLowerCase() === "camera"
        ? "camera"
        : "upload";

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    if (!clientePrimerNombre) {
      return NextResponse.json(
        { error: "Debes ingresar el primer nombre del cliente" },
        { status: 400 }
      );
    }

    if (!clientePrimerApellido) {
      return NextResponse.json(
        { error: "Debes ingresar el primer apellido del cliente" },
        { status: 400 }
      );
    }

    if (!clienteNombreFinal) {
      return NextResponse.json(
        { error: "Debes ingresar el nombre del cliente" },
        { status: 400 }
      );
    }

    if (!clienteTipoDocumento) {
      return NextResponse.json(
        { error: "Debes seleccionar el tipo de documento" },
        { status: 400 }
      );
    }

    if (!clienteDocumento) {
      return NextResponse.json(
        { error: "Debes ingresar la cedula del cliente" },
        { status: 400 }
      );
    }

    if (!clienteTelefono) {
      return NextResponse.json(
        { error: "Debes ingresar el telefono del cliente" },
        { status: 400 }
      );
    }

    if (!clienteDireccion) {
      return NextResponse.json(
        { error: "Debes ingresar la direccion del cliente" },
        { status: 400 }
      );
    }

    if (!clienteFechaNacimiento) {
      return NextResponse.json(
        { error: "Debes ingresar la fecha de nacimiento del cliente" },
        { status: 400 }
      );
    }

    if (!clienteFechaExpedicion) {
      return NextResponse.json(
        { error: "Debes ingresar la fecha de expedicion de la cedula" },
        { status: 400 }
      );
    }

    if (!clienteCorreo) {
      return NextResponse.json(
        { error: "Debes ingresar el correo electronico del cliente" },
        { status: 400 }
      );
    }

    if (!clienteDepartamento) {
      return NextResponse.json(
        { error: "Debes seleccionar el departamento del cliente" },
        { status: 400 }
      );
    }

    if (!clienteCiudad) {
      return NextResponse.json(
        { error: "Debes seleccionar la ciudad del cliente" },
        { status: 400 }
      );
    }

    if (!clienteGenero) {
      return NextResponse.json(
        { error: "Debes seleccionar el genero del cliente" },
        { status: 400 }
      );
    }

    if (!referenciaFamiliar1Nombre || !referenciaFamiliar1Parentesco || !referenciaFamiliar1Telefono) {
      return NextResponse.json(
        { error: "Debes registrar la primera referencia familiar" },
        { status: 400 }
      );
    }

    if (!referenciaFamiliar2Nombre || !referenciaFamiliar2Parentesco || !referenciaFamiliar2Telefono) {
      return NextResponse.json(
        { error: "Debes registrar la segunda referencia familiar" },
        { status: 400 }
      );
    }

    if (clienteFechaNacimiento > new Date()) {
      return NextResponse.json(
        { error: "La fecha de nacimiento no puede estar en el futuro" },
        { status: 400 }
      );
    }

    if (clienteFechaExpedicion < clienteFechaNacimiento) {
      return NextResponse.json(
        {
          error:
            "La fecha de expedicion no puede ser anterior a la fecha de nacimiento",
        },
        { status: 400 }
      );
    }

    if (!imei || !deviceUid) {
      return NextResponse.json(
        { error: "Debes ingresar un IMEI o deviceUid valido" },
        { status: 400 }
      );
    }

    if (!/^\d{15}$/.test(imei) || !/^\d{15}$/.test(deviceUid)) {
      return NextResponse.json(
        { error: "El IMEI debe tener exactamente 15 numeros" },
        { status: 400 }
      );
    }

    const soldDevice = await prisma.credito.findFirst({
      where: {
        estado: {
          not: "ANULADO",
        },
        OR: [{ imei }, { deviceUid }],
      },
      select: {
        id: true,
        folio: true,
        imei: true,
        deviceUid: true,
      },
    });

    if (soldDevice) {
      return NextResponse.json(
        {
          error: `Este IMEI/deviceUid ya fue vendido en el credito ${soldDevice.folio}. No se puede crear otra venta con el mismo equipo.`,
        },
        { status: 400 }
      );
    }

    const clientCredits = await prisma.credito.findMany({
      where: {
        clienteDocumento,
        estado: {
          not: "ANULADO",
        },
      },
      select: {
        id: true,
        folio: true,
        montoCredito: true,
        cuotaInicial: true,
      },
    });

    if (clientCredits.length) {
      const clientPaymentMap = await buildPaymentSummaryMap(
        clientCredits.map((item) => item.id)
      );
      const activeCredit = clientCredits.find(
        (item) => getCreditPendingBalance(item, clientPaymentMap.get(item.id)) > 0
      );

      if (activeCredit) {
        return NextResponse.json(
          {
            error: `La cedula ya tiene saldo vigente en el credito ${activeCredit.folio}. Solo puedes crear una nueva venta cuando el saldo este en $0.`,
          },
          { status: 400 }
        );
      }
    }

    if (!equipoMarca || !equipoModelo) {
      return NextResponse.json(
        { error: "Debes ingresar la marca y el modelo del equipo" },
        { status: 400 }
      );
    }

    if (valorEquipoTotal <= 0) {
      return NextResponse.json(
        { error: "Debes ingresar el valor total del equipo" },
        { status: 400 }
      );
    }

    if (cuotaInicial < 0 || cuotaInicial > valorEquipoTotal) {
      return NextResponse.json(
        { error: "La cuota inicial no puede superar el valor total del equipo" },
        { status: 400 }
      );
    }

    if (montoCredito <= 0) {
      return NextResponse.json(
        { error: "El saldo financiado debe ser mayor a 0" },
        { status: 400 }
      );
    }

    if (plazoMeses <= 0) {
      return NextResponse.json(
        { error: "Debes indicar el numero de cuotas" },
        { status: 400 }
      );
    }

    if (!contratoAceptado) {
      return NextResponse.json(
        { error: "Debes confirmar la aceptacion del contrato digital" },
        { status: 400 }
      );
    }

    if (!contratoFotoDataUrl) {
      return NextResponse.json(
        { error: "Debes tomar la selfie del cliente para el contrato" },
        { status: 400 }
      );
    }

    if (!contratoCedulaFrenteDataUrl || !contratoCedulaRespaldoDataUrl) {
      return NextResponse.json(
        { error: "Debes capturar la cedula por ambos lados" },
        { status: 400 }
      );
    }

    if (!contratoVideoAprobacionDataUrl) {
      return NextResponse.json(
        { error: "Debes registrar el video de aprobacion del cliente" },
        { status: 400 }
      );
    }

    if (!contratoFirmaDataUrl) {
      return NextResponse.json(
        { error: "Debes capturar la firma digital del cliente" },
        { status: 400 }
      );
    }

    if (!pagareAceptado) {
      return NextResponse.json(
        { error: "Debes validar el pagare digital antes de finalizar la venta" },
        { status: 400 }
      );
    }

    if (!cartaAceptada) {
      return NextResponse.json(
        { error: "Debes confirmar la carta de instrucciones antes de finalizar" },
        { status: 400 }
      );
    }

    if (!autorizacionDatosAceptada) {
      return NextResponse.json(
        { error: "Debes aceptar la autorizacion de tratamiento de datos" },
        { status: 400 }
      );
    }

    const allowPendingDeliveryClose =
      ALLOW_TEST_CREDIT_CLOSE_WITHOUT_DELIVERY_VALIDATION;

    if (!isEqualityConfigured() && !allowPendingDeliveryClose) {
      return NextResponse.json(
        {
          error:
            "No se puede finalizar el credito porque Zero Touch no esta configurado.",
        },
        { status: 503 }
      );
    }

    let equalityUpload: unknown = null;
    let equalityActivate: unknown = null;
    let equalityQuery: unknown = null;
    let equalitySummary:
      | ReturnType<typeof getPayloadSummary>
      | null = null;
    let equalityMeta:
      | ReturnType<typeof getEqualityDeviceMeta>
      | null = null;

    if (isEqualityConfigured()) {
      try {
        equalityUpload = await runBusinessSafe(() =>
          uploadEqualityInventoryDevice(deviceUid)
        );
        equalityActivate = await runBusinessSafe(() =>
          activateEqualityFinancingService(deviceUid)
        );
        equalityQuery = await runBusinessSafe(() => queryEqualityDevices(deviceUid));
        equalitySummary = getPayloadSummary(equalityQuery);
        equalityMeta = getEqualityDeviceMeta(equalityQuery);
      } catch (error) {
        console.error("ERROR VALIDANDO ENTREGABILIDAD EN ZERO TOUCH:", error);

        if (!allowPendingDeliveryClose) {
          if (isEqualityApiError(error)) {
            return NextResponse.json(
              {
                error: `Zero Touch no confirmo la entregabilidad: ${error.message}`,
                remoteStatus: error.status,
                remotePayload: error.payload,
              },
              { status: error.status >= 500 ? 502 : error.status }
            );
          }

          return NextResponse.json(
            {
              error:
                "No se pudo validar la entregabilidad del dispositivo antes de crear el credito.",
            },
            { status: 502 }
          );
        }
      }
    }

    if (!equalityMeta?.deliveryStatus?.ready && !allowPendingDeliveryClose) {
      return NextResponse.json(
        {
          error:
            equalityMeta?.deliveryStatus?.detail ||
            "Zero Touch no reporta el equipo como entregable.",
          deliveryStatus: equalityMeta?.deliveryStatus || null,
          equality: equalitySummary && equalityMeta
            ? {
                upload: equalityUpload,
                activate: equalityActivate,
                query: equalityQuery,
                ...equalitySummary,
                ...equalityMeta,
              }
            : null,
        },
        { status: 409 }
      );
    }
    const pendingDeliveryWarning =
      allowPendingDeliveryClose && !equalityMeta?.deliveryStatus?.ready
        ? "Credito creado en modo prueba: la validacion final de entrega quedo pendiente."
        : undefined;

    const contratoSnapshot = {
      template: {
        codigo: "FINSER_CONTRATO_FINANCIACION_EQUIPO_DATOS_HERRAMIENTAS_V3",
        titulo: CONTRACT_TEMPLATE_TITLE,
        vigenteDesde: "2026-04-21",
      },
      cliente: {
        nombre: clienteNombreFinal,
        primerNombre: clientePrimerNombre,
        primerApellido: clientePrimerApellido,
        tipoDocumento: clienteTipoDocumento,
        cedula: clienteDocumento,
        telefono: clienteTelefono,
        correo: clienteCorreo,
        direccion: clienteDireccion,
        departamento: clienteDepartamento,
        ciudad: clienteCiudad,
        genero: clienteGenero,
        fechaNacimiento: clienteFechaNacimiento.toISOString(),
        fechaExpedicion: clienteFechaExpedicion.toISOString(),
        referenciasFamiliares: [
          {
            nombre: referenciaFamiliar1Nombre,
            parentesco: referenciaFamiliar1Parentesco,
            telefono: referenciaFamiliar1Telefono,
          },
          {
            nombre: referenciaFamiliar2Nombre,
            parentesco: referenciaFamiliar2Parentesco,
            telefono: referenciaFamiliar2Telefono,
          },
        ],
      },
      equipo: {
        marca: equipoMarca,
        modelo: equipoModelo,
        imei,
        catalogoId: catalogItem?.id || null,
        precioBaseVenta: precioBaseVentaCatalogo,
        excedentePrecioBase: precioBaseVentaCatalogo
          ? Math.max(0, valorEquipoTotal - precioBaseVentaCatalogo)
          : 0,
      },
      financiero: {
        cuotaInicial,
        saldoBaseFinanciado: financialPlan.saldoBaseFinanciado,
        saldoFinanciado: montoCredito,
        totalFianzaPagar: financialPlan.valorFianza,
        tasaInteresEa: financialPlan.tasaInteresEa,
        valorInteres: financialPlan.valorInteres,
        fianzaPorcentaje: financialPlan.fianzaPorcentaje,
        valorFianza: financialPlan.valorFianza,
        valorCuota,
        valorTotalEquipo: valorEquipoTotal,
        cuotas: plazoMeses,
        frecuenciaPago,
        fechaPrimerPago: fechaPrimerPago.toISOString(),
      },
      financiador: {
        domicilio: "Ibague - Tolima",
        nit: "902052909-4",
        razonSocial: "FINSER PAY S.A.S.",
      },
      firma: {
        fechaHora: contratoAceptadoAt.toISOString(),
        ip: contratoIp,
      },
      evidencia: {
        selfieRegistrada: Boolean(contratoSelfieDataUrl),
        cedulaFrenteRegistrada: Boolean(contratoCedulaFrenteDataUrl),
        cedulaRespaldoRegistrada: Boolean(contratoCedulaRespaldoDataUrl),
        autenticidad: {
          autenticadoCon: [
            "Correo electronico",
            "Direccion IP",
            "Fotografia",
            "Cedula frente",
            "Cedula respaldo",
            "Video de aprobacion",
            "Firma digital",
          ],
          email: clienteCorreo,
          ip: contratoIp,
          firmadoAt: contratoAceptadoAt.toISOString(),
          documento: clienteDocumento,
        },
        selfie: {
          registrada: Boolean(contratoSelfieDataUrl),
          capturedAt: contratoSelfieCapturedAt,
          source: contratoSelfieSource,
          ip: contratoIp,
          email: clienteCorreo,
        },
        cedulaFrente: {
          registrada: Boolean(contratoCedulaFrenteDataUrl),
          capturedAt: contratoCedulaFrenteCapturedAt,
          source: contratoCedulaFrenteSource,
          ip: contratoIp,
          email: clienteCorreo,
        },
        cedulaRespaldo: {
          registrada: Boolean(contratoCedulaRespaldoDataUrl),
          capturedAt: contratoCedulaRespaldoCapturedAt,
          source: contratoCedulaRespaldoSource,
          ip: contratoIp,
          email: clienteCorreo,
        },
        videoAprobacion: {
          registrado: Boolean(contratoVideoAprobacionDataUrl),
          capturedAt: contratoVideoAprobacionCapturedAt,
          source: contratoVideoAprobacionSource,
          durationSeconds: contratoVideoAprobacionDurationSeconds,
          ip: contratoIp,
          email: clienteCorreo,
          dataUrl: contratoVideoAprobacionDataUrl || null,
        },
      },
      otp: {
        canal: contratoOtpCanal || null,
        destino: contratoOtpDestino || null,
        verificadoAt: contratoOtpVerificadoAt?.toISOString() || null,
      },
      pagare: {
        numero: pagareNumero,
        titulo: PAGARE_TEMPLATE_TITLE,
        valorTotal: montoCredito,
        cuotas: plazoMeses,
        frecuenciaPago,
        valorCuota,
        fecha: contratoAceptadoAt.toISOString(),
        fechaPrimerPago: fechaPrimerPago.toISOString(),
        aceptadoAt: contratoAceptadoAt.toISOString(),
        tipoDocumento: clienteTipoDocumento,
        deudor: {
          nombre: clienteNombreFinal,
          documento: clienteDocumento,
        },
        acreedor: {
          nombre: "FINSER PAY S.A.S.",
          nit: "902052909-4",
          ciudadCumplimiento: "Ibague - Tolima",
        },
        clausulasLegacy: [
          "PRIMERA – FORMA DE PAGO",
          "SEGUNDA – VENCIMIENTO ANTICIPADO",
          "TERCERA – INTERESES",
          "CUARTA – GASTOS DE COBRANZA",
          "QUINTA – AUTORIZACION",
          "SEXTA – ESPACIOS EN BLANCO",
          "SEPTIMA – MERITO EJECUTIVO",
        ],
        clausulas: PAGARE_CLAUSE_LABELS,
      },
      cartaInstrucciones: {
        titulo: INSTRUCTION_LETTER_TITLE,
        fecha: contratoAceptadoAt.toISOString(),
        aceptadoAt: contratoAceptadoAt.toISOString(),
        confirmada: cartaAceptada,
        deudor: {
          nombre: clienteNombreFinal,
          primerNombre: clientePrimerNombre,
          primerApellido: clientePrimerApellido,
          cedula: clienteDocumento,
        },
        tipoDocumento: clienteTipoDocumento,
        pagareNumero,
        clausulas: [
          ...INSTRUCTION_LETTER_CLAUSE_LABELS,
        ],
      },
      autorizacionDatos: {
        titulo: DATA_AUTHORIZATION_TITLE,
        fecha: contratoAceptadoAt.toISOString(),
        aceptadoAt: contratoAceptadoAt.toISOString(),
        confirmada: autorizacionDatosAceptada,
        titular: {
          nombre: clienteNombreFinal,
          documento: clienteDocumento,
          tipoDocumento: clienteTipoDocumento,
        },
        clausulas: DATA_AUTHORIZATION_CLAUSE_LABELS,
      },
      clausulasLegacy: [
        "PRIMERA – OBJETO",
        "SEGUNDA – VALOR Y CONDICIONES",
        "TERCERA – MORA",
        "CUARTA – AUTORIZACION DE CONTROL DEL DISPOSITIVO",
        "QUINTA – PROPIEDAD Y GARANTIA",
        "SEXTA – AUTORIZACION DE HABEAS DATA",
        "SEPTIMA – DECLARACIONES DEL CLIENTE",
        "OCTAVA – MERITO EJECUTIVO",
        "NOVENA – VALIDEZ DIGITAL",
        "DECIMA – PRUEBA",
      ],
      clausulas: CONTRACT_CLAUSE_LABELS,
    };

    const created = await prisma.credito.create({
      data: {
        folio,
        clienteDireccion: clienteDireccion || null,
        clienteNombre: clienteNombreFinal,
        clientePrimerNombre: clientePrimerNombre || null,
        clientePrimerApellido: clientePrimerApellido || null,
        clienteTipoDocumento: clienteTipoDocumento || null,
        clienteDocumento: clienteDocumento || null,
        clienteFechaNacimiento,
        clienteFechaExpedicion,
        clienteTelefono: clienteTelefono || null,
        clienteCorreo: clienteCorreo || null,
        clienteDepartamento: clienteDepartamento || null,
        clienteCiudad: clienteCiudad || null,
        clienteGenero: clienteGenero || null,
        imei,
        deviceUid,
        referenciaEquipo: referenciaEquipo || null,
        equipoMarca: equipoMarca || null,
        equipoModelo: equipoModelo || null,
        valorEquipoTotal,
        saldoBaseFinanciado: financialPlan.saldoBaseFinanciado,
        montoCredito,
        cuotaInicial,
        plazoMeses: plazoMeses > 0 ? plazoMeses : null,
        frecuenciaPago,
        tasaInteresEa: financialPlan.tasaInteresEa,
        valorInteres: financialPlan.valorInteres,
        fianzaPorcentaje: financialPlan.fianzaPorcentaje,
        valorFianza: financialPlan.valorFianza,
        valorCuota,
        fechaPrimerPago,
        fechaProximoPago: fechaPrimerPago,
        referenciaPago,
        estado: resolveCreditState({
          deliverable: equalityMeta?.deliveryStatus,
        }),
        deliverableLabel: equalityMeta?.deliveryStatus?.label || null,
        deliverableReady: Boolean(equalityMeta?.deliveryStatus?.ready),
        equalityState: equalityMeta?.deviceState || null,
        equalityService: equalityMeta?.serviceDetails || null,
        equalityPayload: equalityQuery as Prisma.InputJsonValue,
        equalityLastCheckAt: new Date(),
        warrantyUntil: extendDays(15, null),
        contratoAceptadoAt,
        pagareAceptadoAt: contratoAceptadoAt,
        contratoIp,
        contratoFirmaDataUrl,
        contratoFotoDataUrl,
        contratoSelfieDataUrl,
        contratoCedulaFrenteDataUrl,
        contratoCedulaRespaldoDataUrl,
        contratoOtpCanal: contratoOtpCanal || null,
        contratoOtpDestino: contratoOtpDestino || null,
        contratoOtpVerificadoAt,
        contratoSnapshot: contratoSnapshot as Prisma.InputJsonValue,
        usuarioId: user.id,
        vendedorId: sellerSession?.id || null,
        sedeId: user.sedeId,
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

    return NextResponse.json({
      ok: true,
      warning: pendingDeliveryWarning,
      item: serializeCredit(created),
      deliveryStatus: equalityMeta?.deliveryStatus || null,
      equality: equalitySummary
        ? {
            upload: equalityUpload,
            activate: equalityActivate,
            query: equalityQuery,
            ...equalitySummary,
            ...equalityMeta,
          }
        : null,
    });
  } catch (error) {
    console.error("ERROR CREANDO CREDITO:", error);

    return NextResponse.json(
      { error: "No se pudo crear el credito" },
      { status: 500 }
    );
  }
}
