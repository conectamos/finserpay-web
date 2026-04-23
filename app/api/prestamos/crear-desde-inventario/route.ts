import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  esEstadoDeuda,
  esDeudaProveedor,
} from "@/lib/prestamos";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const body = await req.json();
    const inventarioId = Number(body.inventarioId);
    const sedeDestinoId = Number(body.sedeDestinoId);

    if (!inventarioId || !sedeDestinoId) {
      return NextResponse.json({ error: "Datos invalidos" }, { status: 400 });
    }

    if (user.sedeId === sedeDestinoId) {
      return NextResponse.json(
        { error: "No puedes enviar un prestamo a la misma sede" },
        { status: 400 }
      );
    }

    const inventario = await prisma.inventarioSede.findUnique({
      where: { id: inventarioId },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        sedeId: true,
        estadoActual: true,
        estadoFinanciero: true,
        deboA: true,
        distribuidor: true,
        origen: true,
        inventarioPrincipalId: true,
      },
    });

    if (!inventario) {
      return NextResponse.json(
        { error: "Equipo no encontrado en inventario" },
        { status: 404 }
      );
    }

    if (inventario.sedeId !== user.sedeId) {
      return NextResponse.json(
        { error: "No puedes prestar un equipo que no pertenece a tu sede" },
        { status: 403 }
      );
    }

    if (String(inventario.estadoActual || "").toUpperCase() !== "BODEGA") {
      return NextResponse.json(
        {
          error: `Solo se pueden prestar equipos en BODEGA. Estado actual: ${inventario.estadoActual}`,
        },
        { status: 400 }
      );
    }

    const trasladaDeudaDePrincipal =
      String(inventario.origen || "").toUpperCase() === "PRINCIPAL" &&
      esEstadoDeuda(inventario.estadoFinanciero) &&
      esDeudaProveedor(inventario.deboA);

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

    const existeEnDestino = await prisma.inventarioSede.findFirst({
      where: {
        imei: inventario.imei,
        sedeId: sedeDestinoId,
      },
      select: { id: true },
    });

    if (existeEnDestino) {
      return NextResponse.json(
        { error: "Ese IMEI ya existe en la sede destino" },
        { status: 400 }
      );
    }

    const prestamoActivoSalida = await prisma.prestamoSede.findFirst({
      where: {
        imei: inventario.imei,
        sedeOrigenId: inventario.sedeId,
        estado: {
          in: ["PENDIENTE", "APROBADO", "PAGO_PENDIENTE_APROBACION"],
        },
      },
      select: { id: true },
    });

    if (prestamoActivoSalida) {
      return NextResponse.json(
        { error: "Ese equipo ya tiene un prestamo saliente activo desde tu sede" },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.prestamoSede.create({
        data: {
          imei: inventario.imei,
          referencia: inventario.referencia,
          color: inventario.color || null,
          costo: inventario.costo,
          sedeOrigenId: inventario.sedeId,
          sedeDestinoId,
          estado: "PENDIENTE",
        },
      });

      await tx.inventarioSede.update({
        where: { id: inventario.id },
        data: {
          estadoAnterior: inventario.estadoActual || null,
          estadoActual: "PRESTAMO",
          fechaMovimiento: new Date(),
          observacion: trasladaDeudaDePrincipal
            ? `Solicitud enviada a ${sedeDestino.nombre}. La deuda de principal solo se trasladara cuando la sede destino apruebe el prestamo.`
            : `Solicitud enviada a ${sedeDestino.nombre}. Pendiente por aprobacion en sede destino.`,
        },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: inventario.imei,
          tipoMovimiento: "PRESTAMO_ENTRE_SEDES",
          referencia: inventario.referencia,
          color: inventario.color || null,
          costo: inventario.costo,
          sedeId: inventario.sedeId,
          deboA: inventario.deboA,
          estadoFinanciero: inventario.estadoFinanciero,
          origen: "PRESTAMO",
          observacion: trasladaDeudaDePrincipal
            ? `Solicitud de prestamo enviada desde SEDE ${inventario.sedeId} hacia ${sedeDestino.nombre}. La deuda del proveedor se trasladara cuando el destino apruebe.`
            : `Solicitud de prestamo enviada desde SEDE ${inventario.sedeId} hacia ${sedeDestino.nombre}. Pendiente por aprobacion.`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Solicitud de prestamo enviada. La sede destino debe aprobarla para recibir el equipo.",
    });
  } catch (error) {
    console.error("ERROR CREAR PRESTAMO DESDE INVENTARIO:", error);
    return NextResponse.json(
      { error: "Error interno al crear prestamo entre sedes" },
      { status: 500 }
    );
  }
}
