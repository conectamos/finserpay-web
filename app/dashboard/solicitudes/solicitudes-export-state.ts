export type ExportFilters = {
  period: "all" | "month" | "range";
  month: string;
  desde: string;
  hasta: string;
  aliadoIds: number[];
  sedeIds: number[];
  vendedorIds: number[];
  estado: string;
  q: string;
  plataforma: string;
};

export type ExportOption = { id: number; nombre: string };
export type ExportOptions = {
  aliados: ExportOption[];
  sedes: Array<ExportOption & { aliadoId: number }>;
  vendedores: Array<ExportOption & { sedeIds: number[] }>;
};

type AppliedWallFilters = {
  desde: string; hasta: string; aliadoId: string; sedeId: string; asesorId: string;
  estado: string; q: string; plataforma: string;
};

export function exportFiltersFromWall(applied: AppliedWallFilters, now = new Date()): ExportFilters {
  const parts = new Intl.DateTimeFormat("en", {
    year: "numeric", month: "2-digit", timeZone: "America/Bogota",
  }).formatToParts(now);
  const selectedId = (value: string) => /^\d+$/.test(value) && Number(value) > 0 ? [Number(value)] : [];
  return {
    period: applied.desde || applied.hasta ? "range" : "all",
    month: `${parts.find(part => part.type === "year")?.value}-${parts.find(part => part.type === "month")?.value}`,
    desde: applied.desde,
    hasta: applied.hasta,
    aliadoIds: selectedId(applied.aliadoId),
    sedeIds: selectedId(applied.sedeId),
    vendedorIds: selectedId(applied.asesorId),
    estado: applied.estado,
    q: applied.q,
    plataforma: applied.plataforma,
  };
}

export function visibleExportOptions(options: ExportOptions, filters: ExportFilters) {
  const sedes = options.sedes.filter(sede => !filters.aliadoIds.length || filters.aliadoIds.includes(sede.aliadoId));
  const sedeIds = new Set(sedes.filter(sede => !filters.sedeIds.length || filters.sedeIds.includes(sede.id)).map(sede => sede.id));
  const vendedores = options.vendedores.filter(vendedor =>
    (!filters.aliadoIds.length && !filters.sedeIds.length) || vendedor.sedeIds.some(id => sedeIds.has(id))
  );
  return { ...options, sedes, vendedores };
}

export function changeExportSelection(
  current: ExportFilters,
  options: ExportOptions,
  key: "aliadoIds" | "sedeIds" | "vendedorIds",
  values: number[],
): ExportFilters {
  const next = { ...current, [key]: values };
  if (key === "aliadoIds") {
    const allowedSedes = new Set(visibleExportOptions(options, next).sedes.map(sede => sede.id));
    next.sedeIds = next.sedeIds.filter(id => allowedSedes.has(id));
  }
  if (key !== "vendedorIds") {
    const allowedVendors = new Set(visibleExportOptions(options, next).vendedores.map(vendedor => vendedor.id));
    next.vendedorIds = next.vendedorIds.filter(id => allowedVendors.has(id));
  }
  return next;
}
