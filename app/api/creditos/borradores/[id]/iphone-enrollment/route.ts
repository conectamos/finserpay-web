import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { IPHONE_ENROLLMENT_RESPONSE_HEADERS } from "@/lib/iphone-enrollment";
import {
  ensureIphoneEnrollmentSchema,
  getIphoneEnrollmentReviewForSolicitud,
} from "@/lib/iphone-enrollment-storage";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DraftIdentityRow = {
  id: number;
  clienteDocumento: string | null;
  imei: string | null;
};

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function response(body: object, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { ...IPHONE_ENROLLMENT_RESPONSE_HEADERS, Vary: "Cookie" },
  });
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return response({ ok: false, error: "No autenticado" }, 401);
    const id = parseId((await context.params).id);
    if (!id) return response({ ok: false, error: "Solicitud invalida" }, 400);

    const admin = isAdminRole(user.rolNombre);
    const central = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const seller = admin ? null : await getSellerSessionUser(user);
    if (!admin && !seller) {
      return response({ ok: false, error: "Acceso no autorizado" }, 403);
    }
    await ensureIphoneEnrollmentSchema();

    const conditions = [
      `draft."id" = $1`,
      `draft."estado" = 'ABIERTO'`,
      `COALESCE(draft."expiresAt", draft."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP`,
    ];
    const values: unknown[] = [id];
    if (!central && admin) {
      values.push(user.aliadoAccesoId || -1);
      conditions.push(`sede."aliadoId" = $${values.length}`);
    } else if (!central) {
      values.push(seller?.id || -1);
      conditions.push(`draft."vendedorId" = $${values.length}`);
      values.push(seller?.sedeId || -1);
      conditions.push(`draft."sedeId" = $${values.length}`);
    }

    const rows = await prisma.$queryRawUnsafe<DraftIdentityRow[]>(
      `
        SELECT draft."id", draft."clienteDocumento", draft."imei"
        FROM "CreditoBorrador" draft
        LEFT JOIN "Sede" sede ON sede."id" = draft."sedeId"
        WHERE ${conditions.join(" AND ")}
        LIMIT 1
      `,
      ...values
    );
    const draft = rows[0];
    if (!draft) {
      return response({ ok: false, error: "Solicitud no disponible" }, 404);
    }
    const document = String(draft.clienteDocumento || "").replace(/\D/g, "");
    const imei = String(draft.imei || "").replace(/\D/g, "");
    const review =
      document && imei
        ? await getIphoneEnrollmentReviewForSolicitud({
            solicitudId: draft.id,
            document,
            imei,
          })
        : null;
    return response(
      {
        ok: true,
        review: review
          ? {
              id: review.id,
              decision: review.decision,
              analystName: review.analystName,
              approvedAt: review.approvedAt,
            }
          : null,
      },
      200
    );
  } catch (error) {
    console.error("ERROR CONSULTANDO APROBACION DE ENROLAMIENTO IPHONE:", error);
    return response(
      { ok: false, error: "No se pudo consultar el enrolamiento" },
      500
    );
  }
}
