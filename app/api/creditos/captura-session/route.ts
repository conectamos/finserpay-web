import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  buildCreditCaptureExpiry,
  generateCreditCaptureToken,
  resolveCaptureSessionOrigin,
  serializeCaptureSession,
} from "@/lib/credit-capture-session";
import prisma from "@/lib/prisma";
import { getSellerSessionUser } from "@/lib/seller-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const sessionUser = await getSessionUser();

  if (!sessionUser) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const sellerSession = await getSellerSessionUser(sessionUser);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const expiresAt = buildCreditCaptureExpiry();
  const token = generateCreditCaptureToken();
  const captureSessionDelegate = (prisma as any).capturaCreditoSession;

  await captureSessionDelegate.updateMany({
    where: {
      usuarioId: sessionUser.id,
      sedeId: sessionUser.sedeId,
      estado: "ABIERTA",
    },
    data: {
      estado: "REEMPLAZADA",
    },
  });

  const captureSession = await captureSessionDelegate.create({
    data: {
      token,
      estado: "ABIERTA",
      expiresAt,
      usuarioId: sessionUser.id,
      vendedorId: sellerSession?.id ?? null,
      sedeId: sessionUser.sedeId,
      clienteNombre: String(body.clienteNombre || "").trim().slice(0, 120) || null,
      clienteDocumento:
        String(body.clienteDocumento || "").trim().slice(0, 40) || null,
      clienteTelefono: String(body.clienteTelefono || "").trim().slice(0, 40) || null,
    },
  });

  return NextResponse.json({
    ok: true,
    session: serializeCaptureSession(
      captureSession,
      resolveCaptureSessionOrigin(request)
    ),
  });
}
