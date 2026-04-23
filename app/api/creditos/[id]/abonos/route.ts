import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import {
  creditCajaConcept,
  creditCajaDescription,
  normalizePaymentMethod,
  resolveCreditPaymentSummary,
  sanitizeText,
  toNumber,
} from "@/lib/credit-factory";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreditPaymentBody = {
  metodoPago?: string;
  observacion?: string;
  valor?: number | string;
};

function parseId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function serializePayment(item: any) {
  return {
    id: item.id,
    creditoId: item.creditoId,
    valor: Number(item.valor || 0),
    metodoPago: item.metodoPago,
    observacion: item.observacion,
    fechaAbono: item.fechaAbono.toISOString(),
    createdAt: item.createdAt.toISOString(),
    usuario: {
      id: item.vendedor?.id || item.usuario.id,
      nombre: item.vendedor?.nombre || item.usuario.nombre,
      usuario: item.vendedor?.documento || item.usuario.usuario,
    },
    vendedor: item.vendedor
      ? {
          id: item.vendedor.id,
          nombre: item.vendedor.nombre,
          documento: item.vendedor.documento,
        }
      : null,
    sede: {
      id: item.sede.id,
      nombre: item.sede.nombre,
    },
  };
}

async function loadCredit(creditId: number, admin: boolean, sedeId: number) {
  return prisma.credito.findFirst({
    where: admin ? { id: creditId } : { id: creditId, sedeId },
    select: {
      id: true,
      folio: true,
      clienteNombre: true,
      clienteDocumento: true,
      clienteTelefono: true,
      montoCredito: true,
      cuotaInicial: true,
      fechaProximoPago: true,
      referenciaPago: true,
      estado: true,
      sedeId: true,
    },
  });
}

async function loadPaymentSummary(creditId: number, montoCredito: number, cuotaInicial: number) {
  const grouped = await prisma.creditoAbono.groupBy({
    by: ["creditoId"],
    where: {
      creditoId: creditId,
    },
    _count: {
      _all: true,
    },
    _sum: {
      valor: true,
    },
    _max: {
      fechaAbono: true,
    },
  });

  const current = grouped[0];
  const paymentSummary = resolveCreditPaymentSummary({
    montoCredito,
    cuotaInicial,
    totalAbonado: Number(current?._sum.valor || 0),
    abonosCount: current?._count._all || 0,
  });

  return {
    ...paymentSummary,
    ultimoAbonoAt: current?._max.fechaAbono?.toISOString() || null,
  };
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const params = await context.params;
    const creditId = parseId(params.id);

    if (!creditId) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    if (!admin && sellerSession?.tipoPerfil !== "SUPERVISOR") {
      return NextResponse.json(
        { error: "Solo el supervisor o administrador puede consultar abonos" },
        { status: 403 }
      );
    }

    const credit = await loadCredit(creditId, admin, user.sedeId);

    if (!credit) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const items = await prisma.creditoAbono.findMany({
      where: {
        creditoId: credit.id,
      },
      include: {
        usuario: {
          select: {
            id: true,
            nombre: true,
            usuario: true,
          },
        },
        vendedor: {
          select: {
            id: true,
            nombre: true,
            documento: true,
          },
        },
        sede: {
          select: {
            id: true,
            nombre: true,
          },
        },
      },
      orderBy: {
        fechaAbono: "desc",
      },
      take: 50,
    });

    const summary = await loadPaymentSummary(
      credit.id,
      Number(credit.montoCredito || 0),
      Number(credit.cuotaInicial || 0)
    );

    return NextResponse.json({
      ok: true,
      credito: {
        ...credit,
        fechaProximoPago: credit.fechaProximoPago?.toISOString() || null,
        ...summary,
      },
      items: items.map(serializePayment),
    });
  } catch (error) {
    console.error("ERROR LISTANDO ABONOS DE CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudieron cargar los abonos del credito" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const params = await context.params;
    const creditId = parseId(params.id);

    if (!creditId) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    const credit = await loadCredit(creditId, admin, user.sedeId);

    if (!credit) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    if (!admin && sellerSession?.tipoPerfil !== "SUPERVISOR") {
      return NextResponse.json(
        { error: "Solo el supervisor o administrador puede registrar abonos" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as CreditPaymentBody;
    const valor = toNumber(body.valor);
    const metodoPago = normalizePaymentMethod(body.metodoPago);
    const observacion = sanitizeText(body.observacion);

    if (valor <= 0) {
      return NextResponse.json(
        { error: "Debes indicar un valor de abono mayor a 0" },
        { status: 400 }
      );
    }

    const currentSummary = await loadPaymentSummary(
      credit.id,
      Number(credit.montoCredito || 0),
      Number(credit.cuotaInicial || 0)
    );

    if (currentSummary.saldoPendiente <= 0) {
      return NextResponse.json(
        { error: "Este credito ya no tiene saldo pendiente" },
        { status: 400 }
      );
    }

    if (valor > currentSummary.saldoPendiente) {
      return NextResponse.json(
        {
          error: `El abono supera el saldo pendiente actual (${currentSummary.saldoPendiente.toLocaleString("es-CO")})`,
        },
        { status: 400 }
      );
    }

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.creditoAbono.create({
        data: {
          creditoId: credit.id,
          usuarioId: user.id,
          vendedorId: sellerSession?.id || null,
          sedeId: credit.sedeId,
          valor,
          metodoPago,
          observacion: observacion || null,
        },
        include: {
          usuario: {
            select: {
              id: true,
              nombre: true,
              usuario: true,
            },
          },
          vendedor: {
            select: {
              id: true,
              nombre: true,
              documento: true,
            },
          },
          sede: {
            select: {
              id: true,
              nombre: true,
            },
          },
        },
      });

      await tx.cajaMovimiento.create({
        data: {
          tipo: "INGRESO",
          concepto: creditCajaConcept(metodoPago),
          valor,
          descripcion: creditCajaDescription({
            id: created.id,
            creditoFolio: credit.folio,
            clienteNombre: credit.clienteNombre,
            metodoPago,
            observacion,
          }),
          sedeId: credit.sedeId,
        },
      });

      return created;
    });

    const summary = await loadPaymentSummary(
      credit.id,
      Number(credit.montoCredito || 0),
      Number(credit.cuotaInicial || 0)
    );

    return NextResponse.json({
      ok: true,
      message:
        summary.saldoPendiente <= 0
          ? "Abono registrado. El credito quedo sin saldo pendiente."
          : "Abono registrado correctamente.",
      item: serializePayment(payment),
      summary,
    });
  } catch (error) {
    console.error("ERROR REGISTRANDO ABONO DE CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudo registrar el abono del credito" },
      { status: 500 }
    );
  }
}
