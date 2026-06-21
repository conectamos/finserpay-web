import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { canAccessVeriffValidation } from "@/lib/veriff-access";
import { getVeriffValidationById } from "@/lib/veriff-storage";
import { veriffGetSessionMedia } from "@/lib/veriff";

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

function normalizeMediaItem(
  validationId: number,
  item: unknown,
  kind: "image" | "video"
) {
  const record = asRecord(item);
  const id = cleanText(record?.id);

  if (!record || !id) {
    return null;
  }

  return {
    id,
    context: cleanText(record.context),
    downloadUrl: `/api/creditos/veriff/${validationId}/media/${encodeURIComponent(id)}`,
    duration:
      typeof record.duration === "number" && Number.isFinite(record.duration)
        ? record.duration
        : null,
    kind,
    mimetype: cleanText(record.mimetype),
    name: cleanText(record.name),
    size:
      typeof record.size === "number" && Number.isFinite(record.size)
        ? record.size
        : null,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const params = await context.params;
    const id = parseId(params.id);

    if (!id) {
      return NextResponse.json({ ok: false, error: "Validacion invalida" }, { status: 400 });
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
      return NextResponse.json({ ok: true, images: [], videos: [] });
    }

    const payload = await veriffGetSessionMedia(validation.veriffSessionId);

    return NextResponse.json({
      ok: true,
      images: asArray(payload.images)
        .map((item) => normalizeMediaItem(id, item, "image"))
        .filter(Boolean),
      videos: asArray(payload.videos)
        .map((item) => normalizeMediaItem(id, item, "video"))
        .filter(Boolean),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo consultar la evidencia Veriff";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
