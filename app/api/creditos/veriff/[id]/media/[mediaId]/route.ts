import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { canAccessVeriffValidation } from "@/lib/veriff-access";
import { getVeriffValidationById } from "@/lib/veriff-storage";
import { veriffDownloadMedia, veriffGetSessionMedia } from "@/lib/veriff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value: string) {
  const numeric = Math.trunc(Number(value));
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function mediaBelongsToSession(payload: Record<string, unknown>, mediaId: string) {
  return [...asArray(payload.images), ...asArray(payload.videos)].some((item) => {
    const record = asRecord(item);
    return cleanText(record?.id) === mediaId;
  });
}

function fileExtension(contentType: string) {
  if (contentType.includes("png")) {
    return "png";
  }
  if (contentType.includes("webp")) {
    return "webp";
  }
  if (contentType.includes("mp4")) {
    return "mp4";
  }
  if (contentType.includes("webm")) {
    return "webm";
  }
  return "jpg";
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; mediaId: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const params = await context.params;
    const id = parseId(params.id);
    const mediaId = cleanText(params.mediaId);

    if (!id || !mediaId) {
      return NextResponse.json({ ok: false, error: "Media Veriff invalido" }, { status: 400 });
    }

    const validation = await getVeriffValidationById(id);

    if (!validation) {
      return NextResponse.json(
        { ok: false, error: "Validacion Veriff no encontrada" },
        { status: 404 }
      );
    }

    if (!canAccessVeriffValidation(user, validation)) {
      return NextResponse.json(
        { ok: false, error: "No tienes acceso a esta validacion" },
        { status: 403 }
      );
    }

    if (!validation.veriffSessionId) {
      return NextResponse.json(
        { ok: false, error: "Validacion Veriff sin sesion remota" },
        { status: 404 }
      );
    }

    const mediaPayload = await veriffGetSessionMedia(validation.veriffSessionId);

    if (!mediaBelongsToSession(mediaPayload, mediaId)) {
      return NextResponse.json(
        { ok: false, error: "Media Veriff no pertenece a esta validacion" },
        { status: 404 }
      );
    }

    const media = await veriffDownloadMedia(mediaId);
    const contentType = media.contentType.toLowerCase();

    if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
      return NextResponse.json(
        { ok: false, error: "Tipo de media Veriff no permitido" },
        { status: 415 }
      );
    }

    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="veriff-${mediaId}.${fileExtension(contentType)}"`,
      "Content-Type": media.contentType,
    });

    if (media.contentLength) {
      headers.set("Content-Length", media.contentLength);
    }

    return new Response(media.arrayBuffer, { headers });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "No se pudo descargar la evidencia Veriff";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
