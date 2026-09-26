type CreditSellerSource = {
  contratoSnapshot?: unknown;
  contratoAceptadoAt?: unknown;
  pagareAceptadoAt?: unknown;
  contratoFirmaDataUrl?: unknown;
  sedeId?: number | null;
  vendedorId?: number | null;
  vendedor?: { id?: number; nombre?: string | null; documento?: string | null } | null;
  usuario?: { id?: number; nombre?: string | null; usuario?: string | null } | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** An imported unsigned credit can be assigned to a site's administrator,
 * without replacing its original creator or inventing a Vendedor profile. */
export function resolveCreditAssignedAdministrator(credit: CreditSellerSource) {
  const snapshot = record(credit.contratoSnapshot);
  const origin = record(snapshot.origen);
  const assignment = record(snapshot.asignacion);
  const financial = record(snapshot.financiero);
  const name = typeof assignment.vendedor === "string" ? assignment.vendedor.trim() : "";
  const id = assignment.responsableUsuarioId;

  if (
    origin.tipo !== "IMPORTACION_MASIVA" || origin.sinFirmaDigital !== true ||
    credit.contratoAceptadoAt || credit.pagareAceptadoAt || credit.contratoFirmaDataUrl ||
    Object.keys(record(financial.selloFinanciero)).length > 0 ||
    assignment.tipoResponsable !== "ADMINISTRADOR" || assignment.vendedorId !== null ||
    credit.vendedorId !== null || credit.vendedor ||
    typeof credit.sedeId !== "number" || !Number.isSafeInteger(credit.sedeId) || credit.sedeId <= 0 ||
    assignment.sedeId !== credit.sedeId ||
    typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || !name
  ) {
    return null;
  }

  return { id, nombre: name };
}

export function resolveCreditSellerDisplay(credit: CreditSellerSource, fallback = "Sin vendedor") {
  const administrator = resolveCreditAssignedAdministrator(credit);
  if (administrator) {
    return { ...administrator, usuario: "" };
  }

  return {
    id: credit.vendedor?.id || credit.usuario?.id || 0,
    nombre: credit.vendedor?.nombre || credit.usuario?.nombre || fallback,
    usuario: credit.vendedor?.documento || credit.usuario?.usuario || "",
  };
}
