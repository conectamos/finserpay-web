import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { PROVEEDOR_FINSER, SEDE_BODEGA_ID } from "@/lib/prestamos";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";

    if (!esAdmin) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }

    const body = await req.json();
    const id = Number(body.id);
    const sedeDestinoId = Number(body.sedeDestinoId);

    if (!id || !sedeDestinoId) {
      return NextResponse.json({ error: "Datos invalidos" }, { status: 400 });
    }

    const sedeBodega = await prisma.sede.findUnique({
      where: { id: SEDE_BODEGA_ID },
      select: { id: true, nombre: true },
    });

    if (!sedeBodega) {
      return NextResponse.json(
        { error: "No existe la sede configurada como bodega principal" },
        { status: 400 }
      );
    }

    const item = await prisma.inventarioPrincipal.findUnique({
      where: { id },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        distribuidor: true,
        estado: true,
      },
    });

    if (!item) {
      return NextResponse.json(
        { error: "Equipo no encontrado en bodega principal" },
        { status: 404 }
      );
    }

    const estadoPrincipal = String(item.estado || "BODEGA").toUpperCase();

    if (estadoPrincipal !== "BODEGA") {
      return NextResponse.json(
        {
          error:
            "Este equipo no esta disponible en bodega principal para enviarlo a una sede",
        },
        { status: 400 }
      );
    }

    const sedeDestino = await prisma.sede.findUnique({
      where: { id: sedeDestinoId },
      select: { id: true, nombre: true },
    });

    if (!sedeDestino) {
      return NextResponse.json(
        { error: "La sede destino no existe" },
        { status: 404 }
      );
    }

    if (sedeDestino.id === SEDE_BODEGA_ID) {
      return NextResponse.json(
        {
          error:
            "No puedes enviar un equipo desde bodega principal hacia la misma bodega principal",
        },
        { status: 400 }
      );
    }

    const existeEnInventarioSede = await prisma.inventarioSede.findFirst({
      where: {
        imei: item.imei,
        sedeId: sedeDestinoId,
      },
      select: { id: true },
    });

    if (existeEnInventarioSede) {
      return NextResponse.json(
        { error: "Ese IMEI ya existe en la sede destino" },
        { status: 400 }
      );
    }

    const existePrestamoActivo = await prisma.prestamoSede.findFirst({
      where: {
        imei: item.imei,
        sedeOrigenId: SEDE_BODEGA_ID,
        sedeDestinoId,
        estado: {
          in: ["PENDIENTE", "APROBADO", "PAGO_PENDIENTE_APROBACION"],
        },
      },
      select: { id: true },
    });

    if (existePrestamoActivo) {
      return NextResponse.json(
        { error: "Ese equipo ya tiene un prestamo activo hacia esa sede" },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.inventarioSede.create({
        data: {
          imei: item.imei,
          referencia: item.referencia,
          color: item.color || null,
          costo: item.costo,
          sedeId: sedeDestinoId,
          distribuidor: item.distribuidor || sedeBodega.nombre,
          estadoFinanciero: "DEUDA",
          deboA: PROVEEDOR_FINSER,
          estadoActual: "BODEGA",
          origen: "PRINCIPAL",
          inventarioPrincipalId: item.id,
        },
      });

      await tx.inventarioPrincipal.update({
        where: { id: item.id },
        data: {
          estado: "PRESTAMO",
          sedeDestinoId,
          estadoCobro: "PENDIENTE",
          fechaEnvio: new Date(),
          observacion: `Enviado a ${sedeDestino.nombre} con deuda activa a ${PROVEEDOR_FINSER}`,
        },
      });

      await tx.prestamoSede.create({
        data: {
          imei: item.imei,
          referencia: item.referencia,
          color: item.color || null,
          costo: item.costo,
          sedeOrigenId: SEDE_BODEGA_ID,
          sedeDestinoId,
          estado: "APROBADO",
        },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: item.imei,
          tipoMovimiento: "SALIDA_PRINCIPAL_A_SEDE",
          referencia: item.referencia,
          color: item.color || null,
          costo: item.costo,
          sedeId: sedeDestinoId,
          deboA: PROVEEDOR_FINSER,
          estadoFinanciero: "DEUDA",
          origen: "PRINCIPAL",
          observacion: `Equipo enviado desde ${sedeBodega.nombre} a ${sedeDestino.nombre}. Ingresa en BODEGA con deuda a ${PROVEEDOR_FINSER}.`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje:
        "Equipo enviado correctamente a la sede. Ingresa en bodega con deuda a Proveedor Finser.",
    });
  } catch (error) {
    console.error("ERROR ENVIAR PRINCIPAL A SEDE:", error);
    return NextResponse.json(
      { error: "Error enviando equipo a sede" },
      { status: 500 }
    );
  }
}
