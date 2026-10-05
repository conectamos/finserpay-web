import { NextResponse } from "next/server";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getSessionUser } from "@/lib/auth";
import {
  correctFirmaSeguroDraftFinancialTerms,
  FirmaSeguroFinancialCorrectionError,
} from "@/lib/firmaseguro-financial-correction";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDraftId(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, code: "NO_AUTENTICADO", error: "No autenticado" },
        { status: 401 },
      );
    }
    if (
      !isAdminRole(user.rolNombre) ||
      !isFinserPayCentralAlly(user.aliadoAccesoCodigo)
    ) {
      return NextResponse.json(
        {
          ok: false,
          code: "CORRECCION_FINANCIERA_NO_AUTORIZADA",
          error:
            "Solo el administrador central FINSER PAY puede corregir valores después de la firma.",
        },
        { status: 403 },
      );
    }

    const params = await context.params;
    const draftId = parseDraftId(params.id);
    if (!draftId) {
      return NextResponse.json(
        { ok: false, code: "SOLICITUD_INVALIDA", error: "Borrador inválido" },
        { status: 400 },
      );
    }
    const body = (await request.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const result = await correctFirmaSeguroDraftFinancialTerms({
      draftId,
      idempotencyKey: body?.idempotencyKey,
      expectedProcessUuid: body?.expectedProcessUuid,
      expectedFinancialTermsChecksum:
        body?.expectedFinancialTermsChecksum,
      reason: body?.reason,
      valorEquipoTotal: body?.valorEquipoTotal,
      cuotaInicial: body?.cuotaInicial,
      plazoMeses: body?.plazoMeses,
      actorUserId: user.id,
      actorName: user.nombre,
    });

    return NextResponse.json({
      ok: true,
      correction: result,
      message:
        "Los valores fueron corregidos. El contrato anterior quedó en el historial y el cliente debe firmar la nueva versión.",
    });
  } catch (error) {
    if (error instanceof FirmaSeguroFinancialCorrectionError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    console.error("ERROR CORRIGIENDO TERMINOS FIRMADOS:", error);
    return NextResponse.json(
      {
        ok: false,
        code: "CORRECCION_FINANCIERA_ERROR",
        error: "No se pudieron corregir los valores del expediente.",
      },
      { status: 500 },
    );
  }
}
