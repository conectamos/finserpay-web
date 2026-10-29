import { getMoraActor } from "@/lib/analyst-mora-access";
import { exportMoraPortfolio } from "@/lib/analyst-mora-management";
import { buildMoraPortfolioWorkbook } from "@/lib/analyst-mora-excel";
import { colombiaDateKey } from "@/lib/colombia-date";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const filterKeys = ["q", "ally", "responsible", "minDays", "maxDays", "status", "followUp"] as const;
let exportInProgress = false;

export async function GET(request: Request) {
  try {
    // Keep exactly the same access policy as the overdue portfolio screen.
    await getMoraActor();
    if (exportInProgress) {
      throw new CreditApprovalError(
        "MORA_EXPORT_BUSY",
        "Ya se está generando otra exportación de cartera en mora. Espera a que termine e intenta de nuevo.",
        429,
      );
    }

    exportInProgress = true;
    try {
      const now = new Date();
      const params = new URL(request.url).searchParams;
      const result = await exportMoraPortfolio(params, now);
      const filters: Partial<Record<typeof filterKeys[number], string>> = {};
      for (const key of filterKeys) {
        const value = params.get(key)?.trim();
        if (value) filters[key] = value;
      }
      const workbook = buildMoraPortfolioWorkbook(result.items, { generatedAt: now, filters });
      const buffer = await workbook.xlsx.writeBuffer();
      const filename = `cartera-mora-${colombiaDateKey(now)}.xlsx`;

      return new Response(new Uint8Array(buffer), {
        headers: {
          ...approvalPrivateHeaders,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
    } finally {
      exportInProgress = false;
    }
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
