import { NextResponse } from "next/server";
import { getCreditDisplayNumbers, withCreditDisplayNumber } from "@/lib/credit-display-number-server";
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
import { ensureCreditPlanRevisionSchema, getLatestCreditPlanAmortization } from "@/lib/credit-plan-revision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
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

    const originalAmortization = await getCreditAmortizationByCreditId(credit.id);
    const showOriginal = new URL(req.url).searchParams.get("original") === "1";
    if (originalAmortization && !showOriginal) await ensureCreditPlanRevisionSchema();
    const revisedAmortization = originalAmortization && !showOriginal
      ? await getLatestCreditPlanAmortization(credit.id) : null;
    const amortization = revisedAmortization || originalAmortization;

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
      credit: withCreditDisplayNumber(credit, await getCreditDisplayNumbers([credit.id])),
      amortization,
      source: revisedAmortization ? "ADMINISTRATIVE_REVISION" : "ORIGINAL",
      originalChecksum: originalAmortization?.checksum,
    });
  } catch (error) {
    console.error("ERROR CONSULTANDO AMORTIZACION:", error);
    return NextResponse.json(
      { error: "No se pudo consultar la tabla de amortizacion" },
      { status: 500 }
    );
  }
}
