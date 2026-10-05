import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import {
  correctSignedDraftIdentity,
  getSignedDraftIdentityCorrectionDetail,
  parseSignedDraftIdentityCorrection,
  SignedDraftIdentityCorrectionError,
} from "@/lib/firmaseguro-draft-identity-correction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function authorizedActor() {
  const user = await getSessionUser();
  if (!user) return null;
  if (!isAdminRole(user.rolNombre) || !isFinserPayCentralAlly(user.aliadoAccesoCodigo)) return null;
  return user;
}

function parseDraftId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function failure(error: unknown) {
  if (error instanceof SignedDraftIdentityCorrectionError) {
    return NextResponse.json({ ok: false, code: error.code, error: error.message },
      { status: error.status, headers: approvalPrivateHeaders });
  }
  if (error instanceof CreditApprovalError) {
    return NextResponse.json({ ok: false, code: error.code, error: error.message },
      { status: error.status, headers: approvalPrivateHeaders });
  }
  return NextResponse.json({ ok: false, code: "ERROR_TECNICO",
    error: "Error técnico: requiere revisión. Verifica el expediente antes de reintentar." },
    { status: 500, headers: approvalPrivateHeaders });
}

export async function GET(_request: Request, context: Context) {
  const actor = await authorizedActor();
  if (!actor) return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
  const id = parseDraftId((await context.params).id);
  if (!id) return NextResponse.json({ ok: false, error: "Borrador inválido" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await getSignedDraftIdentityCorrectionDetail(id)) },
      { headers: approvalPrivateHeaders });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, context: Context) {
  const actor = await authorizedActor();
  if (!actor) return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
  const id = parseDraftId((await context.params).id);
  if (!id) return NextResponse.json({ ok: false, error: "Borrador inválido" }, { status: 400 });
  try {
    const correction = parseSignedDraftIdentityCorrection(
      await readApprovalRequest(request, { maxBytes: 16_384 }));
    const result = await correctSignedDraftIdentity({ draftId: id,
      actorUserId: actor.id, actorName: actor.nombre, correction });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return failure(error); }
}
