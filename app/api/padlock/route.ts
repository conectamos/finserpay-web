import {
  newPadlockCorrelationId,
  padlockAdminJson,
  requirePadlockCentralAdmin,
} from "@/lib/padlock/admin-http";
import {
  getPadlockAdminOverview,
  publicPadlockAdminError,
} from "@/lib/padlock/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requirePadlockCentralAdmin();
  if (!access.ok) return access.response;

  const correlationId = newPadlockCorrelationId();
  try {
    return padlockAdminJson(
      { ok: true, ...(await getPadlockAdminOverview()) },
      200,
      { "X-Correlation-Id": correlationId }
    );
  } catch (error) {
    const safe = publicPadlockAdminError(error);
    console.error("PADLOCK_ADMIN_OVERVIEW_ERROR", {
      correlationId,
      code: safe.code,
    });
    return padlockAdminJson(
      { ok: false, error: safe.message, code: safe.code, correlationId },
      safe.status,
      { "X-Correlation-Id": correlationId }
    );
  }
}
