import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveDataCreditoManualCreditLimit } from "@/lib/datacredito/manual-credit-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function noStoreJson(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

async function requireUser() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: noStoreJson({ error: "No autenticado" }, 401),
    };
  }

  return { ok: true as const, user };
}

export async function POST(req: Request) {
  try {
    const session = await requireUser();

    if (!session.ok) {
      return session.response;
    }

    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const documentNumber = String(body?.documentNumber ?? "").trim();

    if (!/^\d{3,13}$/.test(documentNumber)) {
      return noStoreJson(
        { error: "El documento debe contener entre 3 y 13 digitos." },
        400
      );
    }

    const activeManualCreditLimit =
      await getActiveDataCreditoManualCreditLimit(documentNumber);
    const manualCreditLimit = activeManualCreditLimit
      ? {
          id: activeManualCreditLimit.id,
          documentLast4: activeManualCreditLimit.documentLast4,
          maxFinancedAmount: activeManualCreditLimit.maxFinancedAmount,
          version: activeManualCreditLimit.version,
        }
      : null;

    return noStoreJson({
      ok: true,
      manualCreditLimit,
    });
  } catch (error) {
    console.error("ERROR LOOKUP CUPO MANUAL DATACREDITO:", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson(
      { error: "No se pudo consultar el cupo manual." },
      500
    );
  }
}
