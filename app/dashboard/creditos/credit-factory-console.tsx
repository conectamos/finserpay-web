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
} from "react";
import FinserBrand from "@/app/_components/finser-brand";
import {
  calculateCreditCharges,
  calculateFinancedBalance,
  calculateRequiredInitialPayment,
  DEFAULT_FIANCO_SURETY_PERCENTAGE,
  DEFAULT_LEGAL_CONSUMER_RATE_EA,
  DEFAULT_LEGAL_RATE_REFERENCE,
  generatePagareNumber,
  getDefaultFirstPaymentDate,
  MAX_DEVICE_FINANCING_BASE,
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
  abonosCount: number;
  ultimoAbonoAt: string | null;
  createdAt: string;
  updatedAt: string;
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

type CreditListResponse = {
  canAdmin: boolean;
  scope: string;
  search?: string;
  items: CreditItem[];
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

type CreateCreditResponse = {
  ok: boolean;
  warning?: string;
  item: CreditItem;
  deliveryStatus: DeliveryStatus;
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

type CreditPaymentItem = {
  id: number;
  creditoId: number;
  valor: number;
  metodoPago: string;
  observacion: string | null;
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
  estado: "PAGADA" | "AL_DIA" | "MORA";
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
    plan?: PaymentPlanInstallment[];
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
    plan?: PaymentPlanInstallment[];
    abonosCount: number;
    ultimoAbonoAt: string | null;
  };
};

type NoticeTone = "amber" | "emerald" | "red" | "slate";

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
  | "update-due-date"
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

const FLEXIBLE_WIZARD_FOR_TESTING = true;

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

function dateTime(value: string | null) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("es-CO");
}

function dateOnly(value: string | null) {
  if (!value) {
    return "";
  }

  return new Date(value).toISOString().slice(0, 10);
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
    throw new Error("El video es demasiado pesado. Vuelve a grabarlo en 7 segundos.");
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
  const [secondsLeft, setSecondsLeft] = useState(7);
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
      setSecondsLeft(7);
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
    setSecondsLeft(7);

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
      setSecondsLeft(7);

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
          Math.min(7, Math.round((Date.now() - startedAt) / 1000))
        );
        finishVideoCapture(elapsedSeconds);
      };
      recorder.start(250);

      countdownRef.current = window.setInterval(() => {
        setSecondsLeft((current) => {
          if (current <= 1) {
            if (countdownRef.current) {
              window.clearInterval(countdownRef.current);
              countdownRef.current = null;
            }
            if (recorder.state !== "inactive") {
              recorder.stop();
            }
            return 0;
          }

          return current - 1;
        });
      }, 1000);
    } catch (recordError) {
      setRecording(false);
      setSecondsLeft(7);
      setError(
        recordError instanceof Error
          ? recordError.message
          : "No se pudo iniciar la grabacion de video."
      );
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
                ? "Graba un video corto donde el cliente diga: YO [NOMBRE] APRUEBO LA COMPRA CON FINSERPAY."
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
              onClick={startVideoRecording}
              disabled={starting || Boolean(error) || recording}
              className="rounded-2xl bg-[#1f8f65] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#18724f] disabled:opacity-70"
            >
              {recording
                ? `Grabando... ${secondsLeft}s`
                : "Grabar video de 7 segundos"}
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
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    setPreviewFailed(false);
  }, [value]);

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
        onError={() => setPreviewFailed(true)}
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration;
          if (!Number.isFinite(duration) || duration <= 0) {
            setPreviewFailed(true);
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

export default function CreditFactoryConsole({
  initialSession,
  initialSeller = null,
  view = "factory",
  initialSearch = "",
  initialSelectedId = null,
  entryMode = "default",
}: {
  initialSession: SessionUser;
  initialSeller?: SellerSessionProfile;
  view?: "factory" | "payments" | "lookup";
  initialSearch?: string;
  initialSelectedId?: number | null;
  entryMode?: "default" | "create-client";
}) {
  const canAdmin = String(initialSession.rolNombre || "").toUpperCase() === "ADMIN";
  const canSupervisor = !canAdmin && initialSeller?.tipoPerfil === "SUPERVISOR";
  const canViewSavedCredits = canAdmin || canSupervisor;
  const paymentsView = view === "payments";
  const lookupView = view === "lookup";
  const createClientMode = !paymentsView && !lookupView && entryMode === "create-client";
  const lookupMode = lookupView && canViewSavedCredits;
  const showSearchSection = paymentsView || lookupMode;
  const pathname = usePathname();
  const normalizedInitialSearch = initialSearch.trim();
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
  const [showPaymentResults, setShowPaymentResults] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(true);
  const [showLookupDetail, setShowLookupDetail] = useState(false);
  const [documentRenderDate, setDocumentRenderDate] = useState("");
  const [documentRenderDateTime, setDocumentRenderDateTime] = useState("");
  const selectedCreditPanelRef = useRef<HTMLDivElement | null>(null);
  const lookupDetailPanelRef = useRef<HTMLDivElement | null>(null);
  const historySectionRef = useRef<HTMLDivElement | null>(null);
  const [wizardStep, setWizardStep] = useState(1);
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
  const [imei, setImei] = useState("");
  const [valorEquipoTotal, setValorEquipoTotal] = useState("");
  const [cuotaInicial, setCuotaInicial] = useState("");
  const [plazoMeses, setPlazoMeses] = useState("12");
  const [tasaInteresEa, setTasaInteresEa] = useState(
    String(DEFAULT_LEGAL_CONSUMER_RATE_EA)
  );
  const [fianzaPorcentaje, setFianzaPorcentaje] = useState(
    String(DEFAULT_FIANCO_SURETY_PERCENTAGE)
  );
  const [fechaPrimerPago, setFechaPrimerPago] = useState(getDefaultFirstPaymentDate());
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
  const [paymentValue, setPaymentValue] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("EFECTIVO");
  const [paymentObservation, setPaymentObservation] = useState("");
  const [selectedInstallmentNumber, setSelectedInstallmentNumber] = useState("");
  const [payments, setPayments] = useState<CreditPaymentItem[]>([]);
  const [paymentSummary, setPaymentSummary] = useState<CreditPaymentsResponse["credito"] | null>(null);
  const [deliveryValidation, setDeliveryValidation] =
    useState<DeliveryValidationState | null>(null);
  const [validatingDelivery, setValidatingDelivery] = useState(false);
  const mobileCaptureAppliedRef = useRef<string>("");
  const [cedulaValidation, setCedulaValidation] = useState<CedulaValidationState>({
    status: "idle",
    summary:
      "Carga frente y respaldo de la cedula y valida que coincidan con los datos ingresados.",
    checkedAt: null,
    checks: [],
  });

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
  const clientPendingTotal = sameClientCredits.reduce(
    (total, item) => total + item.saldoPendiente,
    0
  );
  const clientInitialTotal = sameClientCredits.reduce(
    (total, item) => total + item.cuotaInicial,
    0
  );
  const clientPaymentsTotal = sameClientCredits.reduce(
    (total, item) => total + item.totalAbonado,
    0
  );
  const clientDocumentsCount = sameClientCredits.filter(
    (item) => item.contratoAceptadoAt || item.pagareAceptadoAt
  ).length;
  const clientPrimaryStatus =
    selectedCredit?.saldoPendiente && selectedCredit.saldoPendiente > 0
      ? "Con saldo"
      : selectedCredit?.pazYSalvoEmitidoAt
        ? "Paz y salvo"
        : selectedCredit?.estado || "Activo";
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
  const cuotaInicialNumero = Math.max(0, Number(cuotaInicial || 0));
  const plazoMesesNumero = Math.max(0, Math.trunc(Number(plazoMeses || 0)));
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
  });
  const saldoFinanciado = financialPlan.montoCreditoTotal;
  const valorCuota = financialPlan.valorCuota;
  const referenciaEquipo = [equipoMarca.trim(), equipoModelo.trim()]
    .filter(Boolean)
    .join(" ");
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
            <li>Datos biometricos (fotografia, selfie, video si aplica)</li>
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
  const imeiDigits = imei.replace(/\D/g, "");
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
    Boolean(contratoCedulaRespaldoDataUrl) &&
    Boolean(contratoVideoAprobacionDataUrl) &&
    Boolean(contratoFirmaDataUrl);
  const contractEvidenceReady = identityEvidenceReady;
  const stepContratoReady = identityEvidenceReady;
  const stepEquipoReady =
    Boolean(equipoMarca.trim()) &&
    Boolean(equipoModelo.trim()) &&
    imeiValido &&
    saldoFinanciado > 0 &&
    plazoMesesNumero > 0;
  const contratoListo = stepClienteReady && stepContratoReady && stepEquipoReady;
  const stepDocumentosReady =
    contratoAceptado &&
    pagareAceptado &&
    cartaAceptada &&
    autorizacionDatosAceptada;
  const entregaValidada = Boolean(deliveryValidation?.status?.ready);
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
          overdueCount: 0,
          plan: [],
          abonosCount: selectedCredit.abonosCount,
          ultimoAbonoAt: selectedCredit.ultimoAbonoAt,
        }
      : null);
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
    : lookupMode
      ? "Clientes y expedientes"
      : "Fabrica de creditos";
  const heroTitle = paymentsView
    ? "Recibe cuotas y consulta cartera"
    : lookupMode
      ? "Busca el cliente y abre su expediente"
    : createClientMode
      ? "Crear cliente y abrir la venta"
      : "Genera, inscribe y valida entrega";
  const heroDescription = paymentsView
    ? "Esta vista queda enfocada en buscar clientes, revisar saldo pendiente, registrar abonos y consultar historial de pagos sin mezclar la creacion del credito."
    : lookupMode
      ? "Busca por cedula, folio, telefono, IMEI o nombre y revisa solo la ficha del credito seleccionado, sin mezclar formularios de venta."
    : createClientMode
      ? "Empieza directo en el paso 1 para capturar los datos del cliente y continuar el flujo completo de 5 pasos."
      : "El flujo queda enfocado en generar el credito, inscribir el equipo en Equality y confirmar si el dispositivo si se puede entregar al cliente.";
  const searchDescription = paymentsView
    ? "Busca por cedula, telefono, nombre, folio, IMEI o deviceUid para ubicar el caso y recibir el pago de las cuotas desde esta vista separada."
    : lookupMode
      ? "Busca por cedula, telefono, nombre, folio, IMEI o deviceUid. Si hay varias coincidencias, primero eliges una y luego solo se muestra ese cliente."
      : "Busca por cedula, telefono, nombre, folio, IMEI o deviceUid para ubicar creditos existentes y revisar su estado sin salir de la fabrica.";
  const factorySteps = [
    {
      id: 1,
      label: "Cliente",
      detail: "Datos base",
      ready: stepClienteReady,
      action: "Completa identidad, contacto, direccion y dos referencias.",
    },
    {
      id: 2,
      label: "Equipo",
      detail: "IMEI y plan",
      ready: stepEquipoReady,
      action: "Registra marca, modelo, IMEI y condiciones del credito.",
    },
    {
      id: 3,
      label: "Identidad",
      detail: "Evidencias",
      ready: stepContratoReady,
      action: "Captura selfie, cedula, video y firma.",
    },
    {
      id: 4,
      label: "Contratos",
      detail: "Aceptaciones",
      ready: stepDocumentosReady,
      action: "Confirma contrato, pagare, carta y datos personales.",
    },
    {
      id: 5,
      label: "Entrega",
      detail: "Zero Touch",
      ready: entregaValidada,
      action: "Valida el equipo y cierra solo si queda entregable.",
    },
  ];
  const completedFactorySteps = factorySteps.filter((step) => step.ready).length;
  const factoryProgress = Math.round((completedFactorySteps / factorySteps.length) * 100);
  const activeFactoryStep =
    factorySteps.find((step) => step.id === wizardStep) || factorySteps[0];
  const nextFactoryStep =
    factorySteps.find((step) => !step.ready) || factorySteps[factorySteps.length - 1];
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
      { label: "Video", ready: Boolean(contratoVideoAprobacionDataUrl) },
      { label: "Firma", ready: Boolean(contratoFirmaDataUrl) },
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
      { label: "Identidad", ready: stepContratoReady },
      { label: "Contratos", ready: stepDocumentosReady },
      { label: "Entrega", ready: entregaValidada },
    ],
  };
  const activeRequirements = factoryStepRequirements[wizardStep] || [];
  const activeCompletedCount = activeRequirements.filter((item) => item.ready).length;
  const activeCompletionPercent = activeRequirements.length
    ? Math.round((activeCompletedCount / activeRequirements.length) * 100)
    : 0;
  const showResultsPanel = paymentsView
    ? !selectedCredit || showPaymentResults
    : lookupMode
      ? true
      : false;
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
              de {currency(valorCuota)} cada una, conforme al plan pactado.
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

  const applyEquipmentCatalogItem = (item: EquipmentCatalogItem) => {
    setEquipoMarca(item.marca);
    setEquipoModelo(item.modelo);

    if (!valorEquipoTotal || Number(valorEquipoTotal) <= 0) {
      setValorEquipoTotal(String(Math.round(item.precioBaseVenta)));
    }
  };

  const loadCredits = async (preserveSelected = true, searchValue = activeSearch) => {
    try {
      setLoadingList(true);
      const trimmedSearch = searchValue.trim();

      if (!paymentsView && !lookupMode) {
        setActiveSearch("");
        setCredits([]);
        setSelectedId(null);
        setShowLookupDetail(false);
        return;
      }

      if (lookupMode && !trimmedSearch) {
        setActiveSearch("");
        setCredits([]);
        setSelectedId(null);
        setShowSearchResults(true);
        setShowLookupDetail(false);
        return;
      }

      const params = new URLSearchParams({
        take: "24",
      });

      if (trimmedSearch) {
        params.set("search", trimmedSearch);
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
      } else if (createClientMode) {
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
        setShowSearchResults(true);
        setShowLookupDetail(false);
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

  useEffect(() => {
    void loadEquipmentCatalog();
  }, []);

  useEffect(() => {
    if (!paymentsView && !lookupMode) {
      setLoadingList(false);
      return;
    }

    void loadCredits(Boolean(initialSelectedId), normalizedInitialSearch);
  }, [paymentsView, lookupMode, initialSelectedId, normalizedInitialSearch]);

  useEffect(() => {
    if (!selectedCredit) {
      setPayments([]);
      setPaymentSummary(null);
      return;
    }

    setNextDueDate(dateOnly(selectedCredit.fechaProximoPago));
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

    setCuotaInicial(
      String(
        calculateRequiredInitialPayment(
          totalValue,
          precioBaseVentaCatalogo > 0 ? precioBaseVentaCatalogo : undefined
        )
      )
    );
  }, [precioBaseVentaCatalogo, valorEquipoTotal]);

  useEffect(() => {
    if (!paymentsView) {
      return;
    }

    if (!selectedCredit) {
      setShowPaymentResults(true);
      return;
    }

    setShowPaymentResults(false);
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
      const nextInstallment = result.data.credito.nextInstallment;
      if (nextInstallment?.saldoPendiente && nextInstallment.saldoPendiente > 0) {
        setSelectedInstallmentNumber(String(nextInstallment.numero));
        setPaymentValue(String(Math.round(nextInstallment.saldoPendiente)));
      } else {
        setSelectedInstallmentNumber("");
      }
    } catch (error) {
      setPayments([]);
      setPaymentSummary(null);
      setSelectedInstallmentNumber("");
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
      const durationSeconds = await readVideoDuration(file);

      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("No se pudo leer la duracion del video.");
      }

      if (durationSeconds > 7.5) {
        throw new Error("El video debe durar maximo 7 segundos.");
      }

      const dataUrl = ensureVideoDataUrl(await readFileAsDataUrl(file), file);
      setContratoVideoAprobacionDataUrl(dataUrl);
      setContratoVideoAprobacionAudit({
        capturedAt: new Date().toISOString(),
        source: "upload",
        durationSeconds: Math.max(1, Math.round(durationSeconds)),
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
          durationSeconds: 7,
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
          durationSeconds: audit?.durationSeconds || 7,
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
          session.evidence.videoAprobacionDuration || 7,
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
          "QR listo. Abre el enlace desde el celular para tomar selfie, cédula y video.",
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

  const goToStep = (targetStep: number) => {
    if (FLEXIBLE_WIZARD_FOR_TESTING) {
      setWizardStep(Math.min(5, Math.max(1, targetStep)));
      return;
    }

    if (targetStep <= wizardStep) {
      setWizardStep(targetStep);
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
          "Completa el equipo, usa un IMEI de 15 numeros y revisa el plan financiero antes de avanzar a identidad.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 3 && !stepContratoReady) {
      setNotice({
        text:
          "Completa selfie, cedula por ambos lados, video y firma antes de avanzar a los contratos.",
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
          "Marca la aceptacion del contrato, pagare, carta de instrucciones y autorizacion de datos antes de pasar a la validacion del equipo.",
        tone: "amber",
      });
      return;
    }

    setWizardStep(targetStep);
  };

  const advanceToStep = async (targetStep: number) => {
    if (FLEXIBLE_WIZARD_FOR_TESTING) {
      setWizardStep(Math.min(5, Math.max(1, targetStep)));
      return;
    }

    if (targetStep <= wizardStep) {
      setWizardStep(targetStep);
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
          "Completa el equipo, usa un IMEI de 15 numeros y revisa el plan financiero antes de avanzar a identidad.",
        tone: "amber",
      });
      return;
    }

    if (wizardStep === 3) {
      if (!identityEvidenceReady) {
        setNotice({
          text:
            "Completa selfie, cedula por ambos lados, video de aprobacion y firma antes de pasar a los contratos.",
          tone: "amber",
        });
        return;
      }

      setWizardStep(targetStep);
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
          "Completa el checklist documental antes de pasar a la validacion del equipo.",
        tone: "amber",
      });
      return;
    }

    setWizardStep(targetStep);
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

  const validateDeliveryBeforeFinalize = async () => {
    if (!imeiValido) {
      setNotice({
        text: "El IMEI debe tener exactamente 15 numeros antes de validar la entrega.",
        tone: "red",
      });
      return;
    }

    if (
      !stepClienteReady ||
      !stepEquipoReady ||
      !stepContratoReady ||
      !stepDocumentosReady
    ) {
      setNotice({
        text:
          "Completa cliente, equipo, identidad y checklist documental antes de validar la entrega.",
        tone: "amber",
      });
      return;
    }

    try {
      setValidatingDelivery(true);
      setNotice(null);

      const result = await requestJson<{
        ok?: boolean;
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
          action: "enroll",
          deviceUid: imeiDigits,
        }),
      });

      const nextValidation: DeliveryValidationState = {
        checkedAt: new Date().toISOString(),
        deviceState: result.data.deviceState || null,
        remoteStatusCode: result.data.remoteStatusCode || null,
        resultMessage: result.data.resultMessage || null,
        serviceDetails: result.data.serviceDetails || null,
        status: result.data.deliveryStatus || null,
      };

      setDeliveryValidation(nextValidation);

      if (result.data.deliveryStatus?.ready) {
        setNotice({
          text:
            result.data.deliveryStatus.detail ||
            "Zero Touch confirmo que el equipo esta 100% entregable.",
          tone: "emerald",
        });
        return;
      }

      setNotice({
        text:
          result.data.deliveryStatus?.detail ||
          result.data.resultMessage ||
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
    setWizardStep(1);
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
    setPlazoMeses("12");
    setTasaInteresEa(String(DEFAULT_LEGAL_CONSUMER_RATE_EA));
    setFianzaPorcentaje(String(DEFAULT_FIANCO_SURETY_PERCENTAGE));
    setFechaPrimerPago(getDefaultFirstPaymentDate());
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
    setDeliveryValidation(null);
    setCameraSlot(null);
    setMobileCaptureSession(null);
    setMobileCaptureQrDataUrl("");
    mobileCaptureAppliedRef.current = "";
    setSignaturePadKey((current) => current + 1);
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

  const createCredit = async () => {
    if (!ventaLista) {
      setNotice({
        text:
          "Completa el flujo de cliente, equipo, identidad, contratos y valida el equipo antes de finalizar la venta.",
        tone: "red",
      });
      return;
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
          tasaInteresEa: financialPlan.tasaInteresEa,
          fianzaPorcentaje: financialPlan.fianzaPorcentaje,
          fechaPrimerPago,
          contratoAceptado,
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
          contratoVideoAprobacionDataUrl,
          contratoVideoAprobacionCapturedAt:
            contratoVideoAprobacionAudit?.capturedAt || null,
          contratoVideoAprobacionSource:
            contratoVideoAprobacionAudit?.source || null,
          contratoVideoAprobacionDurationSeconds:
            contratoVideoAprobacionAudit?.durationSeconds || null,
          contratoOtpCanal: "",
          contratoOtpDestino: "",
          contratoOtpVerificadoAt: null,
          pagareAceptado,
          cartaAceptada,
          autorizacionDatosAceptada,
        }),
      });

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo crear el credito");
      }

      upsertCredit(result.data.item);
      window.open(`/api/creditos/${result.data.item.id}/plan-pagos`, "_blank");
      resetForm();

      if (result.data.deliveryStatus?.ready) {
        setNotice({
          text: `${result.data.item.folio} quedo inscrito y 100% entregable.`,
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
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo crear el credito",
        tone: "red",
      });
    } finally {
      setCreating(false);
    }
  };

  const registerPayment = async () => {
    if (!selectedCredit) {
      setNotice({
        text: "Selecciona primero un credito para registrar el abono.",
        tone: "red",
      });
      return;
    }

    try {
      setRegisteringPayment(true);
      setNotice(null);

      const result = await requestJson<RegisterPaymentResponse>(
        `/api/creditos/${selectedCredit.id}/abonos`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            cuotaNumero: selectedInstallmentNumber || null,
            valor: paymentValue,
            metodoPago: paymentMethod,
            observacion: paymentObservation,
          }),
        }
      );

      if (!result.ok) {
        throw new Error(result.data?.error || "No se pudo registrar el abono");
      }

      setPaymentValue("");
      setPaymentObservation("");
      setSelectedInstallmentNumber("");
      await loadPayments(selectedCredit.id);
      await loadCredits(true, activeSearch);

      setNotice({
        text: result.data.message,
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

    window.open(`/api/creditos/${credit.id}/paz-y-salvo`, "_blank");
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

    window.open(`/api/creditos/${credit.id}/plan-pagos`, "_blank");
  };

  const downloadExpedientePdf = (creditId?: number | null) => {
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

    window.open(`/api/creditos/${credit.id}/documentos`, "_blank");
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
    const target = historySectionRef.current;

    if (!target) {
      return;
    }

    const top = target.getBoundingClientRect().top + window.scrollY - 110;
    window.scrollTo({
      top: Math.max(0, top),
      behavior: "smooth",
    });
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
    await loadCredits(false, searchTerm);
  };

  const clearSearch = async () => {
    setSearchTerm("");
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
    setReferenciaFamiliar1Nombre(credit.referenciasFamiliares[0]?.nombre || "");
    setReferenciaFamiliar1Parentesco(credit.referenciasFamiliares[0]?.parentesco || "");
    setReferenciaFamiliar1Telefono(credit.referenciasFamiliares[0]?.telefono || "");
    setReferenciaFamiliar2Nombre(credit.referenciasFamiliares[1]?.nombre || "");
    setReferenciaFamiliar2Parentesco(credit.referenciasFamiliares[1]?.parentesco || "");
    setReferenciaFamiliar2Telefono(credit.referenciasFamiliares[1]?.telefono || "");
    setWizardStep(1);
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
    <div className="fp-shell min-h-screen px-4 py-8 text-slate-950">
      <div className="mx-auto max-w-7xl">
        <section className="fp-hero relative overflow-hidden rounded-[30px] border border-emerald-950/10 px-6 py-8 text-white shadow-[0_30px_90px_rgba(23,32,29,0.20)] sm:px-8">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#12b886,#b7e45c,#ff6b4a)]" />

          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-5">
                <FinserBrand dark />
              </div>
              <div className="inline-flex rounded-full border border-white/14 bg-white/8 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-emerald-50">
                {heroEyebrow}
              </div>
              <h1 className="mt-5 text-4xl font-black tracking-tight sm:text-5xl">
                {heroTitle}
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
                {heroDescription}
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                <span className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Usuario: {initialSession.nombre}
                </span>
                {initialSeller && (
                  <span className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8ce5e1]">
                    Vendedor: {initialSeller.nombre}
                  </span>
                )}
                <span className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Rol: {initialSession.rolNombre}
                </span>
                <span className="rounded-full border border-white/12 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                  Sede: {initialSession.sedeNombre}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/dashboard"
                className="inline-flex min-w-[170px] justify-center rounded-[18px] border border-white/15 bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-50"
              >
                Volver al dashboard
              </Link>
              <Link
                href="/dashboard/integraciones"
                className="inline-flex min-w-[170px] justify-center rounded-[18px] border border-white/15 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/16"
              >
                Ver integraciones
              </Link>
              <Link
                href={
                  paymentsView
                    ? "/dashboard/creditos?mode=create-client"
                    : lookupMode
                      ? "/dashboard/abonos"
                      : "/dashboard/abonos"
                }
                className="inline-flex min-w-[170px] justify-center rounded-[18px] border border-white/15 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/16"
              >
                {paymentsView ? "Ir a crear cliente" : "Ir a abonos"}
              </Link>
            </div>
          </div>
        </section>

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

        {showSearchSection && (
        <section className="fp-surface mt-6 rounded-[28px] p-6">
          <div className="inline-flex rounded-full border fp-kicker px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]">
            Buscar cliente
          </div>
          <h2 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
            Encuentra al cliente y su credito
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            {searchDescription}
          </p>

          <div className="mt-6 flex flex-col gap-3 lg:flex-row">
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void searchCredits();
                }
              }}
              placeholder="Cedula, telefono, nombre, folio o IMEI"
               className="flex-1 rounded-[18px] border border-emerald-950/14 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
            />

            <button
              type="button"
              onClick={() => void searchCredits()}
              disabled={loadingList}
              className="fp-action rounded-[18px] px-5 py-3 text-sm font-semibold text-white transition hover:scale-[1.01] disabled:opacity-70"
            >
              {loadingList ? "Buscando..." : "Buscar cliente"}
            </button>

            <button
              type="button"
              onClick={() => void clearSearch()}
              disabled={loadingList && !activeSearch}
              className="rounded-[18px] border border-emerald-950/14 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-emerald-50 disabled:opacity-70"
            >
              Limpiar
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full border border-[#c7dbe0] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
              Alcance: {canAdmin ? "Global" : `Sede ${initialSession.sedeNombre}`}
            </span>
            <span className="rounded-full border border-[#c7dbe0] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
              Resultados: {credits.length}
            </span>
            {activeSearch && (
              <span className="rounded-full border border-[#c7dbe0] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                Filtro: {activeSearch}
              </span>
            )}
          </div>
        </section>
        )}

        <section
          className={
            paymentsView
              ? "hidden"
              : createClientMode
                ? "mt-8"
                : lookupMode
                  ? "mt-8"
                  : "mt-8 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]"
          }
        >
          <div
            className={[
              "fp-surface rounded-[28px] p-5 sm:p-6",
              lookupMode ? "hidden" : "",
            ].join(" ")}
          >
            <div className="fp-flow-header relative overflow-hidden rounded-[28px] border border-[#cfe5e2] p-5 sm:p-6">
              <div className="relative grid gap-5 xl:grid-cols-[1.1fr_0.9fr] xl:items-end">
                <div>
                  <div className="inline-flex rounded-full border border-[#8fd8cf] bg-white/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#0f5d59]">
                    Nuevo credito
                  </div>
                  <h2 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
                    Fabrica guiada para el asesor
                  </h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                    {canAdmin
                      ? "Genera el credito, revisa evidencias y opera el caso sin perder de vista el estado del cierre."
                      : "Sigue el recorrido paso a paso: cliente, equipo, identidad, contratos y entrega validada."}
                  </p>
                </div>

                <div className="rounded-[24px] border border-white/70 bg-white/78 p-4 shadow-[0_16px_35px_rgba(15,23,42,0.08)]">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                        Avance del caso
                      </p>
                      <p className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                        {factoryProgress}%
                      </p>
                    </div>
                    <div className="fp-pulse-dot" aria-hidden="true" />
                  </div>
                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="fp-flow-progress h-full rounded-full"
                      style={{ width: `${factoryProgress}%` }}
                    />
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    Siguiente accion: <span className="font-semibold text-slate-950">{nextFactoryStep.action}</span>
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-[280px_1fr] xl:items-start">
              <aside className="fp-step-rail rounded-[26px] border border-[#d8e6e5] bg-white/88 p-3 shadow-[0_18px_44px_rgba(15,23,42,0.07)]">
                {factorySteps.map((step) => {
                  const active = step.id === wizardStep;

                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => {
                        void advanceToStep(step.id);
                      }}
                      className={[
                        "group mb-2 flex w-full items-center gap-3 rounded-[22px] border px-3 py-3 text-left transition last:mb-0",
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
                        {step.ready ? "OK" : step.id}
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
                <div className="mb-4 rounded-[26px] border border-[#d8e6e5] bg-white px-4 py-4 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#0f766e]">
                        Paso {activeFactoryStep.id} en curso
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
                  <div className="mt-4 rounded-[22px] border border-[#e1efec] bg-[#f8fdfb] px-4 py-4">
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
                      {activeRequirements.map((item) => (
                        <span
                          key={item.label}
                          className={[
                            "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]",
                            item.ready
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-amber-200 bg-amber-50 text-amber-700",
                          ].join(" ")}
                        >
                          {item.ready ? "OK" : "Falta"} {item.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

            <div className="fp-step-stage fp-form-redesign rounded-[28px] border border-[#d6e4e1] bg-[linear-gradient(180deg,#fffef9_0%,#f7f2e9_100%)] p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
              {wizardStep === 1 && (
                <div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="inline-flex rounded-full border border-[#e6d6bd] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a5a21]">
                        Paso 1
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        Captura de datos del cliente
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Reune primero los datos sensibles del cliente para dejar lista la validacion del contrato.
                      </p>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        stepClienteReady
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {stepClienteReady ? "Datos completos" : "Faltan datos"}
                    </div>
                  </div>

                  <div className="mt-6 rounded-[28px] border border-[#cfe4e7] bg-[linear-gradient(180deg,#eefbff_0%,#f7fdff_100%)] p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-lg font-black tracking-tight text-slate-950">
                          Ingresa los datos del cliente
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Todos los campos son obligatorios para preparar contrato, pagare e identidad comercial.
                        </p>
                      </div>
                      {!canAdmin && initialSeller && (
                        <div className="rounded-2xl border border-[#c3d8dc] bg-white px-4 py-3 text-sm text-slate-600">
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
                      <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-4 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Firma digital
                            </p>
                            <p className="mt-2 text-sm leading-6 text-slate-600">
                              Pidele al cliente que firme directamente en la pantalla.
                            </p>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              setContratoFirmaDataUrl("");
                              setSignaturePadKey((current) => current + 1);
                            }}
                            className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            Limpiar firma
                          </button>
                        </div>

                        <div className="mt-4">
                          <SignaturePad
                            padKey={signaturePadKey}
                            onChange={setContratoFirmaDataUrl}
                          />
                        </div>

                        <div className="mt-4 flex items-start gap-3 rounded-[20px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-3">
                          <input
                            id="contrato-aceptado-wizard"
                            type="checkbox"
                            checked={contratoAceptado}
                            onChange={(event) => setContratoAceptado(event.target.checked)}
                            className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-300"
                          />
                          <label
                            htmlFor="contrato-aceptado-wizard"
                            className="text-sm leading-6 text-slate-700"
                          >
                            Confirmo lectura y aceptacion del contrato, con captura de selfie, cedula y firma.
                          </label>
                        </div>
                      </div>

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
                        Paso 2
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        Equipo y plan financiero
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Captura el equipo, define la inicial y confirma la cuota que vera el cliente.
                      </p>
                    </div>
                    <div
                      className={[
                        "inline-flex rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        stepEquipoReady
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-amber-200 bg-amber-50 text-amber-700",
                      ].join(" ")}
                    >
                      {stepEquipoReady ? "Equipo listo" : "Falta informacion"}
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
                                {item.modelo} - base {currency(item.precioBaseVenta)}
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
                        <p className="mt-2 text-xs font-medium text-slate-500">
                          {precioBaseVentaCatalogo > 0
                            ? `Base del modelo: ${currency(precioBaseVentaCatalogo)}. Excedente a inicial: ${currency(excedentePrecioBase)}.`
                            : `Base maxima sin catalogo: ${currency(MAX_DEVICE_FINANCING_BASE)}.`}
                        </p>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Cuota inicial automatica
                        </label>
                        <input
                          value={currencyInputValue(cuotaInicial)}
                          readOnly
                          placeholder="$ 0"
                          className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-900 outline-none"
                        />
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-semibold text-slate-700">
                          Numero de cuotas
                        </label>
                        <input
                          value={plazoMeses}
                          onChange={(event) => setPlazoMeses(event.target.value.replace(/\D/g, ""))}
                          placeholder="12"
                          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                        />
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
                          Se calcula automaticamente a 15 dias desde hoy.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-[24px] border border-[#d9e6ea] bg-[#f8fdff] p-5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                          Resumen para el asesor
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Muestra solo los datos necesarios para explicar la venta y avanzar al cierre.
                        </p>
                      </div>

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
                        <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Total financiado
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {currency(saldoFinanciado)}
                          </p>
                          <p className="mt-1 text-xs font-medium text-slate-500">
                            Valor final distribuido en las cuotas.
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

              {wizardStep === 3 && (
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
                        Aqui capturas selfie, cedula por ambos lados, video corto y firma para continuar con los contratos.
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
                      {stepContratoReady ? "Identidad validada" : "Faltan validaciones"}
                    </div>
                  </div>

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
                          Si la cámara del computador no logra leer bien la cédula, genera este QR y abre el flujo móvil. La selfie, la cédula por ambos lados y el video se cargarán automáticamente en esta venta.
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
                              {
                                label: "Video",
                                ready: mobileCaptureSession.evidence.videoReady,
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

                  <div className="mt-6 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
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

                      <VideoEvidenceCard
                        title="Video corto de aprobacion"
                        description='Graba 7 segundos donde el cliente diga: "YO [NOMBRE] APRUEBO LA COMPRA CON FINSERPAY".'
                        metaLabel={
                          contratoVideoAprobacionAudit
                            ? `Capturado: ${evidenceAuditTime(
                                contratoVideoAprobacionAudit.capturedAt
                              )} | Origen: ${
                                contratoVideoAprobacionAudit.source === "camera"
                                  ? "Camara"
                                  : "Archivo"
                              }${
                                contratoVideoAprobacionAudit.durationSeconds
                                  ? ` | Duracion: ${contratoVideoAprobacionAudit.durationSeconds}s`
                                  : ""
                              } | IP: se registra al finalizar`
                            : undefined
                        }
                        value={contratoVideoAprobacionDataUrl}
                        onOpenCamera={() => setCameraSlot("video-aprobacion")}
                        onRemove={() => {
                          setContratoVideoAprobacionDataUrl("");
                          setContratoVideoAprobacionAudit(null);
                        }}
                        onFileChange={(event) => void captureApprovalVideo(event)}
                      />
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-4 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Firma digital
                            </p>
                            <p className="mt-2 text-sm leading-6 text-slate-600">
                              Pidele al cliente que firme directamente en la pantalla.
                            </p>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              setContratoFirmaDataUrl("");
                              setSignaturePadKey((current) => current + 1);
                            }}
                            className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            Limpiar firma
                          </button>
                        </div>

                        <div className="mt-4">
                          <SignaturePad
                            padKey={signaturePadKey}
                            onChange={setContratoFirmaDataUrl}
                          />
                        </div>
                      </div>

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

                      <div className="rounded-[24px] border border-[#d9e7ea] bg-[#f8fbfd] px-5 py-5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Checklist de identidad
                        </p>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          {[
                            { label: "Selfie", ready: Boolean(contratoFotoDataUrl) },
                            {
                              label: "Cedula frente y respaldo",
                              ready:
                                Boolean(contratoCedulaFrenteDataUrl) &&
                                Boolean(contratoCedulaRespaldoDataUrl),
                            },
                            { label: "Video", ready: Boolean(contratoVideoAprobacionDataUrl) },
                            { label: "Firma", ready: Boolean(contratoFirmaDataUrl) },
                          ].map(({ label, ready }) => (
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
                        Paso 4
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        Contratos y aceptacion
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Aqui revisas el contrato, el pagaré, la carta de instrucciones y la autorizacion de datos. Tambien ves anexadas las capturas del paso 3.
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
                      {stepDocumentosReady ? "Documentos listos" : "Checklist pendiente"}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 xl:grid-cols-[0.88fr_1.12fr]">
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

                          <div className="rounded-[18px] border border-slate-200 bg-white p-3 sm:col-span-2">
                            <VideoEvidencePreview
                              value={contratoVideoAprobacionDataUrl}
                              emptyLabel="Video pendiente"
                              heightClassName="h-48"
                            />
                            <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
                              <span>
                                Video:{" "}
                                {contratoVideoAprobacionAudit?.durationSeconds
                                  ? `${contratoVideoAprobacionAudit.durationSeconds}s`
                                  : "Pendiente"}
                              </span>
                            </div>
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
                        Paso 5
                      </div>
                      <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                        Validacion del equipo
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
                        <p><span className="font-semibold text-slate-950">Total financiado:</span> {currency(saldoFinanciado)}</p>
                        <p><span className="font-semibold text-slate-950">Valor cuota:</span> {currency(valorCuota)}</p>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#d9e6ea] bg-[#f8fdff] px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                        Validacion de entrega
                      </p>
                      <div className="mt-4 space-y-3 text-sm text-slate-700">
                        <p>
                          En este ultimo paso el sistema inscribe y consulta Zero Touch. Solo si el dispositivo queda entregable se habilita el cierre del credito.
                        </p>
                        <div
                          className={[
                            "rounded-2xl border px-4 py-4",
                            deliveryValidation?.status?.ready
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
                            {deliveryValidation?.status?.label || "Pendiente por validar"}
                          </p>
                          <p className="mt-2 leading-6">
                            {deliveryValidation?.status?.detail ||
                              "Aun no se ha ejecutado la validacion final de entrega."}
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
                            onClick={() => void validateDeliveryBeforeFinalize()}
                            disabled={validatingDelivery}
                            className="rounded-2xl bg-[#145a5a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
                          >
                            {validatingDelivery
                              ? "Validando entrega..."
                              : "Inscribir y validar entrega"}
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
                          { label: "Identidad", ready: stepContratoReady },
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

                      {!entregaValidada && (
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
                        <p><span className="font-semibold text-slate-950">Total financiado:</span> {currency(saldoFinanciado)}</p>
                        <p><span className="font-semibold text-slate-950">Valor cuota:</span> {currency(valorCuota)}</p>
                      </div>
                    </div>

                    <div className="rounded-[24px] border border-[#d9e6ea] bg-[#f8fdff] px-5 py-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1d5b63]">
                        Validacion de entrega
                      </p>
                      <div className="mt-4 space-y-3 text-sm text-slate-700">
                        <p>
                          En este ultimo paso el sistema inscribe y consulta Zero Touch. Solo si
                          el dispositivo queda entregable se habilita el cierre del credito.
                        </p>
                        <div
                          className={[
                            "rounded-2xl border px-4 py-4",
                            deliveryValidation?.status?.ready
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
                            {deliveryValidation?.status?.label || "Pendiente por validar"}
                          </p>
                          <p className="mt-2 leading-6">
                            {deliveryValidation?.status?.detail ||
                              "Aun no se ha ejecutado la validacion final de entrega."}
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
                            onClick={() => void validateDeliveryBeforeFinalize()}
                            disabled={validatingDelivery}
                            className="rounded-2xl bg-[#145a5a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
                          >
                            {validatingDelivery
                              ? "Validando entrega..."
                              : "Inscribir y validar entrega"}
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

                      {!entregaValidada && (
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
                        Resumen financiero
                      </p>
                      <div className="mt-4 space-y-2 text-sm text-slate-700">
                        <p><span className="font-semibold text-slate-950">Equipo:</span> {referenciaEquipo || "-"}</p>
                        <p><span className="font-semibold text-slate-950">IMEI:</span> {imei || "-"}</p>
                        <p><span className="font-semibold text-slate-950">Total equipo:</span> {currency(valorTotalEquipoNumero)}</p>
                        <p><span className="font-semibold text-slate-950">Inicial:</span> {currency(cuotaInicialNumero)}</p>
                        <p><span className="font-semibold text-slate-950">Total financiado:</span> {currency(saldoFinanciado)}</p>
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
                            de {currency(valorCuota)} cada una, conforme al plan pactado.
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

            <div className="fp-flow-actions sticky bottom-4 z-20 mt-5 flex flex-wrap items-center gap-3 rounded-[24px] border border-[#d8e6e5] bg-white/92 px-4 py-4 shadow-[0_18px_45px_rgba(15,23,42,0.12)] backdrop-blur">
              {wizardStep > 1 && (
                <button
                  type="button"
                  onClick={() => setWizardStep((current) => Math.max(1, current - 1))}
                  className="rounded-2xl border border-[#cbdedc] bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-[#f4fbfa]"
                >
                  Anterior
                </button>
              )}

              {wizardStep < 5 && (
                <button
                  type="button"
                        onClick={() => {
                          void advanceToStep(wizardStep + 1);
                        }}
                  className="fp-action rounded-2xl px-5 py-3 text-sm font-semibold text-white transition hover:scale-[1.01]"
                >
                  Siguiente paso
                </button>
              )}

              {wizardStep === 5 && (
                <button
                  type="button"
                  onClick={() => void createCredit()}
                  disabled={creating || !ventaLista}
                  className="fp-action rounded-2xl px-5 py-3 text-sm font-semibold text-white transition hover:scale-[1.01] disabled:opacity-70"
                >
                  {creating ? "Finalizando credito..." : "Finalizar credito"}
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

              {FLEXIBLE_WIZARD_FOR_TESTING && (
                <span className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-700">
                  Modo pruebas activo: puedes saltar entre pasos y finalizar el credito aunque la validacion final de entrega quede pendiente.
                </span>
              )}

              {wizardStep === 5 && !ventaLista && !FLEXIBLE_WIZARD_FOR_TESTING && (
                <span className="text-sm font-medium text-amber-700">
                  Primero valida la entregabilidad del dispositivo para habilitar el cierre.
                </span>
              )}
            </div>
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
                <p className="mt-2 text-xs font-medium text-slate-500">
                  Base financiable maxima: {currency(MAX_DEVICE_FINANCING_BASE)}. El excedente se cobra en la inicial.
                </p>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Cuota inicial
                </label>
                <input
                  value={currencyInputValue(cuotaInicial)}
                  readOnly
                  placeholder="$ 0"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-900 outline-none"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Numero de cuotas
                </label>
                <input
                  value={plazoMeses}
                  onChange={(event) => setPlazoMeses(event.target.value)}
                  placeholder="12"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
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
                  Fecha automatica a 15 dias desde la creacion del credito.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <div className="rounded-[22px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Saldo financiado
                </p>
                <p className="mt-2 text-2xl font-black text-slate-950">
                  {currency(saldoFinanciado)}
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
                    Firma el contrato antes de crear el credito
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    El contrato se llena con los datos de este formulario. Debes tomar la foto de aceptacion y capturar la firma digital del cliente.
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

                  <div className="rounded-[24px] border border-[#e2d6c5] bg-white px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Firma digital
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Pidele al cliente que firme sobre el recuadro.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setContratoFirmaDataUrl("");
                          setSignaturePadKey((current) => current + 1);
                        }}
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                      >
                        Limpiar firma
                      </button>
                    </div>

                    <div className="mt-4">
                      <SignaturePad
                        padKey={signaturePadKey}
                        onChange={setContratoFirmaDataUrl}
                      />
                    </div>

                    <div className="mt-4 flex items-start gap-3 rounded-[20px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-3">
                      <input
                        id="contrato-aceptado"
                        type="checkbox"
                        checked={contratoAceptado}
                        onChange={(event) => setContratoAceptado(event.target.checked)}
                        className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-300"
                      />
                      <label
                        htmlFor="contrato-aceptado"
                        className="text-sm leading-6 text-slate-700"
                      >
                        Confirmo que el cliente leyo, acepto el contrato y autorizo la captura de foto y firma digital.
                      </label>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-[18px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Fecha y hora de firma
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {documentDateTimeLabel}
                        </p>
                      </div>

                      <div className="rounded-[18px] border border-[#e6dece] bg-[#fcfaf6] px-4 py-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          IP del dispositivo
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          Se registra automaticamente al guardar
                        </p>
                      </div>
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
              "rounded-[30px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]",
              createClientMode ? "hidden" : "",
            ].join(" ")}
          >
            <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
              {lookupMode ? "Expediente del cliente" : "Entrega"}
            </div>
            <h2 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
              {lookupMode ? "Cliente y expediente seleccionado" : "Validacion operativa"}
            </h2>

            {!selectedCredit ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                {loadingList
                  ? "Buscando coincidencias..."
                  : lookupMode
                    ? activeSearch
                      ? "La busqueda devolvio varias coincidencias. Selecciona una para ver solo ese expediente."
                      : "Escribe un dato del cliente o del credito para abrir un expediente puntual."
                    : "Genera o selecciona un credito para ver si el equipo ya se puede entregar."}
              </div>
            ) : (
              <div className="mt-6 space-y-4">
                {lookupMode && (
                  <>
                    <div className="rounded-[28px] border border-[#dbe5ec] bg-white px-5 py-5 shadow-sm">
                      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex items-center gap-4">
                          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border border-[#d9e4eb] bg-[linear-gradient(180deg,#f8fafc_0%,#e8eef5_100%)] text-3xl font-black text-slate-950 shadow-[0_12px_28px_rgba(15,23,42,0.08)]">
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

                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-3xl font-black tracking-tight text-slate-950">
                                {selectedCredit.clienteNombre}
                              </h3>
                              <span
                                className={[
                                  "inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
                                  stateBadgeClasses(selectedCredit.estado),
                                ].join(" ")}
                              >
                                {clientPrimaryStatus}
                              </span>
                            </div>
                            <p className="mt-2 text-base text-slate-700">
                              Documento de ID:{" "}
                              <span className="font-semibold text-slate-950">
                                {selectedCredit.clienteTipoDocumento || "CC."}{" "}
                                {selectedCredit.clienteDocumento || "Sin documento"}
                              </span>
                            </p>
                            <p className="mt-1 text-sm text-slate-500">
                              {selectedCredit.clienteTelefono || "-"} {selectedCredit.clienteCorreo ? `| ${selectedCredit.clienteCorreo}` : ""}
                            </p>
                          </div>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-3">
                          <button
                            type="button"
                            onClick={() => openPaymentsForCredit()}
                            className="rounded-[22px] border border-[#145a5a] bg-[#145a5a] px-5 py-4 text-left text-white shadow-[0_16px_32px_rgba(20,90,90,0.18)] transition hover:bg-[#0f4a4a]"
                          >
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/75">
                              Pagar
                            </p>
                            <p className="mt-2 text-xl font-black">Abrir recaudo</p>
                            <p className="mt-1 text-sm text-white/80">
                              Se abre abonos con este cliente listo para cobrar.
                            </p>
                          </button>

                          <button
                            type="button"
                            onClick={focusHistory}
                            className="rounded-[22px] border border-slate-300 bg-[#fcfaf6] px-5 py-4 text-left text-slate-900 transition hover:bg-white"
                          >
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Historial
                            </p>
                            <p className="mt-2 text-xl font-black">Historial y documentos</p>
                            <p className="mt-1 text-sm text-slate-600">
                              Revisa creditos previos y descarga expediente PDF.
                            </p>
                          </button>

                          <button
                            type="button"
                            onClick={() => openLookupDetail(selectedCredit.id)}
                            className="rounded-[22px] border border-slate-300 bg-white px-5 py-4 text-left text-slate-900 transition hover:bg-slate-50"
                          >
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Ver detalle
                            </p>
                            <p className="mt-2 text-xl font-black">Abrir expediente</p>
                            <p className="mt-1 text-sm text-slate-600">
                              Muestra veredicto, datos del cliente y resumen del credito.
                            </p>
                          </button>
                        </div>
                      </div>

                      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Creditos del cliente
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {sameClientCredits.length}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Inicial acumulada
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {currency(clientInitialTotal)}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Abonos en cuotas
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {currency(clientPaymentsTotal)}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Documentos firmados
                          </p>
                          <p className="mt-2 text-2xl font-black text-slate-950">
                            {clientDocumentsCount}
                          </p>
                          <p className="mt-1 text-sm text-slate-500">
                            Pendiente total: {currency(clientPendingTotal)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {lookupMode && !showLookupDetail ? (
                  <div className="rounded-[24px] border border-[#dbe5ec] bg-white px-5 py-5 shadow-sm">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Detalle del credito
                        </p>
                        <h3 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                          El expediente queda oculto hasta abrirlo
                        </h3>
                        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                          Usa el boton <span className="font-semibold text-slate-950">Ver detalle</span> dentro de{" "}
                          <span className="font-semibold text-slate-950">Creditos y documentos</span> para revisar el
                          veredicto de entrega, la ficha completa del cliente, las referencias familiares y el resumen
                          financiero del credito seleccionado.
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setShowSearchResults(true)}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Cambiar credito
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div ref={lookupMode ? lookupDetailPanelRef : null} className="space-y-4">
                <div
                  className={[
                    "rounded-[24px] border px-5 py-5 shadow-sm",
                    deliveryClasses(selectedCredit.deliverableReady),
                  ].join(" ")}
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.18em]">
                    Veredicto para vendedor
                  </p>
                  <p className="mt-2 text-2xl font-black tracking-tight">
                    {selectedCredit.deliverableReady
                      ? "Si, lo puedes entregar"
                      : "No lo entregues aun"}
                  </p>
                  <p className="mt-3 text-sm leading-6">
                    {selectedCredit.deliverableLabel ||
                      "Aun no hay una verificacion comercial disponible."}
                    {selectedCredit.equalityState
                      ? ` Estado remoto: ${selectedCredit.equalityState}.`
                      : ""}
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-[#e6dece] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Folio
                    </p>
                    <p className="mt-2 text-xl font-black text-slate-950">
                      {selectedCredit.folio}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Estado
                    </p>
                    <span
                      className={[
                        "mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
                        stateBadgeClasses(selectedCredit.estado),
                      ].join(" ")}
                    >
                      {selectedCredit.estado}
                    </span>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Cliente
                    </p>
                    <p className="mt-2 text-base font-black text-slate-950">
                      {selectedCredit.clienteNombre}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {selectedCredit.clienteDocumento || "Sin documento"}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Equipo
                    </p>
                    <p className="mt-2 text-base font-black text-slate-950">
                      {selectedCredit.referenciaEquipo || "Sin referencia"}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      IMEI: {selectedCredit.imei}
                    </p>
                  </div>
                </div>

                <div className="rounded-[24px] border border-[#e6dece] bg-white px-5 py-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Ficha del cliente
                      </p>
                      <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                        Informacion personal y expediente
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
                          onClick={() => openPaymentsForCredit()}
                          disabled={!selectedCredit}
                          className="rounded-2xl border border-[#145a5a] bg-[#145a5a] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
                        >
                          Realizar abono
                        </button>
                        <button
                          type="button"
                          onClick={() => createNewSaleFromClient()}
                          disabled={!selectedCredit}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          Nueva venta con este cliente
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadExpedientePdf()}
                          disabled={!selectedCredit}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          Ver documentos firmados
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
                        <button
                          type="button"
                          onClick={() => void runCommand("toggle-stolen-lock")}
                          disabled={!selectedCredit || runningCommand !== null}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
                        >
                          {selectedCredit?.bloqueoRobo ? "Desbloquear dispositivo" : "Bloquear dispositivo"}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Fecha nacimiento
                      </p>
                      <p className="mt-2 text-sm font-bold text-slate-950">
                        {dateTime(selectedCredit.clienteFechaNacimiento)}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Fecha expedicion
                      </p>
                      <p className="mt-2 text-sm font-bold text-slate-950">
                        {dateTime(selectedCredit.clienteFechaExpedicion)}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Correo
                      </p>
                      <p className="mt-2 text-sm font-bold text-slate-950">
                        {selectedCredit.clienteCorreo || "-"}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Ubicacion
                      </p>
                      <p className="mt-2 text-sm font-bold text-slate-950">
                        {[selectedCredit.clienteCiudad, selectedCredit.clienteDepartamento]
                          .filter(Boolean)
                          .join(", ") || "-"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {selectedCredit.referenciasFamiliares.length ? (
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

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Referencia de pago
                    </p>
                    <p className="mt-2 text-sm font-bold text-slate-950">
                      {selectedCredit.referenciaPago || "-"}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Monto
                    </p>
                    <p className="mt-2 text-sm font-bold text-slate-950">
                      {currency(selectedCredit.montoCredito)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Proximo pago
                    </p>
                    <p className="mt-2 text-sm font-bold text-slate-950">
                      {dateTime(selectedCredit.fechaProximoPago)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Ultima verificacion
                    </p>
                    <p className="mt-2 text-sm font-bold text-slate-950">
                      {dateTime(selectedCredit.equalityLastCheckAt)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Ventana temporal
                    </p>
                    <p className="mt-2 text-sm font-bold text-slate-950">
                      {dateTime(selectedCredit.graceUntil)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-[#fcfaf6] px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Garantia
                    </p>
                    <p className="mt-2 text-sm font-bold text-slate-950">
                      {dateTime(selectedCredit.warrantyUntil)}
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
                      Inicial
                    </p>
                    <p className="mt-2 text-lg font-black text-emerald-900">
                      {currency(selectedCredit.cuotaInicial)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                      Saldo pendiente
                    </p>
                    <p className="mt-2 text-lg font-black text-amber-900">
                      {currency(selectedCredit.saldoPendiente)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">
                      Abonos recibidos
                    </p>
                    <p className="mt-2 text-lg font-black text-sky-900">
                      {currency(selectedCredit.totalAbonado)}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Abonos registrados
                    </p>
                    <p className="mt-2 text-lg font-black text-slate-950">
                      {selectedCredit.abonosCount}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      Total en cuotas: {currency(selectedCredit.totalAbonado)}
                    </p>
                  </div>
                </div>
                  </div>
                )}

                {lookupMode && (
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
                          Creditos y documentos
                        </h3>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => openPaymentsForCredit()}
                          className="rounded-2xl border border-[#145a5a] bg-[#145a5a] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0f4a4a]"
                        >
                          Realizar abono
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadExpedientePdf()}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Ver documentos firmados
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
                              Realizar abono
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
                              Ver documentos firmados
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
                                onClick={() => void runCommand("toggle-stolen-lock")}
                                disabled={runningCommand !== null}
                                className="rounded-2xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/16 disabled:opacity-50"
                              >
                                {selectedCredit.bloqueoRobo
                                  ? "Desbloquear dispositivo"
                                  : "Bloquear dispositivo"}
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
              ? showResultsPanel
                ? "mt-8 grid gap-6 xl:grid-cols-[0.82fr_1.18fr]"
                : "mt-8"
              : lookupMode && showResultsPanel
                ? "mt-8"
                : createClientMode
                ? "hidden"
                : "hidden"
          }
        >
          {showResultsPanel && (
          <div className="rounded-[30px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                  Clientes / creditos
                </div>
                <h2 className="mt-4 text-2xl font-black tracking-tight text-slate-950">
                  Resultados de busqueda
                </h2>
              </div>

              <button
                type="button"
                onClick={() => void loadCredits(true, activeSearch)}
                disabled={loadingList}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-70"
              >
                {loadingList ? "Actualizando..." : "Recargar"}
              </button>
            </div>

            <p className="mt-3 text-sm leading-6 text-slate-600">
              {activeSearch
                ? `Mostrando coincidencias para "${activeSearch}".`
                : lookupMode
                  ? "Sin filtro activo. La vista queda vacia hasta que busques un cliente o credito."
                  : "Sin filtro activo. Se muestran los creditos mas recientes dentro de tu alcance."}
            </p>

            <div className="mt-5 space-y-3">
              {!credits.length && !loadingList ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                  No encontramos clientes o creditos con ese criterio de busqueda.
                </div>
              ) : (
                credits.map((credit) => (
                  <button
                    key={credit.id}
                    type="button"
                    onClick={() => {
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
                ))
              )}
            </div>
          </div>
          )}

          {paymentsView && (
          <div className="rounded-[30px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                  Abonos
                </div>
                <h2 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
                  Recibir pago de cuotas
                </h2>
              </div>

              {paymentsView && selectedCredit && (
                <button
                  type="button"
                  onClick={() => setShowPaymentResults((current) => !current)}
                  className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  {showPaymentResults ? "Ocultar resultados" : "Cambiar cliente"}
                </button>
              )}
            </div>

            {!selectedCredit ? (
              <div className="mt-6 rounded-[24px] border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-sm leading-6 text-slate-500">
                Busca y selecciona un cliente para registrar abonos, ver saldo pendiente y consultar el historial de pagos.
              </div>
            ) : (
              <>
                <div className="mt-6 grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-[#e6dece] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Cliente
                    </p>
                    <p className="mt-2 text-lg font-black text-slate-950">
                      {selectedCredit.clienteNombre}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {selectedCredit.clienteDocumento || selectedCredit.clienteTelefono || "Sin identificacion"}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-[#e6dece] bg-white px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Referencia de pago
                    </p>
                    <p className="mt-2 text-lg font-black text-slate-950">
                      {selectedCredit.referenciaPago || "-"}
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
                      {paymentOverview?.overdueCount || 0} cuotas vencidas
                    </p>
                  </div>
                </div>

                <div className="mt-6 rounded-[24px] border border-[#e6dece] bg-[#fcfaf6] p-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Registrar nuevo abono
                  </p>

                  <div className="mt-4 grid gap-4 md:grid-cols-[0.9fr_0.7fr]">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Cuota a pagar
                      </label>
                      <select
                        value={selectedInstallmentNumber}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setSelectedInstallmentNumber(nextValue);
                          const installment = paymentOverview?.plan?.find(
                            (item) => String(item.numero) === nextValue
                          );

                          if (installment) {
                            setPaymentValue(String(Math.round(installment.saldoPendiente)));
                            setPaymentObservation(`Cuota ${installment.numero}`);
                          }
                        }}
                        className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      >
                        <option value="">Pago libre</option>
                        {(paymentOverview?.plan || [])
                          .filter((item) => item.saldoPendiente > 0)
                          .map((item) => (
                            <option key={item.numero} value={item.numero}>
                              Cuota {item.numero} - vence {dateTime(item.fechaVencimiento)} - saldo{" "}
                              {currency(item.saldoPendiente)}
                            </option>
                          ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Valor recibido
                      </label>
                      <input
                        value={paymentValue}
                        onChange={(event) => setPaymentValue(event.target.value)}
                        placeholder="Ejemplo: 50000"
                        className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Metodo de pago
                      </label>
                      <select
                        value={paymentMethod}
                        onChange={(event) => setPaymentMethod(event.target.value)}
                        className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
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
                      className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                    />
                  </div>

                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void registerPayment()}
                      disabled={registeringPayment || loadingPayments}
                      className="rounded-2xl bg-[#145a5a] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
                    >
                      {registeringPayment ? "Registrando..." : "Registrar abono"}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPaymentValue("");
                        setPaymentObservation("");
                        setPaymentMethod("EFECTIVO");
                        setSelectedInstallmentNumber("");
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
                        Cuotas pendientes y realizadas
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

                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead className="text-[11px] uppercase tracking-[0.16em] text-slate-500">
                        <tr>
                          <th className="px-3 py-3">Cuota</th>
                          <th className="px-3 py-3">Vence</th>
                          <th className="px-3 py-3">Valor</th>
                          <th className="px-3 py-3">Abonado</th>
                          <th className="px-3 py-3">Saldo</th>
                          <th className="px-3 py-3">Estado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(paymentOverview?.plan || []).map((item) => (
                          <tr key={item.numero}>
                            <td className="px-3 py-3 font-bold text-slate-950">
                              {item.numero}
                            </td>
                            <td className="px-3 py-3 text-slate-600">
                              {dateTime(item.fechaVencimiento)}
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
                                  item.estado === "MORA"
                                    ? "border-red-200 bg-red-50 text-red-700"
                                    : item.estado === "PAGADA"
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                      : "border-sky-200 bg-sky-50 text-sky-700",
                                ].join(" ")}
                              >
                                {item.estado === "AL_DIA" ? "Al dia" : item.estado}
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

                <div className="mt-6">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Historial de abonos
                      </p>
                      <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                        Pagos registrados
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
                      payments.map((payment) => (
                        <div
                          key={payment.id}
                          className="rounded-[22px] border border-[#e6dece] bg-white px-4 py-4 shadow-sm"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                {dateTime(payment.fechaAbono)}
                              </p>
                              <p className="mt-2 text-lg font-black text-slate-950">
                                {currency(payment.valor)}
                              </p>
                              <p className="mt-1 text-sm text-slate-500">
                                Metodo: {paymentMethodLabel(payment.metodoPago)}
                              </p>
                              <p className="mt-1 text-sm text-slate-500">
                                Recibido por {payment.usuario.nombre}
                              </p>
                            </div>

                            <div className="max-w-sm rounded-2xl border border-slate-200 bg-[#fcfaf6] px-4 py-3 text-sm text-slate-600">
                              {payment.observacion || "Sin observacion"}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          )}
        </section>

        <section
          className={[
            "mt-8 rounded-[30px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)]",
            paymentsView || createClientMode || lookupMode ? "hidden" : "",
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
