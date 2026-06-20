import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import {
  getVeriffValidationById,
  serializeVeriffValidation,
  updateVeriffValidation,
  updateVeriffValidationFromDecision,
} from "@/lib/veriff-storage";
import {
  getVeriffPublicSummary,
  veriffGetDecision,
  VeriffApiError,
} from "@/lib/veriff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value: string) {
  const numeric = Math.trunc(Number(value));
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function canAccessValidation(
  user: Awaited<ReturnType<typeof getSessionUser>>,
  row: Awaited<ReturnType<typeof getVeriffValidationById>>
) {
  if (!user || !row) {
    return false;
  }

  const admin = isAdminRole(user.rolNombre);
  const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);

  if (adminCentral) {
    return true;
  }

  if (admin && user.aliadoAccesoId && row.aliadoId === user.aliadoAccesoId) {
    return true;
  }

  return row.sedeId === user.sedeId || row.usuarioId === user.id;
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

    const current = await getVeriffValidationById(id);

    if (!current) {
      return NextResponse.json(
        { ok: false, error: "Validacion Veriff no encontrada" },
        { status: 404 }
      );
    }

    if (!canAccessValidation(user, current)) {
      return NextResponse.json(
        { ok: false, error: "No tienes acceso a esta validacion" },
        { status: 403 }
      );
    }

    let row = current;

    if (current.veriffSessionId) {
      try {
        const decisionPayload = await veriffGetDecision(current.veriffSessionId);
        row =
          (await updateVeriffValidationFromDecision(
            current.id,
            decisionPayload,
            "decisionPayload"
          )) || current;
      } catch (error) {
        if (error instanceof VeriffApiError && [404, 409].includes(error.status)) {
          row =
            (await updateVeriffValidation(current.id, {
              status: "PENDING",
            })) || current;
        } else {
          throw error;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      validation: serializeVeriffValidation(row),
      veriff: getVeriffPublicSummary(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "No se pudo consultar Veriff";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
