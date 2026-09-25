import { resolveContractualCreditImei } from "./credit-contract-imei";

export type CreditFactorySnapshotDetails = {
  clienteEstadoCivil: string | null;
  clienteEstrato: string | null;
  paso2: {
    origen: "CONTRATO" | "ACTUAL";
    plataformaDispositivo: string | null;
    equipoMarca: string | null;
    equipoModelo: string | null;
    equipoReferencia: string | null;
    imei: string | null;
    valorEquipoTotal: number | null;
    cuotaInicial: number | null;
    saldoBaseFinanciado: number | null;
    montoCredito: number | null;
    tasaInteresEa: number | null;
    valorInteres: number | null;
    fianzaPorcentaje: number | null;
    valorFianza: number | null;
    valorCuota: number | null;
    valorCuotaComercial: number | null;
    numeroCuotas: number | null;
    frecuenciaPago: string | null;
    fechaPrimerPago: string | null;
    seguroCuotaPorcentaje: number | null;
    valorSeguro: number | null;
    cargosIncorporados: number | null;
  };
};

function objectRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const normalized = optionalText(value);

    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const normalized = optionalNumber(value);

    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
}

export function extractCreditFactorySnapshotDetails(
  snapshot: unknown,
  currentCredit?: { imei?: unknown; deviceUid?: unknown }
): CreditFactorySnapshotDetails {
  const root = objectRecord(snapshot);
  const cliente = objectRecord(root?.cliente);
  const equipo = objectRecord(root?.equipo);
  const financiero = objectRecord(root?.financiero);
  const origen = objectRecord(root?.origen);
  const selloFinanciero = objectRecord(financiero?.selloFinanciero);
  const terminosFirmados = objectRecord(selloFinanciero?.snapshot);
  const imeiActual = optionalText(currentCredit?.imei);
  const imeiCorregido =
    origen?.tipo === "IMPORTACION_MASIVA" &&
    origen.sinFirmaDigital === true &&
    origen.imeiTemporalPendienteCorreccion === false &&
    equipo?.imeiTemporal === true &&
    !optionalText(terminosFirmados?.imei) &&
    imeiActual &&
    imeiActual === optionalText(currentCredit?.deviceUid)
      ? optionalText(resolveContractualCreditImei({
          contratoSnapshot: snapshot,
          imei: currentCredit?.imei,
          deviceUid: currentCredit?.deviceUid,
        }))
      : null;
  const cuotaInicial = optionalNumber(financiero?.cuotaInicial);
  const saldoBaseFinanciado = optionalNumber(financiero?.saldoBaseFinanciado);
  const valorEquipoTotal =
    optionalNumber(financiero?.valorTotalEquipo) ??
    (cuotaInicial !== null && saldoBaseFinanciado !== null
      ? cuotaInicial + saldoBaseFinanciado
      : null);

  return {
    clienteEstadoCivil: optionalText(cliente?.estadoCivil),
    clienteEstrato: optionalText(cliente?.estrato),
    paso2: {
      origen: equipo || financiero ? "CONTRATO" : "ACTUAL",
      plataformaDispositivo: optionalText(equipo?.plataforma),
      equipoMarca: optionalText(equipo?.marca),
      equipoModelo: optionalText(equipo?.modelo),
      equipoReferencia: firstText(
        equipo?.referencia,
        [optionalText(equipo?.marca), optionalText(equipo?.modelo)]
          .filter(Boolean)
          .join(" ")
      ),
      imei: imeiCorregido || optionalText(equipo?.imei),
      valorEquipoTotal,
      cuotaInicial,
      saldoBaseFinanciado,
      montoCredito: firstNumber(
        financiero?.saldoFinanciado,
        financiero?.montoCredito
      ),
      tasaInteresEa: optionalNumber(financiero?.tasaInteresEa),
      valorInteres: optionalNumber(financiero?.valorInteres),
      fianzaPorcentaje: optionalNumber(financiero?.fianzaPorcentaje),
      valorFianza: optionalNumber(financiero?.valorFianza),
      valorCuota: optionalNumber(financiero?.valorCuota),
      valorCuotaComercial: optionalNumber(financiero?.cuotaComercial),
      numeroCuotas: firstNumber(financiero?.cuotas, financiero?.plazo),
      frecuenciaPago: optionalText(financiero?.frecuenciaPago),
      fechaPrimerPago: optionalText(financiero?.fechaPrimerPago),
      seguroCuotaPorcentaje: optionalNumber(
        financiero?.seguroCuotaPorcentaje
      ),
      valorSeguro: optionalNumber(financiero?.valorSeguro),
      cargosIncorporados: optionalNumber(financiero?.cargosIncorporados),
    },
  };
}
