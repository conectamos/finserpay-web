import { NextResponse } from "next/server";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import prisma from "@/lib/prisma";
import {
  ensureSecondCreditAuthorizationSchema,
  mutateSecondCreditAuthorization,
  parseSecondCreditMutation,
  SecondCreditAuthorizationError,
} from "@/lib/second-credit-authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const access = await getDataCreditoCentralAdmin();
    if (!access.ok) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Acceso no autorizado." }, { status: access.status, headers });
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "La solicitud no es válida." }, { status: 400, headers });
    }
    const input = parseSecondCreditMutation(body);
    await ensureSecondCreditAuthorizationSchema();
    const result = await prisma.$transaction((tx) => mutateSecondCreditAuthorization(tx, input, access.user), { maxWait: 10_000, timeout: 30_000 });
    const { documento, activeCredits, activeFolios, canCreate, authorization, idempotent } = result;
    return NextResponse.json({ ok: true, documento, activeCredits, activeFolios, canCreate, authorization, idempotent }, { headers });
  } catch (error) {
    if (error instanceof SecondCreditAuthorizationError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers });
    }
    return NextResponse.json({ ok: false, code: "SECOND_CREDIT_AUTHORIZATION_UNAVAILABLE", error: "No se pudo guardar la autorización. Consulta la cédula y reintenta." }, { status: 503, headers });
  }
}