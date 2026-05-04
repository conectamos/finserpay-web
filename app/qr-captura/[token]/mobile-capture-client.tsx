"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import FinserBrand from "@/app/_components/finser-brand";
import {
  MAX_VIDEO_DATA_URL_LENGTH,
  MAX_VIDEO_UPLOAD_BYTES,
} from "@/lib/credit-factory";

type CaptureSessionPayload = {
  token: string;
  estado: string;
  expiresAt: string;
  expired: boolean;
  mobileUrl: string;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
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

type CaptureSessionResponse = {
  ok?: boolean;
  error?: string;
  session?: CaptureSessionPayload;
};

type NoticeTone = "emerald" | "amber" | "red" | "slate";

type ImageCaptureKind = "selfie" | "cedula-frente" | "cedula-respaldo";

type PreviewKey = ImageCaptureKind | "video-aprobacion";

type LocalPreviewMap = Partial<Record<PreviewKey, string>>;

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

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
  });
  const data = (await response.json().catch(() => null)) as T & { error?: string };

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function requestMultipart<T>(url: string, formData: FormData) {
  const response = await fetch(url, {
    cache: "no-store",
    method: "POST",
    body: formData,
  });
  const data = (await response.json().catch(() => null)) as T & { error?: string };

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function normalizeVideoDataUrl(value: string, file: File) {
  let normalized = String(value || "").trim();
  const inferredMimeType = inferVideoMimeType(file);

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

  if (normalized.length > MAX_VIDEO_DATA_URL_LENGTH) {
    throw new Error("El video es demasiado pesado. Graba una toma mas corta.");
  }

  return normalized;
}

async function readFileAsDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

async function loadImageDimensions(source: string) {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("La imagen seleccionada no se pudo abrir."));
    image.src = source;
  });
}

async function normalizeImageFile(file: File) {
  const fileType = String(file.type || "").toLowerCase();

  if (!/(heic|heif)/i.test(fileType) && !/\.(heic|heif)$/i.test(file.name || "")) {
    return file;
  }

  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.92,
  });
  const blob = Array.isArray(converted) ? converted[0] : converted;

  if (!(blob instanceof Blob)) {
    throw new Error("No se pudo convertir la foto HEIC del iPhone.");
  }

  const safeName = (file.name || "captura").replace(/\.(heic|heif)$/i, "");
  return new File([blob], `${safeName}.jpg`, {
    type: "image/jpeg",
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

async function compressImageSource(
  source: string,
  maxSide = 960,
  quality = 0.82
) {
  const image = await loadImageDimensions(source);
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("No se pudo preparar la imagen.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function compressImageFile(file: File, maxSide = 960, quality = 0.82) {
  const normalizedFile = await normalizeImageFile(file);
  const objectUrl = URL.createObjectURL(normalizedFile);

  try {
    return await compressImageSource(objectUrl, maxSide, quality);
  } catch (error) {
    const originalDataUrl = await readFileAsDataUrl(normalizedFile);

    try {
      return await compressImageSource(originalDataUrl, maxSide, quality);
    } catch {
      if (/^data:image\/(png|jpe?g|webp);base64,/i.test(originalDataUrl)) {
        return originalDataUrl;
      }

      throw error instanceof Error
        ? error
        : new Error("La imagen seleccionada no es valida.");
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function inferVideoMimeType(file: File) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();

  if (/^video\/(webm|mp4|ogg|quicktime|mov|x-m4v)$/i.test(type)) {
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

function auditTime(value: string | null) {
  return value ? new Date(value).toLocaleString("es-CO") : "Pendiente";
}

function CaptureCard({
  title,
  description,
  token,
  uploadKind,
  cameraCaptureMode,
  documentCamera = false,
  preview,
  previewAlt,
  meta,
  uploading,
  onCameraChange,
  onOpenDocumentCamera,
}: {
  title: string;
  description: string;
  token: string;
  uploadKind: PreviewKey;
  cameraCaptureMode: "user" | "environment";
  documentCamera?: boolean;
  preview: string | null;
  previewAlt: string;
  meta?: string;
  uploading: boolean;
  onCameraChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenDocumentCamera?: () => void;
}) {
  const videoCapture = uploadKind === "video-aprobacion";
  const cameraAccept = videoCapture ? "video/*" : "image/*";
  const actionLabel = videoCapture ? "Tomar video" : "Tomar foto";
  const inputId = `capture-${uploadKind}`;

  return (
    <div className="rounded-[28px] border border-[#d9dfeb] bg-white p-5 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Evidencia
          </p>
          <h3 className="mt-2 text-xl font-black text-slate-950">{title}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
        </div>
      </div>

      <div className="mt-4 rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Camara del celular
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          {videoCapture
            ? "Graba el video y espera el mensaje de sincronizacion."
            : documentCamera
              ? "Modo OCR: pon solo la cedula dentro del marco horizontal."
              : "Toma la foto y espera el mensaje de sincronizacion."}
        </p>
        <div className="mt-4">
          <input
            id={inputId}
            name="file"
            type="file"
            accept={cameraAccept}
            capture={cameraCaptureMode}
            disabled={uploading}
            onChange={onCameraChange}
            className="sr-only"
          />
          <label
            htmlFor={inputId}
            className={[
              "inline-flex w-full items-center justify-center rounded-[18px] px-5 py-4 text-base font-black text-white shadow-[0_14px_26px_rgba(15,23,42,0.14)] transition",
              uploading
                ? "pointer-events-none bg-slate-400"
                : "bg-[#0f172a] active:scale-[0.99]",
            ].join(" ")}
          >
            {uploading ? "Subiendo..." : documentCamera ? "Tomar foto OCR" : actionLabel}
          </label>
        </div>
      </div>

      <div className="mt-4 rounded-[22px] border border-dashed border-[#d9dfeb] bg-[#f8fafc] p-3">
        {preview ? (
          videoCapture ? (
            <video
              src={preview}
              controls
              className="h-56 w-full rounded-[18px] bg-slate-950 object-contain"
            />
          ) : (
            <img
              src={preview}
              alt={previewAlt}
              className="h-56 w-full rounded-[18px] object-cover"
            />
          )
        ) : (
          <div className="flex h-56 items-center justify-center rounded-[18px] bg-white text-sm text-slate-500">
            Aun no hay captura.
          </div>
        )}
      </div>

      {meta ? (
        <p className="mt-3 text-xs font-medium leading-5 text-slate-500">{meta}</p>
      ) : null}
    </div>
  );
}

function DocumentOcrCamera({
  slot,
  onClose,
  onCapture,
  onNativeCapture,
}: {
  slot: ImageCaptureKind | null;
  onClose: () => void;
  onCapture: (dataUrl: string, slot: ImageCaptureKind) => Promise<boolean> | boolean;
  onNativeCapture: (file: File, slot: ImageCaptureKind) => Promise<boolean> | boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const nativeInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const open = slot === "cedula-frente" || slot === "cedula-respaldo";

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    let active = true;

    const startCamera = async () => {
      if (!open) {
        return;
      }

      try {
        setError("");
        setCameraReady(false);
        setCapturing(false);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
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
      } catch {
        setError("No se pudo abrir la camara. Revisa permisos y vuelve a intentar.");
      }
    };

    void startCamera();

    return () => {
      active = false;
      stopCamera();
    };
  }, [open]);

  if (!open || !slot) {
    return null;
  }

  const captureDocument = async () => {
    const video = videoRef.current;

    if (!video || !video.videoWidth || !video.videoHeight) {
      setError("La camara aun no esta lista.");
      return;
    }

    try {
      setCapturing(true);
      setError("");
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      const targetRatio = 1.586;
      let cropWidth = sourceWidth * 0.88;
      let cropHeight = cropWidth / targetRatio;

      if (cropHeight > sourceHeight * 0.72) {
        cropHeight = sourceHeight * 0.72;
        cropWidth = cropHeight * targetRatio;
      }

      const cropX = Math.max(0, (sourceWidth - cropWidth) / 2);
      const cropY = Math.max(0, (sourceHeight - cropHeight) / 2);
      const canvas = document.createElement("canvas");
      canvas.width = 1400;
      canvas.height = Math.round(canvas.width / targetRatio);
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("No se pudo preparar la captura.");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        video,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        0,
        0,
        canvas.width,
        canvas.height
      );

      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);

      if (dataUrl.length > 2_400_000) {
        throw new Error("La captura quedo muy pesada. Acerca un poco menos la cedula y vuelve a tomarla.");
      }

      const saved = await onCapture(dataUrl, slot);

      if (saved) {
        stopCamera();
        onClose();
      }
    } catch (captureError) {
      setError(
        captureError instanceof Error
          ? captureError.message
          : "No se pudo capturar la cedula."
      );
    } finally {
      setCapturing(false);
    }
  };

  const handleNativeCapture = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      setCapturing(true);
      setError("");
      const saved = await onNativeCapture(file, slot);

      if (saved) {
        stopCamera();
        onClose();
      }
    } catch (nativeError) {
      setError(
        nativeError instanceof Error
          ? nativeError.message
          : "No se pudo guardar la foto directa."
      );
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 text-white">
      <div className="flex min-h-screen flex-col">
        <div className="flex items-center justify-between px-4 py-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-200">
              Modo OCR
            </p>
            <h2 className="mt-1 text-lg font-black">
              {slot === "cedula-frente" ? "Cedula frente" : "Cedula respaldo"}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="rounded-2xl border border-white/20 px-4 py-2 text-sm font-bold"
          >
            Cerrar
          </button>
        </div>

        <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            onLoadedMetadata={() => setCameraReady(true)}
            onCanPlay={() => setCameraReady(true)}
            className="h-full w-full object-cover"
          />
          <div className="pointer-events-none absolute left-1/2 top-1/2 aspect-[1.586/1] w-[88vw] max-w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border-4 border-emerald-300 shadow-[0_0_0_999px_rgba(2,6,23,0.54)]" />
          <div className="pointer-events-none absolute bottom-28 left-5 right-5 rounded-2xl bg-black/50 px-4 py-3 text-center text-sm font-semibold leading-5">
            Ubica solo la cedula dentro del marco. Sin dedos, sin brillo y en horizontal.
          </div>
        </div>

        {error ? (
          <div className="mx-4 mt-4 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {error}
          </div>
        ) : null}

        <div className="grid gap-3 px-4 py-5">
          <input
            ref={nativeInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => void handleNativeCapture(event)}
            className="sr-only"
          />
          <button
            type="button"
            onClick={() => void captureDocument()}
            disabled={!cameraReady || capturing}
            className="rounded-[20px] bg-emerald-400 px-5 py-4 text-base font-black text-slate-950 shadow-[0_18px_36px_rgba(16,185,129,0.26)] disabled:bg-slate-500 disabled:text-white"
          >
            {capturing ? "Guardando..." : cameraReady ? "Capturar cedula" : "Preparando camara..."}
          </button>
          <button
            type="button"
            onClick={() => nativeInputRef.current?.click()}
            disabled={capturing}
            className="rounded-[20px] border border-white/20 bg-white/10 px-5 py-4 text-base font-black text-white disabled:opacity-50"
          >
            Tomar foto directa
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MobileCaptureClient({
  token,
  initialSession = null,
}: {
  token: string;
  initialSession?: CaptureSessionPayload | null;
}) {
  const [session, setSession] = useState<CaptureSessionPayload | null>(initialSession);
  const [loading, setLoading] = useState(!initialSession);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(
    null
  );
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [documentCameraSlot, setDocumentCameraSlot] =
    useState<ImageCaptureKind | null>(null);
  const [localPreviews, setLocalPreviews] = useState<LocalPreviewMap>({});
  const [debugEvents, setDebugEvents] = useState<string[]>([]);
  const blobPreviewUrlsRef = useRef<Partial<Record<PreviewKey, string>>>({});

  const pushDebug = (message: string) => {
    const line = `${new Date().toLocaleTimeString("es-CO")}: ${message}`;
    setDebugEvents((current) => [line, ...current].slice(0, 8));
  };

  const replaceLocalPreview = (key: PreviewKey, nextValue: string | null) => {
    setLocalPreviews((current) => {
      const previous = current[key];

      if (previous?.startsWith("blob:")) {
        URL.revokeObjectURL(previous);
      }

      if (!nextValue) {
        const rest = { ...current };
        delete rest[key];
        delete blobPreviewUrlsRef.current[key];
        return rest;
      }

      if (nextValue.startsWith("blob:")) {
        blobPreviewUrlsRef.current[key] = nextValue;
      } else {
        delete blobPreviewUrlsRef.current[key];
      }

      return {
        ...current,
        [key]: nextValue,
      };
    });
  };

  const loadSession = async () => {
    try {
      pushDebug("Consultando sesion QR...");
      const result = await requestJson<CaptureSessionResponse>(
        `/api/creditos/captura-session/${token}?compactVideo=true`
      );

      if (!result.ok || !result.data?.session) {
        throw new Error(result.data?.error || "No se pudo abrir la sesion de captura.");
      }

      setSession(result.data.session);
      pushDebug("Sesion QR cargada.");
    } catch (error) {
      pushDebug("Error al cargar la sesion QR.");
      setNotice({
        tone: "red",
        text:
          error instanceof Error
            ? error.message
            : "No se pudo abrir la sesion de captura.",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialSession) {
      setSession(initialSession);
      setLoading(false);
    }
  }, [initialSession]);

  useEffect(() => {
    const previewUrls = blobPreviewUrlsRef.current;

    return () => {
      for (const value of Object.values(previewUrls)) {
        if (value?.startsWith("blob:")) {
          URL.revokeObjectURL(value);
        }
      }
    };
  }, []);

  useEffect(() => {
    void loadSession();
  }, [token]);

  const savePatch = async (
    patch: Record<string, unknown>,
    successText: string,
    uploadingState: string
  ) => {
    try {
      setUploadingKey(uploadingState);
      pushDebug(`Subiendo evidencia ${uploadingState}...`);
      const result = await requestJson<CaptureSessionResponse>(
        `/api/creditos/captura-session/${token}?compactVideo=true`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(patch),
        }
      );

      if (!result.ok || !result.data?.session) {
        throw new Error(result.data?.error || "No se pudo sincronizar la captura.");
      }

      setSession(result.data.session);
      pushDebug(`Evidencia ${uploadingState} sincronizada.`);
      setNotice({
        tone: "emerald",
        text: successText,
      });
      return true;
    } catch (error) {
      pushDebug(`Fallo la subida de ${uploadingState}.`);
      setNotice({
        tone: "red",
        text:
          error instanceof Error
            ? error.message
            : "No se pudo sincronizar la captura.",
      });
      return false;
    } finally {
      setUploadingKey(null);
    }
  };

  const saveMultipartEvidence = async (
    formData: FormData,
    successText: string,
    uploadingState: string
  ) => {
    try {
      setUploadingKey(uploadingState);
      pushDebug(`Subiendo evidencia ${uploadingState}...`);
      const result = await requestMultipart<CaptureSessionResponse>(
        `/api/creditos/captura-session/${token}?compactVideo=true`,
        formData
      );

      if (!result.ok || !result.data?.session) {
        throw new Error(result.data?.error || "No se pudo sincronizar la captura.");
      }

      setSession(result.data.session);
      pushDebug(`Evidencia ${uploadingState} sincronizada.`);
      setNotice({
        tone: "emerald",
        text: successText,
      });
      return result.data.session;
    } catch (error) {
      pushDebug(`Fallo la subida de ${uploadingState}.`);
      setNotice({
        tone: "red",
        text:
          error instanceof Error
            ? error.message
            : "No se pudo sincronizar la captura.",
      });
      return null;
    } finally {
      setUploadingKey(null);
    }
  };

  const saveVideoEvidenceJsonFallback = async (
    file: File,
    durationSeconds: number
  ) => {
    pushDebug("Intentando respaldo JSON para video...");
    const dataUrl = normalizeVideoDataUrl(await readFileAsDataUrl(file), file);
    return await savePatch(
      {
        videoAprobacionDataUrl: dataUrl,
        videoAprobacionCapturedAt: new Date().toISOString(),
        videoAprobacionSource: "camera",
        videoAprobacionDuration: Math.max(1, Math.round(durationSeconds)),
      },
      "Video de aprobacion sincronizado.",
      "video-aprobacion"
    );
  };

  const saveImageEvidenceDataUrl = async (
    kind: ImageCaptureKind,
    dataUrl: string
  ) => {
    const capturedAt = new Date().toISOString();
    replaceLocalPreview(kind, dataUrl);
    pushDebug(`Imagen procesada para ${kind}.`);

    if (kind === "selfie") {
      return await savePatch(
        {
          selfieDataUrl: dataUrl,
          selfieCapturedAt: capturedAt,
          selfieSource: "camera",
        },
        "Selfie enviada a la plataforma.",
        kind
      );
    }

    if (kind === "cedula-frente") {
      return await savePatch(
        {
          cedulaFrenteDataUrl: dataUrl,
          cedulaFrenteCapturedAt: capturedAt,
          cedulaFrenteSource: "camera",
        },
        "Frente de la cedula sincronizado.",
        kind
      );
    }

    return await savePatch(
      {
        cedulaRespaldoDataUrl: dataUrl,
        cedulaRespaldoCapturedAt: capturedAt,
        cedulaRespaldoSource: "camera",
      },
      "Respaldo de la cedula sincronizado.",
      kind
    );
  };

  const processImageFile = async (
    file: File | null | undefined,
    kind: ImageCaptureKind
  ) => {
    if (!file) {
      pushDebug(`No se recibio archivo para ${kind}.`);
      return false;
    }

    try {
      const fileType = String(file.type || "").toLowerCase();
      pushDebug(
        `Archivo ${kind}: ${file.name || "sin-nombre"} | ${file.type || "sin-tipo"} | ${Math.round(file.size / 1024)} KB`
      );

      if (
        fileType &&
        !/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(fileType)
      ) {
        throw new Error(
          `La foto llego en formato ${file.type || "desconocido"}. En iPhone cambia Ajustes > Camara > Formatos a "Mas compatible" y vuelve a tomarla.`
        );
      }

      const previewUrl = URL.createObjectURL(file);
      replaceLocalPreview(kind, previewUrl);
      pushDebug(`Preview local lista para ${kind}.`);
      const compressedDataUrl =
        kind === "selfie"
          ? await compressImageFile(file, 1080, 0.84)
          : await compressImageFile(file, 1600, 0.86);
      return await saveImageEvidenceDataUrl(kind, compressedDataUrl);
    } catch (error) {
      pushDebug(`Error procesando ${kind}.`);
      setNotice({
        tone: "red",
        text: error instanceof Error ? error.message : "No se pudo cargar la foto.",
      });
      return false;
    }
  };

  const processVideoFile = async (file: File | null | undefined) => {
    if (!file) {
      pushDebug("No se recibio video.");
      return;
    }

    try {
      pushDebug(
        `Video recibido: ${file.name || "sin-nombre"} | ${file.type || "sin-tipo"} | ${Math.round(file.size / 1024)} KB`
      );
      const previewUrl = URL.createObjectURL(file);
      replaceLocalPreview("video-aprobacion", previewUrl);
      pushDebug("Preview local lista para video.");

      if (!inferVideoMimeType(file)) {
        throw new Error("El video debe estar en formato MP4, MOV, WEBM u OGG.");
      }

      if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
        throw new Error("El video es demasiado pesado. Graba una toma mas corta.");
      }

      const durationSeconds = await readVideoDuration(file);

      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("No se pudo leer la duracion del video.");
      }

      if (durationSeconds > 7.5) {
        throw new Error("El video debe durar maximo 7 segundos.");
      }

      const formData = new FormData();
      formData.set("kind", "video-aprobacion");
      formData.set("source", "camera");
      formData.set("duration", String(Math.max(1, Math.round(durationSeconds))));
      formData.set("file", file, file.name || "video-aprobacion.mov");
      pushDebug("Video procesado.");
      const savedSession = await saveMultipartEvidence(
        formData,
        "Video de aprobacion sincronizado.",
        "video-aprobacion"
      );

      if (!savedSession?.evidence.videoReady) {
        const fallbackSaved = await saveVideoEvidenceJsonFallback(file, durationSeconds);

        if (!fallbackSaved) {
          await loadSession();
        }
      }
    } catch (error) {
      pushDebug("Error procesando video.");
      setNotice({
        tone: "red",
        text: error instanceof Error ? error.message : "No se pudo cargar el video.",
      });
    }
  };

  const handleImageCapture = async (
    event: ChangeEvent<HTMLInputElement>,
    kind: ImageCaptureKind
  ) => {
    const file = event.currentTarget.files?.[0];
    event.target.value = "";
    await processImageFile(file, kind);
  };

  const handleDocumentCameraCapture = async (
    dataUrl: string,
    kind: ImageCaptureKind
  ) => {
    try {
      pushDebug(`Captura OCR recibida para ${kind}.`);
      return await saveImageEvidenceDataUrl(kind, dataUrl);
    } catch (error) {
      pushDebug(`Error procesando captura OCR ${kind}.`);
      setNotice({
        tone: "red",
        text: error instanceof Error ? error.message : "No se pudo cargar la foto.",
      });
      return false;
    }
  };

  const handleVideoCapture = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.target.value = "";
    await processVideoFile(file);
  };

  const completedCount = useMemo(() => {
    if (!session) {
      return 0;
    }

    return [
      session.evidence.selfieReady,
      session.evidence.cedulaFrenteReady,
      session.evidence.cedulaRespaldoReady,
      session.evidence.videoReady,
    ].filter(Boolean).length;
  }, [session]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[linear-gradient(180deg,#eef2f8_0%,#f7f8fb_100%)] px-4 py-8">
        <div className="mx-auto max-w-3xl rounded-[32px] border border-slate-200 bg-white px-6 py-10 text-center shadow-[0_18px_48px_rgba(15,23,42,0.08)]">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            FINSER PAY
          </p>
          <p className="mt-4 text-lg font-semibold text-slate-900">
            Abriendo la sesion de captura...
          </p>
        </div>
      </div>
    );
  }

  const expired = !session || session.expired || session.estado === "EXPIRADA";

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#eef2f8_0%,#f7f8fb_100%)] px-4 py-8">
      <DocumentOcrCamera
        slot={documentCameraSlot}
        onClose={() => setDocumentCameraSlot(null)}
        onCapture={handleDocumentCameraCapture}
        onNativeCapture={(file, slot) => processImageFile(file, slot)}
      />
      <div className="mx-auto max-w-5xl space-y-5">
        <section className="rounded-[32px] bg-[linear-gradient(135deg,#0f172a_0%,#1f2937_54%,#2c2f37_100%)] px-6 py-6 text-white shadow-[0_22px_55px_rgba(15,23,42,0.28)]">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-4">
              <FinserBrand dark />
              <div>
                <div className="inline-flex rounded-full border border-white/20 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-200">
                  Paso 3 - Identidad
                </div>
                <h1 className="mt-4 text-3xl font-black tracking-tight">
                  Toma las evidencias desde el celular
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
                  Captura selfie, cédula por ambos lados y el video de aprobación.
                  Cada evidencia se sincroniza automáticamente con la venta abierta
                  en la plataforma.
                </p>
              </div>
            </div>

            <div className="rounded-[24px] border border-white/15 bg-white/5 px-5 py-4 text-sm text-slate-200">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">
                Sesion
              </p>
              <p className="mt-2 font-semibold">{session?.clienteNombre || "Cliente en venta"}</p>
              <p className="mt-1 text-xs text-slate-300">
                Documento: {session?.clienteDocumento || "Pendiente"}
              </p>
              <p className="mt-1 text-xs text-slate-300">
                Expira: {session?.expiresAt ? new Date(session.expiresAt).toLocaleString("es-CO") : "-"}
              </p>
              <p className="mt-3 text-2xl font-black">{completedCount}/4</p>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-300">
                Evidencias sincronizadas
              </p>
            </div>
          </div>
        </section>

        {notice ? (
          <div className={`rounded-[24px] border px-5 py-4 text-sm leading-6 ${noticeClasses(notice.tone)}`}>
            {notice.text}
          </div>
        ) : null}

        <section className="rounded-[24px] border border-[#d9dfeb] bg-white px-5 py-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                Depuracion movil
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Si algo falla, aqui debe salir en que punto se detuvo.
              </p>
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              build qr-v6
            </span>
          </div>
          <div className="mt-4 space-y-2">
            {debugEvents.length ? (
              debugEvents.map((line) => (
                <div
                  key={line}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
                >
                  {line}
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                Aun no hay eventos de captura.
              </div>
            )}
          </div>
        </section>

        {expired ? (
          <section className="rounded-[28px] border border-amber-200 bg-amber-50 px-6 py-6 text-sm leading-7 text-amber-900 shadow-[0_14px_34px_rgba(15,23,42,0.05)]">
            Esta sesion ya expiro. Vuelve al computador y genera un QR nuevo para continuar.
          </section>
        ) : (
          <>
            <section className="grid gap-4 md:grid-cols-2">
              <CaptureCard
                token={token}
                uploadKind="selfie"
                title="Selfie del cliente"
                description="Usa la cámara frontal y procura que la cara quede bien iluminada."
                cameraCaptureMode="user"
                preview={localPreviews.selfie || session?.evidence.selfieDataUrl || null}
                previewAlt="Selfie del cliente"
                meta={
                  session?.evidence.selfieReady
                    ? `Ultima captura: ${auditTime(session.evidence.selfieCapturedAt)}`
                    : undefined
                }
                uploading={uploadingKey === "selfie"}
                onCameraChange={(event) => void handleImageCapture(event, "selfie")}
              />

              <CaptureCard
                token={token}
                uploadKind="cedula-frente"
                title="Cedula - frente"
                description="Acerca bien la cédula para que el texto salga nítido."
                cameraCaptureMode="environment"
                documentCamera
                preview={
                  localPreviews["cedula-frente"] ||
                  session?.evidence.cedulaFrenteDataUrl ||
                  null
                }
                previewAlt="Cedula frente"
                meta={
                  session?.evidence.cedulaFrenteReady
                    ? `Ultima captura: ${auditTime(session.evidence.cedulaFrenteCapturedAt)}`
                    : undefined
                }
                uploading={uploadingKey === "cedula-frente"}
                onCameraChange={(event) => void handleImageCapture(event, "cedula-frente")}
                onOpenDocumentCamera={() => setDocumentCameraSlot("cedula-frente")}
              />

              <CaptureCard
                token={token}
                uploadKind="cedula-respaldo"
                title="Cedula - respaldo"
                description="Asegúrate de que el código y la fecha se puedan leer."
                cameraCaptureMode="environment"
                documentCamera
                preview={
                  localPreviews["cedula-respaldo"] ||
                  session?.evidence.cedulaRespaldoDataUrl ||
                  null
                }
                previewAlt="Cedula respaldo"
                meta={
                  session?.evidence.cedulaRespaldoReady
                    ? `Ultima captura: ${auditTime(session.evidence.cedulaRespaldoCapturedAt)}`
                    : undefined
                }
                uploading={uploadingKey === "cedula-respaldo"}
                onCameraChange={(event) =>
                  void handleImageCapture(event, "cedula-respaldo")
                }
                onOpenDocumentCamera={() => setDocumentCameraSlot("cedula-respaldo")}
              />

              <CaptureCard
                token={token}
                uploadKind="video-aprobacion"
                title="Video de aprobacion"
                description='Graba un video de hasta 7 segundos diciendo: "Yo [nombre] apruebo la compra con FINSER PAY".'
                cameraCaptureMode="user"
                preview={
                  localPreviews["video-aprobacion"] ||
                  session?.evidence.videoAprobacionDataUrl ||
                  null
                }
                previewAlt="Video de aprobacion"
                meta={
                  session?.evidence.videoReady
                    ? `Ultimo video: ${auditTime(session.evidence.videoAprobacionCapturedAt)}${
                        session.evidence.videoAprobacionDuration
                          ? ` | ${session.evidence.videoAprobacionDuration}s`
                          : ""
                      }`
                    : undefined
                }
                uploading={uploadingKey === "video-aprobacion"}
                onCameraChange={(event) => void handleVideoCapture(event)}
              />
            </section>

            <section className="rounded-[28px] border border-[#d9dfeb] bg-white px-6 py-6 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                Como sigue
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-4">
                {[
                  { label: "Selfie", ready: session?.evidence.selfieReady },
                  {
                    label: "Cedula frente",
                    ready: session?.evidence.cedulaFrenteReady,
                  },
                  {
                    label: "Cedula respaldo",
                    ready: session?.evidence.cedulaRespaldoReady,
                  },
                  { label: "Video", ready: session?.evidence.videoReady },
                ].map((item) => (
                  <div
                    key={item.label}
                    className={`rounded-[20px] border px-4 py-4 text-sm font-semibold ${
                      item.ready
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-amber-200 bg-amber-50 text-amber-700"
                    }`}
                  >
                    {item.label}: {item.ready ? "Sincronizado" : "Pendiente"}
                  </div>
                ))}
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                Cuando termines, vuelve al computador. La plataforma cargará las
                evidencias automáticamente y podrás seguir con OTP, firma y contratos.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
