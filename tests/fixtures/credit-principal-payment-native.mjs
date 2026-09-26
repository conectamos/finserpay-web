import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import path from "node:path";
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "../..") } });
const { calculateFrenchAmortization } = await jiti.import("../../lib/credit-amortization.ts");
const { buildCreditPaymentPlan } = await jiti.import("../../lib/credit-payment-plan.ts");
const { createFinancingTermsSeal } = await jiti.import("../../lib/credit-amortization-contract.ts");
const cash = value => Math.round(value * 100) / 100;
const decimal = (value, digits = 6) => Number(value).toFixed(digits);

// Synthetic terms calculated by the production amortizer, then serialized like PostgreSQL decimals.
export function makeNativeCapitalFixture({ version = "ARES_FRANCES_V2", paidInstallments = 0,
  partial = 0, signed = false, tasa = 29.24 } = {}) {
  const calculated = calculateFrenchAmortization({ calculoVersion: version,
    valorVenta: 2600000, cuotaInicial: 780000, numeroCuotas: 40,
    tasaInteresEa: tasa, fianzaCuotaPorcentaje: 75 / 40,
    seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2030-10-02" });
  const amortizacion = { id: 17, creditoId: 23, calculoVersion: version,
    frecuenciaPago: calculated.frecuenciaPago, periodosPorAnio: calculated.periodosPorAno,
    numeroCuotas: calculated.numeroCuotas, valorVenta: decimal(calculated.valorVenta),
    cuotaInicial: decimal(calculated.cuotaInicial), valorFinanciado: decimal(calculated.valorFinanciado),
    tasaPeriodo: decimal(calculated.tasaPeriodo, 12), tasaInteresEaPorcentaje: decimal(calculated.tasaInteresEa, 12),
    cuotaCreditoExacta: decimal(calculated.cuotaCredito), cuotaFianzaExacta: decimal(calculated.cuotaFianza),
    cuotaSeguroExacta: decimal(calculated.cuotaSeguro), cuotaTotalExacta: decimal(calculated.cuotaTotal),
    cuotaComercial: decimal(calculated.cuotaComercial, 2), totalPagar: decimal(calculated.montoTotal),
    totalInteres: decimal(calculated.valorInteresTotal), totalFianza: decimal(calculated.valorFianzaTotal),
    totalSeguro: decimal(calculated.valorSeguroTotal), parametrosSnapshot: {},
    checksum: createHash("sha256").update(JSON.stringify(calculated)).digest("hex"),
    cuotas: calculated.cuotas.map(row => ({ numero: row.numero,
      fechaVencimiento: new Date(`${row.fechaVencimiento}T00:00:00Z`),
      ...Object.fromEntries(["saldoInicial", "interes", "abonoCapital", "fianza", "seguro", "cuotaCredito", "cuotaTotal", "saldoFinal"]
        .map(key => [key, decimal(row[key])])), cuotaCobro: decimal(row.cuotaCobro, 2) })) };
  const credit = { id: 23, montoCredito: cash(calculated.montoTotal), valorCuota: calculated.cuotaCobro,
    saldoBaseFinanciado: calculated.valorFinanciado, plazoMeses: 40, frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2030-10-02", contratoSnapshot: {}, planCapitalVigente: null, amortizacion };
  if (signed) {
    const seal = createFinancingTermsSeal({ folio: "TEST-CAPITAL", documento: "TEST",
      contrato: { tipoDocumento: "TEST", clienteNombre: "TEST", clienteTelefono: "", clienteCorreo: "",
        clienteDireccion: "", equipoMarca: "TEST", equipoModelo: "TEST", referenciaEquipo: "TEST", imei: "TEST" },
      amortizacion: calculated, parametros: { fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO",
        fianzaFuente: "TEST", tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } } });
    credit.contratoSnapshot = { financiero: { selloFinanciero: seal } };
    amortizacion.parametrosSnapshot = { financialTermsChecksum: seal.checksum };
  }
  const totalPaid = cash(calculated.cuotas.slice(0, paidInstallments).reduce((sum, row) => sum + row.cuotaCobro, 0) + partial);
  const abonos = totalPaid ? [{ id: 101, valor: totalPaid }] : [];
  const plan = buildCreditPaymentPlan({ ...credit, abonos, today: "2030-09-20" });
  return { credit, plan, abonos, calculated };
}
