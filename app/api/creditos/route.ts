import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import {
  calculateFinancedBalance,
  calculateRequiredInitialPaymentForFinancingLimit,
  calculateRequiredInitialPaymentByPlatform,
  DEFAULT_CREDIT_INSTALLMENTS,
  extendDays,
  generateCreditFolio,
  generatePagareNumber,
  generatePaymentReference,
  getDefaultFirstPaymentDateObject,
  getMissingIphoneDeliveryEvidence,
  getMissingIphoneIdentityEvidence,
  hasDuplicateEvidenceValues,
  resolveCreditEquipmentPlatform,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  normalizePaymentFrequency,
  parseCreditInstallmentSelection,
  resolveEffectiveDataCreditoFinancingLimit,
  resolveCreditPaymentSummary,
  resolveCreditState,
  sanitizeDeviceValue,
  sanitizeImageDataUrl,
  sanitizeSearch,
  sanitizeText,
  sanitizeVideoDataUrl,
  toNullableDate,
  toNumber,
  validateIphoneInstallmentLimit,
} from "@/lib/credit-factory";
import { calculateFrenchAmortization } from "@/lib/credit-amortization";
import { resolveCreditPolicyFinancialSettings } from "@/lib/credit-policy-financial-settings";
import {
  createFinancingTermsSeal,
  readFinancingTermsSeal,
} from "@/lib/credit-amortization-contract";
import {
  ensureCreditAmortizationSchema,
  persistCreditAmortization,
  type CreditAmortizationDbClient,
} from "@/lib/credit-amortization-storage";
import {
  getEqualityDeviceMeta,
  getPayloadSummary,
  type EqualityDeliveryStatus,
} from "@/lib/equality-device-meta";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { calculateCreditEarlyPayoff } from "@/lib/credit-early-payoff";
import {
  activateEqualityFinancingService,
  isEqualityApiError,
  isEqualityConfigured,
  queryEqualityDevices,
  uploadEqualityInventoryDevice,
} from "@/lib/equality-zero-touch";
import { getEffectiveCreditSettings } from "@/lib/credit-settings";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { sanitizeIphoneDeliveryEvidenceDataUrl } from "@/lib/iphone-delivery-evidence";
import {
  findEquipmentCatalogItem,
  findEquipmentCatalogItemById,
} from "@/lib/equipment-catalog";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { buildCreditAccessWhere } from "@/lib/credit-route-lookup";
import { getFirmaSeguroProcessByUuid } from "@/lib/firmaseguro-storage";
import {
  linkFirmaSeguroProcessForCredit,
  markCreditoFirmaSeguroCompleted,
  refreshFirmaSeguroProcess,
} from "@/lib/firmaseguro-credit";
import {
  buildVeriffSnapshot,
  getVeriffValidationById,
  isVeriffApproved,
  linkVeriffValidationToCredit,
} from "@/lib/veriff-storage";
import {
  extractVeriffIdentityData,
  getVeriffPublicSummary,
  isVeriffRequired,
} from "@/lib/veriff";
import {
  allowsDataCreditoNonProductionProvider,
  getDataCreditoPublicConfig,
} from "@/lib/datacredito";
import {
  classifyDataCreditoAssessmentForCredit,
  claimDataCreditoAssessment,
  consumeDataCreditoAssessment,
  getApprovedDataCreditoAssessmentForCredit,
  isDataCreditoAuditConfigured,
  releaseDataCreditoAssessment,
  type DataCreditoAssessmentMatchInput,
  type DataCreditoAssessmentRow,
} from "@/lib/datacredito/storage";
import {
  DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT,
  resolveDataCreditoOfferFinancingTerms,
} from "@/lib/datacredito/policy";
import {
  ActiveSolicitudConflictError,
  completeSolicitudForCredit,
  ensureSolicitudSchema,
  getActiveSolicitudCreditContext,
  reserveSolicitudForIdentity,
} from "@/lib/solicitudes-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOW_TEST_CREDIT_CLOSE_WITHOUT_DELIVERY_VALIDATION = false;

function hashImageDataUrl(value: string) {
  if (!value) {
    return null;
  }

  const payload = value.slice(value.indexOf(",") + 1);

  return createHash("sha256")
    .update(Buffer.from(payload, "base64"))
    .digest("hex");
}

function roundCurrency(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

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

function documentDigits(value: unknown) {
  return sanitizeText(value).replace(/\D/g, "");
}

function documentKey(value: unknown) {
  return sanitizeText(value)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

function documentValuesMatch(left: unknown, right: unknown) {
  const leftKey = documentKey(left);
  const rightKey = documentKey(right);

  if (!leftKey || !rightKey) {
    return false;
  }

  if (leftKey === rightKey) {
    return true;
  }

  const leftDigits = documentDigits(left);
  const rightDigits = documentDigits(right);

  return Boolean(leftDigits && rightDigits && leftDigits === rightDigits);
}

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
  iphoneSelfieCedulaCapturedAt?: string;
  iphoneSelfieCedulaDataUrl?: string;
  iphoneSelfieCedulaSource?: string;
  contratoVideoAprobacionCapturedAt?: string;
  contratoVideoAprobacionDataUrl?: string;
  contratoVideoAprobacionDurationSeconds?: number | string;
  contratoVideoAprobacionSource?: string;
  fotoEntregaCapturedAt?: string;
  fotoEntregaDataUrl?: string;
  fotoEntregaSource?: string;
  fotoRemisionCapturedAt?: string;
  fotoRemisionDataUrl?: string;
  fotoRemisionSource?: string;
  cuotaInicial?: number | string;
  dataCreditoAssessmentId?: string | null;
  solicitudId?: number | string | null;
  deviceUid?: string;
  equipoMarca?: string;
  equipoModelo?: string;
  equipoCatalogoId?: number | string;
  fianzaPorcentaje?: number | string;
  fechaPrimerPago?: string;
  frecuenciaPago?: string;
  firmaSeguroPasoContratos?: boolean;
  firmaSeguroProcessUuid?: string;
  iphoneEnrolamientoVerificado?: boolean;
  imei?: string;
  montoCredito?: number | string;
  pagareAceptado?: boolean;
  plataformaDispositivo?: string;
  plazoMeses?: number | string;
  referenciaEquipo?: string;
  tasaInteresEa?: number | string;
  valorEquipoTotal?: number | string;
  veriffValidationId?: number | string | null;
};

type PaymentAggregate = {
  abonosCount: number;
  totalAbonado: number;
  ultimoAbonoAt: Date | null;
};

function safeIsoDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const parsed = new Date(String(value || ""));

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const creditListInclude = {
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
  amortizacion: {
    select: {
      cuotaComercial: true,
    },
  },
} satisfies Prisma.CreditoInclude;

const creditListOmit = {
  iphoneSelfieCedulaDataUrl: true,
  fotoEntregaDataUrl: true,
  fotoRemisionDataUrl: true,
} satisfies Prisma.CreditoOmit;

type CreditListItem = Prisma.CreditoGetPayload<{
  include: typeof creditListInclude;
  omit: typeof creditListOmit;
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

function readCommercialInstallmentFromSnapshot(snapshot: unknown) {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    return null;
  }

  const financiero = (snapshot as Record<string, unknown>).financiero;

  if (
    typeof financiero !== "object" ||
    financiero === null ||
    Array.isArray(financiero)
  ) {
    return null;
  }

  const cuotaComercial = Number(
    (financiero as Record<string, unknown>).cuotaComercial
  );

  return Number.isFinite(cuotaComercial) && cuotaComercial > 0
    ? cuotaComercial
    : null;
}

function resolveCommercialInstallment(item: CreditListItem) {
  const persistedCommercialInstallment = Number(
    item.amortizacion?.cuotaComercial
  );

  if (
    Number.isFinite(persistedCommercialInstallment) &&
    persistedCommercialInstallment > 0
  ) {
    return persistedCommercialInstallment;
  }

  return (
    readCommercialInstallmentFromSnapshot(item.contratoSnapshot) ??
    Number(item.valorCuota || 0)
  );
}

function serializeCredit(
  item: CreditListItem,
  paymentMap?: Map<number, PaymentAggregate>
) {
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
    settled: Boolean(item.pazYSalvoEmitidoAt),
  });
  const earlyPayoff = calculateCreditEarlyPayoff({
    saldoBaseFinanciado: Number(item.saldoBaseFinanciado || 0),
    montoCredito: Number(item.montoCredito || 0),
    valorInteres: Number(item.valorInteres || 0),
    valorFianza: Number(item.valorFianza || 0),
    valorCuota: Number(item.valorCuota || 0),
    plazoMeses: Number(item.plazoMeses || 1),
    frecuenciaPago: item.frecuenciaPago,
    fechaPrimerPago: item.fechaPrimerPago || item.fechaProximoPago,
    abonos: payment.totalAbonado > 0 ? [{ valor: payment.totalAbonado }] : [],
  });
  const valorCuotaComercial = resolveCommercialInstallment(item);

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
    valorCuotaComercial,
    fechaCredito: safeIsoDate(item.fechaCredito) || safeIsoDate(item.createdAt) || "",
    fechaPrimerPago: safeIsoDate(item.fechaPrimerPago),
    fechaProximoPago: safeIsoDate(item.fechaProximoPago),
    referenciaPago: item.referenciaPago,
    estado: item.estado,
    deliverableLabel: item.deliverableLabel,
    deliverableReady: item.deliverableReady,
    equalityState: item.equalityState,
    equalityService: item.equalityService,
    equalityPayload: item.equalityPayload,
    equalityLastCheckAt: safeIsoDate(item.equalityLastCheckAt),
    graceUntil: safeIsoDate(item.graceUntil),
    warrantyUntil: safeIsoDate(item.warrantyUntil),
    bloqueoRobo: item.bloqueoRobo,
    bloqueoRoboAt: safeIsoDate(item.bloqueoRoboAt),
    bloqueoMora: item.bloqueoMora,
    bloqueoMoraAt: safeIsoDate(item.bloqueoMoraAt),
    pazYSalvoEmitidoAt: safeIsoDate(item.pazYSalvoEmitidoAt),
    observacionAdmin: item.observacionAdmin,
    contratoAceptadoAt: safeIsoDate(item.contratoAceptadoAt),
    pagareAceptadoAt: safeIsoDate(item.pagareAceptadoAt),
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
    contratoOtpVerificadoAt: safeIsoDate(item.contratoOtpVerificadoAt),
    referenciasFamiliares: extractFamilyReferences(item.contratoSnapshot),
    totalAbonado: paymentSummary.totalAbonado,
    saldoPendiente: paymentSummary.saldoPendiente,
    totalRecaudado: paymentSummary.totalRecaudado,
    porcentajeRecaudado: paymentSummary.porcentajeRecaudado,
    estadoPago: paymentPlan.estadoPago,
    liquidacionAnticipada: {
      disponible: earlyPayoff.eligible,
      motivo: earlyPayoff.reason,
      capitalPendiente: earlyPayoff.capitalPendiente,
      condonacion: earlyPayoff.interesFianzaCondonado,
      saldoObligacion: earlyPayoff.saldoObligacion,
    },
    cuotasPagadas: paymentPlan.paidCount,
    cuotasPendientes: paymentPlan.pendingCount,
    cuotasEnMora: paymentPlan.overdueCount,
    abonosCount: paymentSummary.abonosCount,
    ultimoAbonoAt: safeIsoDate(payment.ultimoAbonoAt),
    createdAt: safeIsoDate(item.createdAt) || "",
    updatedAt: safeIsoDate(item.updatedAt) || "",
    usuario: {
      id: item.vendedor?.id || item.usuario?.id || 0,
      nombre: item.vendedor?.nombre || item.usuario?.nombre || "Sin vendedor",
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

function redactCreditForNonAdmin(item: ReturnType<typeof serializeCredit>) {
  return {
    ...item,
    clienteDireccion: null,
    clienteFechaNacimiento: null,
    clienteFechaExpedicion: null,
    clienteCorreo: null,
    clienteGenero: null,
    equalityPayload: null,
    observacionAdmin: null,
    contratoIp: null,
    contratoFotoDataUrl: null,
    contratoSelfieDataUrl: null,
    contratoOtpDestino: null,
    referenciasFamiliares: [],
    usuario: {
      ...item.usuario,
      usuario: "",
    },
    vendedor: item.vendedor
      ? {
          ...item.vendedor,
          documento: "",
        }
      : null,
  };
}

function parseTake(value: string | null) {
  const numeric = Number(value || 15);

  if (!Number.isFinite(numeric)) {
    return 15;
  }

  return Math.max(1, Math.min(50, Math.trunc(numeric)));
}

function parseId(value: string | null) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
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

function getCreditPendingBalance(
  item: Pick<CreditListItem, "cuotaInicial" | "montoCredito">,
  payment?: PaymentAggregate
) {
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
    const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const search = sanitizeSearch(searchParams.get("search"));
    const searchDigits = search.replace(/\D/g, "");
    const requestedId = parseId(searchParams.get("id"));
    const requestMode = String(searchParams.get("mode") || "").trim().toLowerCase();
    const paymentsMode = requestMode === "payments" || requestMode === "abonos";
    const supervisor = sellerSession?.tipoPerfil === "SUPERVISOR";
    const supervisorLookupMode = !admin && supervisor && Boolean(search || requestedId);

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    if (paymentsMode && !admin && sellerSession?.tipoPerfil !== "SUPERVISOR") {
      return NextResponse.json(
        { error: "Solo el supervisor o administrador puede buscar creditos para recaudo" },
        { status: 403 }
      );
    }

    if (paymentsMode && !search && !requestedId) {
      return NextResponse.json({
        canAdmin: admin,
        scope: adminCentral ? "global" : "aliado",
        search,
        items: [],
      });
    }

    if (!admin && !supervisor && !search && !requestedId) {
      return NextResponse.json({
        canAdmin: false,
        scope: "vendedor",
        search,
        items: [],
      });
    }

    const scopeWhere: Prisma.CreditoWhereInput =
      admin || paymentsMode || supervisorLookupMode
        ? buildCreditAccessWhere({
            admin,
            adminCentral,
            aliadoId: user.aliadoAccesoId,
            sedeId: user.sedeId,
            sellerSedeId: sellerSession?.sedeId,
            supervisor: paymentsMode || supervisorLookupMode,
          })
        : {
            sedeId: sellerSession!.sedeId,
            vendedorId: sellerSession!.id,
          };
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
    const where: Prisma.CreditoWhereInput = requestedId
      ? {
          AND: [
            scopeWhere,
            {
              id: requestedId,
            },
          ],
        }
      : search
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
      include: creditListInclude,
      omit: creditListOmit,
      orderBy: {
        createdAt: "desc",
      },
      take,
    });
    const paymentMap = await buildPaymentSummaryMap(items.map((item) => item.id));

    return NextResponse.json({
      canAdmin: admin,
      scope: adminCentral
        ? "global"
        : admin || paymentsMode || supervisorLookupMode
          ? "aliado"
          : "vendedor",
      search,
      items: items.map((item) => {
        const serialized = serializeCredit(item, paymentMap);
        return admin ? serialized : redactCreditForNonAdmin(serialized);
      }),
    });
  } catch (error) {
    console.error("ERROR LISTANDO CREDITOS:", error);
    return NextResponse.json(
      { error: "No se pudieron cargar los creditos" },
      { status: 500 }
    );
  }
}

function dataCreditoRecoveredCreditResponse(
  item: CreditListItem,
  warning =
    "El crédito ya había sido creado con esta precalificación. No realices una nueva consulta."
) {
  return NextResponse.json({
    ok: true,
    recovered: true,
    warning,
    item: serializeCredit(item),
    deliveryStatus: null,
    identityValidation: null,
    equality: null,
  });
}

async function recoverDataCreditoCredit(
  input: DataCreditoAssessmentMatchInput
) {
  const classification =
    await classifyDataCreditoAssessmentForCredit(input);

  if (classification.status === 'CONSUMED') {
    const created = await prisma.credito.findFirst({
      where: {
        id: classification.creditId,
        usuarioId: input.userId,
        vendedorId: input.sellerId,
        sedeId: input.sedeId,
      },
      include: creditListInclude,
      omit: creditListOmit,
    });

    if (created) {
      await ensureSolicitudSchema();
      await prisma.$transaction((transaction) =>
        completeSolicitudForCredit(
          {
            assessmentId: input.assessmentId,
            clienteDocumento: input.documentNumber,
            usuarioId: input.userId,
            vendedorId: input.sellerId,
            sedeId: input.sedeId,
            creditoId: created.id,
          },
          transaction
        )
      );
      return dataCreditoRecoveredCreditResponse(created);
    }
  }

  if (classification.status === 'CONSUMED_ELSEWHERE') {
    return NextResponse.json(
      {
        ok: false,
        code: 'DATACREDITO_ASSESSMENT_CONSUMED_ELSEWHERE',
        error:
          'La consulta vigente ya fue utilizada en otra solicitud. No se realizo una nueva consulta y no se exponen datos del otro credito.',
      },
      { status: 409 }
    );
  }

  if (classification.status === 'IN_PROGRESS') {
    return NextResponse.json(
      {
        ok: false,
        code: 'DATACREDITO_ASSESSMENT_IN_PROGRESS',
        error:
          'La solicitud ya se esta procesando. Espera un momento antes de intentar nuevamente.',
      },
      { status: 409 }
    );
  }

  return null;
}

export async function POST(req: Request) {
  let dataCreditoClaim: {
    assessmentId: string;
    claimToken: string;
  } | null = null;
  let dataCreditoAssessmentMatch: DataCreditoAssessmentMatchInput | null =
    null;
  let createdCreditId: number | null = null;

  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    let body: CreditCreateBody;

    try {
      body = (await req.json()) as CreditCreateBody;
    } catch (error) {
      console.error("ERROR LEYENDO EVIDENCIAS DEL CREDITO:", error);

      return NextResponse.json(
        {
          error:
            "Las evidencias del credito llegaron incompletas. Intenta finalizar de nuevo para reenviar las fotos y firma.",
        },
        { status: 413 }
      );
    }

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
    const requestedSolicitudIdValue = sanitizeText(body.solicitudId);
    const requestedSolicitudId = parseId(requestedSolicitudIdValue);
    if (requestedSolicitudIdValue && !requestedSolicitudId) {
      return NextResponse.json(
        {
          code: "SOLICITUD_INVALIDA",
          error: "El identificador de la solicitud es invalido.",
        },
        { status: 400 }
      );
    }
    const solicitudContext = requestedSolicitudId
      ? await getActiveSolicitudCreditContext(requestedSolicitudId)
      : null;
    if (requestedSolicitudId && !solicitudContext) {
      return NextResponse.json(
        {
          code: "SOLICITUD_NO_DISPONIBLE",
          error: "La solicitud ya no esta disponible para continuar.",
        },
        { status: 409 }
      );
    }
    const canOperateSolicitud =
      !solicitudContext ||
      adminCentral ||
      Boolean(
        sellerSession &&
          sellerSession.tipoPerfil === "VENDEDOR" &&
          solicitudContext.vendedorId === sellerSession.id &&
          solicitudContext.sedeId === sellerSession.sedeId
      );
    if (!canOperateSolicitud) {
      return NextResponse.json(
        { code: "SOLICITUD_NO_AUTORIZADA", error: "Solicitud no autorizada" },
        { status: 403 }
      );
    }
    if (
      solicitudContext &&
      !documentValuesMatch(solicitudContext.clienteDocumento, clienteDocumento)
    ) {
      return NextResponse.json(
        {
          code: "SOLICITUD_DOCUMENTO_DIFERENTE",
          error: "La cedula no corresponde a la solicitud autorizada.",
        },
        { status: 409 }
      );
    }
    const requestedAssessmentId = sanitizeText(body.dataCreditoAssessmentId);
    if (
      solicitudContext?.dataCreditoAssessmentId &&
      requestedAssessmentId &&
      solicitudContext.dataCreditoAssessmentId.toLowerCase() !==
        requestedAssessmentId.toLowerCase()
    ) {
      return NextResponse.json(
        {
          code: "SOLICITUD_DATACREDITO_DIFERENTE",
          error: "La consulta de DataCredito no corresponde a esta solicitud.",
        },
        { status: 409 }
      );
    }
    const creditOwner = solicitudContext
      ? {
          usuarioId: solicitudContext.usuarioId,
          vendedorId: solicitudContext.vendedorId,
          sedeId: solicitudContext.sedeId,
          aliadoId: solicitudContext.aliadoId,
        }
      : {
          usuarioId: user.id,
          vendedorId: sellerSession?.id || null,
          sedeId: user.sedeId,
          aliadoId: user.aliadoId || null,
        };
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
    const rawEquipmentCatalogId = body.equipoCatalogoId;
    const hasEquipmentCatalogId =
      rawEquipmentCatalogId !== null &&
      rawEquipmentCatalogId !== undefined &&
      sanitizeText(rawEquipmentCatalogId) !== "";
    const parsedEquipmentCatalogId = Number(rawEquipmentCatalogId);
    const equipoCatalogoId =
      hasEquipmentCatalogId &&
      Number.isInteger(parsedEquipmentCatalogId) &&
      parsedEquipmentCatalogId > 0
        ? parsedEquipmentCatalogId
        : null;

    if (hasEquipmentCatalogId && !equipoCatalogoId) {
      return NextResponse.json(
        {
          code: "INVALID_EQUIPMENT_CATALOG_ID",
          error: "El identificador del equipo de catalogo es invalido.",
        },
        { status: 400 }
      );
    }

    const catalogItem = equipoCatalogoId
      ? await findEquipmentCatalogItemById(equipoCatalogoId)
      : equipoMarca && equipoModelo
        ? await findEquipmentCatalogItem({ marca: equipoMarca, modelo: equipoModelo })
        : null;
    const platformResolution = resolveCreditEquipmentPlatform({
      requestedPlatform: body.plataformaDispositivo,
      equipoMarca,
      equipoModelo,
      catalogItemId: equipoCatalogoId,
      catalogItem,
    });

    if (!platformResolution.ok) {
      return NextResponse.json(
        {
          code: platformResolution.code,
          error: platformResolution.message,
        },
        { status: 400 }
      );
    }

    const plataformaDispositivo = platformResolution.platform;
    const isIphoneCredit = plataformaDispositivo === "IPHONE";
    const dataCreditoPlatform = plataformaDispositivo;
    const dataCreditoProvider = getDataCreditoPublicConfig();
    const dataCreditoRequired = dataCreditoProvider.enabled;
    let dataCreditoAssessment: DataCreditoAssessmentRow | null = null;

    if (dataCreditoRequired) {
      if (!dataCreditoProvider.configured || !isDataCreditoAuditConfigured()) {
        return NextResponse.json(
          {
            error:
              "La precalificacion de DataCredito esta habilitada, pero su configuracion segura esta incompleta.",
          },
          { status: 503 }
        );
      }

      if (
        process.env.NODE_ENV === "production" &&
        !dataCreditoProvider.productionReady &&
        !allowsDataCreditoNonProductionProvider()
      ) {
        return NextResponse.json(
          {
            code: "DATACREDITO_NON_PRODUCTION_PROVIDER",
            error: "El ambiente de certificacion no puede autorizar ventas reales.",
          },
          { status: 503 }
        );
      }

      if (clienteTipoDocumento !== "CEDULA_DE_CIUDADANIA") {
        return NextResponse.json(
          {
            error:
              "La precalificacion actual de DataCredito solo admite cedula de ciudadania.",
          },
          { status: 409 }
        );
      }

      if (!/^\d{3,13}$/.test(clienteDocumento)) {
        return NextResponse.json(
          {
            error:
              "La cedula debe contener entre 3 y 13 digitos, sin puntos ni espacios.",
          },
          { status: 400 }
        );
      }

      const assessmentId = requestedAssessmentId;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          assessmentId
        )
      ) {
        return NextResponse.json(
          {
            code: "DATACREDITO_ASSESSMENT_REQUIRED",
            error:
              "Debes obtener una precalificacion aprobada antes de continuar con el credito.",
          },
          { status: 409 }
        );
      }

      dataCreditoAssessmentMatch = {
        assessmentId,
        documentNumber: clienteDocumento,
        firstSurname: clientePrimerApellido,
        platform: dataCreditoPlatform,
        providerEnvironment: dataCreditoProvider.environment,
        userId: creditOwner.usuarioId,
        sellerId: creditOwner.vendedorId,
        sedeId: creditOwner.sedeId,
        aliadoId: creditOwner.aliadoId,
      };
      dataCreditoAssessment =
        await getApprovedDataCreditoAssessmentForCredit(
          dataCreditoAssessmentMatch
        );

      if (!dataCreditoAssessment) {
        const recovery = await recoverDataCreditoCredit(
          dataCreditoAssessmentMatch
        );
        if (recovery) {
          return recovery;
        }

        return NextResponse.json(
          {
            code: "DATACREDITO_ASSESSMENT_INVALID",
            error:
              "La precalificacion no esta aprobada, vencio o no corresponde al titular, asesor, sede y plataforma de este credito.",
          },
          { status: 409 }
        );
      }
    }

    const iphoneManualEnrollmentVerified =
      isIphoneCredit && Boolean(body.iphoneEnrolamientoVerificado);
    const valorEquipoTotalInput = toNumber(body.valorEquipoTotal);

    const precioBaseVentaCatalogo = catalogItem?.activo
      ? catalogItem.precioBaseVenta
      : null;
    const effectiveCreditSettings = await getEffectiveCreditSettings(
      undefined,
      plataformaDispositivo
    );
    const dataCreditoInitialPaymentPercentage = Number(
      dataCreditoAssessment?.offer?.initialPaymentPercentage
    );
    const dataCreditoSuretyPercentage = Number(
      dataCreditoAssessment?.offer?.suretyPercentage
    );
    const dataCreditoMaxFinancedAmount = Number(
      dataCreditoAssessment?.offer?.maxFinancedAmount
    );
    const dataCreditoFinancingTerms = dataCreditoAssessment
      ? resolveDataCreditoOfferFinancingTerms(
          plataformaDispositivo,
          dataCreditoAssessment.offer
        )
      : null;
    const hasValidDataCreditoOffer =
      !dataCreditoAssessment ||
      (Number.isFinite(dataCreditoInitialPaymentPercentage) &&
        dataCreditoInitialPaymentPercentage >= 0 &&
        dataCreditoInitialPaymentPercentage <= 100 &&
        Number.isFinite(dataCreditoSuretyPercentage) &&
        dataCreditoSuretyPercentage >= 0 &&
        dataCreditoSuretyPercentage <= 100 &&
        Number.isSafeInteger(dataCreditoMaxFinancedAmount) &&
        dataCreditoMaxFinancedAmount > 0 &&
        dataCreditoMaxFinancedAmount <=
          DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT &&
        Boolean(dataCreditoFinancingTerms));

    if (!hasValidDataCreditoOffer) {
      return NextResponse.json(
        {
          error:
            "La oferta de la precalificacion no es valida. Solicita revision de la politica de puntajes.",
        },
        { status: 503 }
      );
    }

    const creditSettings = dataCreditoAssessment
      ? {
          ...effectiveCreditSettings.globalSettings,
          cuotaInicialPorcentaje: dataCreditoInitialPaymentPercentage,
          fianzaPorcentaje: dataCreditoSuretyPercentage,
        }
      : effectiveCreditSettings.globalSettings;
    const dataCreditoEffectiveMaxFinancedAmount = dataCreditoAssessment
      ? resolveEffectiveDataCreditoFinancingLimit({
          platform: plataformaDispositivo,
          maxFinancedAmount: dataCreditoMaxFinancedAmount,
          precioBaseVenta: precioBaseVentaCatalogo,
          iphoneMaxFinancedAmount: creditSettings.iphoneTopeFinanciado,
        })
      : 0;
    const cuotaInicialMinima = dataCreditoAssessment
      ? calculateRequiredInitialPaymentForFinancingLimit(
          valorEquipoTotalInput,
          dataCreditoEffectiveMaxFinancedAmount,
          dataCreditoInitialPaymentPercentage
        )
      : calculateRequiredInitialPaymentByPlatform({
          valorTotalEquipo: valorEquipoTotalInput,
          precioBaseVenta: precioBaseVentaCatalogo,
          initialPaymentPercentage: creditSettings.cuotaInicialPorcentaje,
          platform: plataformaDispositivo,
          iphoneMaxFinancedAmount: creditSettings.iphoneTopeFinanciado,
        });
    const cuotaInicialInput = toNumber(body.cuotaInicial);
    const cuotaInicial =
      cuotaInicialInput > 0
        ? Math.max(cuotaInicialMinima, cuotaInicialInput)
        : cuotaInicialMinima;
    const selectedDataCreditoInstallmentCount = dataCreditoFinancingTerms
      ? parseCreditInstallmentSelection(
          body.plazoMeses,
          dataCreditoFinancingTerms.installmentCount
        )
      : null;

    if (
      dataCreditoFinancingTerms &&
      selectedDataCreditoInstallmentCount === null
    ) {
      return NextResponse.json(
        {
          error: `El número de cuotas debe ser un entero entre 1 y ${dataCreditoFinancingTerms.installmentCount}.`,
        },
        { status: 400 }
      );
    }

    const plazoMeses = dataCreditoFinancingTerms
      ? selectedDataCreditoInstallmentCount!
      : normalizeCreditInstallments(
          Math.trunc(toNumber(body.plazoMeses)),
          creditSettings.plazoCuotas || DEFAULT_CREDIT_INSTALLMENTS,
          normalizeCreditInstallmentLimit(creditSettings.plazoMaximoCuotas)
        );
    const resolvedPolicyFinancialSettings =
      resolveCreditPolicyFinancialSettings({
        globalSettings: effectiveCreditSettings.globalSettings,
        policyFinancialSettings:
          dataCreditoAssessment?.offer?.financialSettings,
        legacyOfferSuretyPercentage: dataCreditoAssessment
          ? dataCreditoSuretyPercentage
          : null,
        numeroCuotas: plazoMeses,
      });
    const frecuenciaPago = normalizePaymentFrequency(
      resolvedPolicyFinancialSettings.frecuenciaPago
    );
    const policyFinancialSettings =
      dataCreditoAssessment?.offer?.financialSettings || null;
    const financialParameterOrigins = {
      calculo: resolvedPolicyFinancialSettings.calculoVersion,
      tasaInteresEa: policyFinancialSettings
        ? "POLITICA_DATACREDITO"
        : "CONFIGURACION_GLOBAL",
      fianzaModalidad: resolvedPolicyFinancialSettings.fianzaModalidad,
      fianzaFuente: resolvedPolicyFinancialSettings.fianzaSource,
      seguro: policyFinancialSettings
        ? "POLITICA_DATACREDITO"
        : "CONFIGURACION_GLOBAL",
      frecuenciaPago: policyFinancialSettings
        ? "POLITICA_DATACREDITO"
        : "CONFIGURACION_GLOBAL",
    } as const;
    const fechaCredito = new Date();
    const fechaPrimerPagoPredeterminada = getDefaultFirstPaymentDateObject(
      frecuenciaPago,
      fechaCredito
    );
    const fechaPrimerPagoTexto = sanitizeText(body.fechaPrimerPago);
    const fechaPrimerPagoSolicitada = /^\d{4}-\d{2}-\d{2}$/.test(
      fechaPrimerPagoTexto
    )
      ? new Date(`${fechaPrimerPagoTexto}T12:00:00.000Z`)
      : toNullableDate(fechaPrimerPagoTexto);
    const fechaPrimerPago =
      fechaPrimerPagoSolicitada && fechaPrimerPagoSolicitada > fechaCredito
        ? fechaPrimerPagoSolicitada
        : fechaPrimerPagoPredeterminada;
    const firmaSeguroPasoContratos = Boolean(body.firmaSeguroPasoContratos);
    const firmaSeguroProcessUuid = sanitizeText(body.firmaSeguroProcessUuid);
    let firmaSeguroProcess:
      | Awaited<ReturnType<typeof getFirmaSeguroProcessByUuid>>
      | null = null;

    if (firmaSeguroPasoContratos) {
      if (!firmaSeguroProcessUuid) {
        return NextResponse.json(
          {
            error:
              "Debes enviar primero el expediente a FirmaSeguro antes de finalizar el credito.",
          },
          { status: 400 }
        );
      }

      const storedFirmaSeguroProcess =
        await getFirmaSeguroProcessByUuid(firmaSeguroProcessUuid);

      if (!storedFirmaSeguroProcess) {
        return NextResponse.json(
          { error: "No se encontro el proceso de FirmaSeguro para este credito." },
          { status: 404 }
        );
      }

      if (storedFirmaSeguroProcess.creditoId) {
        return NextResponse.json(
          {
            error:
              "Este proceso de FirmaSeguro ya fue usado para crear otro credito.",
          },
          { status: 409 }
        );
      }

      const storedProcessCompleted = Boolean(
        storedFirmaSeguroProcess.completedAt ||
          storedFirmaSeguroProcess.signedDocumentBase64
      );

      firmaSeguroProcess = storedProcessCompleted
        ? storedFirmaSeguroProcess
        : await refreshFirmaSeguroProcess(storedFirmaSeguroProcess);

      if (
        !firmaSeguroProcess?.completedAt &&
        !firmaSeguroProcess?.signedDocumentBase64
      ) {
        return NextResponse.json(
          {
            error:
              "FirmaSeguro aun no reporta firma exitosa. Actualiza el estado antes de finalizar el credito.",
          },
          { status: 409 }
        );
      }
    }

    const contratoAceptado =
      Boolean(body.contratoAceptado) || firmaSeguroPasoContratos;
    const contratoFirmaDataUrl = sanitizeImageDataUrl(body.contratoFirmaDataUrl);
    const contratoFotoDataUrl = isIphoneCredit
      ? await sanitizeIphoneDeliveryEvidenceDataUrl(
          body.contratoSelfieDataUrl || body.contratoFotoDataUrl
        )
      : sanitizeImageDataUrl(body.contratoSelfieDataUrl || body.contratoFotoDataUrl);
    const contratoSelfieDataUrl = contratoFotoDataUrl;
    const contratoCedulaFrenteDataUrl = isIphoneCredit
      ? await sanitizeIphoneDeliveryEvidenceDataUrl(
          body.contratoCedulaFrenteDataUrl
        )
      : sanitizeImageDataUrl(body.contratoCedulaFrenteDataUrl);
    const contratoCedulaRespaldoDataUrl = isIphoneCredit
      ? await sanitizeIphoneDeliveryEvidenceDataUrl(
          body.contratoCedulaRespaldoDataUrl
        )
      : sanitizeImageDataUrl(body.contratoCedulaRespaldoDataUrl);
    const fotoEntregaDataUrl = isIphoneCredit
      ? await sanitizeIphoneDeliveryEvidenceDataUrl(body.fotoEntregaDataUrl)
      : "";
    const fotoRemisionDataUrl = isIphoneCredit
      ? await sanitizeIphoneDeliveryEvidenceDataUrl(body.fotoRemisionDataUrl)
      : "";
    const iphoneSelfieCedulaDataUrl = isIphoneCredit
      ? await sanitizeIphoneDeliveryEvidenceDataUrl(
          body.iphoneSelfieCedulaDataUrl
        )
      : "";
    const iphoneIdentityHashes = [
      hashImageDataUrl(contratoCedulaFrenteDataUrl),
      hashImageDataUrl(contratoCedulaRespaldoDataUrl),
      hashImageDataUrl(iphoneSelfieCedulaDataUrl),
    ].filter((value): value is string => Boolean(value));
    const fotoEntregaSha256 = hashImageDataUrl(fotoEntregaDataUrl);
    const fotoRemisionSha256 = hashImageDataUrl(fotoRemisionDataUrl);
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
    const pagareAceptado =
      Boolean(body.pagareAceptado) || firmaSeguroPasoContratos;
    const cartaAceptada =
      Boolean(body.cartaAceptada) || firmaSeguroPasoContratos;
    const autorizacionDatosAceptada =
      Boolean(body.autorizacionDatosAceptada) || firmaSeguroPasoContratos;
    const montoCreditoInput = toNumber(body.montoCredito);
    const saldoBaseFinanciado = calculateFinancedBalance(valorEquipoTotalInput, cuotaInicial);
    const valorVentaCalculo =
      valorEquipoTotalInput > 0
        ? valorEquipoTotalInput
        : (saldoBaseFinanciado > 0 ? saldoBaseFinanciado : montoCreditoInput) +
          cuotaInicial;
    const fianzaCuotaPorcentaje =
      resolvedPolicyFinancialSettings.fianzaCuotaPorcentaje;
    const amortizationPlan = calculateFrenchAmortization({
      calculoVersion: resolvedPolicyFinancialSettings.calculoVersion,
      tasaPeriodoDecimales:
        resolvedPolicyFinancialSettings.tasaPeriodoDecimales,
      redondeoComercial:
        resolvedPolicyFinancialSettings.redondeoComercial,
      valorVenta: valorVentaCalculo,
      cuotaInicial,
      numeroCuotas: plazoMeses,
      tasaInteresEa: resolvedPolicyFinancialSettings.tasaInteresEa,
      fianzaCuotaPorcentaje,
      seguroCuotaPorcentaje:
        resolvedPolicyFinancialSettings.seguroCuotaPorcentaje,
      frecuenciaPago,
      fechaPrimerPago,
    });
    const financialPlan = {
      saldoBaseFinanciado: amortizationPlan.valorFinanciado,
      montoCreditoTotal: roundCurrency(amortizationPlan.montoTotal),
      valorCuota: amortizationPlan.cuotaTotal,
      cuotaComercial: amortizationPlan.cuotaComercial,
      tasaInteresEa: amortizationPlan.tasaInteresEa,
      valorInteres: roundCurrency(amortizationPlan.valorInteresTotal),
      fianzaPorcentaje:
        amortizationPlan.fianzaCuotaPorcentaje * amortizationPlan.numeroCuotas,
      valorFianza: roundCurrency(amortizationPlan.valorFianzaTotal),
    };
    const montoCredito = financialPlan.montoCreditoTotal;
    const valorEquipoTotal = amortizationPlan.valorVenta;
    const valorCuota = financialPlan.valorCuota;
    const iphoneInstallmentLimit = validateIphoneInstallmentLimit({
      platform: plataformaDispositivo,
      valorCuota: amortizationPlan.cuotaTotal,
      iphoneMaxInstallmentValue: dataCreditoFinancingTerms
        ? dataCreditoFinancingTerms.maxInstallmentAmount
        : creditSettings.iphoneTopeCuota,
    });
    const firmaSeguroDraftFolio = firmaSeguroProcess?.draftFolio
      ? sanitizeText(firmaSeguroProcess.draftFolio)
      : "";
    const folio = firmaSeguroDraftFolio || generateCreditFolio();
    const financingTermsSeal = createFinancingTermsSeal({
      folio,
      documento: clienteDocumento,
      contrato: {
        tipoDocumento: clienteTipoDocumento,
        clienteNombre: clienteNombreFinal,
        clienteTelefono,
        clienteCorreo,
        clienteDireccion,
        equipoMarca,
        equipoModelo,
        referenciaEquipo,
        imei,
      },
      amortizacion: amortizationPlan,
      parametros: {
        fianzaTotalPorcentaje:
          resolvedPolicyFinancialSettings.fianzaTotalPorcentaje,
        fianzaModalidad:
          resolvedPolicyFinancialSettings.fianzaModalidad,
        fianzaFuente: resolvedPolicyFinancialSettings.fianzaSource,
        tasaPeriodoDecimales:
          resolvedPolicyFinancialSettings.tasaPeriodoDecimales,
        redondeoComercial:
          resolvedPolicyFinancialSettings.redondeoComercial,
        policyVersion: dataCreditoAssessment?.policyVersion || null,
        policyRevisionId:
          dataCreditoAssessment?.policyRevisionId || null,
      },
    });

    if (firmaSeguroProcess) {
      const draftPayload =
        firmaSeguroProcess.draftPayload &&
        typeof firmaSeguroProcess.draftPayload === "object" &&
        !Array.isArray(firmaSeguroProcess.draftPayload)
          ? (firmaSeguroProcess.draftPayload as Record<string, unknown>)
          : null;

      const signedTerms = readFinancingTermsSeal(
        draftPayload?.financialTermsSeal
      );

      if (!signedTerms) {
        return NextResponse.json(
          {
            code: "FIRMASEGURO_RESIGN_REQUIRED",
            error:
              "Este proceso fue generado sin el sello financiero actual. Debes generar y firmar nuevamente los documentos antes de finalizar el credito.",
          },
          { status: 409 }
        );
      }

      if (signedTerms.checksum !== financingTermsSeal.checksum) {
        return NextResponse.json(
          {
            code: "FIRMASEGURO_TERMS_MISMATCH",
            error:
              "Las condiciones financieras cambiaron despues de enviar el documento a firma. Recalcula y genera un nuevo proceso de FirmaSeguro.",
          },
          { status: 409 }
        );
      }
    }
    const existingCreditWithFolio = await prisma.credito.findUnique({
      where: { folio },
      select: { id: true },
    });

    if (existingCreditWithFolio) {
      return NextResponse.json(
        {
          error:
            "Este expediente ya fue usado para crear un credito. Actualiza la busqueda antes de continuar.",
        },
        { status: 409 }
      );
    }

    const pagareNumero = generatePagareNumber(folio);
    const referenciaPago = generatePaymentReference(folio, clienteDocumento);
    const contratoAceptadoAt = new Date();
    const contratoIp = extractRequestIp(req);
    const iphoneSelfieCedulaCapturedAt = iphoneSelfieCedulaDataUrl
      ? toNullableDate(body.iphoneSelfieCedulaCapturedAt)?.toISOString() ||
        contratoAceptadoAt.toISOString()
      : null;
    const iphoneSelfieCedulaSource = iphoneSelfieCedulaDataUrl
      ? sanitizeText(body.iphoneSelfieCedulaSource).toLowerCase() === "camera"
        ? "camera"
        : "upload"
      : null;
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
    const fotoEntregaCapturedAt = fotoEntregaDataUrl
      ? toNullableDate(body.fotoEntregaCapturedAt)?.toISOString() ||
        contratoAceptadoAt.toISOString()
      : null;
    const fotoEntregaSource = fotoEntregaDataUrl
      ? sanitizeText(body.fotoEntregaSource).toLowerCase() === "camera"
        ? "camera"
        : "upload"
      : null;
    const fotoRemisionCapturedAt = fotoRemisionDataUrl
      ? toNullableDate(body.fotoRemisionCapturedAt)?.toISOString() ||
        contratoAceptadoAt.toISOString()
      : null;
    const fotoRemisionSource = fotoRemisionDataUrl
      ? sanitizeText(body.fotoRemisionSource).toLowerCase() === "camera"
        ? "camera"
        : "upload"
      : null;
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

    const solicitudReservation = await reserveSolicitudForIdentity({
      solicitudId: solicitudContext?.id || null,
      usuarioId: creditOwner.usuarioId,
      vendedorId: creditOwner.vendedorId,
      sedeId: creditOwner.sedeId,
      clienteDocumento,
      plataforma: plataformaDispositivo,
    });
    if (
      solicitudContext &&
      solicitudReservation.id !== solicitudContext.id
    ) {
      return NextResponse.json(
        {
          code: "SOLICITUD_ACTIVA_EXISTENTE",
          error:
            "Existe otra solicitud activa para esta cedula. Debe resolverse antes de continuar.",
        },
        { status: 409 }
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

    // Las excepciones por cedula se conservan solo como historia administrativa.
    // Las ventas nuevas aplican exclusivamente las reglas publicadas de la politica.
    const documentCanHaveMultipleActiveCredits = false;
    const documentCanSkipDeliveryVerification = false;

    if (!documentCanHaveMultipleActiveCredits) {
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
          (item) =>
            getCreditPendingBalance(item, clientPaymentMap.get(item.id)) > 0
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

    if (
      !isIphoneCredit &&
      cuotaInicialInput > 0 &&
      cuotaInicialInput < cuotaInicialMinima
    ) {
      return NextResponse.json(
        {
          error: `La cuota inicial minima es ${Math.round(cuotaInicialMinima).toLocaleString("es-CO")}`,
        },
        { status: 400 }
      );
    }

    if (iphoneInstallmentLimit.exceeded) {
      return NextResponse.json(
        { error: iphoneInstallmentLimit.message },
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

    const veriffValidationId = Math.trunc(toNumber(body.veriffValidationId));
    // The DataCredito prequalification flow always continues through the
    // existing identity validation before a credit can be created. Keeping
    // this conditional preserves the previous Veriff mode when the feature is
    // disabled.
    const veriffRequired = dataCreditoRequired || isVeriffRequired();
    const veriffSummary = getVeriffPublicSummary();
    let veriffValidation =
      veriffValidationId > 0
        ? await getVeriffValidationById(veriffValidationId)
        : null;

    if (veriffValidationId > 0 && !veriffValidation) {
      return NextResponse.json(
        { error: "La validacion Veriff indicada no existe." },
        { status: 404 }
      );
    }

    if (veriffValidation) {
      const verifiedIdentity =
        extractVeriffIdentityData(veriffValidation.decisionPayload) ||
        extractVeriffIdentityData(veriffValidation.webhookPayload);
      const verifiedDocument = sanitizeText(
        verifiedIdentity?.documentNumber || veriffValidation.clienteDocumento
      );
      const storedValidationDocument = sanitizeText(veriffValidation.clienteDocumento);
      const verifiedDocumentIsNumeric = documentDigits(verifiedDocument).length >= 5;
      const verifiedDocumentMatches = documentValuesMatch(
        verifiedDocument,
        clienteDocumento
      );
      const storedValidationDocumentMatches = documentValuesMatch(
        storedValidationDocument,
        clienteDocumento
      );
      const validationDocumentAvailable = Boolean(
        verifiedDocumentIsNumeric ||
          documentDigits(storedValidationDocument).length >= 5 ||
          verifiedDocumentMatches ||
          storedValidationDocumentMatches
      );
      const sameSede = veriffValidation.sedeId === user.sedeId;
      const sameAlly =
        admin &&
        user.aliadoAccesoId &&
        veriffValidation.aliadoId === user.aliadoAccesoId;

      if (
        (verifiedDocumentIsNumeric && !verifiedDocumentMatches) ||
        (!verifiedDocumentIsNumeric &&
          documentKey(verifiedDocument) &&
          !verifiedDocumentMatches &&
          !storedValidationDocumentMatches)
      ) {
        return NextResponse.json(
          {
            error:
              "La validacion Veriff no corresponde a la cedula de este credito.",
          },
          { status: 409 }
        );
      }

      if (
        veriffRequired &&
        isVeriffApproved(veriffValidation) &&
        !validationDocumentAvailable
      ) {
        return NextResponse.json(
          {
            error:
              "Veriff aprobo la identidad, pero no retorno un documento verificable para este credito.",
          },
          { status: 409 }
        );
      }

      if (!adminCentral && !sameSede && !sameAlly) {
        return NextResponse.json(
          {
            error:
              "La validacion Veriff no pertenece a la sede o aliado de este credito.",
          },
          { status: 403 }
        );
      }
    }

    if (veriffRequired && !veriffSummary.configured) {
      return NextResponse.json(
        {
          error:
            "Veriff esta requerido, pero no esta configurado en el servidor.",
        },
        { status: 503 }
      );
    }

    const veriffRiskSnapshot = veriffValidation
      ? buildVeriffSnapshot(veriffValidation)
      : null;
    const veriffRiskBlocked = Boolean(veriffRiskSnapshot?.riskBlocked);
    const veriffMustBeRejected =
      veriffValidation
        ? !isVeriffApproved(veriffValidation)
        : veriffRequired;

    if (veriffMustBeRejected) {
      return NextResponse.json(
        {
          error:
            veriffRiskBlocked
              ? "Veriff aprobo tecnicamente, pero tiene etiquetas de riesgo o PEP/sanciones. Debe revisarse antes de finalizar."
              : "Debes aprobar la validacion de identidad en Veriff antes de finalizar el credito.",
          identityValidation: veriffValidation
            ? {
                id: veriffValidation.id,
                status: veriffValidation.status,
                decision: veriffValidation.decision,
                lastError: veriffValidation.lastError,
                riskSignals: veriffRiskSnapshot?.riskSignals || null,
              }
            : null,
        },
        { status: 409 }
      );
    }

    const veriffApprovedForEvidence = Boolean(
      veriffValidation && isVeriffApproved(veriffValidation)
    );

    if (!contratoAceptado) {
      return NextResponse.json(
        { error: "Debes confirmar la aceptacion del contrato digital" },
        { status: 400 }
      );
    }

    const missingIphoneIdentityEvidence = getMissingIphoneIdentityEvidence({
      platform: plataformaDispositivo,
      cedulaFrenteDataUrl: contratoCedulaFrenteDataUrl,
      cedulaRespaldoDataUrl: contratoCedulaRespaldoDataUrl,
      selfieCedulaDataUrl: iphoneSelfieCedulaDataUrl,
    });
    const missingIphoneDeliveryEvidence = getMissingIphoneDeliveryEvidence({
      platform: plataformaDispositivo,
      fotoEntregaDataUrl,
      fotoRemisionDataUrl,
    });
    const missingIphoneRequiredEvidence = [
      ...missingIphoneIdentityEvidence,
      ...missingIphoneDeliveryEvidence,
    ];

    if (
      isIphoneCredit &&
      iphoneIdentityHashes.length === 3 &&
      hasDuplicateEvidenceValues(iphoneIdentityHashes)
    ) {
      return NextResponse.json(
        {
          code: "IPHONE_IDENTITY_EVIDENCE_DUPLICATED",
          error: "Las fotos de la cedula y la selfie con cedula deben ser imagenes diferentes.",
        },
        { status: 400 }
      );
    }

    if (missingIphoneRequiredEvidence.length) {
      const labels = missingIphoneRequiredEvidence.map((key) =>
        key === "cedulaFrente"
          ? "la foto frontal de la cedula"
          : key === "cedulaRespaldo"
            ? "la foto posterior de la cedula"
            : key === "selfieCedula"
              ? "la selfie con la cedula en la mano"
              : key === "fotoEntrega"
                ? "la foto de entrega"
                : "la foto de remision"
      );
      const missingLabel =
        labels.length > 1
          ? `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}`
          : labels[0];

      return NextResponse.json(
        {
          code: "IPHONE_CLOSURE_EVIDENCE_REQUIRED",
          error: `Debes cargar ${missingLabel} antes de finalizar el credito iPhone.`,
          missing: missingIphoneRequiredEvidence,
        },
        { status: 400 }
      );
    }

    if (!contratoFotoDataUrl && !veriffApprovedForEvidence) {
      return NextResponse.json(
        { error: "Debes tomar la selfie del cliente para el contrato" },
        { status: 400 }
      );
    }

    if (
      (!contratoCedulaFrenteDataUrl || !contratoCedulaRespaldoDataUrl) &&
      !veriffApprovedForEvidence
    ) {
      return NextResponse.json(
        { error: "Debes capturar la cedula por ambos lados" },
        { status: 400 }
      );
    }

    if (!contratoFirmaDataUrl && !firmaSeguroPasoContratos) {
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

    if (
      isIphoneCredit &&
      !iphoneManualEnrollmentVerified &&
      !documentCanSkipDeliveryVerification
    ) {
      return NextResponse.json(
        {
          code: "IPHONE_ENROLLMENT_REQUIRED",
          error: "Debes confirmar el enrolamiento del iPhone antes de finalizar el credito.",
        },
        { status: 400 }
      );
    }

    const allowPendingDeliveryClose =
      ALLOW_TEST_CREDIT_CLOSE_WITHOUT_DELIVERY_VALIDATION ||
      documentCanSkipDeliveryVerification ||
      iphoneManualEnrollmentVerified;

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

    if (
      isEqualityConfigured() &&
      !documentCanSkipDeliveryVerification &&
      !iphoneManualEnrollmentVerified
    ) {
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
    const administrativeDeliveryStatus: EqualityDeliveryStatus | null =
      iphoneManualEnrollmentVerified && !equalityMeta?.deliveryStatus?.ready
        ? {
            label: "Enrolamiento iPhone verificado",
            detail:
              "Entrega permitida con verificacion manual de enrolamiento iPhone.",
            ready: true,
            tone: "emerald",
          }
        : documentCanSkipDeliveryVerification && !equalityMeta?.deliveryStatus?.ready
        ? {
            label: "Entrega autorizada",
            detail:
              "Entrega permitida sin verificar dispositivo por excepcion administrativa.",
            ready: true,
            tone: "emerald",
          }
        : null;
    const effectiveDeliveryStatus =
      administrativeDeliveryStatus || equalityMeta?.deliveryStatus || null;
    const pendingDeliveryWarning = administrativeDeliveryStatus
      ? iphoneManualEnrollmentVerified
        ? "Credito iPhone creado con verificacion manual de enrolamiento."
        : "Credito creado con excepcion administrativa: entrega permitida sin verificar dispositivo."
      : ALLOW_TEST_CREDIT_CLOSE_WITHOUT_DELIVERY_VALIDATION &&
          !equalityMeta?.deliveryStatus?.ready
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
        plataforma: isIphoneCredit ? "IPHONE" : "ANDROID",
        enrolamientoManualVerificado: iphoneManualEnrollmentVerified,
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
        metodoCalculo: amortizationPlan.metodo,
        calculoVersion: amortizationPlan.version,
        tasaPeriodo: amortizationPlan.tasaPeriodo,
        periodosPorAno: amortizationPlan.periodosPorAno,
        fianzaCuotaPorcentaje: amortizationPlan.fianzaCuotaPorcentaje,
        fianzaTotalPorcentaje:
          resolvedPolicyFinancialSettings.fianzaTotalPorcentaje,
        fianzaModalidad: resolvedPolicyFinancialSettings.fianzaModalidad,
        seguroCuotaPorcentaje: amortizationPlan.seguroCuotaPorcentaje,
        tasaPeriodoDecimales:
          resolvedPolicyFinancialSettings.tasaPeriodoDecimales,
        redondeoComercial:
          resolvedPolicyFinancialSettings.redondeoComercial,
        cuotaCreditoExacta: amortizationPlan.cuotaCredito,
        cuotaFianzaExacta: amortizationPlan.cuotaFianza,
        cuotaSeguroExacta: amortizationPlan.cuotaSeguro,
        cuotaTotalExacta: amortizationPlan.cuotaTotal,
        cuotaComercial: amortizationPlan.cuotaComercial,
        valorSeguro: amortizationPlan.valorSeguroTotal,
        valorCuota,
        origenParametros: financialParameterOrigins,
        selloFinanciero: financingTermsSeal,
        dataCredito: dataCreditoAssessment
          ? {
              assessmentId: dataCreditoAssessment.id,
              policyVersion: dataCreditoAssessment.policyVersion,
              policyRevisionId: dataCreditoAssessment.policyRevisionId,
              maxFinancedAmount: dataCreditoMaxFinancedAmount,
              effectiveMaxFinancedAmount:
                dataCreditoEffectiveMaxFinancedAmount,
              installmentCount: dataCreditoFinancingTerms?.installmentCount,
              maxInstallmentCount: dataCreditoFinancingTerms?.installmentCount,
              selectedInstallmentCount: plazoMeses,
              maxInstallmentAmount:
                dataCreditoFinancingTerms?.maxInstallmentAmount,
              usedLegacyFinancingTermsFallback:
                dataCreditoFinancingTerms?.usedLegacyFallback,
              excessToInitial: Math.max(0, valorEquipoTotal - dataCreditoEffectiveMaxFinancedAmount),
            }
          : null,
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
        proveedorDigital: firmaSeguroPasoContratos ? "FirmaSeguro" : null,
        canalProveedorDigital: firmaSeguroPasoContratos ? "WHATSAPP" : null,
        procesoUuid: firmaSeguroProcess?.processUuid || null,
        firmadoAtProveedor:
          firmaSeguroProcess?.completedAt instanceof Date
            ? firmaSeguroProcess.completedAt.toISOString()
            : firmaSeguroProcess?.completedAt || null,
        documentoFirmado: firmaSeguroProcess?.signedDocumentFileName || null,
      },
      evidencia: {
        selfieRegistrada: Boolean(
          contratoSelfieDataUrl || veriffApprovedForEvidence
        ),
        cedulaFrenteRegistrada: Boolean(
          contratoCedulaFrenteDataUrl || veriffApprovedForEvidence
        ),
        cedulaRespaldoRegistrada: Boolean(
          contratoCedulaRespaldoDataUrl || veriffApprovedForEvidence
        ),
        autenticidad: {
          autenticadoCon: [
            "Correo electronico",
            "Direccion IP",
            "Fotografia",
            "Cedula frente",
            "Cedula respaldo",
            "Firma digital",
            ...(isIphoneCredit
              ? ["Foto de entrega", "Foto de remision"]
              : []),
            ...(veriffValidation ? ["Veriff"] : []),
          ],
          email: clienteCorreo,
          ip: contratoIp,
          firmadoAt: contratoAceptadoAt.toISOString(),
          documento: clienteDocumento,
        },
        identidad: buildVeriffSnapshot(veriffValidation),
        selfieConCedula: iphoneSelfieCedulaDataUrl
          ? {
              registrada: true,
              capturedAt: iphoneSelfieCedulaCapturedAt,
              source: iphoneSelfieCedulaSource,
              ip: contratoIp,
              email: clienteCorreo,
              sha256: hashImageDataUrl(iphoneSelfieCedulaDataUrl),
            }
          : null,
        selfie: {
          registrada: Boolean(contratoSelfieDataUrl || veriffApprovedForEvidence),
          capturedAt: contratoSelfieCapturedAt,
          source:
            contratoSelfieSource || (veriffApprovedForEvidence ? "Veriff" : null),
          ip: contratoIp,
          email: clienteCorreo,
        },
        cedulaFrente: {
          registrada: Boolean(
            contratoCedulaFrenteDataUrl || veriffApprovedForEvidence
          ),
          capturedAt: contratoCedulaFrenteCapturedAt,
          source:
            contratoCedulaFrenteSource ||
            (veriffApprovedForEvidence ? "Veriff" : null),
          ip: contratoIp,
          email: clienteCorreo,
        },
        cedulaRespaldo: {
          registrada: Boolean(
            contratoCedulaRespaldoDataUrl || veriffApprovedForEvidence
          ),
          capturedAt: contratoCedulaRespaldoCapturedAt,
          source:
            contratoCedulaRespaldoSource ||
            (veriffApprovedForEvidence ? "Veriff" : null),
          ip: contratoIp,
          email: clienteCorreo,
        },
        fotoEntrega: fotoEntregaDataUrl
          ? {
              registrada: true,
              capturedAt: fotoEntregaCapturedAt,
              source: fotoEntregaSource,
              ip: contratoIp,
              email: clienteCorreo,
              sha256: fotoEntregaSha256,
            }
          : null,
        fotoRemision: fotoRemisionDataUrl
          ? {
              registrada: true,
              capturedAt: fotoRemisionCapturedAt,
              source: fotoRemisionSource,
              ip: contratoIp,
              email: clienteCorreo,
              sha256: fotoRemisionSha256,
            }
          : null,
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

    const amortizationPersistencePlan = {
      calculoVersion: amortizationPlan.version,
      frecuenciaPago: amortizationPlan.frecuenciaPago,
      periodosPorAnio: amortizationPlan.periodosPorAno,
      numeroCuotas: amortizationPlan.numeroCuotas,
      valorVenta: amortizationPlan.valorVenta,
      cuotaInicial: amortizationPlan.cuotaInicial,
      valorFinanciado: amortizationPlan.valorFinanciado,
      tasaInteresEaPorcentaje: amortizationPlan.tasaInteresEa,
      tasaPeriodo: amortizationPlan.tasaPeriodo,
      fianzaCuotaPorcentaje: amortizationPlan.fianzaCuotaPorcentaje,
      seguroCuotaPorcentaje: amortizationPlan.seguroCuotaPorcentaje,
      cuotaCreditoExacta: amortizationPlan.cuotaCredito,
      cuotaFianzaExacta: amortizationPlan.cuotaFianza,
      cuotaSeguroExacta: amortizationPlan.cuotaSeguro,
      cuotaTotalExacta: amortizationPlan.cuotaTotal,
      cuotaComercial: amortizationPlan.cuotaComercial,
      totalInteres: amortizationPlan.valorInteresTotal,
      totalFianza: amortizationPlan.valorFianzaTotal,
      totalSeguro: amortizationPlan.valorSeguroTotal,
      totalPagar: amortizationPlan.montoTotal,
      aprobadoAt: contratoAceptadoAt,
      cuotas: amortizationPlan.cuotas,
    };
    const amortizationParametersSnapshot = {
      metodo: amortizationPlan.metodo,
      calculoVersion: amortizationPlan.version,
      origenFianza: resolvedPolicyFinancialSettings.fianzaModalidad,
      fuenteFianza: resolvedPolicyFinancialSettings.fianzaSource,
      fianzaTotalPorcentaje:
        resolvedPolicyFinancialSettings.fianzaTotalPorcentaje,
      tasaPeriodoDecimales:
        resolvedPolicyFinancialSettings.tasaPeriodoDecimales,
      redondeoComercial:
        resolvedPolicyFinancialSettings.redondeoComercial,
      origenParametros: financialParameterOrigins,
      dataCreditoAssessmentId: dataCreditoAssessment?.id || null,
      dataCreditoPolicyVersion: dataCreditoAssessment?.policyVersion || null,
      dataCreditoPolicyRevisionId:
        dataCreditoAssessment?.policyRevisionId || null,
      dataCreditoInstallmentCount:
        dataCreditoFinancingTerms?.installmentCount || null,
      dataCreditoMaxInstallmentCount:
        dataCreditoFinancingTerms?.installmentCount || null,
      dataCreditoSelectedInstallmentCount:
        dataCreditoAssessment ? plazoMeses : null,
      dataCreditoMaxInstallmentAmount:
        dataCreditoFinancingTerms?.maxInstallmentAmount ?? null,
      dataCreditoUsedLegacyFinancingTermsFallback:
        dataCreditoFinancingTerms?.usedLegacyFallback ?? null,
      documentExceptionId: null,
      fechaPrimerPago: fechaPrimerPago.toISOString(),
      financialTermsChecksum: financingTermsSeal.checksum,
    };

    await ensureCreditAmortizationSchema();
    await ensureSolicitudSchema();

    if (dataCreditoAssessment && dataCreditoAssessmentMatch) {
      const claimed = await claimDataCreditoAssessment(
        dataCreditoAssessmentMatch
      );

      if (!claimed) {
        const recovery = await recoverDataCreditoCredit(
          dataCreditoAssessmentMatch
        );
        if (recovery) {
          return recovery;
        }

        return NextResponse.json(
          {
            code: "DATACREDITO_ASSESSMENT_INVALID",
            error:
              "La precalificacion ya fue utilizada, vencio o esta siendo procesada en otra solicitud.",
          },
          { status: 409 }
        );
      }

      dataCreditoClaim = {
        assessmentId: claimed.assessment.id,
        claimToken: claimed.claimToken,
      };
    }

    const creditCreateArgs = {
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
          deliverable: effectiveDeliveryStatus,
        }),
        deliverableLabel: effectiveDeliveryStatus?.label || null,
        deliverableReady: Boolean(effectiveDeliveryStatus?.ready),
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
        iphoneSelfieCedulaDataUrl,
        fotoEntregaDataUrl,
        fotoRemisionDataUrl,
        contratoOtpCanal: contratoOtpCanal || null,
        contratoOtpDestino: contratoOtpDestino || null,
        contratoOtpVerificadoAt,
        contratoSnapshot: contratoSnapshot as Prisma.InputJsonValue,
        usuarioId: creditOwner.usuarioId,
        vendedorId: creditOwner.vendedorId,
        sedeId: creditOwner.sedeId,
      },
      include: creditListInclude,
      omit: creditListOmit,
    } satisfies Prisma.CreditoCreateArgs;

    const createCreditWithAmortization = async (
      transaction: Prisma.TransactionClient
    ) => {
      const credit = await transaction.credito.create(creditCreateArgs);
      await persistCreditAmortization(
        transaction as unknown as CreditAmortizationDbClient,
        credit.id,
        amortizationPersistencePlan,
        amortizationParametersSnapshot
      );
      const linkedSolicitudId = await completeSolicitudForCredit(
        {
          solicitudId: solicitudReservation.id,
          assessmentId: dataCreditoAssessment?.id || null,
          clienteDocumento,
          usuarioId: creditOwner.usuarioId,
          vendedorId: creditOwner.vendedorId,
          sedeId: creditOwner.sedeId,
          creditoId: credit.id,
        },
        transaction
      );
      if (!linkedSolicitudId) {
        throw new Error("SOLICITUD_COMPLETION_CONFLICT");
      }
      return credit;
    };

    let created;
    if (dataCreditoClaim) {
      const claimedAssessment = dataCreditoClaim;

      created = await prisma.$transaction(async (transaction) => {
        const credit = await createCreditWithAmortization(transaction);
        const consumed = await consumeDataCreditoAssessment(
          {
            assessmentId: claimedAssessment.assessmentId,
            claimToken: claimedAssessment.claimToken,
            creditId: credit.id,
          },
          transaction
        );

        if (!consumed) {
          throw new Error("DATACREDITO_ASSESSMENT_CONSUME_CONFLICT");
        }

        return credit;
      });
      dataCreditoClaim = null;
    } else {
      created = await prisma.$transaction((transaction) =>
        createCreditWithAmortization(transaction)
      );
    }
    createdCreditId = created.id;

    if (firmaSeguroProcess) {
      await linkFirmaSeguroProcessForCredit(firmaSeguroProcess.processUuid, created.id);
      await markCreditoFirmaSeguroCompleted(created.id, {
        processUuid: firmaSeguroProcess.processUuid,
        status: firmaSeguroProcess.status,
        signedDocumentFileName: firmaSeguroProcess.signedDocumentFileName,
        completedAt: firmaSeguroProcess.completedAt || new Date(),
      });

      const linkedCredit = await prisma.credito.findUnique({
        where: { id: created.id },
        include: creditListInclude,
        omit: creditListOmit,
      });

      if (linkedCredit) {
        created = linkedCredit;
      }
    }

    if (veriffValidation) {
      veriffValidation =
        (await linkVeriffValidationToCredit(veriffValidation.id, created.id)) ||
        veriffValidation;
    }

    return NextResponse.json({
      ok: true,
      warning: pendingDeliveryWarning,
      item: serializeCredit(created),
      deliveryStatus: effectiveDeliveryStatus,
      identityValidation: buildVeriffSnapshot(veriffValidation),
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
    if (dataCreditoClaim && !createdCreditId) {
      await releaseDataCreditoAssessment(dataCreditoClaim).catch(() => undefined);
    }

    if (error instanceof ActiveSolicitudConflictError) {
      return NextResponse.json(
        {
          code: error.code,
          error: error.message,
        },
        { status: error.status }
      );
    }

    const rawErrorCode =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "")
        : "";
    console.error("ERROR CREANDO CREDITO:", {
      errorType: error instanceof Error ? error.name : "UnknownError",
      safeCode: /^[A-Z0-9_]{1,64}$/.test(rawErrorCode) ? rawErrorCode : null,
      postCommit: Boolean(createdCreditId),
    });

    if (createdCreditId) {
      const recovered = await prisma.credito
        .findUnique({
          where: { id: createdCreditId },
          include: creditListInclude,
          omit: creditListOmit,
        })
        .catch(() => null);

      if (recovered) {
        return dataCreditoRecoveredCreditResponse(
          recovered,
          "El crédito se creó correctamente, pero una vinculación posterior quedó pendiente. No repitas la consulta; revisa el expediente."
        );
      }
    }

    return NextResponse.json(
      { error: "No se pudo crear el credito" },
      { status: 500 }
    );
  }
}
