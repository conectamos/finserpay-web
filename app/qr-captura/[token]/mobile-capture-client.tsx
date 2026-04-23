"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import FinserBrand from "@/app/_components/finser-brand";

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

const MOBILE_IMAGE_ACCEPT = "image/*,.heic,.heif";

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

function ensureVideoDataUrl(value: string) {
  const normalized = String(value || "").trim();

  if (!/^data:video\/(webm|mp4|ogg);base64,/i.test(normalized)) {
    throw new Error("El video debe guardarse en formato WebM, MP4 u OGG.");
  }

  if (normalized.length > 10_000_000) {
    throw new Error("El video es demasiado pesado. Graba una toma mas corta.");
  }

  return normalized;
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
  accept,
  preview,
  previewAlt,
  meta,
  uploading,
  onCameraChange,
  onGalleryChange,
  onCameraInput,
  onGalleryInput,
}: {
  title: string;
  description: string;
  token: string;
  uploadKind: PreviewKey;
  cameraCaptureMode: "user" | "environment";
  accept: string;
  preview: string | null;
  previewAlt: string;
  meta?: string;
  uploading: boolean;
  onCameraChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onGalleryChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onCameraInput: (event: FormEvent<HTMLInputElement>) => void;
  onGalleryInput: (event: FormEvent<HTMLInputElement>) => void;
}) {
  const cameraAccept = accept.startsWith("video") ? "video/*" : "image/*";

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

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Camara
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Abre la camara del celular para esta evidencia.
          </p>
          <input
            name="file"
            type="file"
            accept={cameraAccept}
            capture={cameraCaptureMode}
            disabled={uploading}
            onChange={onCameraChange}
            onInput={onCameraInput}
            className="mt-3 block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border-0 file:bg-[#0f172a] file:px-4 file:py-2 file:font-semibold file:text-white"
          />
          <form
            action={`/api/creditos/captura-session/${token}`}
            method="post"
            encType="multipart/form-data"
            className="mt-3"
          >
            <input type="hidden" name="kind" value={uploadKind} />
            <input type="hidden" name="source" value="camera-form" />
            <input type="hidden" name="redirectTo" value={`/qr-captura/${token}`} />
            <input
              name="file"
              type="file"
              accept={cameraAccept}
              capture={cameraCaptureMode}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border file:border-slate-300 file:bg-white file:px-4 file:py-2 file:font-semibold file:text-slate-700"
            />
            <button
              type="submit"
              className="mt-3 rounded-2xl bg-[#145a5a] px-4 py-3 text-sm font-semibold text-white"
            >
              Guardar en plataforma
            </button>
          </form>
        </div>

        <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Galeria
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Si la camara no abre, selecciona una imagen o video guardado.
          </p>
          <input
            name="file"
            type="file"
            accept={accept}
            disabled={uploading}
            onChange={onGalleryChange}
            onInput={onGalleryInput}
            className="mt-3 block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border file:border-slate-300 file:bg-white file:px-4 file:py-2 file:font-semibold file:text-slate-700"
          />
          <form
            action={`/api/creditos/captura-session/${token}`}
            method="post"
            encType="multipart/form-data"
            className="mt-3"
          >
            <input type="hidden" name="kind" value={uploadKind} />
            <input type="hidden" name="source" value="gallery-form" />
            <input type="hidden" name="redirectTo" value={`/qr-captura/${token}`} />
            <input
              name="file"
              type="file"
              accept={accept}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border file:border-slate-300 file:bg-white file:px-4 file:py-2 file:font-semibold file:text-slate-700"
            />
            <button
              type="submit"
              className="mt-3 rounded-2xl bg-[#145a5a] px-4 py-3 text-sm font-semibold text-white"
            >
              Guardar en plataforma
            </button>
          </form>
        </div>
      </div>

      <div className="mt-4 rounded-[22px] border border-dashed border-[#d9dfeb] bg-[#f8fafc] p-3">
        {preview ? (
          accept.startsWith("video") ? (
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
        const { [key]: _removed, ...rest } = current;
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
        `/api/creditos/captura-session/${token}`
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
    return () => {
      for (const value of Object.values(blobPreviewUrlsRef.current)) {
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
        `/api/creditos/captura-session/${token}`,
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
    } catch (error) {
      pushDebug(`Fallo la subida de ${uploadingState}.`);
      setNotice({
        tone: "red",
        text:
          error instanceof Error
            ? error.message
            : "No se pudo sincronizar la captura.",
      });
    } finally {
      setUploadingKey(null);
    }
  };

  const processImageFile = async (
    file: File | null | undefined,
    kind: ImageCaptureKind
  ) => {
    if (!file) {
      pushDebug(`No se recibio archivo para ${kind}.`);
      return;
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
          : await compressImageFile(file, 2200, 0.94);
      const capturedAt = new Date().toISOString();
      replaceLocalPreview(kind, compressedDataUrl);
      pushDebug(`Imagen procesada para ${kind}.`);

      if (kind === "selfie") {
        await savePatch(
          {
            selfieDataUrl: compressedDataUrl,
            selfieCapturedAt: capturedAt,
            selfieSource: "camera",
          },
          "Selfie enviada a la plataforma.",
          kind
        );
        return;
      }

      if (kind === "cedula-frente") {
        await savePatch(
          {
            cedulaFrenteDataUrl: compressedDataUrl,
            cedulaFrenteCapturedAt: capturedAt,
            cedulaFrenteSource: "camera",
          },
          "Frente de la cedula sincronizado.",
          kind
        );
        return;
      }

      await savePatch(
        {
          cedulaRespaldoDataUrl: compressedDataUrl,
          cedulaRespaldoCapturedAt: capturedAt,
          cedulaRespaldoSource: "camera",
        },
        "Respaldo de la cedula sincronizado.",
        kind
      );
    } catch (error) {
      pushDebug(`Error procesando ${kind}.`);
      setNotice({
        tone: "red",
        text: error instanceof Error ? error.message : "No se pudo cargar la foto.",
      });
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
      const durationSeconds = await readVideoDuration(file);

      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("No se pudo leer la duracion del video.");
      }

      if (durationSeconds > 7.5) {
        throw new Error("El video debe durar maximo 7 segundos.");
      }

      const capturedAt = new Date().toISOString();
      const dataUrl = ensureVideoDataUrl(await readFileAsDataUrl(file));
      replaceLocalPreview("video-aprobacion", dataUrl);
      pushDebug("Video procesado.");
      await savePatch(
        {
          videoAprobacionDataUrl: dataUrl,
          videoAprobacionCapturedAt: capturedAt,
          videoAprobacionSource: "camera",
          videoAprobacionDuration: Math.max(1, Math.round(durationSeconds)),
        },
        "Video de aprobacion sincronizado.",
        "video-aprobacion"
      );
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

  const handleImageInput = async (
    event: FormEvent<HTMLInputElement>,
    kind: ImageCaptureKind
  ) => {
    const file = event.currentTarget.files?.[0];
    pushDebug(`Evento input recibido para ${kind}.`);
    await processImageFile(file, kind);
  };

  const handleVideoCapture = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.target.value = "";
    await processVideoFile(file);
  };

  const handleVideoInput = async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    pushDebug("Evento input recibido para video.");
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
              build qr-v4
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
                accept={MOBILE_IMAGE_ACCEPT}
                preview={localPreviews.selfie || session?.evidence.selfieDataUrl || null}
                previewAlt="Selfie del cliente"
                meta={
                  session?.evidence.selfieReady
                    ? `Ultima captura: ${auditTime(session.evidence.selfieCapturedAt)}`
                    : undefined
                }
                uploading={uploadingKey === "selfie"}
                onCameraChange={(event) => void handleImageCapture(event, "selfie")}
                onGalleryChange={(event) => void handleImageCapture(event, "selfie")}
                onCameraInput={(event) => void handleImageInput(event, "selfie")}
                onGalleryInput={(event) => void handleImageInput(event, "selfie")}
              />

              <CaptureCard
                token={token}
                uploadKind="cedula-frente"
                title="Cedula - frente"
                description="Acerca bien la cédula para que el texto salga nítido."
                cameraCaptureMode="environment"
                accept={MOBILE_IMAGE_ACCEPT}
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
                onGalleryChange={(event) => void handleImageCapture(event, "cedula-frente")}
                onCameraInput={(event) => void handleImageInput(event, "cedula-frente")}
                onGalleryInput={(event) => void handleImageInput(event, "cedula-frente")}
              />

              <CaptureCard
                token={token}
                uploadKind="cedula-respaldo"
                title="Cedula - respaldo"
                description="Asegúrate de que el código y la fecha se puedan leer."
                cameraCaptureMode="environment"
                accept={MOBILE_IMAGE_ACCEPT}
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
                onGalleryChange={(event) =>
                  void handleImageCapture(event, "cedula-respaldo")
                }
                onCameraInput={(event) =>
                  void handleImageInput(event, "cedula-respaldo")
                }
                onGalleryInput={(event) =>
                  void handleImageInput(event, "cedula-respaldo")
                }
              />

              <CaptureCard
                token={token}
                uploadKind="video-aprobacion"
                title="Video de aprobacion"
                description='Graba un video de hasta 7 segundos diciendo: "Yo [nombre] apruebo la compra con FINSER PAY".'
                cameraCaptureMode="user"
                accept="video/*"
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
                onGalleryChange={(event) => void handleVideoCapture(event)}
                onCameraInput={(event) => void handleVideoInput(event)}
                onGalleryInput={(event) => void handleVideoInput(event)}
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
