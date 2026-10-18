import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import { getEquipmentCatalog } from "@/lib/equipment-catalog";
import {
  buildEquipmentCatalogWorkbook,
  equipmentCatalogExportFilters,
  filterEquipmentCatalogExportItems,
} from "@/lib/equipment-catalog-excel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return Response.json({ error: "No autenticado" }, { status: 401, headers: privateHeaders });
    if (!isAdminRole(user.rolNombre)) {
      return Response.json({ error: "Solo los administradores pueden descargar el catálogo de equipos" }, { status: 403, headers: privateHeaders });
    }

    const centralAdmin = isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const filters = equipmentCatalogExportFilters(new URL(request.url).searchParams, centralAdmin);
    const items = await getEquipmentCatalog({ includeInactive: centralAdmin && filters.status !== "ACTIVOS" });
    const workbook = buildEquipmentCatalogWorkbook(filterEquipmentCatalogExportItems(items, filters));
    const bytes = await workbook.xlsx.writeBuffer();
    const filename = `catalogo-equipos-${filters.product.toLowerCase()}-${filters.status.toLowerCase()}.xlsx`;

    return new Response(new Uint8Array(bytes), {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("ERROR EXPORTANDO CATALOGO DE EQUIPOS:", error);
    return Response.json({ error: "No se pudo descargar el catálogo de equipos. Inténtalo nuevamente." }, { status: 500, headers: privateHeaders });
  }
}
