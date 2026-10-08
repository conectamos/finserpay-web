import "server-only";

import { NextResponse } from "next/server";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { getCreditApprovalSessionUser } from "@/lib/auth";
import { CreditApprovalError } from "@/lib/credit-approval";
import { CreditDeviceReplacementError } from "@/lib/credit-device-replacement-storage";
import { FirmaSeguroImeiCorrectionError } from "@/lib/firmaseguro-imei-correction";
import { DraftDispatchError } from "@/lib/firmaseguro-draft-dispatch-ledger";
import { RequestDataCorrectionError } from "@/lib/approval-request-correction-core";
import { isSameApprovalOrigin, readApprovalRequest } from "@/lib/credit-approval-http";
import { operationalCaseIdentity, OperationalCaseReadError } from "@/lib/approval-operations-read";
import { ApprovalOperationalError, type OperationalActor } from "@/lib/approval-operations-write";

export const operationalPrivateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

export async function requireOperationalActor(): Promise<OperationalActor> {
  // A shared approval link must never inherit the analyst's other browser session.
  if ((await getApprovalSharedRequestActor()) !== undefined) {
    throw new ApprovalOperationalError("SHARED_ACCESS", "Cierra el acceso compartido y usa tu cuenta personal.", 403);
  }
  const user = await getCreditApprovalSessionUser();
  if (!user) throw new ApprovalOperationalError("UNAUTHORIZED", "Inicia sesión como analista de Aprobaciones.", 401);
  return { id: user.id, nombre: user.nombre };
}

export function operationalTarget(kind: string, id: string) {
  return operationalCaseIdentity(kind, id);
}

export function operationalErrorResponse(error: unknown) {
  if (error instanceof ApprovalOperationalError || error instanceof OperationalCaseReadError ||
      error instanceof CreditApprovalError || error instanceof CreditDeviceReplacementError ||
      error instanceof FirmaSeguroImeiCorrectionError || error instanceof DraftDispatchError ||
      error instanceof RequestDataCorrectionError) {
    return NextResponse.json({ ok: false, code: error.code, error: error.message },
      { status: error.status, headers: operationalPrivateHeaders });
  }
  return NextResponse.json({ ok: false, code: "OPERATION_UNAVAILABLE",
    error: "Error técnico: requiere revisión. Actualiza el expediente antes de intentar otra vez." },
    { status: 503, headers: operationalPrivateHeaders });
}

export async function operationalJson(request: Request): Promise<Record<string, unknown>> {
  if (!isSameApprovalOrigin(request))
    throw new ApprovalOperationalError("INVALID_ORIGIN", "La solicitud debe realizarse desde FINSER PAY.", 403);
  const body = await readApprovalRequest(request, { maxBytes: 16 * 1024 });
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApprovalOperationalError("INVALID_REQUEST", "Solicitud no válida.", 400);
  return body as Record<string, unknown>;
}

const maxMultipartBytes = 10 * 1024 * 1024 + 256 * 1024;

export async function operationalFormData(request: Request): Promise<FormData> {
  if (!isSameApprovalOrigin(request))
    throw new ApprovalOperationalError("INVALID_ORIGIN", "La solicitud debe realizarse desde FINSER PAY.", 403);
  const contentType = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType))
    throw new ApprovalOperationalError("INVALID_REQUEST", "Formulario no válido.", 400);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxMultipartBytes)
    throw new ApprovalOperationalError("REQUEST_TOO_LARGE", "La evidencia supera el tamaño permitido.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ApprovalOperationalError("INVALID_REQUEST", "Formulario vacío.", 400);
  const bytes = new Uint8Array(maxMultipartBytes);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > maxMultipartBytes) {
        await reader.cancel();
        throw new ApprovalOperationalError("REQUEST_TOO_LARGE", "La evidencia supera el tamaño permitido.", 413);
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return await new Response(bytes.slice(0, length), { headers: { "Content-Type": contentType } }).formData();
  } catch {
    throw new ApprovalOperationalError("INVALID_REQUEST", "El formulario enviado no es válido.", 400);
  }
}

export function rejectUnexpectedFields(data: FormData, accepted: readonly string[]) {
  const allowed = new Set(accepted);
  for (const key of data.keys()) {
    if (!allowed.has(key) || data.getAll(key).length !== 1)
      throw new ApprovalOperationalError("INVALID_REQUEST", "El formulario contiene campos no válidos.", 400);
  }
}

export function rejectUnexpectedJsonFields(data: Record<string, unknown>, accepted: readonly string[]) {
  const allowed = new Set(accepted);
  if (Object.keys(data).some((key) => !allowed.has(key)))
    throw new ApprovalOperationalError("INVALID_REQUEST", "La solicitud contiene campos no válidos.", 400);
}
