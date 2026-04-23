import { NextResponse } from "next/server";
import { requireFinancialAccess } from "@/lib/financial-access";
import prisma from "@/lib/prisma";
import {
  esDeudaEntreSedes,
  esDeudaProveedor,
  esEstadoDeuda,
  etiquetaSedeAcreedora,
  SEDE_BODEGA_ID,
} from "@/lib/prestamos";
import { extraerFinancierasDetalle } from "@/lib/ventas-financieras";

const CONCEPTO_GASTO_CARTERA = "GASTO CARTERA";

function n(v: unknown) {
  if (!v) return 0;

  if (typeof v === "object" && v !== null && "toNumber" in v) {
    return (v as { toNumber: () => number }).toNumber();
  }

  return Number(v || 0);
}

function agregarFinancieraNeta(
  mapa: Record<string, number>,
  nombre: string,
  valor: number
) {
  const valorNumero = n(valor);
  if (!valorNumero) return;

  if (!mapa[nombre]) {
    mapa[nombre] = 0;
  }

  mapa[nombre] += valorNumero;
}

export async function GET(req: Request) {
  try {
    const access = await requireFinancialAccess();

    if (!access.ok) {
      return access.response;
    }

    const { user, esAdmin } = access;

    const url = new URL(req.url);
    const sedeParam = url.searchParams.get("sedeId");

    let whereSede: { sedeId?: number } = {};

    if (esAdmin) {
      if (sedeParam && Number(sedeParam) > 0) {
        whereSede = { sedeId: Number(sedeParam) };
      }
    } else {
      whereSede = { sedeId: user.sedeId };
    }

    const sedeCoberturaId =
      esAdmin && sedeParam && Number(sedeParam) > 0
        ? Number(sedeParam)
        : esAdmin
          ? null
          : user.sedeId;

    const wherePrestamosPorCobrar = sedeCoberturaId
      ? {
          sedeOrigenId: sedeCoberturaId,
          estado: {
            in: ["APROBADO", "PAGO_PENDIENTE_APROBACION"],
          },
        }
      : {
          estado: {
            in: ["APROBADO", "PAGO_PENDIENTE_APROBACION"],
          },
        };

    const [
      ventas,
      movimientosCaja,
      inventarioSede,
      abonos,
      gastosCartera,
      prestamosActivosPorCobrar,
    ] =
      await Promise.all([
        prisma.venta.findMany({
          where: whereSede,
          select: {
            id: true,
            sedeId: true,
            cajaOficina: true,
            ingreso1: true,
            ingreso2: true,
            primerValor: true,
            segundoValor: true,
            financierasDetalle: true,
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
          },
        }),
        prisma.cajaMovimiento.findMany({
          where: {
            ...whereSede,
            NOT: {
              concepto: CONCEPTO_GASTO_CARTERA,
            },
          },
          select: {
            id: true,
            tipo: true,
            valor: true,
            sedeId: true,
          },
        }),
        prisma.inventarioSede.findMany({
          where: whereSede,
          select: {
            id: true,
            sedeId: true,
            costo: true,
            estadoActual: true,
            estadoFinanciero: true,
          },
        }),
        prisma.abonoFinanciero.findMany({
          where: whereSede,
          select: {
            tipo: true,
            entidad: true,
            valor: true,
          },
        }),
        prisma.gastoCartera.findMany({
          where: whereSede,
          select: {
            valor: true,
          },
        }),
        prisma.prestamoSede.findMany({
          where: wherePrestamosPorCobrar,
          select: {
            imei: true,
            costo: true,
            sedeOrigenId: true,
            sedeDestinoId: true,
          },
        }),
      ]);

    const inventarioDestinoPrestamos =
      prestamosActivosPorCobrar.length > 0
        ? await prisma.inventarioSede.findMany({
            where: {
              OR: prestamosActivosPorCobrar.map((prestamo) => ({
                imei: prestamo.imei,
                sedeId: prestamo.sedeDestinoId,
              })),
            },
            select: {
              imei: true,
              sedeId: true,
              deboA: true,
              estadoFinanciero: true,
            },
          })
        : [];

    let cajaGeneralVentas = 0;
    let transferenciasVentas = 0;

    const financieras: Record<string, number> = {};

    for (const venta of ventas) {
      cajaGeneralVentas += n(venta.cajaOficina);

      const ingreso1 = String(venta.ingreso1 || "").trim().toUpperCase();
      const ingreso2 = String(venta.ingreso2 || "").trim().toUpperCase();

      if (ingreso1 === "TRANSFERENCIA") {
        transferenciasVentas += n(venta.primerValor);
      }
      if (ingreso2 === "TRANSFERENCIA") {
        transferenciasVentas += n(venta.segundoValor);
      }

      const detalleFinancieras = extraerFinancierasDetalle(
        venta as Record<string, unknown>
      );

      for (const financiera of detalleFinancieras) {
        agregarFinancieraNeta(
          financieras,
          String(financiera.nombre || "").trim().toUpperCase(),
          n(financiera.valorNeto)
        );
      }
    }

    let abonosTransferencia = 0;
    const abonosFinancieras: Record<string, number> = {};

    for (const abono of abonos) {
      const tipo = String(abono.tipo || "").trim().toUpperCase();

      if (tipo === "TRANSFERENCIA") {
        abonosTransferencia += n(abono.valor);
      } else if (tipo === "FINANCIERA") {
        const entidad = String(abono.entidad || "").trim().toUpperCase();
        if (!abonosFinancieras[entidad]) {
          abonosFinancieras[entidad] = 0;
        }
        abonosFinancieras[entidad] += n(abono.valor);
      }
    }

    for (const [nombre, valorNeto] of Object.entries(financieras)) {
      const abonado = n(abonosFinancieras[nombre]);
      financieras[nombre] = valorNeto - abonado;
    }

    const ingresosCaja = movimientosCaja
      .filter((m) => String(m.tipo || "").trim().toUpperCase() === "INGRESO")
      .reduce((acc, m) => acc + n(m.valor), 0);

    const egresosCaja = movimientosCaja
      .filter((m) => String(m.tipo || "").trim().toUpperCase() === "EGRESO")
      .reduce((acc, m) => acc + n(m.valor), 0);

    const saldoCaja = ingresosCaja - egresosCaja;

    const deudaEquipos = inventarioSede
      .filter((i) => String(i.estadoFinanciero || "").trim().toUpperCase() === "DEUDA")
      .reduce((acc, i) => acc + n(i.costo), 0);

    const valorPendiente = inventarioSede
      .filter((i) => String(i.estadoActual || "").trim().toUpperCase() === "PENDIENTE")
      .reduce((acc, i) => acc + n(i.costo), 0);

    const valorGarantia = inventarioSede
      .filter((i) => String(i.estadoActual || "").trim().toUpperCase() === "GARANTIA")
      .reduce((acc, i) => acc + n(i.costo), 0);

    const valorBodega = inventarioSede
      .filter((i) => String(i.estadoActual || "").trim().toUpperCase() === "BODEGA")
      .reduce((acc, i) => acc + n(i.costo), 0);

    const totalGastosCartera = gastosCartera.reduce(
      (acc, item) => acc + n(item.valor),
      0
    );

    const inventarioPrestadoPorDestino = new Map(
      inventarioDestinoPrestamos.map((item) => [
        `${item.imei}:${item.sedeId}`,
        item,
      ])
    );

    const prestamosPorCobrar = prestamosActivosPorCobrar.reduce((acc, item) => {
      const inventarioDestino = inventarioPrestadoPorDestino.get(
        `${item.imei}:${item.sedeDestinoId}`
      );

      if (!inventarioDestino || !esEstadoDeuda(inventarioDestino.estadoFinanciero)) {
        return acc;
      }

      if (item.sedeOrigenId === SEDE_BODEGA_ID) {
        return esDeudaProveedor(inventarioDestino.deboA)
          ? acc + n(item.costo)
          : acc;
      }

      if (
        esDeudaEntreSedes(inventarioDestino.deboA) &&
        String(inventarioDestino.deboA || "").trim().toUpperCase() ===
          etiquetaSedeAcreedora(item.sedeOrigenId)
      ) {
        return acc + n(item.costo);
      }

      return acc;
    }, 0);

    return NextResponse.json({
      ok: true,
      resumen: {
        cajaGeneralVentas,
        saldoCaja,
        cajaDisponible: cajaGeneralVentas + saldoCaja,
        transferenciasVentas,
        abonosTransferencia,
        saldoTransferencias: transferenciasVentas - abonosTransferencia,
        deudaEquipos,
        financieras,
        valorPendiente,
        valorGarantia,
        valorBodega,
        totalGastosCartera,
        prestamosPorCobrar,
      },
    });
  } catch (error) {
    console.error("ERROR PANEL FINANCIERO:", error);
    return NextResponse.json(
      { error: "Error interno cargando panel financiero" },
      { status: 500 }
    );
  }
}
