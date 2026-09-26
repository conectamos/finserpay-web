import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { isMassImportedCredit } from "@/lib/credit-import-flags";
import {
  getCapitalOutstandingBalance,
  parseCapitalConciliation,
  parseCapitalPlanSnapshot,
  type CapitalConciliation,
} from "@/lib/credit-principal-payment";

export type PrincipalPaymentContextInput = {
  credit: {
    id: number;
    contratoSnapshot?: unknown;
    observacionAdmin?: string | null;
    equalityService?: string | null;
    amortizacion?: unknown;
    planCapitalVigente?: unknown;
    montoCredito: number;
    valorCuota: number;
    saldoBaseFinanciado: number;
    plazoMeses?: number | null;
    frecuenciaPago?: string | null;
  };
  plan: {
    installments: Array<{
      numero: number;
      fechaVencimiento: string;
      valorProgramado: number;
      valorAbonado: number;
      saldoPendiente: number;
    }>;
    totalPaid: number;
    saldoPendiente: number;
  };
};

export type PrincipalPaymentContext = {
  modoConciliacion: "AUTOMATICA" | "MANUAL" | "VIGENTE";
  requiereConciliacion: boolean;
  motivoConciliacion: string | null;
  capitalPendiente: number | null;
  conciliacion: CapitalConciliation | null;
};

function manual(reason: string): PrincipalPaymentContext {
  return { modoConciliacion: "MANUAL", requiereConciliacion: true,
    motivoConciliacion: reason, capitalPendiente: null, conciliacion: null };
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function amount(value: unknown) {
  if (value === null || value === undefined || typeof value === "boolean" ||
      (typeof value === "string" && !value.trim())) throw new Error("Missing amount");
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1e12) throw new Error("Invalid amount");
  return number;
}
function cents(value: number) { return Math.round(value * 100); }
function money(value: number) { return cents(value) / 100; }
function same(left: number, right: number, tolerance = 0.00001) {
  return Math.abs(left - right) <= tolerance;
}
function dateKey(value: unknown) {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("Invalid date");
  }
  return date;
}
function check(condition: boolean) {
  if (!condition) throw new Error("Unreconciled source");
}

/** Server-owned persisted terms only. A missing/ambiguous source never becomes an estimate. */
export function resolvePrincipalPaymentContext(input: PrincipalPaymentContextInput): PrincipalPaymentContext {
  const { credit, plan } = input;
  // Revised plans are already reconciled, including imported credits. Invalid snapshots fail closed.
  const vigente = parseCapitalPlanSnapshot(credit.planCapitalVigente);
  if (vigente) {
    const capitalPendiente = getCapitalOutstandingBalance(vigente, plan.totalPaid)!.saldoCapital;
    const next = plan.installments.find(row => row.saldoPendiente > 0);
    return { modoConciliacion: "VIGENTE", requiereConciliacion: false, motivoConciliacion: null,
      capitalPendiente, conciliacion: { ...vigente.parametros, capitalPendiente,
        numeroProximaCuota: next?.numero ?? vigente.parametros.numeroProximaCuota } };
  }
  if (isMassImportedCredit(credit)) {
    return manual("Este credito fue importado. El primer abono requiere verificar su capital y condiciones en el plan de origen.");
  }
  const header = object(credit.amortizacion);
  if (!header) return manual("El credito no conserva una tabla de amortizacion completa. Concilia sus condiciones historicas antes del primer abono.");
  try {
    const versions = ["FRANCES_V1", "ARES_FRANCES_V1", "ARES_FRANCES_V2"];
    const version = String(header.calculoVersion);
    const count = amount(header.numeroCuotas);
    const principal = amount(header.valorFinanciado);
    const rate = amount(header.tasaPeriodo);
    const fixedSurety = amount(header.cuotaFianzaExacta);
    const fixedInsurance = amount(header.cuotaSeguroExacta);
    const exactCredit = amount(header.cuotaCreditoExacta);
    const exactTotal = amount(header.cuotaTotalExacta);
    const total = amount(header.totalPagar);
    const amortizationId = amount(header.id);
    check(Number.isSafeInteger(amortizationId) && amortizationId > 0 && amount(header.creditoId) === credit.id);
    check(versions.includes(version) && typeof header.checksum === "string" && /^[a-f0-9]{64}$/i.test(header.checksum));
    check(Number.isSafeInteger(count) && count > 0 && count <= 600 && count === credit.plazoMeses);
    check(principal > 0 && same(principal, amount(credit.saldoBaseFinanciado)));
    check(same(amount(header.valorVenta) - amount(header.cuotaInicial), principal));
    check(rate <= 1 && rate === Math.round(rate * 1e12) / 1e12);
    check(String(header.frecuenciaPago) === credit.frecuenciaPago);
    check(same(exactCredit + fixedSurety + fixedInsurance, exactTotal));
    check(cents(total) === cents(amount(credit.montoCredito)));
    check(Array.isArray(header.cuotas) && header.cuotas.length === count && plan.installments.length === count);
    const rows = (header.cuotas as unknown[]).map((value, index) => {
      const row = object(value);
      if (!row) throw new Error("Missing installment");
      const actual = plan.installments[index];
      const parsed = {
        numero: amount(row.numero), fecha: dateKey(row.fechaVencimiento),
        saldoInicial: amount(row.saldoInicial), capital: amount(row.abonoCapital),
        interes: amount(row.interes), fianza: amount(row.fianza), seguro: amount(row.seguro),
        cuotaCredito: amount(row.cuotaCredito), cuotaTotal: amount(row.cuotaTotal),
        cobro: amount(row.cuotaCobro), saldoFinal: amount(row.saldoFinal),
      };
      check(parsed.numero === index + 1 && actual.numero === parsed.numero && parsed.fecha === actual.fechaVencimiento);
      check(cents(parsed.cobro) === cents(amount(actual.valorProgramado)));
      check(cents(amount(actual.valorAbonado)) <= cents(parsed.cobro));
      // Do not trust the legacy sub-peso paid clamp as evidence of a fully paid installment.
      check(cents(amount(actual.saldoPendiente)) === cents(parsed.cobro) - cents(actual.valorAbonado));
      check(same(parsed.saldoInicial - parsed.capital, parsed.saldoFinal));
      check(same(parsed.interes, parsed.saldoInicial * rate));
      check(same(parsed.capital + parsed.interes, parsed.cuotaCredito));
      check(same(parsed.cuotaCredito + parsed.fianza + parsed.seguro, parsed.cuotaTotal));
      check(same(parsed.fianza, fixedSurety) && same(parsed.seguro, fixedInsurance));
      check(same(parsed.cuotaCredito, exactCredit));
      if (version === "ARES_FRANCES_V2") check(cents(parsed.cobro) === cents(amount(header.cuotaComercial)));
      return parsed;
    });
    check(same(rows[0].saldoInicial, principal) && same(rows[count - 1].saldoFinal, 0));
    for (let index = 1; index < rows.length; index++) {
      check(same(rows[index - 1].saldoFinal, rows[index].saldoInicial) && rows[index - 1].fecha < rows[index].fecha);
    }
    check(cents(rows.reduce((sum, row) => sum + row.cobro, 0)) === cents(total));
    check(same(rows.reduce((sum, row) => sum + row.capital, 0), principal, count * 0.000001 + 0.00001));
    check(cents(plan.installments.reduce((sum, row) => sum + row.valorAbonado, 0)) === cents(amount(plan.totalPaid)));
    check(cents(plan.installments.reduce((sum, row) => sum + row.saldoPendiente, 0)) === cents(amount(plan.saldoPendiente)));

    // If a signed seal exists it must be valid and agree with the persisted financial source.
    const financial = object(object(credit.contratoSnapshot)?.financiero);
    if (financial && financial.selloFinanciero !== undefined && financial.selloFinanciero !== null) {
      const seal = readFinancingTermsSeal(financial.selloFinanciero);
      check(Boolean(seal));
      const signed = seal!.snapshot;
      check(signed.calculoVersion === version && signed.numeroCuotas === count && signed.frecuenciaPago === header.frecuenciaPago);
      check(signed.fechaPrimerPago === rows[0].fecha);
      check(same(amount(signed.valorVenta), amount(header.valorVenta)) && same(amount(signed.cuotaInicial), amount(header.cuotaInicial)));
      check(same(amount(signed.valorFinanciado), principal) && same(amount(signed.tasaPeriodo), rate, 1e-12));
      check(same(amount(signed.cuotaCreditoExacta), exactCredit) && same(amount(signed.cuotaFianzaExacta), fixedSurety));
      check(same(amount(signed.cuotaSeguroExacta), fixedInsurance) && cents(amount(signed.totalPagar)) === cents(total));
      check(same(amount(signed.cuotaTotalExacta), exactTotal) && cents(amount(signed.cuotaComercial)) === cents(amount(header.cuotaComercial)));
      const parameters = object(header.parametrosSnapshot);
      if (parameters?.financialTermsChecksum !== undefined) check(parameters.financialTermsChecksum === seal!.checksum);
    }

    const nextIndex = plan.installments.findIndex(row => row.saldoPendiente > 0);
    if (nextIndex < 0) return manual("El credito no tiene cuotas pendientes para un abono parcial a capital.");
    const next = plan.installments[nextIndex];
    check(plan.installments.slice(0, nextIndex).every(row => cents(row.valorAbonado) === cents(row.valorProgramado)));
    check(plan.installments.slice(nextIndex + 1).every(row => row.valorAbonado === 0));
    const source = rows[nextIndex];
    // A commercial discount must not be reintroduced as principal or as an extra collectible charge.
    const effectiveInterest = source.cobro - source.fianza - source.seguro - source.capital;
    if (next.valorAbonado > Math.max(0, money(effectiveInterest))) {
      return manual("La proxima cuota tiene un pago parcial que alcanza otros componentes. Completa esa cuota o concilia el saldo antes de abonar a capital.");
    }
    const habitual = amount(credit.valorCuota);
    check(cents(habitual) === cents(source.cobro) || nextIndex === rows.length - 1);
    if (version === "ARES_FRANCES_V2") check(cents(habitual) === cents(amount(header.cuotaComercial)));
    else check(cents(habitual) === cents(exactTotal));
    const capitalPendiente = money(source.saldoInicial);
    check(capitalPendiente > 0 && capitalPendiente <= principal && capitalPendiente <= plan.saldoPendiente);
    const conciliacion = parseCapitalConciliation({
      capitalPendiente, tasaPeriodo: rate,
      cuotaCredito: (cents(habitual) - cents(fixedSurety) - cents(fixedInsurance)) / 100,
      fianzaCuota: money(fixedSurety), seguroCuota: money(fixedInsurance), numeroProximaCuota: next.numero,
      fuente: `Conciliacion automatica FINSERPAY: amortizacion ${amortizationId}, version ${version}, checksum ${header.checksum}. Saldo inicial historico de cuota ${next.numero}, importes redondeados a centavos; recaudos ordinarios conciliados.`,
    });
    return { modoConciliacion: "AUTOMATICA", requiereConciliacion: false, motivoConciliacion: null, capitalPendiente, conciliacion };
  } catch {
    return manual("La tabla financiera guardada no concilia completamente con el credito y sus pagos actuales. Verifica el plan historico antes del primer abono.");
  }
}
