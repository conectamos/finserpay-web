import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  esDeudaProveedor,
  esEstadoDeuda,
  SEDE_BODEGA_ID,
} from "@/lib/prestamos";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const body = await req.json();
    const id = Number(body.id);

    if (!id) {
      return NextResponse.json(
        { error: "ID de prestamo invalido" },
        { status: 400 }
      );
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";

    const prestamo = await prisma.prestamoSede.findUnique({
      where: { id },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        sedeOrigenId: true,
        sedeDestinoId: true,
        estado: true,
      },
    });

    if (!prestamo) {
      return NextResponse.json(
        { error: "Prestamo no encontrado" },
        { status: 404 }
      );
    }

    if (!esAdmin && user.sedeId !== prestamo.sedeDestinoId) {
      return NextResponse.json(
        { error: "Solo la sede destino puede devolver este prestamo" },
        { status: 403 }
      );
    }

    if (prestamo.estado !== "APROBADO") {
      return NextResponse.json(
        { error: `No se puede devolver. Estado actual: ${prestamo.estado}` },
        { status: 400 }
      );
    }

    if (prestamo.sedeOrigenId === SEDE_BODEGA_ID) {
      const existePrestamoIntermedioActivo = await prisma.prestamoSede.findFirst({
        where: {
          imei: prestamo.imei,
          sedeDestinoId: prestamo.sedeDestinoId,
          sedeOrigenId: {
            not: SEDE_BODEGA_ID,
          },
          estado: {
            in: ["APROBADO", "PAGO_PENDIENTE_APROBACION"],
          },
        },
        select: {
          id: true,
          sedeOrigenId: true,
        },
      });

      if (existePrestamoIntermedioActivo) {
        return NextResponse.json(
          {
            error: `Este equipo debe devolverse primero a SEDE ${existePrestamoIntermedioActivo.sedeOrigenId} antes de regresar a bodega principal.`,
          },
          { status: 400 }
        );
      }
    }

    const equipoDestino = await prisma.inventarioSede.findFirst({
      where: {
        imei: prestamo.imei,
        sedeId: prestamo.sedeDestinoId,
      },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        estadoActual: true,
        estadoFinanciero: true,
        deboA: true,
        origen: true,
        distribuidor: true,
        inventarioPrincipalId: true,
      },
    });

    if (!equipoDestino) {
      return NextResponse.json(
        { error: "El equipo no existe en la sede destino" },
        { status: 404 }
      );
    }

    if (String(equipoDestino.estadoActual || "").toUpperCase() !== "BODEGA") {
      return NextResponse.json(
        {
          error:
            "Solo se puede devolver un prestamo cuando el equipo sigue en BODEGA en la sede destino. Si ya fue vendido, debes gestionar el pago.",
        },
        { status: 400 }
      );
    }

    const retornoDirectoAPrincipal = prestamo.sedeOrigenId === SEDE_BODEGA_ID;

    const equipoOrigen = retornoDirectoAPrincipal
      ? null
      : await prisma.inventarioSede.findFirst({
          where: {
            imei: prestamo.imei,
            sedeId: prestamo.sedeOrigenId,
            estadoActual: "PRESTAMO",
          },
          select: {
            id: true,
            deboA: true,
            estadoFinanciero: true,
            distribuidor: true,
            origen: true,
            inventarioPrincipalId: true,
          },
        });

    if (!retornoDirectoAPrincipal && !equipoOrigen) {
      return NextResponse.json(
        { error: "El equipo en la sede origen no esta en PRESTAMO" },
        { status: 404 }
      );
    }

    const deudaPrincipalSeDevuelveAlOrigen =
      !retornoDirectoAPrincipal &&
      !!equipoOrigen &&
      String(equipoOrigen.origen || "").toUpperCase() === "PRINCIPAL" &&
      esEstadoDeuda(equipoDestino.estadoFinanciero) &&
      esDeudaProveedor(equipoDestino.deboA);

    await prisma.$transaction(async (tx) => {
      await tx.prestamoSede.update({
        where: { id: prestamo.id },
        data: {
          estado: "DEVUELTO",
        },
      });

      if (retornoDirectoAPrincipal) {
        if (equipoDestino.inventarioPrincipalId) {
          await tx.inventarioPrincipal.update({
            where: { id: equipoDestino.inventarioPrincipalId },
            data: {
              estado: "BODEGA",
              sedeDestinoId: null,
              estadoCobro: null,
              fechaEnvio: null,
              observacion: `Devuelto desde SEDE ${prestamo.sedeDestinoId}`,
            },
          });
        } else {
          await tx.inventarioPrincipal.updateMany({
            where: {
              imei: prestamo.imei,
              sedeDestinoId: prestamo.sedeDestinoId,
              estado: "PRESTAMO",
            },
            data: {
              estado: "BODEGA",
              sedeDestinoId: null,
              estadoCobro: null,
              fechaEnvio: null,
              observacion: `Devuelto desde SEDE ${prestamo.sedeDestinoId}`,
            },
          });
        }
      } else if (equipoOrigen) {
        await tx.inventarioSede.update({
          where: { id: equipoOrigen.id },
          data: {
            estadoAnterior: "PRESTAMO",
            estadoActual: "BODEGA",
            fechaMovimiento: new Date(),
            observacion: `Equipo devuelto desde SEDE ${prestamo.sedeDestinoId}`,
            deboA: deudaPrincipalSeDevuelveAlOrigen
              ? equipoDestino.deboA
              : equipoOrigen.deboA,
            estadoFinanciero: deudaPrincipalSeDevuelveAlOrigen
              ? equipoDestino.estadoFinanciero
              : equipoOrigen.estadoFinanciero || "PAGO",
            distribuidor: equipoOrigen.distribuidor,
          },
        });

        if (deudaPrincipalSeDevuelveAlOrigen) {
          if (equipoOrigen.inventarioPrincipalId) {
            await tx.inventarioPrincipal.update({
              where: { id: equipoOrigen.inventarioPrincipalId },
              data: {
                estado: "PRESTAMO",
                sedeDestinoId: prestamo.sedeOrigenId,
                estadoCobro: "PENDIENTE",
                fechaEnvio: new Date(),
                observacion: `Deuda activa retorna a SEDE ${prestamo.sedeOrigenId} despues de devolucion desde SEDE ${prestamo.sedeDestinoId}.`,
              },
            });
          } else {
            await tx.inventarioPrincipal.updateMany({
              where: {
                imei: prestamo.imei,
              },
              data: {
                estado: "PRESTAMO",
                sedeDestinoId: prestamo.sedeOrigenId,
                estadoCobro: "PENDIENTE",
                fechaEnvio: new Date(),
                observacion: `Deuda activa retorna a SEDE ${prestamo.sedeOrigenId} despues de devolucion desde SEDE ${prestamo.sedeDestinoId}.`,
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
              sedeDestinoId: prestamo.sedeOrigenId,
              estado: "APROBADO",
              montoPago: null,
              fechaSolicitudPago: null,
              fechaAprobacionPago: null,
            },
          });
        }
      }

      await tx.inventarioSede.delete({
        where: { id: equipoDestino.id },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: prestamo.imei,
          tipoMovimiento: "PRESTAMO_DEVUELTO_SALIDA",
          referencia: prestamo.referencia,
          color: prestamo.color || null,
          costo: prestamo.costo,
          sedeId: prestamo.sedeDestinoId,
          deboA: equipoDestino.deboA ?? `SEDE ${prestamo.sedeOrigenId}`,
          estadoFinanciero: equipoDestino.estadoFinanciero,
          origen: "PRESTAMO",
          observacion: `Equipo devuelto a SEDE ${prestamo.sedeOrigenId}. Prestamo #${prestamo.id}`,
        },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: prestamo.imei,
          tipoMovimiento: "PRESTAMO_DEVUELTO_INGRESO",
          referencia: prestamo.referencia,
          color: prestamo.color || null,
          costo: prestamo.costo,
          sedeId: prestamo.sedeOrigenId,
          deboA: retornoDirectoAPrincipal
            ? null
            : deudaPrincipalSeDevuelveAlOrigen
              ? equipoDestino.deboA
              : equipoOrigen?.deboA || null,
          estadoFinanciero: retornoDirectoAPrincipal
            ? "PAGO"
            : deudaPrincipalSeDevuelveAlOrigen
              ? equipoDestino.estadoFinanciero
              : equipoOrigen?.estadoFinanciero || "PAGO",
          origen: retornoDirectoAPrincipal
            ? "DEVOLUCION_PRINCIPAL"
            : "DEVOLUCION_PRESTAMO",
          observacion: retornoDirectoAPrincipal
            ? `Equipo retornado a bodega principal desde SEDE ${prestamo.sedeDestinoId}. Prestamo #${prestamo.id}`
            : `Equipo retornado desde SEDE ${prestamo.sedeDestinoId}. Prestamo #${prestamo.id}`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Prestamo devuelto correctamente",
    });
  } catch (error) {
    console.error("ERROR DEVOLVER PRESTAMO:", error);
    return NextResponse.json(
      { error: "Error interno al devolver prestamo" },
      { status: 500 }
    );
  }
}
