import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

function parseSedeId(value: string | null) {
  const sedeId = Number(value);
  return Number.isInteger(sedeId) && sedeId > 0 ? sedeId : null;
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const esAdmin = user.rolNombre.toUpperCase() === "ADMIN";
    const requestUrl = new URL(req.url);
    const sedeIdFiltro = parseSedeId(requestUrl.searchParams.get("sedeId"));

    const inventario = await prisma.inventarioSede.findMany({
      where: esAdmin
        ? sedeIdFiltro
          ? { sedeId: sedeIdFiltro }
          : {}
        : { sedeId: user.sedeId },
      orderBy: { id: "desc" },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        distribuidor: true,
        deboA: true,
        estadoActual: true,
        estadoFinanciero: true,
        origen: true,
        sedeId: true,
        sede: {
          select: {
            id: true,
            nombre: true,
          },
        },
      },
    });

    return NextResponse.json(inventario);
  } catch (error) {
    console.error("ERROR GET INVENTARIO:", error);

    return NextResponse.json(
      { error: "Error cargando inventario" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const data = await req.json();

    const imei = String(data.imei ?? "").replace(/\D/g, "").slice(0, 15);
    const referencia = String(data.referencia ?? "").trim();
    const color = String(data.color ?? "").trim();
    const costo = Number(data.costo ?? 0);
    const distribuidor = String(data.distribuidor ?? "").trim();
    const estadoFinanciero = String(data.estadoFinanciero ?? "").trim().toUpperCase();
    const deboA = data.deboA ? String(data.deboA).trim() : null;

    const esAdmin = user.rolNombre.toUpperCase() === "ADMIN";
    const sedeId = esAdmin ? Number(data.sedeId ?? user.sedeId) : user.sedeId;

    if (!imei) {
      return NextResponse.json(
        { error: "El IMEI es obligatorio" },
        { status: 400 }
      );
    }

    if (!/^\d{1,15}$/.test(imei)) {
      return NextResponse.json(
        { error: "El IMEI debe tener solo números y máximo 15 dígitos" },
        { status: 400 }
      );
    }

    if (!referencia) {
      return NextResponse.json(
        { error: "La referencia es obligatoria" },
        { status: 400 }
      );
    }

    if (!costo || costo <= 0) {
      return NextResponse.json(
        { error: "El costo debe ser mayor a 0" },
        { status: 400 }
      );
    }

    if (!distribuidor) {
      return NextResponse.json(
        { error: "Debes seleccionar un distribuidor" },
        { status: 400 }
      );
    }

    if (!estadoFinanciero) {
      return NextResponse.json(
        { error: "Debes seleccionar el estado financiero" },
        { status: 400 }
      );
    }

    if (estadoFinanciero === "DEUDA" && !deboA) {
      return NextResponse.json(
        { error: "Debes seleccionar 'Debe a'" },
        { status: 400 }
      );
    }

    if (!sedeId || sedeId <= 0) {
      return NextResponse.json(
        { error: "Sede inválida" },
        { status: 400 }
      );
    }

    const existe = await prisma.inventarioSede.findFirst({
      where: { imei, sedeId },
      select: { id: true },
    });

    if (existe) {
      return NextResponse.json(
        { error: "IMEI ya existe en esta sede" },
        { status: 400 }
      );
    }

    const principal = await prisma.inventarioPrincipal.findUnique({
      where: { imei },
      select: { id: true },
    });

    const nuevo = await prisma.inventarioSede.create({
      data: {
        imei,
        referencia,
        color: color || null,
        costo,
        distribuidor,
        sedeId,
        estadoFinanciero,
        deboA,
        estadoActual: "BODEGA",
        origen: principal ? "PRINCIPAL" : "MANUAL",
        inventarioPrincipalId: principal ? principal.id : null,
      },
      select: {
        id: true,
        imei: true,
        referencia: true,
        sedeId: true,
        estadoActual: true,
        estadoFinanciero: true,
      },
    });

    await prisma.movimientoInventario.create({
      data: {
        imei,
        tipoMovimiento: "INGRESO_SEDE",
        referencia,
        color: color || null,
        costo,
        sedeId,
        deboA,
        estadoFinanciero,
        origen: principal ? "PRINCIPAL" : "MANUAL",
        observacion: `Ingreso manual desde ${distribuidor}`,
      },
      select: {
        id: true,
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Guardado correctamente",
      item: nuevo,
    });
  } catch (error) {
    console.error("ERROR API INVENTARIO:", error);

    return NextResponse.json(
      { error: "Error interno" },
      { status: 500 }
    );
  }
}
