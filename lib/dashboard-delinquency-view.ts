import ExcelJS from "exceljs";
import type { AdminDashboardDelinquencyDetail, AdminDashboardDelinquencyGroup } from "@/lib/dashboard-delinquency";

export type DashboardDelinquencyGroupView = {
  key: string;
  name: string;
  context: string | null;
  unassigned: boolean;
  activeCredits: number;
  overdueCredits: number;
  overdueSharePercent: number;
  overduePortfolioPercent: number;
  overdueBalance?: number;
};

export type DashboardDelinquencyView = {
  activeCredits: number;
  overdueCredits: number;
  overduePortfolioPercent: number;
  overdueBalance?: number;
  leadingSiteKeys: string[];
  leadingSellerKeys: string[];
  sites: DashboardDelinquencyGroupView[];
  sellers: DashboardDelinquencyGroupView[];
};

export type DashboardDelinquencyCreditView = {
  id: number;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string | null;
  sedeKey: string;
  sedeNombre: string;
  sellerKey: string;
  sellerNombre: string;
  aliadoNombre: string | null;
  diasMora: number;
};

type DelinquencyViewOptions = {
  /** Server-side permission derived from the authenticated user's session. */
  viewingCentral?: boolean;
};

function projectGroup(group: AdminDashboardDelinquencyGroup, viewingCentral: boolean): DashboardDelinquencyGroupView {
  return {
    key: group.key,
    name: group.name,
    context: group.context,
    unassigned: group.unassigned,
    activeCredits: group.activeCredits,
    overdueCredits: group.overdueCredits,
    overdueSharePercent: group.overdueSharePercent,
    overduePortfolioPercent: group.overduePortfolioPercent,
    ...(viewingCentral ? { overdueBalance: group.overdueBalance } : {}),
  };
}

function leadingKeys(groups: AdminDashboardDelinquencyGroup[]) {
  const assigned = groups.filter((group) => !group.unassigned && group.overdueCredits > 0);
  const maximum = assigned.reduce((max, group) => Math.max(max, group.overdueBalance), 0);
  return assigned.filter((group) => group.overdueBalance === maximum).map((group) => group.key);
}

/** Whitelist the RSC/export payload before it can reach an allied browser.
 * Preserve the balance-based ranking without exposing the underlying amounts. */
export function projectDashboardDelinquency(
  detail: AdminDashboardDelinquencyDetail,
  { viewingCentral = false }: DelinquencyViewOptions = {},
): DashboardDelinquencyView {
  return {
    activeCredits: detail.activeCredits,
    overdueCredits: detail.overdueCredits,
    overduePortfolioPercent: detail.overduePortfolioPercent,
    ...(viewingCentral ? { overdueBalance: detail.overdueBalance } : {}),
    leadingSiteKeys: leadingKeys(detail.sites),
    leadingSellerKeys: leadingKeys(detail.sellers),
    sites: detail.sites.map((group) => projectGroup(group, viewingCentral)),
    sellers: detail.sellers.map((group) => projectGroup(group, viewingCentral)),
  };
}

export function projectDashboardDelinquencyCredits(credits: DashboardDelinquencyCreditView[]): DashboardDelinquencyCreditView[] {
  return credits.map((credit) => ({
    id: credit.id,
    folio: credit.folio,
    clienteNombre: credit.clienteNombre,
    clienteDocumento: credit.clienteDocumento,
    sedeKey: credit.sedeKey,
    sedeNombre: credit.sedeNombre,
    sellerKey: credit.sellerKey,
    sellerNombre: credit.sellerNombre,
    aliadoNombre: credit.aliadoNombre,
    diasMora: credit.diasMora,
  }));
}

function formatSheet(sheet: ExcelJS.Worksheet, numericColumns: number[], percentColumns: number[], moneyColumns: number[]) {
  for (const [index, column] of sheet.columns.entries()) {
    const number = index + 1;
    column.numFmt = percentColumns.includes(number) ? "0.0%"
      : moneyColumns.includes(number) ? '"$" #,##0'
      : numericColumns.includes(number) ? "0" : "@";
    column.font = { name: "Calibri", size: 11, color: { argb: "FF151A21" } };
    column.alignment = {
      vertical: "middle",
      horizontal: numericColumns.includes(number) ? "right" : "left",
      wrapText: true,
    };
  }

  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    row.height = 30;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = {
        type: "pattern", pattern: "solid",
        fgColor: { argb: index % 2 === 0 ? "FFFFFFFF" : "FFF5F6F4" },
      };
      cell.border = { bottom: { style: "hair", color: { argb: "FFD8DEE5" } } };
    });
  }

  const header = sheet.getRow(1);
  header.height = 34;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF151A21" } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount },
  };
}

function addGroupsSheet(workbook: ExcelJS.Workbook, name: string, heading: string, groups: DashboardDelinquencyGroupView[], viewingCentral: boolean) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  sheet.columns = [
    { header: heading, width: 32 },
    { header: "Aliado", width: 32 },
    { header: "Créditos activos", width: 20 },
    { header: "Créditos en mora", width: 20 },
    { header: "Participación en la mora", width: 25 },
    { header: "Impacto en la cartera", width: 24 },
    ...(viewingCentral ? [{ header: "Saldo en mora", width: 22 }] : []),
  ];
  for (const group of groups) {
    // Use literal text cells, never formulas or hyperlinks from group names.
    sheet.addRow([
      group.name, group.context || "", group.activeCredits, group.overdueCredits,
      group.overdueSharePercent / 100, group.overduePortfolioPercent / 100,
      ...(viewingCentral ? [group.overdueBalance ?? null] : []),
    ]);
  }
  formatSheet(sheet, viewingCentral ? [3, 4, 5, 6, 7] : [3, 4, 5, 6], [5, 6], viewingCentral ? [7] : []);
}

/** Build aggregate-only XLSX. Allied exports omit monetary columns entirely,
 * even if a caller accidentally supplies an unredacted input object. */
export function buildDashboardDelinquencyWorkbook(
  detail: DashboardDelinquencyView,
  { viewingCentral = false }: DelinquencyViewOptions = {},
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FINSER PAY";
  workbook.subject = "Detalle de mora por sede y vendedor";
  const summary = workbook.addWorksheet("Resumen", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  summary.columns = [
    { header: "Créditos activos", width: 22 },
    { header: "Créditos en mora", width: 22 },
    { header: "Mora de la cartera", width: 25 },
    ...(viewingCentral ? [{ header: "Saldo en mora", width: 23 }] : []),
  ];
  summary.addRow([
    detail.activeCredits, detail.overdueCredits, detail.overduePortfolioPercent / 100,
    ...(viewingCentral ? [detail.overdueBalance ?? null] : []),
  ]);
  formatSheet(summary, viewingCentral ? [1, 2, 3, 4] : [1, 2, 3], [3], viewingCentral ? [4] : []);
  addGroupsSheet(workbook, "Sedes", "Sede", detail.sites, viewingCentral);
  addGroupsSheet(workbook, "Vendedores", "Vendedor", detail.sellers, viewingCentral);
  return workbook;
}

export async function exportDashboardDelinquencyWorkbook(
  detail: DashboardDelinquencyView,
  options: DelinquencyViewOptions = {},
) {
  const workbook = buildDashboardDelinquencyWorkbook(detail, options);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
