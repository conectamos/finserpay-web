import ExcelJS from "exceljs";
import { isEquipmentCatalogItemAllowedForPlatform } from "@/lib/credit-factory";
import type { EquipmentCatalogItem } from "@/lib/equipment-catalog";

export type EquipmentCatalogExportFilters = {
  product: "ANDROID" | "IPHONE" | "TODOS";
  status: "ACTIVOS" | "RETIRADOS" | "TODOS";
  q: string;
};

function searchKey(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleUpperCase().replace(/\s+/g, " ").trim();
}

export function equipmentCatalogExportFilters(
  params: URLSearchParams,
  centralAdmin: boolean,
): EquipmentCatalogExportFilters {
  const product = params.get("product")?.trim().toUpperCase();
  const status = params.get("status")?.trim().toUpperCase();
  return {
    product: product === "ANDROID" || product === "IPHONE" ? product : "TODOS",
    status: centralAdmin && (status === "RETIRADOS" || status === "TODOS") ? status : "ACTIVOS",
    q: params.get("q") || "",
  };
}

export function filterEquipmentCatalogExportItems(
  items: EquipmentCatalogItem[],
  filters: EquipmentCatalogExportFilters,
) {
  const query = searchKey(filters.q);
  return items.filter(item => {
    if (filters.status === "ACTIVOS" && !item.activo) return false;
    if (filters.status === "RETIRADOS" && item.activo) return false;
    if (filters.product !== "TODOS" && !isEquipmentCatalogItemAllowedForPlatform(item, filters.product)) return false;
    return !query || searchKey(`${item.marca} ${item.modelo}`).includes(query);
  });
}

export function buildEquipmentCatalogWorkbook(items: EquipmentCatalogItem[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FINSER PAY";
  const sheet = workbook.addWorksheet("Catálogo de equipos", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  sheet.columns = [
    { header: "Producto", width: 16 },
    { header: "Marca", width: 22 },
    { header: "Modelo", width: 44 },
    { header: "Precio base de venta", width: 24 },
    { header: "Estado", width: 18 },
  ];
  sheet.columns.forEach((column, index) => {
    column.numFmt = index === 3 ? '[$$-es-CO] #,##0' : "@";
    column.font = { name: "Calibri", size: 11, color: { argb: "FF151A21" } };
    column.alignment = { vertical: "middle", horizontal: index === 3 ? "right" : "left", wrapText: true };
  });

  for (const item of items) {
    // Only literal strings and the numeric sale price are exported; never stored objects or private metadata.
    const row = sheet.addRow([
      isEquipmentCatalogItemAllowedForPlatform(item, "IPHONE") ? "IPHONE" : "ANDROID",
      String(item.marca),
      String(item.modelo),
      item.precioBaseVenta,
      item.activo ? "Activo" : "Retirado",
    ]);
    row.height = 32;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: row.number % 2 === 0 ? "FFFFFFFF" : "FFF5F6F4" } };
      cell.border = { bottom: { style: "hair", color: { argb: "FFD8DEE5" } } };
    });
  }

  const header = sheet.getRow(1);
  header.height = 34;
  header.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF151A21" } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  sheet.autoFilter = `A1:E${sheet.rowCount}`;
  return workbook;
}
