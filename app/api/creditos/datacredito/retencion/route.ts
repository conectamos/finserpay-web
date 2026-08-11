import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  DataCreditoStorageConfigurationError,
  getDataCreditoRetentionDays,
  purgeExpiredDataCreditoAssessments,
} from "@/lib/datacredito/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearerToken(request: Request) {
  const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function tokensMatch(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function isAuthorized(request: Request) {
  const expected = String(
    process.env.DATACREDITO_RETENTION_TOKEN || process.env.CRON_SECRET || ""
  ).trim();
  const received = bearerToken(request);
  return (
    Buffer.byteLength(expected, "utf8") >= 32 &&
    received.length > 0 &&
    tokensMatch(received, expected)
  );
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }

  try {
    const deleted = await purgeExpiredDataCreditoAssessments();
    return NextResponse.json({
      ok: true,
      deleted,
      retentionDays: getDataCreditoRetentionDays(),
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof DataCreditoStorageConfigurationError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error:
            "DataCredito requiere ejecutar npm run db:setup-datacredito antes de la retencion.",
        },
        { status: 503 }
      );
    }

    console.error(
      "ERROR RETENCION DATACREDITO:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json(
      { ok: false, error: "No se pudo ejecutar la retencion de DataCredito" },
      { status: 500 }
    );
  }
}
