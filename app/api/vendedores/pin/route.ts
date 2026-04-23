import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";

function normalizePin(value: unknown) {
  return String(value || "").replace(/\D/g, "").trim();
}

function isValidPin(pin: string) {
  return /^\d{4,6}$/.test(pin);
}

export async function PATCH(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const seller = await getSellerSessionUser(user);

    if (!seller) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const currentPin = normalizePin(body.currentPin);
    const nextPin = normalizePin(body.nextPin);

    if (!isValidPin(currentPin) || !isValidPin(nextPin)) {
      return NextResponse.json(
        { error: "El PIN actual y el nuevo deben tener entre 4 y 6 digitos" },
        { status: 400 }
      );
    }

    if (currentPin === nextPin) {
      return NextResponse.json(
        { error: "El nuevo PIN debe ser diferente al actual" },
        { status: 400 }
      );
    }

    const sellerWithPin = await prisma.vendedor.findUnique({
      where: {
        id: seller.id,
      },
      select: {
        id: true,
        pinHash: true,
        pinTemporalHash: true,
      },
    });

    if (!sellerWithPin) {
      return NextResponse.json(
        { error: "No se encontro el perfil del vendedor" },
        { status: 404 }
      );
    }

    const validMainPin = verifyPassword(currentPin, sellerWithPin.pinHash);
    const validTempPin = sellerWithPin.pinTemporalHash
      ? verifyPassword(currentPin, sellerWithPin.pinTemporalHash)
      : false;

    if (!validMainPin && !validTempPin) {
      return NextResponse.json(
        { error: "El PIN actual no coincide" },
        { status: 401 }
      );
    }

    await prisma.vendedor.update({
      where: {
        id: seller.id,
      },
      data: {
        pinHash: hashPassword(nextPin),
        pinTemporalHash: null,
        debeCambiarPin: false,
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "PIN actualizado correctamente",
    });
  } catch (error) {
    console.error("ERROR ACTUALIZANDO PIN DE VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo actualizar el PIN" },
      { status: 500 }
    );
  }
}
