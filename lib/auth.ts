import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import {
  SELLER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifySellerSessionToken,
  verifySessionToken,
} from "@/lib/session";
import { isAdminRole } from "@/lib/roles";

export async function getSessionUser() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  const session = verifySessionToken(sessionToken);

  if (!session) return null;

  const user = await prisma.usuario.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      nombre: true,
      usuario: true,
      activo: true,
      sedeId: true,
      rolId: true,
      rol: {
        select: {
          id: true,
          nombre: true,
          descripcion: true,
        },
      },
      sede: {
        select: {
          id: true,
          nombre: true,
        },
      },
    },
  });

  if (!user || !user.activo) return null;

  const sellerSession = verifySellerSessionToken(
    cookieStore.get(SELLER_SESSION_COOKIE_NAME)?.value
  );
  const canUseSellerSede =
    sellerSession &&
    sellerSession.userId === user.id &&
    !isAdminRole(user.rol?.nombre) &&
    (!sellerSession.accesoSedeId || sellerSession.accesoSedeId === user.sedeId);

  const operatingSede = canUseSellerSede
    ? await prisma.sede.findFirst({
        where: {
          id: sellerSession.sedeId,
          activa: true,
        },
        select: {
          id: true,
          nombre: true,
        },
      })
    : null;

  const effectiveSedeId = operatingSede?.id ?? user.sedeId;
  const effectiveSedeNombre =
    operatingSede?.nombre ?? user.sede?.nombre ?? `SEDE ${user.sedeId}`;

  return {
    id: user.id,
    nombre: user.nombre,
    usuario: user.usuario,
    activo: user.activo,
    sedeId: effectiveSedeId,
    sedeNombre: effectiveSedeNombre,
    sedeAccesoId: user.sedeId,
    sedeAccesoNombre: user.sede?.nombre ?? `SEDE ${user.sedeId}`,
    rolId: user.rolId,
    rolNombre: user.rol?.nombre ?? "",
  };
}
