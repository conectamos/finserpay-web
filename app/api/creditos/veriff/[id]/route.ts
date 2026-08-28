import { NextResponse } from "next/server";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { canOperateSolicitud } from "@/lib/solicitud-operation-access";
import { getActiveSolicitudCreditContext } from "@/lib/solicitudes-storage";
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
import {
  enforceVeriffRetryPolicy,
  getVeriffRetryPolicy,
} from "@/lib/veriff-retry-policy";
import { redactVeriffValidationForOperator } from "@/lib/veriff-response";
import { tryAcquireSolicitudOperationLock } from "@/lib/firmaseguro-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value: string) {
  const numeric = Math.trunc(Number(value));
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

async function canReadActiveValidation(input: {
  current: Awaited<ReturnType<typeof getVeriffValidationById>>;
  seller: Awaited<ReturnType<typeof getSellerSessionUser>>;
  viewerAllyId: number | null | undefined;
}) {
  if (!input.current?.draftId || input.current.creditoId) return false;

  const draft = await getActiveSolicitudCreditContext(input.current.draftId);
  return canOperateSolicitud({
    central: false,
    seller: input.seller,
    viewerAllyId: input.viewerAllyId,
    owner: draft,
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let operationLock:
    | Awaited<ReturnType<typeof tryAcquireSolicitudOperationLock>>
    | null = null;

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

    const centralAdmin =
      isAdminRole(user.rolNombre) &&
      isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const sellerSession = centralAdmin ? null : await getSellerSessionUser(user);

    if (
      !centralAdmin &&
      !(await canReadActiveValidation({
        current,
        seller: sellerSession,
        viewerAllyId: user.aliadoId,
      }))
    ) {
      return NextResponse.json(
        { ok: false, error: "No tienes acceso a esta validacion" },
        { status: 403 }
      );
    }

    if (current.creditoId) {
      return NextResponse.json({
        ok: true,
        validation: serializeVeriffValidation(current),
        retryPolicy: await getVeriffRetryPolicy(current.draftId),
        veriff: getVeriffPublicSummary(),
      });
    }

    let row = current;
    let decisionPayload: unknown = null;
    let personPayload: unknown = null;
    let decisionUnavailable = false;

    if (current.veriffSessionId) {
      try {
        decisionPayload = await veriffGetDecision(current.veriffSessionId);
        try {
          personPayload = await veriffGetPerson(current.veriffSessionId);
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
          decisionUnavailable = true;
        } else {
          throw error;
        }
      }
    }

    if (current.draftId) {
      operationLock = await tryAcquireSolicitudOperationLock(current.draftId);
      if (!operationLock) {
        const serialized = serializeVeriffValidation(current);
        return NextResponse.json(
          {
            ok: true,
            refreshDeferred: true,
            retryable: true,
            validation: centralAdmin
              ? serialized
              : redactVeriffValidationForOperator(serialized),
            retryPolicy: await getVeriffRetryPolicy(current.draftId),
            veriff: getVeriffPublicSummary(),
          },
          { headers: { "Retry-After": "2" } }
        );
      }
    }

    row = (await getVeriffValidationById(current.id)) || current;
    if (
      !centralAdmin &&
      !(await canReadActiveValidation({
        current: row,
        seller: sellerSession,
        viewerAllyId: user.aliadoId,
      }))
    ) {
      return NextResponse.json(
        { ok: false, error: "No tienes acceso a esta validacion" },
        { status: 403 }
      );
    }

    if (decisionPayload) {
      row =
        (await updateVeriffValidationFromDecision(
          row.id,
          decisionPayload,
          "decisionPayload"
        )) || row;
      if (personPayload) {
        row =
          (await updateVeriffValidation(row.id, {
            decisionPayload: {
              decisionPayload,
              personPayload,
            },
          })) || row;
      }
    } else if (decisionUnavailable) {
      const currentStatus = serializeVeriffValidation(row)?.status;
      const currentHasFinalDecision = Boolean(
        currentStatus &&
          ["APPROVED", "DECLINED", "ERROR", "EXPIRED", "ABANDONED"].includes(
            currentStatus
          )
      );
      row = currentHasFinalDecision
        ? row
        : (await updateVeriffValidation(row.id, {
            status: "PENDING",
          })) || row;
    }

    const retryPolicy = await enforceVeriffRetryPolicy(row);
    if (
      !centralAdmin &&
      !(await canReadActiveValidation({
        current: row,
        seller: sellerSession,
        viewerAllyId: user.aliadoId,
      }))
    ) {
      return NextResponse.json(
        { ok: false, error: "No tienes acceso a esta validacion" },
        { status: 403 }
      );
    }

    const serialized = serializeVeriffValidation(row);

    return NextResponse.json({
      ok: true,
      validation: centralAdmin
        ? serialized
        : redactVeriffValidationForOperator(serialized),
      retryPolicy,
      veriff: getVeriffPublicSummary(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "No se pudo consultar Veriff";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    await operationLock?.release();
  }
}
