import { NextResponse } from "next/server";
import { getNominalApprovalAnalystSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import {
  APPROVAL_REQUEST_DOCUMENT_FIELDS,
  decodeApprovalRequestDocument,
  parseApprovalDraftRequestId,
  parseApprovalRequestDocumentKey,
} from "@/lib/approval-request-document";
import prisma from "@/lib/prisma";
import { normalizeSolicitudFilters } from "@/lib/solicitudes";
import { getSolicitudDetail } from "@/lib/solicitudes-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

type Context = { params: Promise<{ id: string; key: string }> };

function errorResponse(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status, headers: privateHeaders });
}

export async function GET(_request: Request, context: Context) {
  try {
    const analyst = await getNominalApprovalAnalystSessionUser();
    if (!analyst || (await getApprovalSharedRequestActor()) !== undefined) {
      return errorResponse(401, "Inicia sesión con tu cuenta de analista.");
    }

    const params = await context.params;
    const draftId = parseApprovalDraftRequestId(params.id);
    const key = parseApprovalRequestDocumentKey(params.key);
    if (!draftId || !key) return errorResponse(404, "Archivo no disponible.");

    const item = await getSolicitudDetail({
      viewer: {
        kind: "APPROVAL_ANALYST",
        userId: analyst.id,
        aliadoId: null,
        sedeId: null,
        vendedorId: null,
      },
      filters: normalizeSolicitudFilters({ id: params.id }),
      readOnly: true,
    });
    if (!item) return errorResponse(404, "Archivo no disponible.");

    const rows = key === "documento-firmado"
      ? await prisma.$queryRawUnsafe<Array<{ value: string | null }>>(`
          SELECT process."signedDocumentBase64" AS "value"
          FROM "FirmaSeguroProcess" process
          WHERE process."draftId" = $1
            AND process."supersededAt" IS NULL
            AND NULLIF(BTRIM(process."signedDocumentBase64"), '') IS NOT NULL
          ORDER BY process."createdAt" DESC, process."id" DESC
          LIMIT 1
        `, draftId)
      : await prisma.$queryRawUnsafe<Array<{ value: string | null }>>(`
          SELECT COALESCE(${APPROVAL_REQUEST_DOCUMENT_FIELDS[key].map((_, index) =>
            `NULLIF(BTRIM(d."payload" ->> $${index + 2}::text), '')`).join(", ")}) AS "value"
          FROM "CreditoBorrador" d
          WHERE d."id" = $1
          LIMIT 1
        `, draftId, ...APPROVAL_REQUEST_DOCUMENT_FIELDS[key]);
    const media = decodeApprovalRequestDocument(rows[0]?.value, key);
    if (!media) return errorResponse(404, "Archivo no disponible.");

    return new Response(new Uint8Array(media.bytes), {
      headers: {
        ...privateHeaders,
        "Content-Type": media.contentType,
        "Content-Length": String(media.bytes.length),
        "Content-Disposition": `inline; filename="solicitud-${draftId}-${key}.${media.extension}"`,
      },
    });
  } catch {
    return errorResponse(503, "No fue posible consultar el archivo. Intenta de nuevo.");
  }
}
