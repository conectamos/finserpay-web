export const SEDE_BODEGA_ID = 10;
export const PROVEEDOR_FINSER = "Proveedor Finser";

function normalizarTexto(valor: string | null | undefined) {
  return String(valor || "").trim().toUpperCase();
}

export function normalizarEstadoFinanciero(
  estado: string | null | undefined
) {
  return normalizarTexto(estado);
}

export function esEstadoDeuda(estado: string | null | undefined) {
  return normalizarEstadoFinanciero(estado) === "DEUDA";
}

export function etiquetaSedeAcreedora(sedeId: number) {
  return `SEDE ${sedeId}`;
}

export function esDeudaEntreSedes(deboA: string | null | undefined) {
  return normalizarTexto(deboA).startsWith("SEDE ");
}

export function esDeudaProveedor(deboA: string | null | undefined) {
  const acreedor = normalizarTexto(deboA);

  if (!acreedor) {
    return false;
  }

  if (esDeudaEntreSedes(acreedor)) {
    return false;
  }

  return acreedor.includes("FINSER") || acreedor.includes("PROVEEDOR");
}

export function resolverFinanzasDestinoPrestamo(params: {
  estadoFinanciero: string | null | undefined;
  deboA: string | null | undefined;
  sedeOrigenId: number;
}) {
  if (esEstadoDeuda(params.estadoFinanciero)) {
    return {
      estadoFinanciero: "DEUDA",
      deboA: String(params.deboA || "").trim() || etiquetaSedeAcreedora(params.sedeOrigenId),
    };
  }

  return {
    estadoFinanciero: "DEUDA",
    deboA: etiquetaSedeAcreedora(params.sedeOrigenId),
  };
}
