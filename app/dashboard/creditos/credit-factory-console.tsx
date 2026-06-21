"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import QRCode from "qrcode";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import FinserBrand from "@/app/_components/finser-brand";
import {
  calculateCreditCharges,
  calculateFinancedBalance,
  calculateRequiredInitialPayment,
  DEFAULT_CREDIT_INSTALLMENTS,
  DEFAULT_FIANCO_SURETY_PERCENTAGE,
  DEFAULT_INITIAL_PAYMENT_PERCENTAGE,
  DEFAULT_LEGAL_CONSUMER_RATE_EA,
  DEFAULT_LEGAL_RATE_REFERENCE,
  DEFAULT_MAX_CREDIT_INSTALLMENTS,
  DEFAULT_PAYMENT_FREQUENCY,
  generatePagareNumber,
  getDefaultFirstPaymentDate,
  getCreditInstallmentOptions,
  getPaymentFrequencyLabel,
  MAX_CREDIT_INSTALLMENTS,
  MAX_DEVICE_FINANCING_BASE,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  PAYMENT_FREQUENCY_OPTIONS,
} from "@/lib/credit-factory";
import {
  runCedulaValidation,
  type CedulaValidationCheck,
  type CedulaValidationResult,
} from "@/lib/cedula-ocr";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  activo: boolean;
  sedeId: number;
  sedeNombre: string;
  aliadoId?: number | null;
  aliadoNombre?: string | null;
  aliadoCodigo?: string | null;
  sedeAccesoId?: number | null;
  sedeAccesoNombre?: string | null;
  aliadoAccesoId?: number | null;
  aliadoAccesoNombre?: string | null;
  aliadoAccesoCodigo?: string | null;
  rolId: number;
  rolNombre: string;
};

type SellerSessionProfile = {
  id: number;
  nombre: string;
  documento: string | null;
  telefono: string | null;
  email: string | null;
  debeCambiarPin: boolean;
  tipoPerfil: "VENDEDOR" | "SUPERVISOR";
  accesoSedeId?: number;
  accesoSedeNombre?: string;
  sedeId?: number;
  sedeNombre?: string;
} | null;

type FamilyReference = {
  nombre: string;
  parentesco: string;
  telefono: string;
};

type EvidenceAudit = {
  capturedAt: string;
  source: "camera" | "upload";
  durationSeconds?: number;
};

type DeliveryStatus = {
  detail: string;
  label: string;
  ready: boolean;
  tone: "amber" | "emerald" | "red" | "sky" | "slate";
} | null;

type DeliveryValidationState = {
  checkedAt: string;
  deviceState: string | null;
  remoteStatusCode: number | null;
  resultMessage: string | null;
  serviceDetails: string | null;
  status: DeliveryStatus;
};

type CedulaValidationState = {
  status: "idle" | "processing" | "valid" | "invalid";
  summary: string;
  checkedAt: string | null;
  checks: CedulaValidationCheck[];
};

type VeriffMode = "off" | "required" | "soft";

type VeriffIdentityDataState = {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  documentNumber: string | null;
  documentType: string | null;
  documentCountry: string | null;
  dateOfBirth: string | null;
  issueDate: string | null;
  validUntil: string | null;
  gender: string | null;
  nationality: string | null;
  placeOfBirth: string | null;
};

type VeriffRiskSignalState = {
  blocked?: boolean;
  fraudRiskLevel?: string | null;
  highRisk?: boolean;
  pepSanctionMatch?: boolean;
  reasons?: string[];
  riskLabels?: Array<{
    category?: string | null;
    label?: string | null;
    sessionIds?: string[];
  }>;
  riskScore?: number | null;
};

type VeriffValidationState = {
  id: number;
  status:
    | "ABANDONED"
    | "APPROVED"
    | "DECLINED"
    | "ERROR"
    | "EXPIRED"
    | "PENDING"
    | "RESUBMISSION"
    | "REVIEW";
  decision: string | null;
  approved: boolean;
  technicalApproved?: boolean;
  trusted?: boolean;
  riskBlocked?: boolean;
  riskSignals?: VeriffRiskSignalState | null;
  pending: boolean;
  veriffSessionId: string | null;
  sessionUrl: string | null;
  identityData: VeriffIdentityDataState | null;
  code: string | null;
  reason: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
};

function veriffIdentityHasAutofillData(
  validation: VeriffValidationState | null | undefined
) {
  const identity = validation?.identityData;

  if (!identity) {
    return false;
  }

  return Boolean(
    String(identity.fullName || "").trim() ||
      String(identity.firstName || "").trim() ||
      String(identity.lastName || "").trim() ||
      String(identity.documentNumber || "").replace(/\D/g, "") ||
      String(identity.dateOfBirth || "").trim() ||
      String(identity.issueDate || "").trim() ||
      String(identity.gender || "").trim()
  );
}

function veriffApprovalCanUnlockClient(
  validation: VeriffValidationState | null | undefined
) {
  return Boolean(
    validation?.approved &&
      validation.decidedAt &&
      veriffIdentityHasAutofillData(validation)
  );
}

type VeriffConfigState = {
  apiKeyFingerprint?: string | null;
  apiKeyHint?: string | null;
  configured: boolean;
  mode: VeriffMode;
  environment?: "live" | "test";
  decisionsTrusted?: boolean;
  baseUrl?: string | null;
};

type VeriffResponse = {
  ok?: boolean;
  error?: string;
  remotePayload?: unknown;
  remoteStatus?: number;
  validation?: VeriffValidationState | null;
  veriff?: VeriffConfigState;
};

type VeriffMediaState = {
  context: string;
  downloadUrl: string;
  duration: number | null;
  id: string;
  kind: "image" | "video";
  mimetype: string;
  name: string;
  size: number | null;
};

type VeriffMediaResponse = {
  ok?: boolean;
  error?: string;
  images?: VeriffMediaState[];
  videos?: VeriffMediaState[];
};

type MobileCaptureSession = {
  token: string;
  estado: string;
  expiresAt: string;
  expired: boolean;
  mobileUrl: string;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  evidence: {
    selfieReady: boolean;
    cedulaFrenteReady: boolean;
    cedulaRespaldoReady: boolean;
    videoReady: boolean;
    selfieDataUrl: string | null;
    selfieCapturedAt: string | null;
    selfieSource: string | null;
    cedulaFrenteDataUrl: string | null;
    cedulaFrenteCapturedAt: string | null;
    cedulaFrenteSource: string | null;
    cedulaRespaldoDataUrl: string | null;
    cedulaRespaldoCapturedAt: string | null;
    cedulaRespaldoSource: string | null;
    videoAprobacionDataUrl: string | null;
    videoAprobacionCapturedAt: string | null;
    videoAprobacionSource: string | null;
    videoAprobacionDuration: number | null;
  };
};

type MobileCaptureSessionResponse = {
  ok?: boolean;
  error?: string;
  session?: MobileCaptureSession;
};

type WhatsAppOtpResponse = {
  ok?: boolean;
  code?: string;
  details?: string | null;
  error?: string;
  messageId?: string | null;
  mode?: "template" | "text";
  recipient?: string;
};

type CreditItem = {
  id: number;
  folio: string;
  clienteNombre: string;
  clientePrimerNombre?: string | null;
  clientePrimerApellido?: string | null;
  clienteTipoDocumento?: string | null;
  clienteDireccion: string | null;
  clienteDocumento: string | null;
  clienteFechaNacimiento: string | null;
  clienteFechaExpedicion: string | null;
  clienteTelefono: string | null;
  clienteCorreo?: string | null;
  clienteDepartamento?: string | null;
  clienteCiudad?: string | null;
  clienteGenero?: string | null;
  imei: string;
  deviceUid: string;
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
  valorEquipoTotal: number;
  saldoBaseFinanciado: number;
  montoCredito: number;
  cuotaInicial: number;
  plazoMeses: number | null;
  frecuenciaPago: string | null;
  tasaInteresEa: number;
  valorInteres: number;
  fianzaPorcentaje: number;
  valorFianza: number;
  valorCuota: number;
  fechaCredito: string;
  fechaPrimerPago: string | null;
  fechaProximoPago: string | null;
  referenciaPago: string | null;
  estado: string;
  deliverableLabel: string | null;
  deliverableReady: boolean;
  equalityState: string | null;
  equalityService: string | null;
  equalityPayload: Record<string, unknown> | null;
  equalityLastCheckAt: string | null;
  graceUntil: string | null;
  warrantyUntil: string | null;
  bloqueoRobo: boolean;
  bloqueoRoboAt: string | null;
  bloqueoMora?: boolean;
  bloqueoMoraAt?: string | null;
  pazYSalvoEmitidoAt: string | null;
  observacionAdmin: string | null;
  contratoAceptadoAt: string | null;
  pagareAceptadoAt: string | null;
  contratoIp: string | null;
  contratoFotoDataUrl?: string | null;
  contratoSelfieDataUrl?: string | null;
  contratoListo: boolean;
  contratoSelfieLista: boolean;
  contratoCedulaLista: boolean;
  contratoOtpCanal: string | null;
  contratoOtpDestino: string | null;
  contratoOtpVerificadoAt: string | null;
  referenciasFamiliares: FamilyReference[];
  totalAbonado: number;
  saldoPendiente: number;
  totalRecaudado: number;
  porcentajeRecaudado: number;
  estadoPago?: "PAGADO" | "AL_DIA" | "MORA";
  cuotasPagadas?: number;
  cuotasPendientes?: number;
  cuotasEnMora?: number;
  liquidacionAnticipada?: EarlyPayoffSummary;
  abonosCount: number;
  ultimoAbonoAt: string | null;
  createdAt: string;
  updatedAt: string;
  usuario: {
    id: number;
    nombre: string;
    usuario: string;
  };
  vendedor?: {
    id: number;
    nombre: string;
    documento: string | null;
  } | null;
  sede: {
    id: number;
    nombre: string;
  };
};

type CreditListResponse = {
  canAdmin: boolean;
  scope: string;
  search?: string;
  items: CreditItem[];
};

type CreditDraftPayload = Record<string, unknown>;

type CreditDraftItem = {
  id: number;
  estado: string;
  currentStep: number;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  imei: string | null;
  payload: CreditDraftPayload;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  usuario: {
    id: number;
    nombre: string;
    usuario: string;
  };
  vendedor: {
    id: number;
    nombre: string;
    documento: string | null;
  } | null;
  sede: {
    id: number;
    nombre: string;
  };
};

type CreditDraftListResponse = {
  ok?: boolean;
  scope?: string;
  search?: string;
  items: CreditDraftItem[];
  error?: string;
};

type CreditDraftSingleResponse = {
  ok?: boolean;
  item?: CreditDraftItem | null;
  error?: string;
};

type EquipmentCatalogItem = {
  id: number;
  marca: string;
  modelo: string;
  precioBaseVenta: number;
  activo: boolean;
};

type EquipmentCatalogResponse = {
  ok: boolean;
  items: EquipmentCatalogItem[];
  error?: string;
};

type CreditSettings = {
  tasaInteresEa: number;
  fianzaPorcentaje: number;
  cuotaInicialPorcentaje: number;
  plazoCuotas: number;
  plazoMaximoCuotas: number;
  frecuenciaPago: string;
  updatedAt: string | null;
};

type CreditDocumentException = {
  documentoNormalizado: string;
  permiteMultiplesCreditos: boolean;
  permiteEntregaSinVerificacion: boolean;
  activo: boolean;
};

type CreditSettingsResponse = {
  ok?: boolean;
  settings?: CreditSettings;
  documentException?: CreditDocumentException | null;
  error?: string;
};

type CreateCreditResponse = {
  ok: boolean;
  warning?: string;
  item: CreditItem;
  deliveryStatus: DeliveryStatus | null;
  identityValidation?: {
    id?: number | null;
    estado?: string | null;
    sessionId?: string | null;
  } | null;
};

type CommandResponse = {
  ok: boolean;
  message: string;
  item: CreditItem;
  remote: {
    deliveryStatus: DeliveryStatus;
    resultCode: string | null;
    resultMessage: string | null;
  } | null;
};

type ManualPushPreset = "custom" | "efecty" | "internet" | "mora";

type ManualPushResponse = {
  ok?: boolean;
  summary?: {
    checked: number;
    failed: number;
    noToken: number;
    sent: number;
    targetCredits: number;
    wouldSend: number;
  };
  error?: string;
};

type FirmaSeguroResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  documentUrl?: string | null;
  process?: {
    id?: number;
    creditoId?: number | null;
    draftId?: number | null;
    draftFolio?: string | null;
    processUuid?: string | null;
    status?: string | null;
    hasSignedDocument?: boolean;
    signedDocumentFileName?: string | null;
    lastError?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    completedAt?: string | null;
  } | null;
};

type FirmaSeguroProcess = NonNullable<FirmaSeguroResponse["process"]>;

function isFirmaSeguroSuccessfulProcess(process?: FirmaSeguroProcess | null) {
  if (!process) {
    return false;
  }

  const normalized = String(process.status || "")
    .trim()
    .toUpperCase();

  return Boolean(
    process.completedAt ||
      process.hasSignedDocument ||
      [
        "COMPLETED",
        "COMPLETE",
        "COMPLETADO",
        "FINALIZED",
        "FINALIZADO",
        "FINISHED",
        "SIGNED",
        "FIRMADO",
        "APROBADO",
        "APROBADA",
        "EXITOSO",
        "EXITOSA",
        "SUCCESS",
        "SUCCESSFUL",
      ].some((item) => normalized.includes(item))
  );
}

type CreditPaymentItem = {
  id: number;
  creditoId: number;
  valor: number;
  metodoPago: string;
  observacion: string | null;
  estado?: string;
  anuladoAt?: string | null;
  anulacionMotivo?: string | null;
  fechaAbono: string;
  createdAt: string;
  usuario: {
    id: number;
    nombre: string;
    usuario: string;
  };
  sede: {
    id: number;
    nombre: string;
  };
};

type PaymentPlanInstallment = {
  numero: number;
  fechaVencimiento: string;
  valorProgramado: number;
  valorAbonado: number;
  saldoPendiente: number;
  estado: "PAGO" | "PENDIENTE";
  estaEnMora?: boolean;
};

type EarlyPayoffSummary = {
  capitalPendiente: number;
  condonacion: number;
  disponible: boolean;
  motivo?: string | null;
  saldoObligacion: number;
};

type CreditPaymentsResponse = {
  ok: boolean;
  credito: {
    id: number;
    folio: string;
    clienteNombre: string;
    clienteDocumento: string | null;
    clienteTelefono: string | null;
    montoCredito: number;
    cuotaInicial: number;
    fechaProximoPago: string | null;
    referenciaPago: string | null;
    estado: string;
    totalAbonado: number;
    saldoPendiente: number;
    totalRecaudado: number;
    porcentajeRecaudado: number;
    estadoPago?: "PAGADO" | "AL_DIA" | "MORA";
    nextInstallment?: PaymentPlanInstallment | null;
    overdueCount?: number;
    paidCount?: number;
    pendingCount?: number;
    plan?: PaymentPlanInstallment[];
    liquidacionAnticipada?: EarlyPayoffSummary;
    abonosCount: number;
    ultimoAbonoAt: string | null;
  };
  items: CreditPaymentItem[];
};

type RegisterPaymentResponse = {
  ok: boolean;
  message: string;
  item: CreditPaymentItem;
  summary: {
    totalAbonado: number;
    saldoPendiente: number;
    totalRecaudado: number;
    porcentajeRecaudado: number;
    estadoPago?: "PAGADO" | "AL_DIA" | "MORA";
    nextInstallment?: PaymentPlanInstallment | null;
    overdueCount?: number;
    paidCount?: number;
    pendingCount?: number;
    plan?: PaymentPlanInstallment[];
    liquidacionAnticipada?: EarlyPayoffSummary;
    abonosCount: number;
    ultimoAbonoAt: string | null;
  };
};

type NoticeTone = "amber" | "emerald" | "red" | "slate";
type PaymentRegisterMode = "INSTALLMENTS" | "PAYOFF";

type Notice = {
  text: string;
  tone: NoticeTone;
};

type CaptureSlot =
  | "selfie"
  | "cedula-frente"
  | "cedula-respaldo"
  | "video-aprobacion";
type EvidenceProcessingMode = "default" | "document";

type CreditAdminCommand =
  | "consult-device"
  | "payment-reference"
  | "toggle-stolen-lock"
  | "toggle-mora-lock"
  | "update-due-date"
  | "update-plan"
  | "extend-1h"
  | "extend-24h"
  | "extend-48h"
  | "warranty-15d"
  | "warranty-20d"
  | "remove-lock";

const DOCUMENT_TYPE_OPTIONS = [
  { value: "CEDULA_DE_CIUDADANIA", label: "Cedula de Ciudadania" },
  { value: "CEDULA_DE_EXTRANJERIA", label: "Cedula de Extranjeria" },
  { value: "PASAPORTE", label: "Pasaporte" },
  { value: "PPT", label: "Permiso por Proteccion Temporal" },
];

const GENDER_OPTIONS = [
  { value: "MASCULINO", label: "Masculino" },
  { value: "FEMENINO", label: "Femenino" },
  { value: "OTRO", label: "Otro" },
  { value: "PREFIERO_NO_DECIR", label: "Prefiero no decirlo" },
];

const DEPARTMENT_CITY_OPTIONS: Record<string, string[]> = {
  ANTIOQUIA: ["Medellin", "Bello", "Itagui", "Envigado", "Rionegro"],
  ATLANTICO: ["Barranquilla", "Soledad", "Malambo", "Puerto Colombia"],
  BOLIVAR: ["Cartagena", "Magangue", "Turbaco", "Arjona"],
  CALDAS: ["Manizales", "Villamaria", "Chinchina", "La Dorada"],
  CUNDINAMARCA: ["Bogota", "Soacha", "Facatativa", "Zipaquira", "Chia"],
  HUILA: ["Neiva", "Pitalito", "Garzon", "La Plata"],
  META: ["Villavicencio", "Granada", "Acacias", "Puerto Lopez"],
  RISARALDA: ["Pereira", "Dosquebradas", "Santa Rosa de Cabal"],
  SANTANDER: ["Bucaramanga", "Floridablanca", "Girón", "Piedecuesta"],
  TOLIMA: ["Ibague", "Espinal", "Melgar", "Honda", "Lerida"],
  VALLE_DEL_CAUCA: ["Cali", "Palmira", "Tulua", "Buenaventura", "Buga"],
};

const DEPARTMENT_OPTIONS = Object.keys(DEPARTMENT_CITY_OPTIONS).map((value) => ({
  value,
  label: value.replace(/_/g, " "),
}));

const FLEXIBLE_WIZARD_FOR_TESTING = false;

const copCurrencyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function currency(value: number) {
  return copCurrencyFormatter.format(Math.round(Number(value || 0)));
}

function currencyInputValue(value: string | number) {
  const normalized = String(value ?? "").replace(/\D/g, "");

  if (!normalized) {
    return "";
  }

  return copCurrencyFormatter.format(Number(normalized));
}

function equipmentCatalogKey(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function parseDisplayDate(value: string | null | undefined) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateTime(value: string | null | undefined) {
  const parsed = parseDisplayDate(value);

  if (!parsed) {
    return "-";
  }

  return parsed.toLocaleString("es-CO");
}

function dateOnly(value: string | null | undefined) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const parsed = parseDisplayDate(normalized);
  return parsed ? parsed.toISOString().slice(0, 10) : "";
}

function valueOrDash(value: unknown) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || "-";
}

function humanizeConstant(value: unknown) {
  const normalized = valueOrDash(value);

  if (normalized === "-") {
    return normalized;
  }

  return normalized.replace(/_/g, " ");
}

function formatPercent(value: number | null | undefined) {
  const numeric = Number(value || 0);
  return `${Math.max(0, Math.min(100, Math.round(numeric)))}%`;
}

function paymentMethodLabel(value: string) {
  const normalized = String(value || "").trim().toUpperCase();

  if (normalized === "NEQUI") {
    return "Nequi";
  }

  if (normalized === "DAVIPLATA") {
    return "Daviplata";
  }

  if (normalized === "TRANSFERENCIA") {
    return "Transferencia";
  }

  if (normalized === "OTRO") {
    return "Otro";
  }

  return "Efectivo";
}

function noticeClasses(tone: NoticeTone) {
  switch (tone) {
    case "emerald":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "amber":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "red":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function deliveryClasses(ready: boolean) {
  return ready
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : "border-amber-200 bg-amber-50 text-amber-900";
}

function stateBadgeClasses(estado: string) {
  const normalized = String(estado || "").toUpperCase();

  if (normalized === "ANULADO") {
    return "border-red-200 bg-red-50 text-red-700";
  }

  if (normalized === "ENTREGABLE") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (normalized === "ROBO_BLOQUEADO") {
    return "border-red-200 bg-red-50 text-red-700";
  }

  if (normalized === "PAZ_Y_SALVO") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  if (normalized === "INSCRITO") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function isCreditAnnulled(estado: string | null | undefined) {
  return String(estado || "").trim().toUpperCase() === "ANULADO";
}

type TileTone = "slate" | "emerald" | "amber" | "sky" | "red" | "white";

function tileClasses(tone: TileTone) {
  switch (tone) {
    case "emerald":
      return "border-emerald-200 bg-emerald-50 text-emerald-950";
    case "amber":
      return "border-amber-200 bg-amber-50 text-amber-950";
    case "sky":
      return "border-sky-200 bg-sky-50 text-sky-950";
    case "red":
      return "border-red-200 bg-red-50 text-red-950";
    case "white":
      return "border-[#dbe5ec] bg-white text-slate-950";
    default:
      return "border-slate-200 bg-slate-50 text-slate-950";
  }
}

function tileLabelClasses(tone: TileTone) {
  switch (tone) {
    case "emerald":
      return "text-emerald-700";
    case "amber":
      return "text-amber-700";
    case "sky":
      return "text-sky-700";
    case "red":
      return "text-red-700";
    default:
      return "text-slate-500";
  }
}

function InfoTile({
  label,
  value,
  detail,
  tone = "slate",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: TileTone;
}) {
  return (
    <div className={["rounded-2xl border px-4 py-4", tileClasses(tone)].join(" ")}>
      <p className={["text-[11px] font-semibold uppercase", tileLabelClasses(tone)].join(" ")}>
        {label}
      </p>
      <div className="mt-2 break-words text-lg font-black leading-snug">{value}</div>
      {detail ? (
        <div className="mt-1 break-words text-sm font-medium text-slate-600">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="border-b border-slate-200 py-3 last:border-b-0">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <div className="mt-1 break-words text-sm font-black leading-snug text-slate-950">
        {value}
      </div>
      {detail ? (
        <div className="mt-1 break-words text-xs leading-5 text-slate-500">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
  });

  const data = (await response.json().catch(() => null)) as T & {
    error?: string;
    warning?: string;
  };

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function readFileAsDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.readAsDataURL(file);
  });
}

async function readVideoDuration(file: File) {
  return await new Promise<number>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("No se pudo leer la duracion del video."));
    };
    video.src = objectUrl;
  });
}

function inferVideoMimeType(file: File) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();

  if (/^video\/(webm|mp4|ogg|quicktime|x-m4v)$/i.test(type)) {
    return type;
  }

  if (/\.webm$/i.test(name)) {
    return "video/webm";
  }

  if (/\.mp4$/i.test(name)) {
    return "video/mp4";
  }

  if (/\.ogg$/i.test(name)) {
    return "video/ogg";
  }

  if (/\.(mov|qt)$/i.test(name)) {
    return "video/quicktime";
  }

  if (/\.m4v$/i.test(name)) {
    return "video/x-m4v";
  }

  return "";
}

function ensureVideoDataUrl(value: string, file?: File) {
  let normalized = String(value || "").trim();
  const inferredMimeType = file ? inferVideoMimeType(file) : "";

  if (
    inferredMimeType &&
    /^data:(application\/octet-stream)?;base64,/i.test(normalized)
  ) {
    normalized = normalized.replace(
      /^data:(application\/octet-stream)?;base64,/i,
      `data:${inferredMimeType};base64,`
    );
  }

  if (!/^data:video\/(webm|mp4|ogg|quicktime|mov|x-m4v);base64,/i.test(normalized)) {
    throw new Error("El video debe guardarse en formato WebM, MP4, OGG o MOV.");
  }

  if (normalized.length > 10_000_000) {
    throw new Error("El video es demasiado pesado. Vuelve a grabarlo con menor peso.");
  }

  return normalized;
}

function getVideoMimeTypeFromDataUrl(value: string) {
  const match = /^data:([^;,]+)[;,]/i.exec(String(value || "").trim());
  return String(match?.[1] || "").toLowerCase();
}

function isBrowserPlayableVideoDataUrl(value: string) {
  const mimeType = getVideoMimeTypeFromDataUrl(value);
  return /^video\/(webm|mp4|ogg)$/i.test(mimeType);
}

function getVideoEvidenceFormatLabel(value: string) {
  const mimeType = getVideoMimeTypeFromDataUrl(value);

  if (mimeType === "video/quicktime" || mimeType === "video/mov") {
    return "QuickTime/MOV";
  }

  if (mimeType === "video/x-m4v") {
    return "M4V";
  }

  if (mimeType === "video/mp4") {
    return "MP4";
  }

  if (mimeType === "video/webm") {
    return "WEBM";
  }

  if (mimeType === "video/ogg") {
    return "OGG";
  }

  return "video";
}

function getVideoEvidenceDownloadName(value: string) {
  const mimeType = getVideoMimeTypeFromDataUrl(value);

  if (mimeType === "video/quicktime" || mimeType === "video/mov") {
    return "video-aprobacion.mov";
  }

  if (mimeType === "video/x-m4v") {
    return "video-aprobacion.m4v";
  }

  if (mimeType === "video/mp4") {
    return "video-aprobacion.mp4";
  }

  if (mimeType === "video/ogg") {
    return "video-aprobacion.ogg";
  }

  return "video-aprobacion.webm";
}

async function compressImageDataUrl(
  dataUrl: string,
  maxSide = 960,
  quality = 0.78
) {
  return await new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("No se pudo preparar la foto"));
        return;
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => reject(new Error("La foto seleccionada no es valida"));
    image.src = dataUrl;
  });
}

function getDocumentCaptureCrop(width: number, height: number) {
  const aspectRatio = 1.586;
  const maxFrameWidth = width * 0.82;
  const maxFrameHeight = height * 0.58;
  let cropWidth = maxFrameWidth;
  let cropHeight = cropWidth / aspectRatio;

  if (cropHeight > maxFrameHeight) {
    cropHeight = maxFrameHeight;
    cropWidth = cropHeight * aspectRatio;
  }

  const x = Math.max(0, Math.round((width - cropWidth) / 2));
  const y = Math.max(0, Math.round((height - cropHeight) / 2 + height * 0.04));

  return {
    x,
    y: Math.min(y, Math.max(0, height - Math.round(cropHeight))),
    width: Math.round(cropWidth),
    height: Math.round(cropHeight),
  };
}

function SignaturePad({
  onChange,
  padKey,
}: {
  onChange: (value: string) => void;
  padKey: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(190 * ratio));

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.scale(ratio, ratio);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, rect.width, 190);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#0f172a";
    context.lineWidth = 2.4;
    onChange("");
  }, [onChange, padKey]);

  const resolvePoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return { x: 0, y: 0 };
    }

    const rect = canvas.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const beginStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    const point = resolvePoint(event);
    drawingRef.current = true;
    lastPointRef.current = point;

    context.beginPath();
    context.arc(point.x, point.y, 1.2, 0, Math.PI * 2);
    context.fillStyle = "#0f172a";
    context.fill();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    const nextPoint = resolvePoint(event);
    context.beginPath();
    context.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    context.lineTo(nextPoint.x, nextPoint.y);
    context.stroke();
    lastPointRef.current = nextPoint;
  };

  const endStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) {
      return;
    }

    drawingRef.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onChange(canvasRef.current?.toDataURL("image/png") || "");
  };

  return (
    <canvas
      key={padKey}
      ref={canvasRef}
      className="h-[190px] w-full touch-none rounded-[24px] border border-dashed border-[#d8c9b1] bg-white"
      onPointerDown={beginStroke}
      onPointerMove={moveStroke}
      onPointerUp={endStroke}
      onPointerLeave={endStroke}
    />
  );
}

function CameraCaptureModal({
  open,
  slot,
  onClose,
  onCapture,
}: {
  open: boolean;
  slot: CaptureSlot | null;
  onClose: () => void;
  onCapture: (
    value: string,
    slot: CaptureSlot,
    audit?: Partial<EvidenceAudit>
  ) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const countdownRef = useRef<number | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const documentSlot = slot === "cedula-frente" || slot === "cedula-respaldo";
  const videoSlot = slot === "video-aprobacion";

  const stopActiveStream = () => {
    if (countdownRef.current) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    if (!open || !slot) {
      stopActiveStream();
      setRecording(false);
      setRecordingSeconds(0);
      return;
    }

    let active = true;

    const startCamera = async () => {
      try {
        setStarting(true);
        setError("");

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Este navegador no permite abrir la camara.");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: videoSlot,
          video: {
            facingMode: slot === "selfie" || videoSlot ? "user" : "environment",
            width: { ideal: documentSlot ? 1920 : videoSlot ? 960 : 1280 },
            height: { ideal: documentSlot ? 1080 : videoSlot ? 540 : 720 },
          },
        });

        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => null);
        }
      } catch (cameraError) {
        setError(
          cameraError instanceof Error
            ? cameraError.message
            : "No se pudo iniciar la camara"
        );
      } finally {
        setStarting(false);
      }
    };

    void startCamera();

    return () => {
      active = false;
      stopActiveStream();
      setRecording(false);
    };
  }, [documentSlot, open, slot, videoSlot]);

  if (!open || !slot) {
    return null;
  }

  const captureLabel =
    slot === "selfie"
      ? "selfie del cliente"
      : slot === "cedula-frente"
        ? "frente de la cédula"
        : "respaldo de la cédula";

  const captureLabelClean =
    slot === "selfie"
      ? "selfie del cliente"
      : slot === "cedula-frente"
        ? "frente de la cedula"
        : slot === "video-aprobacion"
          ? "video de aprobacion"
          : "respaldo de la cedula";

  const finishVideoCapture = (durationSeconds: number) => {
    const slotValue = slot;
    const chunks = [...recordedChunksRef.current];
    recordedChunksRef.current = [];
    setRecording(false);
    setRecordingSeconds(0);

    if (!slotValue || slotValue !== "video-aprobacion") {
      return;
    }

    if (!chunks.length) {
      setError("No se pudo capturar el video. Intenta grabarlo nuevamente.");
      return;
    }

    const mimeType =
      recorderRef.current?.mimeType || "video/webm;codecs=vp8,opus";
    const blob = new Blob(chunks, { type: mimeType });
    const reader = new FileReader();

    reader.onload = () => {
      onCapture(String(reader.result || ""), slotValue, {
        capturedAt: new Date().toISOString(),
        source: "camera",
        durationSeconds,
      });
      onClose();
    };
    reader.onerror = () => {
      setError("No se pudo procesar el video grabado.");
    };
    reader.readAsDataURL(blob);
  };

  const takePicture = () => {
    const video = videoRef.current;

    if (!video) {
      setError("La camara aun no esta lista.");
      return;
    }

    const width = Math.max(1, video.videoWidth || 1280);
    const height = Math.max(1, video.videoHeight || 720);
    const canvas = document.createElement("canvas");

    if (documentSlot) {
      const crop = getDocumentCaptureCrop(width, height);
      const documentMaxWidth = 2200;
      const scale = Math.min(2.6, documentMaxWidth / Math.max(1, crop.width));
      canvas.width = Math.max(1, Math.round(crop.width * scale));
      canvas.height = Math.max(1, Math.round(crop.height * scale));
      const context = canvas.getContext("2d");

      if (!context) {
        setError("No se pudo preparar la captura.");
        return;
      }

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        video,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
      onCapture(canvas.toDataURL("image/jpeg", 0.95), slot);
      onClose();
      return;
    }

    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");

    if (!context) {
      setError("No se pudo preparar la captura.");
      return;
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    onCapture(canvas.toDataURL("image/jpeg", 0.82), slot);
    onClose();
  };

  const startVideoRecording = () => {
    const stream = streamRef.current;

    if (!stream) {
      setError("La camara aun no esta lista.");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setError("Este navegador no permite grabar video desde la camara.");
      return;
    }

    const mimeType = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ].find((candidate) =>
      typeof MediaRecorder.isTypeSupported === "function"
        ? MediaRecorder.isTypeSupported(candidate)
        : candidate === "video/webm"
    );

    try {
      recordedChunksRef.current = [];
      setRecording(true);
      setError("");
      setRecordingSeconds(0);

      const startedAt = Date.now();
      const recorder = mimeType
        ? new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 850_000,
            audioBitsPerSecond: 96_000,
          })
        : new MediaRecorder(stream);

      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const elapsedSeconds = Math.max(
          1,
          Math.round((Date.now() - startedAt) / 1000)
        );
        finishVideoCapture(elapsedSeconds);
      };
      recorder.start(250);

      countdownRef.current = window.setInterval(() => {
        setRecordingSeconds((current) => current + 1);
      }, 1000);
    } catch (recordError) {
      setRecording(false);
      setRecordingSeconds(0);
      setError(
        recordError instanceof Error
          ? recordError.message
          : "No se pudo iniciar la grabacion de video."
      );
    }
  };

  const stopVideoRecording = () => {
    if (countdownRef.current) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4 py-6">
      <div className="w-full max-w-3xl rounded-[28px] border border-white/10 bg-[#0f172a] p-5 text-white shadow-[0_25px_80px_rgba(15,23,42,0.5)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#f1d19c]">
              Captura guiada
            </p>
            <h3 className="mt-2 text-2xl font-black tracking-tight">
              Tomar{" "}
              {videoSlot
                ? "video de aprobacion"
                : captureLabel
                    .replace("cÃ©dula", "cedula")
                    .replace("Ã©", "e")}
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              {videoSlot
                ? "Graba el video donde el cliente diga: YO [NOMBRE] APRUEBO LA COMPRA CON FINSERPAY."
                : "Se abre la camara del computador para capturar la evidencia y anexarla al contrato digital."}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/16"
          >
            Cerrar
          </button>
        </div>

        <div className="mt-5 rounded-[24px] border border-white/10 bg-black/50 p-3">
          <div className="relative">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className={[
                "h-[420px] w-full rounded-[18px] bg-black",
                documentSlot ? "object-contain" : "object-cover",
              ].join(" ")}
            />
            {documentSlot && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative h-[220px] w-[350px] max-w-[82%] rounded-[26px] border-[3px] border-dashed border-[#f1d19c] shadow-[0_0_0_999px_rgba(15,23,42,0.38)]">
                  <div className="absolute -top-10 left-1/2 w-max -translate-x-1/2 rounded-full bg-slate-950/75 px-3 py-1 text-[11px] font-semibold tracking-[0.14em] text-[#f8dfb9]">
                    Acerca solo la cedula al marco
                  </div>
                  <div className="absolute -bottom-12 left-1/2 w-max max-w-[92vw] -translate-x-1/2 rounded-2xl bg-slate-950/75 px-4 py-2 text-center text-xs text-slate-100">
                    La selfie ya va aparte. Aqui debe verse solo el documento, centrado y legible.
                  </div>
                </div>
              </div>
            )}
            {videoSlot && (
              <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-6">
                <div className="rounded-2xl bg-slate-950/75 px-4 py-3 text-center text-xs font-medium text-slate-100">
                  Mira al frente y di claramente:
                  <span className="mt-1 block text-sm font-semibold text-[#f8dfb9]">
                    YO APRUEBO LA COMPRA CON FINSERPAY
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {(starting || error) && (
          <div
            className={[
              "mt-4 rounded-2xl border px-4 py-3 text-sm",
              error
                ? "border-red-200/30 bg-red-500/10 text-red-100"
                : "border-sky-200/30 bg-sky-500/10 text-sky-100",
            ].join(" ")}
          >
            {error || "Abriendo camara... autoriza el acceso para continuar."}
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          {videoSlot ? (
            <button
              type="button"
              onClick={recording ? stopVideoRecording : startVideoRecording}
              disabled={starting || Boolean(error)}
              className="rounded-2xl bg-[#1f8f65] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#18724f] disabled:opacity-70"
            >
              {recording
                ? `Detener grabacion (${recordingSeconds}s)`
                : "Grabar video"}
            </button>
          ) : (
            <button
              type="button"
              onClick={takePicture}
              disabled={starting || Boolean(error)}
              className="rounded-2xl bg-[#1f8f65] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#18724f] disabled:opacity-70"
            >
              Capturar ahora
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={recording}
            className="rounded-2xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

function VideoEvidenceCard({
  title,
  description,
  metaLabel,
  value,
  onOpenCamera,
  onRemove,
  onFileChange,
}: {
  title: string;
  description: string;
  metaLabel?: string;
  value: string;
  onOpenCamera: () => void;
  onRemove: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="rounded-[24px] border border-[#cbe4e8] bg-[#f6fcfd] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {title}
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onOpenCamera}
          className="rounded-2xl bg-[#145a5a] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a]"
        >
          Grabar video
        </button>

        <label className="inline-flex cursor-pointer items-center rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
          Cargar video
          <input
            type="file"
            accept="video/webm,video/mp4,video/ogg,video/quicktime,.mov,video/*"
            onChange={onFileChange}
            className="hidden"
          />
        </label>

        <button
          type="button"
          onClick={onRemove}
          disabled={!value}
          className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
        >
          Borrar y grabar de nuevo
        </button>
      </div>

      <div className="mt-4 rounded-[22px] border border-dashed border-[#d8c9b1] bg-white p-3">
        <VideoEvidencePreview
          value={value}
          emptyLabel="Aun no hay video registrado."
          heightClassName="h-52"
          roundedClassName="rounded-[16px]"
        />
      </div>

      {metaLabel ? (
        <p className="mt-3 text-xs font-medium leading-5 text-slate-500">{metaLabel}</p>
      ) : null}
    </div>
  );
}

function VideoEvidencePreview({
  value,
  emptyLabel,
  heightClassName,
  roundedClassName = "rounded-2xl",
}: {
  value: string;
  emptyLabel: string;
  heightClassName: string;
  roundedClassName?: string;
}) {
  const [failedPreviewValue, setFailedPreviewValue] = useState<string | null>(null);

  if (!value) {
    return (
      <div
        className={[
          "flex items-center justify-center bg-slate-50 text-sm text-slate-500",
          heightClassName,
          roundedClassName,
        ].join(" ")}
      >
        {emptyLabel}
      </div>
    );
  }

  const previewFailed = failedPreviewValue === value;
  const showPlayer = isBrowserPlayableVideoDataUrl(value) && !previewFailed;
  const formatLabel = getVideoEvidenceFormatLabel(value);
  const downloadName = getVideoEvidenceDownloadName(value);

  if (!showPlayer) {
    return (
      <div
        className={[
          "flex flex-col items-center justify-center gap-3 bg-slate-50 px-5 text-center",
          heightClassName,
          roundedClassName,
        ].join(" ")}
      >
        <div>
          <p className="text-sm font-bold text-slate-900">Video guardado</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Formato {formatLabel}. Si no se reproduce en este navegador, abre o descarga el archivo.
          </p>
        </div>
        <a
          href={value}
          download={downloadName}
          className="rounded-2xl bg-[#145a5a] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#0f4a4a]"
        >
          Abrir / descargar video
        </a>
      </div>
    );
  }

  return (
    <div>
      <video
        src={value}
        controls
        preload="metadata"
        onError={() => setFailedPreviewValue(value)}
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration;
          if (!Number.isFinite(duration) || duration <= 0) {
            setFailedPreviewValue(value);
          }
        }}
        className={[
          "w-full bg-slate-950 object-contain",
          heightClassName,
          roundedClassName,
        ].join(" ")}
      />
      <a
        href={value}
        download={downloadName}
        className="mt-3 inline-flex rounded-2xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
      >
        Descargar video
      </a>
    </div>
  );
}

function EvidenceCaptureCard({
  title,
  description,
  metaLabel,
  value,
  tone = "teal",
  onOpenCamera,
  onRemove,
  onFileChange,
}: {
  title: string;
  description: string;
  metaLabel?: string;
  value: string;
  tone?: "teal" | "amber" | "slate";
  onOpenCamera: () => void;
  onRemove: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const toneClasses =
    tone === "amber"
      ? "border-[#ead7b8] bg-[#fffaf2]"
      : tone === "slate"
        ? "border-slate-200 bg-slate-50"
        : "border-[#cbe4e8] bg-[#f6fcfd]";

  return (
    <div className={["rounded-[24px] border p-4", toneClasses].join(" ")}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {title}
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onOpenCamera}
          className="rounded-2xl bg-[#145a5a] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a]"
        >
          Tomar foto
        </button>

        <label className="inline-flex cursor-pointer items-center rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
          Cargar archivo
          <input
            type="file"
            accept="image/*"
            onChange={onFileChange}
            className="hidden"
          />
        </label>

        <button
          type="button"
          onClick={onRemove}
          disabled={!value}
          className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
        >
          Borrar y tomar otra
        </button>
      </div>

      <div className="mt-4 rounded-[22px] border border-dashed border-[#d8c9b1] bg-white p-3">
        {value ? (
          <img
            src={value}
            alt={title}
            className="h-52 w-full rounded-[16px] object-cover"
          />
        ) : (
          <div className="flex h-52 items-center justify-center rounded-[16px] bg-slate-50 text-sm text-slate-500">
            Aun no hay captura.
          </div>
        )}
      </div>

      {metaLabel ? (
        <p className="mt-3 text-xs font-medium leading-5 text-slate-500">{metaLabel}</p>
      ) : null}
    </div>
  );
}

function esAliadoFinserPay(codigo: string | null | undefined) {
  return String(codigo || "").trim().toUpperCase() === "FINSERPAY";
}

export default function CreditFactoryConsole({
  initialSession,
  initialSeller = null,
  view = "factory",
  initialSearch = "",
  initialSelectedId = null,
  initialDraftId = null,
  entryMode = "default",
}: {
  initialSession: SessionUser;
  initialSeller?: SellerSessionProfile;
  view?: "factory" | "payments" | "lookup";
  initialSearch?: string;
  initialSelectedId?: number | null;
  initialDraftId?: number | null;
  entryMode?: "default" | "create-client" | "delivery" | "simulator";
}) {
  const canAdmin = String(initialSession.rolNombre || "").toUpperCase() === "ADMIN";
  const canSeeInternalPricing =
    canAdmin && esAliadoFinserPay(initialSession.aliadoAccesoCodigo);
  const canSupervisor = !canAdmin && initialSeller?.tipoPerfil === "SUPERVISOR";
  const canViewSavedCredits = canAdmin || canSupervisor;
  const paymentsView = view === "payments";
  const lookupView = view === "lookup";
  const createClientMode = !paymentsView && !lookupView && entryMode === "create-client";
  const deliveryMode = !paymentsView && !lookupView && entryMode === "delivery";
  const simulatorMode = !paymentsView && !lookupView && entryMode === "simulator";
  const lookupMode = (lookupView && canViewSavedCredits) || deliveryMode;
  const clientLookupMode = lookupView && canViewSavedCredits;
  const canAdminMoveFreelyInFactory = canAdmin && !paymentsView && !lookupMode;
  const adminFactoryAssistAvailable = canAdmin && createClientMode;
  const pathname = usePathname();
  const normalizedInitialSearch = initialSearch.trim();
  const [showAdminAssist, setShowAdminAssist] = useState(
    adminFactoryAssistAvailable &&
      (Boolean(normalizedInitialSearch) || Boolean(initialDraftId))
  );
  const adminFactoryAssistMode = adminFactoryAssistAvailable && showAdminAssist;
  const canSearchCreditsInCurrentView = paymentsView || lookupMode || adminFactoryAssistMode;
  const showSearchSection = paymentsView || lookupMode || adminFactoryAssistMode;
  const [credits, setCredits] = useState<CreditItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [creating, setCreating] = useState(false);
  const [registeringPayment, setRegisteringPayment] = useState(false);
  const [runningCommand, setRunningCommand] = useState<CreditAdminCommand | null>(null);
  const [searchTerm, setSearchTerm] = useState(normalizedInitialSearch);
  const [activeSearch, setActiveSearch] = useState(normalizedInitialSearch);
  const [draftId, setDraftId] = useState<number | null>(initialDraftId);
  const [draftSearchResults, setDraftSearchResults] = useState<CreditDraftItem[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [draftStatus, setDraftStatus] = useState<
    "idle" | "loading" | "saving" | "saved" | "error"
  >(initialDraftId ? "loading" : "idle");
  const [draftLastSavedAt, setDraftLastSavedAt] = useState("");
  const [showPaymentResults, setShowPaymentResults] = useState(false);
  const [paymentsTab, setPaymentsTab] = useState<"pay" | "history">("pay");
  const [showSearchResults, setShowSearchResults] = useState(true);
  const [showLookupDetail, setShowLookupDetail] = useState(false);
  const [documentRenderDate, setDocumentRenderDate] = useState("");
  const [documentRenderDateTime, setDocumentRenderDateTime] = useState("");
  const selectedCreditPanelRef = useRef<HTMLDivElement | null>(null);
  const lookupDetailPanelRef = useRef<HTMLDivElement | null>(null);
  const historySectionRef = useRef<HTMLDivElement | null>(null);
  const [wizardStep, setWizardStep] = useState(simulatorMode ? 2 : 1);
  const [clienteNombre, setClienteNombre] = useState("");
  const [clientePrimerNombre, setClientePrimerNombre] = useState("");
  const [clientePrimerApellido, setClientePrimerApellido] = useState("");
  const [clienteTipoDocumento, setClienteTipoDocumento] = useState(
    DOCUMENT_TYPE_OPTIONS[0].value
  );
  const [clienteDireccion, setClienteDireccion] = useState("");
  const [clienteDocumento, setClienteDocumento] = useState("");
  const [clienteFechaNacimiento, setClienteFechaNacimiento] = useState("");
  const [clienteFechaExpedicion, setClienteFechaExpedicion] = useState("");
  const [clienteTelefono, setClienteTelefono] = useState("");
  const [clienteCorreo, setClienteCorreo] = useState("");
  const [clienteDepartamento, setClienteDepartamento] = useState("");
  const [clienteCiudad, setClienteCiudad] = useState("");
  const [clienteGenero, setClienteGenero] = useState("");
  const [referenciaFamiliar1Nombre, setReferenciaFamiliar1Nombre] = useState("");
  const [referenciaFamiliar1Parentesco, setReferenciaFamiliar1Parentesco] =
    useState("");
  const [referenciaFamiliar1Telefono, setReferenciaFamiliar1Telefono] =
    useState("");
  const [referenciaFamiliar2Nombre, setReferenciaFamiliar2Nombre] = useState("");
  const [referenciaFamiliar2Parentesco, setReferenciaFamiliar2Parentesco] =
    useState("");
  const [referenciaFamiliar2Telefono, setReferenciaFamiliar2Telefono] =
    useState("");
  const [equipoMarca, setEquipoMarca] = useState("");
  const [equipoModelo, setEquipoModelo] = useState("");
  const [equipmentCatalog, setEquipmentCatalog] = useState<EquipmentCatalogItem[]>([]);
  const [creditSettings, setCreditSettings] = useState<CreditSettings>({
    tasaInteresEa: DEFAULT_LEGAL_CONSUMER_RATE_EA,
    fianzaPorcentaje: DEFAULT_FIANCO_SURETY_PERCENTAGE,
    cuotaInicialPorcentaje: DEFAULT_INITIAL_PAYMENT_PERCENTAGE,
    plazoCuotas: DEFAULT_CREDIT_INSTALLMENTS,
    plazoMaximoCuotas: DEFAULT_MAX_CREDIT_INSTALLMENTS,
    frecuenciaPago: DEFAULT_PAYMENT_FREQUENCY,
    updatedAt: null,
  });
  const [creditDocumentException, setCreditDocumentException] =
    useState<CreditDocumentException | null>(null);
  const [creditSettingsDocument, setCreditSettingsDocument] = useState("");
  const [imei, setImei] = useState("");
  const [valorEquipoTotal, setValorEquipoTotal] = useState("");
  const [cuotaInicial, setCuotaInicial] = useState("");
  const [plazoMeses, setPlazoMeses] = useState(String(DEFAULT_CREDIT_INSTALLMENTS));
  const [tasaInteresEa, setTasaInteresEa] = useState(
    String(DEFAULT_LEGAL_CONSUMER_RATE_EA)
  );
  const [fianzaPorcentaje, setFianzaPorcentaje] = useState(
    String(DEFAULT_FIANCO_SURETY_PERCENTAGE)
  );
  const [fechaPrimerPago, setFechaPrimerPago] = useState(
    getDefaultFirstPaymentDate(new Date(), DEFAULT_PAYMENT_FREQUENCY)
  );
  const [contratoAceptado, setContratoAceptado] = useState(false);
  const [contratoFotoDataUrl, setContratoFotoDataUrl] = useState("");
  const [contratoCedulaFrenteDataUrl, setContratoCedulaFrenteDataUrl] = useState("");
  const [contratoCedulaRespaldoDataUrl, setContratoCedulaRespaldoDataUrl] =
    useState("");
  const [contratoFotoAudit, setContratoFotoAudit] = useState<EvidenceAudit | null>(null);
  const [contratoCedulaFrenteAudit, setContratoCedulaFrenteAudit] =
    useState<EvidenceAudit | null>(null);
  const [contratoCedulaRespaldoAudit, setContratoCedulaRespaldoAudit] =
    useState<EvidenceAudit | null>(null);
  const [contratoVideoAprobacionDataUrl, setContratoVideoAprobacionDataUrl] =
    useState("");
  const [contratoVideoAprobacionAudit, setContratoVideoAprobacionAudit] =
    useState<EvidenceAudit | null>(null);
  const [contratoFirmaDataUrl, setContratoFirmaDataUrl] = useState("");
  const [signaturePadKey, setSignaturePadKey] = useState(0);
  const [otpCodeGenerated, setOtpCodeGenerated] = useState("");
  const [otpCodeTyped, setOtpCodeTyped] = useState("");
  const [otpVerifiedAt, setOtpVerifiedAt] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
  const [pagareAceptado, setPagareAceptado] = useState(false);
  const [cartaAceptada, setCartaAceptada] = useState(false);
  const [autorizacionDatosAceptada, setAutorizacionDatosAceptada] =
    useState(false);
  const [cameraSlot, setCameraSlot] = useState<CaptureSlot | null>(null);
  const [mobileCaptureSession, setMobileCaptureSession] =
    useState<MobileCaptureSession | null>(null);
  const [mobileCaptureQrDataUrl, setMobileCaptureQrDataUrl] = useState("");
  const [creatingMobileCapture, setCreatingMobileCapture] = useState(false);
  const [observacionAdmin, setObservacionAdmin] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [planInstallments, setPlanInstallments] = useState("");
  const [planFrequency, setPlanFrequency] = useState(DEFAULT_PAYMENT_FREQUENCY);
  const [planFirstPaymentDate, setPlanFirstPaymentDate] = useState("");
  const [updatingPlan, setUpdatingPlan] = useState(false);
  const [manualPushPreset, setManualPushPreset] =
    useState<ManualPushPreset>("internet");
  const [manualPushTitle, setManualPushTitle] = useState("FINSER PAY");
  const [manualPushBody, setManualPushBody] = useState("");
  const [sendingManualPush, setSendingManualPush] = useState(false);
  const [firmaSeguroSubmitting, setFirmaSeguroSubmitting] = useState(false);
  const [firmaSeguroRefreshing, setFirmaSeguroRefreshing] = useState(false);
  const [firmaSeguroDraftProcess, setFirmaSeguroDraftProcess] =
    useState<FirmaSeguroProcess | null>(null);
  const [paymentValue, setPaymentValue] = useState("");
  const [receivedPaymentValue, setReceivedPaymentValue] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("EFECTIVO");
  const [paymentObservation, setPaymentObservation] = useState("");
  const [paymentRegisterMode, setPaymentRegisterMode] =
    useState<PaymentRegisterMode>("INSTALLMENTS");
  const [selectedInstallmentNumbers, setSelectedInstallmentNumbers] = useState<string[]>([]);
  const [payments, setPayments] = useState<CreditPaymentItem[]>([]);
  const [paymentSummary, setPaymentSummary] = useState<CreditPaymentsResponse["credito"] | null>(null);
  const [deliveryValidation, setDeliveryValidation] =
    useState<DeliveryValidationState | null>(null);
  const [veriffConfig, setVeriffConfig] = useState<VeriffConfigState>({
    configured: false,
    mode: "soft",
  });
  const [veriffValidation, setVeriffValidation] =
    useState<VeriffValidationState | null>(null);
  const [veriffQrDataUrl, setVeriffQrDataUrl] = useState("");
  const [veriffInlineMessage, setVeriffInlineMessage] = useState("");
  const [veriffSubmitting, setVeriffSubmitting] = useState(false);
  const [veriffRefreshing, setVeriffRefreshing] = useState(false);
  const [veriffMediaItems, setVeriffMediaItems] = useState<VeriffMediaState[]>([]);
  const [veriffMediaLoading, setVeriffMediaLoading] = useState(false);
  const [veriffMediaError, setVeriffMediaError] = useState("");
  const [enrollingDelivery, setEnrollingDelivery] = useState(false);
  const [validatingDelivery, setValidatingDelivery] = useState(false);
  const mobileCaptureAppliedRef = useRef<string>("");
  const applyingVeriffIdentityRef = useRef(false);
  const veriffAutoSessionRef = useRef(false);
  const [cedulaValidation, setCedulaValidation] = useState<CedulaValidationState>({
    status: "idle",
    summary:
      "Carga frente y respaldo de la cedula y valida que coincidan con los datos ingresados.",
    checkedAt: null,
    checks: [],
  });
  const draftSaveTimerRef = useRef<number | null>(null);
  const applyingDraftRef = useRef(false);

  const selectedCredit = useMemo(
    () => credits.find((item) => item.id === selectedId) || null,
    [credits, selectedId]
  );
  const sameClientCredits = useMemo(() => {
    if (!selectedCredit) {
      return [];
    }

    const selectedDocument = String(selectedCredit.clienteDocumento || "")
      .trim()
      .toUpperCase();
    const selectedPhone = String(selectedCredit.clienteTelefono || "").trim();
    const selectedName = String(selectedCredit.clienteNombre || "")
      .trim()
      .toUpperCase();

    return [...credits]
      .filter((item) => {
        const itemDocument = String(item.clienteDocumento || "")
          .trim()
          .toUpperCase();
        const itemPhone = String(item.clienteTelefono || "").trim();
        const itemName = String(item.clienteNombre || "")
          .trim()
          .toUpperCase();

        if (selectedDocument && itemDocument) {
          return selectedDocument === itemDocument;
        }

        if (selectedPhone && itemPhone) {
          return selectedPhone === itemPhone;
        }

        return selectedName && itemName === selectedName;
      })
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      );
  }, [credits, selectedCredit]);
  const selectedClientSearchValue = selectedCredit
    ? selectedCredit.clienteDocumento ||
      selectedCredit.clienteTelefono ||
      selectedCredit.folio
    : "";
  const clientInitialTotal = sameClientCredits.reduce(
    (total, item) => total + item.cuotaInicial,
    0
  );
  const clientPaymentsTotal = sameClientCredits.reduce(
    (total, item) => total + item.totalAbonado,
    0
  );
  const clientPrimaryStatus =
    selectedCredit?.saldoPendiente && selectedCredit.saldoPendiente > 0
      ? "Con saldo"
      : selectedCredit?.pazYSalvoEmitidoAt
        ? "Paz y salvo"
        : selectedCredit?.estado || "Activo";
  const accessProfileLabel = canSeeInternalPricing
    ? "Admin central"
    : canAdmin
      ? "Admin aliado"
      : canSupervisor
        ? "Supervisor de sede"
        : initialSeller
          ? "Vendedor"
          : "Sede";
  const accessScopeLabel = canSeeInternalPricing
    ? "Global: todos los aliados"
    : canAdmin
      ? `Aliado ${initialSession.aliadoAccesoNombre || initialSession.aliadoNombre || initialSession.sedeNombre}`
      : canSupervisor
        ? `Sede ${initialSeller?.sedeNombre || initialSession.sedeNombre}`
        : initialSeller
          ? `Sede ${initialSeller.sedeNombre}`
          : `Sede ${initialSession.sedeNombre}`;
  const selectedCreditDocumentLabel = selectedCredit
    ? `${humanizeConstant(selectedCredit.clienteTipoDocumento || "CC")} ${
        selectedCredit.clienteDocumento || "Sin documento"
      }`
    : "-";
  const selectedCreditLocationLine = selectedCredit
    ? [
        selectedCredit.clienteDireccion,
        selectedCredit.clienteCiudad,
        selectedCredit.clienteDepartamento,
      ]
        .filter(Boolean)
        .join(" | ") || "-"
    : "-";
  const selectedCreditEquipmentLabel = selectedCredit
    ? selectedCredit.referenciaEquipo ||
      [selectedCredit.equipoMarca, selectedCredit.equipoModelo].filter(Boolean).join(" ") ||
      "Equipo sin referencia"
    : "-";
  const selectedCreditAdvisorLabel = selectedCredit
    ? selectedCredit.vendedor?.nombre || selectedCredit.usuario.nombre
    : "-";
  const selectedCreditPaymentStatusLabel =
    selectedCredit?.estadoPago === "MORA"
      ? "En mora"
      : selectedCredit?.estadoPago === "PAGADO"
        ? "Pagado"
        : "Al dia";
  const selectedCreditDocumentsStatus = selectedCredit?.contratoListo
    ? "Expediente completo"
    : selectedCredit?.contratoAceptadoAt || selectedCredit?.pagareAceptadoAt
      ? "Expediente parcial"
      : "Sin firma completa";
  const selectedCreditEvidenceStatus = selectedCredit
    ? [
        selectedCredit.contratoSelfieLista ? "Selfie lista" : "Selfie pendiente",
        selectedCredit.contratoCedulaLista ? "Cedula lista" : "Cedula pendiente",
        selectedCredit.contratoOtpVerificadoAt ? "OTP verificado" : "OTP pendiente",
      ].join(" | ")
    : "-";
  const selectedCreditLockStatus = selectedCredit?.bloqueoRobo
    ? "Bloqueo por robo activo"
    : selectedCredit?.bloqueoMora
      ? "Bloqueo por mora activo"
      : "Sin bloqueo manual activo";
  const selectedCreditLockCommand: CreditAdminCommand =
    selectedCredit?.bloqueoRobo ? "toggle-stolen-lock" : "toggle-mora-lock";
  const selectedCreditLockButtonLabel = selectedCredit?.bloqueoRobo
    ? "Desbloquear robo"
    : selectedCredit?.bloqueoMora
      ? "Desbloquear mora"
      : "Bloquear mora";
  const selectedCreditPaymentProgress = selectedCredit
    ? `${selectedCredit.cuotasPagadas || 0} pagas / ${
        selectedCredit.cuotasPendientes || 0
      } pendientes / ${selectedCredit.cuotasEnMora || 0} en mora`
    : "-";
  const selectedCreditPaidPercent = selectedCredit
    ? Math.max(0, Number(selectedCredit.porcentajeRecaudado || 0))
    : 0;
  const selectedCreditIsPaidOff = selectedCredit
    ? selectedCredit.saldoPendiente <= 0 || selectedCredit.estadoPago === "PAGADO"
    : false;
  const selectedCreditIsCurrent = selectedCredit
    ? selectedCredit.estadoPago !== "MORA" && (selectedCredit.cuotasEnMora || 0) <= 0
    : false;
  const selectedCreditCanCreateNewCredit = selectedCredit
    ? selectedCreditIsPaidOff ||
      (selectedCreditIsCurrent && selectedCreditPaidPercent >= 50)
    : false;
  const selectedCreditNewCreditTitle = selectedCreditCanCreateNewCredit
    ? "Crear nuevo credito con los datos de este cliente"
    : "Disponible cuando el credito este al dia y tenga al menos el 50% pagado";
  const selectedCreditCreatedLabel = selectedCredit
    ? `Creado ${dateTime(selectedCredit.createdAt)} | Actualizado ${dateTime(
        selectedCredit.updatedAt
      )}`
    : "-";
  const valorTotalEquipoNumero = Math.max(0, Number(valorEquipoTotal || 0));
  const activeEquipmentCatalog = useMemo(
    () => equipmentCatalog.filter((item) => item.activo),
    [equipmentCatalog]
  );
  const equipmentBrandOptions = useMemo(() => {
    const brands = new Map<string, string>();

    for (const item of activeEquipmentCatalog) {
      const key = equipmentCatalogKey(item.marca);
      if (key && !brands.has(key)) {
        brands.set(key, item.marca);
      }
    }

    return Array.from(brands.values());
  }, [activeEquipmentCatalog]);
  const equipmentModelOptions = useMemo(() => {
    const selectedBrandKey = equipmentCatalogKey(equipoMarca);

    return activeEquipmentCatalog.filter((item) => {
      if (!selectedBrandKey) {
        return false;
      }

      return equipmentCatalogKey(item.marca) === selectedBrandKey;
    });
  }, [activeEquipmentCatalog, equipoMarca]);
  const selectedEquipmentCatalogItem = useMemo(() => {
    const selectedBrandKey = equipmentCatalogKey(equipoMarca);
    const selectedModelKey = equipmentCatalogKey(equipoModelo);

    if (!selectedBrandKey || !selectedModelKey) {
      return null;
    }

    return (
      activeEquipmentCatalog.find(
        (item) =>
          equipmentCatalogKey(item.marca) === selectedBrandKey &&
          equipmentCatalogKey(item.modelo) === selectedModelKey
      ) || null
    );
  }, [activeEquipmentCatalog, equipoMarca, equipoModelo]);
  const precioBaseVentaCatalogo = selectedEquipmentCatalogItem?.precioBaseVenta || 0;
  const excedentePrecioBase =
    precioBaseVentaCatalogo > 0
      ? Math.max(0, valorTotalEquipoNumero - precioBaseVentaCatalogo)
      : Math.max(0, valorTotalEquipoNumero - MAX_DEVICE_FINANCING_BASE);
  const initialPaymentPercentage =
    creditSettings.cuotaInicialPorcentaje ?? DEFAULT_INITIAL_PAYMENT_PERCENTAGE;
  const cuotaInicialMinimaNumero = calculateRequiredInitialPayment(
    valorTotalEquipoNumero,
    precioBaseVentaCatalogo > 0 ? precioBaseVentaCatalogo : undefined,
    initialPaymentPercentage
  );
  const cuotaInicialNumero = Math.max(0, Number(cuotaInicial || 0));
  const cuotaInicialValida =
    valorTotalEquipoNumero > 0 &&
    cuotaInicialNumero >= cuotaInicialMinimaNumero &&
    cuotaInicialNumero <= valorTotalEquipoNumero;
  const plazoMaximoCuotas = normalizeCreditInstallmentLimit(
    creditSettings.plazoMaximoCuotas
  );
  const creditInstallmentOptions = useMemo(
    () => getCreditInstallmentOptions(plazoMaximoCuotas),
    [plazoMaximoCuotas]
  );
  const plazoMesesNumero = normalizeCreditInstallments(
    plazoMeses,
    creditSettings.plazoCuotas || DEFAULT_CREDIT_INSTALLMENTS,
    plazoMaximoCuotas
  );
  const tasaInteresEaNumero = Math.max(0, Number(tasaInteresEa || 0));
  const fianzaPorcentajeNumero = Math.max(0, Number(fianzaPorcentaje || 0));
  const saldoBaseFinanciado = calculateFinancedBalance(
    valorTotalEquipoNumero,
    cuotaInicialNumero
  );
  const financialPlan = calculateCreditCharges({
    saldoBaseFinanciado,
    cuotas: plazoMesesNumero,
    tasaInteresEa: tasaInteresEaNumero || DEFAULT_LEGAL_CONSUMER_RATE_EA,
    fianzaPorcentaje:
      fianzaPorcentajeNumero >= 0
        ? fianzaPorcentajeNumero
        : DEFAULT_FIANCO_SURETY_PERCENTAGE,
    frecuenciaPago: creditSettings.frecuenciaPago,
  });
  const saldoFinanciado = financialPlan.montoCreditoTotal;
  const valorCuota = financialPlan.valorCuota;
  const frecuenciaPagoLabel = getPaymentFrequencyLabel(creditSettings.frecuenciaPago);
  const creditSettingsScopeLabel = creditDocumentException
    ? `Parametros especiales para cedula ${creditDocumentException.documentoNormalizado}`
    : "Parametros globales";
  const referenciaEquipo = [equipoMarca.trim(), equipoModelo.trim()]
    .filter(Boolean)
    .join(" ");
  const imeiDigits = imei.replace(/\D/g, "");
  const factoryDraftPayload = useMemo(
    () => ({
      wizardStep,
      clienteNombre,
      clientePrimerNombre,
      clientePrimerApellido,
      clienteTipoDocumento,
      clienteDireccion,
      clienteDocumento,
      clienteFechaNacimiento,
      clienteFechaExpedicion,
      clienteTelefono,
      clienteCorreo,
      clienteDepartamento,
      clienteCiudad,
      clienteGenero,
      referenciaFamiliar1Nombre,
      referenciaFamiliar1Parentesco,
      referenciaFamiliar1Telefono,
      referenciaFamiliar2Nombre,
      referenciaFamiliar2Parentesco,
      referenciaFamiliar2Telefono,
      equipoMarca,
      equipoModelo,
      equipoCatalogoId: selectedEquipmentCatalogItem?.id || null,
      imei: imeiDigits,
      valorEquipoTotal,
      cuotaInicial,
      plazoMeses,
      frecuenciaPago: creditSettings.frecuenciaPago,
      tasaInteresEa: financialPlan.tasaInteresEa,
      fianzaPorcentaje: financialPlan.fianzaPorcentaje,
      fechaPrimerPago,
      contratoAceptado,
      contratoFotoDataUrl,
      contratoSelfieDataUrl: contratoFotoDataUrl,
      contratoSelfieCapturedAt: contratoFotoAudit?.capturedAt || null,
      contratoSelfieSource: contratoFotoAudit?.source || null,
      contratoFotoCapturedAt: contratoFotoAudit?.capturedAt || null,
      contratoFotoSource: contratoFotoAudit?.source || null,
      contratoCedulaFrenteDataUrl,
      cedulaFrenteDataUrl: contratoCedulaFrenteDataUrl,
      contratoCedulaFrenteCapturedAt:
        contratoCedulaFrenteAudit?.capturedAt || null,
      contratoCedulaFrenteSource: contratoCedulaFrenteAudit?.source || null,
      contratoCedulaRespaldoDataUrl,
      cedulaRespaldoDataUrl: contratoCedulaRespaldoDataUrl,
      contratoCedulaRespaldoCapturedAt:
        contratoCedulaRespaldoAudit?.capturedAt || null,
      contratoCedulaRespaldoSource: contratoCedulaRespaldoAudit?.source || null,
      veriffValidationId: veriffValidation?.id || null,
      pagareAceptado,
      cartaAceptada,
      autorizacionDatosAceptada,
    }),
    [
      autorizacionDatosAceptada,
      cartaAceptada,
      clienteCiudad,
      clienteCorreo,
      clienteDepartamento,
      clienteDireccion,
      clienteDocumento,
      clienteFechaExpedicion,
      clienteFechaNacimiento,
      clienteGenero,
      clienteNombre,
      clientePrimerApellido,
      clientePrimerNombre,
      clienteTelefono,
      clienteTipoDocumento,
      contratoAceptado,
      contratoCedulaFrenteAudit?.capturedAt,
      contratoCedulaFrenteAudit?.source,
      contratoCedulaFrenteDataUrl,
      contratoCedulaRespaldoAudit?.capturedAt,
      contratoCedulaRespaldoAudit?.source,
      contratoCedulaRespaldoDataUrl,
      contratoFotoAudit?.capturedAt,
      contratoFotoAudit?.source,
      contratoFotoDataUrl,
      creditSettings.frecuenciaPago,
      cuotaInicial,
      equipoMarca,
      equipoModelo,
      fechaPrimerPago,
      fianzaPorcentajeNumero,
      financialPlan.fianzaPorcentaje,
      financialPlan.tasaInteresEa,
      imeiDigits,
      pagareAceptado,
      plazoMeses,
      referenciaFamiliar1Nombre,
      referenciaFamiliar1Parentesco,
      referenciaFamiliar1Telefono,
      referenciaFamiliar2Nombre,
      referenciaFamiliar2Parentesco,
      referenciaFamiliar2Telefono,
      selectedEquipmentCatalogItem?.id,
      tasaInteresEaNumero,
      valorEquipoTotal,
      veriffValidation?.id,
      wizardStep,
    ]
  );
  const draftHasMeaningfulData = useMemo(() => {
    return Boolean(
      clienteDocumento.trim() ||
        clienteTelefono.trim() ||
        clientePrimerNombre.trim() ||
        clientePrimerApellido.trim() ||
        equipoMarca.trim() ||
        equipoModelo.trim() ||
        imeiDigits ||
        Number(valorEquipoTotal || 0) > 0
    );
  }, [
    clienteDocumento,
    clientePrimerApellido,
    clientePrimerNombre,
    clienteTelefono,
    equipoMarca,
    equipoModelo,
    imeiDigits,
    valorEquipoTotal,
  ]);
  const cityOptions = useMemo(
    () => DEPARTMENT_CITY_OPTIONS[clienteDepartamento] || [],
    [clienteDepartamento]
  );
  const clienteTipoDocumentoLabel =
    DOCUMENT_TYPE_OPTIONS.find((option) => option.value === clienteTipoDocumento)?.label ||
    clienteTipoDocumento ||
    "{{TIPO_DOCUMENTO}}";
  const fechaPrimerPagoLabel = fechaPrimerPago
    ? new Date(fechaPrimerPago).toLocaleDateString("es-CO")
    : "{{FECHA_PRIMER_PAGO}}";
  const pagarePreviewNumber = generatePagareNumber(
    `${clienteDocumento || "CLIENTE"}${imei || referenciaEquipo || "PREVIO"}`
  );
  const pagarePreviewNode = (
    <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
        Pagare digital
      </p>
      <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
        <p className="font-black text-slate-950">PAGARE No. {pagarePreviewNumber}</p>
        <p className="mt-2">
          Yo,{" "}
          <span className="font-semibold">
            {clienteNombre || "{{NOMBRE_CLIENTE}}"}
          </span>
          , identificado con{" "}
          <span className="font-semibold">{clienteTipoDocumentoLabel}</span> No.{" "}
          <span className="font-semibold">
            {clienteDocumento || "{{NUMERO_DOCUMENTO}}"}
          </span>
          , actuando en calidad de <span className="font-semibold">DEUDOR</span>,
          por medio del presente titulo valor me obligo de manera{" "}
          <span className="font-semibold">clara, expresa e incondicional</span> a
          pagar a la orden de:
        </p>

        <div className="mt-4">
          <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
          <p>NIT 902052909-4</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">
            {currency(saldoFinanciado)} (PESOS COLOMBIANOS)
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">1. FORMA DE PAGO</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Numero de cuotas: {plazoMesesNumero || "{{NUM_CUOTAS}}"}</li>
            <li>Frecuencia de pago: {frecuenciaPagoLabel}</li>
            <li>Valor de cada cuota: {currency(valorCuota)}</li>
            <li>Fecha de inicio: {fechaPrimerPagoLabel}</li>
          </ul>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">2. VENCIMIENTO ANTICIPADO</p>
          <p className="mt-2">
            El incumplimiento en el pago de una sola cuota dara derecho al
            ACREEDOR a declarar vencido el plazo y exigir el pago inmediato del
            saldo total de la obligacion.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">3. INTERESES</p>
          <p className="mt-2">
            En caso de mora, se causaran intereses moratorios a la maxima tasa
            legal permitida en Colombia.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">4. MERITO EJECUTIVO</p>
          <p className="mt-2">
            El presente pagare presta merito ejecutivo conforme a la ley, siendo
            exigible judicialmente sin necesidad de requerimientos adicionales.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">5. RENUNCIA A REQUERIMIENTOS</p>
          <p className="mt-2">
            El DEUDOR renuncia expresamente a requerimientos judiciales y
            extrajudiciales para la constitucion en mora.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">6. GASTOS DE COBRANZA</p>
          <p className="mt-2">
            El DEUDOR asumira todos los gastos de cobranza judicial y
            extrajudicial en caso de incumplimiento.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">7. FIRMA ELECTRONICA</p>
          <p className="mt-2">
            El DEUDOR acepta que este pagare es suscrito mediante mecanismos
            electronicos validos, incluyendo:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Direccion IP</li>
            <li>Correo electronico</li>
            <li>Evidencia fotografica</li>
          </ul>
          <p className="mt-2">de conformidad con la Ley 527 de 1999.</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">8. LUGAR DE CUMPLIMIENTO</p>
          <p className="mt-2">
            El pago debera realizarse en la ciudad de{" "}
            <span className="font-semibold">Ibague - Tolima</span>.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">9. FECHA DE EMISION</p>
          <p className="mt-2">{documentRenderDate || "Pendiente"}</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">EL DEUDOR</p>
          <p className="mt-2">{clienteNombre || "{{NOMBRE_CLIENTE}}"}</p>
          <p>
            {clienteTipoDocumentoLabel}{" "}
            {clienteDocumento || "{{NUMERO_DOCUMENTO}}"}
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
          <p>NIT 902052909-4</p>
        </div>
      </div>
    </div>
  );
  const cartaInstructionsPreviewNode = (
    <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
        Carta de instrucciones
      </p>
      <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
        <p className="font-black text-slate-950">
          CARTA DE INSTRUCCIONES PARA DILIGENCIAMIENTO DE PAGARE
        </p>
        <p className="mt-4">
          Yo,{" "}
          <span className="font-semibold">
            {clienteNombre || "{{NOMBRE_CLIENTE}}"}
          </span>
          , identificado con <span className="font-semibold">{clienteTipoDocumentoLabel}</span>{" "}
          No. <span className="font-semibold">{clienteDocumento || "{{NUMERO_DOCUMENTO}}"}</span>,
          en calidad de <span className="font-semibold">DEUDOR</span>, autorizo de
          manera expresa, irrevocable y permanente a:
        </p>

        <div className="mt-4">
          <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
          <p>NIT 902052909-4</p>
        </div>

        <p className="mt-4">
          para diligenciar el pagare suscrito por mi con base en las siguientes
          instrucciones:
        </p>

        <div className="mt-5">
          <p className="font-black text-slate-950">1. VALOR</p>
          <p className="mt-2">
            El ACREEDOR podra llenar el pagare por el valor total de la obligacion,
            incluyendo:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Capital</li>
            <li>Intereses corrientes</li>
            <li>Intereses de mora</li>
            <li>Gastos de cobranza</li>
            <li>Costas judiciales</li>
          </ul>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">2. FECHAS</p>
          <p className="mt-2">Podra establecer:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Fecha de exigibilidad</li>
            <li>Fechas de vencimiento</li>
            <li>Fecha de mora</li>
          </ul>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">3. VENCIMIENTO ANTICIPADO</p>
          <p className="mt-2">
            En caso de incumplimiento, el ACREEDOR podra declarar vencido el plazo
            y exigir la totalidad de la obligacion.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">4. ESPACIOS EN BLANCO</p>
          <p className="mt-2">
            El DEUDOR autoriza el diligenciamiento de cualquier espacio en blanco
            del pagare conforme a las condiciones del credito otorgado.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">5. USO JUDICIAL</p>
          <p className="mt-2">
            El pagare podra ser utilizado para iniciar procesos ejecutivos sin
            requerimientos adicionales.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">6. IRREVOCABILIDAD</p>
          <p className="mt-2">
            La presente autorizacion es irrevocable y se mantendra vigente hasta la
            cancelacion total de la obligacion.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">7. ACEPTACION ELECTRONICA</p>
          <p className="mt-2">
            Esta carta se entiende aceptada mediante mecanismos electronicos
            validos:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>IP</li>
            <li>Correo</li>
            <li>Evidencia digital</li>
          </ul>
          <p className="mt-2">conforme a la Ley 527 de 1999.</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">8. FECHA</p>
          <p className="mt-2">{documentRenderDate || "Pendiente"}</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">EL DEUDOR</p>
          <p className="mt-2">{clienteNombre || "{{NOMBRE_CLIENTE}}"}</p>
          <p>
            {clienteTipoDocumentoLabel}{" "}
            {clienteDocumento || "{{NUMERO_DOCUMENTO}}"}
          </p>
        </div>
      </div>
    </div>
  );
  const dataAuthorizationPreviewNode = (
    <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
        Autorizacion de datos personales
      </p>
      <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
        <p className="font-black text-slate-950">
          AUTORIZACION PARA EL TRATAMIENTO DE DATOS PERSONALES
        </p>
        <p>(Ley 1581 de 2012 y Decreto 1377 de 2013)</p>

        <div className="mt-4">
          <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
          <p>NIT: 902052909-4</p>
          <p>Domicilio: Ibague - Tolima</p>
        </div>

        <p className="mt-4">
          En calidad de titular de la informacion, yo,{" "}
          <span className="font-semibold">
            {clienteNombre || "{{NOMBRE_CLIENTE}}"}
          </span>
          , identificado con <span className="font-semibold">{clienteTipoDocumentoLabel}</span>{" "}
          No. <span className="font-semibold">{clienteDocumento || "{{NUMERO_DOCUMENTO}}"}</span>,
          autorizo de manera <span className="font-semibold">previa, expresa e informada</span>{" "}
          a FINSER PAY S.A.S. para recolectar, almacenar, usar, circular,
          actualizar y suprimir mis datos personales conforme a las siguientes
          condiciones:
        </p>

        <div className="mt-5">
          <p className="font-black text-slate-950">1. FINALIDAD DEL TRATAMIENTO</p>
          <p className="mt-2">Mis datos seran utilizados para:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Evaluacion y aprobacion de solicitudes de credito</li>
            <li>Gestion de cobranza judicial y extrajudicial</li>
            <li>Consulta, reporte y actualizacion en centrales de riesgo</li>
            <li>Verificacion de identidad</li>
            <li>Prevencion de fraude</li>
            <li>Gestion comercial y contacto</li>
            <li>Cumplimiento de obligaciones contractuales</li>
          </ul>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">2. DATOS TRATADOS</p>
          <p className="mt-2">Autorizo el tratamiento de:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Datos personales basicos (nombre, cedula, telefono, direccion)</li>
            <li>Datos financieros y crediticios</li>
            <li>Informacion de contacto</li>
            <li>Datos biometricos (fotografia, selfie y firma)</li>
            <li>Datos tecnicos (direccion IP, dispositivo, geolocalizacion)</li>
          </ul>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">3. CENTRALES DE RIESGO</p>
          <p className="mt-2">
            Autorizo de manera expresa a FINSER PAY S.A.S. para:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Consultar mi informacion en centrales de riesgo</li>
            <li>Reportar mi comportamiento de pago</li>
            <li>Actualizar y compartir dicha informacion con terceros autorizados</li>
          </ul>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">4. DERECHOS DEL TITULAR</p>
          <p className="mt-2">Como titular de los datos, tengo derecho a:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Conocer, actualizar y rectificar mis datos</li>
            <li>Solicitar prueba de esta autorizacion</li>
            <li>Ser informado del uso de mis datos</li>
            <li>Revocar la autorizacion y/o solicitar la supresion</li>
            <li>Acceder gratuitamente a mis datos</li>
          </ul>
          <p className="mt-2">
            Podre ejercer estos derechos a traves de los canales dispuestos por
            FINSER PAY S.A.S.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">5. MEDIDAS DE SEGURIDAD</p>
          <p className="mt-2">
            FINSER PAY S.A.S. implementara medidas de seguridad para proteger la
            informacion contra acceso no autorizado, perdida o alteracion.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">6. TRANSFERENCIA Y TRANSMISION</p>
          <p className="mt-2">Autorizo que mis datos puedan ser compartidos con:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Aliados comerciales</li>
            <li>Plataformas tecnologicas</li>
            <li>Entidades de cobranza</li>
            <li>Operadores de verificacion</li>
          </ul>
          <p className="mt-2">
            unicamente para las finalidades aqui descritas.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">7. VIGENCIA</p>
          <p className="mt-2">
            La presente autorizacion permanecera vigente durante la relacion
            contractual y hasta por el tiempo necesario para el cumplimiento de
            obligaciones legales.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">8. ACEPTACION ELECTRONICA</p>
          <p className="mt-2">
            Acepto que esta autorizacion se otorga mediante mecanismos electronicos
            validos, tales como:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Direccion IP</li>
            <li>Correo electronico</li>
            <li>Evidencia digital</li>
          </ul>
          <p className="mt-2">de conformidad con la Ley 527 de 1999.</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">9. FECHA DE AUTORIZACION</p>
          <p className="mt-2">{documentRenderDate || "Pendiente"}</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">EL TITULAR</p>
          <p className="mt-2">{clienteNombre || "{{NOMBRE_CLIENTE}}"}</p>
          <p>
            {clienteTipoDocumentoLabel}{" "}
            {clienteDocumento || "{{NUMERO_DOCUMENTO}}"}
          </p>
        </div>
      </div>
    </div>
  );
  useEffect(() => {
    setCedulaValidation((current) =>
      current.status === "processing"
        ? current
        : {
            status: "idle",
            summary:
              "Carga frente y respaldo de la cedula y valida que coincidan con los datos ingresados.",
            checkedAt: null,
            checks: [],
          }
    );
    if (applyingVeriffIdentityRef.current) {
      applyingVeriffIdentityRef.current = false;
      return;
    }
    setVeriffValidation(null);
    setVeriffQrDataUrl("");
    setVeriffInlineMessage("");
    setVeriffMediaItems([]);
    setVeriffMediaError("");
    veriffAutoSessionRef.current = false;
  }, [
    contratoCedulaFrenteDataUrl,
    contratoCedulaRespaldoDataUrl,
    clienteDocumento,
    clientePrimerNombre,
    clientePrimerApellido,
    clienteFechaNacimiento,
    clienteFechaExpedicion,
  ]);
  useEffect(() => {
    const now = new Date();
    setDocumentRenderDate(now.toLocaleDateString("es-CO"));
    setDocumentRenderDateTime(now.toLocaleString("es-CO"));
  }, []);
  useEffect(() => {
    if (!mobileCaptureSession?.mobileUrl) {
      setMobileCaptureQrDataUrl("");
      return;
    }

    let active = true;

    void QRCode.toDataURL(mobileCaptureSession.mobileUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    })
      .then((value: string) => {
        if (active) {
          setMobileCaptureQrDataUrl(value);
        }
      })
      .catch(() => {
        if (active) {
          setMobileCaptureQrDataUrl("");
        }
      });

    return () => {
      active = false;
    };
  }, [mobileCaptureSession?.mobileUrl]);
  useEffect(() => {
    if (!veriffValidation?.sessionUrl) {
      setVeriffQrDataUrl("");
      return;
    }

    let active = true;

    void QRCode.toDataURL(veriffValidation.sessionUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: {
        dark: "#0f766e",
        light: "#ffffff",
      },
    })
      .then((value: string) => {
        if (active) {
          setVeriffQrDataUrl(value);
        }
      })
      .catch(() => {
        if (active) {
          setVeriffQrDataUrl("");
        }
      });

    return () => {
      active = false;
    };
  }, [veriffValidation?.sessionUrl]);
  useEffect(() => {
    if (
      wizardStep !== 3 ||
      !mobileCaptureSession?.token ||
      mobileCaptureSession.expired ||
      mobileCaptureSession.estado === "EXPIRADA"
    ) {
      return;
    }

    const syncOnce = () => {
      void syncMobileCaptureSession(mobileCaptureSession.token, true).catch(() => null);
    };

    syncOnce();
    const pollId = window.setInterval(syncOnce, 4000);

    return () => {
      window.clearInterval(pollId);
    };
  }, [
    mobileCaptureSession?.estado,
    mobileCaptureSession?.expired,
    mobileCaptureSession?.token,
    wizardStep,
  ]);
  const imeiValido = imeiDigits.length === 15;
  const stepClienteReady =
    Boolean(clientePrimerNombre.trim()) &&
    Boolean(clientePrimerApellido.trim()) &&
    Boolean(clienteTipoDocumento.trim()) &&
    Boolean(clienteDocumento.trim()) &&
    Boolean(clienteTelefono.trim()) &&
    Boolean(clienteCorreo.trim()) &&
    Boolean(clienteDepartamento.trim()) &&
    Boolean(clienteCiudad.trim()) &&
    Boolean(clienteGenero.trim()) &&
    Boolean(referenciaFamiliar1Nombre.trim()) &&
    Boolean(referenciaFamiliar1Parentesco.trim()) &&
    Boolean(referenciaFamiliar1Telefono.trim()) &&
    Boolean(referenciaFamiliar2Nombre.trim()) &&
    Boolean(referenciaFamiliar2Parentesco.trim()) &&
    Boolean(referenciaFamiliar2Telefono.trim()) &&
    Boolean(clienteDireccion.trim()) &&
    Boolean(clienteFechaNacimiento) &&
    Boolean(clienteFechaExpedicion);
  const otpReady = Boolean(otpVerifiedAt);
  const identityEvidenceReady =
    Boolean(contratoFotoDataUrl) &&
    Boolean(contratoCedulaFrenteDataUrl) &&
    Boolean(contratoCedulaRespaldoDataUrl);
  const veriffRequired =
    veriffConfig.configured && veriffConfig.mode === "required";
  const veriffApproved = veriffApprovalCanUnlockClient(veriffValidation);
  const veriffHasFinalDecision = Boolean(
    veriffValidation?.approved ||
      veriffValidation?.riskBlocked ||
      veriffValidation?.status === "DECLINED" ||
      veriffValidation?.status === "ERROR" ||
      veriffValidation?.status === "EXPIRED" ||
      veriffValidation?.status === "ABANDONED"
  );
  const veriffIdentityFlowEnabled =
    veriffConfig.configured && veriffConfig.mode !== "off";
  const hideIdentityWizardStep = veriffIdentityFlowEnabled;
  const clienteFormUnlocked = !veriffIdentityFlowEnabled || veriffApproved;
  const identityStepReady = identityEvidenceReady || veriffApproved;
  const contractEvidenceReady = identityStepReady;
  const stepContratoReady =
    identityStepReady && (!veriffRequired || veriffApproved);
  const stepEquipoReady =
    Boolean(equipoMarca.trim()) &&
    Boolean(equipoModelo.trim()) &&
    imeiValido &&
    cuotaInicialValida &&
    saldoFinanciado > 0 &&
    plazoMesesNumero > 0;
  const contratoListo = stepClienteReady && stepContratoReady && stepEquipoReady;
  const firmaSeguroProcessSent = Boolean(firmaSeguroDraftProcess?.processUuid);
  const firmaSeguroProcessSigned = Boolean(
    firmaSeguroDraftProcess?.completedAt ||
      firmaSeguroDraftProcess?.hasSignedDocument
  );
  const firmaSeguroDraftFolio = firmaSeguroDraftProcess?.draftFolio || "";
  const stepDocumentosReady =
    firmaSeguroProcessSigned ||
    (contratoAceptado &&
      pagareAceptado &&
      cartaAceptada &&
      autorizacionDatosAceptada);
  const entregaSinVerificacionAutorizada = Boolean(
    creditDocumentException?.permiteEntregaSinVerificacion
  );
  const entregaValidada = Boolean(
    deliveryValidation?.status?.ready || entregaSinVerificacionAutorizada
  );
  const deliveryStatusLabel = deliveryValidation?.status?.ready
    ? deliveryValidation.status.label
    : entregaSinVerificacionAutorizada
      ? "Entrega autorizada"
      : deliveryValidation?.status?.label || "Pendiente por validar";
  const deliveryStatusDetail = deliveryValidation?.status?.ready
    ? deliveryValidation.status.detail
    : entregaSinVerificacionAutorizada
      ? "Esta cedula tiene excepcion administrativa para entregar sin verificar dispositivo."
      : deliveryValidation?.status?.detail ||
        "Aun no se ha ejecutado la validacion final de entrega.";
  const deliveryRequirementReady = FLEXIBLE_WIZARD_FOR_TESTING || entregaValidada;
  const ventaLista =
    stepClienteReady &&
    stepEquipoReady &&
    stepContratoReady &&
    stepDocumentosReady &&
    deliveryRequirementReady;
  const paymentOverview = paymentSummary ||
    (selectedCredit
      ? {
          id: selectedCredit.id,
          folio: selectedCredit.folio,
          clienteNombre: selectedCredit.clienteNombre,
          clienteDocumento: selectedCredit.clienteDocumento,
          clienteTelefono: selectedCredit.clienteTelefono,
          montoCredito: selectedCredit.montoCredito,
          cuotaInicial: selectedCredit.cuotaInicial,
          fechaProximoPago: selectedCredit.fechaProximoPago,
          referenciaPago: selectedCredit.referenciaPago,
          estado: selectedCredit.estado,
          totalAbonado: selectedCredit.totalAbonado,
          saldoPendiente: selectedCredit.saldoPendiente,
          totalRecaudado: selectedCredit.totalRecaudado,
          porcentajeRecaudado: selectedCredit.porcentajeRecaudado,
          estadoPago: selectedCredit.estadoPago,
          nextInstallment: null,
          overdueCount: selectedCredit.cuotasEnMora || 0,
          paidCount: selectedCredit.cuotasPagadas || 0,
          pendingCount: selectedCredit.cuotasPendientes || 0,
          plan: [],
          liquidacionAnticipada: selectedCredit.liquidacionAnticipada,
          abonosCount: selectedCredit.abonosCount,
          ultimoAbonoAt: selectedCredit.ultimoAbonoAt,
        }
      : null);
  const earlyPayoffSummary =
    paymentOverview?.liquidacionAnticipada ||
    selectedCredit?.liquidacionAnticipada ||
    null;
  const earlyPayoffAvailable = Boolean(earlyPayoffSummary?.disponible);
  const isEarlyPayoffMode = paymentRegisterMode === "PAYOFF";
  const payableInstallments = (paymentOverview?.plan || []).filter(
    (item) => item.saldoPendiente > 0
  );
  const paymentBlockedByAnnulment = isCreditAnnulled(
    paymentOverview?.estado || selectedCredit?.estado
  );
  const selectedInstallmentSet = new Set(selectedInstallmentNumbers);
  const selectedInstallmentsData = payableInstallments.filter((item) =>
    selectedInstallmentSet.has(String(item.numero))
  );
  const selectedInstallmentTotal = selectedInstallmentNumbers.reduce((sum, numero) => {
    const installment = payableInstallments.find(
      (item) => String(item.numero) === String(numero)
    );

    return sum + Math.max(0, Number(installment?.saldoPendiente || 0));
  }, 0);
  const selectedInstallmentRoundedTotal = Math.round(selectedInstallmentTotal);
  const creditPendingRoundedTotal = Math.round(
    Number(paymentOverview?.saldoPendiente ?? selectedCredit?.saldoPendiente ?? 0)
  );
  const earlyPayoffRoundedTotal = Math.round(
    Number(earlyPayoffSummary?.capitalPendiente || 0)
  );
  const paymentTargetRoundedTotal = isEarlyPayoffMode
    ? earlyPayoffRoundedTotal
    : creditPendingRoundedTotal;
  const paymentAmountToApply = Number(String(paymentValue || "").replace(/\D/g, "") || 0);
  const receivedPaymentAmount = Number(
    String(receivedPaymentValue || "").replace(/\D/g, "") || 0
  );
  const selectedInstallmentCoverageShortfall =
    selectedInstallmentNumbers.length > 0
      ? Math.max(0, selectedInstallmentRoundedTotal - paymentAmountToApply)
      : 0;
  const paymentOverCreditAmount =
    paymentAmountToApply > 0
      ? Math.max(0, paymentAmountToApply - paymentTargetRoundedTotal)
      : 0;
  const paymentAdvanceAmount =
    selectedInstallmentNumbers.length > 0 && selectedInstallmentCoverageShortfall <= 0
      ? Math.max(
          0,
          Math.min(
            paymentAmountToApply,
            creditPendingRoundedTotal
          ) - selectedInstallmentRoundedTotal
        )
      : 0;
  const paymentChangeAmount =
    paymentAmountToApply > 0
      ? Math.max(0, receivedPaymentAmount - paymentAmountToApply)
      : 0;
  const paymentShortfallAmount =
    paymentAmountToApply > 0
      ? Math.max(0, paymentAmountToApply - receivedPaymentAmount)
      : 0;
  const paymentSubmitBlocked =
    paymentAmountToApply <= 0 ||
    (isEarlyPayoffMode && !earlyPayoffAvailable) ||
    paymentShortfallAmount > 0 ||
    selectedInstallmentCoverageShortfall > 0 ||
    paymentOverCreditAmount > 0;
  const selectedOverdueTotal = selectedInstallmentsData.reduce(
    (sum, item) =>
      sum + (item.estaEnMora ? Math.max(0, Number(item.saldoPendiente || 0)) : 0),
    0
  );
  const updateSelectedInstallments = (numero: number, checked: boolean) => {
    if (paymentRegisterMode !== "INSTALLMENTS") {
      setPaymentRegisterMode("INSTALLMENTS");
    }

    const orderedNumbers = payableInstallments.map((item) => item.numero);
    const nextNumbers = checked
      ? orderedNumbers.filter((item) => item <= numero)
      : orderedNumbers.filter(
          (item) => item < numero && selectedInstallmentSet.has(String(item))
        );

    setSelectedInstallmentNumbers(nextNumbers.map(String));
  };

  const selectEarlyPayoffPayment = () => {
    if (!earlyPayoffSummary?.disponible) {
      setNotice({
        text:
          earlyPayoffSummary?.motivo ||
          "La liquidacion anticipada solo aplica cuando el credito esta al dia.",
        tone: "red",
      });
      return;
    }

    const payoffValue = String(Math.round(earlyPayoffSummary.capitalPendiente || 0));
    setPaymentRegisterMode("PAYOFF");
    setSelectedInstallmentNumbers([]);
    setPaymentValue(payoffValue);
    setReceivedPaymentValue(payoffValue);
    setPaymentObservation("Liquidacion anticipada");
    setNotice(null);
  };

  useEffect(() => {
    if (paymentRegisterMode === "PAYOFF") {
      return;
    }

    if (!selectedInstallmentNumbers.length) {
      setPaymentValue("");
      setReceivedPaymentValue("");
      setPaymentObservation("");
      return;
    }

    const roundedSelectionTotal = String(Math.round(selectedInstallmentTotal));
    setPaymentValue(roundedSelectionTotal);
    setReceivedPaymentValue(roundedSelectionTotal);
    setPaymentObservation(
      selectedInstallmentNumbers.length === 1
        ? `Cuota ${selectedInstallmentNumbers[0]}`
        : `Cuotas ${selectedInstallmentNumbers.join(", ")}`
    );
  }, [paymentRegisterMode, selectedInstallmentNumbers, selectedInstallmentTotal]);

  const evidenceAuditTime = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString("es-CO") : "Pendiente";
  const documentDateLabel = documentRenderDate || "Pendiente";
  const documentDateTimeLabel = documentRenderDateTime || "Pendiente";
  const focusSelectedCreditPanel = () => {
    window.setTimeout(() => {
      const target = selectedCreditPanelRef.current;

      if (!target) {
        return;
      }

      const top = target.getBoundingClientRect().top + window.scrollY - 110;
      window.scrollTo({
        top: Math.max(0, top),
        behavior: "smooth",
      });
    }, 80);
  };
  const focusLookupDetailPanel = () => {
    window.setTimeout(() => {
      const target = lookupDetailPanelRef.current;

      if (!target) {
        return;
      }

      const top = target.getBoundingClientRect().top + window.scrollY - 110;
      window.scrollTo({
        top: Math.max(0, top),
        behavior: "smooth",
      });
    }, 120);
  };
  const heroEyebrow = paymentsView
    ? "Abonos y recaudo"
    : deliveryMode
      ? "Validacion de entrega"
    : simulatorMode
      ? "Simulador"
    : lookupMode
      ? "Clientes y expedientes"
      : "Fabrica de creditos";
  const heroTitle = paymentsView
    ? "Recibe cuotas y consulta cartera"
    : deliveryMode
      ? "Consulta si el equipo esta entregable"
    : simulatorMode
      ? "Simula equipo, inicial y cuotas"
    : lookupMode
      ? "Buscar cliente"
    : createClientMode
      ? "Nueva venta"
      : "Genera, inscribe y valida entrega";
  const heroDescription = paymentsView
    ? "Esta vista queda enfocada en buscar clientes, revisar saldo pendiente, registrar abonos y consultar historial de pagos sin mezclar la creacion del credito."
    : deliveryMode
      ? "Escribe numero de cedula o IMEI, consulta el credito y revisa si ya esta listo para entregar."
    : simulatorMode
      ? "Selecciona marca, modelo, precio e inicial para revisar cuotas antes de iniciar la venta."
    : lookupMode
      ? "Consulta por cedula, telefono, folio, IMEI o nombre y abre el expediente del credito seleccionado."
    : createClientMode
      ? `${initialSeller?.nombre || "Asesor"} | ${initialSession.sedeNombre}`
      : "Genera el credito, inscribe el equipo y confirma si el dispositivo se puede entregar.";
  const searchDescription = paymentsView
    ? "Busca por cedula, telefono, nombre, folio, IMEI o deviceUid para ubicar el caso y recibir el pago de las cuotas desde esta vista separada."
    : deliveryMode
      ? "Escribe la cedula del cliente o el IMEI del equipo. Al consultar se mostrara si el credito ya esta en estado entregable."
    : lookupMode
      ? "Cedula, telefono, nombre, folio o IMEI."
      : "Busca por cedula, telefono, nombre, folio, IMEI o deviceUid para ubicar creditos existentes y revisar su estado sin salir de la fabrica.";
  const factorySteps = [
    {
      id: 1,
      label: veriffIdentityFlowEnabled ? "Identidad" : "Cliente",
      detail: veriffIdentityFlowEnabled ? "Cliente" : "Datos",
      ready: stepClienteReady,
      action: veriffIdentityFlowEnabled ? "Validacion y datos" : "Datos personales",
    },
    {
      id: 2,
      label: "Equipo",
      detail: "Plan",
      ready: stepEquipoReady,
      action: "Equipo y cuotas",
    },
    {
      id: 3,
      label: "Identidad",
      detail: "Evidencias",
      ready: stepContratoReady,
      action: "QR y evidencias",
    },
    {
      id: 4,
      label: "Contratos",
      detail: "Firma",
      ready: stepDocumentosReady,
      action: "Firma y documentos",
    },
    {
      id: 5,
      label: "Entrega",
      detail: entregaSinVerificacionAutorizada ? "Excepcion" : "Zero Touch",
      ready: entregaValidada,
      action: entregaSinVerificacionAutorizada
        ? "Entrega autorizada"
        : "Validar entrega",
    },
  ];
  const visibleFactorySteps = hideIdentityWizardStep
    ? factorySteps.filter((step) => step.id !== 3)
    : factorySteps;
  const completedFactorySteps = visibleFactorySteps.filter((step) => step.ready).length;
  const factoryProgress = Math.round((completedFactorySteps / visibleFactorySteps.length) * 100);
  const activeFactoryStep =
    visibleFactorySteps.find((step) => step.id === wizardStep) ||
    (hideIdentityWizardStep && wizardStep === 3
      ? visibleFactorySteps.find((step) => step.id === 4)
      : null) ||
    visibleFactorySteps[0];
  const activeFactoryStepNumber =
    Math.max(
      0,
      visibleFactorySteps.findIndex((step) => step.id === activeFactoryStep.id)
    ) + 1;
  const nextFactoryStep =
    visibleFactorySteps.find((step) => !step.ready) ||
    visibleFactorySteps[visibleFactorySteps.length - 1];
  const factoryStepRequirements: Record<
    number,
    Array<{ label: string; ready: boolean }>
  > = {
    1: [
      { label: "Nombre", ready: Boolean(clientePrimerNombre.trim()) },
      { label: "Apellido", ready: Boolean(clientePrimerApellido.trim()) },
      { label: "Documento", ready: Boolean(clienteDocumento.trim()) },
      { label: "Celular", ready: Boolean(clienteTelefono.trim()) },
      { label: "Correo", ready: Boolean(clienteCorreo.trim()) },
      { label: "Ubicacion", ready: Boolean(clienteDepartamento.trim() && clienteCiudad.trim()) },
      { label: "Direccion", ready: Boolean(clienteDireccion.trim()) },
      {
        label: "Referencias",
        ready: Boolean(
          referenciaFamiliar1Nombre.trim() &&
            referenciaFamiliar1Parentesco.trim() &&
            referenciaFamiliar1Telefono.trim() &&
            referenciaFamiliar2Nombre.trim() &&
            referenciaFamiliar2Parentesco.trim() &&
            referenciaFamiliar2Telefono.trim()
        ),
      },
    ],
    2: [
      { label: "Marca", ready: Boolean(equipoMarca.trim()) },
      { label: "Modelo", ready: Boolean(equipoModelo.trim()) },
      { label: "IMEI", ready: imeiValido },
      { label: "Precio", ready: Number(valorEquipoTotal || 0) > 0 },
      { label: "Plazo", ready: plazoMesesNumero > 0 },
      { label: "Saldo", ready: saldoFinanciado > 0 },
    ],
    3: [
      { label: "Selfie", ready: Boolean(contratoFotoDataUrl) },
      { label: "Cedula frente", ready: Boolean(contratoCedulaFrenteDataUrl) },
      { label: "Cedula respaldo", ready: Boolean(contratoCedulaRespaldoDataUrl) },
    ],
    4: [
      { label: "Contrato", ready: contratoAceptado },
      { label: "Pagare", ready: pagareAceptado },
      { label: "Carta", ready: cartaAceptada },
      { label: "Datos", ready: autorizacionDatosAceptada },
    ],
    5: [
      { label: "Cliente", ready: stepClienteReady },
      { label: "Equipo", ready: stepEquipoReady },
      ...(!hideIdentityWizardStep
        ? [{ label: "Identidad", ready: stepContratoReady }]
        : []),
      { label: "Contratos", ready: stepDocumentosReady },
      { label: "Entrega", ready: entregaValidada },
    ],
  };
  const activeRequirements = factoryStepRequirements[wizardStep] || [];
  const activeCompletedCount = activeRequirements.filter((item) => item.ready).length;
  const activeCompletionPercent = activeRequirements.length
    ? Math.round((activeCompletedCount / activeRequirements.length) * 100)
    : 0;
  const activeMissingRequirements = activeRequirements.filter((item) => !item.ready);
  const showResultsPanel = paymentsView
    ? !selectedCredit || showPaymentResults
    : clientLookupMode
      ? false
    : lookupMode
      ? true
      : adminFactoryAssistMode
        ? Boolean(activeSearch) || loadingList
        : false;
  const showCompactSearchSection = paymentsView ? showResultsPanel : showSearchSection;
  const legalDocumentationStepContent = (
    <>
      <div className="rounded-[24px] border border-[#dbe4ea] bg-[#f8fbfd] px-5 py-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Paquete contractual
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          Estos documentos hacen parte del cierre contractual del credito:
          pagaré y carta de instrucciones.
        </p>
      </div>
      {pagarePreviewNode}
      {cartaInstructionsPreviewNode}

      <div className="rounded-[24px] border border-[#eadfcb] bg-[#fffaf2] px-5 py-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a5a21]">
          Autorizacion independiente
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          La autorizacion de tratamiento de datos personales queda separada del
          contrato, del pagare y de la carta de instrucciones.
        </p>
      </div>
      {dataAuthorizationPreviewNode}
      {false && (
      <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
          Pagare digital
        </p>
        <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
          <p className="font-black text-slate-950">PAGARE No. {pagarePreviewNumber}</p>
          <p className="mt-2">
            Yo, <span className="font-semibold">{clienteNombre || "{{nombre}}"}</span>,
            mayor de edad, identificado con cedula de ciudadania No.{" "}
            <span className="font-semibold">{clienteDocumento || "{{cedula}}"}</span>,
            actuando en nombre propio, me obligo de manera incondicional a pagar a
            la orden de:
          </p>
          <div className="mt-4">
            <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
            <p>NIT: 902052909-4</p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">
              $ {currency(saldoFinanciado).replace("$ ", "")} (PESOS COLOMBIANOS)
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">PRIMERA – FORMA DE PAGO</p>
            <p className="mt-2">
              La obligacion sera pagada en {plazoMesesNumero || "{{cuotas}}"} cuotas
              de {currency(valorCuota)} cada una, con frecuencia {frecuenciaPagoLabel.toLowerCase()},
              conforme al plan pactado.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">SEGUNDA – VENCIMIENTO ANTICIPADO</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Exigibilidad inmediata del total de la deuda.</li>
              <li>Cobro de intereses moratorios.</li>
            </ul>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">TERCERA – INTERESES</p>
            <p className="mt-2">
              Se causaran intereses de mora a la tasa maxima legal vigente.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">CUARTA – GASTOS DE COBRANZA</p>
            <p className="mt-2">
              El deudor asumira todos los gastos derivados de cobro, incluyendo
              honorarios juridicos.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">QUINTA – AUTORIZACION</p>
            <p className="mt-2">El deudor autoriza el reporte a centrales de riesgo.</p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">SEXTA – ESPACIOS EN BLANCO</p>
            <p className="mt-2">
              El deudor autoriza expresa e irrevocablemente a FINSER PAY S.A.S.
              para llenar los espacios en blanco del presente pagare conforme a
              las condiciones del credito otorgado.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">SEPTIMA – MERITO EJECUTIVO</p>
            <p className="mt-2">El presente pagare presta merito ejecutivo.</p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">LUGAR Y FECHA</p>
          <p className="mt-2">Ibague, {documentDateTimeLabel}</p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">FIRMA DEL DEUDOR</p>
            <p className="mt-2">
              Firma: {contratoFirmaDataUrl ? "Registrada" : "_________________________"}
            </p>
            <p>Nombre: {clienteNombre || "{{nombre}}"}</p>
            <p>Cedula: {clienteDocumento || "{{cedula}}"}</p>
          </div>
        </div>
      </div>
      )}

      {false && (
      <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
          Carta de instrucciones
        </p>
        <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
          <p className="font-black text-slate-950">
            CARTA DE INSTRUCCIONES PARA DILIGENCIAMIENTO DE PAGARE EN BLANCO
          </p>
          <div className="mt-4">
            <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
            <p>NIT: 902052909-4</p>
            <p>Domicilio: Ibague - Tolima</p>
          </div>
          <p className="mt-4">
            Yo, <span className="font-semibold">{clienteNombre || "{{nombre}}"}</span>,
            identificado con cedula de ciudadania No.{" "}
            <span className="font-semibold">{clienteDocumento || "{{cedula}}"}</span>,
            actuando en nombre propio, por medio del presente documento autorizo
            expresa, previa e irrevocablemente a{" "}
            <span className="font-semibold">FINSER PAY S.A.S.</span>, para que
            diligencie el pagare firmado por mi.
          </p>
          <div className="mt-5">
            <p className="font-black text-slate-950">PRIMERA - OBJETO</p>
            <p className="mt-2">
              El pagare respalda todas las obligaciones derivadas del contrato de
              financiacion de equipo movil suscrito con FINSER PAY S.A.S.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">SEGUNDA - DILIGENCIAMIENTO</p>
            <p className="mt-2">
              Autorizo a FINSER PAY S.A.S. para llenar los espacios en blanco del
              pagare, incluyendo valor total, fechas, cuotas, intereses y numero
              del pagare.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">TERCERA - VALOR</p>
            <p className="mt-2">
              El valor a diligenciar correspondera al total de la obligacion
              adquirida, incluyendo capital, intereses corrientes, intereses de mora
              y gastos de cobranza.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">CUARTA - VENCIMIENTO</p>
            <p className="mt-2">
              El pagare podra ser llenado con vencimiento inmediato en caso de mora
              o incumplimiento de cualquiera de las condiciones del contrato.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">QUINTA - EXIGIBILIDAD</p>
            <p className="mt-2">
              Autorizo expresamente que, en caso de incumplimiento, el pagare sea
              exigible de manera inmediata en su totalidad.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">SEXTA - CESION</p>
            <p className="mt-2">
              FINSER PAY S.A.S. podra ceder el pagare a terceros sin necesidad de
              autorizacion adicional del deudor.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">SEPTIMA - COBRO</p>
            <p className="mt-2">
              Autorizo el inicio de procesos de cobro prejuridico y juridico,
              asumiendo todos los costos derivados.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">OCTAVA - ACEPTACION</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>He firmado el pagare de manera libre y voluntaria.</li>
              <li>Conozco y acepto el contenido de esta carta de instrucciones.</li>
              <li>Entiendo las consecuencias legales del incumplimiento.</li>
            </ul>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">NOVENA - VALIDEZ DIGITAL</p>
            <p className="mt-2">
              El presente documento se firma mediante mecanismos electronicos, con
              plena validez juridica conforme a la legislacion colombiana.
            </p>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">DECIMA - PRUEBA</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Firma digital</li>
              <li>Registro fotografico</li>
              <li>Datos tecnicos (fecha, hora, IP, dispositivo)</li>
            </ul>
          </div>
          <div className="mt-5">
            <p className="font-black text-slate-950">FIRMA DEL DEUDOR</p>
            <p className="mt-2">
              Firma: {contratoFirmaDataUrl ? "Registrada" : "{{firma_digital}}"}
            </p>
            <p>Nombre: {clienteNombre || "{{nombre}}"}</p>
            <p>Cedula: {clienteDocumento || "{{cedula}}"}</p>
          <p>Fecha: {documentDateTimeLabel}</p>
          </div>
        </div>
      </div>
      )}

      <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Checklist legal
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Cliente", ready: stepClienteReady },
            { label: "Equipo", ready: stepEquipoReady },
            { label: "Contrato", ready: stepContratoReady },
            { label: "Pagare", ready: pagareAceptado },
          ].map(({ label, ready }) => (
            <div
              key={label}
              className={[
                "rounded-2xl border px-4 py-4 text-sm font-semibold",
                ready
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-700",
              ].join(" ")}
            >
              {label}: {ready ? "OK" : "Pendiente"}
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-start gap-3 rounded-[20px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-3">
          <input
            id="pagare-aceptado-wizard"
            type="checkbox"
            checked={pagareAceptado}
            onChange={(event) => setPagareAceptado(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-300"
          />
          <label
            htmlFor="pagare-aceptado-wizard"
            className="text-sm leading-6 text-slate-700"
          >
            Confirmo que el cliente acepto el pagare digital y la carta de instrucciones.
          </label>
        </div>
      </div>
    </>
  );

  const loadEquipmentCatalog = async () => {
    try {
      const params = canAdmin ? "?includeInactive=true" : "";
      const result = await requestJson<EquipmentCatalogResponse>(
        `/api/creditos/catalogo-equipos${params}`
      );

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo cargar el catalogo de equipos");
      }

      setEquipmentCatalog(result.data.items || []);
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo cargar el catalogo de equipos",
        tone: "red",
      });
    }
  };

  const applyCreditSettings = (
    nextSettingsInput: CreditSettings,
    nextException: CreditDocumentException | null,
    documentValue: string
  ) => {
    const nextMaxInstallments = normalizeCreditInstallmentLimit(
      nextSettingsInput.plazoMaximoCuotas
    );
    const nextSettings = {
      ...nextSettingsInput,
      plazoMaximoCuotas: nextMaxInstallments,
      plazoCuotas: normalizeCreditInstallments(
        nextSettingsInput.plazoCuotas,
        DEFAULT_CREDIT_INSTALLMENTS,
        nextMaxInstallments
      ),
    };

    setCreditSettings(nextSettings);
    setCreditDocumentException(nextException);
    setCreditSettingsDocument(documentValue);
    setTasaInteresEa(String(nextSettings.tasaInteresEa));
    setFianzaPorcentaje(String(nextSettings.fianzaPorcentaje));
    setPlazoMeses(String(nextSettings.plazoCuotas));
    setFechaPrimerPago(
      getDefaultFirstPaymentDate(new Date(), nextSettings.frecuenciaPago)
    );
  };

  const loadCreditSettings = async (documentValue = "") => {
    try {
      const normalizedDocument = documentValue.replace(/\D/g, "");
      const endpoint = normalizedDocument
        ? `/api/creditos/configuracion?documento=${encodeURIComponent(normalizedDocument)}`
        : "/api/creditos/configuracion";
      const result = await requestJson<CreditSettingsResponse>(
        endpoint
      );

      if (!result.ok || !result.data.settings) {
        throw new Error(
          result.data?.error || "No se pudo cargar la configuracion del credito"
        );
      }

      applyCreditSettings(
        result.data.settings,
        result.data.documentException || null,
        normalizedDocument
      );
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo cargar la configuracion del credito",
        tone: "red",
      });
    }
  };

  const applyEquipmentCatalogItem = (item: EquipmentCatalogItem) => {
    const previousCatalogBase = selectedEquipmentCatalogItem?.precioBaseVenta || 0;
    const currentEquipmentValue = Number(valorEquipoTotal || 0);

    setEquipoMarca(item.marca);
    setEquipoModelo(item.modelo);

    if (
      previousCatalogBase > 0 &&
      currentEquipmentValue === Math.round(previousCatalogBase)
    ) {
      setValorEquipoTotal("");
    }
  };

  const handleCuotaInicialBlur = () => {
    if (!valorTotalEquipoNumero) {
      setCuotaInicial("");
      return;
    }

    const normalizedInitial = Math.max(
      cuotaInicialMinimaNumero,
      Math.min(cuotaInicialNumero, valorTotalEquipoNumero)
    );

    setCuotaInicial(String(Math.round(normalizedInitial)));
  };

  const loadCredits = async (preserveSelected = true, searchValue = activeSearch) => {
    try {
      setLoadingList(true);
      const trimmedSearch = searchValue.trim();

      if (!canSearchCreditsInCurrentView) {
        setActiveSearch("");
        setCredits([]);
        setSelectedId(null);
        setShowLookupDetail(false);
        return;
      }

      if ((lookupMode || adminFactoryAssistMode) && !trimmedSearch) {
        setActiveSearch("");
        setCredits([]);
        setSelectedId(null);
        setShowSearchResults(true);
        setShowLookupDetail(false);
        return;
      }

      if (paymentsView && !trimmedSearch && !selectedId) {
        setActiveSearch("");
        setCredits([]);
        setShowPaymentResults(true);
        return;
      }

      const params = new URLSearchParams({
        take: paymentsView ? "50" : "24",
      });

      if (paymentsView) {
        params.set("mode", "payments");
      }

      if (trimmedSearch) {
        params.set("search", trimmedSearch);
      } else if (paymentsView && selectedId) {
        params.set("id", String(selectedId));
      }

      const result = await requestJson<CreditListResponse>(`/api/creditos?${params.toString()}`);

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudieron cargar los creditos");
      }

      setActiveSearch(trimmedSearch);
      setCredits(result.data.items);
      let nextSelectedId: number | null = null;

      if (
        preserveSelected &&
        selectedId &&
        result.data.items.some((item) => item.id === selectedId)
      ) {
        nextSelectedId = selectedId;
      } else if (paymentsView) {
        nextSelectedId =
          trimmedSearch && result.data.items.length === 1
            ? result.data.items[0]?.id || null
            : null;
      } else if (createClientMode || adminFactoryAssistMode) {
        nextSelectedId = null;
      } else if (lookupMode) {
        nextSelectedId =
          trimmedSearch && result.data.items.length === 1
            ? result.data.items[0]?.id || null
            : null;
      } else {
        nextSelectedId = result.data.items[0]?.id || null;
      }

      setSelectedId(nextSelectedId);

      if (paymentsView) {
        setShowPaymentResults(nextSelectedId === null);
      }

      if (lookupMode) {
        setShowSearchResults(nextSelectedId === null);
        setShowLookupDetail(clientLookupMode ? false : nextSelectedId !== null);
        if (nextSelectedId !== null) {
          focusSelectedCreditPanel();
        }
      }
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudieron cargar los creditos",
        tone: "red",
      });
    } finally {
      setLoadingList(false);
    }
  };

  const loadDrafts = async (searchValue = activeSearch) => {
    if (!adminFactoryAssistMode) {
      setDraftSearchResults([]);
      return;
    }

    const trimmedSearch = searchValue.trim();

    if (!trimmedSearch) {
      setDraftSearchResults([]);
      return;
    }

    try {
      setLoadingDrafts(true);
      const params = new URLSearchParams({
        take: "12",
        search: trimmedSearch,
      });
      const result = await requestJson<CreditDraftListResponse>(
        `/api/creditos/borradores?${params.toString()}`
      );

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudieron cargar los borradores");
      }

      setDraftSearchResults(result.data.items || []);
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudieron cargar los borradores",
        tone: "red",
      });
    } finally {
      setLoadingDrafts(false);
    }
  };

  useEffect(() => {
    void loadEquipmentCatalog();
    void loadCreditSettings();
    void requestJson<VeriffResponse>("/api/creditos/veriff").then((result) => {
      if (result.ok && result.data?.veriff) {
        setVeriffConfig(result.data.veriff);
      }
    });
  }, []);

  useEffect(() => {
    const normalizedDocument = clienteDocumento.replace(/\D/g, "");
    const targetDocument = normalizedDocument.length >= 5 ? normalizedDocument : "";

    if (targetDocument === creditSettingsDocument) {
      return;
    }

    const timer = window.setTimeout(() => {
      void loadCreditSettings(targetDocument);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [clienteDocumento, creditSettingsDocument]);

  useEffect(() => {
    if (simulatorMode) {
      setWizardStep(2);
    }
  }, [simulatorMode]);

  useEffect(() => {
    if (hideIdentityWizardStep && wizardStep === 3) {
      setWizardStep(4);
    }
  }, [hideIdentityWizardStep, wizardStep]);

  useEffect(() => {
    if (!canSearchCreditsInCurrentView) {
      setLoadingList(false);
      return;
    }

    void loadCredits(Boolean(initialSelectedId), normalizedInitialSearch);

    if (adminFactoryAssistMode) {
      void loadDrafts(normalizedInitialSearch);
    }
  }, [
    adminFactoryAssistMode,
    canSearchCreditsInCurrentView,
    initialSelectedId,
    normalizedInitialSearch,
  ]);

  useEffect(() => {
    if (!selectedCredit) {
      setPayments([]);
      setPaymentSummary(null);
      return;
    }

    setNextDueDate(dateOnly(selectedCredit.fechaProximoPago));
    setPlanInstallments(String(selectedCredit.plazoMeses || DEFAULT_CREDIT_INSTALLMENTS));
    setPlanFrequency(selectedCredit.frecuenciaPago || DEFAULT_PAYMENT_FREQUENCY);
    setPlanFirstPaymentDate(
      dateOnly(selectedCredit.fechaPrimerPago || selectedCredit.fechaProximoPago)
    );
    setObservacionAdmin(selectedCredit.observacionAdmin || "");
  }, [selectedCredit?.id]);

  useEffect(() => {
    const nextFullName = [clientePrimerNombre.trim(), clientePrimerApellido.trim()]
      .filter(Boolean)
      .join(" ");

    setClienteNombre(nextFullName);
  }, [clientePrimerNombre, clientePrimerApellido]);

  useEffect(() => {
    if (clienteCiudad && !cityOptions.includes(clienteCiudad)) {
      setClienteCiudad("");
    }
  }, [cityOptions, clienteCiudad]);

  useEffect(() => {
    const normalizedValue = String(valorEquipoTotal || "").replace(/\D/g, "");

    if (!normalizedValue) {
      setCuotaInicial("");
      return;
    }

    const totalValue = Number(normalizedValue);

    if (!Number.isFinite(totalValue) || totalValue <= 0) {
      setCuotaInicial("");
      return;
    }

    setCuotaInicial(String(cuotaInicialMinimaNumero));
  }, [
    cuotaInicialMinimaNumero,
    valorEquipoTotal,
  ]);

  useEffect(() => {
    if (!paymentsView) {
      return;
    }

    if (!selectedCredit) {
      setShowPaymentResults(true);
      setPaymentsTab("pay");
      setPaymentRegisterMode("INSTALLMENTS");
      return;
    }

    setShowPaymentResults(false);
    setPaymentsTab("pay");
    setPaymentRegisterMode("INSTALLMENTS");
  }, [paymentsView, selectedCredit?.id]);

  useEffect(() => {
    if (!lookupMode) {
      return;
    }

    if (!selectedCredit) {
      setShowSearchResults(true);
    }
  }, [lookupMode, selectedCredit?.id]);

  useEffect(() => {
    setDeliveryValidation(null);
  }, [imei, equipoMarca, equipoModelo, valorEquipoTotal, plazoMeses, fechaPrimerPago]);

  const loadPayments = async (creditId: number) => {
    try {
      setLoadingPayments(true);
      const result = await requestJson<CreditPaymentsResponse>(
        `/api/creditos/${creditId}/abonos`
      );

      if (!result.ok) {
        throw new Error(
          result.data?.error || "No se pudieron cargar los abonos del credito"
        );
      }

      setPayments(result.data.items);
      setPaymentSummary(result.data.credito);
      setPaymentRegisterMode("INSTALLMENTS");
      if (isCreditAnnulled(result.data.credito.estado)) {
        setSelectedInstallmentNumbers([]);
        setPaymentValue("");
        setReceivedPaymentValue("");
        return;
      }

      const nextInstallment = result.data.credito.nextInstallment;
      if (nextInstallment?.saldoPendiente && nextInstallment.saldoPendiente > 0) {
        const nextInstallmentValue = String(Math.round(nextInstallment.saldoPendiente));
        setSelectedInstallmentNumbers([String(nextInstallment.numero)]);
        setPaymentValue(nextInstallmentValue);
        setReceivedPaymentValue(nextInstallmentValue);
      } else {
        setSelectedInstallmentNumbers([]);
        setPaymentValue("");
        setReceivedPaymentValue("");
      }
    } catch (error) {
      setPayments([]);
      setPaymentSummary(null);
      setPaymentRegisterMode("INSTALLMENTS");
      setSelectedInstallmentNumbers([]);
      setPaymentValue("");
      setReceivedPaymentValue("");
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudieron cargar los abonos del credito",
        tone: "red",
      });
    } finally {
      setLoadingPayments(false);
    }
  };

  useEffect(() => {
    if (!selectedCredit?.id) {
      return;
    }

    void loadPayments(selectedCredit.id);
  }, [selectedCredit?.id]);

  const processEvidenceDataUrl = async (
    originalDataUrl: string,
    onSuccess: (value: string) => void,
    successMessage: string,
    onAudit?: (value: EvidenceAudit | null) => void,
    source: EvidenceAudit["source"] = "upload",
    mode: EvidenceProcessingMode = "default"
  ) => {
    try {
      const compressedDataUrl =
        mode === "document"
          ? await compressImageDataUrl(originalDataUrl, 2200, 0.94)
          : await compressImageDataUrl(originalDataUrl, 960, 0.78);
      onSuccess(compressedDataUrl);
      onAudit?.({
        capturedAt: new Date().toISOString(),
        source,
      });
      setNotice({
        text: successMessage,
        tone: "emerald",
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo procesar la foto",
        tone: "red",
      });
    }
  };

  const captureContractPhoto = async (
    event: ChangeEvent<HTMLInputElement>,
    onSuccess: (value: string) => void = setContratoFotoDataUrl,
    successMessage = "Foto del cliente cargada para el contrato.",
    onAudit?: (value: EvidenceAudit | null) => void,
    mode: EvidenceProcessingMode = "default"
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const originalDataUrl = await readFileAsDataUrl(file);
      await processEvidenceDataUrl(
        originalDataUrl,
        onSuccess,
        successMessage,
        onAudit,
        "upload",
        mode
      );
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo leer la imagen",
        tone: "red",
      });
    }
  };

  const captureApprovalVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      let durationSeconds: number | undefined;

      try {
        const measuredDuration = await readVideoDuration(file);
        if (Number.isFinite(measuredDuration) && measuredDuration > 0) {
          durationSeconds = Math.max(1, Math.round(measuredDuration));
        }
      } catch {
        durationSeconds = undefined;
      }

      const dataUrl = ensureVideoDataUrl(await readFileAsDataUrl(file), file);
      setContratoVideoAprobacionDataUrl(dataUrl);
      setContratoVideoAprobacionAudit({
        capturedAt: new Date().toISOString(),
        source: "upload",
        durationSeconds,
      });
      setNotice({
        text: "Video de aprobacion cargado correctamente.",
        tone: "emerald",
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo cargar el video.",
        tone: "red",
      });
    }
  };

  const handleCameraCapture = async (value: string, slot: CaptureSlot) => {
    if (slot === "video-aprobacion") {
      try {
        setContratoVideoAprobacionDataUrl(ensureVideoDataUrl(value));
        setContratoVideoAprobacionAudit({
          capturedAt: new Date().toISOString(),
          source: "camera",
          durationSeconds: undefined,
        });
        setNotice({
          text: "Video de aprobacion capturado correctamente.",
          tone: "emerald",
        });
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : "No se pudo procesar el video.",
          tone: "red",
        });
      }
      return;
    }

    if (slot === "selfie") {
      await processEvidenceDataUrl(
        value,
        setContratoFotoDataUrl,
        "Selfie del cliente anexada al contrato.",
        setContratoFotoAudit,
        "camera"
      );
      return;
    }

    if (slot === "cedula-frente") {
      await processEvidenceDataUrl(
        value,
        setContratoCedulaFrenteDataUrl,
        "Frente de la cédula capturado correctamente."
      );
      return;
    }

    await processEvidenceDataUrl(
      value,
      setContratoCedulaRespaldoDataUrl,
      "Respaldo de la cédula capturado correctamente."
    );
  };

  const handleCameraCaptureWithAudit = async (
    value: string,
    slot: CaptureSlot,
    audit?: Partial<EvidenceAudit>
  ) => {
    if (slot === "video-aprobacion") {
      try {
        setContratoVideoAprobacionDataUrl(ensureVideoDataUrl(value));
        setContratoVideoAprobacionAudit({
          capturedAt: audit?.capturedAt || new Date().toISOString(),
          source: audit?.source === "upload" ? "upload" : "camera",
          durationSeconds:
            audit?.durationSeconds && audit.durationSeconds > 0
              ? audit.durationSeconds
              : undefined,
        });
        setNotice({
          text: "Video de aprobacion capturado correctamente.",
          tone: "emerald",
        });
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : "No se pudo procesar el video.",
          tone: "red",
        });
      }
      return;
    }

    if (slot === "selfie") {
      await processEvidenceDataUrl(
        value,
        setContratoFotoDataUrl,
        "Selfie del cliente anexada al contrato.",
        setContratoFotoAudit,
        "camera"
      );
      return;
    }

    if (slot === "cedula-frente") {
      await processEvidenceDataUrl(
        value,
        setContratoCedulaFrenteDataUrl,
        "Frente de la cedula capturado correctamente.",
        setContratoCedulaFrenteAudit,
        "camera",
        "document"
      );
      return;
    }

    await processEvidenceDataUrl(
      value,
      setContratoCedulaRespaldoDataUrl,
      "Respaldo de la cedula capturado correctamente.",
      setContratoCedulaRespaldoAudit,
      "camera",
      "document"
    );
  };

  const applyMobileCaptureEvidence = (
    session: MobileCaptureSession,
    showSuccessNotice = false
  ) => {
    const updateMarker = session.updatedAt || `${Date.now()}`;

    if (mobileCaptureAppliedRef.current === updateMarker) {
      return;
    }

    let importedCount = 0;

    if (session.evidence.selfieDataUrl) {
      setContratoFotoDataUrl(session.evidence.selfieDataUrl);
      setContratoFotoAudit({
        capturedAt:
          session.evidence.selfieCapturedAt || new Date().toISOString(),
        source: session.evidence.selfieSource === "upload" ? "upload" : "camera",
      });
      importedCount += 1;
    }

    if (session.evidence.cedulaFrenteDataUrl) {
      setContratoCedulaFrenteDataUrl(session.evidence.cedulaFrenteDataUrl);
      setContratoCedulaFrenteAudit({
        capturedAt:
          session.evidence.cedulaFrenteCapturedAt || new Date().toISOString(),
        source:
          session.evidence.cedulaFrenteSource === "upload" ? "upload" : "camera",
      });
      importedCount += 1;
    }

    if (session.evidence.cedulaRespaldoDataUrl) {
      setContratoCedulaRespaldoDataUrl(session.evidence.cedulaRespaldoDataUrl);
      setContratoCedulaRespaldoAudit({
        capturedAt:
          session.evidence.cedulaRespaldoCapturedAt || new Date().toISOString(),
        source:
          session.evidence.cedulaRespaldoSource === "upload" ? "upload" : "camera",
      });
      importedCount += 1;
    }

    if (session.evidence.videoAprobacionDataUrl) {
      setContratoVideoAprobacionDataUrl(session.evidence.videoAprobacionDataUrl);
      setContratoVideoAprobacionAudit({
        capturedAt:
          session.evidence.videoAprobacionCapturedAt || new Date().toISOString(),
        source:
          session.evidence.videoAprobacionSource === "upload" ? "upload" : "camera",
        durationSeconds:
          session.evidence.videoAprobacionDuration &&
          session.evidence.videoAprobacionDuration > 0
            ? session.evidence.videoAprobacionDuration
            : undefined,
      });
      importedCount += 1;
    }

    mobileCaptureAppliedRef.current = updateMarker;

    if (showSuccessNotice && importedCount > 0) {
      setNotice({
        text: `Se cargaron ${importedCount} evidencias desde el celular.`,
        tone: "emerald",
      });
    }
  };

  const syncMobileCaptureSession = async (
    token: string,
    showSuccessNotice = false
  ) => {
    const result = await requestJson<MobileCaptureSessionResponse>(
      `/api/creditos/captura-session/${token}`
    );

    if (!result.ok || !result.data?.session) {
      throw new Error(
        result.data?.error || "No se pudo sincronizar la captura del celular."
      );
    }

    setMobileCaptureSession(result.data.session);
    applyMobileCaptureEvidence(result.data.session, showSuccessNotice);
    return result.data.session;
  };

  const createMobileCaptureSession = async () => {
    try {
      setCreatingMobileCapture(true);
      const result = await requestJson<MobileCaptureSessionResponse>(
        "/api/creditos/captura-session",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            clienteNombre,
            clienteDocumento,
            clienteTelefono,
          }),
        }
      );

      if (!result.ok || !result.data?.session) {
        throw new Error(result.data?.error || "No se pudo generar el QR.");
      }

      mobileCaptureAppliedRef.current = "";
      setMobileCaptureSession(result.data.session);
      setNotice({
        text:
          "QR listo. Abre el enlace desde el celular para tomar selfie y cédula.",
        tone: "emerald",
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo generar el QR.",
        tone: "red",
      });
    } finally {
      setCreatingMobileCapture(false);
    }
  };

  const validateCedulaAgainstForm = async () => {
    if (!contratoCedulaFrenteDataUrl || !contratoCedulaRespaldoDataUrl) {
      setNotice({
        text: "Debes cargar la cedula por ambos lados antes de validarla.",
        tone: "amber",
      });
      return false;
    }

    if (
      !clienteDocumento.trim() ||
      !clientePrimerNombre.trim() ||
      !clientePrimerApellido.trim() ||
      !clienteFechaNacimiento ||
      !clienteFechaExpedicion
    ) {
      setNotice({
        text: "Completa documento, nombre, apellido y fechas antes de validar la cedula.",
        tone: "amber",
      });
      return false;
    }

    setCedulaValidation({
      status: "processing",
      summary: "Leyendo la cedula y comparando la informacion del formulario...",
      checkedAt: null,
      checks: [],
    });

    try {
      const result: CedulaValidationResult = await runCedulaValidation({
        frontImage: contratoCedulaFrenteDataUrl,
        backImage: contratoCedulaRespaldoDataUrl,
        firstName: clientePrimerNombre,
        lastName: clientePrimerApellido,
        documentNumber: clienteDocumento,
        birthDate: clienteFechaNacimiento,
        issueDate: clienteFechaExpedicion,
      });

      setCedulaValidation(result);
      setNotice({
        text: result.summary,
        tone: result.status === "valid" ? "emerald" : "red",
      });

      return result.status === "valid";
    } catch (error) {
      setCedulaValidation({
        status: "invalid",
        summary:
          "No se pudo leer la cedula. Toma fotos mas claras o carga imagenes mas nitidas antes de continuar.",
        checkedAt: new Date().toISOString(),
        checks: [],
      });
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo validar la cedula contra los datos de la venta.",
        tone: "red",
      });
      return false;
    }
  };

  const veriffStatusLabel = (validation: VeriffValidationState | null) => {
    if (!validation) {
      return veriffConfig.configured ? "Pendiente" : "Sin configurar";
    }

    if (veriffApprovalCanUnlockClient(validation)) {
      return "Aprobada";
    }

    if (validation.approved) {
      return "Sin datos";
    }

    if (validation.technicalApproved && validation.riskBlocked) {
      return "Riesgo";
    }

    if (validation.technicalApproved && !validation.trusted) {
      return "Prueba";
    }

    if (validation.status === "DECLINED") {
      return "Rechazada";
    }

    if (validation.status === "EXPIRED" || validation.status === "ABANDONED") {
      return "Vencida";
    }

    if (validation.status === "RESUBMISSION") {
      return "Nueva captura";
    }

    if (validation.status === "ERROR") {
      return "Error";
    }

    if (validation.sessionUrl) {
      return "QR listo";
    }

    return "En revision";
  };

  const normalizeVeriffDocumentType = (value: string | null | undefined) => {
    const normalized = String(value || "").toUpperCase();
    if (normalized.includes("PASSPORT")) {
      return "PASAPORTE";
    }
    if (normalized.includes("RESIDENCE") || normalized.includes("FOREIGN")) {
      return "CEDULA_DE_EXTRANJERIA";
    }
    return DOCUMENT_TYPE_OPTIONS[0].value;
  };

  const normalizeVeriffGender = (value: string | null | undefined) => {
    const normalized = String(value || "").trim().toUpperCase();
    if (["M", "MALE", "MASCULINO", "HOMBRE"].includes(normalized)) {
      return "MASCULINO";
    }
    if (["F", "FEMALE", "FEMENINO", "MUJER"].includes(normalized)) {
      return "FEMENINO";
    }
    return "";
  };

  const applyVeriffIdentityData = (validation: VeriffValidationState | null) => {
    const identity = validation?.identityData;
    if (!veriffApprovalCanUnlockClient(validation) || !identity) {
      return false;
    }

    const fullNameParts = String(identity.fullName || "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    const firstName = String(identity.firstName || fullNameParts[0] || "")
      .replace(/\s+/g, " ")
      .trim();
    const lastName = String(
      identity.lastName ||
        (fullNameParts.length > 1 ? fullNameParts[fullNameParts.length - 1] : "")
    )
      .replace(/\s+/g, " ")
      .trim();
    const documentNumber = String(identity.documentNumber || "").replace(/\D/g, "");
    const birthDate = dateOnly(identity.dateOfBirth);
    const issueDate = dateOnly(identity.issueDate);
    const gender = normalizeVeriffGender(identity.gender);

    let copiedFields = 0;

    if (firstName) {
      copiedFields += 1;
      setClientePrimerNombre(firstName);
    }
    if (lastName) {
      copiedFields += 1;
      setClientePrimerApellido(lastName);
    }
    if (documentNumber) {
      copiedFields += 1;
      setClienteDocumento(documentNumber);
    }
    if (identity.documentType) {
      copiedFields += 1;
      setClienteTipoDocumento(normalizeVeriffDocumentType(identity.documentType));
    }
    if (birthDate) {
      copiedFields += 1;
      setClienteFechaNacimiento(birthDate);
    }
    if (issueDate) {
      copiedFields += 1;
      setClienteFechaExpedicion(issueDate);
    }
    if (gender) {
      copiedFields += 1;
      setClienteGenero(gender);
    }

    if (copiedFields <= 0) {
      return false;
    }

    applyingVeriffIdentityRef.current = true;
    setWizardStep(1);

    return true;
  };

  const veriffMissingIdentityMessage =
    "Aprobada sin datos para autocompletar.";
  const veriffRiskMessage =
    "Validacion aprobada tecnicamente, pero tiene etiquetas de riesgo.";

  const veriffMediaLabel = (item: VeriffMediaState) => {
    const context = `${item.context || item.name}`.toLowerCase();

    if (context.includes("document-and-face")) {
      return "Documento y rostro";
    }
    if (context.includes("document-front")) {
      return "Cedula frente";
    }
    if (context.includes("document-back")) {
      return "Cedula respaldo";
    }
    if (context.includes("face") || context.includes("self")) {
      return "Selfie";
    }
    return item.kind === "video" ? "Video Veriff" : "Foto Veriff";
  };

  const refreshVeriffMedia = async (
    validation: VeriffValidationState | null = veriffValidation
  ) => {
    if (!validation?.id || !validation.veriffSessionId) {
      setVeriffMediaItems([]);
      setVeriffMediaError("");
      return;
    }

    try {
      setVeriffMediaLoading(true);
      setVeriffMediaError("");
      const result = await requestJson<VeriffMediaResponse>(
        `/api/creditos/veriff/${validation.id}/media`
      );

      if (!result.ok) {
        throw new Error(
          result.data?.error || "No se pudo consultar la evidencia Veriff"
        );
      }

      setVeriffMediaItems([
        ...(result.data.images || []),
        ...(result.data.videos || []),
      ]);
    } catch (error) {
      setVeriffMediaItems([]);
      setVeriffMediaError(
        error instanceof Error
          ? error.message
          : "No se pudo consultar la evidencia Veriff"
      );
    } finally {
      setVeriffMediaLoading(false);
    }
  };

  const refreshVeriffValidation = async (
    validationId = veriffValidation?.id || null,
    options: { silent?: boolean } = {}
  ) => {
    if (!validationId) {
      if (!options.silent) {
        setNotice({
          text: "Primero genera la validacion de identidad.",
          tone: "amber",
        });
      }
      return null;
    }

    try {
      setVeriffRefreshing(true);
      const result = await requestJson<VeriffResponse>(
        `/api/creditos/veriff/${validationId}`
      );

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo consultar la validacion");
      }

      if (result.data.veriff) {
        setVeriffConfig(result.data.veriff);
      }

      const validation = result.data.validation || null;
      setVeriffValidation(validation);
      const usableApproval = veriffApprovalCanUnlockClient(validation);
      const filledClientData = applyVeriffIdentityData(validation);
      setVeriffInlineMessage(
        validation?.riskBlocked
          ? veriffRiskMessage
          : validation?.approved && (!usableApproval || !filledClientData)
            ? veriffMissingIdentityMessage
            : ""
      );
      const isTestApproval =
        Boolean(validation?.technicalApproved) && validation?.trusted === false;
      const shouldNotify =
        !options.silent ||
        usableApproval ||
        Boolean(validation?.approved && !usableApproval) ||
        Boolean(validation?.riskBlocked) ||
        validation?.status === "DECLINED" ||
        validation?.status === "ERROR" ||
        validation?.status === "EXPIRED" ||
        validation?.status === "ABANDONED";

      if (shouldNotify) {
        setNotice({
          text: validation?.riskBlocked
            ? "Validacion bloqueada por riesgo."
            : usableApproval
            ? filledClientData
              ? "Identidad aprobada. Datos copiados."
              : "Identidad aprobada sin datos."
            : validation?.approved
              ? "Identidad aprobada sin datos para autocompletar. Reintenta la validacion."
            : isTestApproval
              ? "Aprobacion de prueba."
              : validation
                ? `${veriffStatusLabel(validation)}.`
                : "Sin resultado.",
          tone: validation?.riskBlocked
            ? "red"
            : usableApproval
            ? "emerald"
            : validation?.approved
              ? "amber"
            : validation?.status === "DECLINED" || validation?.status === "ERROR"
              ? "red"
              : "amber",
        });
      }

      if (validation?.veriffSessionId) {
        void refreshVeriffMedia(validation);
      } else {
        setVeriffMediaItems([]);
        setVeriffMediaError("");
      }

      return validation;
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo consultar la validacion.",
        tone: "red",
      });
      return null;
    } finally {
      setVeriffRefreshing(false);
    }
  };

  const validateIdentityWithVeriff = async () => {
    if (!veriffConfig.configured) {
      setNotice({
        text:
          "Configura VERIFF_BASE_URL, VERIFF_API_KEY y VERIFF_SHARED_SECRET antes de validar con Veriff.",
        tone: "amber",
      });
      return null;
    }

    try {
      setVeriffSubmitting(true);
      setVeriffInlineMessage("");
      setVeriffMediaItems([]);
      setVeriffMediaError("");
      setNotice({
        text: "Preparando validacion de identidad...",
        tone: "slate",
      });

      const result = await requestJson<VeriffResponse>("/api/creditos/veriff", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          captureToken: mobileCaptureSession?.token || null,
          draftId,
          clienteDocumento,
          clientePrimerNombre,
          clientePrimerApellido,
          clienteTipoDocumento,
        }),
      });

      if (!result.ok) {
        const remotePayload = result.data?.remotePayload;
        const remoteMessage =
          remotePayload && typeof remotePayload === "object"
            ? String(
                (remotePayload as Record<string, unknown>).message ||
                  (remotePayload as Record<string, unknown>).error ||
                  ""
              )
            : "";
        throw new Error(
          [result.data?.error, remoteMessage].filter(Boolean).join(" | ") ||
            "No se pudo generar el QR de identidad"
        );
      }

      if (result.data.veriff) {
        setVeriffConfig(result.data.veriff);
      }

      const validation = result.data.validation || null;
      setVeriffValidation(validation);
      if (!validation?.sessionUrl) {
        setVeriffInlineMessage(
          "Se creo la sesion, pero no retorno un enlace para generar el QR."
        );
      }
      const filledClientData = applyVeriffIdentityData(validation);
      const usableApproval = veriffApprovalCanUnlockClient(validation);
      setVeriffInlineMessage(
        validation?.riskBlocked
          ? veriffRiskMessage
          : validation?.approved && (!usableApproval || !filledClientData)
            ? veriffMissingIdentityMessage
            : ""
      );
      setNotice({
        text: validation?.riskBlocked
          ? "Validacion bloqueada por riesgo."
          : usableApproval
          ? filledClientData
            ? "Identidad aprobada. Datos copiados."
            : "Identidad aprobada sin datos."
          : validation?.approved
            ? "Identidad aprobada sin datos para autocompletar. Reintenta la validacion."
          : "QR de validacion listo.",
        tone: validation?.riskBlocked ? "red" : usableApproval ? "emerald" : "amber",
      });

      if (validation?.veriffSessionId) {
        void refreshVeriffMedia(validation);
      }

      return validation;
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo validar identidad.",
        tone: "red",
      });
      setVeriffInlineMessage(
        error instanceof Error
          ? error.message
          : "No se pudo generar el QR de identidad."
      );
      return null;
    } finally {
      setVeriffSubmitting(false);
    }
  };

  const validateIdentityWithVeriffRef = useRef(validateIdentityWithVeriff);
  const refreshVeriffValidationRef = useRef(refreshVeriffValidation);

  useEffect(() => {
    validateIdentityWithVeriffRef.current = validateIdentityWithVeriff;
    refreshVeriffValidationRef.current = refreshVeriffValidation;
  });

  useEffect(() => {
    if (
      !veriffIdentityFlowEnabled ||
      paymentsView ||
      lookupMode ||
      simulatorMode ||
      wizardStep !== 1 ||
      veriffValidation?.id ||
      veriffSubmitting ||
      veriffAutoSessionRef.current
    ) {
      return;
    }

    veriffAutoSessionRef.current = true;
    void validateIdentityWithVeriffRef.current().then((validation) => {
      if (!validation?.id) {
        veriffAutoSessionRef.current = false;
      }
    });
  }, [
    lookupMode,
    paymentsView,
    simulatorMode,
    veriffIdentityFlowEnabled,
    veriffSubmitting,
    veriffValidation?.id,
    wizardStep,
  ]);

  useEffect(() => {
    if (
      !veriffIdentityFlowEnabled ||
      !veriffValidation?.id ||
      veriffHasFinalDecision
    ) {
      return;
    }

    let polling = false;
    const syncStatus = () => {
      if (polling) {
        return;
      }
      polling = true;
      void refreshVeriffValidationRef
        .current(veriffValidation.id, { silent: true })
        .finally(() => {
          polling = false;
        });
    };

    const pollId = window.setInterval(syncStatus, 4000);

    return () => {
      window.clearInterval(pollId);
    };
  }, [
    veriffHasFinalDecision,
    veriffIdentityFlowEnabled,
    veriffValidation?.id,
  ]);

  const clampWizardStep = (targetStep: number) => {
    const clamped = Math.min(5, Math.max(1, targetStep));
    return hideIdentityWizardStep && clamped === 3 ? 4 : clamped;
  };

  const nextVisibleWizardStep = (currentStep: number) =>
    visibleFactorySteps.find((step) => step.id > currentStep)?.id || currentStep;

  const previousVisibleWizardStep = (currentStep: number) =>
    [...visibleFactorySteps].reverse().find((step) => step.id < currentStep)?.id || 1;

  const goToStep = (targetStep: number) => {
    if (FLEXIBLE_WIZARD_FOR_TESTING || canAdminMoveFreelyInFactory) {
      setWizardStep(clampWizardStep(targetStep));
      return;
    }

    if (targetStep <= wizardStep) {
      setWizardStep(clampWizardStep(targetStep));
      return;
    }

    if (wizardStep === 1 && !stepClienteReady) {
      setNotice({
        text: "Completa los datos del cliente antes de avanzar al equipo.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 2 && !stepEquipoReady) {
      setNotice({
        text:
          hideIdentityWizardStep
            ? "Completa el equipo, usa un IMEI de 15 numeros y revisa el plan financiero antes de avanzar a contratos."
            : "Completa el equipo, usa un IMEI de 15 numeros y revisa el plan financiero antes de avanzar a identidad.",
        tone: "amber",
      });
      return;
    }

    if (hideIdentityWizardStep && wizardStep === 2 && targetStep >= 3 && !stepContratoReady) {
      setNotice({
        text: "Veriff debe aprobar la identidad antes de avanzar a contratos.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 3 && !stepContratoReady) {
      setNotice({
        text:
          veriffIdentityFlowEnabled && !veriffApproved
            ? "Veriff debe aprobar la identidad antes de avanzar a los contratos."
            : "Completa selfie y cedula por ambos lados antes de avanzar a los contratos.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 2 && !stepEquipoReady) {
      setNotice({
        text:
          "Captura selfie, cédula por ambos lados y firma antes de avanzar al equipo.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 3 && !stepContratoReady) {
      setNotice({
        text:
          "Completa la selección del equipo y la estructura financiera antes de finalizar.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 4 && !stepDocumentosReady) {
      setNotice({
        text:
          "Envia primero el expediente por FirmaSeguro antes de pasar a la validacion del equipo.",
        tone: "amber",
      });
      return;
    }

    setWizardStep(clampWizardStep(targetStep));
  };

  const advanceToStep = async (targetStep: number) => {
    if (FLEXIBLE_WIZARD_FOR_TESTING || canAdminMoveFreelyInFactory) {
      setWizardStep(clampWizardStep(targetStep));
      return;
    }

    if (targetStep <= wizardStep) {
      setWizardStep(clampWizardStep(targetStep));
      return;
    }

    if (wizardStep === 1 && !stepClienteReady) {
      setNotice({
        text: "Completa los datos del cliente antes de avanzar al equipo.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 2 && !stepEquipoReady) {
      setNotice({
        text:
          hideIdentityWizardStep
            ? "Completa el equipo, usa un IMEI de 15 numeros y revisa el plan financiero antes de avanzar a contratos."
            : "Completa el equipo, usa un IMEI de 15 numeros y revisa el plan financiero antes de avanzar a identidad.",
        tone: "amber",
      });
      return;
    }

    if (hideIdentityWizardStep && wizardStep === 2 && targetStep >= 3 && !stepContratoReady) {
      setNotice({
        text: "Veriff debe aprobar la identidad antes de pasar a contratos.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 3) {
      if (!identityStepReady) {
        setNotice({
          text:
            "Aprueba la identidad con Veriff antes de pasar a los contratos.",
          tone: "amber",
        });
        return;
      }

      if (veriffRequired && !veriffApproved) {
        setNotice({
          text: "Veriff debe aprobar la identidad antes de pasar a los contratos.",
          tone: "amber",
        });
        return;
      }

      setWizardStep(clampWizardStep(targetStep));
      return;
    }

    if (wizardStep === 2 && !stepEquipoReady) {
      setNotice({
        text:
          "Completa el equipo, usa un IMEI de 15 numeros y revisa la estructura financiera antes de avanzar al contrato.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 3) {
      if (!contractEvidenceReady || !pagareAceptado) {
        setNotice({
          text: "Completa contrato, pagare y carta antes de pasar a la validacion final.",
          tone: "amber",
        });
        return;
      }

    }

    if (wizardStep === 4 && !stepDocumentosReady) {
      setNotice({
        text:
          "Envia primero el expediente por FirmaSeguro antes de pasar a la validacion del equipo.",
        tone: "amber",
      });
      return;
    }

    setWizardStep(clampWizardStep(targetStep));
  };

  const createWhatsAppOtp = async () => {
    if (!clienteTelefono.trim()) {
      setNotice({
        text: "Ingresa primero el telefono del cliente para generar el OTP.",
        tone: "amber",
      });
      return;
    }

    setSendingOtp(true);
    setNotice({
      text: "Enviando OTP por WhatsApp API...",
      tone: "slate",
    });

    try {
      const result = await requestJson<WhatsAppOtpResponse>(
        "/api/creditos/otp-whatsapp",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            telefono: clienteTelefono,
            clienteNombre: clienteNombre || clientePrimerNombre,
          }),
        }
      );

      if (!result.ok || !result.data?.code) {
        throw new Error(
          [result.data?.error, result.data?.details].filter(Boolean).join(" - ") ||
            "No se pudo enviar el OTP por WhatsApp"
        );
      }

      setOtpCodeGenerated(result.data.code);
      setOtpCodeTyped("");
      setOtpVerifiedAt("");
      setNotice({
        text:
          result.data.mode === "template"
            ? "OTP enviado por WhatsApp API. Pide al cliente el codigo recibido para validarlo aqui."
            : "OTP enviado por WhatsApp API como mensaje directo. Si Meta lo rechaza, crea una plantilla de autenticacion.",
        tone: "emerald",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo enviar el OTP por WhatsApp",
        tone: "red",
      });
    } finally {
      setSendingOtp(false);
    }
  };

  const verifyOtp = () => {
    if (!otpCodeGenerated) {
      setNotice({
        text: "Primero genera el OTP desde WhatsApp.",
        tone: "amber",
      });
      return;
    }

    if (otpCodeTyped.trim() !== otpCodeGenerated) {
      setNotice({
        text: "El codigo OTP no coincide. Revisa el valor confirmado por el cliente.",
        tone: "red",
      });
      return;
    }

    const now = new Date().toISOString();
    setOtpVerifiedAt(now);
    setNotice({
      text: "OTP validado correctamente como evidencia adicional del contrato.",
      tone: "emerald",
    });
  };

  const ensureDeliveryReadyToRequest = (actionLabel: string) => {
    if (!imeiValido) {
      setNotice({
        text: `El IMEI debe tener exactamente 15 numeros antes de ${actionLabel}.`,
        tone: "red",
      });
      return false;
    }

    if (
      !stepClienteReady ||
      !stepEquipoReady ||
      !stepContratoReady ||
      !stepDocumentosReady
    ) {
      setNotice({
        text:
          `Completa cliente, equipo, identidad y envia FirmaSeguro antes de ${actionLabel}.`,
        tone: "amber",
      });
      return false;
    }

    return true;
  };

  const requestDeliveryAction = async (action: "enroll" | "query") => {
    const result = await requestJson<{
      ok?: boolean;
      error?: string;
      remoteStatusCode?: number | null;
      resultMessage?: string | null;
      serviceDetails?: string | null;
      deviceState?: string | null;
      deliveryStatus?: DeliveryStatus;
    }>("/api/equality", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        deviceUid: imeiDigits,
      }),
    });

    if (!result.ok) {
      throw new Error(
        result.data?.error ||
          (action === "enroll"
            ? "No se pudo inscribir el equipo en Zero Touch"
            : "No se pudo validar la entrega del dispositivo")
      );
    }

    return result.data;
  };

  const enrollDeviceBeforeFinalize = async () => {
    if (!ensureDeliveryReadyToRequest("inscribir el equipo")) {
      return;
    }

    try {
      setEnrollingDelivery(true);
      setNotice(null);
      setDeliveryValidation(null);

      const result = await requestDeliveryAction("enroll");

      setNotice({
        text:
          result.resultMessage ||
          "Inscripcion enviada a Zero Touch. Ahora valida la entrega para confirmar si se puede cerrar.",
        tone: "emerald",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo inscribir el equipo en Zero Touch",
        tone: "red",
      });
    } finally {
      setEnrollingDelivery(false);
    }
  };

  const validateDeliveryBeforeFinalize = async () => {
    if (!ensureDeliveryReadyToRequest("validar la entrega")) {
      return;
    }

    try {
      setValidatingDelivery(true);
      setNotice(null);

      const result = await requestDeliveryAction("query");

      const nextValidation: DeliveryValidationState = {
        checkedAt: new Date().toISOString(),
        deviceState: result.deviceState || null,
        remoteStatusCode: result.remoteStatusCode || null,
        resultMessage: result.resultMessage || null,
        serviceDetails: result.serviceDetails || null,
        status: result.deliveryStatus || null,
      };

      setDeliveryValidation(nextValidation);

      if (result.deliveryStatus?.ready) {
        setNotice({
          text:
            result.deliveryStatus.detail ||
            "Zero Touch confirmo que el equipo esta 100% entregable.",
          tone: "emerald",
        });
        return;
      }

      setNotice({
        text:
          result.deliveryStatus?.detail ||
          result.resultMessage ||
          "Zero Touch aun no confirma que el equipo este entregable.",
        tone: "amber",
      });
    } catch (error) {
      setDeliveryValidation(null);
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo validar la entrega del dispositivo",
        tone: "red",
      });
    } finally {
      setValidatingDelivery(false);
    }
  };

  const resetForm = () => {
    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }

    setWizardStep(1);
    setDraftId(null);
    setDraftStatus("idle");
    setDraftLastSavedAt("");
    setClienteNombre("");
    setClientePrimerNombre("");
    setClientePrimerApellido("");
    setClienteTipoDocumento(DOCUMENT_TYPE_OPTIONS[0].value);
    setClienteDireccion("");
    setClienteDocumento("");
    setClienteFechaNacimiento("");
    setClienteFechaExpedicion("");
    setClienteTelefono("");
    setClienteCorreo("");
    setClienteDepartamento("");
    setClienteCiudad("");
    setClienteGenero("");
    setReferenciaFamiliar1Nombre("");
    setReferenciaFamiliar1Parentesco("");
    setReferenciaFamiliar1Telefono("");
    setReferenciaFamiliar2Nombre("");
    setReferenciaFamiliar2Parentesco("");
    setReferenciaFamiliar2Telefono("");
    setEquipoMarca("");
    setEquipoModelo("");
    setImei("");
    setValorEquipoTotal("");
    setCuotaInicial("");
    setPlazoMeses(
      String(
        normalizeCreditInstallments(
          creditSettings.plazoCuotas,
          DEFAULT_CREDIT_INSTALLMENTS,
          creditSettings.plazoMaximoCuotas
        )
      )
    );
    setTasaInteresEa(String(creditSettings.tasaInteresEa));
    setFianzaPorcentaje(String(creditSettings.fianzaPorcentaje));
    setFechaPrimerPago(
      getDefaultFirstPaymentDate(new Date(), creditSettings.frecuenciaPago)
    );
    setContratoAceptado(false);
    setContratoFotoDataUrl("");
    setContratoFotoAudit(null);
    setContratoCedulaFrenteDataUrl("");
    setContratoCedulaFrenteAudit(null);
    setContratoCedulaRespaldoDataUrl("");
    setContratoCedulaRespaldoAudit(null);
    setContratoVideoAprobacionDataUrl("");
    setContratoVideoAprobacionAudit(null);
    setContratoFirmaDataUrl("");
    setOtpCodeGenerated("");
    setOtpCodeTyped("");
    setOtpVerifiedAt("");
    setPagareAceptado(false);
    setCartaAceptada(false);
    setAutorizacionDatosAceptada(false);
    setFirmaSeguroDraftProcess(null);
    setDeliveryValidation(null);
    setVeriffValidation(null);
    setCameraSlot(null);
    setMobileCaptureSession(null);
    setMobileCaptureQrDataUrl("");
    mobileCaptureAppliedRef.current = "";
    setSignaturePadKey((current) => current + 1);
    void loadCreditSettings();
  };

  const upsertCredit = (item: CreditItem) => {
    setCredits((current) => {
      const next = current.some((credit) => credit.id === item.id)
        ? current.map((credit) => (credit.id === item.id ? item : credit))
        : [item, ...current];

      return next.sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    });
    setSelectedId(item.id);
  };

  const saveCurrentDraft = async (currentStepOverride = wizardStep) => {
    const result = await requestJson<CreditDraftSingleResponse>(
      "/api/creditos/borradores",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: draftId,
          currentStep: currentStepOverride,
          payload: {
            ...factoryDraftPayload,
            wizardStep: currentStepOverride,
          },
        }),
      }
    );

    if (!result.ok || !result.data?.item) {
      throw new Error(result.data?.error || "No se pudo guardar el borrador");
    }

    setDraftId(result.data.item.id);
    setDraftLastSavedAt(
      result.data.item.updatedAt ? dateTime(result.data.item.updatedAt) : ""
    );
    setDraftStatus("saved");

    return result.data.item.id;
  };

  const submitFirmaSeguroDraft = async (currentDraftId: number) => {
    const result = await requestJson<FirmaSeguroResponse>(
      `/api/creditos/borradores/${currentDraftId}/firma-seguro`,
      {
        method: "POST",
      }
    );

    if (!result.ok || !result.data?.ok) {
      throw new Error(
        result.data?.error || "No se pudo enviar el expediente a FirmaSeguro"
      );
    }

    setFirmaSeguroDraftProcess(result.data.process || null);
    return result.data;
  };

  const refreshFirmaSeguroDraftProcess = async () => {
    if (!draftId) {
      setNotice({
        text: "Guarda o envia primero el borrador a FirmaSeguro.",
        tone: "amber",
      });
      return null;
    }

    try {
      setFirmaSeguroRefreshing(true);
      setNotice(null);

      const result = await requestJson<FirmaSeguroResponse>(
        `/api/creditos/borradores/${draftId}/firma-seguro?refresh=1`
      );

      if (!result.ok || !result.data?.ok) {
        throw new Error(
          result.data?.error || "No se pudo actualizar el estado de FirmaSeguro"
        );
      }

      const process = result.data.process || null;
      setFirmaSeguroDraftProcess(process);

      if (process?.completedAt || process?.hasSignedDocument) {
        setWizardStep(5);
        setNotice({
          text:
            "FirmaSeguro reporto firma exitosa. Ahora valida la entrega y finaliza el credito.",
          tone: "emerald",
        });
      } else {
        setNotice({
          text: "FirmaSeguro aun no reporta firma exitosa.",
          tone: "amber",
        });
      }

      return process;
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo consultar FirmaSeguro",
        tone: "red",
      });
      return null;
    } finally {
      setFirmaSeguroRefreshing(false);
    }
  };

  const createCredit = async (
    options: {
      allowPendingDelivery?: boolean;
      firmaSeguroPasoContratos?: boolean;
      firmaSeguroProcessUuid?: string;
    } = {}
  ) => {
    const acceptsByFirmaSeguro = Boolean(options.firmaSeguroPasoContratos);
    const documentsReadyForCreate = acceptsByFirmaSeguro
      ? firmaSeguroProcessSigned
      : stepDocumentosReady;
    const deliveryReadyForCreate =
      Boolean(options.allowPendingDelivery) || deliveryRequirementReady;
    const readyToCreate =
      stepClienteReady &&
      stepEquipoReady &&
      stepContratoReady &&
      documentsReadyForCreate &&
      deliveryReadyForCreate;

    if (!readyToCreate) {
      setNotice({
        text: acceptsByFirmaSeguro
          ? veriffRequired && !veriffApproved
            ? "Veriff debe aprobar la identidad antes de finalizar el credito."
            : "FirmaSeguro debe reportar firma exitosa y debes validar la entrega antes de finalizar el credito."
          : veriffRequired && !veriffApproved
            ? "Veriff debe aprobar la identidad antes de finalizar la venta."
            : "Completa el flujo de cliente, equipo, identidad, contratos y valida el equipo antes de finalizar la venta.",
        tone: "red",
      });
      return null;
    }

    try {
      setCreating(true);
      setNotice(null);

      const result = await requestJson<CreateCreditResponse>("/api/creditos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientePrimerNombre,
          clientePrimerApellido,
          clienteTipoDocumento,
          clienteDireccion,
          clienteNombre,
          clienteDocumento,
          clienteFechaNacimiento,
          clienteFechaExpedicion,
          clienteTelefono,
          clienteCorreo,
          clienteDepartamento,
          clienteCiudad,
          clienteGenero,
          referenciaFamiliar1Nombre,
          referenciaFamiliar1Parentesco,
          referenciaFamiliar1Telefono,
          referenciaFamiliar2Nombre,
          referenciaFamiliar2Parentesco,
          referenciaFamiliar2Telefono,
          referenciaEquipo,
          equipoMarca,
          equipoModelo,
          equipoCatalogoId: selectedEquipmentCatalogItem?.id || null,
          imei: imeiDigits,
          valorEquipoTotal,
          cuotaInicial,
          plazoMeses,
          frecuenciaPago: creditSettings.frecuenciaPago,
          tasaInteresEa: financialPlan.tasaInteresEa,
          fianzaPorcentaje: financialPlan.fianzaPorcentaje,
          fechaPrimerPago,
          firmaSeguroPasoContratos: acceptsByFirmaSeguro,
          firmaSeguroProcessUuid:
            options.firmaSeguroProcessUuid ||
            firmaSeguroDraftProcess?.processUuid ||
            null,
          contratoAceptado: acceptsByFirmaSeguro || contratoAceptado,
          contratoFirmaDataUrl,
          contratoFotoDataUrl,
          contratoSelfieDataUrl: contratoFotoDataUrl,
          contratoSelfieCapturedAt: contratoFotoAudit?.capturedAt || null,
          contratoSelfieSource: contratoFotoAudit?.source || null,
          contratoCedulaFrenteDataUrl,
          contratoCedulaFrenteCapturedAt:
            contratoCedulaFrenteAudit?.capturedAt || null,
          contratoCedulaFrenteSource: contratoCedulaFrenteAudit?.source || null,
          contratoCedulaRespaldoDataUrl,
          contratoCedulaRespaldoCapturedAt:
            contratoCedulaRespaldoAudit?.capturedAt || null,
          contratoCedulaRespaldoSource:
            contratoCedulaRespaldoAudit?.source || null,
          contratoOtpCanal: "",
          contratoOtpDestino: "",
          contratoOtpVerificadoAt: null,
          veriffValidationId: veriffValidation?.id || null,
          pagareAceptado: acceptsByFirmaSeguro || pagareAceptado,
          cartaAceptada: acceptsByFirmaSeguro || cartaAceptada,
          autorizacionDatosAceptada:
            acceptsByFirmaSeguro || autorizacionDatosAceptada,
        }),
      });

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo crear el credito");
      }

      const createdCredit = result.data.item;
      upsertCredit(createdCredit);
      const planLookup = encodeURIComponent(
        String(createdCredit.folio || createdCredit.id)
      );
      window.open(`/api/creditos/${planLookup}/plan-pagos`, "_blank");
      const closedDraftId = draftId;

      if (closedDraftId) {
        await requestJson<CreditDraftSingleResponse>("/api/creditos/borradores", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ id: closedDraftId, estado: "CERRADO" }),
        }).catch(() => null);
      }

      resetForm();

      if (result.data.deliveryStatus?.ready) {
        setNotice({
          text: `${createdCredit.folio} quedo inscrito y 100% entregable.`,
          tone: "emerald",
        });
      } else if (result.data.warning) {
        setNotice({
          text: result.data.warning,
          tone: "amber",
        });
      } else {
        setNotice({
          text:
            result.data.deliveryStatus?.detail ||
            "Credito generado. Revisa la verificacion antes de entregar el equipo.",
          tone: "amber",
        });
      }

      window.location.assign("/app");
      return createdCredit;
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo crear el credito",
        tone: "red",
      });
      return null;
    } finally {
      setCreating(false);
    }
  };

  const handleFirmaSeguroStepReady = async () => {
    if (!contratoListo) {
      setNotice({
        text:
          "Completa cliente, equipo e identidad antes de enviar el expediente a FirmaSeguro.",
        tone: "amber",
      });
      return;
    }

    try {
      setFirmaSeguroSubmitting(true);
      setNotice(null);

      const currentDraftId = await saveCurrentDraft(4);
      const signature = await submitFirmaSeguroDraft(currentDraftId);
      const process = signature.process || null;
      const uuid = process?.processUuid;
      const signed = Boolean(process?.completedAt || process?.hasSignedDocument);

      if (signed) {
        setWizardStep(5);
      }

      setNotice({
        text: signed
          ? "FirmaSeguro reporto firma exitosa. Valida la entrega para finalizar el credito."
          : uuid
            ? `Expediente enviado a FirmaSeguro. Proceso: ${uuid}. Espera la firma exitosa para continuar.`
            : signature.message ||
              "Expediente enviado a FirmaSeguro. Espera la firma exitosa para continuar.",
        tone: signed ? "emerald" : "amber",
      });
    } catch (error) {
      setNotice({
        text:
          "No se pudo enviar a FirmaSeguro: " +
          (error instanceof Error ? error.message : "error desconocido"),
        tone: "red",
      });
    } finally {
      setFirmaSeguroSubmitting(false);
    }
  };

  const finalizeFirmaSeguroDelivery = async () => {
    if (firmaSeguroProcessSent || firmaSeguroDraftProcess) {
      if (!firmaSeguroProcessSigned) {
        setNotice({
          text:
            "FirmaSeguro debe reportar firma exitosa antes de finalizar el credito.",
          tone: "amber",
        });
        return;
      }

      if (!deliveryRequirementReady) {
        setNotice({
          text:
            "Valida primero la entrega con Zero Touch antes de finalizar este credito.",
          tone: "amber",
        });
        return;
      }

      await createCredit({
        firmaSeguroPasoContratos: true,
        firmaSeguroProcessUuid: firmaSeguroDraftProcess?.processUuid || undefined,
      });
      return;
    }

    if (!stepDocumentosReady) {
      setNotice({
        text:
          "Completa primero los contratos o envia el expediente por FirmaSeguro.",
        tone: "amber",
      });
      return;
    }

    if (!deliveryRequirementReady) {
      setNotice({
        text:
          "Valida primero la entrega con Zero Touch antes de finalizar este credito.",
        tone: "amber",
      });
      return;
    }

    await createCredit();
  };

  const registerPayment = async () => {
    if (!selectedCredit) {
      setNotice({
        text: "Selecciona primero un credito para registrar el abono.",
        tone: "red",
      });
      return;
    }

    if (isCreditAnnulled(selectedCredit.estado) || paymentBlockedByAnnulment) {
      setNotice({
        text: "Este credito esta anulado y no permite registrar recaudos.",
        tone: "red",
      });
      return;
    }

    if (paymentAmountToApply <= 0) {
      setNotice({
        text: "Indica el abono que se va a aplicar al credito.",
        tone: "red",
      });
      return;
    }

    if (isEarlyPayoffMode && !earlyPayoffAvailable) {
      setNotice({
        text:
          earlyPayoffSummary?.motivo ||
          "La liquidacion anticipada solo aplica cuando el credito esta al dia.",
        tone: "red",
      });
      return;
    }

    if (
      selectedInstallmentNumbers.length > 0 &&
      selectedInstallmentCoverageShortfall > 0
    ) {
      setNotice({
        text: `El abono no alcanza para las cuotas seleccionadas. Faltan ${currency(selectedInstallmentCoverageShortfall)}.`,
        tone: "red",
      });
      return;
    }

    if (paymentOverCreditAmount > 0) {
      setNotice({
        text: `El abono supera el valor permitido. Ajusta el abono a ${currency(paymentTargetRoundedTotal)}.`,
        tone: "red",
      });
      return;
    }

    if (paymentShortfallAmount > 0) {
      setNotice({
        text: `El valor recibido esta incompleto. Faltan ${currency(paymentShortfallAmount)}.`,
        tone: "red",
      });
      return;
    }

    try {
      setRegisteringPayment(true);
      setNotice(null);
      const valueToRegister = String(
        isEarlyPayoffMode ? earlyPayoffRoundedTotal : paymentAmountToApply
      );
      const paymentAdvanceObservation =
        !isEarlyPayoffMode && paymentAdvanceAmount > 0
          ? `Abono adicional a proximas cuotas ${currency(paymentAdvanceAmount)}`
          : "";
      const paymentChangeObservation =
        paymentChangeAmount > 0
          ? `Recibido ${currency(receivedPaymentAmount)} - devolver ${currency(paymentChangeAmount)}`
          : "";

      const result = await requestJson<RegisterPaymentResponse>(
        `/api/creditos/${selectedCredit.id}/abonos`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            cuotaNumeros: isEarlyPayoffMode ? [] : selectedInstallmentNumbers,
            liquidacionAnticipada: isEarlyPayoffMode,
            tipoAbono: isEarlyPayoffMode ? "LIQUIDACION_ANTICIPADA" : "CUOTAS",
            valor: valueToRegister,
            metodoPago: paymentMethod,
            observacion: [
              paymentObservation,
              paymentAdvanceObservation,
              paymentChangeObservation,
            ]
              .filter(Boolean)
              .join(" - "),
          }),
        }
      );

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo registrar el abono");
      }

      setPaymentValue("");
      setReceivedPaymentValue("");
      setPaymentObservation("");
      setPaymentRegisterMode("INSTALLMENTS");
      setSelectedInstallmentNumbers([]);
      await loadPayments(selectedCredit.id);
      await loadCredits(true, activeSearch);

      const receiptCreditLookup = encodeURIComponent(
        String(selectedCredit.folio || selectedCredit.id)
      );
      window.open(
        `/api/creditos/${receiptCreditLookup}/abonos/${result.data.item.id}/recibo`,
        "_blank"
      );

      setNotice({
        text: `${result.data.message}. Recibo generado.`,
        tone: result.data.summary.saldoPendiente <= 0 ? "emerald" : "amber",
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo registrar el abono",
        tone: "red",
      });
    } finally {
      setRegisteringPayment(false);
    }
  };

  const runCommand = async (command: CreditAdminCommand) => {
    if (!selectedCredit) {
      setNotice({
        text: "Selecciona un credito antes de ejecutar comandos.",
        tone: "red",
      });
      return;
    }

    try {
      setRunningCommand(command);
      setNotice(null);

      const result = await requestJson<CommandResponse>(
        `/api/creditos/${selectedCredit.id}/command`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            command,
            fechaProximoPago: nextDueDate || null,
            observacionAdmin,
          }),
        }
      );

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo ejecutar el comando");
      }

      upsertCredit(result.data.item);
      setNotice({
        text: result.data.message,
        tone: result.data.item.deliverableReady ? "emerald" : "amber",
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo ejecutar el comando",
        tone: "red",
      });
    } finally {
      setRunningCommand(null);
    }
  };

  const updateCreditPlan = async () => {
    if (!selectedCredit) {
      setNotice({
        text: "Selecciona un credito antes de ajustar el plan.",
        tone: "red",
      });
      return;
    }

    const normalizedInstallments = Math.trunc(Number(planInstallments || 0));

    if (!Number.isFinite(normalizedInstallments) || normalizedInstallments < 1) {
      setNotice({
        text: "Indica un numero de cuotas valido.",
        tone: "red",
      });
      return;
    }

    const confirmed = window.confirm(
      `Vas a recalcular este credito a ${normalizedInstallments} cuotas ${getPaymentFrequencyLabel(planFrequency).toLowerCase()}. Esto actualiza cuota, total del credito y plan de pagos.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setUpdatingPlan(true);
      setRunningCommand("update-plan");
      setNotice(null);

      const result = await requestJson<CommandResponse>(
        `/api/creditos/${selectedCredit.id}/command`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            command: "update-plan",
            plazoMeses: normalizedInstallments,
            frecuenciaPago: planFrequency,
            fechaPrimerPago: planFirstPaymentDate || null,
            observacionAdmin: "Correccion de plazo/frecuencia",
          }),
        }
      );

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo ajustar el plan");
      }

      if (!result.data?.item) {
        throw new Error("El servidor no devolvio el credito actualizado");
      }

      upsertCredit(result.data.item);
      await loadPayments(result.data.item.id);
      setNotice({
        text: result.data.message,
        tone: "emerald",
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo ajustar el plan",
        tone: "red",
      });
    } finally {
      setUpdatingPlan(false);
      setRunningCommand(null);
    }
  };

  const sendManualPush = async () => {
    if (!selectedCredit) {
      setNotice({
        text: "Selecciona un credito antes de enviar push.",
        tone: "red",
      });
      return;
    }

    if (manualPushPreset === "custom" && !manualPushBody.trim()) {
      setNotice({
        text: "Escribe el mensaje personalizado antes de enviarlo.",
        tone: "red",
      });
      return;
    }

    try {
      setSendingManualPush(true);
      setNotice(null);

      const result = await requestJson<ManualPushResponse>(
        "/api/creditos/push-manual",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            body: manualPushBody,
            creditoId: selectedCredit.id,
            mode: "credit",
            preset: manualPushPreset,
            title: manualPushTitle,
          }),
        }
      );

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo enviar el push");
      }

      const summary = result.data?.summary;
      setNotice({
        text: summary
          ? `Push enviado: ${summary.sent}. Sin app: ${summary.noToken}. Fallidos: ${summary.failed}.`
          : "Push enviado.",
        tone: summary?.failed ? "red" : summary?.sent ? "emerald" : "amber",
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo enviar el push",
        tone: "red",
      });
    } finally {
      setSendingManualPush(false);
    }
  };

  const downloadPazYSalvo = (creditId?: number | null) => {
    const credit =
      typeof creditId === "number"
        ? credits.find((item) => item.id === creditId) || null
        : selectedCredit;

    if (!credit) {
      setNotice({
        text: "Selecciona un credito antes de descargar el paz y salvo.",
        tone: "red",
      });
      return;
    }

    if (credit.saldoPendiente > 0) {
      setNotice({
        text: "El paz y salvo solo se puede emitir cuando el saldo pendiente este en $0.",
        tone: "amber",
      });
      return;
    }

    const creditLookup = encodeURIComponent(String(credit.folio || credit.id));
    window.open(`/api/creditos/${creditLookup}/paz-y-salvo`, "_blank");
  };

  const downloadPlanPagos = (creditId?: number | null) => {
    const credit =
      typeof creditId === "number"
        ? credits.find((item) => item.id === creditId) || null
        : selectedCredit;

    if (!credit) {
      setNotice({
        text: "Selecciona un credito antes de descargar el plan de pagos.",
        tone: "red",
      });
      return;
    }

    const planLookup = encodeURIComponent(String(credit.folio || credit.id));
    window.open(`/api/creditos/${planLookup}/plan-pagos`, "_blank");
  };

  const downloadPaymentReceipt = (payment: CreditPaymentItem) => {
    const credit =
      selectedCredit?.id === payment.creditoId
        ? selectedCredit
        : credits.find((item) => item.id === payment.creditoId) || null;

    if (!credit) {
      setNotice({
        text: "Selecciona el credito antes de reimprimir el recibo.",
        tone: "red",
      });
      return;
    }

    const creditLookup = encodeURIComponent(String(credit.folio || credit.id));
    window.open(`/api/creditos/${creditLookup}/abonos/${payment.id}/recibo`, "_blank");
  };

  const downloadExpedientePdf = async (creditId?: number | null) => {
    const credit =
      typeof creditId === "number"
        ? credits.find((item) => item.id === creditId) || null
        : selectedCredit;

    if (!credit) {
      setNotice({
        text: "Selecciona un credito antes de descargar el expediente.",
        tone: "red",
      });
      return;
    }

    const creditLookup = encodeURIComponent(String(credit.folio || credit.id));

    try {
      setFirmaSeguroRefreshing(true);
      setNotice(null);

      const result = await requestJson<FirmaSeguroResponse>(
        `/api/creditos/${creditLookup}/firma-seguro?refresh=1`
      );

      if (!result.ok || !result.data?.ok) {
        throw new Error(
          result.data?.error || "No se pudo consultar el expediente firmado"
        );
      }

      if (result.data.documentUrl || result.data.process?.hasSignedDocument) {
        window.open(
          result.data.documentUrl ||
            `/api/creditos/${creditLookup}/firma-seguro/documento?refresh=1`,
          "_blank"
        );
        return;
      }

      const process = result.data.process || null;
      const processStatus = process?.status || "pendiente";
      const lastError = process?.lastError;

      setNotice({
        text: process
          ? isFirmaSeguroSuccessfulProcess(process)
            ? `FirmaSeguro reporto firma exitosa, pero el expediente firmado aun no esta disponible para descargar. ${
                lastError ? `Detalle: ${lastError}. ` : ""
              }Estado: ${processStatus}.`
            : `El expediente PDF final solo queda disponible cuando FirmaSeguro reporte firma exitosa. Estado: ${processStatus}${lastError ? `. Ultimo error: ${lastError}` : ""}.`
          : "Este credito aun no tiene expediente enviado a FirmaSeguro.",
        tone: process
          ? isFirmaSeguroSuccessfulProcess(process)
            ? "amber"
            : "slate"
          : "amber",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo consultar el expediente firmado",
        tone: "red",
      });
    } finally {
      setFirmaSeguroRefreshing(false);
    }
  };

  const openFirmaSeguroSignedDocument = async (creditId?: number | null) => {
    const credit =
      typeof creditId === "number"
        ? credits.find((item) => item.id === creditId) || null
        : selectedCredit;

    if (!credit) {
      setNotice({
        text: "Selecciona un credito antes de consultar FirmaSeguro.",
        tone: "red",
      });
      return;
    }

    try {
      setFirmaSeguroRefreshing(true);
      setNotice(null);

      const creditLookup = encodeURIComponent(String(credit.folio || credit.id));
      const result = await requestJson<FirmaSeguroResponse>(
        `/api/creditos/${creditLookup}/firma-seguro?refresh=1`
      );

      if (!result.ok || !result.data?.ok) {
        throw new Error(
          result.data?.error || "No se pudo consultar el estado de FirmaSeguro"
        );
      }

      if (result.data.documentUrl || result.data.process?.hasSignedDocument) {
        window.open(
          result.data.documentUrl ||
            `/api/creditos/${creditLookup}/firma-seguro/documento?refresh=1`,
          "_blank"
        );
        return;
      }

      const process = result.data.process || null;
      const processStatus = process?.status || "pendiente";
      const lastError = result.data.process?.lastError;
      const signedWithoutPdf = isFirmaSeguroSuccessfulProcess(process);
      setNotice({
        text: process
          ? signedWithoutPdf
            ? `FirmaSeguro reporto firma exitosa, pero el expediente firmado aun no esta disponible para descargar. ${
                lastError ||
                "FirmaSeguro no devolvio el PDF firmado en esta consulta."
              } Estado: ${processStatus}.`
            : `FirmaSeguro aun no reporta firma exitosa. Estado: ${processStatus}${lastError ? `. Ultimo error: ${lastError}` : ""}.`
          : "Este credito aun no se ha enviado a FirmaSeguro.",
        tone: process ? "amber" : "slate",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo consultar el estado de FirmaSeguro",
        tone: "red",
      });
    } finally {
      setFirmaSeguroRefreshing(false);
    }
  };

  const openPaymentsForCredit = (creditId?: number | null) => {
    const credit =
      typeof creditId === "number"
        ? credits.find((item) => item.id === creditId) || null
        : selectedCredit;

    if (!credit) {
      return;
    }

    const params = new URLSearchParams();
    const searchValue =
      credit.clienteDocumento || credit.clienteTelefono || credit.folio;

    if (searchValue) {
      params.set("search", searchValue);
    }

    params.set("selected", String(credit.id));
    window.location.assign(`/dashboard/abonos?${params.toString()}`);
  };

  const focusHistory = () => {
    setPaymentsTab("history");
    window.setTimeout(() => {
      const target = historySectionRef.current;

      if (!target) {
        return;
      }

      const top = target.getBoundingClientRect().top + window.scrollY - 110;
      window.scrollTo({
        top: Math.max(0, top),
        behavior: "smooth",
      });
    }, 80);
  };

  const searchCredits = async () => {
    if (paymentsView) {
      setShowPaymentResults(true);
      setSelectedId(null);
    }
    if (lookupMode) {
      setShowSearchResults(true);
      setShowLookupDetail(false);
    }
    await Promise.all([
      loadCredits(false, searchTerm),
      adminFactoryAssistMode ? loadDrafts(searchTerm) : Promise.resolve(),
    ]);
  };

  const clearSearch = async () => {
    setSearchTerm("");
    setDraftSearchResults([]);
    if (paymentsView) {
      setShowPaymentResults(true);
      setSelectedId(null);
    }
    if (lookupMode) {
      setShowSearchResults(true);
      setSelectedId(null);
      setShowLookupDetail(false);
    }
    await loadCredits(false, "");
  };

  const applyClientDataFromCredit = (credit: CreditItem) => {
    setClientePrimerNombre(credit.clientePrimerNombre || "");
    setClientePrimerApellido(credit.clientePrimerApellido || "");
    setClienteTipoDocumento(credit.clienteTipoDocumento || DOCUMENT_TYPE_OPTIONS[0].value);
    setClienteDireccion(credit.clienteDireccion || "");
    setClienteNombre(credit.clienteNombre || "");
    setClienteDocumento(credit.clienteDocumento || "");
    setClienteFechaNacimiento(dateOnly(credit.clienteFechaNacimiento));
    setClienteFechaExpedicion(dateOnly(credit.clienteFechaExpedicion));
    setClienteTelefono(credit.clienteTelefono || "");
    setClienteCorreo(credit.clienteCorreo || "");
    setClienteDepartamento(credit.clienteDepartamento || "");
    setClienteCiudad(credit.clienteCiudad || "");
    setClienteGenero(credit.clienteGenero || "");
    const familyReferences = credit.referenciasFamiliares || [];
    setReferenciaFamiliar1Nombre(familyReferences[0]?.nombre || "");
    setReferenciaFamiliar1Parentesco(familyReferences[0]?.parentesco || "");
    setReferenciaFamiliar1Telefono(familyReferences[0]?.telefono || "");
    setReferenciaFamiliar2Nombre(familyReferences[1]?.nombre || "");
    setReferenciaFamiliar2Parentesco(familyReferences[1]?.parentesco || "");
    setReferenciaFamiliar2Telefono(familyReferences[1]?.telefono || "");
    setWizardStep(1);
  };

  const applyDraftPayload = (draft: CreditDraftItem) => {
    const payload = draft.payload || {};
    const value = (key: string) => {
      const current = payload[key];

      if (typeof current === "number") {
        return String(current);
      }

      return typeof current === "string" ? current : "";
    };
    const checked = (key: string) => payload[key] === true;

    applyingDraftRef.current = true;
    setDraftId(draft.id);
    setDraftStatus("saved");
    setDraftLastSavedAt(draft.updatedAt ? dateTime(draft.updatedAt) : "");
    setClientePrimerNombre(value("clientePrimerNombre"));
    setClientePrimerApellido(value("clientePrimerApellido"));
    setClienteTipoDocumento(value("clienteTipoDocumento") || DOCUMENT_TYPE_OPTIONS[0].value);
    setClienteDireccion(value("clienteDireccion"));
    setClienteNombre(value("clienteNombre"));
    setClienteDocumento(value("clienteDocumento"));
    setClienteFechaNacimiento(value("clienteFechaNacimiento"));
    setClienteFechaExpedicion(value("clienteFechaExpedicion"));
    setClienteTelefono(value("clienteTelefono"));
    setClienteCorreo(value("clienteCorreo"));
    setClienteDepartamento(value("clienteDepartamento"));
    setClienteCiudad(value("clienteCiudad"));
    setClienteGenero(value("clienteGenero"));
    setReferenciaFamiliar1Nombre(value("referenciaFamiliar1Nombre"));
    setReferenciaFamiliar1Parentesco(value("referenciaFamiliar1Parentesco"));
    setReferenciaFamiliar1Telefono(value("referenciaFamiliar1Telefono"));
    setReferenciaFamiliar2Nombre(value("referenciaFamiliar2Nombre"));
    setReferenciaFamiliar2Parentesco(value("referenciaFamiliar2Parentesco"));
    setReferenciaFamiliar2Telefono(value("referenciaFamiliar2Telefono"));
    setEquipoMarca(value("equipoMarca"));
    setEquipoModelo(value("equipoModelo"));
    setImei(value("imei"));
    setValorEquipoTotal(value("valorEquipoTotal"));
    setCuotaInicial(value("cuotaInicial"));
    setPlazoMeses(value("plazoMeses") || plazoMeses);
    setTasaInteresEa(value("tasaInteresEa") || tasaInteresEa);
    setFianzaPorcentaje(value("fianzaPorcentaje") || fianzaPorcentaje);
    setFechaPrimerPago(value("fechaPrimerPago") || fechaPrimerPago);
    setContratoAceptado(checked("contratoAceptado"));
    setContratoFotoDataUrl(
      value("contratoSelfieDataUrl") || value("contratoFotoDataUrl")
    );
    setContratoFotoAudit(
      value("contratoSelfieCapturedAt") ||
        value("contratoFotoCapturedAt") ||
        value("contratoSelfieSource") ||
        value("contratoFotoSource")
        ? {
            capturedAt:
              value("contratoSelfieCapturedAt") ||
              value("contratoFotoCapturedAt") ||
              new Date().toISOString(),
            source:
              (value("contratoSelfieSource") || value("contratoFotoSource")) ===
              "upload"
                ? "upload"
                : "camera",
          }
        : null
    );
    setContratoCedulaFrenteDataUrl(
      value("contratoCedulaFrenteDataUrl") || value("cedulaFrenteDataUrl")
    );
    setContratoCedulaFrenteAudit(
      value("contratoCedulaFrenteCapturedAt") ||
        value("contratoCedulaFrenteSource")
        ? {
            capturedAt:
              value("contratoCedulaFrenteCapturedAt") || new Date().toISOString(),
            source:
              value("contratoCedulaFrenteSource") === "upload"
                ? "upload"
                : "camera",
          }
        : null
    );
    setContratoCedulaRespaldoDataUrl(
      value("contratoCedulaRespaldoDataUrl") || value("cedulaRespaldoDataUrl")
    );
    setContratoCedulaRespaldoAudit(
      value("contratoCedulaRespaldoCapturedAt") ||
        value("contratoCedulaRespaldoSource")
        ? {
            capturedAt:
              value("contratoCedulaRespaldoCapturedAt") ||
              new Date().toISOString(),
            source:
              value("contratoCedulaRespaldoSource") === "upload"
                ? "upload"
                : "camera",
          }
        : null
    );
    setPagareAceptado(checked("pagareAceptado"));
    setCartaAceptada(checked("cartaAceptada"));
    setAutorizacionDatosAceptada(checked("autorizacionDatosAceptada"));
    setFirmaSeguroDraftProcess(null);
    setDeliveryValidation(null);
    setVeriffValidation(null);
    const savedVeriffValidationId = Number(value("veriffValidationId") || 0);
    if (Number.isInteger(savedVeriffValidationId) && savedVeriffValidationId > 0) {
      veriffAutoSessionRef.current = true;
      void refreshVeriffValidation(savedVeriffValidationId);
    } else {
      veriffAutoSessionRef.current = false;
    }
    setWizardStep(
      clampWizardStep(Number(payload.wizardStep || draft.currentStep || wizardStep))
    );

    window.setTimeout(() => {
      applyingDraftRef.current = false;
    }, 350);
  };

  const createNewSaleFromClient = (creditId?: number | null) => {
    const credit =
      typeof creditId === "number"
        ? credits.find((item) => item.id === creditId) || null
        : selectedCredit;

    if (!credit) {
      return;
    }

    window.sessionStorage.setItem("finserpay-client-prefill", JSON.stringify(credit));
    window.location.assign("/dashboard/creditos?mode=create-client");
  };

  const openAdminAssistanceForCredit = (credit: CreditItem) => {
    const params = new URLSearchParams();
    const searchValue =
      activeSearch ||
      searchTerm.trim() ||
      credit.clienteDocumento ||
      credit.imei ||
      credit.folio;

    if (searchValue) {
      params.set("search", searchValue);
    }

    params.set("selected", String(credit.id));
    window.location.assign(`/dashboard/clientes?${params.toString()}`);
  };

  const openAdminAssistanceForDraft = (draft: CreditDraftItem) => {
    const params = new URLSearchParams();

    params.set("mode", "create-client");
    params.set("draft", String(draft.id));

    if (activeSearch || searchTerm.trim()) {
      params.set("search", activeSearch || searchTerm.trim());
    }

    window.location.assign(`/dashboard/creditos?${params.toString()}`);
  };

  useEffect(() => {
    if (!createClientMode) {
      return;
    }

    const raw = window.sessionStorage.getItem("finserpay-client-prefill");

    if (!raw) {
      return;
    }

    try {
      const credit = JSON.parse(raw) as CreditItem;
      applyClientDataFromCredit(credit);
      setNotice({
        text:
          "Datos del cliente cargados desde su registro anterior. Completa equipo, identidad y contratos para la nueva venta.",
        tone: "emerald",
      });
    } catch {
      setNotice({
        text: "No se pudieron cargar los datos anteriores del cliente.",
        tone: "red",
      });
    } finally {
      window.sessionStorage.removeItem("finserpay-client-prefill");
    }
  }, [createClientMode]);

  useEffect(() => {
    if (!createClientMode || !initialDraftId) {
      return;
    }

    let cancelled = false;

    const loadDraft = async () => {
      try {
        setDraftStatus("loading");
        const params = new URLSearchParams({ id: String(initialDraftId) });
        const result = await requestJson<CreditDraftSingleResponse>(
          `/api/creditos/borradores?${params.toString()}`
        );

        if (!result.ok || !result.data?.item) {
          throw new Error(result.data?.error || "No se encontro el borrador");
        }

        if (cancelled) {
          return;
        }

        applyDraftPayload(result.data.item);
        const firmaSeguroResult = await requestJson<FirmaSeguroResponse>(
          `/api/creditos/borradores/${result.data.item.id}/firma-seguro`
        ).catch(() => null);

        if (
          firmaSeguroResult?.ok &&
          firmaSeguroResult.data?.ok &&
          !cancelled
        ) {
          setFirmaSeguroDraftProcess(firmaSeguroResult.data.process || null);
        }

        setNotice({
          text: "Borrador cargado. Puedes continuar o corregir el proceso del asesor.",
          tone: "emerald",
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setDraftStatus("error");
        setNotice({
          text: error instanceof Error ? error.message : "No se pudo abrir el borrador",
          tone: "red",
        });
      }
    };

    void loadDraft();

    return () => {
      cancelled = true;
    };
  }, [createClientMode, initialDraftId]);

  useEffect(() => {
    if (!createClientMode || simulatorMode || deliveryMode || !draftHasMeaningfulData) {
      return;
    }

    if (applyingDraftRef.current) {
      return;
    }

    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
    }

    draftSaveTimerRef.current = window.setTimeout(() => {
      const saveDraft = async () => {
        try {
          setDraftStatus("saving");
          const result = await requestJson<CreditDraftSingleResponse>(
            "/api/creditos/borradores",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                id: draftId,
                currentStep: wizardStep,
                payload: factoryDraftPayload,
              }),
            }
          );

          if (!result.ok || !result.data?.item) {
            throw new Error(result.data?.error || "No se pudo guardar el borrador");
          }

          setDraftId(result.data.item.id);
          setDraftLastSavedAt(
            result.data.item.updatedAt ? dateTime(result.data.item.updatedAt) : ""
          );
          setDraftStatus("saved");
        } catch {
          setDraftStatus("error");
        }
      };

      void saveDraft();
    }, 1200);

    return () => {
      if (draftSaveTimerRef.current) {
        window.clearTimeout(draftSaveTimerRef.current);
      }
    };
  }, [
    createClientMode,
    deliveryMode,
    draftHasMeaningfulData,
    draftId,
    factoryDraftPayload,
    simulatorMode,
    wizardStep,
  ]);

  const openLookupCredit = (creditId: number) => {
    if (!lookupMode) {
      setSelectedId(creditId);
      return;
    }

    const params = new URLSearchParams();
    const nextSearch = activeSearch || searchTerm.trim();

    if (nextSearch) {
      params.set("search", nextSearch);
    }

    if (deliveryMode) {
      params.set("mode", "delivery");
    }

    params.set("selected", String(creditId));
    const href = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    window.location.assign(href);
  };

  const openLookupDetail = (creditId: number) => {
    if (!lookupMode) {
      setSelectedId(creditId);
      return;
    }

    setSelectedId(creditId);
    setShowSearchResults(false);
    setShowLookupDetail(true);
    focusSelectedCreditPanel();
    focusLookupDetailPanel();
  };

  const contractPreviewNode = (
    <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
        Contrato de financiacion de equipo movil, tratamiento de datos y herramientas tecnologicas
      </p>
      <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
        <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
        <p>NIT: 902052909-4</p>
        <p>Domicilio: Ibague - Tolima</p>

        <div className="mt-5">
          <p className="font-black text-slate-950">
            CONTRATO DE FINANCIACION DE EQUIPO MOVIL, AUTORIZACION DE TRATAMIENTO DE DATOS Y USO DE HERRAMIENTAS TECNOLOGICAS
          </p>
          <p className="mt-2">Entre los suscritos a saber:</p>
          <p className="mt-3">
            <span className="font-semibold text-slate-950">EL ACREEDOR:</span> FINSER PAY S.A.S.
          </p>
          <p>
            <span className="font-semibold text-slate-950">EL DEUDOR:</span>{" "}
            {clienteNombre || "{{NOMBRE_CLIENTE}}"}, identificado con {clienteTipoDocumentoLabel} No.{" "}
            {clienteDocumento || "{{NUMERO_DOCUMENTO}}"}
          </p>
          <p className="mt-3">
            Se celebra el presente contrato de financiacion, el cual se regira por las siguientes clausulas:
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">1. OBJETO</p>
          <p className="mt-2">
            El ACREEDOR financia al DEUDOR la adquisicion del equipo movil descrito a continuacion:
          </p>
          <p className="mt-2">Equipo: {referenciaEquipo || "{{EQUIPO}}"}</p>
          <p>IMEI: {imei || "{{IMEI}}"}</p>
          <p>Valor total: {currency(valorTotalEquipoNumero)}</p>
          <p>Cuota inicial: {currency(cuotaInicialNumero)}</p>
          <p>Valor financiado: {currency(financialPlan.saldoBaseFinanciado)}</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">2. CONDICIONES DEL CREDITO</p>
          <p className="mt-2">El DEUDOR se obliga a pagar:</p>
          <p className="mt-2">Total a pagar: {currency(saldoFinanciado)}</p>
          <p>Numero de cuotas: {plazoMesesNumero || "{{NUM_CUOTAS}}"}</p>
          <p>Frecuencia de pago: {frecuenciaPagoLabel}</p>
          <p>Valor por cuota: {currency(valorCuota)}</p>
          <p>Fecha primer pago: {fechaPrimerPagoLabel}</p>
          <p className="mt-2">El incumplimiento de una o mas cuotas dara lugar a:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Exigibilidad inmediata de la obligacion</li>
            <li>Cobro de intereses de mora conforme a la ley</li>
            <li>Gastos de cobranza</li>
          </ul>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">3. NATURALEZA DEL CONTRATO</p>
          <p className="mt-2">
            El presente contrato es de caracter comercial y privado, no constituye actividad financiera vigilada por la Superintendencia Financiera, sino una financiacion directa entre particulares.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">4. AUTORIZACION DE TRATAMIENTO DE DATOS</p>
          <p className="mt-2">
            El DEUDOR autoriza de manera libre, previa, expresa e informada a FINSER PAY S.A.S. para:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Consultar, reportar y actualizar informacion en centrales de riesgo</li>
            <li>Verificar identidad y comportamiento crediticio</li>
            <li>Usar sus datos para gestion de cobro</li>
          </ul>
          <p className="mt-2">En cumplimiento de la Ley 1581 de 2012 y normas concordantes.</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">5. AUTORIZACION DE HERRAMIENTAS TECNOLOGICAS</p>
          <p className="mt-2">
            El DEUDOR declara conocer y aceptar que el equipo financiado podra contar con herramientas tecnologicas de gestion, tales como:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Restricciones de uso</li>
            <li>Configuraciones de seguridad</li>
            <li>Limitaciones operativas en caso de incumplimiento</li>
          </ul>
          <p className="mt-2">
            Estas herramientas son aceptadas como mecanismo de gestion del riesgo y garantia del credito, y no constituyen sancion, coaccion ni vulneracion de derechos fundamentales.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">6. DECLARACIONES DEL DEUDOR</p>
          <p className="mt-2">El DEUDOR manifiesta que:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Ha leido y comprendido el contrato</li>
            <li>Acepta voluntariamente las condiciones</li>
            <li>Recibe el equipo en perfecto estado</li>
            <li>La informacion suministrada es veraz</li>
          </ul>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">7. MERITO EJECUTIVO</p>
          <p className="mt-2">
            El presente contrato presta merito ejecutivo conforme a la ley, junto con el pagare suscrito.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">8. FIRMA ELECTRONICA</p>
          <p className="mt-2">El DEUDOR acepta que la firma realizada mediante:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Registro de IP</li>
            <li>Correo electronico</li>
            <li>Evidencia fotografica</li>
          </ul>
          <p className="mt-2">constituye firma valida conforme a la Ley 527 de 1999.</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">9. JURISDICCION</p>
          <p className="mt-2">
            Para todos los efectos legales, las partes fijan como domicilio la ciudad de Ibague - Tolima.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">10. ACEPTACION</p>
          <p className="mt-2">
          El presente contrato se entiende aceptado electronicamente por el DEUDOR en la fecha {documentDateTimeLabel}, quedando registro digital verificable.
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
          <p>NIT: 902052909-4</p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">EL DEUDOR</p>
          <p>{clienteNombre || "{{NOMBRE_CLIENTE}}"}</p>
          <p>
            {clienteTipoDocumentoLabel} {clienteDocumento || "{{NUMERO_DOCUMENTO}}"}
          </p>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">EVIDENCIA FOTOGRAFICA</p>
          <div className="mt-3 rounded-[20px] border border-dashed border-[#d8c9b1] bg-[#fcfaf6] p-3">
            {contratoFotoDataUrl ? (
              <img
                src={contratoFotoDataUrl}
                alt="Foto del cliente"
                className="h-40 w-full rounded-[16px] object-cover"
              />
            ) : (
              <div className="flex h-40 items-center justify-center rounded-[16px] bg-white text-sm text-slate-500">
                [ FOTO DEL CLIENTE ]
              </div>
            )}
          </div>
        </div>

        <div className="mt-5">
          <p className="font-black text-slate-950">FIRMA DIGITAL</p>
          <div className="mt-3 rounded-[20px] border border-dashed border-[#d8c9b1] bg-[#fcfaf6] p-3">
            {contratoFirmaDataUrl ? (
              <img
                src={contratoFirmaDataUrl}
                alt="Firma digital"
                className="h-24 w-full rounded-[16px] object-contain"
              />
            ) : (
              <div className="flex h-24 items-center justify-center rounded-[16px] bg-white text-sm text-slate-500">
                {"{{firma_digital}}"}
              </div>
            )}
          </div>
          <p className="mt-3">Nombre: {clienteNombre || "{{NOMBRE_CLIENTE}}"}</p>
          <p>
            {clienteTipoDocumentoLabel} {clienteDocumento || "{{NUMERO_DOCUMENTO}}"}
          </p>
          <p>Fecha: {documentDateTimeLabel}</p>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={[
        "fp-shell min-h-screen px-4 py-6 text-slate-950",
        paymentsView ? "" : clientLookupMode ? "fp-client-lookup" : "fp-seller-app",
      ].join(" ")}
    >
      <div
        className={
          paymentsView
            ? "mx-auto max-w-[1180px]"
            : clientLookupMode
              ? "mx-auto max-w-[1060px]"
              : "mx-auto max-w-7xl"
        }
      >
        {paymentsView ? (
          <section className="overflow-hidden rounded-[28px] border border-[#cfe0dc] bg-[#123331] p-5 text-white shadow-[0_20px_50px_rgba(15,23,42,0.14)]">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <FinserBrand dark />
                <div className="mt-5 inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.2em] text-[#a7f3d0]">
                  Abonos y recaudo
                </div>
                <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                  Recaudar cuotas
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/72">
                  Busca el cliente, confirma el credito y recibe el pago desde la sede donde se presente.
                </p>
              </div>

              <div className="flex flex-col gap-3 lg:items-end">
                <Link
                  href="/dashboard"
                  className="inline-flex min-w-[170px] justify-center rounded-[16px] border border-white/15 bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-50"
                >
                  Volver al dashboard
                </Link>
                <div className="grid gap-2 text-[11px] font-black uppercase tracking-[0.16em] text-white/74 sm:grid-cols-3 lg:grid-cols-1">
                  <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1">
                    {initialSession.sedeNombre}
                  </span>
                  <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1">
                    {canAdmin ? "Admin" : "Supervisor"}
                  </span>
                  <span className="rounded-full border border-[#34d399]/30 bg-[#064e3b]/40 px-3 py-1 text-[#bbf7d0]">
                    Recaudo entre sedes
                  </span>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section
            className={
              clientLookupMode
                ? "fp-client-lookup-hero"
                : [
                    "fp-seller-hero rounded-[24px] border border-[#d9e6ea] bg-white px-5 py-5 shadow-sm sm:px-6",
                    simulatorMode || deliveryMode ? "fp-tool-hero" : "",
                  ].join(" ")
            }
          >
            {simulatorMode || deliveryMode ? (
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                  <FinserBrand compact showTagline={false} />
                  <div className="hidden h-10 w-px bg-[#e8decb] sm:block" />
                  <div>
                    <div className="inline-flex rounded-full border border-[#e6d6bd] bg-[#faf7ef] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7a5c20]">
                      {deliveryMode ? "Entrega" : "Simulador"}
                    </div>
                    <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
                      {deliveryMode ? "Validar entrega" : "Calcula cuotas"}
                    </h1>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {initialSession.sedeNombre}
                  </span>
                  <Link
                    href="/dashboard"
                    className="inline-flex justify-center rounded-[16px] border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    Volver
                  </Link>
                </div>
              </div>
            ) : clientLookupMode ? (
              <div className="space-y-8">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <FinserBrand compact showTagline={false} />

                  <div className="flex flex-col gap-2 sm:items-end">
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href="/dashboard"
                        className="inline-flex justify-center rounded-full border border-slate-300 bg-white/86 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                      >
                        Dashboard
                      </Link>
                      <Link
                        href="/dashboard/abonos"
                        className="inline-flex justify-center rounded-full border border-[#d7c79d] bg-white/86 px-4 py-2 text-sm font-semibold text-[#6f551f] transition hover:border-slate-950 hover:bg-white hover:text-slate-950"
                      >
                        Ir a abonos
                      </Link>
                    </div>
                    <p className="text-xs font-semibold text-slate-500 sm:text-right">
                      {initialSession.sedeNombre} | {initialSession.rolNombre} | {accessProfileLabel}
                      {initialSeller ? ` | ${initialSeller.nombre}` : ""}
                    </p>
                  </div>
                </div>

                <div className="max-w-3xl">
                  <p className="text-sm font-black uppercase tracking-[0.18em] text-[#8a6a24]">
                    Clientes y expedientes
                  </p>
                  <h1 className="mt-3 max-w-2xl text-4xl font-black leading-[1.02] tracking-normal text-slate-950 sm:text-5xl">
                    Buscar cliente
                  </h1>
                  <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
                    Ubica al cliente, confirma el credito activo y abre su expediente sin entrar al flujo de venta.
                  </p>
                </div>
              </div>
            ) : (
              <div
                className={
                  lookupMode
                    ? "flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
                    : "flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between"
                }
              >
                <div className={lookupMode || createClientMode ? "max-w-2xl" : "max-w-3xl"}>
                  <FinserBrand
                    compact={lookupMode || createClientMode}
                    showTagline={!lookupMode && !createClientMode}
                  />
                  {!lookupMode && !createClientMode ? (
                    <div className="mt-4 inline-flex rounded-full border border-[#c7dbe0] bg-[#f7fbfa] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#145a5a]">
                      {heroEyebrow}
                    </div>
                  ) : null}
                  <h1
                    className={
                      lookupMode
                        ? "mt-3 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl"
                        : createClientMode
                          ? "mt-3 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl"
                          : "mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl"
                    }
                  >
                    {heroTitle}
                  </h1>
                  <p
                    className={
                      lookupMode || createClientMode
                        ? "mt-1 max-w-xl text-xs font-semibold leading-5 text-slate-500"
                        : "mt-2 max-w-2xl text-sm leading-6 text-slate-600"
                    }
                  >
                    {heroDescription}
                  </p>
                </div>

                <div className="flex flex-col gap-3 lg:items-end">
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href="/dashboard"
                      className={lookupMode ? "inline-flex justify-center rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50" : "inline-flex min-w-[160px] justify-center rounded-[16px] border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"}
                    >
                      {lookupMode || createClientMode ? "Dashboard" : "Volver al dashboard"}
                    </Link>
                    {canViewSavedCredits && !lookupMode && !createClientMode ? (
                        <Link
                          href="/dashboard/integraciones"
                          className="inline-flex min-w-[160px] justify-center rounded-[16px] border border-[#c7dbe0] bg-[#f7fbfa] px-4 py-2.5 text-sm font-semibold text-[#145a5a] transition hover:bg-[#eef8f6]"
                        >
                          Ver integraciones
                        </Link>
                    ) : null}
                    {canViewSavedCredits && (
                        <Link
                          href={
                            paymentsView
                              ? "/dashboard/creditos?mode=create-client"
                              : lookupMode
                                ? "/dashboard/abonos"
                                : "/dashboard/abonos"
                          }
                          className={lookupMode ? "inline-flex justify-center rounded-[14px] border border-[#c7dbe0] bg-[#f7fbfa] px-4 py-2 text-sm font-semibold text-[#145a5a] transition hover:bg-[#eef8f6]" : "inline-flex min-w-[160px] justify-center rounded-[16px] border border-[#c7dbe0] bg-[#f7fbfa] px-4 py-2.5 text-sm font-semibold text-[#145a5a] transition hover:bg-[#eef8f6]"}
                        >
                          {paymentsView ? "Crear cliente" : createClientMode ? "Abonos" : "Ir a abonos"}
                        </Link>
                    )}
                    {adminFactoryAssistAvailable ? (
                      <button
                        type="button"
                        onClick={() => {
                          setShowAdminAssist((value) => !value);
                          if (showAdminAssist) {
                            setDraftSearchResults([]);
                            setCredits([]);
                            setActiveSearch("");
                            setSelectedId(null);
                          }
                        }}
                        aria-expanded={showAdminAssist}
                        className={[
                          "inline-flex min-w-[160px] justify-center rounded-[16px] border px-4 py-2.5 text-sm font-semibold transition",
                          showAdminAssist
                            ? "border-[#145a5a] bg-[#123f3e] text-white hover:bg-[#0f3433]"
                            : "border-[#c7dbe0] bg-white text-[#145a5a] hover:bg-[#eef8f6]",
                        ].join(" ")}
                      >
                        {showAdminAssist ? "Cerrar asistencia" : "Asistencia"}
                      </button>
                    ) : null}
                  </div>

                  {lookupMode ? (
                    <p className="max-w-xl text-xs font-semibold text-slate-500 lg:text-right">
                      {initialSession.sedeNombre} | {initialSession.rolNombre} | {accessProfileLabel}
                      {initialSeller ? ` | ${initialSeller.nombre}` : ""}
                    </p>
                  ) : createClientMode ? null : (
                  <div className="flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                      {initialSession.sedeNombre}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                      {initialSession.rolNombre}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                      {accessProfileLabel}
                    </span>
                    {initialSeller ? (
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                        {initialSeller.nombre}
                      </span>
                    ) : null}
                  </div>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {notice && (
          <div
            className={[
              "mt-6 rounded-[24px] border px-5 py-4 text-sm font-medium shadow-sm",
              noticeClasses(notice.tone),
            ].join(" ")}
          >
            {notice.text}
          </div>
        )}

        {showCompactSearchSection && (
        <section
          className={
            paymentsView
              ? "mt-5 overflow-hidden rounded-[28px] border border-[#cfe0dc] bg-white p-5 shadow-[0_18px_44px_rgba(15,23,42,0.08)]"
              : deliveryMode
                ? "fp-surface mt-6 rounded-[28px] p-5"
              : clientLookupMode
                ? "fp-client-lookup-search"
              : adminFactoryAssistMode
                ? "fp-surface mt-4 rounded-[24px] p-4"
                : "fp-surface mt-6 rounded-[28px] p-6"
          }
        >
          {!clientLookupMode ? (
            <div
              className={[
                "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]",
                paymentsView ? "border-emerald-200 bg-emerald-50 text-[#116b61]" : "fp-kicker",
              ].join(" ")}
            >
              {deliveryMode
                ? "Validar entrega"
                : adminFactoryAssistMode
                  ? "Asistencia admin"
                  : "Buscar cliente"}
            </div>
          ) : null}
          <h2
            className={[
              "font-black tracking-tight text-slate-950",
              paymentsView
                ? "mt-3 text-2xl"
                : clientLookupMode
                  ? "text-sm uppercase tracking-[0.16em] text-[#8a6a24]"
                  : adminFactoryAssistMode
                    ? "mt-3 text-xl"
                    : "mt-4 text-3xl",
            ].join(" ")}
          >
            {paymentsView
              ? "Buscar credito"
              : deliveryMode
                ? "Busca el credito"
                : adminFactoryAssistMode
                  ? "Buscar caso"
                : clientLookupMode
                  ? "Buscar expediente"
                : "Encuentra al cliente y su credito"}
          </h2>
          {adminFactoryAssistMode ? null : (
            <p
              className={[
                "max-w-3xl text-sm leading-6 text-slate-600",
                paymentsView || clientLookupMode ? "mt-1" : "mt-3",
              ].join(" ")}
            >
              {paymentsView
                ? "Cedula, telefono, folio o IMEI."
                : deliveryMode
                  ? "Ingresa cedula o IMEI para saber si el equipo se puede entregar."
                  : searchDescription}
            </p>
          )}

          <div
            className={
              deliveryMode
                ? "mt-5 flex flex-col gap-3 lg:flex-row"
                : clientLookupMode
                  ? "fp-client-lookup-command mt-4 flex flex-col gap-2 lg:flex-row"
                : adminFactoryAssistMode
                  ? "mt-4 flex flex-col gap-3 lg:flex-row"
                  : "mt-6 flex flex-col gap-3 lg:flex-row"
            }
          >
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void searchCredits();
                }
              }}
              placeholder={
                deliveryMode || adminFactoryAssistMode
                  ? "Cedula o IMEI"
                  : paymentsView
                    ? "Cedula, telefono, folio o IMEI"
                    : "Cedula, telefono, nombre, folio o IMEI"
              }
               className={[
                 "flex-1 border bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100",
                 paymentsView ? "rounded-[20px] border-slate-200 shadow-inner" : clientLookupMode ? "rounded-[18px] border-transparent bg-transparent focus:border-transparent focus:ring-0" : "rounded-[18px] border-emerald-950/14",
               ].join(" ")}
            />

            <button
              type="button"
              onClick={() => void searchCredits()}
              disabled={loadingList || loadingDrafts}
              className={clientLookupMode ? "rounded-[16px] bg-[#111318] px-6 py-3 text-sm font-black text-white transition hover:bg-[#2a2d33] disabled:opacity-70" : "fp-action rounded-[18px] px-5 py-3 text-sm font-semibold text-white transition hover:scale-[1.01] disabled:opacity-70"}
            >
              {loadingList || loadingDrafts
                ? "Buscando..."
                : deliveryMode
                  ? "Consultar"
                  : adminFactoryAssistMode
                    ? "Buscar caso"
                    : paymentsView
                      ? "Buscar"
                      : "Buscar cliente"}
            </button>

            <button
              type="button"
              onClick={() => void clearSearch()}
              disabled={(loadingList || loadingDrafts) && !activeSearch}
              className={clientLookupMode ? "rounded-[16px] border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-70" : "rounded-[18px] border border-emerald-950/14 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-emerald-50 disabled:opacity-70"}
            >
              {paymentsView ? "Nueva busqueda" : "Limpiar"}
            </button>
          </div>

          {clientLookupMode && activeSearch && !selectedCredit && !loadingList ? (
            <div className="mt-4 border-t border-slate-200 pt-3">
              {!credits.length ? (
                <p className="text-sm text-slate-500">
                  No encontramos clientes o creditos con ese criterio.
                </p>
              ) : (
                <div className="divide-y divide-slate-200">
                  {credits.map((credit) => (
                    <button
                      key={`lookup-inline-${credit.id}`}
                      type="button"
                      onClick={() => openLookupCredit(credit.id)}
                      className="grid w-full gap-2 py-3 text-left transition hover:text-slate-950 md:grid-cols-[1.3fr_1fr_auto] md:items-center"
                    >
                      <span>
                        <span className="block text-sm font-black text-slate-950">
                          {credit.clienteNombre}
                        </span>
                        <span className="mt-0.5 block text-xs font-semibold text-slate-500">
                          {credit.folio} | {credit.clienteDocumento || credit.clienteTelefono || "Sin dato principal"}
                        </span>
                      </span>
                      <span className="text-sm font-semibold text-slate-600">
                        {credit.referenciaEquipo || credit.imei || "Sin equipo"}
                      </span>
                      <span className="text-sm font-black text-slate-950">
                        {currency(credit.saldoPendiente)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {paymentsView ? (
            <div className="mt-5 rounded-[22px] border border-slate-200 bg-[#f8fbfa] p-4">
              {activeSearch && credits.length > 1 ? (
                <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-center">
                  <label className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Selecciona el credito
                    <select
                      value={selectedId || ""}
                      onChange={(event) => {
                        const nextId = Number(event.target.value || 0);
                        setSelectedId(Number.isInteger(nextId) && nextId > 0 ? nextId : null);
                        setShowPaymentResults(!(Number.isInteger(nextId) && nextId > 0));
                        setPaymentsTab("pay");
                      }}
                      className="mt-2 block w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold normal-case tracking-normal text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                    >
                      <option value="">Elige el credito a recaudar</option>
                      {credits.map((credit) => (
                        <option key={credit.id} value={credit.id}>
                          {credit.clienteNombre} - {credit.clienteDocumento || credit.clienteTelefono || credit.folio} - {credit.referenciaEquipo || credit.imei} - saldo {currency(credit.saldoPendiente)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="rounded-full border border-emerald-200 bg-white px-3 py-1 text-xs font-bold text-[#116b61]">
                    {credits.length} resultados
                  </span>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    ["1", activeSearch && loadingList ? "Buscando" : "Buscar"],
                    ["2", activeSearch && credits.length === 1 ? "Credito listo" : "Confirmar"],
                    ["3", selectedCredit ? "Recaudar" : "Cobrar"],
                  ].map(([number, label]) => (
                    <div
                      key={number}
                      className="flex items-center gap-3 rounded-[18px] border border-white bg-white px-4 py-3 shadow-sm"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#116b61] text-xs font-black text-white">
                        {number}
                      </span>
                      <span className="text-sm font-black text-slate-800">
                        {activeSearch && !loadingList && !credits.length && number === "2"
                          ? "Sin resultado"
                          : label}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : deliveryMode || clientLookupMode ? null : (
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full border border-[#c7dbe0] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                Alcance: {accessScopeLabel}
              </span>
              <span className="rounded-full border border-[#c7dbe0] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                Resultados: {credits.length + (adminFactoryAssistMode ? draftSearchResults.length : 0)}
              </span>
              {activeSearch && (
                <span className="rounded-full border border-[#c7dbe0] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                  Filtro: {activeSearch}
                </span>
              )}
            </div>
          )}
        </section>
        )}

        <section
          className={
            paymentsView
              ? "hidden"
              : createClientMode
                ? "fp-seller-workbench mt-6"
                : lookupMode
                  ? "mt-6"
                  : simulatorMode
                    ? "fp-seller-workbench mt-6"
                  : "fp-seller-workbench mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]"
          }
        >
          <div
            className={[
              "fp-surface fp-seller-panel rounded-[24px] p-4 sm:p-5",
              lookupMode ? "hidden" : "",
            ].join(" ")}
          >
            <div
              className={[
                "fp-flow-header fp-seller-flow-intro relative overflow-hidden rounded-[24px] border border-[#cfe5e2] bg-white/72 p-4 sm:p-5",
                createClientMode ? "hidden" : "",
              ].join(" ")}
            >
              <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#0f766e]">
                    {simulatorMode ? "Calculo rapido" : "Flujo de venta"}
                  </p>
                  <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                    {simulatorMode ? "Equipo e inicial" : "Venta en curso"}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {simulatorMode
                      ? "Elige modelo, inicial y plazo."
                      : (
                          <>
                            Paso actual: <span className="font-semibold text-slate-950">{activeFactoryStep.label}</span>
                          </>
                        )}
                  </p>
                </div>

                <div
                  className={[
                    "min-w-[260px] rounded-[20px] border border-[#d8e6e5] bg-white/88 px-4 py-3",
                    simulatorMode ? "hidden" : "",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-700">Avance general</p>
                    <p className="text-xl font-black tracking-tight text-slate-950">
                      {factoryProgress}%
                    </p>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="fp-flow-progress h-full rounded-full"
                      style={{ width: `${factoryProgress}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div
              className={
                simulatorMode ? "mt-4" : "mt-4 grid gap-4 xl:grid-cols-[220px_1fr] xl:items-start"
              }
            >
              <aside
                className={[
                  "fp-step-rail rounded-[22px] border border-[#d8e6e5] bg-white/88 p-2.5 shadow-[0_12px_28px_rgba(15,23,42,0.05)]",
                  simulatorMode ? "hidden" : "",
                ].join(" ")}
              >
                {visibleFactorySteps.map((step, stepIndex) => {
                  const active = step.id === activeFactoryStep.id;

                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => {
                        void advanceToStep(step.id);
                      }}
                      className={[
                        "fp-seller-step-button group mb-2 flex w-full items-center gap-3 rounded-[22px] border px-3 py-3 text-left transition last:mb-0",
                        active
                          ? "fp-step-active border-[#145a5a] bg-[#123f3e] text-white"
                          : "border-transparent bg-transparent text-slate-700 hover:border-[#cde2df] hover:bg-[#f5fbfa]",
                      ].join(" ")}
                    >
                      <span
                        className={[
                          "grid h-10 w-10 shrink-0 place-items-center rounded-2xl border text-sm font-black transition",
                          active
                            ? "border-white/25 bg-white/12 text-white"
                            : step.ready
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-white text-slate-500 group-hover:border-[#8fd8cf]",
                        ].join(" ")}
                      >
                        {step.ready ? "OK" : stepIndex + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-black tracking-tight">
                          {step.label}
                        </span>
                        <span
                          className={[
                            "mt-0.5 block text-xs",
                            active ? "text-white/72" : "text-slate-500",
                          ].join(" ")}
                        >
                          {step.detail}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </aside>

              <div>
                <div
                  className={[
                    "fp-active-step-summary mb-4 rounded-[22px] border border-[#d8e6e5] bg-white px-4 py-4 shadow-[0_10px_22px_rgba(15,23,42,0.04)]",
                    createClientMode ? "hidden" : "",
                  ].join(" ")}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#0f766e]">
                        Paso {activeFactoryStepNumber} en curso
                      </p>
                      <p className="mt-1 text-xl font-black tracking-tight text-slate-950">
                        {activeFactoryStep.label}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        {activeFactoryStep.action}
                      </p>
                    </div>
                    <span
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        activeFactoryStep.ready
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {activeFactoryStep.ready ? "Listo" : "En progreso"}
                    </span>
                  </div>
                  <div className="fp-active-step-meter mt-4 rounded-[20px] border border-[#e1efec] bg-[#f8fdfb] px-4 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm font-semibold text-slate-700">
                        Formulario: {activeCompletedCount}/{activeRequirements.length} listo
                      </p>
                      <p className="text-sm font-black text-[#145a5a]">
                        {activeCompletionPercent}%
                      </p>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="fp-form-meter h-full rounded-full transition-all duration-300"
                        style={{ width: `${activeCompletionPercent}%` }}
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {activeMissingRequirements.slice(0, 4).map((item) => (
                        <span
                          key={item.label}
                          className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-700"
                        >
                          Falta {item.label}
                        </span>
                      ))}
                      {activeMissingRequirements.length > 4 && (
                        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                          +{activeMissingRequirements.length - 4} pendientes
                        </span>
                      )}
                      {activeMissingRequirements.length === 0 && (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                          Paso completo
                        </span>
                      )}
                    </div>
                  </div>
                </div>

            <div className="fp-step-stage fp-form-redesign fp-seller-form-card rounded-[24px] border border-[#d6e4e1] bg-white p-5 shadow-[0_12px_28px_rgba(15,23,42,0.05)]">
              {wizardStep === 1 && (
                <div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-2xl font-black uppercase tracking-normal text-slate-950">
                        VALIDACION DE IDENTIDAD
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Escanea el QR. Al aprobarse la identidad se habilita la informacion del cliente.
                      </p>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        veriffApproved
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : veriffValidation?.riskBlocked ||
                              veriffValidation?.status === "DECLINED" ||
                              veriffValidation?.status === "ERROR"
                            ? "border-red-200 bg-red-50 text-red-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {veriffApproved
                        ? "Aprobada"
                        : veriffValidation?.riskBlocked ||
                            veriffValidation?.status === "DECLINED" ||
                            veriffValidation?.status === "ERROR"
                          ? "Revisar"
                          : "Pendiente"}
                    </div>
                  </div>

                  <div className="mt-5 rounded-[22px] border border-teal-200 bg-teal-50/60 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <h4 className="mt-2 text-lg font-black text-slate-950">
                          Escanea el QR con el celular del cliente
                        </h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          {veriffValidation?.riskBlocked
                            ? "Requiere revision."
                            : veriffApproved
                            ? veriffValidation?.identityData
                              ? "Identidad aprobada. Datos copiados al formulario."
                              : "Aprobada sin datos."
                            : veriffValidation?.approved
                              ? "Aprobada sin datos para autocompletar. Reintenta la validacion."
                            : veriffValidation?.technicalApproved &&
                                veriffValidation.trusted === false
                              ? "Aprobacion de prueba."
                              : veriffConfig.configured &&
                                  veriffConfig.decisionsTrusted === false
                                ? "Modo prueba."
                              : veriffValidation?.sessionUrl
                                ? "QR listo. Esperando decision."
                                : "Preparando QR..."}
                        </p>
                      </div>
                      <span
                        className={[
                          "w-fit rounded-2xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em]",
                          veriffApproved
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : veriffValidation?.riskBlocked
                              ? "border-red-200 bg-red-50 text-red-700"
                            : veriffValidation?.status === "DECLINED" ||
                                veriffValidation?.status === "ERROR" ||
                                veriffValidation?.status === "EXPIRED" ||
                                veriffValidation?.status === "ABANDONED"
                              ? "border-red-200 bg-red-50 text-red-700"
                              : veriffConfig.configured
                                ? "border-amber-200 bg-amber-50 text-amber-700"
                                : "border-slate-200 bg-slate-50 text-slate-600",
                        ].join(" ")}
                      >
                        {veriffStatusLabel(veriffValidation)}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-[auto_1fr] lg:items-center">
                      {veriffQrDataUrl ? (
                        <img
                          src={veriffQrDataUrl}
                          alt="QR de validacion de identidad"
                          className="h-64 w-64 rounded-2xl border border-white bg-white p-2 shadow-sm"
                        />
                      ) : (
                        <div className="grid h-64 w-64 place-items-center rounded-2xl border border-dashed border-teal-200 bg-white text-center text-xs font-semibold text-teal-700">
                          {veriffSubmitting ? "Preparando QR..." : "QR de validacion"}
                        </div>
                      )}
                      <div>
                        {veriffRefreshing && !veriffApproved ? (
                          <p className="rounded-2xl border border-teal-200 bg-white px-4 py-3 text-sm font-semibold text-teal-700">
                            Consultando estado...
                          </p>
                        ) : null}
                        {veriffValidation?.sessionUrl ? (
                          <a
                            href={veriffValidation.sessionUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-3 inline-flex rounded-2xl border border-teal-200 bg-white px-4 py-2 text-xs font-semibold text-teal-700 transition hover:bg-teal-50"
                          >
                            Abrir enlace
                          </a>
                        ) : null}
                        {!veriffApproved &&
                        (veriffHasFinalDecision || Boolean(veriffInlineMessage)) ? (
                          <button
                            type="button"
                            onClick={() => {
                              veriffAutoSessionRef.current = true;
                              void validateIdentityWithVeriff();
                            }}
                            disabled={veriffSubmitting || !veriffConfig.configured}
                            className="mt-3 rounded-2xl bg-[#0f172a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                          >
                            {veriffSubmitting ? "Preparando QR..." : "Reintentar validacion"}
                          </button>
                        ) : null}
                        {veriffInlineMessage ? (
                          <p className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold leading-5 text-red-700">
                            {veriffInlineMessage}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {clienteFormUnlocked ? (
                  <div className="mt-5 rounded-[22px] border border-[#dbe8e6] bg-[#f8fbfa] p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-base font-black tracking-tight text-slate-950">
                          Ingresa los datos del cliente
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Todos los campos son obligatorios para preparar contrato, pagare e identidad comercial.
                        </p>
                      </div>
                      {!canAdmin && initialSeller && (
                        <div className="rounded-[18px] border border-[#d6e4e1] bg-white px-4 py-3 text-sm text-slate-600">
                          <p className="font-semibold text-slate-950">Vendedor activo</p>
                          <p className="mt-1">{initialSeller.nombre}</p>
                        </div>
                      )}
                    </div>

                    <div className="mt-6 grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Primer nombre
                        </label>
                        <input
                          value={clientePrimerNombre}
                          onChange={(event) => setClientePrimerNombre(event.target.value)}
                          placeholder="Ejemplo: Carlos"
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Primer apellido
                        </label>
                        <input
                          value={clientePrimerApellido}
                          onChange={(event) => setClientePrimerApellido(event.target.value)}
                          placeholder="Ejemplo: Ochoa"
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Tipo de documento
                        </label>
                        <select
                          value={clienteTipoDocumento}
                          onChange={(event) => setClienteTipoDocumento(event.target.value)}
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        >
                          {DOCUMENT_TYPE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Numero de documento
                        </label>
                        <input
                          value={clienteDocumento}
                          onChange={(event) =>
                            setClienteDocumento(event.target.value.replace(/\D/g, ""))
                          }
                          placeholder="Ejemplo: 1234567890"
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Fecha de expedicion del documento
                        </label>
                        <input
                          type="date"
                          value={clienteFechaExpedicion}
                          onChange={(event) => setClienteFechaExpedicion(event.target.value)}
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Fecha de nacimiento
                        </label>
                        <input
                          type="date"
                          value={clienteFechaNacimiento}
                          onChange={(event) => setClienteFechaNacimiento(event.target.value)}
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Numero de celular con WhatsApp
                        </label>
                        <div className="flex items-center overflow-hidden rounded-2xl border border-[#c3d8dc] bg-white">
                          <span className="border-r border-[#d9e7ea] px-4 py-3 text-base font-semibold text-slate-600">
                            +57
                          </span>
                          <input
                            value={clienteTelefono}
                            onChange={(event) =>
                              setClienteTelefono(event.target.value.replace(/\D/g, ""))
                            }
                            placeholder="3001234567"
                            className="flex-1 px-4 py-3 text-base text-slate-900 outline-none"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Correo electronico
                        </label>
                        <input
                          type="email"
                          value={clienteCorreo}
                          onChange={(event) => setClienteCorreo(event.target.value)}
                          placeholder="Ejemplo: cliente@gmail.com"
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          En que departamento vive el cliente
                        </label>
                        <select
                          value={clienteDepartamento}
                          onChange={(event) => setClienteDepartamento(event.target.value)}
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        >
                          <option value="">Selecciona</option>
                          {DEPARTMENT_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          En que ciudad vive el cliente
                        </label>
                        <select
                          value={clienteCiudad}
                          onChange={(event) => setClienteCiudad(event.target.value)}
                          disabled={!clienteDepartamento}
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2] disabled:bg-slate-50 disabled:text-slate-400"
                        >
                          <option value="">Selecciona</option>
                          {cityOptions.map((city) => (
                            <option key={city} value={city}>
                              {city}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Genero
                        </label>
                        <select
                          value={clienteGenero}
                          onChange={(event) => setClienteGenero(event.target.value)}
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        >
                          <option value="">Selecciona</option>
                          {GENDER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="md:col-span-2">
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Direccion completa
                        </label>
                        <input
                          value={clienteDireccion}
                          onChange={(event) => setClienteDireccion(event.target.value)}
                          placeholder="Barrio, carrera, calle, numero y complemento"
                          className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                        />
                      </div>

                      <div className="md:col-span-2">
                        <div className="rounded-[24px] border border-[#c3d8dc] bg-white/80 p-4">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="text-sm font-black tracking-tight text-slate-950">
                                Referencias familiares obligatorias
                              </p>
                              <p className="text-sm leading-6 text-slate-600">
                                Solicita dos referencias para dejar completo el contrato y la validacion comercial.
                              </p>
                            </div>
                            <span className="inline-flex rounded-full border border-[#d8e7ea] bg-[#f7fcff] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                              2 requeridas
                            </span>
                          </div>

                          <div className="mt-4 grid gap-4 xl:grid-cols-2">
                            <div className="rounded-[22px] border border-[#d9e7ea] bg-[#fbfeff] p-4">
                              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                Referencia familiar 1
                              </p>
                              <div className="mt-3 grid gap-3">
                                <input
                                  value={referenciaFamiliar1Nombre}
                                  onChange={(event) =>
                                    setReferenciaFamiliar1Nombre(event.target.value)
                                  }
                                  placeholder="Nombre completo"
                                  className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                                />
                                <input
                                  value={referenciaFamiliar1Parentesco}
                                  onChange={(event) =>
                                    setReferenciaFamiliar1Parentesco(event.target.value)
                                  }
                                  placeholder="Parentesco"
                                  className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                                />
                                <input
                                  value={referenciaFamiliar1Telefono}
                                  onChange={(event) =>
                                    setReferenciaFamiliar1Telefono(
                                      event.target.value.replace(/\D/g, "")
                                    )
                                  }
                                  placeholder="Telefono"
                                  className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                                />
                              </div>
                            </div>

                            <div className="rounded-[22px] border border-[#d9e7ea] bg-[#fbfeff] p-4">
                              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                Referencia familiar 2
                              </p>
                              <div className="mt-3 grid gap-3">
                                <input
                                  value={referenciaFamiliar2Nombre}
                                  onChange={(event) =>
                                    setReferenciaFamiliar2Nombre(event.target.value)
                                  }
                                  placeholder="Nombre completo"
                                  className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                                />
                                <input
                                  value={referenciaFamiliar2Parentesco}
                                  onChange={(event) =>
                                    setReferenciaFamiliar2Parentesco(event.target.value)
                                  }
                                  placeholder="Parentesco"
                                  className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                                />
                                <input
                                  value={referenciaFamiliar2Telefono}
                                  onChange={(event) =>
                                    setReferenciaFamiliar2Telefono(
                                      event.target.value.replace(/\D/g, "")
                                    )
                                  }
                                  placeholder="Telefono"
                                  className="w-full rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#145a5a] focus:ring-2 focus:ring-[#d6eef2]"
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  ) : (
                    null
                  )}
                </div>
              )}

              {false && wizardStep === 3 && (
                <div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-[#e6d6bd] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a5a21]">
                        Paso 3
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        Contrato y documentos
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Aqui queda el paquete contractual del credito y, por
                        separado, la autorizacion de tratamiento de datos
                        personales como documento independiente.
                      </p>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        stepDocumentosReady
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {stepDocumentosReady ? "Documentos listos" : "Faltan documentos"}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
                    <div className="space-y-4">
                      <EvidenceCaptureCard
                        title="Selfie del cliente"
                        description="Usa la camara del computador o carga una imagen si ese equipo no tiene camara."
                        metaLabel={
                          contratoFotoAudit
                            ? `Capturada: ${evidenceAuditTime(
                                contratoFotoAudit?.capturedAt
                              )} | Origen: ${
                                contratoFotoAudit?.source === "camera"
                                  ? "Camara"
                                  : "Archivo"
                              } | IP: se registra al finalizar`
                            : undefined
                        }
                        value={contratoFotoDataUrl}
                        onOpenCamera={() => setCameraSlot("selfie")}
                        onRemove={() => {
                          setContratoFotoDataUrl("");
                          setContratoFotoAudit(null);
                        }}
                        onFileChange={(event) =>
                          void captureContractPhoto(
                            event,
                            setContratoFotoDataUrl,
                            "Selfie del cliente cargada para el contrato.",
                            setContratoFotoAudit
                          )
                        }
                      />

                      <div className="grid gap-4 md:grid-cols-2">
                        <EvidenceCaptureCard
                          title="Cedula frente"
                          description="Debe quedar legible y centrada."
                          metaLabel={
                            contratoCedulaFrenteAudit
                              ? `Capturada: ${evidenceAuditTime(
                                  contratoCedulaFrenteAudit?.capturedAt
                                )} | Origen: ${
                                  contratoCedulaFrenteAudit?.source === "camera"
                                    ? "Camara"
                                    : "Archivo"
                                } | IP: se registra al finalizar`
                              : undefined
                          }
                          value={contratoCedulaFrenteDataUrl}
                          tone="amber"
                          onOpenCamera={() => setCameraSlot("cedula-frente")}
                          onRemove={() => {
                            setContratoCedulaFrenteDataUrl("");
                            setContratoCedulaFrenteAudit(null);
                          }}
                          onFileChange={(event) =>
                            void captureContractPhoto(
                              event,
                              setContratoCedulaFrenteDataUrl,
                              "Frente de la cedula cargado.",
                              setContratoCedulaFrenteAudit,
                              "document"
                            )
                          }
                        />

                        <EvidenceCaptureCard
                          title="Cedula respaldo"
                          description="Adjunta tambien el reverso del documento."
                          metaLabel={
                            contratoCedulaRespaldoAudit
                              ? `Capturada: ${evidenceAuditTime(
                                  contratoCedulaRespaldoAudit?.capturedAt
                                )} | Origen: ${
                                  contratoCedulaRespaldoAudit?.source === "camera"
                                    ? "Camara"
                                    : "Archivo"
                                } | IP: se registra al finalizar`
                              : undefined
                          }
                          value={contratoCedulaRespaldoDataUrl}
                          tone="amber"
                          onOpenCamera={() => setCameraSlot("cedula-respaldo")}
                          onRemove={() => {
                            setContratoCedulaRespaldoDataUrl("");
                            setContratoCedulaRespaldoAudit(null);
                          }}
                          onFileChange={(event) =>
                            void captureContractPhoto(
                              event,
                              setContratoCedulaRespaldoDataUrl,
                              "Respaldo de la cedula cargado.",
                              setContratoCedulaRespaldoAudit,
                              "document"
                            )
                          }
                        />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="hidden rounded-[24px] border border-[#d9e6ea] bg-[#f8fdff] px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                          OTP por WhatsApp
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Envia un codigo al WhatsApp del cliente usando la API oficial de Meta.
                        </p>

                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="button"
                            onClick={createWhatsAppOtp}
                            disabled={sendingOtp}
                            className="rounded-2xl bg-[#145a5a] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a]"
                          >
                            {sendingOtp ? "Enviando..." : "Enviar OTP por WhatsApp"}
                          </button>

                          {otpReady && (
                            <span className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
                              OTP validado
                            </span>
                          )}
                        </div>

                        {otpCodeGenerated && (
                          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
                            <input
                              value={otpCodeTyped}
                              onChange={(event) => setOtpCodeTyped(event.target.value)}
                              placeholder="Codigo confirmado por el cliente"
                              className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                            />
                            <button
                              type="button"
                              onClick={verifyOtp}
                              className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                            >
                              Validar codigo
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                          Contrato digital vigente
                        </p>
                        <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
                          <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
                          <p>NIT: 902052909-4</p>
                          <p>Domicilio: Ibague - Tolima</p>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">
                              CONTRATO DE FINANCIACION, AUTORIZACION DE CONTROL TECNOLOGICO Y TRATAMIENTO DE DATOS
                            </p>
                            <p className="mt-2">
                              Entre los suscritos a saber, de una parte{" "}
                              <span className="font-semibold">FINSER PAY S.A.S.</span>, en
                              adelante <span className="font-semibold">EL FINANCIADOR</span>, y
                              de la otra:
                            </p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">EL CLIENTE</p>
                            <p>Nombre: {clienteNombre || "{{nombre}}"}</p>
                            <p>Cedula: {clienteDocumento || "{{cedula}}"}</p>
                            <p>Telefono: {clienteTelefono || "{{telefono}}"}</p>
                            <p>Direccion: {clienteDireccion || "{{direccion}}"}</p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">
                              REFERENCIAS FAMILIARES
                            </p>
                            <p className="mt-2">
                              Referencia 1:{" "}
                              {referenciaFamiliar1Nombre || "{{referencia_1_nombre}}"} |{" "}
                              {referenciaFamiliar1Parentesco ||
                                "{{referencia_1_parentesco}}"} |{" "}
                              {referenciaFamiliar1Telefono ||
                                "{{referencia_1_telefono}}"}
                            </p>
                            <p>
                              Referencia 2:{" "}
                              {referenciaFamiliar2Nombre || "{{referencia_2_nombre}}"} |{" "}
                              {referenciaFamiliar2Parentesco ||
                                "{{referencia_2_parentesco}}"} |{" "}
                              {referenciaFamiliar2Telefono ||
                                "{{referencia_2_telefono}}"}
                            </p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">PRIMERA – OBJETO</p>
                            <p className="mt-2">
                              EL FINANCIADOR entrega al CLIENTE, bajo modalidad de financiacion,
                              un dispositivo movil cuyas caracteristicas son:
                            </p>
                            <p className="mt-2">Marca: {equipoMarca || "{{marca}}"}</p>
                            <p>Modelo: {equipoModelo || "{{modelo}}"}</p>
                            <p>IMEI: {imei || "{{imei}}"}</p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">
                              SEGUNDA – VALOR Y CONDICIONES
                            </p>
                            <p className="mt-2">
                              Valor total del equipo: {currency(valorTotalEquipoNumero)}
                            </p>
                            <p>Cuota inicial: {currency(cuotaInicialNumero)}</p>
                            <p>
                              Credito autorizado:{" "}
                              {currency(financialPlan.saldoBaseFinanciado)}
                            </p>
                            <p>Interes estimado: {currency(financialPlan.valorInteres)}</p>
                            <p>Valor total a pagar: {currency(saldoFinanciado)}</p>
                            <p>Numero de cuotas: {plazoMesesNumero || "{{cuotas}}"}</p>
                            <p>Valor de cada cuota: {currency(valorCuota)}</p>
                            <p className="mt-2">
                              El CLIENTE se obliga a pagar en las fechas acordadas.
                            </p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">TERCERA – MORA</p>
                            <ol className="mt-2 list-decimal space-y-1 pl-5">
                              <li>Exigibilidad inmediata de la totalidad de la obligacion.</li>
                              <li>Intereses moratorios a la tasa maxima legal permitida.</li>
                              <li>Inicio de gestion de cobro prejuridico y juridico.</li>
                            </ol>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">
                              CUARTA – AUTORIZACION DE CONTROL DEL DISPOSITIVO
                            </p>
                            <ul className="mt-2 list-disc space-y-1 pl-5">
                              <li>
                                El dispositivo podra ser bloqueado, restringido o limitado en
                                caso de mora.
                              </li>
                              <li>Podran implementarse medidas tecnologicas de control remoto.</li>
                              <li>
                                Dichas medidas permaneceran hasta la normalizacion de la
                                obligacion.
                              </li>
                            </ul>
                            <p className="mt-2">
                              Esta autorizacion constituye aceptacion libre de mecanismos de
                              garantia tecnologica.
                            </p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">
                              QUINTA – PROPIEDAD Y GARANTIA
                            </p>
                            <p className="mt-2">
                              El dispositivo permanecera como garantia de la obligacion hasta el
                              pago total.
                            </p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">
                              SEXTA – AUTORIZACION DE HABEAS DATA
                            </p>
                            <ul className="mt-2 list-disc space-y-1 pl-5">
                              <li>
                                Consultar, reportar, procesar y actualizar informacion en
                                centrales de riesgo.
                              </li>
                              <li>
                                Compartir informacion con entidades aliadas para gestion de
                                cobranza.
                              </li>
                            </ul>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">
                              SEPTIMA – DECLARACIONES DEL CLIENTE
                            </p>
                            <ul className="mt-2 list-disc space-y-1 pl-5">
                              <li>Que la informacion suministrada es veraz.</li>
                              <li>Que recibe el equipo en perfecto estado.</li>
                              <li>
                                Que comprende plenamente las condiciones del contrato.
                              </li>
                            </ul>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">
                              OCTAVA – MERITO EJECUTIVO
                            </p>
                            <p className="mt-2">
                              El presente contrato presta merito ejecutivo y constituye titulo
                              idoneo para exigir judicialmente el pago de la obligacion.
                            </p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">NOVENA – VALIDEZ DIGITAL</p>
                            <p className="mt-2">
                              El presente contrato se firma por medios electronicos, teniendo
                              plena validez juridica conforme a la legislacion colombiana.
                            </p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">DECIMA – PRUEBA</p>
                            <ul className="mt-2 list-disc space-y-1 pl-5">
                              <li>Firma digital</li>
                              <li>Registro fotografico del cliente</li>
                              <li>Datos tecnicos (fecha, hora, IP, dispositivo)</li>
                            </ul>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">EVIDENCIA FOTOGRAFICA</p>
                            <p className="mt-2">
                              Selfie: {contratoFotoDataUrl ? "Lista" : "[ FOTO DEL CLIENTE ]"}
                            </p>
                            <p>
                              Selfie capturada:{" "}
                              {evidenceAuditTime(contratoFotoAudit?.capturedAt)}
                            </p>
                            <p>
                              Cedula frente:{" "}
                              {contratoCedulaFrenteDataUrl ? "Lista" : "Pendiente"}
                            </p>
                            <p>
                              Cedula frente capturada:{" "}
                              {evidenceAuditTime(contratoCedulaFrenteAudit?.capturedAt)}
                            </p>
                            <p>
                              Cedula respaldo:{" "}
                              {contratoCedulaRespaldoDataUrl ? "Lista" : "Pendiente"}
                            </p>
                            <p>
                              Cedula respaldo capturada:{" "}
                              {evidenceAuditTime(contratoCedulaRespaldoAudit?.capturedAt)}
                            </p>
                            <p>IP del proceso: se registra automaticamente al finalizar el credito.</p>
                          </div>

                          <div className="mt-5">
                            <p className="font-black text-slate-950">FIRMA DIGITAL</p>
                            <p className="mt-2">
                              Firma:{" "}
                              {contratoFirmaDataUrl ? "Registrada" : "{{firma_digital}}"}
                            </p>
                            <p>Nombre: {clienteNombre || "{{nombre}}"}</p>
                            <p>Cedula: {clienteDocumento || "{{cedula}}"}</p>
                          <p>Fecha: {documentDateTimeLabel}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 xl:grid-cols-2">
                    {legalDocumentationStepContent}
                  </div>
                </div>
              )}

              {wizardStep === 2 && (
                <div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-[#e6d6bd] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a5a21]">
                        {simulatorMode ? "Simulador" : "Paso 2"}
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        {simulatorMode ? "Equipo y cuotas" : "Equipo y plan financiero"}
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {simulatorMode
                          ? "Selecciona equipo, inicial y plazo."
                          : "Captura el equipo, define la inicial y confirma la cuota que vera el cliente."}
                      </p>
                      <div
                        className={[
                          "mt-3 inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]",
                          simulatorMode ? "hidden" : "",
                          creditDocumentException
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-slate-200 bg-slate-50 text-slate-500",
                        ].join(" ")}
                      >
                        {creditSettingsScopeLabel}
                      </div>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        simulatorMode
                          ? "hidden"
                          : stepEquipoReady
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {simulatorMode
                        ? "Solo consulta"
                        : stepEquipoReady
                          ? "Equipo listo"
                          : "Falta informacion"}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Marca
                        </label>
                        {equipmentBrandOptions.length ? (
                          <select
                            value={equipoMarca}
                            onChange={(event) => {
                              setEquipoMarca(event.target.value);
                              setEquipoModelo("");
                            }}
                            className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                          >
                            <option value="">Selecciona marca</option>
                            {equipmentBrandOptions.map((brand) => (
                              <option key={equipmentCatalogKey(brand)} value={brand}>
                                {brand}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={equipoMarca}
                            onChange={(event) => setEquipoMarca(event.target.value)}
                            placeholder="Primero carga el catalogo"
                            className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                          />
                        )}
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Modelo
                        </label>
                        {equipmentBrandOptions.length ? (
                          <select
                            value={selectedEquipmentCatalogItem?.id || ""}
                            onChange={(event) => {
                              const selected = equipmentModelOptions.find(
                                (item) => item.id === Number(event.target.value)
                              );

                              if (selected) {
                                applyEquipmentCatalogItem(selected);
                              } else {
                                setEquipoModelo("");
                              }
                            }}
                            disabled={!equipoMarca}
                            className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                          >
                            <option value="">
                              {equipoMarca ? "Selecciona modelo" : "Elige una marca"}
                            </option>
                            {equipmentModelOptions.map((item) => (
                              <option key={item.id} value={item.id}>
                                {canSeeInternalPricing
                                  ? `${item.modelo} - base ${currency(item.precioBaseVenta)}`
                                  : item.modelo}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={equipoModelo}
                            onChange={(event) => setEquipoModelo(event.target.value)}
                            placeholder="Modelo comercial"
                            className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                          />
                        )}
                      </div>

                      <div className={simulatorMode ? "hidden" : ""}>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          IMEI / deviceUid
                        </label>
                        <input
                          value={imei}
                          onChange={(event) =>
                            setImei(event.target.value.replace(/\D/g, "").slice(0, 15))
                          }
                          inputMode="numeric"
                          maxLength={15}
                          placeholder="15 numeros del IMEI"
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                        />
                        <p
                          className={[
                            "mt-2 text-xs font-medium",
                            imeiDigits.length > 0 && !imeiValido
                              ? "text-red-600"
                              : "text-slate-500",
                          ].join(" ")}
                        >
                          {imeiDigits.length > 0
                            ? `${imeiDigits.length}/15 digitos`
                            : "Debe tener exactamente 15 numeros."}
                        </p>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Precio Equipo
                        </label>
                        <input
                          value={currencyInputValue(valorEquipoTotal)}
                          onChange={(event) =>
                            setValorEquipoTotal(event.target.value.replace(/\D/g, ""))
                          }
                          inputMode="numeric"
                          placeholder="$ 850.000"
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                        />
                        {canSeeInternalPricing ? (
                          <p className="mt-2 text-xs font-medium text-slate-500">
                            {precioBaseVentaCatalogo > 0
                              ? `Base del modelo: ${currency(precioBaseVentaCatalogo)}. Excedente a inicial: ${currency(excedentePrecioBase)}.`
                              : `Base maxima sin catalogo: ${currency(MAX_DEVICE_FINANCING_BASE)}.`}
                            {` Inicial base: ${initialPaymentPercentage}%.`}
                          </p>
                        ) : (
                          <p className="mt-2 text-xs font-medium text-slate-500">
                            Ingresa manualmente el valor de venta acordado con el cliente.
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Cuota inicial
                        </label>
                        <input
                          value={currencyInputValue(cuotaInicial)}
                          onChange={(event) =>
                            setCuotaInicial(event.target.value.replace(/\D/g, ""))
                          }
                          onBlur={handleCuotaInicialBlur}
                          inputMode="numeric"
                          placeholder="$ 0"
                          className={[
                            "w-full rounded-2xl border bg-white px-4 py-3 text-base font-semibold text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200",
                            cuotaInicial || !valorTotalEquipoNumero
                              ? cuotaInicialValida || !valorTotalEquipoNumero
                                ? "border-slate-300"
                                : "border-red-300"
                              : "border-slate-300",
                          ].join(" ")}
                        />
                        <p
                          className={[
                            "mt-2 text-xs font-medium",
                            cuotaInicial && !cuotaInicialValida
                              ? "text-red-600"
                              : "text-slate-500",
                          ].join(" ")}
                        >
                          Minimo: {currency(cuotaInicialMinimaNumero)}. Puedes subirla si el cliente da mas.
                        </p>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Numero de cuotas
                        </label>
                        <select
                          value={plazoMeses}
                          onChange={(event) => setPlazoMeses(event.target.value)}
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                        >
                          {creditInstallmentOptions.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Frecuencia
                        </label>
                        <div className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-900">
                          {frecuenciaPagoLabel}
                        </div>
                      </div>

                      <div className="md:col-span-2">
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Primer pago
                        </label>
                        <input
                          type="date"
                          value={fechaPrimerPago}
                          readOnly
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                        />
                        <p className="mt-2 text-xs font-medium text-slate-500">
                          Se calcula automaticamente segun la fecha del credito y frecuencia {frecuenciaPagoLabel.toLowerCase()}.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Equipo
                          </p>
                          <p className="mt-2 text-lg font-black text-slate-950">
                            {referenciaEquipo || "Pendiente"}
                          </p>
                        </div>
                        <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Valor del equipo
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {currency(valorTotalEquipoNumero)}
                          </p>
                        </div>
                        <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Inicial
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {currency(cuotaInicialNumero)}
                          </p>
                          <p className="mt-1 text-xs font-medium text-slate-500">
                            Minimo {currency(cuotaInicialMinimaNumero)}.
                          </p>
                        </div>
                        <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Valor credito
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {currency(saldoBaseFinanciado)}
                          </p>
                          <p className="mt-1 text-xs font-medium text-slate-500">
                            Valor equipo - inicial.
                          </p>
                        </div>
                        <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Plazo
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {plazoMesesNumero || 0}
                          </p>
                          <p className="mt-1 text-xs font-medium text-slate-500">
                            cuotas
                          </p>
                        </div>
                        {canSeeInternalPricing ? (
                          <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Total a pagar
                            </p>
                            <p className="mt-2 text-xl font-black text-slate-950">
                              {currency(saldoFinanciado)}
                            </p>
                            <p className="mt-1 text-xs font-medium text-slate-500">
                              Valor final distribuido en cuotas.
                            </p>
                          </div>
                        ) : null}
                        <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Frecuencia
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {frecuenciaPagoLabel}
                          </p>
                        </div>
                        <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Valor por cuota
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {currency(valorCuota)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {!hideIdentityWizardStep && wizardStep === 3 && (
                <div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-[#e6d6bd] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a5a21]">
                        Paso 3
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        Identidad del cliente
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {veriffIdentityFlowEnabled
                          ? "Aqui validas la identidad con Veriff; si aprueba, no debes capturar cedula ni selfie otra vez."
                          : "Captura selfie y cedula por ambos lados para anexar la evidencia interna."}
                      </p>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        stepContratoReady
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {stepContratoReady
                        ? "Identidad validada"
                        : veriffIdentityFlowEnabled && !veriffApproved
                          ? "Falta Veriff"
                          : "Faltan validaciones"}
                    </div>
                  </div>

                  {!veriffIdentityFlowEnabled ? (
                  <div className="mt-6 rounded-[28px] border border-[#d9e6ea] bg-[#f8fdff] px-5 py-5">
                    <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                      <div className="max-w-2xl">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                          Captura desde celular
                        </p>
                        <h4 className="mt-3 text-xl font-black text-slate-950">
                          Escanea un QR y toma la cédula desde el teléfono
                        </h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Si la cámara del computador no logra leer bien la cédula, genera este QR y abre el flujo móvil. La selfie y la cédula por ambos lados se cargarán automáticamente en esta venta.
                        </p>

                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="button"
                            onClick={() => {
                              void createMobileCaptureSession();
                            }}
                            disabled={creatingMobileCapture}
                            className="rounded-2xl bg-[#0f172a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-70"
                          >
                            {creatingMobileCapture ? "Generando QR..." : mobileCaptureSession ? "Generar QR nuevo" : "Generar QR para celular"}
                          </button>

                          {mobileCaptureSession?.mobileUrl ? (
                            <a
                              href={mobileCaptureSession.mobileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                            >
                              Abrir enlace móvil
                            </a>
                          ) : null}
                        </div>

                        {mobileCaptureSession ? (
                          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {[
                              {
                                label: "Selfie",
                                ready: mobileCaptureSession.evidence.selfieReady,
                              },
                              {
                                label: "Cédula frente",
                                ready: mobileCaptureSession.evidence.cedulaFrenteReady,
                              },
                              {
                                label: "Cédula respaldo",
                                ready: mobileCaptureSession.evidence.cedulaRespaldoReady,
                              },
                            ].map((item) => (
                              <div
                                key={item.label}
                                className={[
                                  "rounded-2xl border px-4 py-3 text-sm font-semibold",
                                  item.ready
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border-amber-200 bg-amber-50 text-amber-700",
                                ].join(" ")}
                              >
                                {item.label}: {item.ready ? "Sincronizado" : "Pendiente"}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      <div className="w-full max-w-[320px] rounded-[24px] border border-[#d6dee8] bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
                        {mobileCaptureQrDataUrl ? (
                          <>
                            <img
                              src={mobileCaptureQrDataUrl}
                              alt="QR para captura móvil"
                              className="mx-auto h-64 w-64 rounded-[20px] border border-slate-200 bg-white object-contain p-2"
                            />
                            <p className="mt-4 text-center text-xs font-medium leading-5 text-slate-500">
                              Escanea este QR desde el celular del cliente o desde el equipo del asesor conectado a la misma red.
                            </p>
                          </>
                        ) : (
                          <div className="flex h-[288px] items-center justify-center rounded-[20px] border border-dashed border-slate-200 bg-[#f8fafc] text-center text-sm leading-6 text-slate-500">
                            Genera el QR para habilitar la captura móvil.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  ) : null}

                  <div
                    className={[
                      "mt-6 grid gap-4",
                      veriffIdentityFlowEnabled
                        ? "xl:grid-cols-1"
                        : "xl:grid-cols-[1.05fr_0.95fr]",
                    ].join(" ")}
                  >
                    {!veriffIdentityFlowEnabled ? (
                    <div className="space-y-4">
                      <EvidenceCaptureCard
                        title="Selfie del cliente"
                        description="Usa la camara del computador o carga una imagen si ese equipo no tiene camara."
                        metaLabel={
                          contratoFotoAudit
                            ? `Capturada: ${evidenceAuditTime(
                                contratoFotoAudit.capturedAt
                              )} | Origen: ${
                                contratoFotoAudit.source === "camera"
                                  ? "Camara"
                                  : "Archivo"
                              } | IP: se registra al finalizar`
                            : undefined
                        }
                        value={contratoFotoDataUrl}
                        onOpenCamera={() => setCameraSlot("selfie")}
                        onRemove={() => {
                          setContratoFotoDataUrl("");
                          setContratoFotoAudit(null);
                        }}
                        onFileChange={(event) =>
                          void captureContractPhoto(
                            event,
                            setContratoFotoDataUrl,
                            "Selfie del cliente cargada para la validacion.",
                            setContratoFotoAudit
                          )
                        }
                      />

                      <div className="grid gap-4 md:grid-cols-2">
                        <EvidenceCaptureCard
                          title="Cedula frente"
                          description="Debe quedar legible y centrada."
                          metaLabel={
                            contratoCedulaFrenteAudit
                              ? `Capturada: ${evidenceAuditTime(
                                  contratoCedulaFrenteAudit.capturedAt
                                )} | Origen: ${
                                  contratoCedulaFrenteAudit.source === "camera"
                                    ? "Camara"
                                    : "Archivo"
                                } | IP: se registra al finalizar`
                              : undefined
                          }
                          value={contratoCedulaFrenteDataUrl}
                          tone="amber"
                          onOpenCamera={() => setCameraSlot("cedula-frente")}
                          onRemove={() => {
                            setContratoCedulaFrenteDataUrl("");
                            setContratoCedulaFrenteAudit(null);
                          }}
                          onFileChange={(event) =>
                            void captureContractPhoto(
                              event,
                              setContratoCedulaFrenteDataUrl,
                              "Frente de la cedula cargado.",
                              setContratoCedulaFrenteAudit,
                              "document"
                            )
                          }
                        />

                        <EvidenceCaptureCard
                          title="Cedula respaldo"
                          description="Adjunta tambien el reverso del documento."
                          metaLabel={
                            contratoCedulaRespaldoAudit
                              ? `Capturada: ${evidenceAuditTime(
                                  contratoCedulaRespaldoAudit.capturedAt
                                )} | Origen: ${
                                  contratoCedulaRespaldoAudit.source === "camera"
                                    ? "Camara"
                                    : "Archivo"
                                } | IP: se registra al finalizar`
                              : undefined
                          }
                          value={contratoCedulaRespaldoDataUrl}
                          tone="amber"
                          onOpenCamera={() => setCameraSlot("cedula-respaldo")}
                          onRemove={() => {
                            setContratoCedulaRespaldoDataUrl("");
                            setContratoCedulaRespaldoAudit(null);
                          }}
                          onFileChange={(event) =>
                            void captureContractPhoto(
                              event,
                              setContratoCedulaRespaldoDataUrl,
                              "Respaldo de la cedula cargado.",
                              setContratoCedulaRespaldoAudit,
                              "document"
                            )
                          }
                        />
                      </div>

                    </div>
                    ) : null}

                    <div
                      className={
                        veriffIdentityFlowEnabled
                          ? "grid gap-4 xl:grid-cols-[1.15fr_0.85fr] xl:items-start"
                          : "space-y-4"
                      }
                    >
                      <div className="hidden rounded-[24px] border border-[#d9e6ea] bg-[#f8fdff] px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                          OTP por WhatsApp
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Envia un codigo al WhatsApp del cliente usando la API oficial de Meta.
                        </p>

                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="button"
                            onClick={createWhatsAppOtp}
                            disabled={sendingOtp}
                            className="rounded-2xl bg-[#145a5a] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a]"
                          >
                            {sendingOtp ? "Enviando..." : "Enviar OTP por WhatsApp"}
                          </button>

                          {otpReady && (
                            <span className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
                              OTP validado
                            </span>
                          )}
                        </div>

                        {otpCodeGenerated && (
                          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
                            <input
                              value={otpCodeTyped}
                              onChange={(event) => setOtpCodeTyped(event.target.value)}
                              placeholder="Codigo confirmado por el cliente"
                              className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                            />
                            <button
                              type="button"
                              onClick={verifyOtp}
                              className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                            >
                              Validar codigo
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="rounded-[24px] border border-[#d9e7ea] bg-white px-5 py-5 shadow-[0_14px_34px_rgba(15,23,42,0.05)]">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Veriff
                            </p>
                          <h4 className="mt-2 text-lg font-black text-slate-950">
                              QR de validacion Veriff
                            </h4>
                            <p className="mt-2 text-sm leading-6 text-slate-600">
                              {veriffValidation?.riskBlocked
                                ? "Requiere revision por riesgo."
                                : veriffConfig.configured
                                ? veriffConfig.decisionsTrusted === false
                                  ? "Modo prueba: genera un QR para validar el flujo; no confirma identidad real."
                                  : veriffRequired
                                    ? "Disponible despues de la aprobacion crediticia; requerida para finalizar."
                                    : "Genera un QR para que Veriff capture y valide la identidad."
                                : "Pendiente configurar variables de entorno."}
                            </p>
                            {veriffConfig.configured ? (
                              <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                Entorno: {veriffConfig.environment || "-"} · API key:{" "}
                                {veriffConfig.apiKeyHint || "-"}
                              </p>
                            ) : null}
                          </div>
                          <span
                            className={[
                              "rounded-2xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em]",
                              veriffApproved
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : veriffValidation?.riskBlocked
                                  ? "border-red-200 bg-red-50 text-red-700"
                                  : veriffValidation?.status === "DECLINED" ||
                                      veriffValidation?.status === "ERROR" ||
                                      veriffValidation?.status === "EXPIRED" ||
                                      veriffValidation?.status === "ABANDONED"
                                  ? "border-red-200 bg-red-50 text-red-700"
                                  : veriffConfig.configured
                                    ? "border-amber-200 bg-amber-50 text-amber-700"
                                    : "border-slate-200 bg-slate-50 text-slate-600",
                            ].join(" ")}
                          >
                            {veriffStatusLabel(veriffValidation)}
                          </span>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <button
                            type="button"
                            onClick={() => void validateIdentityWithVeriff()}
                            disabled={
                              veriffSubmitting ||
                              !veriffConfig.configured
                            }
                            className="rounded-2xl bg-[#0f172a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                          >
                            {veriffSubmitting
                              ? "Generando QR..."
                              : veriffValidation
                                ? "Generar nuevo QR"
                                : "Generar QR Veriff"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void refreshVeriffValidation()}
                            disabled={veriffRefreshing || !veriffValidation?.id}
                            className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                          >
                            {veriffRefreshing ? "Consultando..." : "Actualizar estado"}
                          </button>
                        </div>

                        {veriffValidation ? (
                          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
                            {veriffQrDataUrl ? (
                              <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center">
                                <img
                                  src={veriffQrDataUrl}
                                  alt="QR Veriff"
                                  className="h-64 w-64 rounded-2xl border border-white bg-white p-2 shadow-sm"
                                />
                                <div className="space-y-2 text-sm leading-6 text-slate-600">
                                  <p className="font-semibold text-slate-900">
                                    Escanea este QR para hacer la validacion en Veriff.
                                  </p>
                                  {veriffValidation.sessionUrl ? (
                                    <a
                                      href={veriffValidation.sessionUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex rounded-2xl border border-teal-200 bg-white px-4 py-2 text-xs font-semibold text-teal-700 transition hover:bg-teal-50"
                                    >
                                      Abrir enlace Veriff
                                    </a>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
                            <p>
                              Sesion:{" "}
                              <span className="font-semibold text-slate-900">
                                {veriffValidation.veriffSessionId || "-"}
                              </span>
                            </p>
                            <p>
                              Ultima revision:{" "}
                              {dateTime(
                                veriffValidation.decidedAt ||
                                  veriffValidation.updatedAt ||
                                  veriffValidation.submittedAt
                              )}
                            </p>
                            {veriffValidation.reason || veriffValidation.lastError ? (
                              <p>
                                Detalle:{" "}
                                {veriffValidation.reason ||
                                  veriffValidation.lastError}
                              </p>
                            ) : null}
                            {veriffValidation.riskBlocked ? (
                              <p className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 font-semibold text-red-700">
                                Riesgo:{" "}
                                {veriffValidation.riskSignals?.riskLabels
                                  ?.map((item) => item.label)
                                  .filter(Boolean)
                                  .join(", ") ||
                                  veriffValidation.riskSignals?.reasons?.join(", ") ||
                                  "senal de riesgo"}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      {veriffIdentityFlowEnabled ? (
                        <div className="rounded-[24px] border border-[#d9e7ea] bg-white px-5 py-5 shadow-[0_14px_34px_rgba(15,23,42,0.05)]">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                Evidencia Veriff
                              </p>
                              <h4 className="mt-2 text-lg font-black text-slate-950">
                                Fotos de la validacion
                              </h4>
                            </div>
                            {veriffMediaLoading ? (
                              <span className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">
                                Cargando
                              </span>
                            ) : veriffMediaItems.length ? (
                              <span className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                                {veriffMediaItems.length} archivos
                              </span>
                            ) : (
                              <span className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
                                Sin fotos
                              </span>
                            )}
                          </div>

                          {veriffMediaError ? (
                            <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold leading-6 text-red-700">
                              {veriffMediaError}
                            </p>
                          ) : null}

                          {!veriffMediaLoading &&
                          !veriffMediaError &&
                          !veriffMediaItems.length ? (
                            <p className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-semibold leading-6 text-slate-500">
                              Disponible despues de actualizar una sesion Veriff con media.
                            </p>
                          ) : null}

                          {veriffMediaItems.length ? (
                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                              {veriffMediaItems.map((item) => (
                                <figure
                                  key={item.id}
                                  className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50"
                                >
                                  {item.kind === "video" ? (
                                    <video
                                      controls
                                      src={item.downloadUrl}
                                      className="h-52 w-full bg-black object-contain"
                                    />
                                  ) : (
                                    <img
                                      src={item.downloadUrl}
                                      alt={veriffMediaLabel(item)}
                                      className="h-52 w-full bg-white object-contain"
                                    />
                                  )}
                                  <figcaption className="border-t border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">
                                    {veriffMediaLabel(item)}
                                  </figcaption>
                                </figure>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="rounded-[24px] border border-[#d9e7ea] bg-[#f8fbfd] px-5 py-5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Checklist de identidad
                        </p>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          {(veriffIdentityFlowEnabled
                            ? [
                                {
                                  label: "QR Veriff generado",
                                  ready: Boolean(veriffValidation?.sessionUrl),
                                },
                                {
                                  label: "Aprobacion real Veriff",
                                  ready: veriffApproved,
                                },
                              ]
                            : [
                                {
                                  label: "Selfie interna",
                                  ready: Boolean(contratoFotoDataUrl),
                                },
                                {
                                  label: "Cedula frente",
                                  ready: Boolean(contratoCedulaFrenteDataUrl),
                                },
                                {
                                  label: "Cedula respaldo",
                                  ready: Boolean(contratoCedulaRespaldoDataUrl),
                                },
                              ]).map(({ label, ready }) => (
                            <div
                              key={label}
                              className={[
                                "rounded-2xl border px-4 py-3 text-sm font-semibold",
                                ready
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-amber-200 bg-amber-50 text-amber-700",
                              ].join(" ")}
                            >
                              {label}: {ready ? "OK" : "Pendiente"}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {wizardStep === 4 && (
                <div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-[#e6d6bd] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a5a21]">
                        {hideIdentityWizardStep ? "Paso 3" : "Paso 4"}
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        FirmaSeguro
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Envia un PDF legal consolidado por el canal habilitado en FirmaSeguro.
                      </p>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        firmaSeguroProcessSigned
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {firmaSeguroSubmitting || firmaSeguroRefreshing
                        ? "Enviando"
                        : firmaSeguroProcessSigned
                          ? "Firma exitosa"
                          : firmaSeguroProcessSent
                            ? "Esperando firma"
                            : "Pendiente envio"}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                    <div className="rounded-[24px] border border-emerald-200 bg-[#f2fbf7] px-5 py-5">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0f766e]">
                            FirmaSeguro
                          </p>
                          <h4 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                            Envio digital certificado
                          </h4>
                          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
                            Se creara un expediente de borrador con los documentos legales. El credito solo se inscribe cuando FirmaSeguro reporte firma exitosa y valides la entrega.
                          </p>
                        </div>
                        {firmaSeguroDraftFolio ? (
                          <div
                            className={[
                              "rounded-2xl border bg-white px-4 py-3 text-xs font-semibold",
                              firmaSeguroProcessSigned
                                ? "border-emerald-200 text-emerald-700"
                                : "border-amber-200 text-amber-700",
                            ].join(" ")}
                          >
                            Folio {firmaSeguroDraftFolio}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        {[
                          ["Cliente", clienteNombre || "-"],
                          ["Contacto", clienteCorreo || clienteTelefono || "-"],
                          ["Documento", clienteDocumento || "-"],
                          ["Equipo", referenciaEquipo || "-"],
                          ["IMEI", imei || "-"],
                          ["Valor cuota", currency(valorCuota)],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            className="rounded-2xl border border-emerald-100 bg-white/80 px-4 py-3"
                          >
                            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                              {label}
                            </p>
                            <p className="mt-1 text-sm font-black text-slate-950">
                              {value}
                            </p>
                          </div>
                        ))}
                      </div>

                      <div className="mt-5 grid gap-3 md:grid-cols-3">
                        {[
                          { label: "Cliente", ready: stepClienteReady },
                          { label: "Equipo", ready: stepEquipoReady },
                          ...(!hideIdentityWizardStep
                            ? [{ label: "Identidad", ready: stepContratoReady }]
                            : []),
                        ].map(({ label, ready }) => (
                          <div
                            key={label}
                            className={[
                              "rounded-2xl border px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em]",
                              ready
                                ? "border-emerald-200 bg-white text-emerald-700"
                                : "border-amber-200 bg-amber-50 text-amber-700",
                            ].join(" ")}
                          >
                            {label}: {ready ? "OK" : "Pendiente"}
                          </div>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleFirmaSeguroStepReady()}
                        disabled={
                          !contratoListo ||
                          creating ||
                          firmaSeguroSubmitting
                        }
                        className="mt-5 w-full rounded-2xl bg-[#145a5a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a] disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                      >
                        {creating || firmaSeguroSubmitting
                          ? "Enviando a FirmaSeguro..."
                          : firmaSeguroProcessSent
                            ? "Reenviar FirmaSeguro"
                            : "Enviar a FirmaSeguro"}
                      </button>

                      {firmaSeguroProcessSent ? (
                        <button
                          type="button"
                          onClick={() => void refreshFirmaSeguroDraftProcess()}
                          disabled={firmaSeguroRefreshing || firmaSeguroSubmitting}
                          className="mt-3 w-full rounded-2xl border border-[#cbdedc] bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-[#f4fbfa] disabled:cursor-not-allowed disabled:opacity-70 sm:ml-3 sm:w-auto"
                        >
                          {firmaSeguroRefreshing
                            ? "Actualizando..."
                            : "Actualizar estado"}
                        </button>
                      ) : null}

                      {!contratoListo ? (
                        <p className="mt-3 text-xs font-medium leading-5 text-amber-700">
                          Completa cliente, equipo e identidad para enviar el expediente.
                        </p>
                      ) : firmaSeguroProcessSigned ? (
                        <p className="mt-3 text-xs font-medium leading-5 text-emerald-700">
                          Firma exitosa. Continua al paso 5 para validar la entrega y crear el credito.
                        </p>
                      ) : firmaSeguroProcessSent ? (
                        <p className="mt-3 text-xs font-medium leading-5 text-amber-700">
                          Cuando FirmaSeguro reporte firma exitosa se habilita el paso 5.
                        </p>
                      ) : null}
                    </div>

                    <div className="rounded-[24px] border border-[#d9e7ea] bg-[#f8fbfd] px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                        Paquete documental unico
                      </p>
                      <div className="mt-4 rounded-2xl border border-emerald-200 bg-white px-4 py-4">
                        <p className="text-sm font-black text-slate-950">
                          1 PDF para firmar
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          FirmaSeguro recibira un solo archivo con todos los soportes integrados.
                        </p>
                      </div>
                      <div className="mt-4 space-y-3 text-sm font-semibold text-slate-700">
                        {[
                          "Autorizacion de datos integrada",
                          "Contrato de financiacion integrado",
                          "Pagare integrado",
                          "Carta de instrucciones integrada",
                          "Evidencias del paso 3 integradas",
                        ].map((item) => (
                          <div
                            key={item}
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
                          >
                            {item}
                          </div>
                        ))}
                      </div>
                      <div className="mt-5 rounded-[20px] border border-dashed border-emerald-200 bg-white px-4 py-4 text-sm leading-6 text-slate-600">
                        El cliente firma desde FirmaSeguro. Luego validas la entrega del equipo en el paso 5.
                      </div>
                    </div>
                  </div>

                  <div className="hidden">
                    <div className="space-y-4">
                      <div className="rounded-[24px] border border-[#d9e7ea] bg-[#f8fbfd] px-5 py-5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Evidencia anexada desde identidad
                        </p>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <div className="rounded-[18px] border border-slate-200 bg-white p-3">
                            {contratoFotoDataUrl ? (
                              <img
                                src={contratoFotoDataUrl}
                                alt="Selfie del cliente"
                                className="h-36 w-full rounded-2xl object-cover"
                              />
                            ) : (
                              <div className="flex h-36 items-center justify-center rounded-2xl bg-slate-50 text-sm text-slate-500">
                                Selfie pendiente
                              </div>
                            )}
                            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                              Selfie
                            </p>
                          </div>

                          <div className="rounded-[18px] border border-slate-200 bg-white p-3">
                            {contratoFirmaDataUrl ? (
                              <img
                                src={contratoFirmaDataUrl}
                                alt="Firma digital"
                                className="h-36 w-full rounded-2xl object-contain"
                              />
                            ) : (
                              <div className="flex h-36 items-center justify-center rounded-2xl bg-slate-50 text-sm text-slate-500">
                                Firma pendiente
                              </div>
                            )}
                            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                              Firma
                            </p>
                          </div>

                          <div className="rounded-[18px] border border-slate-200 bg-white p-3">
                            {contratoCedulaFrenteDataUrl ? (
                              <img
                                src={contratoCedulaFrenteDataUrl}
                                alt="Cedula frente"
                                className="h-36 w-full rounded-2xl object-contain"
                              />
                            ) : (
                              <div className="flex h-36 items-center justify-center rounded-2xl bg-slate-50 text-sm text-slate-500">
                                Frente pendiente
                              </div>
                            )}
                            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                              Cedula frente
                            </p>
                          </div>

                          <div className="rounded-[18px] border border-slate-200 bg-white p-3">
                            {contratoCedulaRespaldoDataUrl ? (
                              <img
                                src={contratoCedulaRespaldoDataUrl}
                                alt="Cedula respaldo"
                                className="h-36 w-full rounded-2xl object-contain"
                              />
                            ) : (
                              <div className="flex h-36 items-center justify-center rounded-2xl bg-slate-50 text-sm text-slate-500">
                                Respaldo pendiente
                              </div>
                            )}
                            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                              Cedula respaldo
                            </p>
                          </div>

                        </div>
                      </div>

                      <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Checklist documental
                        </p>
                        <div className="mt-4 space-y-3">
                          {[
                            {
                              id: "contrato-aceptado-step4",
                              checked: contratoAceptado,
                              onChange: setContratoAceptado,
                              label: "Contrato principal aceptado",
                            },
                            {
                              id: "pagare-aceptado-step4",
                              checked: pagareAceptado,
                              onChange: setPagareAceptado,
                              label: "Pagare aceptado",
                            },
                            {
                              id: "carta-aceptada-step4",
                              checked: cartaAceptada,
                              onChange: setCartaAceptada,
                              label: "Carta de instrucciones aceptada",
                            },
                            {
                              id: "datos-aceptados-step4",
                              checked: autorizacionDatosAceptada,
                              onChange: setAutorizacionDatosAceptada,
                              label: "Autorizacion de datos aceptada",
                            },
                          ].map((item) => (
                            <label
                              key={item.id}
                              htmlFor={item.id}
                              className="flex items-start gap-3 rounded-[20px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-3 text-sm leading-6 text-slate-700"
                            >
                              <input
                                id={item.id}
                                type="checkbox"
                                checked={item.checked}
                                onChange={(event) => item.onChange(event.target.checked)}
                                className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-300"
                              />
                              <span>{item.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-[24px] border border-emerald-200 bg-[#f2fbf7] px-5 py-5">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0f766e]">
                              FirmaSeguro
                            </p>
                            <h4 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                              Expediente digital
                            </h4>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleFirmaSeguroStepReady()}
                            disabled={
                              !stepDocumentosReady ||
                              creating ||
                              firmaSeguroSubmitting
                            }
                            className="rounded-2xl bg-[#145a5a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a] disabled:cursor-not-allowed disabled:opacity-70"
                          >
                            {firmaSeguroProcessSent
                              ? "FirmaSeguro enviado"
                              : "Listo, enviar FirmaSeguro"}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      {contractPreviewNode}
                      <div className="grid gap-4">{legalDocumentationStepContent}</div>
                    </div>
                  </div>
                </div>
              )}

              {wizardStep === 5 && (
                <div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-[#e6d6bd] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a5a21]">
                        {hideIdentityWizardStep ? "Paso 4" : "Paso 5"}
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        Validacion del equipo
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {entregaSinVerificacionAutorizada
                          ? "Esta cedula tiene autorizacion administrativa para cerrar la entrega sin validar el dispositivo."
                          : "El cierre queda reservado para validar la entregabilidad del dispositivo con Zero Touch antes de cerrar la entrega."}
                      </p>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        entregaValidada
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {entregaValidada ? "Lista para cierre" : "Pendiente validacion"}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 xl:grid-cols-2">
                    <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Resumen listo para validar
                      </p>
                      <div className="mt-4 space-y-2 text-sm text-slate-700">
                        <p><span className="font-semibold text-slate-950">Cliente:</span> {clienteNombre || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Documento:</span> {clienteDocumento || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Equipo:</span> {referenciaEquipo || "-"}</p>
                        <p><span className="font-semibold text-slate-950">IMEI:</span> {imei || "-"}</p>
                        {canSeeInternalPricing ? (
                          <p><span className="font-semibold text-slate-950">Total financiado:</span> {currency(saldoFinanciado)}</p>
                        ) : null}
                        <p><span className="font-semibold text-slate-950">Valor cuota:</span> {currency(valorCuota)}</p>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#d9e6ea] bg-[#f8fdff] px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                        Validacion de entrega
                      </p>
                      <div className="mt-4 space-y-3 text-sm text-slate-700">
                        <p>
                          Primero inscribe el equipo en Zero Touch. Luego valida la entrega para confirmar si el dispositivo ya permite cerrar el credito.
                        </p>
                        <div
                          className={[
                            "rounded-2xl border px-4 py-4",
                            entregaValidada
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : deliveryValidation
                                ? "border-amber-200 bg-amber-50 text-amber-800"
                                : "border-slate-200 bg-white text-slate-600",
                          ].join(" ")}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                            Estado actual
                          </p>
                          <p className="mt-2 text-xl font-black">
                            {deliveryStatusLabel}
                          </p>
                          <p className="mt-2 leading-6">
                            {deliveryStatusDetail}
                          </p>
                          {deliveryValidation && (
                            <div className="mt-3 space-y-1 text-xs">
                              <p>Estado remoto: {deliveryValidation?.deviceState || "-"}</p>
                              <p>Servicio: {deliveryValidation?.serviceDetails || "-"}</p>
                              <p>
                                Ultima revision: {dateTime(deliveryValidation?.checkedAt ?? null)}
                              </p>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-3">
                          <button
                            type="button"
                            onClick={() => void enrollDeviceBeforeFinalize()}
                            disabled={
                              enrollingDelivery ||
                              validatingDelivery ||
                              entregaSinVerificacionAutorizada
                            }
                            className="rounded-2xl bg-[#145a5a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
                          >
                            {entregaSinVerificacionAutorizada
                              ? "Inscripcion no requerida"
                              : enrollingDelivery
                                ? "Inscribiendo..."
                                : "Inscribir equipo"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void validateDeliveryBeforeFinalize()}
                            disabled={
                              validatingDelivery ||
                              enrollingDelivery ||
                              entregaSinVerificacionAutorizada
                            }
                            className="rounded-2xl border border-[#145a5a]/25 bg-white px-5 py-3 text-sm font-semibold text-[#145a5a] transition hover:bg-[#e9f7f4] disabled:opacity-70"
                          >
                            {entregaSinVerificacionAutorizada
                              ? "Verificacion no requerida"
                              : validatingDelivery
                                ? "Validando..."
                                : "Validar entrega"}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5 xl:col-span-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Flujo de cierre
                      </p>
                      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                        {[
                          { label: "Cliente", ready: stepClienteReady },
                          { label: "Equipo", ready: stepEquipoReady },
                          ...(!hideIdentityWizardStep
                            ? [{ label: "Identidad", ready: stepContratoReady }]
                            : []),
                          { label: "Contratos", ready: stepDocumentosReady },
                          { label: "Entregable", ready: entregaValidada },
                        ].map(({ label, ready }) => (
                          <div
                            key={label}
                            className={[
                              "rounded-2xl border px-4 py-4 text-sm font-semibold",
                              ready
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-amber-200 bg-amber-50 text-amber-700",
                            ].join(" ")}
                          >
                            {label}: {ready ? "OK" : "Pendiente"}
                          </div>
                        ))}
                      </div>

                      {!entregaValidada && !FLEXIBLE_WIZARD_FOR_TESTING && (
                        <div className="mt-5 rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
                          El credito solo se puede finalizar cuando Zero Touch confirme que el equipo esta entregable.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {false && wizardStep === 4 && (
                <div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-[#e6d6bd] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a5a21]">
                        Paso 4
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        Finalizar venta
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        El cierre queda reservado para validar la entregabilidad del dispositivo con Zero Touch antes de crear el credito.
                      </p>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        entregaValidada
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {entregaValidada ? "Lista para cierre" : "Pendiente validacion"}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 xl:grid-cols-2">
                    <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Resumen listo para validar
                      </p>
                      <div className="mt-4 space-y-2 text-sm text-slate-700">
                        <p><span className="font-semibold text-slate-950">Cliente:</span> {clienteNombre || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Documento:</span> {clienteDocumento || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Equipo:</span> {referenciaEquipo || "-"}</p>
                        <p><span className="font-semibold text-slate-950">IMEI:</span> {imei || "-"}</p>
                        {canSeeInternalPricing ? (
                          <p><span className="font-semibold text-slate-950">Total financiado:</span> {currency(saldoFinanciado)}</p>
                        ) : null}
                        <p><span className="font-semibold text-slate-950">Valor cuota:</span> {currency(valorCuota)}</p>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#d9e6ea] bg-[#f8fdff] px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                        Validacion de entrega
                      </p>
                      <div className="mt-4 space-y-3 text-sm text-slate-700">
                        <p>
                          Primero inscribe el equipo en Zero Touch. Luego valida la entrega para confirmar si el dispositivo ya permite cerrar el credito.
                        </p>
                        <div
                          className={[
                            "rounded-2xl border px-4 py-4",
                            entregaValidada
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : deliveryValidation
                                ? "border-amber-200 bg-amber-50 text-amber-800"
                                : "border-slate-200 bg-white text-slate-600",
                          ].join(" ")}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                            Estado actual
                          </p>
                          <p className="mt-2 text-xl font-black">
                            {deliveryStatusLabel}
                          </p>
                          <p className="mt-2 leading-6">
                            {deliveryStatusDetail}
                          </p>
                          {deliveryValidation && (
                            <div className="mt-3 space-y-1 text-xs">
                              <p>Estado remoto: {deliveryValidation?.deviceState || "-"}</p>
                              <p>Servicio: {deliveryValidation?.serviceDetails || "-"}</p>
                              <p>
                                Ultima revision: {dateTime(deliveryValidation?.checkedAt ?? null)}
                              </p>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-3">
                          <button
                            type="button"
                            onClick={() => void enrollDeviceBeforeFinalize()}
                            disabled={
                              enrollingDelivery ||
                              validatingDelivery ||
                              entregaSinVerificacionAutorizada
                            }
                            className="rounded-2xl bg-[#145a5a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
                          >
                            {entregaSinVerificacionAutorizada
                              ? "Inscripcion no requerida"
                              : enrollingDelivery
                                ? "Inscribiendo..."
                                : "Inscribir equipo"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void validateDeliveryBeforeFinalize()}
                            disabled={
                              validatingDelivery ||
                              enrollingDelivery ||
                              entregaSinVerificacionAutorizada
                            }
                            className="rounded-2xl border border-[#145a5a]/25 bg-white px-5 py-3 text-sm font-semibold text-[#145a5a] transition hover:bg-[#e9f7f4] disabled:opacity-70"
                          >
                            {entregaSinVerificacionAutorizada
                              ? "Verificacion no requerida"
                              : validatingDelivery
                                ? "Validando..."
                                : "Validar entrega"}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5 xl:col-span-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Flujo de cierre
                      </p>
                      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        {[
                          { label: "Cliente", ready: stepClienteReady },
                          { label: "Equipo", ready: stepEquipoReady },
                          { label: "Documentos", ready: stepDocumentosReady },
                          { label: "Entregable", ready: entregaValidada },
                        ].map(({ label, ready }) => (
                          <div
                            key={label}
                            className={[
                              "rounded-2xl border px-4 py-4 text-sm font-semibold",
                              ready
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-amber-200 bg-amber-50 text-amber-700",
                            ].join(" ")}
                          >
                            {label}: {ready ? "OK" : "Pendiente"}
                          </div>
                        ))}
                      </div>

                      {!entregaValidada && !FLEXIBLE_WIZARD_FOR_TESTING && (
                        <div className="mt-5 rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
                          El credito solo se puede finalizar cuando Zero Touch confirme que el equipo esta entregable.
                        </div>
                      )}
                    </div>

                    <div className="hidden xl:col-span-2">
                    <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Resumen del cliente
                      </p>
                      <div className="mt-4 space-y-2 text-sm text-slate-700">
                        <p><span className="font-semibold text-slate-950">Nombre:</span> {clienteNombre || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Cedula:</span> {clienteDocumento || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Telefono:</span> {clienteTelefono || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Direccion:</span> {clienteDireccion || "-"}</p>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {canSeeInternalPricing ? "Resumen financiero" : "Resumen comercial"}
                      </p>
                      <div className="mt-4 space-y-2 text-sm text-slate-700">
                        <p><span className="font-semibold text-slate-950">Equipo:</span> {referenciaEquipo || "-"}</p>
                        <p><span className="font-semibold text-slate-950">IMEI:</span> {imei || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Total equipo:</span> {currency(valorTotalEquipoNumero)}</p>
                        <p><span className="font-semibold text-slate-950">Inicial:</span> {currency(cuotaInicialNumero)}</p>
                        {canSeeInternalPricing ? (
                          <p><span className="font-semibold text-slate-950">Total financiado:</span> {currency(saldoFinanciado)}</p>
                        ) : null}
                        <p><span className="font-semibold text-slate-950">Valor cuota:</span> {currency(valorCuota)}</p>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)] xl:col-span-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                        Pagare digital
                      </p>
                      <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
                        <p className="font-black text-slate-950">
                          PAGARE No. {pagarePreviewNumber}
                        </p>
                        <p className="mt-2">
                          Yo, <span className="font-semibold">{clienteNombre || "{{nombre}}"}</span>,
                          mayor de edad, identificado con cedula de ciudadania No.{" "}
                          <span className="font-semibold">
                            {clienteDocumento || "{{cedula}}"}
                          </span>
                          , actuando en nombre propio, me obligo de manera incondicional a
                          pagar a la orden de:
                        </p>

                        <div className="mt-4">
                          <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
                          <p>NIT: 902052909-4</p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">
                            $ {currency(saldoFinanciado).replace("$ ", "")} (PESOS COLOMBIANOS)
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">PRIMERA – FORMA DE PAGO</p>
                          <p className="mt-2">
                            La obligacion sera pagada en {plazoMesesNumero || "{{cuotas}}"} cuotas
                            de {currency(valorCuota)} cada una, con frecuencia {frecuenciaPagoLabel.toLowerCase()},
                            conforme al plan pactado.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">
                            SEGUNDA – VENCIMIENTO ANTICIPADO
                          </p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            <li>Exigibilidad inmediata del total de la deuda.</li>
                            <li>Cobro de intereses moratorios.</li>
                          </ul>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">TERCERA – INTERESES</p>
                          <p className="mt-2">
                            Se causaran intereses de mora a la tasa maxima legal vigente.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">
                            CUARTA – GASTOS DE COBRANZA
                          </p>
                          <p className="mt-2">
                            El deudor asumira todos los gastos derivados de cobro, incluyendo
                            honorarios juridicos.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">QUINTA – AUTORIZACION</p>
                          <p className="mt-2">
                            El deudor autoriza el reporte a centrales de riesgo.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">
                            SEXTA – ESPACIOS EN BLANCO
                          </p>
                          <p className="mt-2">
                            El deudor autoriza expresa e irrevocablemente a FINSER PAY S.A.S.
                            para llenar los espacios en blanco del presente pagare conforme a
                            las condiciones del credito otorgado.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">
                            SEPTIMA – MERITO EJECUTIVO
                          </p>
                          <p className="mt-2">El presente pagare presta merito ejecutivo.</p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">LUGAR Y FECHA</p>
                          <p className="mt-2">
                            Ibague, {documentDateTimeLabel}
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">FIRMA DEL DEUDOR</p>
                          <p className="mt-2">
                            Firma: {contratoFirmaDataUrl ? "Registrada" : "_________________________"}
                          </p>
                          <p>Nombre: {clienteNombre || "{{nombre}}"}</p>
                          <p>Cedula: {clienteDocumento || "{{cedula}}"}</p>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)] xl:col-span-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                        Carta de instrucciones
                      </p>
                      <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
                        <p className="font-black text-slate-950">
                          CARTA DE INSTRUCCIONES PARA DILIGENCIAMIENTO DE PAGARE EN BLANCO
                        </p>
                        <div className="mt-4">
                          <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
                          <p>NIT: 902052909-4</p>
                          <p>Domicilio: Ibague - Tolima</p>
                        </div>

                        <p className="mt-4">
                          Yo, <span className="font-semibold">{clienteNombre || "{{nombre}}"}</span>,
                          identificado con cedula de ciudadania No.{" "}
                          <span className="font-semibold">
                            {clienteDocumento || "{{cedula}}"}
                          </span>
                          , actuando en nombre propio, por medio del presente documento
                          autorizo expresa, previa e irrevocablemente a{" "}
                          <span className="font-semibold">FINSER PAY S.A.S.</span>, para que
                          diligencie el pagare firmado por mi, conforme a las siguientes
                          instrucciones:
                        </p>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">PRIMERA - OBJETO</p>
                          <p className="mt-2">
                            El pagare respalda todas las obligaciones derivadas del contrato de
                            financiacion de equipo movil suscrito con FINSER PAY S.A.S.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">
                            SEGUNDA - DILIGENCIAMIENTO
                          </p>
                          <p className="mt-2">
                            Autorizo a FINSER PAY S.A.S. para llenar los espacios en blanco del
                            pagare, incluyendo pero sin limitarse a:
                          </p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            <li>Valor total de la obligacion</li>
                            <li>Fecha de creacion</li>
                            <li>Fecha de vencimiento</li>
                            <li>Numero de cuotas</li>
                            <li>Intereses</li>
                            <li>Numero del pagare</li>
                          </ul>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">TERCERA - VALOR</p>
                          <p className="mt-2">
                            El valor a diligenciar correspondera al total de la obligacion
                            adquirida, incluyendo capital, intereses corrientes, intereses de
                            mora y gastos de cobranza.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">CUARTA - VENCIMIENTO</p>
                          <p className="mt-2">
                            El pagare podra ser llenado con vencimiento inmediato en caso de
                            incumplimiento en el pago de una o mas cuotas, mora en la
                            obligacion o incumplimiento de cualquiera de las condiciones del
                            contrato.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">QUINTA - EXIGIBILIDAD</p>
                          <p className="mt-2">
                            Autorizo expresamente que, en caso de incumplimiento, el pagare sea
                            exigible de manera inmediata en su totalidad.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">SEXTA - CESION</p>
                          <p className="mt-2">
                            FINSER PAY S.A.S. podra ceder el pagare a terceros sin necesidad de
                            autorizacion adicional del deudor.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">SEPTIMA - COBRO</p>
                          <p className="mt-2">
                            Autorizo el inicio de procesos de cobro prejuridico y cobro
                            juridico, asumiendo todos los costos derivados, incluyendo
                            honorarios de abogados.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">OCTAVA - ACEPTACION</p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            <li>He firmado el pagare de manera libre y voluntaria.</li>
                            <li>Conozco y acepto el contenido de esta carta de instrucciones.</li>
                            <li>Entiendo las consecuencias legales del incumplimiento.</li>
                          </ul>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">NOVENA - VALIDEZ DIGITAL</p>
                          <p className="mt-2">
                            El presente documento se firma mediante mecanismos electronicos,
                            teniendo plena validez juridica conforme a la legislacion
                            colombiana.
                          </p>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">DECIMA - PRUEBA</p>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            <li>Firma digital</li>
                            <li>Registro fotografico</li>
                            <li>Datos tecnicos (fecha, hora, IP, dispositivo)</li>
                          </ul>
                        </div>

                        <div className="mt-5">
                          <p className="font-black text-slate-950">FIRMA DEL DEUDOR</p>
                          <p className="mt-2">
                            Firma: {contratoFirmaDataUrl ? "Registrada" : "{{firma_digital}}"}
                          </p>
                          <p>Nombre: {clienteNombre || "{{nombre}}"}</p>
                          <p>Cedula: {clienteDocumento || "{{cedula}}"}</p>
                          <p>Fecha: {documentDateTimeLabel}</p>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-5 py-5 xl:col-span-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Checklist final
                      </p>
                      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        {[
                          { label: "Cliente", ready: stepClienteReady },
                          { label: "Equipo", ready: stepEquipoReady },
                          { label: "Contrato", ready: stepContratoReady },
                        ].map(({ label, ready }) => (
                          <div
                            key={label}
                            className={[
                              "rounded-2xl border px-4 py-4 text-sm font-semibold",
                              ready
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-amber-200 bg-amber-50 text-amber-700",
                            ].join(" ")}
                          >
                            {label}: {ready ? "OK" : "Pendiente"}
                          </div>
                        ))}
                      </div>

                      <div className="mt-5 flex items-start gap-3 rounded-[20px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-3">
                        <input
                          id="pagare-aceptado-wizard"
                          type="checkbox"
                          checked={pagareAceptado}
                          onChange={(event) => setPagareAceptado(event.target.checked)}
                          className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-300"
                        />
                        <label
                          htmlFor="pagare-aceptado-wizard"
                          className="text-sm leading-6 text-slate-700"
                        >
                          Confirmo que el cliente acepto el pagare digital y la carta de instrucciones, y que la venta puede pasar a inscripcion y validacion final.
                        </label>
                      </div>
                    </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {!simulatorMode && (
              <div className="fp-flow-actions sticky bottom-4 z-20 mt-5 flex flex-wrap items-center gap-3 rounded-[24px] border border-[#d8e6e5] bg-white/92 px-4 py-4 shadow-[0_18px_45px_rgba(15,23,42,0.12)] backdrop-blur">
                {wizardStep > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setWizardStep((current) => previousVisibleWizardStep(current))
                    }
                    className="rounded-2xl border border-[#cbdedc] bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-[#f4fbfa]"
                  >
                    Anterior
                  </button>
                )}

                {wizardStep < 5 && (
                  <button
                    type="button"
                    disabled={
                      creating ||
                      firmaSeguroSubmitting ||
                      (wizardStep === 4 && !stepDocumentosReady)
                    }
                    onClick={() => {
                      void advanceToStep(nextVisibleWizardStep(wizardStep));
                    }}
                    className="fp-action rounded-2xl px-5 py-3 text-sm font-semibold text-white transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    Siguiente paso
                  </button>
                )}

                {wizardStep === 5 && (
                  <button
                    type="button"
                    onClick={() => void finalizeFirmaSeguroDelivery()}
                    disabled={
                      creating ||
                      firmaSeguroSubmitting ||
                      (firmaSeguroProcessSent
                        ? !firmaSeguroProcessSigned || !deliveryRequirementReady
                        : !ventaLista)
                    }
                    className="fp-action rounded-2xl px-5 py-3 text-sm font-semibold text-white transition hover:scale-[1.01] disabled:opacity-70"
                  >
                    {creating || firmaSeguroSubmitting
                      ? "Finalizando credito..."
                      : firmaSeguroProcessSent
                        ? "Finalizar credito firmado"
                        : "Finalizar credito"}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => resetForm()}
                  disabled={creating}
                  className="rounded-2xl border border-[#cbdedc] bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-[#f4fbfa] disabled:opacity-70"
                >
                  Limpiar
                </button>

                {createClientMode && draftHasMeaningfulData ? (
                  <span
                    className={[
                      "rounded-2xl border px-4 py-2 text-xs font-semibold",
                      draftStatus === "error"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : draftStatus === "saving" || draftStatus === "loading"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700",
                    ].join(" ")}
                  >
                    {draftStatus === "saving"
                      ? "Guardando borrador..."
                      : draftStatus === "loading"
                        ? "Cargando borrador..."
                        : draftStatus === "error"
                          ? "Borrador no guardado"
                          : draftId
                            ? `Borrador #${draftId} guardado${draftLastSavedAt ? ` - ${draftLastSavedAt}` : ""}`
                            : "Borrador listo para guardar"}
                  </span>
                ) : null}

                {FLEXIBLE_WIZARD_FOR_TESTING && (
                  <span className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-medium text-sky-700">
                    Modo pruebas: puedes saltar entre pasos y cerrar sin la validacion final de entrega.
                  </span>
                )}

                {wizardStep === 5 && !ventaLista && !FLEXIBLE_WIZARD_FOR_TESTING && (
                  <span className="text-sm font-medium text-amber-700">
                    Primero valida la entregabilidad del dispositivo para habilitar el cierre.
                  </span>
                )}
              </div>
            )}
              </div>
            </div>

            <div className="hidden">

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Cliente
                </label>
                <input
                  value={clienteNombre}
                  onChange={(event) => setClienteNombre(event.target.value)}
                  placeholder="Nombre completo"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Documento
                </label>
                <input
                  value={clienteDocumento}
                  onChange={(event) => setClienteDocumento(event.target.value)}
                  placeholder="Cedula del cliente"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Telefono
                </label>
                <input
                  value={clienteTelefono}
                  onChange={(event) => setClienteTelefono(event.target.value)}
                  placeholder="Numero del cliente"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Direccion
                </label>
                <input
                  value={clienteDireccion}
                  onChange={(event) => setClienteDireccion(event.target.value)}
                  placeholder="Direccion completa del cliente"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Marca
                </label>
                <input
                  value={equipoMarca}
                  onChange={(event) => setEquipoMarca(event.target.value)}
                  placeholder="Infinix, Samsung, Xiaomi..."
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Modelo
                </label>
                <input
                  value={equipoModelo}
                  onChange={(event) => setEquipoModelo(event.target.value)}
                  placeholder="Modelo comercial"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  IMEI / deviceUid
                </label>
                <input
                  value={imei}
                  onChange={(event) =>
                    setImei(event.target.value.replace(/\D/g, "").slice(0, 15))
                  }
                  inputMode="numeric"
                  maxLength={15}
                  placeholder="15 numeros del IMEI"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
                <p
                  className={[
                    "mt-2 text-xs font-medium",
                    imeiDigits.length > 0 && !imeiValido ? "text-red-600" : "text-slate-500",
                  ].join(" ")}
                >
                  {imeiDigits.length > 0
                    ? `${imeiDigits.length}/15 digitos`
                    : "Debe tener exactamente 15 numeros."}
                </p>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Precio Equipo
                </label>
                <input
                  value={currencyInputValue(valorEquipoTotal)}
                  onChange={(event) => setValorEquipoTotal(event.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                  placeholder="$ 850.000"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
                {canSeeInternalPricing ? (
                  <p className="mt-2 text-xs font-medium text-slate-500">
                    Base financiable maxima: {currency(MAX_DEVICE_FINANCING_BASE)}. El excedente se cobra en la inicial.
                  </p>
                ) : (
                  <p className="mt-2 text-xs font-medium text-slate-500">
                    Ingresa manualmente el valor de venta acordado con el cliente.
                  </p>
                )}
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Cuota inicial
                </label>
                <input
                  value={currencyInputValue(cuotaInicial)}
                  onChange={(event) => setCuotaInicial(event.target.value.replace(/\D/g, ""))}
                  onBlur={handleCuotaInicialBlur}
                  inputMode="numeric"
                  placeholder="$ 0"
                  className={[
                    "w-full rounded-2xl border bg-white px-4 py-3 text-base font-semibold text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200",
                    cuotaInicial || !valorTotalEquipoNumero
                      ? cuotaInicialValida || !valorTotalEquipoNumero
                        ? "border-slate-300"
                        : "border-red-300"
                      : "border-slate-300",
                  ].join(" ")}
                />
                <p
                  className={[
                    "mt-2 text-xs font-medium",
                    cuotaInicial && !cuotaInicialValida ? "text-red-600" : "text-slate-500",
                  ].join(" ")}
                >
                  Minimo: {currency(cuotaInicialMinimaNumero)}. Puedes subirla si el cliente da mas.
                </p>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Numero de cuotas
                </label>
                <select
                  value={plazoMeses}
                  onChange={(event) => setPlazoMeses(event.target.value)}
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                >
                  {creditInstallmentOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Frecuencia
                </label>
                <div className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-900">
                  {frecuenciaPagoLabel}
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Primer pago
                </label>
                <input
                  type="date"
                  value={fechaPrimerPago}
                  readOnly
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
                <p className="mt-2 text-xs font-medium text-slate-500">
                  Fecha automatica segun la fecha del credito y frecuencia {frecuenciaPagoLabel.toLowerCase()}.
                </p>
              </div>
            </div>

            <div className={["mt-6 grid gap-3", canSeeInternalPricing ? "md:grid-cols-3" : "md:grid-cols-2"].join(" ")}>
              {canSeeInternalPricing ? (
                <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Saldo financiado
                  </p>
                  <p className="mt-2 text-xl font-black text-slate-950">
                    {currency(saldoFinanciado)}
                  </p>
                </div>
              ) : null}

              <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Valor por cuota
                </p>
                <p className="mt-2 text-2xl font-black text-slate-950">
                  {currency(valorCuota)}
                </p>
              </div>

              <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Referencia comercial
                </p>
                <p className="mt-2 text-lg font-black text-slate-950">
                  {referenciaEquipo || "Pendiente"}
                </p>
              </div>
            </div>

            <div className="mt-8 rounded-[28px] border border-[#dbcdb8] bg-[linear-gradient(180deg,#fffdf8_0%,#f8f3ea_100%)] p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="inline-flex rounded-full border border-[#e6d6bd] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a5a21]">
                    Contrato digital
                  </div>
                  <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                    Completa la evidencia antes de crear el credito
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    El contrato se llena con los datos de este formulario. La firma se gestiona en FirmaSeguro.
                  </p>
                </div>

                <div
                  className={[
                    "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                    contratoListo
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-700",
                  ].join(" ")}
                >
                  {contratoListo ? "Contrato listo para guardar" : "Falta evidencia contractual"}
                </div>
              </div>

              <div className="mt-6 grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="space-y-5">
                  <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Evidencia fotografica
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Toma una foto del cliente aceptando el contrato. Puedes usar camara o cargarla desde el dispositivo.
                    </p>

                    <div className="mt-4 flex flex-wrap gap-3">
                      <label className="inline-flex cursor-pointer items-center rounded-2xl bg-[#145a5a] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a]">
                        Tomar / cargar foto
                        <input
                          type="file"
                          accept="image/*"
                          capture="user"
                          onChange={captureContractPhoto}
                          className="hidden"
                        />
                      </label>

                      <button
                        type="button"
                        onClick={() => setContratoFotoDataUrl("")}
                        disabled={!contratoFotoDataUrl}
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                      >
                        Quitar foto
                      </button>
                    </div>

                    <div className="mt-4 rounded-[22px] border border-dashed border-[#d8c9b1] bg-[#fcfaf6] p-3">
                      {contratoFotoDataUrl ? (
                        <img
                          src={contratoFotoDataUrl}
                          alt="Foto del cliente"
                          className="h-56 w-full rounded-[18px] object-cover"
                        />
                      ) : (
                        <div className="flex h-56 items-center justify-center rounded-[18px] bg-white text-sm text-slate-500">
                          Aun no hay foto del cliente.
                        </div>
                      )}
                    </div>
                  </div>

                </div>

                {contractPreviewNode}
                {false && (
                <div className="rounded-[24px] border border-[#0f172a] bg-[#fffdfa] p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                    Contrato de financiacion de equipo movil, tratamiento de datos y herramientas tecnologicas
                  </p>
                  <div className="mt-4 border-t border-dashed border-slate-300 pt-4 text-sm leading-7 text-slate-700">
                    <p className="font-black text-slate-950">FINSER PAY S.A.S.</p>
                    <p>NIT: 902052909-4</p>
                    <p>Domicilio: Ibague - Tolima</p>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">
                        CONTRATO DE FINANCIACION DE EQUIPO MOVIL, AUTORIZACION DE TRATAMIENTO DE DATOS Y USO DE HERRAMIENTAS TECNOLOGICAS
                      </p>
                      <p className="mt-2">Entre los suscritos a saber:</p>
                      <p className="mt-3">
                        <span className="font-semibold text-slate-950">EL ACREEDOR:</span> FINSER PAY S.A.S.
                      </p>
                      <p>
                        <span className="font-semibold text-slate-950">EL DEUDOR:</span>{" "}
                        {clienteNombre || "{{NOMBRE_CLIENTE}}"}, identificado con {clienteTipoDocumentoLabel} No.{" "}
                        {clienteDocumento || "{{NUMERO_DOCUMENTO}}"}
                      </p>
                      <p className="mt-3">
                        Se celebra el presente contrato de financiacion, el cual se regira por las siguientes clausulas:
                      </p>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">PRIMERA – OBJETO</p>
                      <p className="mt-2">
                        EL FINANCIADOR entrega al CLIENTE, bajo modalidad de financiacion, un dispositivo movil cuyas caracteristicas son:
                      </p>
                      <p className="mt-2">Marca: {equipoMarca || "{{marca}}"}</p>
                      <p>Modelo: {equipoModelo || "{{modelo}}"}</p>
                      <p>IMEI: {imei || "{{imei}}"}</p>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">
                        SEGUNDA – VALOR Y CONDICIONES
                      </p>
                      <p className="mt-2">
                        Valor total del equipo: {currency(valorTotalEquipoNumero)}
                      </p>
                      <p>Cuota inicial: {currency(cuotaInicialNumero)}</p>
                      <p>
                        Credito autorizado: {currency(financialPlan.saldoBaseFinanciado)}
                      </p>
                      <p>Interes estimado: {currency(financialPlan.valorInteres)}</p>
                      <p>Valor total a pagar: {currency(saldoFinanciado)}</p>
                      <p>Numero de cuotas: {plazoMesesNumero || "{{cuotas}}"}</p>
                      <p>Valor de cada cuota: {currency(valorCuota)}</p>
                      <p className="mt-2">
                        El CLIENTE se obliga a pagar en las fechas acordadas.
                      </p>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">TERCERA – MORA</p>
                      <ol className="mt-2 list-decimal space-y-1 pl-5">
                        <li>Exigibilidad inmediata de la totalidad de la obligacion.</li>
                        <li>Intereses moratorios a la tasa maxima legal permitida.</li>
                        <li>Inicio de gestion de cobro prejuridico y juridico.</li>
                      </ol>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">
                        CUARTA – AUTORIZACION DE CONTROL DEL DISPOSITIVO
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>El dispositivo podra ser bloqueado, restringido o limitado en caso de mora.</li>
                        <li>Podran implementarse medidas tecnologicas de control remoto.</li>
                        <li>Dichas medidas permaneceran hasta la normalizacion de la obligacion.</li>
                      </ul>
                      <p className="mt-2">
                        Esta autorizacion constituye aceptacion libre de mecanismos de garantia tecnologica.
                      </p>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">
                        QUINTA – PROPIEDAD Y GARANTIA
                      </p>
                      <p className="mt-2">
                        El dispositivo permanecera como garantia de la obligacion hasta el pago total.
                      </p>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">
                        SEXTA – AUTORIZACION DE HABEAS DATA
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>Consultar, reportar, procesar y actualizar informacion en centrales de riesgo.</li>
                        <li>Compartir informacion con entidades aliadas para gestion de cobranza.</li>
                      </ul>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">
                        SEPTIMA – DECLARACIONES DEL CLIENTE
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>Que la informacion suministrada es veraz.</li>
                        <li>Que recibe el equipo en perfecto estado.</li>
                        <li>Que comprende plenamente las condiciones del contrato.</li>
                      </ul>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">OCTAVA – MERITO EJECUTIVO</p>
                      <p className="mt-2">
                        El presente contrato presta merito ejecutivo y constituye titulo idoneo para exigir judicialmente el pago de la obligacion.
                      </p>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">NOVENA – VALIDEZ DIGITAL</p>
                      <p className="mt-2">
                        El presente contrato se firma por medios electronicos, teniendo plena validez juridica conforme a la legislacion colombiana.
                      </p>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">
                        DECIMA – PRUEBA
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>Firma digital</li>
                        <li>Registro fotografico del cliente</li>
                        <li>Datos tecnicos (fecha, hora, IP, dispositivo)</li>
                      </ul>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">EVIDENCIA FOTOGRAFICA</p>
                      <div className="mt-3 rounded-[20px] border border-dashed border-[#d8c9b1] bg-[#fcfaf6] p-3">
                        {contratoFotoDataUrl ? (
                          <img
                            src={contratoFotoDataUrl}
                            alt="Foto del cliente"
                            className="h-40 w-full rounded-[16px] object-cover"
                          />
                        ) : (
                          <div className="flex h-40 items-center justify-center rounded-[16px] bg-white text-sm text-slate-500">
                            [ FOTO DEL CLIENTE ]
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-5">
                      <p className="font-black text-slate-950">FIRMA DIGITAL</p>
                      <div className="mt-3 rounded-[20px] border border-dashed border-[#d8c9b1] bg-[#fcfaf6] p-3">
                        {contratoFirmaDataUrl ? (
                          <img
                            src={contratoFirmaDataUrl}
                            alt="Firma digital"
                            className="h-24 w-full rounded-[16px] object-contain"
                          />
                        ) : (
                          <div className="flex h-24 items-center justify-center rounded-[16px] bg-white text-sm text-slate-500">
                            {"{{firma_digital}}"}
                          </div>
                        )}
                      </div>
                      <p className="mt-3">Nombre: {clienteNombre || "{{nombre}}"}</p>
                      <p>Cedula: {clienteDocumento || "{{cedula}}"}</p>
                          <p>Fecha: {documentDateTimeLabel}</p>
                    </div>
                  </div>
                </div>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void createCredit()}
                disabled={creating || !contratoListo}
                className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-70"
              >
                {creating ? "Guardando contrato..." : "Generar credito, firmar e inscribir"}
              </button>

              <button
                type="button"
                onClick={() => resetForm()}
                disabled={creating}
                className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
              >
                Limpiar
              </button>

              {!contratoListo && (
                <span className="text-sm font-medium text-amber-700">
                  Completa contrato, foto y firma para habilitar el alta.
                </span>
              )}
            </div>
            </div>
          </div>

          <div
            ref={lookupMode ? selectedCreditPanelRef : null}
            className={[
              clientLookupMode
                ? "fp-client-lookup-result"
                : "rounded-[30px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] shadow-[0_18px_50px_rgba(15,23,42,0.07)]",
              deliveryMode ? "p-5" : clientLookupMode ? "" : "p-6",
              clientLookupMode && !selectedCredit ? "hidden" : "",
              createClientMode || simulatorMode || (deliveryMode && !selectedCredit) ? "hidden" : "",
            ].join(" ")}
          >
            <div className={clientLookupMode ? "hidden" : "inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600"}>
              {deliveryMode ? "Validacion de entrega" : lookupMode ? "Expediente del cliente" : "Entrega"}
            </div>
            {!clientLookupMode ? (
              <h2 className={deliveryMode ? "mt-3 text-2xl font-black tracking-tight text-slate-950" : "mt-4 text-3xl font-black tracking-tight text-slate-950"}>
                {deliveryMode ? "Resultado de consulta" : "Validacion operativa"}
              </h2>
            ) : null}

            {!selectedCredit ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                {loadingList
                  ? "Buscando coincidencias..."
                  : lookupMode
                    ? activeSearch
                      ? deliveryMode
                        ? "La consulta encontro varias coincidencias. Selecciona una para validar la entrega."
                        : "La busqueda devolvio varias coincidencias. Selecciona una para ver solo ese expediente."
                      : deliveryMode
                        ? "Escribe numero de cedula o IMEI y consulta si el equipo esta entregable."
                        : "Escribe un dato del cliente o del credito para abrir un expediente puntual."
                    : "Genera o selecciona un credito para ver si el equipo ya se puede entregar."}
              </div>
            ) : (
              <div className={clientLookupMode ? "mt-5 space-y-4" : "mt-6 space-y-4"}>
                {clientLookupMode && (
                  <>
                    <div className="fp-client-dossier-hero">
                      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
                        <div className="grid min-w-0 gap-5 md:grid-cols-[172px_minmax(0,1fr)] md:items-center">
                          <div className="fp-client-dossier-photo mx-auto flex h-[156px] w-[156px] shrink-0 items-center justify-center overflow-hidden rounded-[34px] border text-4xl font-black md:mx-0 md:h-[172px] md:w-[172px]">
                            {selectedCredit.contratoSelfieDataUrl ||
                            selectedCredit.contratoFotoDataUrl ? (
                              <img
                                src={
                                  selectedCredit.contratoSelfieDataUrl ||
                                  selectedCredit.contratoFotoDataUrl ||
                                  ""
                                }
                                alt={`Selfie de ${selectedCredit.clienteNombre}`}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              String(
                                selectedCredit.clientePrimerNombre ||
                                  selectedCredit.clienteNombre ||
                                  "C"
                              )
                                .trim()
                                .charAt(0)
                                .toUpperCase()
                            )}
                          </div>

                          <div className="min-w-0">
                            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-[#8a6a24]">
                              Abrir abonos
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="mt-2 max-w-3xl break-words text-3xl font-black leading-tight tracking-normal text-slate-950 sm:text-4xl">
                                {selectedCredit.clienteNombre}
                              </h3>
                              <span className="fp-client-dossier-status">
                                {clientPrimaryStatus}
                              </span>
                            </div>
                            <div className="mt-4 grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
                              <p>
                                <span className="block text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">
                                  Documento
                                </span>
                                <span className="font-black text-slate-950">
                                  {selectedCreditDocumentLabel}
                                </span>
                              </p>
                              <p>
                                <span className="block text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">
                                  Telefono
                                </span>
                                <span className="font-black text-slate-950">
                                  {selectedCredit.clienteTelefono || "-"}
                                </span>
                              </p>
                              <p className="sm:col-span-2">
                                <span className="block text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">
                                  Correo
                                </span>
                                <span className="font-semibold text-slate-700">
                                  {selectedCredit.clienteCorreo || "Sin correo"}
                                </span>
                              </p>
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => openPaymentsForCredit()}
                          className="fp-client-action-primary rounded-[18px] px-6 py-3 text-sm font-black"
                        >
                          Abrir abonos
                        </button>
                      </div>

                      <div className="fp-client-dossier-summary mt-6 grid lg:grid-cols-[1fr_1fr_1fr_1.35fr]">
                        <div className="border-b border-slate-200 px-4 py-3 sm:border-b-0 sm:border-r">
                          <p className="text-[11px] font-semibold uppercase text-slate-500">Saldo del credito</p>
                          <p className="mt-1 break-words text-base font-black text-slate-950">{currency(selectedCredit.saldoPendiente)}</p>
                          <p className="mt-1 text-xs text-slate-500">{selectedCreditPaymentStatusLabel}</p>
                        </div>
                        <div className="border-b border-slate-200 px-4 py-3 sm:border-b-0 sm:border-r">
                          <p className="text-[11px] font-semibold uppercase text-slate-500">Cuotas pagas</p>
                          <p className="mt-1 break-words text-base font-black text-slate-950">{selectedCredit.cuotasPagadas || 0}</p>
                          <p className="mt-1 text-xs text-slate-500">{formatPercent(selectedCreditPaidPercent)} pagado</p>
                        </div>
                        <div className="border-b border-slate-200 px-4 py-3 sm:border-b-0 sm:border-r">
                          <p className="text-[11px] font-semibold uppercase text-slate-500">Cuotas pendientes</p>
                          <p className="mt-1 break-words text-base font-black text-slate-950">{selectedCredit.cuotasPendientes || 0}</p>
                          <p className="mt-1 text-xs text-slate-500">{selectedCredit.cuotasEnMora || 0} en mora</p>
                        </div>
                        <div className="px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase text-slate-500">Equipo / ref / IMEI</p>
                          <p className="mt-1 break-words text-base font-black text-slate-950">{selectedCreditEquipmentLabel}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Ref: {selectedCredit.referenciaEquipo || selectedCredit.folio} | IMEI: {selectedCredit.imei || selectedCredit.deviceUid || "-"}
                          </p>
                        </div>
                      </div>

                      <div className="fp-client-dossier-actions mt-5 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => openLookupDetail(selectedCredit.id)}
                        >
                          Ver detalle
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPazYSalvo()}
                          disabled={!selectedCredit || selectedCredit.saldoPendiente > 0}
                        >
                          Paz y salvo
                        </button>
                        <button
                          type="button"
                          onClick={() => createNewSaleFromClient()}
                          disabled={!selectedCreditCanCreateNewCredit}
                          title={selectedCreditNewCreditTitle}
                        >
                          Crear nuevo credito
                        </button>
                        {canAdmin || canSupervisor ? (
                          <button
                            type="button"
                            onClick={() => void runCommand(selectedCreditLockCommand)}
                            disabled={!selectedCredit || runningCommand !== null}
                          >
                            {selectedCreditLockButtonLabel}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => downloadPlanPagos()}
                          disabled={!selectedCredit}
                        >
                          Plan de pagos
                        </button>
                        <button
                          type="button"
                          onClick={() => void openFirmaSeguroSignedDocument()}
                          disabled={firmaSeguroRefreshing}
                        >
                          {firmaSeguroRefreshing ? "Consultando..." : "Expediente PDF"}
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {lookupMode && !showLookupDetail ? (
                  clientLookupMode ? null : (
                  <div className="flex flex-col gap-3 border-t border-slate-200 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-slate-600">
                      El detalle completo queda contraido para mantener esta vista limpia.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowSearchResults(true)}
                      className="rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                    >
                      Cambiar credito
                    </button>
                  </div>
                  )
                ) : lookupMode && !deliveryMode ? (
                  <div ref={lookupDetailPanelRef} className="fp-client-dossier-detail space-y-6">
                    <div className="fp-client-dossier-statusbar flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a6a24]">
                          Expediente operativo
                        </p>
                        <h3 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                          {selectedCredit.deliverableReady ? "Listo para entregar" : "No entregar todavia"}
                        </h3>
                        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                          {selectedCredit.deliverableLabel ||
                            "Aun no hay una verificacion comercial disponible."}
                          {selectedCredit.equalityState
                            ? ` Estado remoto: ${selectedCredit.equalityState}.`
                            : ""}
                        </p>
                        <p className="mt-2 text-xs font-semibold text-slate-500">
                          Ultima revision: {dateTime(selectedCredit.equalityLastCheckAt)} | {selectedCreditLockStatus} | Ventana: {dateTime(selectedCredit.graceUntil)}
                        </p>
                      </div>

                      <div className="fp-client-detail-actions flex flex-wrap gap-2 lg:justify-end">
                        <button
                          type="button"
                          onClick={() => setShowLookupDetail(false)}
                          className="rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Ocultar detalle
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowSearchResults(true)}
                          className="rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Cambiar credito
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadExpedientePdf()}
                          disabled={!selectedCredit}
                          className="rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          Expediente PDF
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPlanPagos()}
                          disabled={!selectedCredit}
                          className="rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          Plan de pagos
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPazYSalvo()}
                          disabled={!selectedCredit || selectedCredit.saldoPendiente > 0}
                          className="rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          Paz y salvo
                        </button>
                        {canAdmin || canSupervisor ? (
                          <button
                            type="button"
                            onClick={() => void runCommand(selectedCreditLockCommand)}
                            disabled={!selectedCredit || runningCommand !== null}
                            className="rounded-[14px] border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                          >
                            {selectedCreditLockButtonLabel}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
                      <section>
                        <h4 className="text-sm font-black uppercase tracking-[0.14em] text-slate-700">
                          Credito
                        </h4>
                        <div className="mt-2 border-y border-slate-200">
                          <DetailRow
                            label="Folio y estado"
                            value={selectedCredit.folio}
                            detail={`${selectedCredit.estado} | ${selectedCreditPaymentStatusLabel}`}
                          />
                          <DetailRow
                            label="Responsable"
                            value={selectedCreditAdvisorLabel}
                            detail={`Sede: ${selectedCredit.sede.nombre}`}
                          />
                          <DetailRow
                            label="Equipo"
                            value={selectedCreditEquipmentLabel}
                            detail={`IMEI: ${selectedCredit.imei || selectedCredit.deviceUid || "-"}`}
                          />
                          <DetailRow
                            label="Referencia pago"
                            value={selectedCredit.referenciaPago || "-"}
                            detail="Dato para recaudo y conciliacion"
                          />
                        </div>
                      </section>

                      <section>
                        <h4 className="text-sm font-black uppercase tracking-[0.14em] text-slate-700">
                          Cliente
                        </h4>
                        <div className="mt-2 border-y border-slate-200">
                          <DetailRow
                            label="Documento"
                            value={selectedCreditDocumentLabel}
                            detail={`Expedido: ${dateTime(selectedCredit.clienteFechaExpedicion)}`}
                          />
                          <DetailRow
                            label="Telefono y correo"
                            value={selectedCredit.clienteTelefono || "-"}
                            detail={selectedCredit.clienteCorreo || "Sin correo"}
                          />
                          <DetailRow
                            label="Nacimiento"
                            value={dateTime(selectedCredit.clienteFechaNacimiento)}
                            detail={`Genero: ${humanizeConstant(selectedCredit.clienteGenero)}`}
                          />
                          <DetailRow
                            label="Ubicacion"
                            value={
                              [selectedCredit.clienteCiudad, selectedCredit.clienteDepartamento]
                                .filter(Boolean)
                                .join(", ") || "-"
                            }
                            detail={selectedCredit.clienteDireccion || "Sin direccion"}
                          />
                        </div>
                      </section>

                      <section>
                        <h4 className="text-sm font-black uppercase tracking-[0.14em] text-slate-700">
                          Cartera
                        </h4>
                        <div className="mt-2 border-y border-slate-200">
                          <DetailRow
                            label="Saldo pendiente"
                            value={currency(selectedCredit.saldoPendiente)}
                            detail={selectedCreditPaymentProgress}
                          />
                          <DetailRow
                            label="Monto y cuota"
                            value={currency(selectedCredit.montoCredito)}
                            detail={`Cuota: ${currency(selectedCredit.valorCuota)} | ${selectedCredit.plazoMeses || "-"} cuotas`}
                          />
                          <DetailRow
                            label="Proximo pago"
                            value={dateTime(selectedCredit.fechaProximoPago)}
                            detail={`Primer pago: ${dateTime(selectedCredit.fechaPrimerPago)}`}
                          />
                          <DetailRow
                            label="Recaudo"
                            value={formatPercent(selectedCredit.porcentajeRecaudado)}
                            detail={`${selectedCredit.abonosCount} abono(s) | Ultimo: ${dateTime(selectedCredit.ultimoAbonoAt)}`}
                          />
                        </div>
                      </section>
                    </div>

                    <div className="grid gap-x-8 gap-y-6 border-t border-slate-200 pt-5 lg:grid-cols-2">
                      <section>
                        <h4 className="text-sm font-black uppercase tracking-[0.14em] text-slate-700">
                          Firma y documentos
                        </h4>
                        <div className="mt-2 border-y border-slate-200">
                          <DetailRow
                            label="Auditoria"
                            value={selectedCreditDocumentsStatus}
                            detail={selectedCreditCreatedLabel}
                          />
                          <DetailRow
                            label="Evidencia"
                            value={selectedCredit.contratoListo ? "Completa" : "Pendiente"}
                            detail={selectedCreditEvidenceStatus}
                          />
                          <DetailRow
                            label="OTP contrato"
                            value={selectedCredit.contratoOtpVerificadoAt ? "Verificado" : "Pendiente"}
                            detail={
                              [
                                selectedCredit.contratoOtpCanal,
                                selectedCredit.contratoOtpDestino,
                              ]
                                .filter(Boolean)
                                .join(" | ") || "Sin canal registrado"
                            }
                          />
                          <DetailRow
                            label="Firma"
                            value={selectedCreditDocumentsStatus}
                            detail={`Contrato: ${dateTime(selectedCredit.contratoAceptadoAt)} | Pagare: ${dateTime(selectedCredit.pagareAceptadoAt)}`}
                          />
                        </div>
                      </section>

                      <section>
                        <h4 className="text-sm font-black uppercase tracking-[0.14em] text-slate-700">
                          Referencias
                        </h4>
                        <div className="mt-2 border-y border-slate-200">
                          {selectedCredit.referenciasFamiliares?.length ? (
                            selectedCredit.referenciasFamiliares.map((reference, index) => (
                              <DetailRow
                                key={`${reference.nombre}-${index}`}
                                label={`Referencia familiar ${index + 1}`}
                                value={reference.nombre}
                                detail={`${reference.parentesco} | ${reference.telefono}`}
                              />
                            ))
                          ) : (
                            <p className="py-3 text-sm text-slate-500">
                              Este credito no tiene referencias familiares visibles.
                            </p>
                          )}
                        </div>
                      </section>
                    </div>

                    {sameClientCredits.length > 1 ? (
                      <section className="border-t border-slate-200 pt-5">
                        <h4 className="text-sm font-black uppercase tracking-[0.14em] text-slate-700">
                          Historial dentro de tu alcance
                        </h4>
                        <div className="mt-2 divide-y divide-slate-200 border-y border-slate-200">
                          {sameClientCredits.map((credit) => (
                            <div
                              key={`history-flat-${credit.id}`}
                              className="grid gap-2 py-3 text-sm md:grid-cols-[1.2fr_1fr_1fr_auto] md:items-center"
                            >
                              <div>
                                <p className="font-black text-slate-950">{credit.folio}</p>
                                <p className="text-xs text-slate-500">{credit.estado}</p>
                              </div>
                              <p className="text-slate-600">{credit.referenciaEquipo || credit.imei}</p>
                              <p className="font-semibold text-slate-700">{currency(credit.saldoPendiente)}</p>
                              <button
                                type="button"
                                onClick={() => openLookupDetail(credit.id)}
                                className="rounded-[14px] border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                              >
                                Abrir
                              </button>
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {canAdmin && !clientLookupMode ? (
                      <section className="border-t border-slate-200 pt-5">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                          <div className="lg:w-56">
                            <p className="text-sm font-black uppercase tracking-[0.14em] text-slate-700">
                              Ajuste admin
                            </p>
                            <p className="mt-1 text-xs leading-5 text-slate-500">
                              Corregir plan de pagos.
                            </p>
                          </div>
                          <label className="grid gap-2 text-sm font-semibold text-slate-700">
                            Cuotas
                            <select
                              value={planInstallments}
                              onChange={(event) => setPlanInstallments(event.target.value)}
                              className="h-11 rounded-[14px] border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                            >
                              {Array.from(
                                { length: MAX_CREDIT_INSTALLMENTS },
                                (_, index) => String(index + 1)
                              ).map((option) => (
                                <option key={`lookup-plan-${option}`} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid gap-2 text-sm font-semibold text-slate-700">
                            Frecuencia
                            <select
                              value={planFrequency}
                              onChange={(event) => setPlanFrequency(event.target.value)}
                              className="h-11 rounded-[14px] border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                            >
                              {PAYMENT_FREQUENCY_OPTIONS.map((option) => (
                                <option key={`lookup-${option.value}`} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid gap-2 text-sm font-semibold text-slate-700">
                            Primer pago
                            <input
                              type="date"
                              value={planFirstPaymentDate}
                              onChange={(event) => setPlanFirstPaymentDate(event.target.value)}
                              className="h-11 rounded-[14px] border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => void updateCreditPlan()}
                            disabled={updatingPlan || runningCommand !== null}
                            className="h-11 rounded-[14px] border border-[#145a5a] bg-[#145a5a] px-4 text-sm font-black text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
                          >
                            {updatingPlan ? "Guardando..." : "Guardar plan"}
                          </button>
                        </div>
                      </section>
                    ) : null}
                  </div>
                ) : (
                  <div ref={lookupMode ? lookupDetailPanelRef : null} className="space-y-4">
                <div
                  className={[
                    "rounded-[24px] border px-5 py-5 shadow-sm",
                    deliveryClasses(selectedCredit.deliverableReady),
                  ].join(" ")}
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase">
                        Estado operativo y entrega
                      </p>
                      <p className="mt-2 text-2xl font-black leading-tight">
                        {selectedCredit.deliverableReady
                          ? "Listo para entregar"
                          : "No entregar todavia"}
                      </p>
                      <p className="mt-3 max-w-3xl text-sm leading-6">
                        {selectedCredit.deliverableLabel ||
                          "Aun no hay una verificacion comercial disponible."}
                        {selectedCredit.equalityState
                          ? ` Estado remoto: ${selectedCredit.equalityState}.`
                          : ""}
                      </p>
                    </div>

                    <div className="grid gap-2 text-sm font-semibold lg:min-w-[260px]">
                      <span>Ultima revision: {dateTime(selectedCredit.equalityLastCheckAt)}</span>
                      <span>{selectedCreditLockStatus}</span>
                      <span>Ventana: {dateTime(selectedCredit.graceUntil)}</span>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <InfoTile
                    label="Folio y estado"
                    value={selectedCredit.folio}
                    detail={
                      <span
                        className={[
                          "inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase",
                          stateBadgeClasses(selectedCredit.estado),
                        ].join(" ")}
                      >
                        {selectedCredit.estado}
                      </span>
                    }
                    tone="white"
                  />
                  <InfoTile
                    label="Responsable"
                    value={selectedCreditAdvisorLabel}
                    detail={`Sede: ${selectedCredit.sede.nombre}`}
                    tone="slate"
                  />
                  <InfoTile
                    label="Equipo financiado"
                    value={selectedCreditEquipmentLabel}
                    detail={`Marca/modelo: ${
                      [selectedCredit.equipoMarca, selectedCredit.equipoModelo]
                        .filter(Boolean)
                        .join(" ") || "-"
                    } | IMEI: ${selectedCredit.imei || selectedCredit.deviceUid || "-"}`}
                    tone="sky"
                  />
                  <InfoTile
                    label="Auditoria"
                    value={selectedCreditDocumentsStatus}
                    detail={selectedCreditCreatedLabel}
                    tone={selectedCredit.contratoListo ? "emerald" : "amber"}
                  />
                </div>

                <div
                  className={[
                    "rounded-[24px] border border-[#e6dece] bg-white px-5 py-5",
                    deliveryMode ? "hidden" : "",
                  ].join(" ")}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Ficha del cliente
                      </p>
                      <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                        Datos personales, contacto y referencias
                      </h3>
                    </div>

                    {canViewSavedCredits && (
                      <div className="flex flex-wrap gap-2">
                        {lookupMode && (
                          <button
                            type="button"
                            onClick={() => setShowLookupDetail(false)}
                            className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            Ocultar detalle
                          </button>
                        )}
                        {lookupMode && (
                          <button
                            type="button"
                            onClick={() => setShowSearchResults(true)}
                            className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            Cambiar credito
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => downloadExpedientePdf()}
                          disabled={!selectedCredit}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          Expediente PDF
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPlanPagos()}
                          disabled={!selectedCredit}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                          >
                            Plan de pagos
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPazYSalvo()}
                          disabled={!selectedCredit || selectedCredit.saldoPendiente > 0}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          Emitir paz y salvo
                        </button>
                        {canAdmin || canSupervisor ? (
                          <button
                            type="button"
                            onClick={() => void runCommand(selectedCreditLockCommand)}
                            disabled={!selectedCredit || runningCommand !== null}
                            className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                          >
                            {selectedCreditLockButtonLabel}
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <InfoTile
                      label="Documento"
                      value={selectedCreditDocumentLabel}
                      detail={`Expedido: ${dateTime(selectedCredit.clienteFechaExpedicion)}`}
                      tone="white"
                    />
                    <InfoTile
                      label="Telefono"
                      value={selectedCredit.clienteTelefono || "-"}
                      detail={selectedCredit.clienteCorreo || "Sin correo"}
                      tone="white"
                    />
                    <InfoTile
                      label="Nacimiento"
                      value={dateTime(selectedCredit.clienteFechaNacimiento)}
                      detail={`Genero: ${humanizeConstant(selectedCredit.clienteGenero)}`}
                      tone="slate"
                    />
                    <InfoTile
                      label="Ubicacion"
                      value={
                        [selectedCredit.clienteCiudad, selectedCredit.clienteDepartamento]
                          .filter(Boolean)
                          .join(", ") || "-"
                      }
                      detail={selectedCredit.clienteDireccion || "Sin direccion"}
                      tone="slate"
                    />
                    <InfoTile
                      label="Evidencia"
                      value={selectedCredit.contratoListo ? "Completa" : "Pendiente"}
                      detail={selectedCreditEvidenceStatus}
                      tone={selectedCredit.contratoListo ? "emerald" : "amber"}
                    />
                    <InfoTile
                      label="OTP contrato"
                      value={selectedCredit.contratoOtpVerificadoAt ? "Verificado" : "Pendiente"}
                      detail={[
                        selectedCredit.contratoOtpCanal,
                        selectedCredit.contratoOtpDestino,
                      ]
                        .filter(Boolean)
                        .join(" | ") || "Sin canal registrado"}
                      tone={selectedCredit.contratoOtpVerificadoAt ? "emerald" : "slate"}
                    />
                    <InfoTile
                      label="Firma"
                      value={selectedCreditDocumentsStatus}
                      detail={`Contrato: ${dateTime(selectedCredit.contratoAceptadoAt)} | Pagare: ${dateTime(
                        selectedCredit.pagareAceptadoAt
                      )}`}
                      tone={selectedCredit.contratoListo ? "emerald" : "amber"}
                    />
                    <InfoTile
                      label="IP firma"
                      value={selectedCredit.contratoIp || "-"}
                      detail={selectedCreditCreatedLabel}
                      tone="slate"
                    />
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {selectedCredit.referenciasFamiliares?.length ? (
                      selectedCredit.referenciasFamiliares.map((reference, index) => (
                        <div
                          key={`${reference.nombre}-${index}`}
                          className="rounded-2xl border border-[#d9e7ea] bg-[#f8fdff] px-4 py-4"
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Referencia familiar {index + 1}
                          </p>
                          <p className="mt-2 text-base font-black text-slate-950">
                            {reference.nombre}
                          </p>
                          <p className="mt-1 text-sm text-slate-600">
                            {reference.parentesco} | {reference.telefono}
                          </p>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500 md:col-span-2">
                        Este credito no tiene referencias familiares visibles en el expediente.
                      </div>
                    )}
                  </div>
                </div>

                <div
                  className={[
                    "grid gap-3 md:grid-cols-2 xl:grid-cols-4",
                    deliveryMode ? "hidden" : "",
                  ].join(" ")}
                >
                  <InfoTile
                    label="Referencia pago"
                    value={selectedCredit.referenciaPago || "-"}
                    detail="Dato para recaudo y conciliacion"
                    tone="white"
                  />
                  <InfoTile
                    label="Monto credito"
                    value={currency(selectedCredit.montoCredito)}
                    detail={`Valor equipo: ${currency(selectedCredit.valorEquipoTotal)}`}
                    tone="white"
                  />
                  <InfoTile
                    label="Cuota"
                    value={currency(selectedCredit.valorCuota)}
                    detail={`${selectedCredit.plazoMeses || "-"} cuotas | ${getPaymentFrequencyLabel(
                      selectedCredit.frecuenciaPago
                    )}`}
                    tone="sky"
                  />
                  <InfoTile
                    label="Proximo pago"
                    value={dateTime(selectedCredit.fechaProximoPago)}
                    detail={`Primer pago: ${dateTime(selectedCredit.fechaPrimerPago)}`}
                    tone="amber"
                  />
                  <InfoTile
                    label="Base financiada"
                    value={currency(selectedCredit.saldoBaseFinanciado)}
                    detail={`Interes: ${currency(selectedCredit.valorInteres)}`}
                    tone="slate"
                  />
                  <InfoTile
                    label="Fianza"
                    value={currency(selectedCredit.valorFianza)}
                    detail={`Porcentaje: ${formatPercent(selectedCredit.fianzaPorcentaje)}`}
                    tone="slate"
                  />
                  <InfoTile
                    label="Revision remota"
                    value={dateTime(selectedCredit.equalityLastCheckAt)}
                    detail={`Servicio: ${selectedCredit.equalityService || "-"}`}
                    tone="slate"
                  />
                  <InfoTile
                    label="Garantia"
                    value={dateTime(selectedCredit.warrantyUntil)}
                    detail={`Ventana temporal: ${dateTime(selectedCredit.graceUntil)}`}
                    tone="slate"
                  />
                </div>

                <div
                  className={[
                    "grid gap-3 md:grid-cols-2 xl:grid-cols-4",
                    deliveryMode ? "hidden" : "",
                  ].join(" ")}
                >
                  <InfoTile
                    label="Cuota inicial"
                    value={currency(selectedCredit.cuotaInicial)}
                    detail={`Inicial acumulada cliente: ${currency(clientInitialTotal)}`}
                    tone="emerald"
                  />
                  <InfoTile
                    label="Saldo pendiente"
                    value={currency(selectedCredit.saldoPendiente)}
                    detail={selectedCreditPaymentProgress}
                    tone={selectedCredit.saldoPendiente > 0 ? "amber" : "emerald"}
                  />
                  <InfoTile
                    label="Abonos recibidos"
                    value={currency(selectedCredit.totalAbonado)}
                    detail={`Acumulado cliente: ${currency(clientPaymentsTotal)}`}
                    tone="sky"
                  />
                  <InfoTile
                    label="Recaudo"
                    value={formatPercent(selectedCredit.porcentajeRecaudado)}
                    detail={`${selectedCredit.abonosCount} abono(s) | Ultimo: ${dateTime(
                      selectedCredit.ultimoAbonoAt
                    )}`}
                    tone="slate"
                  />
                </div>

                {canAdmin && !deliveryMode ? (
                  <div className="rounded-[24px] border border-[#d9e7ea] bg-white px-5 py-5 shadow-sm">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Ajuste admin
                        </p>
                        <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                          Corregir plan de pagos
                        </h3>
                      </div>

                      <div className="grid w-full gap-3 md:grid-cols-4 xl:max-w-4xl">
                        <label className="grid gap-2 text-sm font-semibold text-slate-700">
                          Cuotas
                          <select
                            value={planInstallments}
                            onChange={(event) => setPlanInstallments(event.target.value)}
                            className="h-12 rounded-2xl border border-[#ccd7dd] bg-white px-4 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                          >
                            {Array.from(
                              { length: MAX_CREDIT_INSTALLMENTS },
                              (_, index) => String(index + 1)
                            ).map((option) => (
                              <option key={`plan-${option}`} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="grid gap-2 text-sm font-semibold text-slate-700">
                          Frecuencia
                          <select
                            value={planFrequency}
                            onChange={(event) => setPlanFrequency(event.target.value)}
                            className="h-12 rounded-2xl border border-[#ccd7dd] bg-white px-4 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                          >
                            {PAYMENT_FREQUENCY_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="grid gap-2 text-sm font-semibold text-slate-700">
                          Primer pago
                          <input
                            type="date"
                            value={planFirstPaymentDate}
                            onChange={(event) => setPlanFirstPaymentDate(event.target.value)}
                            className="h-12 rounded-2xl border border-[#ccd7dd] bg-white px-4 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                          />
                        </label>

                        <button
                          type="button"
                          onClick={() => void updateCreditPlan()}
                          disabled={updatingPlan || runningCommand !== null}
                          className="h-12 self-end rounded-2xl border border-[#145a5a] bg-[#145a5a] px-4 text-sm font-black text-white shadow-[0_14px_30px_rgba(20,90,90,0.18)] transition hover:bg-[#0f4a4a] disabled:opacity-70"
                        >
                          {updatingPlan ? "Guardando..." : "Guardar plan"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                  </div>
                )}

                {lookupMode && !deliveryMode && (
                  <div
                    ref={historySectionRef}
                    className="rounded-[24px] border border-[#dbe5ec] bg-white px-5 py-5 shadow-sm"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Historial del cliente
                        </p>
                        <h3 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                          Creditos, documentos y acciones
                        </h3>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Se muestran los creditos del mismo documento, telefono o nombre que estan dentro de tu alcance.
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => openPaymentsForCredit()}
                          className="rounded-2xl border border-[#145a5a] bg-[#145a5a] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0f4a4a]"
                        >
                          Abrir abonos
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadExpedientePdf()}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Expediente PDF
                        </button>
                        <button
                          type="button"
                          onClick={() => void openFirmaSeguroSignedDocument()}
                          disabled={firmaSeguroRefreshing}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          {firmaSeguroRefreshing ? "Consultando..." : "Ver FirmaSeguro"}
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPlanPagos()}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Plan de pagos
                        </button>
                      </div>
                    </div>

                    <div className="mt-5 space-y-3">
                      {sameClientCredits.map((credit) => (
                        <div
                          key={`history-${credit.id}`}
                          className={[
                            "rounded-[24px] border px-4 py-4 transition",
                            credit.id === selectedCredit.id
                              ? "border-slate-950 bg-slate-950 text-white shadow-[0_18px_40px_rgba(15,23,42,0.18)]"
                              : "border-[#e6dece] bg-[#fcfaf6]",
                          ].join(" ")}
                        >
                          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-lg font-black tracking-tight">
                                  Credito #{credit.folio}
                                </p>
                                <span
                                  className={[
                                    "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                                    credit.id === selectedCredit.id
                                      ? "border-white/20 bg-white/10 text-white"
                                      : stateBadgeClasses(credit.estado),
                                  ].join(" ")}
                                >
                                  {credit.estado}
                                </span>
                              </div>
                              <p
                                className={[
                                  "mt-2 text-sm",
                                  credit.id === selectedCredit.id
                                    ? "text-slate-300"
                                    : "text-slate-600",
                                ].join(" ")}
                              >
                                Aperturado: {dateTime(credit.fechaCredito)}
                              </p>
                              <p
                                className={[
                                  "mt-1 text-sm",
                                  credit.id === selectedCredit.id
                                    ? "text-slate-300"
                                    : "text-slate-600",
                                ].join(" ")}
                              >
                                Equipo: {credit.referenciaEquipo || credit.imei}
                              </p>
                              <p
                                className={[
                                  "mt-1 text-sm",
                                  credit.id === selectedCredit.id
                                    ? "text-slate-300"
                                    : "text-slate-600",
                                ].join(" ")}
                              >
                                Sede: {credit.sede.nombre} | Asesor:{" "}
                                {credit.vendedor?.nombre || credit.usuario.nombre}
                              </p>
                            </div>

                            <div className="grid gap-2 text-sm xl:text-right">
                              <p className={credit.id === selectedCredit.id ? "text-slate-300" : "text-slate-600"}>
                                Valor: <span className="font-bold">{currency(credit.montoCredito)}</span>
                              </p>
                              <p className={credit.id === selectedCredit.id ? "text-slate-300" : "text-slate-600"}>
                                Inicial: <span className="font-bold">{currency(credit.cuotaInicial)}</span>
                              </p>
                              <p className={credit.id === selectedCredit.id ? "text-slate-300" : "text-slate-600"}>
                                Pendiente: <span className="font-bold">{currency(credit.saldoPendiente)}</span>
                              </p>
                              <p className={credit.id === selectedCredit.id ? "text-slate-300" : "text-slate-600"}>
                                Proximo pago: <span className="font-bold">{dateTime(credit.fechaProximoPago)}</span>
                              </p>
                              <p className={credit.id === selectedCredit.id ? "text-slate-300" : "text-slate-600"}>
                                Docs: <span className="font-bold">{credit.contratoListo ? "Completos" : "Pendientes"}</span>
                              </p>
                            </div>
                          </div>

                          <div className="mt-4 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => openPaymentsForCredit(credit.id)}
                              className={[
                                "rounded-2xl px-4 py-2.5 text-sm font-semibold transition",
                                credit.id === selectedCredit.id
                                  ? "border border-white/15 bg-white/10 text-white hover:bg-white/16"
                                  : "border border-[#145a5a] bg-[#145a5a] text-white hover:bg-[#0f4a4a]",
                              ].join(" ")}
                            >
                              Abono
                            </button>
                            <button
                              type="button"
                              onClick={() => openLookupDetail(credit.id)}
                              className={[
                                "rounded-2xl border px-4 py-2.5 text-sm font-semibold transition",
                                credit.id === selectedCredit.id
                                  ? "border-white/15 bg-white/10 text-white hover:bg-white/16"
                                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                              ].join(" ")}
                            >
                              Ver detalle
                            </button>
                            <button
                              type="button"
                              onClick={() => createNewSaleFromClient(credit.id)}
                              className={[
                                "rounded-2xl border px-4 py-2.5 text-sm font-semibold transition",
                                credit.id === selectedCredit.id
                                  ? "border-white/15 bg-white/10 text-white hover:bg-white/16"
                                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                              ].join(" ")}
                            >
                              Nueva venta
                            </button>
                            <button
                              type="button"
                              onClick={() => downloadExpedientePdf(credit.id)}
                              className={[
                                "rounded-2xl border px-4 py-2.5 text-sm font-semibold transition",
                                credit.id === selectedCredit.id
                                  ? "border-white/15 bg-white/10 text-white hover:bg-white/16"
                                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                              ].join(" ")}
                            >
                              Expediente PDF
                            </button>
                            <button
                              type="button"
                              onClick={() => void openFirmaSeguroSignedDocument(credit.id)}
                              disabled={firmaSeguroRefreshing}
                              className={[
                                "rounded-2xl border px-4 py-2.5 text-sm font-semibold transition",
                                credit.id === selectedCredit.id
                                  ? "border-white/15 bg-white/10 text-white hover:bg-white/16 disabled:opacity-40"
                                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50",
                              ].join(" ")}
                            >
                              FirmaSeguro
                            </button>
                            <button
                              type="button"
                              onClick={() => downloadPlanPagos(credit.id)}
                              className={[
                                "rounded-2xl border px-4 py-2.5 text-sm font-semibold transition",
                                credit.id === selectedCredit.id
                                  ? "border-white/15 bg-white/10 text-white hover:bg-white/16"
                                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                              ].join(" ")}
                            >
                              Plan de pagos
                            </button>
                            <button
                              type="button"
                              onClick={() => downloadPazYSalvo(credit.id)}
                              disabled={credit.saldoPendiente > 0}
                              className={[
                                "rounded-2xl border px-4 py-2.5 text-sm font-semibold transition",
                                credit.id === selectedCredit.id
                                  ? "border-white/15 bg-white/10 text-white hover:bg-white/16 disabled:opacity-40"
                                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50",
                              ].join(" ")}
                            >
                              Emitir paz y salvo
                            </button>
                            {credit.id === selectedCredit.id ? (
                              <button
                                type="button"
                                onClick={() => void runCommand(selectedCreditLockCommand)}
                                disabled={runningCommand !== null}
                                className="rounded-2xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/16 disabled:opacity-50"
                              >
                                {selectedCreditLockButtonLabel}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <section
          className={
            paymentsView
              ? selectedCredit
                ? "mt-6"
                : "hidden"
              : lookupMode && showResultsPanel
                ? deliveryMode
                  ? activeSearch && !selectedCredit
                    ? "mt-6"
                    : "hidden"
                  : "mt-8"
                : adminFactoryAssistMode && showResultsPanel
                  ? "mt-6"
                : createClientMode
                ? "hidden"
                : "hidden"
          }
        >
          {showResultsPanel && !paymentsView && (
          <div className="rounded-[30px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                  {paymentsView
                    ? "Seleccion de cliente"
                    : deliveryMode
                      ? "Estado de entrega"
                      : adminFactoryAssistMode
                        ? "Asistencia admin"
                      : "Clientes / creditos"}
                </div>
                <h2 className="mt-4 text-2xl font-black tracking-tight text-slate-950">
                  {paymentsView
                    ? "Credito encontrado"
                    : deliveryMode
                      ? "Resultado de la consulta"
                      : adminFactoryAssistMode
                        ? "Casos encontrados"
                      : "Resultados de busqueda"}
                </h2>
              </div>

              <button
                type="button"
                onClick={() => {
                  void loadCredits(true, activeSearch);
                  if (adminFactoryAssistMode) {
                    void loadDrafts(activeSearch);
                  }
                }}
                disabled={loadingList || loadingDrafts}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
              >
                {loadingList || loadingDrafts ? "Actualizando..." : "Recargar"}
              </button>
            </div>

            <p className="mt-3 text-sm leading-6 text-slate-600">
              {paymentsView
                ? activeSearch
                  ? `Mostrando coincidencias para "${activeSearch}".`
                  : "Selecciona un cliente para abrir la vista de recaudo."
                : activeSearch
                  ? `Mostrando coincidencias para "${activeSearch}".`
                  : adminFactoryAssistMode
                    ? "Busca por cedula o IMEI para abrir el expediente del caso."
                    : lookupMode
                    ? deliveryMode
                      ? "Sin filtro activo. Ingresa cedula o IMEI para validar la entrega."
                      : "Sin filtro activo. La vista queda vacia hasta que busques un cliente o credito."
                    : "Sin filtro activo. Se muestran los creditos mas recientes dentro de tu alcance."}
            </p>

            <div className="mt-5 space-y-3">
              {loadingDrafts && adminFactoryAssistMode ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                  Buscando borradores en proceso...
                </div>
              ) : null}

              {!credits.length &&
              !loadingList &&
              !loadingDrafts &&
              (!adminFactoryAssistMode || !draftSearchResults.length) ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                  {deliveryMode
                    ? "No encontramos un credito con esa cedula o IMEI."
                    : adminFactoryAssistMode
                      ? "No encontramos borradores ni creditos guardados con esa cedula o IMEI."
                    : "No encontramos clientes o creditos con ese criterio de busqueda."}
                </div>
              ) : (
                <>
                {adminFactoryAssistMode
                  ? draftSearchResults.map((draft) => (
                      <button
                        key={`draft-${draft.id}`}
                        type="button"
                        onClick={() => openAdminAssistanceForDraft(draft)}
                        className="w-full rounded-[24px] border border-emerald-200 bg-emerald-50 px-4 py-4 text-left text-emerald-950 transition hover:-translate-y-0.5 hover:shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
                              Borrador #{draft.id} - paso {draft.currentStep}
                            </p>
                            <p className="mt-2 text-lg font-black tracking-tight">
                              {draft.clienteNombre || "Cliente en captura"}
                            </p>
                            <p className="mt-1 text-sm text-emerald-800">
                              {draft.clienteDocumento || draft.clienteTelefono || "Sin documento aun"}
                            </p>
                            <p className="mt-1 text-sm text-emerald-700">
                              {draft.imei || "IMEI pendiente"} - {draft.sede.nombre}
                            </p>
                          </div>

                          <div className="text-right">
                            <span className="rounded-full border border-emerald-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
                              En proceso
                            </span>
                            <p className="mt-3 text-sm font-semibold text-emerald-800">
                              {draft.vendedor?.nombre || draft.usuario.nombre}
                            </p>
                            <p className="mt-1 text-xs text-emerald-700">
                              {draft.updatedAt ? dateTime(draft.updatedAt) : "Sin fecha"}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))
                  : null}

                {credits.map((credit) => (
                  <button
                    key={credit.id}
                    type="button"
                    onClick={() => {
                      if (adminFactoryAssistMode) {
                        openAdminAssistanceForCredit(credit);
                        return;
                      }
                      if (lookupMode) {
                        openLookupCredit(credit.id);
                        return;
                      }
                      setSelectedId(credit.id);
                      if (paymentsView) {
                        setShowPaymentResults(false);
                      }
                    }}
                    className={[
                      "w-full rounded-[24px] border px-4 py-4 text-left transition",
                      selectedId === credit.id
                        ? "border-slate-950 bg-slate-950 text-white shadow-[0_18px_40px_rgba(15,23,42,0.18)]"
                        : "border-[#e6dece] bg-white hover:-translate-y-0.5 hover:shadow-sm",
                    ].join(" ")}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p
                          className={[
                            "text-[11px] font-semibold uppercase tracking-[0.18em]",
                            selectedId === credit.id ? "text-slate-300" : "text-slate-500",
                          ].join(" ")}
                        >
                          {credit.folio}
                        </p>
                        <p className="mt-2 text-lg font-black tracking-tight">
                          {credit.clienteNombre}
                        </p>
                        <p
                          className={[
                            "mt-1 text-sm",
                            selectedId === credit.id ? "text-slate-300" : "text-slate-500",
                          ].join(" ")}
                        >
                          {credit.clienteDocumento || credit.clienteTelefono || "Sin dato principal"}
                        </p>
                        <p
                          className={[
                            "mt-1 text-sm",
                            selectedId === credit.id ? "text-slate-400" : "text-slate-400",
                          ].join(" ")}
                        >
                          {credit.referenciaEquipo || credit.imei}
                        </p>
                      </div>

                      <div className="text-right">
                        <span
                          className={[
                            "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                            selectedId === credit.id
                              ? "border-white/20 bg-white/10 text-white"
                              : stateBadgeClasses(credit.estado),
                          ].join(" ")}
                        >
                          {credit.deliverableReady ? "Entregable" : credit.estado}
                        </span>
                        <p
                          className={[
                            "mt-3 text-sm font-semibold",
                            selectedId === credit.id ? "text-slate-200" : "text-slate-700",
                          ].join(" ")}
                        >
                          Saldo: {currency(credit.saldoPendiente)}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
                </>
              )}
            </div>
          </div>
          )}

          {paymentsView && selectedCredit && (
          <div className="rounded-[30px] border border-[#e1d8ca] bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.06)]">
            {selectedCredit ? (
              <div className="rounded-[26px] border border-emerald-100 bg-[linear-gradient(135deg,#f6fffb_0%,#ffffff_62%)] px-5 py-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">
                      Cliente
                    </p>
                    <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
                      {selectedCredit.clienteNombre}
                    </h2>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs font-black uppercase tracking-[0.12em] text-slate-600">
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1">
                        CC. {selectedCredit.clienteDocumento || selectedCredit.clienteTelefono || "Sin identificacion"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1">
                        {paymentOverview?.paidCount || 0} pagas / {paymentOverview?.pendingCount || 0} pendientes
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex rounded-full bg-[#116b61] px-4 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-white">
                      {paymentOverview?.estadoPago === "MORA"
                        ? "Mora"
                        : paymentOverview?.estadoPago === "PAGADO"
                          ? "Pagado"
                          : "Al dia"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowPaymentResults((current) => !current)}
                      className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                    >
                      {showPaymentResults ? "Ocultar resultados" : "Cambiar cliente"}
                    </button>
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setPaymentsTab("pay")}
                    className={[
                      "rounded-[18px] px-5 py-4 text-center text-base font-black transition",
                      paymentsTab === "pay"
                        ? "bg-[linear-gradient(135deg,#00a884_0%,#116b61_100%)] text-white shadow-[0_18px_34px_rgba(17,107,97,0.24)]"
                        : "border border-emerald-200 bg-white text-[#116b61] hover:bg-emerald-50",
                    ].join(" ")}
                  >
                    Pagar cuota
                  </button>
                  <button
                    type="button"
                    onClick={() => focusHistory()}
                    className={[
                      "rounded-[18px] px-5 py-4 text-center text-base font-black transition",
                      paymentsTab === "history"
                        ? "bg-slate-950 text-white shadow-[0_14px_28px_rgba(15,23,42,0.18)]"
                        : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                    ].join(" ")}
                  >
                    Historial y certificados
                  </button>
                </div>
              </div>
            ) : null}

            {!selectedCredit ? null : (
              <>
                {false && (
                <div className="mt-6 grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-[#e6dece] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Cliente
                    </p>
                    <p className="mt-2 text-lg font-black text-slate-950">
                      {selectedCredit?.clienteNombre}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {selectedCredit?.clienteDocumento || selectedCredit?.clienteTelefono || "Sin identificacion"}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Referencia de pago
                    </p>
                    <p className="mt-2 text-lg font-black text-slate-950">
                      {selectedCredit?.referenciaPago || "-"}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
                      Inicial
                    </p>
                    <p className="mt-2 text-lg font-black text-emerald-900">
                      {currency(paymentOverview?.cuotaInicial || 0)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                      Saldo pendiente
                    </p>
                    <p className="mt-2 text-lg font-black text-amber-900">
                      {currency(paymentOverview?.saldoPendiente || 0)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">
                      Abonos recibidos
                    </p>
                    <p className="mt-2 text-lg font-black text-sky-900">
                      {currency(paymentOverview?.totalAbonado || 0)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Estado de cartera
                    </p>
                    <p className="mt-2 text-lg font-black text-slate-950">
                      {paymentOverview?.estadoPago === "MORA"
                        ? "En mora"
                        : paymentOverview?.estadoPago === "PAGADO"
                          ? "Pagado"
                          : "Al dia"}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {paymentOverview?.paidCount || 0} pagadas ·{" "}
                      {paymentOverview?.pendingCount || 0} pendientes ·{" "}
                      {paymentOverview?.overdueCount || 0} en mora
                    </p>
                  </div>
                </div>
                )}

                {false && (
                <div className="mt-6 rounded-[24px] border border-[#d9e6ea] bg-white px-5 py-5 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Cliente
                      </p>
                      <h3 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                        {selectedCredit?.clienteNombre}
                      </h3>
                      <p className="mt-1 text-sm text-slate-600">
                        {selectedCredit?.clienteDocumento || selectedCredit?.clienteTelefono || "Sin identificacion"}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <span className="inline-flex rounded-full bg-[#ff7a30] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white">
                        {paymentOverview?.estadoPago === "MORA"
                          ? "Mora"
                          : paymentOverview?.estadoPago === "PAGADO"
                            ? "Pagado"
                            : "Al dia"}
                      </span>
                      <span className="inline-flex rounded-full bg-[#111111] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white">
                        {paymentOverview?.overdueCount || 0} en mora
                      </span>
                      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-700">
                        {paymentOverview?.paidCount || 0} pagadas
                      </span>
                      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-700">
                        {paymentOverview?.pendingCount || 0} pendientes
                      </span>
                    </div>
                  </div>
                </div>
                )}

                {paymentsTab === "pay" ? (
                <>
                {paymentBlockedByAnnulment ? (
                  <div className="mt-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-5 text-red-800">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em]">
                      Recaudo bloqueado
                    </p>
                    <h3 className="mt-2 text-2xl font-black text-red-900">
                      Credito anulado
                    </h3>
                    <p className="mt-2 text-sm font-semibold leading-6">
                      Este credito fue anulado. No se pueden registrar cuotas,
                      pagos por Wompi ni movimientos nuevos sobre esta venta.
                    </p>
                  </div>
                ) : null}
                <div className="mt-5 rounded-[28px] border border-emerald-100 bg-[linear-gradient(180deg,#ffffff_0%,#f8fffc_100%)] p-5 shadow-[0_14px_42px_rgba(15,23,42,0.06)]">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">
                        Recaudo
                      </p>
                      <h3 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                        Recibir pago
                      </h3>
                    </div>
                    <p className="text-sm font-semibold text-slate-500">
                      {isEarlyPayoffMode
                        ? "Confirma el capital a liquidar y el valor recibido."
                        : "Selecciona cuotas, define el abono y confirma el valor recibido."}
                    </p>
                  </div>

                  <div className="mt-5 rounded-[24px] border border-emerald-100 bg-white px-5 py-4 shadow-[0_12px_28px_rgba(17,107,97,0.06)]">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-[0.16em] text-emerald-700">
                          Liquidacion anticipada
                        </p>
                        <h4 className="mt-1 text-xl font-black text-slate-950">
                          Pagar hoy
                        </h4>
                        <p className="mt-1 text-sm font-semibold text-slate-500">
                          {earlyPayoffAvailable
                            ? `Capital a recoger: ${currency(earlyPayoffRoundedTotal)}. Se condona ${currency(Number(earlyPayoffSummary?.condonacion || 0))}.`
                            : earlyPayoffSummary?.motivo ||
                              "Disponible solo cuando el credito esta al dia."}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={selectEarlyPayoffPayment}
                        disabled={
                          registeringPayment ||
                          loadingPayments ||
                          paymentBlockedByAnnulment ||
                          !earlyPayoffAvailable
                        }
                        className={[
                          "rounded-[20px] px-5 py-3 text-sm font-black transition",
                          isEarlyPayoffMode
                            ? "bg-slate-950 text-white"
                            : "border border-emerald-200 bg-emerald-50 text-[#116b61] hover:bg-emerald-100",
                          "disabled:cursor-not-allowed disabled:opacity-60",
                        ].join(" ")}
                      >
                        {isEarlyPayoffMode ? "Seleccionado" : "Liquidar hoy"}
                      </button>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-[1fr_0.72fr]">
                    <div className="rounded-[26px] border border-[#0f5654] bg-[linear-gradient(135deg,#0f5654_0%,#11786d_100%)] px-5 py-5 text-white shadow-[0_20px_48px_rgba(15,86,84,0.22)]">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#98ece0]">
                            {isEarlyPayoffMode ? "Modalidad" : "Cuotas seleccionadas"}
                          </p>
                          <p className="mt-2 text-3xl font-black">
                            {isEarlyPayoffMode
                              ? "Pagar hoy"
                              : selectedInstallmentNumbers.length
                                ? selectedInstallmentNumbers.join(", ")
                                : "Ninguna"}
                          </p>
                        </div>
                        <div className="rounded-full bg-[#ff7a30] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white">
                          {isEarlyPayoffMode
                            ? "Capital"
                            : selectedInstallmentsData.some((item) => item.estaEnMora)
                            ? "Con mora"
                            : "Al dia"}
                        </div>
                      </div>
                      <div className="mt-5 rounded-[22px] bg-white px-5 py-4 text-[#082f2b]">
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#0f766e]">
                          {isEarlyPayoffMode ? "Capital a liquidar" : "Total seleccionado"}
                        </p>
                        <p className="mt-1 text-4xl font-black tracking-tight">
                          {currency(
                            isEarlyPayoffMode
                              ? earlyPayoffRoundedTotal
                              : selectedInstallmentTotal
                          )}
                        </p>
                      </div>
                      {isEarlyPayoffMode && earlyPayoffSummary ? (
                        <p className="mt-3 text-xs font-semibold text-[#d5fff7]">
                          Saldo anterior {currency(earlyPayoffSummary.saldoObligacion)}.
                          Condonacion: {currency(earlyPayoffSummary.condonacion)}.
                        </p>
                      ) : null}
                      {selectedOverdueTotal > 0 ? (
                        <p className="mt-3 text-xs font-semibold text-[#ffd5bd]">
                          Mora dentro de la seleccion: {currency(selectedOverdueTotal)}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {isEarlyPayoffMode ? (
                          <span className="text-xs font-semibold text-[#c6e8e3]">
                            Este recaudo cierra la obligacion cobrando solo capital.
                          </span>
                        ) : selectedInstallmentsData.length ? (
                          selectedInstallmentsData.map((item) => (
                            <span
                              key={item.numero}
                              className={[
                                "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em]",
                                item.estaEnMora
                                  ? "border-[#ffb08a] bg-[#ffefe4] text-[#ff7a30]"
                                  : item.estado === "PAGO"
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border-white/20 bg-white/10 text-white",
                              ].join(" ")}
                            >
                              Cuota {item.numero}: {item.estaEnMora ? "MORA" : item.estado}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs font-semibold text-[#c6e8e3]">
                            Marca una cuota para ver el detalle del abono.
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="rounded-[26px] border border-slate-200 bg-white px-5 py-5 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
                      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
                        Abono y caja
                      </p>

                      <div className="mt-4 grid gap-4">
                        <div>
                          <label className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                            Abonar un valor distinto a la cuota
                          </label>
                          <input
                            value={currencyInputValue(paymentValue)}
                            onChange={(event) =>
                              setPaymentValue(String(event.target.value || "").replace(/\D/g, ""))
                            }
                            inputMode="numeric"
                            placeholder="$ 50.000"
                            disabled={paymentBlockedByAnnulment || isEarlyPayoffMode}
                            className="w-full rounded-[20px] border border-slate-200 bg-[#fbfcfb] px-4 py-3 text-lg font-black text-slate-950 outline-none transition focus:border-[#116b61] focus:ring-4 focus:ring-emerald-100"
                          />
                        </div>

                        <div className="rounded-[22px] border border-emerald-100 bg-[linear-gradient(180deg,#ffffff_0%,#f2fffb_100%)] p-3 shadow-[0_12px_26px_rgba(17,107,97,0.08)]">
                          <label className="mb-2 block text-sm font-black text-[#0f5654]">
                            Valor recibido
                          </label>
                          <input
                            value={currencyInputValue(receivedPaymentValue)}
                            onChange={(event) =>
                              setReceivedPaymentValue(String(event.target.value || "").replace(/\D/g, ""))
                            }
                            inputMode="numeric"
                            placeholder="$ 0"
                            disabled={paymentBlockedByAnnulment}
                            className="w-full rounded-[20px] border-2 border-[#18b995] bg-white px-4 py-5 text-2xl font-black text-slate-950 outline-none transition focus:border-[#00a884] focus:ring-4 focus:ring-emerald-100"
                          />
                        </div>
                      </div>
                      {selectedInstallmentNumbers.length > 0 || isEarlyPayoffMode ? (
                        <div
                          className={[
                            "mt-4 rounded-[20px] border px-4 py-3",
                            selectedInstallmentCoverageShortfall > 0 ||
                            paymentOverCreditAmount > 0 ||
                            paymentShortfallAmount > 0
                              ? "border-red-200 bg-red-50 text-red-800"
                              : paymentChangeAmount > 0
                                ? "border-amber-200 bg-amber-50 text-amber-900"
                                : paymentAdvanceAmount > 0
                              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                                  : "border-slate-200 bg-slate-50 text-slate-700",
                          ].join(" ")}
                        >
                          <p className="text-[11px] font-black uppercase tracking-[0.16em]">
                            {isEarlyPayoffMode && paymentChangeAmount <= 0 && paymentOverCreditAmount <= 0
                              ? "Liquidacion lista"
                              : paymentOverCreditAmount > 0
                              ? "Supera saldo pendiente"
                              : selectedInstallmentCoverageShortfall > 0
                                ? "Abono insuficiente"
                                : paymentShortfallAmount > 0
                                ? "Falta por recibir"
                                : paymentChangeAmount > 0
                                  ? "Devolver al cliente"
                                  : paymentAdvanceAmount > 0
                                    ? "Abono a proximas cuotas"
                                    : "Valor exacto"}
                          </p>
                          <p className="mt-1 text-2xl font-black">
                            {isEarlyPayoffMode && paymentChangeAmount <= 0 && paymentOverCreditAmount <= 0
                              ? currency(earlyPayoffRoundedTotal)
                              : paymentOverCreditAmount > 0
                              ? currency(paymentOverCreditAmount)
                              : selectedInstallmentCoverageShortfall > 0
                                ? currency(selectedInstallmentCoverageShortfall)
                                : paymentShortfallAmount > 0
                                  ? currency(paymentShortfallAmount)
                                  : paymentChangeAmount > 0
                                    ? currency(paymentChangeAmount)
                                    : paymentAdvanceAmount > 0
                                      ? currency(paymentAdvanceAmount)
                                      : "$ 0"}
                          </p>
                          {paymentChangeAmount > 0 ? (
                            <p className="mt-1 text-xs font-semibold">
                              El cliente entrega {currency(receivedPaymentAmount)} y el abono aplicado es {currency(paymentAmountToApply)}.
                            </p>
                          ) : null}
                          {isEarlyPayoffMode && paymentChangeAmount <= 0 ? (
                            <p className="mt-1 text-xs font-semibold">
                              Se aplicara el capital pendiente y el sistema cerrara el credito.
                            </p>
                          ) : null}
                          {paymentAdvanceAmount > 0 ? (
                            <p className="mt-1 text-xs font-semibold">
                              Despues de cubrir la seleccion, {currency(paymentAdvanceAmount)} se aplica a proximas cuotas.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Metodo de pago
                      </label>
                      <select
                        value={paymentMethod}
                        onChange={(event) => setPaymentMethod(event.target.value)}
                        disabled={paymentBlockedByAnnulment}
                        className="w-full rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#116b61] focus:ring-4 focus:ring-emerald-100"
                      >
                        <option value="EFECTIVO">Efectivo</option>
                        <option value="TRANSFERENCIA">Transferencia</option>
                        <option value="NEQUI">Nequi</option>
                        <option value="DAVIPLATA">Daviplata</option>
                        <option value="OTRO">Otro</option>
                      </select>
                    </div>
                  </div>

                  <div className="mt-4">
                    <label className="mb-2 block text-sm font-semibold text-slate-700">
                      Observacion
                    </label>
                    <input
                      value={paymentObservation}
                      onChange={(event) => setPaymentObservation(event.target.value)}
                      placeholder="Detalle opcional del pago"
                      disabled={paymentBlockedByAnnulment}
                      className="w-full rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-[#116b61] focus:ring-4 focus:ring-emerald-100"
                    />
                  </div>

                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void registerPayment()}
                      disabled={
                        registeringPayment ||
                        loadingPayments ||
                        paymentBlockedByAnnulment ||
                        paymentSubmitBlocked
                      }
                      className="rounded-[22px] bg-[linear-gradient(135deg,#00a884_0%,#116b61_100%)] px-8 py-4 text-lg font-black text-white shadow-[0_18px_35px_rgba(17,107,97,0.28)] transition hover:-translate-y-0.5 hover:shadow-[0_22px_42px_rgba(17,107,97,0.34)] disabled:translate-y-0 disabled:opacity-70"
                    >
                      {paymentBlockedByAnnulment
                        ? "Credito anulado"
                          : registeringPayment
                            ? "Registrando..."
                          : isEarlyPayoffMode
                            ? `Liquidar ${currency(earlyPayoffRoundedTotal)}`
                          : paymentAmountToApply > 0
                            ? `Pagar ${currency(paymentAmountToApply)}`
                            : "Pagar"}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPaymentValue("");
                        setReceivedPaymentValue("");
                        setPaymentObservation("");
                        setPaymentMethod("EFECTIVO");
                        setPaymentRegisterMode("INSTALLMENTS");
                        setSelectedInstallmentNumbers([]);
                      }}
                      disabled={registeringPayment}
                      className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                    >
                      Limpiar formulario
                    </button>
                  </div>
                </div>

                <div className="mt-6 rounded-[24px] border border-[#d9e6ea] bg-white p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                        Plan de pagos
                      </p>
                      <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                        Selecciona las cuotas que se van a pagar
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadPlanPagos()}
                      className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                    >
                      Descargar plan
                    </button>
                  </div>

                  <div className="mt-4 overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
                    <table className="min-w-full text-left text-sm">
                      <thead className="bg-[#171717] text-[11px] uppercase tracking-[0.16em] text-white">
                        <tr>
                          <th className="px-3 py-4">Cuota</th>
                          <th className="px-3 py-4">Fecha</th>
                          <th className="px-3 py-4">Valor</th>
                          <th className="px-3 py-4">Abonado</th>
                          <th className="px-3 py-4">Saldo</th>
                          <th className="px-3 py-4">Estado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {(paymentOverview?.plan || []).map((item, index) => (
                          <tr
                            key={item.numero}
                            className={index % 2 === 0 ? "bg-[#eef8f9]" : "bg-white"}
                          >
                            <td className="px-3 py-3 font-bold text-slate-950">
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={selectedInstallmentSet.has(String(item.numero))}
                                  disabled={
                                    item.saldoPendiente <= 0 ||
                                    registeringPayment ||
                                    paymentBlockedByAnnulment ||
                                    isEarlyPayoffMode
                                  }
                                  onChange={(event) =>
                                    updateSelectedInstallments(
                                      item.numero,
                                      event.target.checked
                                    )
                                  }
                                  className="h-4 w-4 rounded border-slate-300 text-[#145a5a] focus:ring-[#145a5a]"
                                />
                                <span>{item.numero}</span>
                              </label>
                            </td>
                            <td className="px-3 py-3 text-slate-600">
                              {dateOnly(item.fechaVencimiento)}
                            </td>
                            <td className="px-3 py-3 text-slate-600">
                              {currency(item.valorProgramado)}
                            </td>
                            <td className="px-3 py-3 text-slate-600">
                              {currency(item.valorAbonado)}
                            </td>
                            <td className="px-3 py-3 font-bold text-slate-950">
                              {currency(item.saldoPendiente)}
                            </td>
                            <td className="px-3 py-3">
                              <span
                                className={[
                                  "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.14em]",
                                  item.estaEnMora
                                    ? "border-red-200 bg-red-50 text-red-700"
                                    : item.estado === "PAGO"
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                      : "border-amber-200 bg-amber-50 text-amber-700",
                                ].join(" ")}
                              >
                                {item.estaEnMora ? "MORA" : item.estado}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!paymentOverview?.plan?.length ? (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                        El plan se cargara al consultar los abonos del credito.
                      </div>
                    ) : null}
                  </div>
                </div>
                </>
                ) : (

                <div ref={historySectionRef} className="mt-6 grid gap-6 xl:grid-cols-[0.82fr_1.18fr]">
                  <div className="rounded-[24px] border border-[#d9e6ea] bg-white p-5 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                      Certificados y documentos
                    </p>
                    <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                      Documentos del credito
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Aqui puede consultar el contrato, el plan de pagos y el paz y salvo cuando el credito ya no tenga saldo pendiente.
                    </p>

                    <div className="mt-5 space-y-3">
                      <button
                        type="button"
                        onClick={() => downloadExpedientePdf()}
                        className="flex w-full items-center justify-between rounded-[18px] border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                      >
                        <span>Contrato y documentos firmados</span>
                        <span className="text-xs uppercase tracking-[0.14em] text-slate-400">
                          PDF
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void openFirmaSeguroSignedDocument()}
                        disabled={firmaSeguroRefreshing}
                        className="flex w-full items-center justify-between rounded-[18px] border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <span>
                          {firmaSeguroRefreshing
                            ? "Consultando FirmaSeguro"
                            : "Ver PDF firmado en FirmaSeguro"}
                        </span>
                        <span className="text-xs uppercase tracking-[0.14em] text-slate-400">
                          PDF
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadPlanPagos()}
                        className="flex w-full items-center justify-between rounded-[18px] border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                      >
                        <span>Plan de pagos</span>
                        <span className="text-xs uppercase tracking-[0.14em] text-slate-400">
                          PDF
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadPazYSalvo()}
                        disabled={(paymentOverview?.saldoPendiente ?? selectedCredit.saldoPendiente) > 0}
                        className="flex w-full items-center justify-between rounded-[18px] border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span>Paz y salvo</span>
                        <span className="text-xs uppercase tracking-[0.14em] text-slate-400">
                          PDF
                        </span>
                      </button>
                    </div>

                    <p className="mt-4 text-xs font-medium text-slate-500">
                      {(paymentOverview?.saldoPendiente ?? selectedCredit.saldoPendiente) > 0
                        ? "El paz y salvo se habilita cuando el saldo pendiente sea cero."
                        : "El paz y salvo ya esta disponible para este credito."}
                    </p>
                  </div>

                  <div className="rounded-[24px] border border-[#d9e6ea] bg-white p-5 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
                    <div className="flex items-end justify-between gap-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Historial de abonos
                        </p>
                        <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                          Pagos realizados
                        </h3>
                      </div>

                      <button
                        type="button"
                        onClick={() => selectedCredit && void loadPayments(selectedCredit.id)}
                        disabled={!selectedCredit || loadingPayments}
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                      >
                        {loadingPayments ? "Actualizando..." : "Recargar"}
                      </button>
                    </div>

                    <div className="mt-4 space-y-3">
                      {!payments.length && !loadingPayments ? (
                        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                          Aun no hay abonos registrados para este credito.
                        </div>
                      ) : (
                        payments.map((payment) => {
                          const paymentAnnulled =
                            String(payment.estado || "").toUpperCase() === "ANULADO";

                          return (
                            <div
                              key={payment.id}
                              className={[
                                "rounded-[22px] border px-4 py-4",
                                paymentAnnulled
                                  ? "border-red-200 bg-red-50/60"
                                  : "border-[#e6dece] bg-[#fcfaf6]",
                              ].join(" ")}
                            >
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                      {dateTime(payment.fechaAbono)}
                                    </p>
                                    {paymentAnnulled ? (
                                      <span className="rounded-full border border-red-200 bg-white px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-red-600">
                                        Anulado
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="mt-2 text-lg font-black text-slate-950">
                                    {currency(payment.valor)}
                                  </p>
                                  <p className="mt-1 text-sm text-slate-500">
                                    Metodo: {paymentMethodLabel(payment.metodoPago)}
                                  </p>
                                  <p className="mt-1 text-sm text-slate-500">
                                    Recibido por {payment.usuario.nombre}
                                  </p>
                                  {paymentAnnulled && payment.anulacionMotivo ? (
                                    <p className="mt-1 text-sm font-semibold text-red-600">
                                      Motivo: {payment.anulacionMotivo}
                                    </p>
                                  ) : null}
                                </div>

                                <div className="flex w-full max-w-sm flex-col gap-2">
                                  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
                                    {payment.observacion || "Sin observacion"}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => downloadPaymentReceipt(payment)}
                                    className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                                  >
                                    Reimprimir recibo
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
                )}
              </>
            )}
          </div>
          )}
        </section>

        <section
          className={[
            "mt-8 rounded-[30px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]",
            paymentsView || createClientMode || lookupMode || simulatorMode ? "hidden" : "",
          ].join(" ")}
        >
          <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
            {canAdmin ? "Comandos administrativos" : "Alcance vendedor"}
          </div>
          <h2 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
            {canAdmin ? "Panel operativo del credito" : "Inscripcion, busqueda y recaudo"}
          </h2>

          {canAdmin ? (
            <>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                Estos comandos son internos de la fabrica de creditos. Sirven para operar la vida comercial del caso y combinarlo con el estado remoto del equipo en Equality.
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-[0.8fr_1.2fr]">
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Nueva fecha de pago
                  </label>
                  <input
                    type="date"
                    value={nextDueDate}
                    onChange={(event) => setNextDueDate(event.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Observacion administrativa
                  </label>
                  <input
                    value={observacionAdmin}
                    onChange={(event) => setObservacionAdmin(event.target.value)}
                    placeholder="Detalle interno del caso"
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void runCommand("consult-device")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  {runningCommand === "consult-device" ? "Consultando..." : "Consultar Celular"}
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("payment-reference")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  Referencia de Pago
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("toggle-stolen-lock")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  Des/Bloquear Robo
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("update-due-date")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  Actualizar Fecha
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("extend-1h")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  1 Hora
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("extend-24h")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  24 Horas
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("extend-48h")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  48 Horas
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("warranty-15d")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  Garantia 15D
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("warranty-20d")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  Garantia 20D
                </button>

                <button
                  type="button"
                  onClick={() => void runCommand("remove-lock")}
                  disabled={!selectedCredit || runningCommand !== null}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  Quitar Candado
                </button>

                <button
                  type="button"
                  onClick={() => downloadPazYSalvo()}
                  disabled={!selectedCredit}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                >
                  Descargar Paz y Salvo
                </button>
              </div>

              <div className="mt-6 rounded-[24px] border border-[#d9e7ea] bg-white px-5 py-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0f766e]">
                      Push app clientes
                    </p>
                    <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                      Enviar notificacion individual
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-slate-500">
                      Llega solo si el cliente ya abrio la app nueva y tiene token activo.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => void sendManualPush()}
                    disabled={!selectedCredit || sendingManualPush}
                    className="rounded-2xl border border-[#145a5a] bg-[#145a5a] px-5 py-3 text-sm font-black text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
                  >
                    {sendingManualPush ? "Enviando..." : "Enviar push"}
                  </button>
                </div>

                <div className="mt-4 grid gap-3 lg:grid-cols-[0.7fr_0.9fr_1.4fr]">
                  <label className="grid gap-2 text-sm font-semibold text-slate-700">
                    Tipo
                    <select
                      value={manualPushPreset}
                      onChange={(event) =>
                        setManualPushPreset(event.target.value as ManualPushPreset)
                      }
                      className="h-12 rounded-2xl border border-[#ccd7dd] bg-white px-4 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                    >
                      <option value="internet">Mantener internet</option>
                      <option value="mora">Cuota vencida</option>
                      <option value="efecty">Pago EFECTY</option>
                      <option value="custom">Personalizado</option>
                    </select>
                  </label>

                  <label className="grid gap-2 text-sm font-semibold text-slate-700">
                    Titulo
                    <input
                      value={manualPushTitle}
                      onChange={(event) => setManualPushTitle(event.target.value)}
                      placeholder="FINSER PAY"
                      className="h-12 rounded-2xl border border-[#ccd7dd] bg-white px-4 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                    />
                  </label>

                  <label className="grid gap-2 text-sm font-semibold text-slate-700">
                    Mensaje personalizado
                    <input
                      value={manualPushBody}
                      onChange={(event) => setManualPushBody(event.target.value)}
                      placeholder="Solo se usa cuando eliges Personalizado"
                      className="h-12 rounded-2xl border border-[#ccd7dd] bg-white px-4 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#13bfa6] focus:ring-4 focus:ring-[#13bfa6]/10"
                    />
                  </label>
                </div>
              </div>
            </>
          ) : (
            <div className="mt-6 rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-5 text-sm leading-6 text-amber-900">
              Tu vista queda limitada a buscar clientes, registrar abonos, generar el credito, inscribir el equipo y confirmar si ya esta 100% entregable. Los comandos administrativos solo aparecen para el rol `ADMIN`.
            </div>
          )}
        </section>
        <CameraCaptureModal
          open={cameraSlot !== null}
          slot={cameraSlot}
          onClose={() => setCameraSlot(null)}
          onCapture={(value, slot, audit) =>
            void handleCameraCaptureWithAudit(value, slot, audit)
          }
        />
      </div>
    </div>
  );
}
