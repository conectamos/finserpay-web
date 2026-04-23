type NumericValue =
  | number
  | string
  | { toString(): string }
  | null
  | undefined;

export type CatalogoFinanciera = {
  id: number;
  nombre: string;
  aplicaIntermediacion?: boolean;
  porcentajeIntermediacion?: number;
};

export type FinancieraInput = {
  nombre: string;
  valor: unknown;
};

export type FinancieraDetalle = {
  nombre: string;
  nombreNormalizado: string;
  valorBruto: number;
  valorNeto: number;
  aplicaIntermediacion: boolean;
  porcentajeIntermediacion: number;
};

const LEGACY_FINANCIAL_FIELD_MAP = [
  { key: "alcanos", nombre: "ALCANOS", aliases: ["ALCANOS"] },
  { key: "payjoy", nombre: "PAYJOY", aliases: ["PAYJOY"] },
  { key: "sistecredito", nombre: "SISTECREDITO", aliases: ["SISTECREDITO"] },
  { key: "addi", nombre: "ADDI", aliases: ["ADDI"] },
  { key: "sumaspay", nombre: "SUMASPAY", aliases: ["SUMASPAY"] },
  { key: "celya", nombre: "CELYA", aliases: ["CELYA"] },
  { key: "bogota", nombre: "BANCO BOGOTA", aliases: ["BANCO BOGOTA", "BOGOTA"] },
  { key: "alocredit", nombre: "ALO-CREDIT", aliases: ["ALO-CREDIT", "ALO CREDIT"] },
  { key: "esmio", nombre: "ESMIO", aliases: ["ESMIO"] },
  { key: "kaiowa", nombre: "KAIOWA", aliases: ["KAIOWA"] },
  { key: "finser", nombre: "FINSER", aliases: ["FINSER", "FINSER PAY"] },
  { key: "gora", nombre: "GORA", aliases: ["GORA"] },
] as const;

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  if (typeof value === "object" && value !== null && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }

  const numero = Number(value);
  return Number.isFinite(numero) ? numero : 0;
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function normalizarNombreFinanciera(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function claveFinanciera(value: unknown) {
  return normalizarNombreFinanciera(value).toUpperCase();
}

function legacyIntermediationPercentage(nombreNormalizado: string) {
  if (nombreNormalizado === "SISTECREDITO") return 2;
  if (
    nombreNormalizado === "ADDI" ||
    nombreNormalizado === "ALCANOS" ||
    nombreNormalizado === "GORA"
  ) {
    return 8;
  }
  if (
    nombreNormalizado === "BANCO BOGOTA" ||
    nombreNormalizado === "BOGOTA"
  ) {
    return 5;
  }
  if (
    nombreNormalizado === "ESMIO" ||
    nombreNormalizado === "KAIOWA" ||
    nombreNormalizado === "FINSER PAY"
  ) {
    return 10;
  }

  return 0;
}

function buildCatalogMap(catalogo?: CatalogoFinanciera[]) {
  const map = new Map<string, CatalogoFinanciera>();

  for (const item of catalogo || []) {
    const key = claveFinanciera(item.nombre);
    if (!key) continue;
    map.set(key, item);
  }

  return map;
}

export function resolverIntermediacionFinanciera(
  nombre: string,
  catalogo?: CatalogoFinanciera[]
) {
  const nombreLimpio = normalizarNombreFinanciera(nombre);
  const nombreNormalizado = claveFinanciera(nombreLimpio);
  const config = buildCatalogMap(catalogo).get(nombreNormalizado);

  if (config) {
    const aplicaIntermediacion = Boolean(config.aplicaIntermediacion);
    const porcentajeIntermediacion = aplicaIntermediacion
      ? Math.max(0, toNumber(config.porcentajeIntermediacion))
      : 0;

    return {
      nombre: nombreLimpio,
      nombreNormalizado,
      aplicaIntermediacion,
      porcentajeIntermediacion,
    };
  }

  const porcentajeIntermediacion = legacyIntermediationPercentage(
    nombreNormalizado
  );

  return {
    nombre: nombreLimpio,
    nombreNormalizado,
    aplicaIntermediacion: porcentajeIntermediacion > 0,
    porcentajeIntermediacion,
  };
}

export function calcularValorNetoFinanciera(
  nombre: string,
  valorBruto: NumericValue,
  catalogo?: CatalogoFinanciera[]
) {
  const bruto = toNumber(valorBruto);

  if (!bruto) {
    return 0;
  }

  const config = resolverIntermediacionFinanciera(nombre, catalogo);
  const porcentaje = config.aplicaIntermediacion
    ? config.porcentajeIntermediacion / 100
    : 0;

  return roundCurrency(bruto * (1 - porcentaje));
}

export function construirDetalleFinancieras(
  finanzas: FinancieraInput[],
  catalogo?: CatalogoFinanciera[]
) {
  const map = new Map<string, FinancieraDetalle>();

  for (const item of finanzas) {
    const nombre = normalizarNombreFinanciera(item.nombre);
    const valorBruto = toNumber(item.valor);

    if (!nombre || valorBruto <= 0) {
      continue;
    }

    const config = resolverIntermediacionFinanciera(nombre, catalogo);
    const valorNeto = calcularValorNetoFinanciera(nombre, valorBruto, catalogo);
    const existente = map.get(config.nombreNormalizado);

    if (existente) {
      existente.valorBruto = roundCurrency(existente.valorBruto + valorBruto);
      existente.valorNeto = roundCurrency(existente.valorNeto + valorNeto);
      continue;
    }

    map.set(config.nombreNormalizado, {
      nombre: config.nombre,
      nombreNormalizado: config.nombreNormalizado,
      valorBruto: roundCurrency(valorBruto),
      valorNeto,
      aplicaIntermediacion: config.aplicaIntermediacion,
      porcentajeIntermediacion: config.porcentajeIntermediacion,
    });
  }

  return Array.from(map.values());
}

export function totalFinancierasNetas(detalle: FinancieraDetalle[]) {
  return roundCurrency(
    detalle.reduce((acc, item) => acc + toNumber(item.valorNeto), 0)
  );
}

export function totalFinancierasBrutas(detalle: FinancieraDetalle[]) {
  return roundCurrency(
    detalle.reduce((acc, item) => acc + toNumber(item.valorBruto), 0)
  );
}

export function buildLegacyFinancieraPayload(detalle: FinancieraDetalle[]) {
  const payload: Record<(typeof LEGACY_FINANCIAL_FIELD_MAP)[number]["key"], number | null> =
    {
      alcanos: null,
      payjoy: null,
      sistecredito: null,
      addi: null,
      sumaspay: null,
      celya: null,
      bogota: null,
      alocredit: null,
      esmio: null,
      kaiowa: null,
      finser: null,
      gora: null,
    };

  for (const item of detalle) {
    const legacyField = LEGACY_FINANCIAL_FIELD_MAP.find(
      (field) => field.aliases.some((alias) => alias === item.nombreNormalizado)
    );

    if (!legacyField) {
      continue;
    }

    payload[legacyField.key] = roundCurrency(
      toNumber(payload[legacyField.key]) + item.valorBruto
    );
  }

  return payload;
}

function parseStoredDetalle(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as FinancieraDetalle[];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const row = item as Record<string, unknown>;
      const nombre = normalizarNombreFinanciera(row.nombre);
      const nombreNormalizado =
        claveFinanciera(row.nombreNormalizado || nombre) || claveFinanciera(nombre);
      const valorBruto = toNumber(row.valorBruto);
      const valorNeto = toNumber(row.valorNeto);

      if (!nombre || !nombreNormalizado || valorBruto <= 0) {
        return null;
      }

      return {
        nombre,
        nombreNormalizado,
        valorBruto: roundCurrency(valorBruto),
        valorNeto: roundCurrency(valorNeto || valorBruto),
        aplicaIntermediacion: Boolean(row.aplicaIntermediacion),
        porcentajeIntermediacion: Math.max(0, toNumber(row.porcentajeIntermediacion)),
      } satisfies FinancieraDetalle;
    })
    .filter((item): item is FinancieraDetalle => Boolean(item));
}

export function extraerFinancierasDetalle(
  source: Record<string, unknown>,
  catalogo?: CatalogoFinanciera[]
) {
  const stored = parseStoredDetalle(source.financierasDetalle);

  if (stored.length) {
    return stored;
  }

  return construirDetalleFinancieras(
    LEGACY_FINANCIAL_FIELD_MAP.map((field) => ({
      nombre: field.nombre,
      valor: source[field.key],
    })),
    catalogo
  );
}

export function financierasTextoDesdeDetalle(detalle: FinancieraDetalle[]) {
  if (!detalle.length) {
    return "Sin financieras";
  }

  return detalle
    .map(
      (item) =>
        `${item.nombre}: $ ${toNumber(item.valorBruto).toLocaleString("es-CO")}`
    )
    .join(" | ");
}
