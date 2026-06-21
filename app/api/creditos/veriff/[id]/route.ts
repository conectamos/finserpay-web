import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { canAccessVeriffValidation } from "@/lib/veriff-access";
import {
  getVeriffValidationById,
  serializeVeriffValidation,
  updateVeriffValidation,
  updateVeriffValidationFromDecision,
} from "@/lib/veriff-storage";
import {
  getVeriffPublicSummary,
  veriffGetDecision,
  veriffGetPerson,
  VeriffApiError,
} from "@/lib/veriff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value: string) {
  const numeric = Math.trunc(Number(value));
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
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

    if (!canAccessVeriffValidation(user, current)) {
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
        try {
          const personPayload = await veriffGetPerson(current.veriffSessionId);
          row =
            (await updateVeriffValidation(row.id, {
              decisionPayload: {
                decisionPayload,
                personPayload,
              },
            })) || row;
        } catch (personError) {
          if (
            !(personError instanceof VeriffApiError) ||
            ![404, 409].includes(personError.status)
          ) {
            throw personError;
          }
        }
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
