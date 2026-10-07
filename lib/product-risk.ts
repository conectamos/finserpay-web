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
    referencia: credit.referencia,
    tipo: credit.tipo,
    aliado: credit.aliado,
    sede: credit.sede,
    fecha: credit.fecha,
    activo: riskCreditActive(credit),
    dias: credit.dias,
    gestion: credit.gestion,
    gestionFecha: credit.gestionFecha,
    ...(viewingCentral ? { capital: credit.capital, saldo: credit.saldo, vencido: credit.vencido } : {}),
  }));
}
export function riskTone(percent: number) {
  return percent >= 8 ? "danger" : percent >= 5 ? "warning" : "positive";
}
export function riskCreditEligible(credit: { estado: string; montoCredito: number; contratoAceptadoAt: unknown; pagareAceptadoAt: unknown; fotoEntregaDataUrl: unknown; fotoRemisionDataUrl: unknown; pazYSalvoEmitidoAt: unknown; equalityService?: string | null; importOriginType?: string | null }) {
  const state = credit.estado.trim().toUpperCase();
  if (/ANUL|CANCEL|RECHAZ|NO_DESEMBOLS|PENDIENTE/.test(state) || credit.montoCredito <= 0) return false;
  // Historical portfolio imports intentionally have no digital signatures or
  // delivery photos. Require both persisted source markers, never free text.
  const importedPortfolio = credit.equalityService === "IMPORTACION_MASIVA" && credit.importOriginType === "IMPORTACION_MASIVA";
  // ENTREGABLE only means that the device is ready. Require recorded delivery,
  // a completed state, or settlement rather than treating readiness as disbursement.
  return importedPortfolio || Boolean(credit.pazYSalvoEmitidoAt) || Boolean(
    credit.contratoAceptadoAt && credit.pagareAceptadoAt &&
    (credit.fotoEntregaDataUrl || credit.fotoRemisionDataUrl || ["ENTREGADO", "FINALIZADO", "DESEMBOLSADO", "PAGADO"].includes(state))
  );
}
export function filterRiskCredits(credits: ProductRiskCredit[], f: ProductRiskFilters) {
  return credits.filter(c => (!f.desde || c.fecha >= f.desde) && (!f.hasta || c.fecha <= f.hasta)
    && (!f.marca || c.marca === f.marca) && (!f.referencia || c.referencia === f.referencia)
    && (!f.tipo || c.tipo === f.tipo) && (!f.aliado || c.aliado === f.aliado) && (!f.sede || c.sede === f.sede)
    && (!f.estado || (f.estado === "pagado" ? !riskCreditActive(c) : f.estado === "activo" ? riskCreditActive(c) : f.estado === "mora" ? c.dias > 0 : riskCreditActive(c) && c.dias === 0))
    && (!f.minDias || c.dias >= Number(f.minDias)) && (!f.maxDias || c.dias <= Number(f.maxDias)));
}
export function aggregateProductRisk(credits: ProductRiskCredit[]) {
  const groups = new Map<string, { key: string; marca: string; referencia: string; financiadas: number; activas: number; mora: number; porcentaje: number; capital: number; saldo: number; vencido: number; dias: number; ultima: string; credits: ProductRiskCredit[] }>();
  for (const c of credits) {
    const key = JSON.stringify([c.marca.trim().toLocaleUpperCase("es"), c.referencia.trim().toLocaleUpperCase("es"), c.tipo]);
    const row = groups.get(key) || { key, marca: c.marca, referencia: c.referencia, financiadas: 0, activas: 0, mora: 0, porcentaje: 0, capital: 0, saldo: 0, vencido: 0, dias: 0, ultima: "", credits: [] };
    row.financiadas++; row.activas += Number(riskCreditActive(c)); row.mora += Number(c.dias > 0 && riskCreditActive(c));
    row.capital += c.capital ?? 0; row.saldo += c.saldo ?? 0; row.vencido += c.vencido ?? 0;
    if (c.dias > 0 && riskCreditActive(c)) row.dias += c.dias;
    if (c.fecha > row.ultima) row.ultima = c.fecha;
    row.credits.push(c); groups.set(key, row);
  }
  return [...groups.values()].map(r => ({ ...r, porcentaje: r.mora / r.financiadas * 100, dias: r.mora ? r.dias / r.mora : 0 }));
}
