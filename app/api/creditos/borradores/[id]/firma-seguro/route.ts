import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import {
  allowsDataCreditoNonProductionProvider,
  getDataCreditoPublicConfig,
} from "@/lib/datacredito";
import {
  getApprovedDataCreditoAssessmentForCredit,
  isDataCreditoAuditConfigured,
} from "@/lib/datacredito/storage";
import {
  DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT,
  resolveDataCreditoOfferFinancingTerms,
  type DataCreditoPolicyFinancialSettings,
} from "@/lib/datacredito/policy";
import { resolveDataCreditoManualCreditLimit } from "@/lib/datacredito/manual-credit-limits";
import {
  DEFAULT_CREDIT_INSTALLMENTS,
  generateCreditFolio,
  generatePaymentReference,
  getDefaultFirstPaymentDateObject,
  resolveCreditEquipmentPlatform,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  normalizePaymentFrequency,
  parseCreditInstallmentSelection,
  resolveRequiredInitialPaymentByPlatform,
  sanitizeDeviceValue,
  sanitizeImageDataUrl,
  sanitizeText,
  toNumber,
  validateIphoneInstallmentLimit,
} from "@/lib/credit-factory";
import { validateCreditContactPhones } from "@/lib/credit-contact-phones";
import { calculateFrenchAmortization } from "@/lib/credit-amortization";
import { createFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { resolveCreditPolicyFinancialSettings } from "@/lib/credit-policy-financial-settings";
import { getEffectiveCreditSettings } from "@/lib/credit-settings";
import {
  findEquipmentCatalogItem,
  findEquipmentCatalogItemById,
} from "@/lib/equipment-catalog";
import {
  FirmaSeguroApiError,
  isFirmaSeguroCompletedStatus,
} from "@/lib/firmaseguro";
import { isFirmaSeguroFailedStatus } from "@/lib/firmaseguro-status";
import {
  createFirmaSeguroProcessForDraft,
  getLatestFirmaSeguroProcessForDraft,
  refreshFirmaSeguroProcess,
  serializeFirmaSeguroProcess,
} from "@/lib/firmaseguro-credit";
import {
  correctFirmaSeguroDraftImei,
  FirmaSeguroImeiCorrectionError,
  recordFirmaSeguroImeiCorrectionReissue,
} from "@/lib/firmaseguro-imei-correction";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";
import { tryAcquireFirmaSeguroDraftDispatchLock } from "@/lib/firmaseguro-storage";
import { isAdminRole } from "@/lib/roles";
import { expireStaleSolicitudes } from "@/lib/solicitudes-storage";
import {
  getVeriffValidationById,
  isVeriffApproved,
} from "@/lib/veriff-storage";
import { isVeriffRequired } from "@/lib/veriff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DraftPayload = Record<string, unknown>;

type DraftRow = {
  id: number;
  estado: string;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  currentStep: number;
  payload: unknown;
  usuarioNombre: string | null;
  usuarioLogin: string | null;
  vendedorNombre: string | null;
  vendedorDocumento: string | null;
  vendedorTelefono: string | null;
  vendedorEmail: string | null;
  sedeNombre: string | null;
  sedeCodigo: string | null;
  sedeAliadoId: number | null;
};

type DraftDataCreditoOffer = {
  assessmentId: string;
  policyVersion: number;
  policyRevisionId: string;
  initialPaymentPercentage: number;
  suretyPercentage: number;
  maxFinancedAmount: number;
  installmentCount: number;
  maxInstallmentAmount: number | null;
  usedLegacyFinancingTermsFallback: boolean;
  financialSettings: DataCreditoPolicyFinancialSettings | null;
};

type BuiltDraftCredit = {
  credit: CreditForFirmaSeguroPdf;
  amortizationPlan: ReturnType<typeof calculateFrenchAmortization>;
  financingParameters: Parameters<
    typeof createFinancingTermsSeal
  >[0]["parametros"];
};

class CreditValidationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status = 400,
    code = "FIRMASEGURO_CREDIT_INVALID"
  ) {
    super(message);
    this.name = "CreditValidationError";
    this.status = status;
    this.code = code;
  }
}

function canReuseFirmaSeguroProcess(process: {
  completedAt?: unknown;
  lastError?: unknown;
  signedDocumentBase64?: unknown;
  status?: unknown;
}) {
  const normalized = sanitizeText(process.status).toUpperCase();

  if (
    process.completedAt ||
    sanitizeText(process.signedDocumentBase64) ||
    isFirmaSeguroCompletedStatus(normalized)
  ) {
    return true;
  }

  if (sanitizeText(process.lastError)) {
    return false;
  }

  return Boolean(normalized && !isFirmaSeguroFailedStatus(normalized));
}

function logFirmaSeguroDraftError(
  operation: "GET" | "POST" | "PATCH",
  draftId: number | null,
  error: unknown
) {
  console.error("ERROR FIRMASEGURO BORRADOR:", {
    operation,
    draftId,
    errorType: error instanceof Error ? error.name : "UnknownError",
    status:
      error instanceof CreditValidationError ||
      error instanceof FirmaSeguroApiError ||
      error instanceof FirmaSeguroImeiCorrectionError
        ? error.status
        : 500,
    code:
      error instanceof CreditValidationError ||
      error instanceof FirmaSeguroImeiCorrectionError
        ? error.code
        : error instanceof FirmaSeguroApiError
          ? "FIRMASEGURO_PROVIDER_ERROR"
          : "FIRMASEGURO_UNEXPECTED_ERROR",
  });
}


function parseDraftId(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function payloadObject(value: unknown): DraftPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DraftPayload)
    : {};
}

function toValidDate(value: unknown, fallback: Date) {
  const text = sanitizeText(value);
  if (!text) {
    return fallback;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

async function ensureDraftTable() {
  await expireStaleSolicitudes();
}

async function readAuthorizedDraft(
  draftId: number,
  options: { operate?: boolean } = {}
) {
  const user = await getSessionUser();

  if (!user) {
    return { ok: false as const, status: 401, error: "No autenticado" };
  }

  const admin = isAdminRole(user.rolNombre);
  const centralAdmin = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
  const sellerSession = admin ? null : await getSellerSessionUser(user);

  if (!admin && sellerSession?.tipoPerfil !== "VENDEDOR") {
    return {
      ok: false as const,
      status: 403,
      error: "Debes abrir primero el perfil del vendedor",
    };
  }

  await ensureDraftTable();

  const where = [
    `d."id" = $1`,
    `d."estado" = 'ABIERTO'`,
    `d."creditoId" IS NULL`,
    `COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP`,
  ];
  const values: unknown[] = [draftId];

  if (admin && !centralAdmin) {
    values.push(user.aliadoAccesoId || -1);
    where.push(`s."aliadoId" = $${values.length}`);
  } else if (!admin) {
    values.push(sellerSession?.id || 0);
    where.push(`d."vendedorId" = $${values.length}`);

    values.push(user.aliadoId || -1);
    where.push(`s."aliadoId" = $${values.length}`);
  }
  if (options.operate && admin && !centralAdmin) {
    return {
      ok: false as const,
      status: 403,
      error: "Solo el administrador central puede operar esta solicitud",
    };
  }

  const rows = await prisma.$queryRawUnsafe<DraftRow[]>(
    `
      SELECT
        d.*,
        u."nombre" AS "usuarioNombre",
        u."usuario" AS "usuarioLogin",
        v."nombre" AS "vendedorNombre",
        v."documento" AS "vendedorDocumento",
        v."telefono" AS "vendedorTelefono",
        v."email" AS "vendedorEmail",
        s."nombre" AS "sedeNombre",
        s."codigo" AS "sedeCodigo",
        s."aliadoId" AS "sedeAliadoId"
      FROM "CreditoBorrador" d
      LEFT JOIN "Usuario" u ON u."id" = d."usuarioId"
      LEFT JOIN "Vendedor" v ON v."id" = d."vendedorId"
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      WHERE ${where.join(" AND ")}
      LIMIT 1
    `,
    ...values
  );

  const row = rows[0];
  if (!row) {
    return { ok: false as const, status: 404, error: "Borrador no encontrado" };
  }

  return { ok: true as const, row };
}

async function getDraftDataCreditoOffer(
  row: DraftRow,
  payload: DraftPayload,
  platform: "ANDROID" | "IPHONE"
): Promise<DraftDataCreditoOffer | null> {
  const dataCreditoProvider = getDataCreditoPublicConfig();

  if (!dataCreditoProvider.enabled) {
    return null;
  }

  if (!dataCreditoProvider.configured || !isDataCreditoAuditConfigured()) {
    throw new CreditValidationError(
      "La precalificacion de DataCredito esta habilitada, pero su configuracion segura esta incompleta.",
      503
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    !dataCreditoProvider.productionReady &&
    !allowsDataCreditoNonProductionProvider()
  ) {
    throw new CreditValidationError(
      "El ambiente de certificacion no puede autorizar ventas reales.",
      503
    );
  }

  if (sanitizeText(payload.clienteTipoDocumento) !== "CEDULA_DE_CIUDADANIA") {
    throw new CreditValidationError(
      "La precalificacion actual de DataCredito solo admite cedula de ciudadania.",
      409
    );
  }

  const documentNumber = sanitizeText(payload.clienteDocumento);
  if (!/^\d{3,13}$/.test(documentNumber)) {
    throw new CreditValidationError(
      "La cedula debe contener entre 3 y 13 digitos, sin puntos ni espacios."
    );
  }

  const assessment = await getApprovedDataCreditoAssessmentForCredit({
    assessmentId: sanitizeText(payload.dataCreditoAssessmentId),
    documentNumber,
    firstSurname: sanitizeText(payload.clientePrimerApellido),
    platform,
    providerEnvironment: dataCreditoProvider.environment,
    userId: row.usuarioId,
    sellerId: row.vendedorId,
    sedeId: row.sedeId,
    aliadoId: row.sedeAliadoId,
  });

  if (!assessment) {
    throw new CreditValidationError(
      "La precalificacion no esta aprobada, vencio o no coincide con la cedula y el primer apellido consultados para este credito.",
      409,
      "DATACREDITO_ASSESSMENT_INVALID"
    );
  }

  const initialPaymentPercentage = Number(
    assessment.offer?.initialPaymentPercentage
  );
  const suretyPercentage = Number(assessment.offer?.suretyPercentage);
  const maxFinancedAmount = Number(assessment.offer?.maxFinancedAmount);
  const financingTerms = resolveDataCreditoOfferFinancingTerms(
    platform,
    assessment.offer
  );
  const validOffer =
    Number.isFinite(initialPaymentPercentage) &&
    initialPaymentPercentage >= 0 &&
    initialPaymentPercentage <= 100 &&
    Number.isFinite(suretyPercentage) &&
    suretyPercentage >= 0 &&
    suretyPercentage <= 100 &&
    Number.isSafeInteger(maxFinancedAmount) &&
    maxFinancedAmount > 0 &&
    maxFinancedAmount <= DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT &&
    Boolean(financingTerms);

  if (!validOffer || !financingTerms) {
    throw new CreditValidationError(
      "La oferta de la precalificacion no es valida. Solicita revision de la politica de puntajes.",
      503
    );
  }

  return {
    assessmentId: assessment.id,
    policyVersion: assessment.policyVersion,
    policyRevisionId: assessment.policyRevisionId,
    initialPaymentPercentage,
    suretyPercentage,
    maxFinancedAmount,
    installmentCount: financingTerms.installmentCount,
    maxInstallmentAmount: financingTerms.maxInstallmentAmount,
    usedLegacyFinancingTermsFallback: financingTerms.usedLegacyFallback,
    financialSettings: assessment.offer?.financialSettings || null,
  };
}

async function buildDraftCredit(row: DraftRow): Promise<BuiltDraftCredit> {
  const payload = payloadObject(row.payload);
  const clientePrimerNombre = sanitizeText(payload.clientePrimerNombre);
  const clientePrimerApellido = sanitizeText(payload.clientePrimerApellido);
  const clienteNombre =
    sanitizeText(payload.clienteNombre) ||
    [clientePrimerNombre, clientePrimerApellido].filter(Boolean).join(" ");
  const clienteDocumento = sanitizeText(payload.clienteDocumento);
  const clienteTelefono = sanitizeText(payload.clienteTelefono);
  const referenciaFamiliar1Telefono = sanitizeText(
    payload.referenciaFamiliar1Telefono
  );
  const referenciaFamiliar2Telefono = sanitizeText(
    payload.referenciaFamiliar2Telefono
  );
  const clienteCorreo = sanitizeText(payload.clienteCorreo);
  const clienteDireccion = sanitizeText(payload.clienteDireccion);
  const equipoMarca = sanitizeText(payload.equipoMarca);
  const equipoModelo = sanitizeText(payload.equipoModelo);
  const contactPhoneValidation = validateCreditContactPhones({
    clienteTelefono,
    referenciaFamiliar1Telefono,
    referenciaFamiliar2Telefono,
  });
  if (!contactPhoneValidation.ok) {
    throw new CreditValidationError(contactPhoneValidation.message);
  }
  const contratoFotoDataUrl = sanitizeImageDataUrl(
    payload.contratoSelfieDataUrl || payload.contratoFotoDataUrl
  );
  const contratoCedulaFrenteDataUrl = sanitizeImageDataUrl(
    payload.contratoCedulaFrenteDataUrl || payload.cedulaFrenteDataUrl
  );
  const contratoCedulaRespaldoDataUrl = sanitizeImageDataUrl(
    payload.contratoCedulaRespaldoDataUrl || payload.cedulaRespaldoDataUrl
  );
  const referenciaEquipo =
    sanitizeText(payload.referenciaEquipo) ||
    [equipoMarca, equipoModelo].filter(Boolean).join(" ");
  const imei = sanitizeDeviceValue(payload.imei || payload.deviceUid)
    .replace(/\D/g, "");
  if (!/^\d{15}$/.test(imei)) {
    throw new CreditValidationError(
      "El IMEI debe tener exactamente 15 numeros antes de enviar a FirmaSeguro.",
      400,
      "FIRMASEGURO_IMEI_INVALID"
    );
  }
  const rawEquipmentCatalogId = payload.equipoCatalogoId;
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
    throw new CreditValidationError(
      "El identificador del equipo de catalogo es invalido."
    );
  }

  const catalogItem = equipoCatalogoId
    ? await findEquipmentCatalogItemById(equipoCatalogoId)
    : equipoMarca && equipoModelo
      ? await findEquipmentCatalogItem({ marca: equipoMarca, modelo: equipoModelo })
      : null;
  const platformResolution = resolveCreditEquipmentPlatform({
    requestedPlatform: payload.plataformaDispositivo,
    equipoMarca,
    equipoModelo,
    catalogItemId: equipoCatalogoId,
    catalogItem,
  });

  if (!platformResolution.ok) {
    throw new CreditValidationError(platformResolution.message);
  }

  const plataformaDispositivo = platformResolution.platform;
  const valorEquipoTotalInput = toNumber(payload.valorEquipoTotal);
  const precioBaseVentaCatalogo = catalogItem?.activo
    ? catalogItem.precioBaseVenta
    : null;
  const effectiveCreditSettings = await getEffectiveCreditSettings(
    undefined,
    plataformaDispositivo
  );
  const dataCreditoOffer = await getDraftDataCreditoOffer(
    row,
    payload,
    plataformaDispositivo
  );
  const dataCreditoCreditLimit = dataCreditoOffer
    ? await resolveDataCreditoManualCreditLimit({
        documento: clienteDocumento,
        policyMaxFinancedAmount: dataCreditoOffer.maxFinancedAmount,
      })
    : null;
  const dataCreditoMaxFinancedAmount =
    dataCreditoCreditLimit?.maxFinancedAmount || 0;
  const creditSettings = dataCreditoOffer
    ? {
        ...effectiveCreditSettings.globalSettings,
        cuotaInicialPorcentaje: dataCreditoOffer.initialPaymentPercentage,
        fianzaPorcentaje: dataCreditoOffer.suretyPercentage,
      }
    : effectiveCreditSettings.globalSettings;
  const initialPaymentBreakdown = resolveRequiredInitialPaymentByPlatform({
    valorTotalEquipo: valorEquipoTotalInput,
    precioBaseVenta: precioBaseVentaCatalogo,
    initialPaymentPercentage: creditSettings.cuotaInicialPorcentaje,
    platform: plataformaDispositivo,
    iphoneMaxFinancedAmount: creditSettings.iphoneTopeFinanciado,
    maxFinancedAmount: dataCreditoOffer
      ? dataCreditoMaxFinancedAmount
      : undefined,
  });
  const cuotaInicialMinima =
    initialPaymentBreakdown.requiredInitialPayment;
  const cuotaInicialInput = toNumber(payload.cuotaInicial);
  const cuotaInicial =
    cuotaInicialInput > 0
      ? Math.max(cuotaInicialMinima, cuotaInicialInput)
      : cuotaInicialMinima;
  const selectedDataCreditoInstallmentCount = dataCreditoOffer
    ? parseCreditInstallmentSelection(
        payload.plazoMeses,
        dataCreditoOffer.installmentCount
      )
    : null;
  if (dataCreditoOffer && selectedDataCreditoInstallmentCount === null) {
    throw new CreditValidationError(
      `El número de cuotas debe ser un entero entre 1 y ${dataCreditoOffer.installmentCount}.`
    );
  }
  const plazoMeses = dataCreditoOffer
    ? selectedDataCreditoInstallmentCount!
    : normalizeCreditInstallments(
        toNumber(payload.plazoMeses),
        creditSettings.plazoCuotas || DEFAULT_CREDIT_INSTALLMENTS,
        normalizeCreditInstallmentLimit(creditSettings.plazoMaximoCuotas)
      );
  const resolvedPolicyFinancialSettings =
    resolveCreditPolicyFinancialSettings({
      globalSettings: effectiveCreditSettings.globalSettings,
      policyFinancialSettings: dataCreditoOffer?.financialSettings,
      legacyOfferSuretyPercentage:
        dataCreditoOffer?.suretyPercentage ?? null,
      numeroCuotas: plazoMeses,
    });
  const frecuenciaPago = normalizePaymentFrequency(
    resolvedPolicyFinancialSettings.frecuenciaPago
  );
  const fechaCredito = new Date();
  const defaultFirstPaymentDate = getDefaultFirstPaymentDateObject(
    frecuenciaPago,
    fechaCredito
  );
  const requestedFirstPaymentDate = toValidDate(
    payload.fechaPrimerPago,
    defaultFirstPaymentDate
  );
  const fechaPrimerPago =
    requestedFirstPaymentDate > fechaCredito
      ? requestedFirstPaymentDate
      : defaultFirstPaymentDate;
  const amortizationPlan = calculateFrenchAmortization({
    calculoVersion: resolvedPolicyFinancialSettings.calculoVersion,
    tasaPeriodoDecimales:
      resolvedPolicyFinancialSettings.tasaPeriodoDecimales,
    redondeoComercial:
      resolvedPolicyFinancialSettings.redondeoComercial,
    valorVenta: valorEquipoTotalInput,
    cuotaInicial,
    numeroCuotas: plazoMeses,
    tasaInteresEa: resolvedPolicyFinancialSettings.tasaInteresEa,
    fianzaCuotaPorcentaje:
      resolvedPolicyFinancialSettings.fianzaCuotaPorcentaje,
    seguroCuotaPorcentaje:
      resolvedPolicyFinancialSettings.seguroCuotaPorcentaje,
    frecuenciaPago,
    fechaPrimerPago,
  });
  const financialPlan = {
    montoCreditoTotal:
      Math.round(amortizationPlan.montoTotal * 100) / 100,
    valorCuota: amortizationPlan.cuotaTotal,
    cuotaComercial: amortizationPlan.cuotaComercial,
    valorFianza:
      Math.round(amortizationPlan.valorFianzaTotal * 100) / 100,
  };
  const financingParameters: BuiltDraftCredit["financingParameters"] = {
    fianzaTotalPorcentaje:
      resolvedPolicyFinancialSettings.fianzaTotalPorcentaje,
    fianzaModalidad:
      resolvedPolicyFinancialSettings.fianzaModalidad,
    fianzaFuente: resolvedPolicyFinancialSettings.fianzaSource,
    tasaPeriodoDecimales:
      resolvedPolicyFinancialSettings.tasaPeriodoDecimales,
    redondeoComercial:
      resolvedPolicyFinancialSettings.redondeoComercial,
    policyVersion: dataCreditoOffer?.policyVersion || null,
    policyRevisionId:
      dataCreditoOffer?.policyRevisionId || null,
  };
  const iphoneInstallmentLimit = validateIphoneInstallmentLimit({
    platform: plataformaDispositivo,
    valorCuota: amortizationPlan.cuotaTotal,
    iphoneMaxInstallmentValue: dataCreditoOffer
      ? dataCreditoOffer.maxInstallmentAmount
      : creditSettings.iphoneTopeCuota,
  });

  if (iphoneInstallmentLimit.exceeded) {
    throw new CreditValidationError(iphoneInstallmentLimit.message);
  }

  const folio = sanitizeText(payload.firmaSeguroDraftFolio) || generateCreditFolio();
  const referenciaPago = generatePaymentReference(folio, clienteDocumento);

  return {
    credit: {
      folio,
    contratoSnapshot: {
      borradorId: row.id,
      origen: "BORRADOR_FIRMASEGURO",
      dataCredito: dataCreditoOffer
        ? {
            assessmentId: dataCreditoOffer.assessmentId,
            policyVersion: dataCreditoOffer.policyVersion,
            policyRevisionId: dataCreditoOffer.policyRevisionId,
            policyMaxFinancedAmount: dataCreditoOffer.maxFinancedAmount,
            manualMaxFinancedAmount:
              dataCreditoCreditLimit?.manualLimit?.maxFinancedAmount ?? null,
            resolvedMaxFinancedAmount: dataCreditoMaxFinancedAmount,
            maxFinancedAmount: dataCreditoMaxFinancedAmount,
            financingLimitSource:
              dataCreditoCreditLimit?.source || "POLICY",
            manualCreditLimitId:
              dataCreditoCreditLimit?.manualLimit?.id || null,
            manualCreditLimitVersion:
              dataCreditoCreditLimit?.manualLimit?.version || null,
            manualCreditLimitDocumentLast4:
              dataCreditoCreditLimit?.manualLimit?.documentLast4 || null,
            effectiveMaxFinancedAmount:
              dataCreditoMaxFinancedAmount,
            initialPaymentCalculationVersion: "BALANCE_LIMIT_V2",
            platformInitialPayment:
              initialPaymentBreakdown.platformInitialPayment,
            dataCreditoInitialPayment:
              initialPaymentBreakdown.dataCreditoInitialPayment,
            dataCreditoInitialPaymentAdjustment:
              initialPaymentBreakdown.dataCreditoInitialPaymentAdjustment,
            installmentCount: dataCreditoOffer.installmentCount,
            maxInstallmentCount: dataCreditoOffer.installmentCount,
            selectedInstallmentCount: plazoMeses,
            maxInstallmentAmount: dataCreditoOffer.maxInstallmentAmount,
            usedLegacyFinancingTermsFallback:
              dataCreditoOffer.usedLegacyFinancingTermsFallback,
            documentExceptionId: null,
          }
        : null,
    },
    clienteTipoDocumento: sanitizeText(payload.clienteTipoDocumento) || null,
    clienteNombre,
    clientePrimerNombre,
    clientePrimerApellido,
    clienteDocumento,
    clienteTelefono,
    clienteCorreo,
    clienteDireccion,
    referenciaEquipo,
    equipoMarca,
    equipoModelo,
    imei,
    deviceUid: imei,
    valorEquipoTotal: valorEquipoTotalInput,
    montoCredito: financialPlan.montoCreditoTotal,
    cuotaInicial,
    valorCuota: financialPlan.valorCuota,
    valorCuotaComercial: financialPlan.cuotaComercial,
    tasaInteresEa: amortizationPlan.tasaInteresEa,
    tasaPeriodo: amortizationPlan.tasaPeriodo,
    fianzaCuotaPorcentaje: amortizationPlan.fianzaCuotaPorcentaje,
    fianzaTotalPorcentaje:
      resolvedPolicyFinancialSettings.fianzaTotalPorcentaje,
    fianzaModalidad:
      resolvedPolicyFinancialSettings.fianzaModalidad,
    seguroCuotaPorcentaje: amortizationPlan.seguroCuotaPorcentaje,
    redondeoComercialModo:
      resolvedPolicyFinancialSettings.redondeoComercial.modo,
    redondeoComercialMultiplo:
      resolvedPolicyFinancialSettings.redondeoComercial.multiplo,
    valorSeguro: amortizationPlan.valorSeguroTotal,
    plazoMeses,
    frecuenciaPago,
    fechaPrimerPago,
    fechaCredito,
    referenciaPago,
    valorFianza: financialPlan.valorFianza,
    contratoIp: sanitizeText(payload.contratoIp) || null,
    contratoFotoDataUrl,
    contratoSelfieDataUrl: contratoFotoDataUrl,
    contratoCedulaFrenteDataUrl,
    contratoCedulaRespaldoDataUrl,
    usuario: {
      nombre: row.usuarioNombre || "Usuario FINSER PAY",
      usuario: row.usuarioLogin || null,
    },
    vendedor: row.vendedorId
      ? {
          nombre: row.vendedorNombre,
          documento: row.vendedorDocumento,
          telefono: row.vendedorTelefono,
          email: row.vendedorEmail,
        }
      : null,
      sede: {
        nombre: row.sedeNombre || "Sede",
        codigo: row.sedeCodigo,
        aliadoId: row.sedeAliadoId,
      },
    },
    amortizationPlan,
    financingParameters,
  };
}

function firmaSeguroErrorResponse(error: unknown) {
  if (error instanceof FirmaSeguroImeiCorrectionError) {
    return NextResponse.json(
      {
        ok: false,
        code: error.code,
        stage: "imei_correction",
        error: error.message,
      },
      { status: error.status }
    );
  }

  if (error instanceof CreditValidationError) {
    return NextResponse.json(
      {
        ok: false,
        code: error.code,
        stage: "credit_validation",
        error: error.message,
      },
      { status: error.status }
    );
  }

  if (error instanceof FirmaSeguroApiError) {
    return NextResponse.json(
      {
        ok: false,
        code: "FIRMASEGURO_PROVIDER_ERROR",
        stage: "provider_dispatch",
        error: error.message,
        detail: error.detail,
      },
      { status: error.status || 500 }
    );
  }

  const message =
    error instanceof Error
      ? error.message
      : "No se pudo procesar la solicitud de FirmaSeguro";

  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let draftIdForLog: number | null = null;
  try {
    const params = await context.params;
    const draftId = parseDraftId(params.id);
    draftIdForLog = draftId;

    if (!draftId) {
      return NextResponse.json(
        { ok: false, error: "Borrador invalido" },
        { status: 400 }
      );
    }

    const authorized = await readAuthorizedDraft(draftId);
    if (!authorized.ok) {
      return NextResponse.json(
        { ok: false, error: authorized.error },
        { status: authorized.status }
      );
    }

    const current = await getLatestFirmaSeguroProcessForDraft(draftId);
    if (!current) {
      return NextResponse.json({ ok: true, process: null });
    }

    const url = new URL(request.url);
    const shouldRefresh = url.searchParams.get("refresh") === "1";
    const process = shouldRefresh ? await refreshFirmaSeguroProcess(current) : current;

    return NextResponse.json({
      ok: true,
      process: serializeFirmaSeguroProcess(process),
    });
  } catch (error) {
    logFirmaSeguroDraftError("GET", draftIdForLog, error);
    return firmaSeguroErrorResponse(error);
  }
}

async function requireApprovedVeriffBeforeFirmaSeguro(row: DraftRow) {
  const payload = payloadObject(row.payload);
  const mustRequireVeriff =
    getDataCreditoPublicConfig().enabled || isVeriffRequired();
  if (!mustRequireVeriff) {
    return;
  }

  const validationId = Math.trunc(toNumber(payload.veriffValidationId));
  if (!Number.isInteger(validationId) || validationId <= 0) {
    throw new CreditValidationError(
      "Aprueba primero la identidad con Veriff antes de enviar el contrato.",
      409,
      "FIRMASEGURO_VERIFF_REQUIRED"
    );
  }

  const validation = await getVeriffValidationById(validationId);
  const draftDocument = sanitizeText(payload.clienteDocumento).replace(/\D/g, "");
  const validationDocument = String(
    validation?.clienteDocumento || ""
  ).replace(/\D/g, "");

  if (
    !validation ||
    validation.draftId !== row.id ||
    validation.creditoId ||
    !isVeriffApproved(validation) ||
    !draftDocument ||
    validationDocument !== draftDocument
  ) {
    throw new CreditValidationError(
      "La aprobación Veriff no corresponde a esta solicitud o ya no está vigente.",
      409,
      "FIRMASEGURO_VERIFF_INVALID"
    );
  }

  const latestRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `
      SELECT validation."id"
      FROM "VeriffIdentityValidation" validation
      WHERE validation."draftId" = $1
        AND validation."creditoId" IS NULL
      ORDER BY validation."id" DESC
      LIMIT 1
    `,
    row.id
  );
  if (Number(latestRows[0]?.id || 0) !== validation.id) {
    throw new CreditValidationError(
      "Existe una validación Veriff más reciente. Actualiza el estado antes de enviar el contrato.",
      409,
      "FIRMASEGURO_VERIFF_SUPERSEDED"
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let draftIdForLog: number | null = null;
  try {
    const params = await context.params;
    const draftId = parseDraftId(params.id);
    draftIdForLog = draftId;
    if (!draftId) {
      return NextResponse.json(
        { ok: false, code: "SOLICITUD_INVALIDA", error: "Borrador invalido" },
        { status: 400 }
      );
    }

    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, code: "NO_AUTENTICADO", error: "No autenticado" },
        { status: 401 }
      );
    }
    if (
      !isAdminRole(user.rolNombre) ||
      !isFinserPayCentralAlly(user.aliadoAccesoCodigo)
    ) {
      return NextResponse.json(
        {
          ok: false,
          code: "CORRECCION_IMEI_NO_AUTORIZADA",
          error: "Solo el administrador central FINSER PAY puede corregir el IMEI.",
        },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => null)) as
      | {
          action?: unknown;
          imei?: unknown;
          reason?: unknown;
          expectedCurrentImei?: unknown;
          expectedProcessUuid?: unknown;
          expectedEnrollmentReviewId?: unknown;
        }
      | null;
    if (String(body?.action || "").trim().toUpperCase() !== "CORREGIR_IMEI") {
      return NextResponse.json(
        {
          ok: false,
          code: "ACCION_CORRECCION_INVALIDA",
          error: "La accion solicitada no es valida.",
        },
        { status: 400 }
      );
    }

    const result = await correctFirmaSeguroDraftImei({
      draftId,
      imei: body?.imei,
      reason: body?.reason,
      expectedCurrentImei: body?.expectedCurrentImei,
      expectedProcessUuid: body?.expectedProcessUuid,
      expectedEnrollmentReviewId: body?.expectedEnrollmentReviewId,
      actorUserId: user.id,
      actorName: user.nombre,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logFirmaSeguroDraftError("PATCH", draftIdForLog, error);
    return firmaSeguroErrorResponse(error);
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let draftIdForLog: number | null = null;
  try {
    const params = await context.params;
    const draftId = parseDraftId(params.id);
    draftIdForLog = draftId;

    if (!draftId) {
      return NextResponse.json(
        { ok: false, error: "Borrador invalido" },
        { status: 400 }
      );
    }

    const authorized = await readAuthorizedDraft(draftId, { operate: true });
    if (!authorized.ok) {
      return NextResponse.json(
        { ok: false, error: authorized.error },
        { status: authorized.status }
      );
    }

    const current = await getLatestFirmaSeguroProcessForDraft(draftId);
    if (current && canReuseFirmaSeguroProcess(current)) {
      await recordFirmaSeguroImeiCorrectionReissue(draftId, current);
      return NextResponse.json({
        ok: true,
        idempotent: true,
        process: serializeFirmaSeguroProcess(current),
        message: "La solicitud ya tiene un proceso activo en FirmaSeguro",
      });
    }
    const dispatchLock = await tryAcquireFirmaSeguroDraftDispatchLock(draftId);
    if (!dispatchLock) {
      const concurrentProcess = await getLatestFirmaSeguroProcessForDraft(draftId);
      if (concurrentProcess && canReuseFirmaSeguroProcess(concurrentProcess)) {
        await recordFirmaSeguroImeiCorrectionReissue(draftId, concurrentProcess);
        return NextResponse.json({
          ok: true,
          idempotent: true,
          process: serializeFirmaSeguroProcess(concurrentProcess),
          message: "La solicitud ya tiene un proceso activo en FirmaSeguro",
        });
      }
      return NextResponse.json(
        {
          ok: false,
          code: "FIRMASEGURO_DISPATCH_IN_PROGRESS",
          stage: "provider_dispatch",
          error:
            "El expediente ya se esta enviando a FirmaSeguro. Espera unos segundos y actualiza el estado.",
        },
        { status: 409, headers: { "Retry-After": "2" } }
      );
    }

    try {
      const lockedAuthorized = await readAuthorizedDraft(draftId, {
        operate: true,
      });
      if (!lockedAuthorized.ok) {
        return NextResponse.json(
          { ok: false, error: lockedAuthorized.error },
          { status: lockedAuthorized.status }
        );
      }

      const lockedCurrent = await getLatestFirmaSeguroProcessForDraft(draftId);
      if (lockedCurrent && canReuseFirmaSeguroProcess(lockedCurrent)) {
        await recordFirmaSeguroImeiCorrectionReissue(draftId, lockedCurrent);
        return NextResponse.json({
          ok: true,
          idempotent: true,
          process: serializeFirmaSeguroProcess(lockedCurrent),
          message: "La solicitud ya tiene un proceso activo en FirmaSeguro",
        });
      }

      await requireApprovedVeriffBeforeFirmaSeguro(lockedAuthorized.row);
      const built = await buildDraftCredit(lockedAuthorized.row);
      const { credit, amortizationPlan, financingParameters } = built;
      const draftFolio = lockedCurrent?.draftFolio || credit.folio;
      const payload = {
        ...payloadObject(lockedAuthorized.row.payload),
        firmaSeguroDraftFolio: draftFolio,
      };
      const firmaSeguroDraftPayload: Record<string, unknown> = {
        ...payload,
      };
      delete firmaSeguroDraftPayload.iphoneSelfieCedulaDataUrl;
      delete firmaSeguroDraftPayload.iphoneSelfieCedulaCapturedAt;
      delete firmaSeguroDraftPayload.iphoneSelfieCedulaSource;

      credit.folio = draftFolio;
      credit.referenciaPago = generatePaymentReference(
        draftFolio,
        credit.clienteDocumento || ""
      );
      firmaSeguroDraftPayload.financialTermsSeal = createFinancingTermsSeal({
        folio: draftFolio,
        documento: credit.clienteDocumento || "",
        contrato: {
          tipoDocumento: credit.clienteTipoDocumento || "",
          clienteNombre: credit.clienteNombre,
          clienteTelefono: credit.clienteTelefono || "",
          clienteCorreo: credit.clienteCorreo || "",
          clienteDireccion: credit.clienteDireccion || "",
          equipoMarca: credit.equipoMarca || "",
          equipoModelo: credit.equipoModelo || "",
          referenciaEquipo: credit.referenciaEquipo || "",
          imei: credit.imei || credit.deviceUid || "",
        },
        amortizacion: amortizationPlan,
        parametros: financingParameters,
      });

      const updatedDraftRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
        `
          UPDATE "CreditoBorrador"
          SET "payload" = $2::jsonb,
              "updatedAt" = NOW()
          WHERE "id" = $1
            AND "estado" = 'ABIERTO'
            AND "creditoId" IS NULL
            AND COALESCE("expiresAt", "createdAt" + INTERVAL '15 days') >
              CURRENT_TIMESTAMP
          RETURNING "id"
        `,
        draftId,
        JSON.stringify(payload)
      );
      if (updatedDraftRows.length !== 1) {
        throw new CreditValidationError(
          "La solicitud cambió antes de enviar el contrato. Recarga el caso e intenta nuevamente.",
          409,
          "FIRMASEGURO_DRAFT_CHANGED"
        );
      }

      const process = await createFirmaSeguroProcessForDraft(credit, {
        draftId,
        draftFolio,
        draftPayload: firmaSeguroDraftPayload,
      });
      await recordFirmaSeguroImeiCorrectionReissue(draftId, process);

      return NextResponse.json({
        ok: true,
        process: serializeFirmaSeguroProcess(process),
        message: "Proceso de firma enviado a FirmaSeguro",
      });
    } finally {
      await dispatchLock.release();
    }
  } catch (error) {
    logFirmaSeguroDraftError("POST", draftIdForLog, error);
    return firmaSeguroErrorResponse(error);
  }
}
