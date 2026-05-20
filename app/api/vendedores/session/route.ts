import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser, resolveSellerProfileType } from "@/lib/seller-auth";
import { verifyPassword } from "@/lib/password";
import {
  type AvatarPerfilKey,
  normalizarAvatarPerfil,
  normalizarTipoPerfilVendedor,
} from "@/lib/profile-avatars";
import { ensureVendorProfileVisualColumns } from "@/lib/vendor-profile-schema";
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
  tipoPerfil?: string | null;
  avatarKey?: string | null;
}) {
  const tipoPerfil = normalizarTipoPerfilVendedor(
    item.tipoPerfil || resolveSellerProfileType(item.nombre)
  );

  return {
    id: item.id,
    nombre: item.nombre,
    documento: item.documento,
    telefono: item.telefono,
    email: item.email,
    activo: item.activo,
    debeCambiarPin: item.debeCambiarPin,
    tipoPerfil,
    avatarKey: normalizarAvatarPerfil(item.avatarKey, tipoPerfil) satisfies AvatarPerfilKey,
  };
}

function normalizeSedeAccess(value?: string | null) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function isVentasAccessSede(sede?: { nombre?: string | null; codigo?: string | null }) {
  const values = [sede?.nombre, sede?.codigo].map(normalizeSedeAccess);
  return values.some((value) => value === "VENTAS" || value === "VENTA");
}

function isBlockedOperationalSede(sede?: { nombre?: string | null; codigo?: string | null }) {
  const values = [sede?.nombre, sede?.codigo].map(normalizeSedeAccess);
  return values.some(
    (value) =>
      value === "PP" ||
      value === "PRINCIPAL" ||
      value.includes("PRINCIPAL") ||
      value.includes("RECAUDO")
  );
}

function serializeSede(item: { id: number; nombre: string; codigo: string | null }) {
  return {
    id: item.id,
    nombre: item.nombre,
    codigo: item.codigo,
  };
}

async function getOperationalSedes(accessSedeId: number) {
  const sedes = await prisma.sede.findMany({
    where: {
      activa: true,
      NOT: {
        id: accessSedeId,
      },
    },
    select: {
      id: true,
      nombre: true,
      codigo: true,
    },
    orderBy: [
      {
        nombre: "asc",
      },
      {
        id: "asc",
      },
    ],
  });

  return sedes.filter((sede) => !isBlockedOperationalSede(sede)).map(serializeSede);
}

async function getAssignedSellersForSede(sedeId: number) {
  await ensureVendorProfileVisualColumns();

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
          tipoPerfil: true,
          avatarKey: true,
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

    const accessSedeId = user.sedeAccesoId ?? user.sedeId;
    const [currentSeller, sellers] = await Promise.all([
      getSellerSessionUser(user),
      getAssignedSellersForSede(accessSedeId),
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

    await ensureVendorProfileVisualColumns();
    const accessSedeId = user.sedeAccesoId ?? user.sedeId;

    const body = (await req.json()) as Record<string, unknown>;
    const vendedorId = Number(body.vendedorId || 0);
    const pin = String(body.pin || "").replace(/\D/g, "").trim();
    const requestedSedeId = Number(body.sedeId || body.operationalSedeId || 0);

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
        sedeId: accessSedeId,
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
            tipoPerfil: true,
            avatarKey: true,
            pinHash: true,
            pinTemporalHash: true,
          },
        },
        sede: {
          select: {
            id: true,
            nombre: true,
            codigo: true,
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

    const isVentasAccess = isVentasAccessSede(assignment.sede);
    const operationalSedeId = isVentasAccess
      ? requestedSedeId
      : accessSedeId;

    if (isVentasAccess && !operationalSedeId) {
      const sedes = await getOperationalSedes(accessSedeId);

      if (!sedes.length) {
        return NextResponse.json(
          { error: "No hay sedes activas disponibles para realizar la venta" },
          { status: 400 }
        );
      }

      return NextResponse.json({
        ok: true,
        requiresSedeSelection: true,
        seller: serializeSeller(assignment.vendedor),
        availableSedes: sedes,
        mustChangePin: assignment.vendedor.debeCambiarPin,
      });
    }

    const operationalSede = await prisma.sede.findFirst({
      where: {
        id: operationalSedeId,
        activa: true,
      },
      select: {
        id: true,
        nombre: true,
        codigo: true,
      },
    });

    if (!operationalSede) {
      return NextResponse.json(
        { error: "Selecciona una sede activa para realizar la venta" },
        { status: 400 }
      );
    }

    if (isBlockedOperationalSede(operationalSede)) {
      return NextResponse.json(
        { error: "Esta sede no esta disponible para registrar ventas" },
        { status: 403 }
      );
    }

    if (!isVentasAccess && operationalSede.id !== accessSedeId) {
      return NextResponse.json(
        { error: "Esta sede de acceso no permite operar en otra sede" },
        { status: 403 }
      );
    }

    const response = NextResponse.json({
      ok: true,
      seller: serializeSeller(assignment.vendedor),
      operationalSede: serializeSede(operationalSede),
      mustChangePin: assignment.vendedor.debeCambiarPin,
    });

    response.cookies.set(
      SELLER_SESSION_COOKIE_NAME,
      createSellerSessionToken({
        accesoSedeId: accessSedeId,
        sedeId: operationalSede.id,
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
