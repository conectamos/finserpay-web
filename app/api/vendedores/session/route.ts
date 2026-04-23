import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser, resolveSellerProfileType } from "@/lib/seller-auth";
import { verifyPassword } from "@/lib/password";
import {
  SELLER_SESSION_COOKIE_NAME,
  createSellerSessionToken,
  getSessionCookieOptions,
} from "@/lib/session";

function serializeSeller(item: {
  id: number;
  nombre: string;
  documento: string | null;
  telefono: string | null;
  email: string | null;
  activo: boolean;
  debeCambiarPin: boolean;
}) {
  return {
    id: item.id,
    nombre: item.nombre,
    documento: item.documento,
    telefono: item.telefono,
    email: item.email,
    activo: item.activo,
    debeCambiarPin: item.debeCambiarPin,
    tipoPerfil: resolveSellerProfileType(item.nombre),
  };
}

async function getAssignedSellersForSede(sedeId: number) {
  const rows = await prisma.sedeVendedor.findMany({
    where: {
      sedeId,
      activo: true,
      vendedor: {
        activo: true,
      },
    },
    select: {
      vendedor: {
        select: {
          id: true,
          nombre: true,
          documento: true,
          telefono: true,
          email: true,
          activo: true,
          debeCambiarPin: true,
        },
      },
    },
    orderBy: {
      vendedor: {
        nombre: "asc",
      },
    },
  });

  return rows.map((row) => serializeSeller(row.vendedor));
}

export async function GET() {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const [currentSeller, sellers] = await Promise.all([
      getSellerSessionUser(user),
      getAssignedSellersForSede(user.sedeId),
    ]);

    return NextResponse.json({
      ok: true,
      currentSeller,
      sellers,
    });
  } catch (error) {
    console.error("ERROR CONSULTANDO SESION DE VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo cargar la sesion del vendedor" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const vendedorId = Number(body.vendedorId || 0);
    const pin = String(body.pin || "").replace(/\D/g, "").trim();

    if (!Number.isInteger(vendedorId) || vendedorId <= 0) {
      return NextResponse.json(
        { error: "Selecciona un vendedor valido" },
        { status: 400 }
      );
    }

    if (!pin) {
      return NextResponse.json(
        { error: "Debes ingresar el PIN del vendedor" },
        { status: 400 }
      );
    }

    const assignment = await prisma.sedeVendedor.findFirst({
      where: {
        sedeId: user.sedeId,
        vendedorId,
        activo: true,
        vendedor: {
          activo: true,
        },
      },
      select: {
        vendedor: {
          select: {
            id: true,
            nombre: true,
            documento: true,
            telefono: true,
            email: true,
            activo: true,
            debeCambiarPin: true,
            pinHash: true,
            pinTemporalHash: true,
          },
        },
      },
    });

    if (!assignment) {
      return NextResponse.json(
        { error: "Ese vendedor no esta asignado a esta sede" },
        { status: 404 }
      );
    }

    const validMainPin = verifyPassword(pin, assignment.vendedor.pinHash);
    const validTempPin = assignment.vendedor.pinTemporalHash
      ? verifyPassword(pin, assignment.vendedor.pinTemporalHash)
      : false;

    if (!validMainPin && !validTempPin) {
      return NextResponse.json(
        { error: "El PIN ingresado no es correcto" },
        { status: 401 }
      );
    }

    await prisma.vendedor.update({
      where: { id: assignment.vendedor.id },
      data: {
        ultimoIngresoAt: new Date(),
      },
    });

    const response = NextResponse.json({
      ok: true,
      seller: serializeSeller(assignment.vendedor),
      mustChangePin: assignment.vendedor.debeCambiarPin,
    });

    response.cookies.set(
      SELLER_SESSION_COOKIE_NAME,
      createSellerSessionToken({
        sedeId: user.sedeId,
        userId: user.id,
        vendedorId: assignment.vendedor.id,
      }),
      getSessionCookieOptions()
    );

    return response;
  } catch (error) {
    console.error("ERROR ABRIENDO PERFIL DE VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo abrir el perfil del vendedor" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });

  response.cookies.set(SELLER_SESSION_COOKIE_NAME, "", {
    ...getSessionCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });

  return response;
}
