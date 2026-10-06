import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  deactivateMoraBlockExemption,
  listActiveMoraBlockExemptions,
} from "@/lib/mora-block-exemptions";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";

async function requireCentralAdmin() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }

  if (
    !isAdminRole(user.rolNombre) ||
    !isFinserPayCentralAlly(user.aliadoAccesoCodigo)
  ) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Solo FINSER PAY central puede gestionar estas excepciones" },
        { status: 403 }
      ),
    };
  }

  return { ok: true as const, user };
}

async function loadExemptions() {
  const exemptions = await listActiveMoraBlockExemptions();
  const documents = exemptions.map((item) => item.documento);
  const creatorIds = exemptions
    .map((item) => item.creadoPorUsuarioId)
    .filter((value): value is number => Number.isInteger(value));

  const [credits, creators] = await Promise.all([
    documents.length
      ? prisma.credito.findMany({
          where: {
            clienteDocumento: { in: documents },
            estado: { not: "ANULADO" },
          },
          select: {
            id: true,
            clienteDocumento: true,
            clienteNombre: true,
            clienteTelefono: true,
            bloqueoMora: true,
            folio: true,
          },
          orderBy: { id: "desc" },
        })
      : Promise.resolve([]),
    creatorIds.length
      ? prisma.usuario.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, nombre: true },
        })
      : Promise.resolve([]),
  ]);
  const creatorNames = new Map(creators.map((item) => [item.id, item.nombre]));

  return exemptions.map((exemption) => {
    const matchingCredits = credits.filter(
      (credit) => credit.clienteDocumento === exemption.documento
    );
    const latestCredit = matchingCredits[0] ?? null;

    return {
      id: exemption.id,
      documento: exemption.documento,
      motivo: exemption.motivo,
      fechaFin: exemption.fechaFin?.toISOString() ?? null,
      createdAt: exemption.createdAt.toISOString(),
      updatedAt: exemption.updatedAt.toISOString(),
      creadoPor:
        creatorNames.get(exemption.creadoPorUsuarioId ?? 0) ?? "FINSER PAY",
      cliente: latestCredit
        ? {
            nombre: latestCredit.clienteNombre,
            telefono: latestCredit.clienteTelefono,
          }
        : null,
      creditosActivos: matchingCredits.length,
      bloqueosMoraActivos: matchingCredits.filter((item) => item.bloqueoMora)
        .length,
    };
  });
}

export async function GET() {
  const access = await requireCentralAdmin();

  if (!access.ok) {
    return access.response;
  }

  return NextResponse.json({ excepciones: await loadExemptions() });
}

export async function POST() {
  const access = await requireCentralAdmin();

  if (!access.ok) {
    return access.response;
  }

  return NextResponse.json({
    ok: false,
    code: "LEGACY_MORA_EXCEPTION_DISABLED",
    error: "Crea la excepción desde Aprobaciones por crédito para aplicar fechas, enfriamiento y auditoría.",
    href: "/dashboard/aprobaciones/excepciones-mora",
  }, { status: 409 });
}

export async function DELETE(request: Request) {
  const access = await requireCentralAdmin();

  if (!access.ok) {
    return access.response;
  }

  try {
    const body = (await request.json()) as { documento?: unknown };
    const exemption = await deactivateMoraBlockExemption(body.documento);

    if (!exemption) {
      return NextResponse.json(
        { error: "La excepcion no existe" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      message:
        "Excepcion retirada. Si el credito sigue en mora, el bloqueo se evaluara en la proxima sincronizacion.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo retirar la excepcion",
      },
      { status: 400 }
    );
  }
}
