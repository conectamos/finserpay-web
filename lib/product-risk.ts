export type ProductRiskCredit = {
  id: number; folio: string; cliente: string; marca: string; referencia: string;
  tipo: string; aliado: string; sede: string; fecha: string; capital?: number;
  saldo?: number; vencido?: number; activo?: boolean; dias: number; gestion: string | null;
  numeroCreditoVisible?: string; gestionFecha?: string | null;
};
export type ProductRiskFilters = { desde: string; hasta: string; marca: string; referencia: string; tipo: string; aliado: string; sede: string; estado: string; minDias: string; maxDias: string };
export const emptyProductRiskFilters: ProductRiskFilters = { desde: "", hasta: "", marca: "", referencia: "", tipo: "", aliado: "", sede: "", estado: "", minDias: "", maxDias: "" };
export function riskCreditActive(credit: ProductRiskCredit) {
  return credit.activo ?? ((credit.saldo ?? 0) > 0);
}

/** Whitelist the client report: allied accounts retain unit-based risk and
 * filters without receiving any monetary value in the serialized payload. */
export function projectProductRiskCredits(credits: ProductRiskCredit[], { viewingCentral = false }: { viewingCentral?: boolean } = {}): ProductRiskCredit[] {
  return credits.map(credit => ({
    id: credit.id,
    folio: credit.folio,
    numeroCreditoVisible: credit.numeroCreditoVisible,
    cliente: credit.cliente,
    marca: credit.marca,
    referencia: normalizeRiskReference(credit.referencia),
    tipo: credit.tipo,
    aliado: credit.aliado,
    sede: credit.sede,
    fecha: credit.fecha,
    activo: riskCreditActive(credit),
    dias: credit.dias,
    // Free text can contain overdue amounts; keep it in the central view.
    gestion: viewingCentral ? credit.gestion : null,
    gestionFecha: viewingCentral ? credit.gestionFecha : null,
    ...(viewingCentral ? { capital: credit.capital, saldo: credit.saldo, vencido: credit.vencido } : {}),
  }));
}
export function riskTone(percent: number) {
  return percent >= 8 ? "danger" : percent >= 5 ? "warning" : "positive";
}
/** Match the registered portfolio population: documentation does not remove a loan. */
export function riskCreditEligible(credit: { estado: string; montoCredito: number }) {
  const state = credit.estado.trim().toUpperCase();
  return credit.montoCredito > 0 && !["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(state);
}
export function filterRiskCredits(credits: ProductRiskCredit[], f: ProductRiskFilters) {
  return credits.filter(c => (!f.desde || c.fecha >= f.desde) && (!f.hasta || c.fecha <= f.hasta)
    && (!f.marca || c.marca === f.marca) && (!f.referencia || normalizeRiskReference(c.referencia) === normalizeRiskReference(f.referencia))
    && (!f.tipo || c.tipo === f.tipo) && (!f.aliado || c.aliado === f.aliado) && (!f.sede || c.sede === f.sede)
    && (!f.estado || (f.estado === "pagado" ? !riskCreditActive(c) : f.estado === "activo" ? riskCreditActive(c) : f.estado === "mora" ? c.dias > 0 : riskCreditActive(c) && c.dias === 0))
    && (!f.minDias || c.dias >= Number(f.minDias)) && (!f.maxDias || c.dias <= Number(f.maxDias)));
}
export function aggregateProductRisk(credits: ProductRiskCredit[]) {
  const groups = new Map<string, { key: string; marca: string; referencia: string; financiadas: number; activas: number; mora: number; porcentaje: number; capital: number; saldo: number; vencido: number; dias: number; ultima: string; credits: ProductRiskCredit[] }>();
  for (const c of credits) {
    const referencia = normalizeRiskReference(c.referencia);
    const key = JSON.stringify([referencia, c.tipo]);
    const row = groups.get(key) || { key, marca: c.marca, referencia, financiadas: 0, activas: 0, mora: 0, porcentaje: 0, capital: 0, saldo: 0, vencido: 0, dias: 0, ultima: "", credits: [] };
    row.financiadas++; row.activas += Number(riskCreditActive(c)); row.mora += Number(c.dias > 0 && riskCreditActive(c));
    row.capital += c.capital ?? 0; row.saldo += c.saldo ?? 0; row.vencido += c.vencido ?? 0;
    if (c.dias > 0 && riskCreditActive(c)) row.dias += c.dias;
    if (c.fecha > row.ultima) row.ultima = c.fecha;
    row.credits.push(c); groups.set(key, row);
  }
  return [...groups.values()].map(r => ({ ...r, porcentaje: r.mora / r.financiadas * 100, dias: r.mora ? r.dias / r.mora : 0 }));
}

export function summarizeProductRisk(credits: ProductRiskCredit[]) {
 const financiadas = credits.length;
 const mora = credits.filter(c => c.dias > 0 && riskCreditActive(c)).length;
 return { financiadas, mora, porcentaje: financiadas ? mora / financiadas * 100 : 0 };
}

/** Report classification follows the product description, including historical typos. */
export function classifyRiskProduct(equipment: { equipoMarca?: string | null; equipoModelo?: string | null; referenciaEquipo?: string | null }): "IPHONE" | "ANDROID" {
  const description = [equipment.equipoMarca, equipment.equipoModelo, equipment.referenciaEquipo].join(" ").toUpperCase();
  return /IPHONE|IPOHN/.test(description) ? "IPHONE" : "ANDROID";
}

/** A reference identifies the model, regardless of a missing or different brand label. */
export function normalizeRiskReference(reference: string): string {
  const normalized = reference.trim().toLocaleUpperCase("es").replace(/\s+/g, " ").replace(/(\d)\s+GB\b/g, "$1GB");
  // Keep the generation and variant; storage and color do not split iPhone models.
  const iphone = normalized.match(/\b(?:IPHONE|IPOHN)\s*(\d+[A-Z]?|SE(?:\s*\d+)?|XS|XR|X)\b(?:\s*(PRO\s*MAX|PRO|PLUS|MINI|MAX))?/);
  if (!iphone) return normalized;
  const variant = iphone[2]?.replace(/PRO\s*MAX/, "PRO MAX");
  return `IPHONE ${iphone[1]}${variant ? ` ${variant}` : ""}`;
}

/** Explicit report correction requested for the legacy DIRECTO credit. */
export function resolveRiskEquipment(equipment: { equipoMarca?: string | null; equipoModelo?: string | null; referenciaEquipo?: string | null }, displayNumber: string) {
  if (displayNumber.trim() === "0100000217") return { referencia: "IPHONE 13", tipo: "IPHONE" as const };
  return {
    referencia: normalizeRiskReference(equipment.equipoModelo?.trim() || equipment.referenciaEquipo?.trim() || "Sin referencia"),
    tipo: classifyRiskProduct(equipment),
  };
}
