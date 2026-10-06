import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { getNominalApprovalAnalystSessionUser } from "@/lib/auth";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import { buildCreditApprovalQueueScopeSql } from "@/lib/credit-approval-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getNominalApprovalAnalystSessionUser();
    if (!user) throw new CreditApprovalError("AUTH_REQUIRED", "Inicia sesión con tu cuenta de analista.", 401);
    if ((await getApprovalSharedRequestActor()) !== undefined) {
      throw new CreditApprovalError("SHARED_ACCESS_FORBIDDEN", "Esta consulta requiere una cuenta nominal.", 403);
    }

    const rows = await prisma.$queryRawUnsafe<Array<{ nombre: string }>>(`SELECT MIN(BTRIM(ally."nombre")) AS "nombre"
      FROM "Credito" credit
      JOIN "Sede" site ON site."id"=credit."sedeId"
      JOIN "Aliado" ally ON ally."id"=site."aliadoId"
      WHERE ${buildCreditApprovalQueueScopeSql("credit")}
        AND UPPER(BTRIM(COALESCE(ally."codigo",'')))<>'FINSERPAY'
        AND UPPER(BTRIM(COALESCE(credit."estado",''))) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')
        AND NULLIF(BTRIM(ally."nombre"),'') IS NOT NULL
      GROUP BY LOWER(BTRIM(ally."nombre"))
      ORDER BY MIN(BTRIM(ally."nombre"))`);

    return NextResponse.json(
      { ok: true, items: rows.map((item) => item.nombre) },
      { headers: approvalPrivateHeaders },
    );
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
