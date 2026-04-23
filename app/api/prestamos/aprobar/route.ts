import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  esDeudaProveedor,
  esEstadoDeuda,
  resolverFinanzasDestinoPrestamo,
  SEDE_BODEGA_ID,
} from "@/lib/prestamos";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const { id } = await req.json();

    if (!id) {
      return NextResponse.json({ error: "ID requerido" }, { status: 400 });
    }

    const prestamo = await prisma.prestamoSede.findUnique({
      where: { id: Number(id) },
    });

    if (!prestamo) {
      return NextResponse.json(
        { error: "Prestamo no encontrado" },
        { status: 404 }
      );
    }

    if (String(prestamo.estado).toUpperCase() !== "PENDIENTE") {
      return NextResponse.json(
        { error: "El prestamo no esta pendiente" },
        { status: 400 }
      );
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";
    const esDestino = Number(user.sedeId) === Number(prestamo.sedeDestinoId);

    if (!esAdmin && !esDestino) {
      return NextResponse.json(
        { error: "No autorizado para aprobar este prestamo" },
        { status: 403 }
      );
    }

    const itemOrigen = await prisma.inventarioSede.findFirst({
      where: {
        imei: prestamo.imei,
        sedeId: Number(prestamo.sedeOrigenId),
      },
    });

    if (!itemOrigen) {
      return NextResponse.json(
        { error: "Equipo no encontrado en la sede origen" },
        { status: 404 }
      );
    }

    const trasladaDeudaDePrincipal =
      String(itemOrigen.origen || "").toUpperCase() === "PRINCIPAL" &&
      esEstadoDeuda(itemOrigen.estadoFinanciero) &&
      esDeudaProveedor(itemOrigen.deboA);

    const finanzasDestino = resolverFinanzasDestinoPrestamo({
      estadoFinanciero: itemOrigen.estadoFinanciero,
      deboA: itemOrigen.deboA,
      sedeOrigenId: prestamo.sedeOrigenId,
    });

    await prisma.$transaction(async (tx) => {
      const existenteDestino = await tx.inventarioSede.findFirst({
        where: {
          imei: prestamo.imei,
          sedeId: Number(prestamo.sedeDestinoId),
        },
      });

      if (existenteDestino) {
        await tx.inventarioSede.update({
          where: { id: existenteDestino.id },
          data: {
            referencia: prestamo.referencia,
            color: prestamo.color,
            costo: Number(prestamo.costo),
            distribuidor: itemOrigen.distribuidor,
            deboA: finanzasDestino.deboA,
            estadoFinanciero: finanzasDestino.estadoFinanciero,
            origen: "PRESTAMO",
            estadoAnterior: existenteDestino.estadoActual,
            estadoActual: "BODEGA",
            fechaMovimiento: new Date(),
            inventarioPrincipalId: itemOrigen.inventarioPrincipalId || null,
            observacion: `Recibido por prestamo desde sede ${prestamo.sedeOrigenId}`,
          },
        });
      } else {
        await tx.inventarioSede.create({
          data: {
            imei: prestamo.imei,
            referencia: prestamo.referencia,
            color: prestamo.color,
            costo: Number(prestamo.costo),
            distribuidor: itemOrigen.distribuidor,
            sedeId: Number(prestamo.sedeDestinoId),
            deboA: finanzasDestino.deboA,
            estadoFinanciero: finanzasDestino.estadoFinanciero,
            origen: "PRESTAMO",
            estadoAnterior: itemOrigen.estadoActual,
            estadoActual: "BODEGA",
            fechaMovimiento: new Date(),
            inventarioPrincipalId: itemOrigen.inventarioPrincipalId || null,
            observacion: `Recibido por prestamo desde sede ${prestamo.sedeOrigenId}`,
          },
        });
      }

      await tx.inventarioSede.update({
        where: { id: itemOrigen.id },
        data: {
          estadoAnterior: itemOrigen.estadoActual,
          estadoActual: "PRESTAMO",
          fechaMovimiento: new Date(),
          observacion: trasladaDeudaDePrincipal
            ? `Prestamo aprobado hacia sede ${prestamo.sedeDestinoId}. La deuda de principal queda trasladada a la sede destino.`
            : `Prestamo aprobado hacia sede ${prestamo.sedeDestinoId}`,
          estadoFinanciero: trasladaDeudaDePrincipal
            ? "PAGO"
            : itemOrigen.estadoFinanciero,
          deboA: trasladaDeudaDePrincipal ? null : itemOrigen.deboA,
        },
      });

      await tx.prestamoSede.update({
        where: { id: prestamo.id },
        data: {
          estado: "APROBADO",
        },
      });

      if (trasladaDeudaDePrincipal) {
        if (itemOrigen.inventarioPrincipalId) {
          await tx.inventarioPrincipal.update({
            where: { id: itemOrigen.inventarioPrincipalId },
            data: {
              estado: "PRESTAMO",
              sedeDestinoId: prestamo.sedeDestinoId,
              estadoCobro: "PENDIENTE",
              fechaEnvio: new Date(),
              observacion: `Deuda activa trasladada a SEDE ${prestamo.sedeDestinoId} despues de aprobacion desde SEDE ${prestamo.sedeOrigenId}.`,
            },
          });
        } else {
          await tx.inventarioPrincipal.updateMany({
            where: {
              imei: prestamo.imei,
            },
            data: {
              estado: "PRESTAMO",
              sedeDestinoId: prestamo.sedeDestinoId,
              estadoCobro: "PENDIENTE",
              fechaEnvio: new Date(),
              observacion: `Deuda activa trasladada a SEDE ${prestamo.sedeDestinoId} despues de aprobacion desde SEDE ${prestamo.sedeOrigenId}.`,
            },
          });
        }

        await tx.prestamoSede.updateMany({
          where: {
            imei: prestamo.imei,
            sedeOrigenId: SEDE_BODEGA_ID,
            estado: {
              in: ["APROBADO", "PAGO_PENDIENTE_APROBACION"],
            },
          },
          data: {
            sedeDestinoId: prestamo.sedeDestinoId,
            estado: "APROBADO",
            montoPago: null,
            fechaSolicitudPago: null,
            fechaAprobacionPago: null,
          },
        });
      }

      await tx.movimientoInventario.create({
        data: {
          imei: prestamo.imei,
          tipoMovimiento: "PRESTAMO_RECIBIDO",
          referencia: prestamo.referencia,
          color: prestamo.color || null,
          costo: Number(prestamo.costo),
          sedeId: Number(prestamo.sedeDestinoId),
          deboA: finanzasDestino.deboA,
          estadoFinanciero: finanzasDestino.estadoFinanciero,
          origen: "PRESTAMO",
          observacion: trasladaDeudaDePrincipal
            ? `Prestamo aprobado desde SEDE ${prestamo.sedeOrigenId}. La deuda del proveedor queda ahora en la sede destino.`
            : `Prestamo aprobado y recibido desde SEDE ${prestamo.sedeOrigenId}.`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Prestamo aprobado correctamente",
    });
  } catch (error) {
    console.error("ERROR APROBANDO PRESTAMO:", error);
    return NextResponse.json(
      { error: "Error aprobando prestamo" },
      { status: 500 }
    );
  }
}
