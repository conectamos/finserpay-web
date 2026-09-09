import { createHash } from "node:crypto";
import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";

export function reissueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function reissueHash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
const text = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
function requiredNumber(value: unknown, min = 0) {
  const number = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(number) || number < min) throw new Error("FROZEN_TERMS_INCOMPLETE");
  return number;
}
function sameNumber(a: unknown, b: unknown) {
  if (Math.abs(requiredNumber(a) - requiredNumber(b)) > 0.011) throw new Error("FROZEN_TERMS_CHANGED");
}
/** Build only from the signed seal; never evaluate current policies or payment plans. */
export function frozenReissueCredit(credit: Record<string, unknown>, process: {
  draftPayload: unknown; draftFolio: string | null; createdAt: Date | string;
}) {
  const snapshot = reissueRecord(credit.contratoSnapshot);
  const financial = reissueRecord(snapshot.financiero);
  const draft = reissueRecord(process.draftPayload);
  const draftSeal = readFinancingTermsSeal(draft.financialTermsSeal);
  const creditSeal = readFinancingTermsSeal(financial.selloFinanciero);
  if (!draftSeal || !creditSeal || draftSeal.checksum !== creditSeal.checksum) throw new Error("FROZEN_TERMS_UNAVAILABLE");
  const terms = draftSeal.snapshot;
  if (!terms.folio || terms.folio !== credit.folio || process.draftFolio !== terms.folio
    || text(terms.documento) !== text(credit.clienteDocumento)
    || text(terms.clienteNombre) !== text(credit.clienteNombre)
    || text(terms.imei) !== text(credit.imei)
    || !terms.clienteTelefono || !terms.clienteDireccion
    || !terms.equipoMarca || !terms.equipoModelo
    || !["MENSUAL", "QUINCENAL", "SEMANAL"].includes(terms.frecuenciaPago)
    || !Number.isInteger(terms.numeroCuotas) || terms.numeroCuotas < 1
    || !terms.fechaPrimerPago || !Number.isFinite(new Date(terms.fechaPrimerPago).getTime())) throw new Error("FROZEN_TERMS_CHANGED");
  for (const [field, sealed] of [
    ["valorEquipoTotal", terms.valorVenta], ["cuotaInicial", terms.cuotaInicial],
    ["saldoBaseFinanciado", terms.valorFinanciado], ["montoCredito", terms.totalPagar],
    ["valorCuota", terms.cuotaTotalExacta],
    ["plazoMeses", terms.numeroCuotas], ["tasaInteresEa", terms.tasaInteresEa],
  ] as const) sameNumber(credit[field], sealed);
  for (const [field, sealed] of [
    ["cuotaComercial", terms.cuotaComercial], ["cuotaTotalExacta", terms.cuotaTotalExacta],
    ["fianzaCuotaPorcentaje", terms.fianzaCuotaPorcentaje], ["seguroCuotaPorcentaje", terms.seguroCuotaPorcentaje],
  ] as const) sameNumber(financial[field], sealed);
  for (const [field, sealed] of [
    ["clienteTelefono", terms.clienteTelefono], ["clienteCorreo", terms.clienteCorreo],
    ["clienteDireccion", terms.clienteDireccion], ["equipoMarca", terms.equipoMarca],
    ["equipoModelo", terms.equipoModelo], ["frecuenciaPago", terms.frecuenciaPago],
  ] as const) if (text(credit[field]) !== text(sealed)) throw new Error("FROZEN_TERMS_CHANGED");
  if (requiredNumber(terms.valorVenta) <= requiredNumber(terms.cuotaInicial)) throw new Error("FROZEN_TERMS_INCOMPLETE");
  const date = new Date(process.createdAt);
  if (!Number.isFinite(date.getTime())) throw new Error("FROZEN_TERMS_INCOMPLETE");
  const frozen: CreditForFirmaSeguroPdf = {
    folio: terms.folio, clienteTipoDocumento: terms.tipoDocumento, clienteNombre: terms.clienteNombre,
    clienteDocumento: terms.documento, clienteTelefono: terms.clienteTelefono,
    clienteCorreo: terms.clienteCorreo, clienteDireccion: terms.clienteDireccion,
    referenciaEquipo: terms.referenciaEquipo, equipoMarca: terms.equipoMarca, equipoModelo: terms.equipoModelo,
    imei: terms.imei, deviceUid: terms.imei, valorEquipoTotal: requiredNumber(terms.valorVenta),
    montoCredito: Math.round(requiredNumber(terms.totalPagar) * 100) / 100, cuotaInicial: requiredNumber(terms.cuotaInicial),
    valorCuota: requiredNumber(terms.cuotaTotalExacta), valorCuotaComercial: requiredNumber(terms.cuotaComercial),
    tasaInteresEa: requiredNumber(terms.tasaInteresEa), tasaPeriodo: requiredNumber(terms.tasaPeriodo),
    fianzaCuotaPorcentaje: requiredNumber(terms.fianzaCuotaPorcentaje),
    fianzaTotalPorcentaje: requiredNumber(terms.fianzaTotalPorcentaje), fianzaModalidad: terms.fianzaModalidad,
    seguroCuotaPorcentaje: requiredNumber(terms.seguroCuotaPorcentaje),
    redondeoComercialModo: terms.redondeoComercialModo, redondeoComercialMultiplo: terms.redondeoComercialMultiplo,
    plazoMeses: terms.numeroCuotas, frecuenciaPago: terms.frecuenciaPago, fechaCredito: date.toISOString(),
    fechaPrimerPago: terms.fechaPrimerPago, usuario: { nombre: "FINSER PAY" }, sede: { nombre: "FINSER PAY" },
  };
  return { credit: frozen, termsHash: draftSeal.checksum };
}
