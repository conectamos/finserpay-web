import prisma from "@/lib/prisma";
import { exportSadminCredits } from "@/lib/credit-sadmin";
import { buildSadminWorkbook } from "@/lib/credit-sadmin-excel";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import type { SadminStatusFilter } from "@/lib/credit-sadmin-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statusFilename: Record<SadminStatusFilter, string> = {
  all: "todos",
  pending: "pendientes",
  created: "creados",
};

let exportInProgress = false;

function colombiaDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function GET(request: Request) {
  try {
    const actor = await getApprovalActor();
    if (exportInProgress) {
      throw new CreditApprovalError(
        "SADMIN_EXPORT_BUSY",
        "Ya se está generando otra exportación de SADMIN. Espera a que termine e intenta de nuevo.",
        429,
      );
    }

    exportInProgress = true;
    try {
      const params = new URL(request.url).searchParams;
      const result = await exportSadminCredits(prisma, actor, {
        q: params.get("q"),
        status: params.get("status"),
      });
      const workbook = buildSadminWorkbook(result.items);
      const buffer = await workbook.xlsx.writeBuffer();
      const date = colombiaDate();
      const filename = `creacion-sadmin-${statusFilename[result.status]}-${date}.xlsx`;

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
