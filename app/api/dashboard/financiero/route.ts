import { NextResponse } from "next/server";
import { requireFinancialAccess } from "@/lib/financial-access";
import prisma from "@/lib/prisma";

const CONCEPTO_GASTO_CARTERA = "GASTO CARTERA";

export async function GET() {
  try {
    const access = await requireFinancialAccess();

    if (!access.ok) {
      return access.response;
    }

    const { user, esAdmin } = access;

    // =========================
    // 1) MOVIMIENTOS DE CAJA
    // =========================
    const movimientosCaja = await prisma.cajaMovimiento.findMany({
      where: esAdmin
        ? { NOT: { concepto: CONCEPTO_GASTO_CARTERA } }
        : { sedeId: user.sedeId, NOT: { concepto: CONCEPTO_GASTO_CARTERA } },
      select: {
        tipo: true,
        valor: true,
      },
    });

    let ingresosCaja = 0;
    let egresosCaja = 0;

    movimientosCaja.forEach((mov) => {
      const valor = Number(mov.valor || 0);

      if (String(mov.tipo).toUpperCase() === "INGRESO") {
        ingresosCaja += valor;
      }

      if (String(mov.tipo).toUpperCase() === "EGRESO") {
        egresosCaja += valor;
      }
    });

    // =========================
    // 2) VENTAS
    // =========================
    const ventas = await prisma.venta.findMany({
      where: esAdmin ? {} : { sedeId: user.sedeId },
      select: {
        ingreso: true,
        comision: true,
        salida: true,
        cajaOficina: true,
      },
    });

    let ingresosVentas = 0;
    let egresosVentas = 0;
    let cajaVentas = 0;

    ventas.forEach((venta) => {
      ingresosVentas += Number(venta.ingreso || 0);
      egresosVentas += Number(venta.comision || 0) + Number(venta.salida || 0);
      cajaVentas += Number(venta.cajaOficina || 0);
    });

    // =========================
    // 3) DEUDA ENTRE SEDES
    // =========================
    const deudas = await prisma.inventarioSede.findMany({
      where: {
        estadoFinanciero: "DEUDA",
        ...(esAdmin ? {} : { sedeId: user.sedeId }),
      },
      select: {
        costo: true,
      },
    });

    let totalDeuda = 0;

    deudas.forEach((item) => {
      totalDeuda += Number(item.costo || 0);
    });

    // =========================
    // 4) TOTALES FINALES
    // =========================
    const ingresos = ingresosCaja + ingresosVentas;
    const egresos = egresosCaja + egresosVentas;

    // Caja actual real del negocio:
    // ventas.cajaOficina + ingresos manuales - egresos manuales
    const saldo = cajaVentas + ingresosCaja - egresosCaja;

    return NextResponse.json({
      ingresos,
      egresos,
      saldo,
      deuda: totalDeuda,

      // extras útiles por si luego quieres mostrarlos
      detalle: {
        ingresosCaja,
        egresosCaja,
        ingresosVentas,
        egresosVentas,
        cajaVentas,
      },
    });
  } catch (error) {
    console.error("ERROR DASHBOARD FINANCIERO:", error);
    return NextResponse.json(
      { error: "Error cargando dashboard financiero" },
      { status: 500 }
    );
  }
}
