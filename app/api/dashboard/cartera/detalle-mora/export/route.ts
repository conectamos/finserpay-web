import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { DelinquencyScopeError, resolveDelinquencyDetailScope } from "@/lib/delinquency-detail-access";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { exportDashboardDelinquencyWorkbook } from "@/lib/dashboard-delinquency-view";
import { getDelinquencyDetailData } from "@/app/dashboard/_lib/delinquency-detail-data";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    if (!isAdminRole(session.rolNombre)) return NextResponse.json({ error: "Solo el administrador puede descargar el detalle de mora" }, { status: 403 });
    const allies = isFinserPayCentralAlly(session.aliadoAccesoCodigo)
      ? await prisma.aliado.findMany({ select: { id: true, nombre: true, codigo: true }, orderBy: { nombre: "asc" } }) : [];
    const scope = resolveDelinquencyDetailScope(session, new URL(request.url).searchParams.get("aliadoId"), allies);
    await ensureCreditAbonoAuditColumns();
    const { detail } = await getDelinquencyDetailData(scope.aliadoId, scope.adminCentral);
    const workbook = await exportDashboardDelinquencyWorkbook(detail, { viewingCentral: scope.adminCentral });
    return new Response(new Uint8Array(workbook), { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="finserpay-detalle-mora.xlsx"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof DelinquencyScopeError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[delinquency-detail-export] No se pudo exportar el detalle", error instanceof Error ? error.name : "Error");
    return NextResponse.json({ error: "No se pudo exportar el detalle de mora. Intenta de nuevo." }, { status: 500 });
  }
}
