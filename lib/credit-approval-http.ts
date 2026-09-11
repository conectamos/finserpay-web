import { NextResponse } from "next/server";
import { getCreditApprovalSessionUser } from "@/lib/auth";
import { canReviewCreditApprovals } from "@/lib/roles";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { ApprovalActorAccessError, ApprovalActorCreditAccessError, type ApprovalActor } from "@/lib/credit-approval-actor";
import { CreditApprovalError } from "@/lib/credit-approval";

export const approvalPrivateHeaders = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };

export async function getApprovalActor(): Promise<ApprovalActor> {
  const shared = await getApprovalSharedRequestActor();
  if (shared === null) throw new ApprovalActorAccessError();
  if (shared) return shared;
  const user = await getCreditApprovalSessionUser();
  if (!user) throw new CreditApprovalError("UNAUTHENTICATED", "Inicia sesión para revisar créditos.", 401);
  if (!canReviewCreditApprovals(user)) throw new CreditApprovalError("FORBIDDEN", "No tienes permiso para revisar estos créditos.", 403);
  return { id: user.id, nombre: user.nombre };
}

export function isSameApprovalOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = request.headers.get("origin");
  // Authenticated non-browser clients may omit Origin. Fetch Metadata still
  // rejects cross-site requests before this exception is considered.
  if (origin === null) return true;

  try {
    if (!/^https?:\/\/[^/?#\s\\]+$/i.test(origin)) return false;
    const source = new URL(origin);
    if (source.username || source.password || source.origin === "null") return false;

    // Next can reconstruct request.url with its internal listening hostname.
    // Host is the HTTP authority sent to this app, including through a proxy
    // preserving Host. Do not trust arbitrary X-Forwarded-Host as an allowlist.
    const host = request.headers.get("host") ?? new URL(request.url).host;
    if (!host || /[\s,\/\\?#@%]/.test(host)) return false;
    const authority = new URL(`${source.protocol}//${host}`);
    return source.host === authority.host;
  } catch {
    return false;
  }
}

export async function readApprovalRequest(request: Request, options: { maxBytes?: number } = {}) {
  if (!isSameApprovalOrigin(request)) {
    throw new CreditApprovalError("INVALID_ORIGIN", "La solicitud debe realizarse desde FINSER PAY.", 403);
  }
  const maxBytes = options.maxBytes ?? 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 3_000_000) throw new Error("Invalid approval request limit");
  const tooLarge = () => new CreditApprovalError("INVALID_REQUEST", "Solicitud demasiado extensa.");
  if (Number(request.headers.get("content-length")) > maxBytes) throw tooLarge();
  const reader = request.body?.getReader();
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (length + chunk.value.length > bytes.length) {
          await reader.cancel();
          throw tooLarge();
        }
        bytes.set(chunk.value, length);
        length += chunk.value.length;
      }
    } finally { reader.releaseLock(); }
  }
  const text = new TextDecoder().decode(bytes.subarray(0, length));
  try { return JSON.parse(text) as unknown; }
  catch { throw new CreditApprovalError("INVALID_REQUEST", "Solicitud no válida."); }
}

export function approvalErrorResponse(error: unknown) {
  if (error instanceof CreditApprovalError || error instanceof ApprovalActorAccessError || error instanceof ApprovalActorCreditAccessError) {
    return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.status, headers: approvalPrivateHeaders });
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "P2034" || code === "40001" || code === "40P01") {
    return NextResponse.json({ ok: false, code: "REVIEW_CHANGED", error: "Otra operación está actualizando el crédito. Actualiza y revisa su estado antes de continuar." }, { status: 409, headers: approvalPrivateHeaders });
  }
  return NextResponse.json({ ok: false, code: "APPROVAL_UNAVAILABLE", error: "No se pudo verificar el expediente. Intenta de nuevo en unos momentos." }, { status: 503, headers: approvalPrivateHeaders });
}
