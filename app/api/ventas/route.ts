import { NextResponse } from "next/server";
import { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  buildLegacyFinancieraPayload,
  construirDetalleFinancieras,
  totalFinancierasNetas as sumarFinancierasNetas,
  type CatalogoFinanciera,
} from "@/lib/ventas-financieras";
import { obtenerCatalogoPersonalVenta } from "@/lib/ventas-personal";

type VentaInput = {
  descripcion: string;
  cerrador: string;
  comision: number;
  finanzas: Array<{
    nombre: string;
    valor: number;
  }>;
  ingreso1Base: number;
  ingreso2Base: number;
  jalador: string;
  salida: number;
  serial: string;
  servicio: string;
  tipoIngreso1: string;
  tipoIngreso2: string;
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeServiceValue(servicio: string) {
  return servicio.trim().toUpperCase();
}

function ingresoNeto(valorBase: number, tipoIngreso: string): number {
  return tipoIngreso.trim().toUpperCase() === "VOUCHER"
    ? valorBase * 0.95
    : valorBase;
}

function ingresoCajaOficina(valorBase: number, tipoIngreso: string): number {
  const tipo = tipoIngreso.trim().toUpperCase();

  if (tipo === "TRANSFERENCIA") return 0;
  if (tipo === "VOUCHER") return valorBase * 0.95;
  return valorBase;
}

function servicioOcultaFinancieras(servicio: string): boolean {
  const normalized = normalizeServiceValue(servicio);
  return (
    normalized.includes("ACTIVACI") ||
    normalized === "CONTADO CLARO" ||
    normalized === "CONTADO LIBRES"
  );
}

function parseVentaInput(data: Record<string, unknown>): VentaInput {
  return {
    serial: String(data.serial ?? "")
      .replace(/\D/g, "")
      .slice(0, 15),
    servicio: String(data.servicio ?? "").trim(),
    descripcion: String(data.descripcion ?? "").trim(),
    jalador: String(data.jalador ?? "").trim(),
    cerrador: String(data.cerrador ?? "").trim(),
    tipoIngreso1: "EFECTIVO",
    tipoIngreso2: String(data.tipoIngreso2 ?? "").trim(),
    ingreso1Base: toNumber(data.ingreso1Base),
    ingreso2Base: toNumber(data.ingreso2Base),
    comision: toNumber(data.comision),
    salida: toNumber(data.salida),
    finanzas: [
      {
        nombre: String(data.fin1Nombre ?? "").trim(),
        valor: toNumber(data.fin1Valor),
      },
      {
        nombre: String(data.fin2Nombre ?? "").trim(),
        valor: toNumber(data.fin2Valor),
      },
      {
        nombre: String(data.fin3Nombre ?? "").trim(),
        valor: toNumber(data.fin3Valor),
      },
      {
        nombre: String(data.fin4Nombre ?? "").trim(),
        valor: toNumber(data.fin4Valor),
      },
    ],
  };
}

function validateVentaInput(input: VentaInput, options?: { requireSerial?: boolean }) {
  if (options?.requireSerial !== false && !input.serial) {
    return "El IMEI es obligatorio";
  }

  if (!input.servicio) {
    return "Debes seleccionar el servicio";
  }

  if (!input.descripcion) {
    return "La descripcion es obligatoria";
  }

  if (!input.jalador) {
    return "Debes seleccionar el jalador";
  }

  if (!input.cerrador) {
    return "Debes seleccionar el cerrador";
  }

  if (input.ingreso1Base < 0) {
    return "Debes ingresar el valor del ingreso 1";
  }

  if (input.ingreso2Base > 0 && !input.tipoIngreso2) {
    return "Debes seleccionar el tipo del ingreso 2";
  }

  return null;
}

function normalizeFinanzas(input: VentaInput) {
  if (servicioOcultaFinancieras(input.servicio)) {
    return input.finanzas.map(() => ({ nombre: "", valor: 0 }));
  }

  return input.finanzas;
}

function buildJsonFinancierasDetalle(detalle: unknown[]) {
  return detalle.length
    ? (JSON.parse(JSON.stringify(detalle)) as Prisma.InputJsonValue)
    : Prisma.JsonNull;
}

function buildVentaData(
  input: VentaInput,
  costoEquipo: number,
  catalogoFinancieras: CatalogoFinanciera[]
) {
  const finanzas = normalizeFinanzas(input);
  const detalleFinancieras = construirDetalleFinancieras(
    finanzas,
    catalogoFinancieras
  );

  const ingreso1Neto = ingresoNeto(input.ingreso1Base, input.tipoIngreso1);
  const ingreso2Neto = ingresoNeto(input.ingreso2Base, input.tipoIngreso2);
  const totalIngresosNetos = ingreso1Neto + ingreso2Neto;
  const totalCajaIngresos =
    ingresoCajaOficina(input.ingreso1Base, input.tipoIngreso1) +
    ingresoCajaOficina(input.ingreso2Base, input.tipoIngreso2);

  const totalFinancierasNetas = sumarFinancierasNetas(detalleFinancieras);

  const utilidad =
    totalIngresosNetos + totalFinancierasNetas - costoEquipo - input.comision - input.salida;
  const cajaOficina = totalCajaIngresos - input.comision - input.salida;

  return {
    detalleFinancieras,
    payloadFinancieras: buildLegacyFinancieraPayload(detalleFinancieras),
    totalIngresosNetos,
    utilidad,
    cajaOficina,
    ingreso1Neto,
    ingreso2Neto,
    finanzas,
  };
}

async function requireSessionUser() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }

  return { ok: true as const, user };
}

function isAdminRole(roleName: string) {
  return String(roleName || "").trim().toUpperCase() === "ADMIN";
}

function parseSedeId(value: string | null) {
  const sedeId = Number(value);
  return Number.isInteger(sedeId) && sedeId > 0 ? sedeId : null;
}

async function getVentaById(id: number) {
  return prisma.venta.findUnique({
    where: { id },
    select: {
      id: true,
      idVenta: true,
      fecha: true,
      hora: true,
      servicio: true,
      descripcion: true,
      serial: true,
      jalador: true,
      cerrador: true,
      ingreso: true,
      alcanos: true,
      payjoy: true,
      sistecredito: true,
      addi: true,
      sumaspay: true,
      celya: true,
      bogota: true,
      alocredit: true,
      esmio: true,
      kaiowa: true,
      finser: true,
      gora: true,
      financierasDetalle: true,
      utilidad: true,
      comision: true,
      salida: true,
      cajaOficina: true,
      tipoIngreso: true,
      ingreso1: true,
      ingreso2: true,
      primerValor: true,
      segundoValor: true,
      usuarioId: true,
      sedeId: true,
      inventarioSedeId: true,
      sede: {
        select: {
          id: true,
          nombre: true,
        },
      },
      inventarioSede: {
        select: {
          id: true,
          referencia: true,
          color: true,
          costo: true,
          estadoActual: true,
          estadoFinanciero: true,
          origen: true,
        },
      },
    },
  });
}

export async function GET(req: Request) {
  try {
    const session = await requireSessionUser();

    if (!session.ok) {
      return session.response;
    }

    const user = session.user;
    const esAdmin = isAdminRole(user.rolNombre);
    const requestUrl = new URL(req.url);
    const ventaIdParam = requestUrl.searchParams.get("id");
    const sedeIdFiltro = parseSedeId(requestUrl.searchParams.get("sedeId"));

    if (ventaIdParam) {
      const ventaId = Number(ventaIdParam);

      if (!Number.isInteger(ventaId) || ventaId <= 0) {
        return NextResponse.json({ error: "La venta no es valida" }, { status: 400 });
      }

      const venta = await getVentaById(ventaId);

      if (!venta || (!esAdmin && venta.sedeId !== user.sedeId)) {
        return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
      }

      return NextResponse.json(venta);
    }

    const ventas = await prisma.venta.findMany({
      where: esAdmin
        ? sedeIdFiltro
          ? { sedeId: sedeIdFiltro }
          : {}
        : { sedeId: user.sedeId },
      select: {
        id: true,
        idVenta: true,
        fecha: true,
        hora: true,
        servicio: true,
        descripcion: true,
        serial: true,
        jalador: true,
        cerrador: true,
        ingreso: true,
        alcanos: true,
        payjoy: true,
        sistecredito: true,
        addi: true,
        sumaspay: true,
        celya: true,
        bogota: true,
        alocredit: true,
        esmio: true,
        kaiowa: true,
        finser: true,
        gora: true,
        financierasDetalle: true,
        utilidad: true,
        comision: true,
        salida: true,
        cajaOficina: true,
        tipoIngreso: true,
        ingreso1: true,
        ingreso2: true,
        primerValor: true,
        segundoValor: true,
        sede: {
          select: {
            id: true,
            nombre: true,
          },
        },
        inventarioSede: {
          select: {
            id: true,
            referencia: true,
            color: true,
            costo: true,
          },
        },
      },
      orderBy: { id: "desc" },
    });

    return NextResponse.json(ventas);
  } catch (error) {
    console.error("ERROR GET VENTAS:", error);
    return NextResponse.json({ error: "Error cargando ventas" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSessionUser();

    if (!session.ok) {
      return session.response;
    }

    const user = session.user;
    const data = (await req.json()) as Record<string, unknown>;
    const input = parseVentaInput(data);
    const catalogo = await obtenerCatalogoPersonalVenta();
    const validationError = validateVentaInput(input);

    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const inventario = await prisma.inventarioSede.findFirst({
      where: {
        imei: input.serial,
        sedeId: user.sedeId,
      },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        estadoFinanciero: true,
        origen: true,
        estadoActual: true,
      },
    });

    if (!inventario) {
      return NextResponse.json(
        { error: "IMEI no registra en el inventario de tu sede" },
        { status: 404 }
      );
    }

    const estadoActual = String(inventario.estadoActual ?? "").trim().toUpperCase();

    if (estadoActual && estadoActual !== "BODEGA") {
      return NextResponse.json(
        { error: `No se puede vender. Estado actual: ${inventario.estadoActual}` },
        { status: 400 }
      );
    }

    const yaVendido = await prisma.venta.findFirst({
      where: {
        serial: input.serial,
        inventarioSedeId: inventario.id,
      },
      select: { id: true },
    });

    if (yaVendido) {
      return NextResponse.json(
        { error: "Ese IMEI ya tiene una venta registrada" },
        { status: 400 }
      );
    }

    const now = new Date();
    const idVenta = `VTA-${Date.now()}`;
    const calculo = buildVentaData(input, inventario.costo, catalogo.financieras);

    const venta = await prisma.$transaction(async (tx) => {
      const creada = await tx.venta.create({
        data: {
          idVenta,
          fecha: now,
          hora: now.toLocaleTimeString("es-CO", { hour12: false }),
          servicio: input.servicio,
          descripcion: input.descripcion || inventario.referencia,
          serial: input.serial,
          jalador: input.jalador,
          ingreso: calculo.totalIngresosNetos,
          ...calculo.payloadFinancieras,
          financierasDetalle: buildJsonFinancierasDetalle(calculo.detalleFinancieras),
          utilidad: calculo.utilidad,
          cerrador: input.cerrador,
          comision: input.comision,
          salida: input.salida,
          cajaOficina: calculo.cajaOficina,
          tipoIngreso: [input.tipoIngreso1, input.tipoIngreso2].filter(Boolean).join(" / ") || null,
          ingreso1: input.tipoIngreso1 || null,
          ingreso2: input.tipoIngreso2 || null,
          primerValor: calculo.ingreso1Neto,
          segundoValor: calculo.ingreso2Neto,
          usuarioId: user.id,
          sedeId: user.sedeId,
          inventarioSedeId: inventario.id,
        },
        select: {
          id: true,
          idVenta: true,
        },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: inventario.imei,
          tipoMovimiento: "VENTA",
          referencia: inventario.referencia,
          color: inventario.color || null,
          costo: inventario.costo,
          sedeId: user.sedeId,
          estadoFinanciero: inventario.estadoFinanciero,
          origen: inventario.origen,
          observacion: `Venta registrada ${creada.idVenta} desde formulario web`,
        },
      });

      await tx.inventarioSede.update({
        where: { id: inventario.id },
        data: {
          estadoAnterior: inventario.estadoActual,
          estadoActual: "VENDIDO",
          fechaMovimiento: now,
          observacion: "VENTA REGISTRADA DESDE FORMULARIO WEB",
          origen: "VENTA",
        },
      });

      return creada;
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Venta registrada correctamente",
      venta,
    });
  } catch (error) {
    console.error("ERROR POST VENTAS:", error);
    return NextResponse.json({ error: "Error guardando venta" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireSessionUser();

    if (!session.ok) {
      return session.response;
    }

    const user = session.user;

    if (!isAdminRole(user.rolNombre)) {
      return NextResponse.json(
        { error: "Solo el administrador puede editar ventas" },
        { status: 403 }
      );
    }

    const data = (await req.json()) as Record<string, unknown>;
    const ventaId = Number(data.id);

    if (!Number.isInteger(ventaId) || ventaId <= 0) {
      return NextResponse.json({ error: "La venta no es valida" }, { status: 400 });
    }

    const ventaActual = await getVentaById(ventaId);

    if (!ventaActual) {
      return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
    }

    if (!ventaActual.inventarioSede) {
      return NextResponse.json(
        { error: "La venta no tiene inventario asociado para recalcularse" },
        { status: 400 }
      );
    }

    const input = parseVentaInput({
      ...data,
      serial: ventaActual.serial,
    });
    const catalogo = await obtenerCatalogoPersonalVenta();
    const validationError = validateVentaInput(input, { requireSerial: false });

    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const calculo = buildVentaData(
      input,
      ventaActual.inventarioSede.costo,
      catalogo.financieras
    );

    await prisma.$transaction(async (tx) => {
      await tx.venta.update({
        where: { id: ventaId },
        data: {
          servicio: input.servicio,
          descripcion: input.descripcion || ventaActual.inventarioSede?.referencia || ventaActual.descripcion,
          jalador: input.jalador,
          cerrador: input.cerrador,
          ingreso: calculo.totalIngresosNetos,
          ...calculo.payloadFinancieras,
          financierasDetalle: buildJsonFinancierasDetalle(calculo.detalleFinancieras),
          utilidad: calculo.utilidad,
          comision: input.comision,
          salida: input.salida,
          cajaOficina: calculo.cajaOficina,
          tipoIngreso: [input.tipoIngreso1, input.tipoIngreso2].filter(Boolean).join(" / ") || null,
          ingreso1: input.tipoIngreso1 || null,
          ingreso2: input.tipoIngreso2 || null,
          primerValor: calculo.ingreso1Neto,
          segundoValor: calculo.ingreso2Neto,
        },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: ventaActual.serial,
          tipoMovimiento: "VENTA_EDITADA",
          referencia:
            ventaActual.inventarioSede?.referencia || ventaActual.descripcion || "VENTA",
          color: ventaActual.inventarioSede?.color || null,
          costo: ventaActual.inventarioSede?.costo || 0,
          sedeId: ventaActual.sedeId,
          estadoFinanciero: ventaActual.inventarioSede?.estadoFinanciero || null,
          origen: ventaActual.inventarioSede?.origen || "VENTA",
          observacion: `Venta ${ventaActual.idVenta} editada por ${user.nombre}`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Venta actualizada correctamente",
    });
  } catch (error) {
    console.error("ERROR PUT VENTAS:", error);
    return NextResponse.json({ error: "Error actualizando venta" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireSessionUser();

    if (!session.ok) {
      return session.response;
    }

    const user = session.user;

    if (!isAdminRole(user.rolNombre)) {
      return NextResponse.json(
        { error: "Solo el administrador puede eliminar ventas" },
        { status: 403 }
      );
    }

    const requestUrl = new URL(req.url);
    const ventaId = Number(requestUrl.searchParams.get("id"));

    if (!Number.isInteger(ventaId) || ventaId <= 0) {
      return NextResponse.json({ error: "La venta no es valida" }, { status: 400 });
    }

    const ventaActual = await getVentaById(ventaId);

    if (!ventaActual) {
      return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.venta.delete({
        where: { id: ventaId },
      });

      if (ventaActual.inventarioSede) {
        await tx.inventarioSede.update({
          where: { id: ventaActual.inventarioSede.id },
          data: {
            estadoAnterior: ventaActual.inventarioSede.estadoActual || "VENDIDO",
            estadoActual: "BODEGA",
            fechaMovimiento: now,
            observacion: `VENTA ${ventaActual.idVenta} eliminada por administrador`,
            origen: "VENTA ELIMINADA",
          },
        });
      }

      await tx.movimientoInventario.create({
        data: {
          imei: ventaActual.serial,
          tipoMovimiento: "VENTA_ELIMINADA",
          referencia:
            ventaActual.inventarioSede?.referencia || ventaActual.descripcion || "VENTA",
          color: ventaActual.inventarioSede?.color || null,
          costo: ventaActual.inventarioSede?.costo || 0,
          sedeId: ventaActual.sedeId,
          estadoFinanciero: ventaActual.inventarioSede?.estadoFinanciero || null,
          origen: ventaActual.inventarioSede?.origen || "VENTA",
          observacion: `Venta ${ventaActual.idVenta} eliminada por ${user.nombre}`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Venta eliminada correctamente",
    });
  } catch (error) {
    console.error("ERROR DELETE VENTAS:", error);
    return NextResponse.json({ error: "Error eliminando venta" }, { status: 500 });
  }
}
