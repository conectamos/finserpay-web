import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";

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

  return {
    id: user.id,
    nombre: user.nombre,
    usuario: user.usuario,
    activo: user.activo,
    sedeId: user.sedeId,
    sedeNombre: user.sede?.nombre ?? `SEDE ${user.sedeId}`,
    rolId: user.rolId,
    rolNombre: user.rol?.nombre ?? "",
  };
}
