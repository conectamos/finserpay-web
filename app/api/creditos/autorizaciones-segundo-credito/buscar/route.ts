import { NextResponse } from "next/server";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import prisma from "@/lib/prisma";
import {
  ensureSecondCreditAuthorizationSchema,
  getSecondCreditEligibility,
  normalizeSecondCreditDocument,
  SecondCreditAuthorizationError,
} from "@/lib/second-credit-authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Exact document in the request body, never in request URLs or a public listing. */
export async function POST(request: Request) {
  try {
    const access = await getDataCreditoCentralAdmin();
    if (!access.ok) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Acceso no autorizado." }, { status: access.status, headers });
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "La solicitud no es válida." }, { status: 400, headers });
    }
    const documentNumber = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).documentNumber : null;
    const documento = normalizeSecondCreditDocument(documentNumber);
    await ensureSecondCreditAuthorizationSchema();
    const item = (await getSecondCreditEligibility(prisma, [documento])).get(documento)!;
    const { activeCredits, activeFolios, canCreate, authorization } = item;
    return NextResponse.json({ ok: true, documento, activeCredits, activeFolios, canCreate, authorization }, { headers });
  } catch (error) {
    if (error instanceof SecondCreditAuthorizationError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers });
    }
    return NextResponse.json({ ok: false, code: "SECOND_CREDIT_AUTHORIZATION_UNAVAILABLE", error: "No se pudo consultar la autorización. Reintenta antes de continuar." }, { status: 503, headers });
  }
}