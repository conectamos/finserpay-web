import { NextResponse } from "next/server";
import {
  resolveCaptureSessionOrigin,
  resolveCaptureSessionState,
  sanitizeCaptureSessionPatch,
  serializeCaptureSession,
} from "@/lib/credit-capture-session";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TokenRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

async function findSessionByToken(token: string) {
  return await (prisma as any).capturaCreditoSession.findUnique({
    where: {
      token,
    },
  });
}

function uploadedImageMimeType(file: File) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();

  if (/^image\/jpe?g$/i.test(type) || /\.(jpe?g)$/i.test(name)) {
    return "image/jpeg";
  }

  if (/^image\/png$/i.test(type) || /\.png$/i.test(name)) {
    return "image/png";
  }

  if (/^image\/webp$/i.test(type) || /\.webp$/i.test(name)) {
    return "image/webp";
  }

  return "";
}

function uploadedVideoMimeType(file: File) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();

  if (/^video\/webm$/i.test(type) || /\.webm$/i.test(name)) {
    return "video/webm";
  }

  if (/^video\/mp4$/i.test(type) || /\.mp4$/i.test(name)) {
    return "video/mp4";
  }

  if (/^video\/ogg$/i.test(type) || /\.ogg$/i.test(name)) {
    return "video/ogg";
  }

  return "";
}

async function uploadedFileToDataUrl(file: File, mimeType: string) {
  const buffer = Buffer.from(await file.arrayBuffer());
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function buildPatchFromMultipart(formData: FormData) {
  const kind = String(formData.get("kind") || "").trim().toLowerCase();
  const source = String(formData.get("source") || "upload").trim().slice(0, 20) || "upload";
  const file = formData.get("file");

  if (!(file instanceof File) || file.size <= 0) {
    throw new Error("No se recibio ningun archivo.");
  }

  const capturedAt = new Date().toISOString();

  if (kind === "selfie" || kind === "cedula-frente" || kind === "cedula-respaldo") {
    const mimeType = uploadedImageMimeType(file);

    if (!mimeType) {
      throw new Error("La imagen debe ser JPG, PNG o WEBP.");
    }

    const dataUrl = await uploadedFileToDataUrl(file, mimeType);
    const patch = sanitizeCaptureSessionPatch({
      ...(kind === "selfie"
        ? {
            selfieDataUrl: dataUrl,
            selfieCapturedAt: capturedAt,
            selfieSource: source,
          }
        : kind === "cedula-frente"
          ? {
              cedulaFrenteDataUrl: dataUrl,
              cedulaFrenteCapturedAt: capturedAt,
              cedulaFrenteSource: source,
            }
          : {
              cedulaRespaldoDataUrl: dataUrl,
              cedulaRespaldoCapturedAt: capturedAt,
              cedulaRespaldoSource: source,
            }),
    });

    if (
      (kind === "selfie" && !patch.selfieDataUrl) ||
      (kind === "cedula-frente" && !patch.cedulaFrenteDataUrl) ||
      (kind === "cedula-respaldo" && !patch.cedulaRespaldoDataUrl)
    ) {
      throw new Error("La imagen no se pudo preparar para la plataforma.");
    }

    return patch;
  }

  if (kind === "video-aprobacion") {
    const mimeType = uploadedVideoMimeType(file);

    if (!mimeType) {
      throw new Error("El video debe ser MP4, WEBM u OGG.");
    }

    const dataUrl = await uploadedFileToDataUrl(file, mimeType);
    const patch = sanitizeCaptureSessionPatch({
      videoAprobacionDataUrl: dataUrl,
      videoAprobacionCapturedAt: capturedAt,
      videoAprobacionSource: source,
      videoAprobacionDuration: null,
    });

    if (!patch.videoAprobacionDataUrl) {
      throw new Error("El video no se pudo preparar para la plataforma.");
    }

    return patch;
  }

  throw new Error("Tipo de evidencia no soportado.");
}

export async function GET(request: Request, context: TokenRouteContext) {
  const { token } = await context.params;
  const captureSession = await findSessionByToken(token);

  if (!captureSession) {
    return NextResponse.json({ error: "Sesion no encontrada" }, { status: 404 });
  }

  const estado = resolveCaptureSessionState(captureSession);

  if (estado !== captureSession.estado) {
    await (prisma as any).capturaCreditoSession.update({
      where: {
        id: captureSession.id,
      },
      data: {
        estado,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    session: serializeCaptureSession(
      {
        ...captureSession,
        estado,
      },
      resolveCaptureSessionOrigin(request)
    ),
  });
}

export async function POST(request: Request, context: TokenRouteContext) {
  const { token } = await context.params;
  const captureSession = await findSessionByToken(token);

  if (!captureSession) {
    return NextResponse.json({ error: "Sesion no encontrada" }, { status: 404 });
  }

  const currentState = resolveCaptureSessionState(captureSession);

  if (currentState === "EXPIRADA") {
    await (prisma as any).capturaCreditoSession.update({
      where: {
        id: captureSession.id,
      },
      data: {
        estado: "EXPIRADA",
      },
    });

    return NextResponse.json(
      { error: "El QR ya expiro. Genera uno nuevo en la plataforma." },
      { status: 410 }
    );
  }

  const contentType = request.headers.get("content-type") || "";
  const isMultipart = contentType.toLowerCase().includes("multipart/form-data");
  const formData = isMultipart ? await request.formData() : null;
  const redirectToRaw = formData ? String(formData.get("redirectTo") || "") : "";
  const body = isMultipart
    ? null
    : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
  const patch = isMultipart
    ? await buildPatchFromMultipart(formData as FormData)
    : sanitizeCaptureSessionPatch(body as Record<string, unknown>);
  const candidate = {
    ...captureSession,
    ...patch,
  };
  const nextState = resolveCaptureSessionState(candidate);

  const updated = await (prisma as any).capturaCreditoSession.update({
    where: {
      id: captureSession.id,
    },
    data: {
      ...patch,
      estado: nextState,
    },
  });

  if (isMultipart) {
    const redirectTo = redirectToRaw || `/qr-captura/${token}`;
    return NextResponse.redirect(new URL(redirectTo, resolveCaptureSessionOrigin(request)), {
      status: 303,
    });
  }

  return NextResponse.json({
    ok: true,
    session: serializeCaptureSession(updated, resolveCaptureSessionOrigin(request)),
  });
}
