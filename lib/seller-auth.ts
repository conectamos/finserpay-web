import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  SELLER_SESSION_COOKIE_NAME,
  verifySellerSessionToken,
} from "@/lib/session";

export type SellerSessionUser = {
  id: number;
  nombre: string;
  activo: boolean;
  debeCambiarPin: boolean;
  tipoPerfil: "VENDEDOR" | "SUPERVISOR";
  documento: string | null;
  telefono: string | null;
  email: string | null;
  sedeId: number;
  sedeNombre: string;
};

export function resolveSellerProfileType(value?: string | null) {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized.includes("SUPERVISOR") ? "SUPERVISOR" : "VENDEDOR";
}

export async function getSellerSessionUser(
  sessionUser?: Awaited<ReturnType<typeof getSessionUser>> | null
) {
  const currentUser = sessionUser ?? (await getSessionUser());

  if (!currentUser) {
    return null;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SELLER_SESSION_COOKIE_NAME)?.value;
  const sellerSession = verifySellerSessionToken(token);

  if (!sellerSession) {
    return null;
  }

  if (
    sellerSession.userId !== currentUser.id ||
    sellerSession.sedeId !== currentUser.sedeId
  ) {
    return null;
  }

  const seller = await prisma.vendedor.findFirst({
    where: {
      id: sellerSession.vendedorId,
      activo: true,
      asignaciones: {
        some: {
          sedeId: currentUser.sedeId,
          activo: true,
        },
      },
    },
    select: {
      id: true,
      nombre: true,
      activo: true,
      debeCambiarPin: true,
      documento: true,
      telefono: true,
      email: true,
      asignaciones: {
        where: {
          sedeId: currentUser.sedeId,
          activo: true,
        },
        select: {
          sede: {
            select: {
              id: true,
              nombre: true,
            },
          },
        },
        take: 1,
      },
    },
  });

  if (!seller || !seller.asignaciones.length) {
    return null;
  }

  return {
    id: seller.id,
    nombre: seller.nombre,
    activo: seller.activo,
    debeCambiarPin: seller.debeCambiarPin,
    tipoPerfil: resolveSellerProfileType(seller.nombre),
    documento: seller.documento,
    telefono: seller.telefono,
    email: seller.email,
    sedeId: seller.asignaciones[0].sede.id,
    sedeNombre: seller.asignaciones[0].sede.nombre,
  } satisfies SellerSessionUser;
}
