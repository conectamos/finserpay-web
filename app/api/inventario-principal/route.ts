import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

export async function GET() {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const esAdmin = user.rolNombre?.toUpperCase() === "ADMIN";

    if (!esAdmin) {
      return NextResponse.json(
        { error: "No autorizado" },
        { status: 403 }
      );
    }

const inventario = await prisma.inventarioPrincipal.findMany({
      orderBy: { id: "desc" },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        numeroFactura: true,
        distribuidor: true,

        // 🔥 IMPORTANTE
        estado: true,
        sedeDestinoId: true,
        estadoCobro: true,
      },
    });

    return NextResponse.json(inventario);
  } catch (error) {
    console.error("ERROR GET INVENTARIO PRINCIPAL:", error);

    return NextResponse.json(
      { error: "Error cargando inventario principal" },
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

    const esAdmin = user.rolNombre?.toUpperCase() === "ADMIN";

    if (!esAdmin) {
      return NextResponse.json(
        { error: "No autorizado" },
        { status: 403 }
      );
    }

    const body = await req.json();

    const referencia = String(body.referencia ?? "").trim();
    const color = String(body.color ?? "").trim();
    const costo = Number(body.costo ?? 0);
    const numeroFactura = String(body.numeroFactura ?? "").trim();
    const distribuidor = String(body.distribuidor ?? "").trim();

    const imeisRaw = Array.isArray(body.imeis)
      ? body.imeis
      : body.imei
      ? [body.imei]
      : [];

const imeisRawTyped = imeisRaw as unknown[];

const imeis: string[] = imeisRawTyped
  .map((item: unknown) =>
    String(item ?? "").replace(/\D/g, "").trim()
  )
  .filter((item: string) => item.length > 0);
  

    if (imeis.length === 0) {
      return NextResponse.json(
        { error: "Debes ingresar al menos un IMEI" },
        { status: 400 }
      );
    }

    const imeiLargoInvalido = imeis.find((item) => item.length > 15);
    if (imeiLargoInvalido) {
      return NextResponse.json(
        { error: "Hay IMEIs con más de 15 dígitos" },
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

    if (!numeroFactura) {
      return NextResponse.json(
        { error: "El número de factura es obligatorio" },
        { status: 400 }
      );
    }

    if (!distribuidor) {
      return NextResponse.json(
        { error: "El distribuidor es obligatorio" },
        { status: 400 }
      );
    }

    const imeisUnicos = [...new Set(imeis)];

    const existentesEnPrincipal = await prisma.inventarioPrincipal.findMany({
      where: {
        imei: { in: imeisUnicos },
      },
      select: { imei: true },
    });

    const existentesEnSede = await prisma.inventarioSede.findMany({
      where: {
        imei: { in: imeisUnicos },
      },
      select: { imei: true },
    });

    const imeisExistentes = new Set<string>([
      ...existentesEnPrincipal.map((item) => item.imei),
      ...existentesEnSede.map((item) => item.imei),
    ]);

    const imeisParaInsertar = imeisUnicos.filter(
      (item) => !imeisExistentes.has(item)
    );

    if (imeisParaInsertar.length === 0) {
      return NextResponse.json(
        { error: "Todos los IMEIs ya existen en el sistema" },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.inventarioPrincipal.createMany({
        data: imeisParaInsertar.map((item: string) => ({
          imei: item,
          referencia,
          color: color || null,
          costo,
          numeroFactura,
          distribuidor,
        })),
      });

      await tx.movimientoInventario.createMany({
        data: imeisParaInsertar.map((item: string) => ({
          imei: item,
          tipoMovimiento: "INGRESO_PRINCIPAL",
          referencia,
          color: color || null,
          costo,
          origen: "PRINCIPAL",
          observacion: `Ingreso a bodega principal. Factura: ${numeroFactura}. Distribuidor: ${distribuidor}`,
        })),
      });
    });

    return NextResponse.json({
      ok: true,
      insertados: imeisParaInsertar.length,
      omitidos: imeisUnicos.length - imeisParaInsertar.length,
      imeisOmitidos: imeisUnicos.filter((item: string) => imeisExistentes.has(item)),
    });
  } catch (error) {
    console.error("ERROR POST INVENTARIO PRINCIPAL:", error);
    return NextResponse.json(
      { error: "Error interno al guardar en inventario principal" },
      { status: 500 }
    );
  }
}