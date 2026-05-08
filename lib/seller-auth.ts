import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  SELLER_SESSION_COOKIE_NAME,
  verifySellerSessionToken,
} from "@/lib/session";
import {
  type AvatarPerfilKey,
  normalizarAvatarPerfil,
  normalizarTipoPerfilVendedor,
} from "@/lib/profile-avatars";
import { ensureVendorProfileVisualColumns } from "@/lib/vendor-profile-schema";

export type SellerSessionUser = {
  id: number;
  nombre: string;
  activo: boolean;
  debeCambiarPin: boolean;
  tipoPerfil: "VENDEDOR" | "SUPERVISOR";
  avatarKey: AvatarPerfilKey;
  documento: string | null;
  telefono: string | null;
  email: string | null;
  accesoSedeId: number;
  accesoSedeNombre: string;
  sedeId: number;
  sedeNombre: string;
};

export function resolveSellerProfileType(value?: string | null) {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized.includes("SUPERVISOR")
    ? "SUPERVISOR"
    : normalizarTipoPerfilVendedor(normalized);
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

  await ensureVendorProfileVisualColumns();

  const accesoSedeId = sellerSession.accesoSedeId ?? sellerSession.sedeId;

  const seller = await prisma.vendedor.findFirst({
    where: {
      id: sellerSession.vendedorId,
      activo: true,
      asignaciones: {
        some: {
          sedeId: accesoSedeId,
          activo: true,
        },
      },
    },
    select: {
      id: true,
      nombre: true,
      activo: true,
      debeCambiarPin: true,
      tipoPerfil: true,
      avatarKey: true,
      documento: true,
      telefono: true,
      email: true,
      asignaciones: {
        where: {
          sedeId: accesoSedeId,
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

  const operatingSede = await prisma.sede.findFirst({
    where: {
      id: sellerSession.sedeId,
      activa: true,
    },
    select: {
      id: true,
      nombre: true,
    },
  });

  if (!operatingSede) {
    return null;
  }

  const tipoPerfil = normalizarTipoPerfilVendedor(
    seller.tipoPerfil || resolveSellerProfileType(seller.nombre)
  );

  return {
    id: seller.id,
    nombre: seller.nombre,
    activo: seller.activo,
    debeCambiarPin: seller.debeCambiarPin,
    tipoPerfil,
    avatarKey: normalizarAvatarPerfil(seller.avatarKey, tipoPerfil),
    documento: seller.documento,
    telefono: seller.telefono,
    email: seller.email,
    accesoSedeId: seller.asignaciones[0].sede.id,
    accesoSedeNombre: seller.asignaciones[0].sede.nombre,
    sedeId: operatingSede.id,
    sedeNombre: operatingSede.nombre,
  } satisfies SellerSessionUser;
}
