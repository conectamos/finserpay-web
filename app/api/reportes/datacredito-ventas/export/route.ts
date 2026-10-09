import { NextResponse } from "next/server";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getDataCreditoRetentionDays } from "@/lib/datacredito/storage";
import { getDataCreditoQuerySalesReport, DataCreditoQuerySalesReportInputError } from "@/lib/datacredito/admin-query-sales-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
export async function POST(request: Request) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) return NextResponse.json({error: "Acceso exclusivo del administrador central"},{status:access.status,headers});
  try {
    const input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input) || !["xlsx","pdf"].includes(input.format)) return NextResponse.json({error:"Selecciona Excel o PDF"},{status:400,headers});
    const provider = getDataCreditoPublicConfig();
    const report = { ...await getDataCreditoQuerySalesReport(input,provider.environment), retentionDays:getDataCreditoRetentionDays(),providerEnvironment:provider.environment };
    // Recompute on the server. Never accept rows, counts or permissions from the browser.
    const { buildQueryReportExcel, buildQueryReportPdf } = await import("@/lib/datacredito/query-report-export");
    const buffer = input.format === "xlsx" ? await buildQueryReportExcel(report) : await buildQueryReportPdf(report);
    const end = new Date(new Date(report.period.endExclusive).getTime()-86400000).toISOString().slice(0,10);
    const filename = `FINSER_PAY_DataCredito_${report.filters.allyId ?? "todos"}_${report.period.start.slice(0,10)}_${end}.${input.format}`;
    return new Response(new Uint8Array(buffer),{ headers:{...headers,"Content-Type":input.format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf","Content-Disposition":`attachment; filename="${filename}"`} });
  } catch (error) {
    if (error instanceof DataCreditoQuerySalesReportInputError || error instanceof SyntaxError) return NextResponse.json({error:error.message},{status:400,headers});
    console.error("DATACREDITO_REPORT_EXPORT_FAILED",error);
    return NextResponse.json({error:"No se pudo exportar el informe. Inténtalo de nuevo."},{status:500,headers});
  }
}
