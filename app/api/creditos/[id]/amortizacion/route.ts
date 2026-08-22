import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  buildCreditAccessWhere,
  buildCreditLookupWhere,
  parseCreditRouteLookup,
} from "@/lib/credit-route-lookup";
import { getCreditAmortizationByCreditId } from "@/lib/credit-amortization-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const supervisor = sellerSession?.tipoPerfil === "SUPERVISOR";

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditLookup = parseCreditRouteLookup(params.id);

    if (!creditLookup.id && !creditLookup.folio) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    const credit = await prisma.credito.findFirst({
      where: {
        AND: [
          buildCreditLookupWhere(creditLookup),
          buildCreditAccessWhere({
            admin,
            adminCentral,
            aliadoId: user.aliadoAccesoId,
            sedeId: user.sedeId,
            sellerSedeId: sellerSession?.sedeId,
            supervisor,
          }),
        ],
      },
      select: { id: true, folio: true },
    });

    if (!credit) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const amortization = await getCreditAmortizationByCreditId(credit.id);

    if (!amortization) {
      return NextResponse.json(
        {
          code: "LEGACY_CREDIT_WITHOUT_AMORTIZATION",
          error: "Este credito historico no tiene una tabla francesa persistida.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      credit: { id: credit.id, folio: credit.folio },
      amortization,
    });
  } catch (error) {
    console.error("ERROR CONSULTANDO AMORTIZACION:", error);
    return NextResponse.json(
      { error: "No se pudo consultar la tabla de amortizacion" },
      { status: 500 }
    );
  }
}
