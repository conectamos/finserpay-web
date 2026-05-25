import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { ALIADO_FINSER_PAY, isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";

export async function GET() {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const isAdmin = isAdminRole(user.rolNombre);
    const isCentralAdmin = isAdmin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const aliadoScopeId = Number(user.aliadoAccesoId || 0);

    const sedes = await prisma.sede.findMany({
      where: isAdmin
        ? isCentralAdmin
          ? {}
          : {
              aliadoId:
                Number.isInteger(aliadoScopeId) && aliadoScopeId > 0
                  ? aliadoScopeId
                  : -1,
            }
        : {
            id: user.sedeId,
            aliado: {
              codigo: {
                not: ALIADO_FINSER_PAY.codigo,
              },
            },
          },
      select: {
        id: true,
        nombre: true,
        aliadoId: true,
        aliado: {
          select: {
            id: true,
            nombre: true,
            codigo: true,
          },
        },
      },
      orderBy: {
        id: "asc",
      },
    });

    return NextResponse.json(sedes);
  } catch (error) {
    console.error("ERROR LISTANDO SEDES:", error);
    return NextResponse.json(
      { error: "Error cargando sedes" },
      { status: 500 }
    );
  }
}
