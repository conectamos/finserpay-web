export const DATACREDITO_PLATFORMS = ["ANDROID", "IPHONE"] as const;
export const DATACREDITO_DECISIONS = ["APROBADO", "RECHAZADO"] as const;
export const DATACREDITO_FINANCIAL_CALCULATION_VERSIONS = [
  "FRANCES_V1",
  "ARES_FRANCES_V1",
] as const;
export const DATACREDITO_COMMERCIAL_ROUNDING_MODES = [
  "REDONDEO",
  "PISO",
] as const;
export const DATACREDITO_FINANCIAL_PAYMENT_FREQUENCIES = [
  "SEMANAL",
  "QUINCENAL",
  "MENSUAL",
] as const;
export const DATACREDITO_NO_INFORMATION_SCORE = -1;
export const DATACREDITO_MIN_SCORE = 0;
export const DATACREDITO_MAX_SCORE = 950;
// Defensive ceiling for an administratively configured credit offer (COP).
export const DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT = 100_000_000;
export const DATACREDITO_MAX_INSTALLMENT_COUNT = 60;
export const DATACREDITO_DEFAULT_ANDROID_INSTALLMENT_COUNT = 16;
export const DATACREDITO_DEFAULT_IPHONE_INSTALLMENT_COUNT = 24;
export const DATACREDITO_DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT = 160_000;
export const DATACREDITO_RISK_METRIC_VERSION =
  "MIDECISOR_PN_MILES_COP_V1" as const;
export const DATACREDITO_DECISION_RULES = [
  "SCORE_BAND",
  "TELCO_DELINQUENCY_THRESHOLD",
  "TOTAL_DELINQUENCY_THRESHOLD",
] as const;

export type DataCreditoPlatform = (typeof DATACREDITO_PLATFORMS)[number];
export type DataCreditoDecision = (typeof DATACREDITO_DECISIONS)[number];
export type DataCreditoFinancialCalculationVersion =
  (typeof DATACREDITO_FINANCIAL_CALCULATION_VERSIONS)[number];
export type DataCreditoFinancialPaymentFrequency =
  (typeof DATACREDITO_FINANCIAL_PAYMENT_FREQUENCIES)[number];
export type DataCreditoCommercialRoundingMode =
  (typeof DATACREDITO_COMMERCIAL_ROUNDING_MODES)[number];

export type DataCreditoDecisionRule =
  (typeof DATACREDITO_DECISION_RULES)[number];

export type DataCreditoPolicyPriorityRules = {
  telcoDelinquency: {
    enabled: boolean;
    rejectAboveCopByPlatform: Record<DataCreditoPlatform, number>;
  };
  totalDelinquency?: {
    enabled: boolean;
    rejectAboveCopByPlatform: Record<DataCreditoPlatform, number>;
  };
};

export type DataCreditoDecisionRiskContext = {
  telcoDelinquentBalanceCop?: number | null;
  telcoDelinquencyInformationAvailable?: boolean | null;
  totalDelinquentBalanceCop?: number | null;
  totalDelinquencyInformationAvailable?: boolean | null;
};

export type DataCreditoDecisionAudit = {
  decisionRule: DataCreditoDecisionRule;
  telcoRejectionThresholdCop: number | null;
  totalDelinquencyRejectionThresholdCop: number | null;
  riskMetricVersion: typeof DATACREDITO_RISK_METRIC_VERSION;
};

type DataCreditoPolicyFinancialSettingsBase = {
  tasaInteresEa: number;
  seguroCuotaPorcentaje: number;
  frecuenciaPago: DataCreditoFinancialPaymentFrequency;
};

export type DataCreditoLegacyPolicyFinancialSettings =
  DataCreditoPolicyFinancialSettingsBase & {
    calculoVersion: "FRANCES_V1";
    fianzaCuotaPorcentaje: number;
  };

export type DataCreditoAresPolicyFinancialSettings =
  DataCreditoPolicyFinancialSettingsBase & {
    calculoVersion: "ARES_FRANCES_V1";
    fianzaTotalPorcentaje: number;
    tasaPeriodoDecimales: 6;
    redondeoComercial: {
      modo: "PISO";
      multiplo: 50;
    };
  };

export type DataCreditoPolicyFinancialSettings =
  | DataCreditoLegacyPolicyFinancialSettings
  | DataCreditoAresPolicyFinancialSettings;

export const DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS = {
  calculoVersion: "ARES_FRANCES_V1",
  tasaInteresEa: 29.66,
  fianzaTotalPorcentaje: 75,
  seguroCuotaPorcentaje: 0.03,
  frecuenciaPago: "QUINCENAL",
  tasaPeriodoDecimales: 6,
  redondeoComercial: {
    modo: "PISO",
    multiplo: 50,
  },
} as const satisfies DataCreditoAresPolicyFinancialSettings;

export type DataCreditoPolicyBand = {
  id: string;
  platform: DataCreditoPlatform;
  scoreMin: number;
  scoreMax: number;
  decision: DataCreditoDecision;
  initialPaymentPercentage: number;
  suretyPercentage: number;
  maxFinancedAmount: number;
  installmentCount?: number;
  maxInstallmentAmount?: number | null;
};

export type DataCreditoPolicy = {
  profileId?: string;
  profileName?: string;
  revisionId?: string;
  version: number;
  bands: DataCreditoPolicyBand[];
  financialSettings?: DataCreditoPolicyFinancialSettings | null;
  priorityRules?: DataCreditoPolicyPriorityRules | null;
  createdAt?: string;
};

export type DataCreditoOffer = {
  initialPaymentPercentage: number;
  suretyPercentage: number;
  maxFinancedAmount: number;
  installmentCount: number;
  maxInstallmentAmount: number | null;
  policyVersion: number;
  financialSettings?: DataCreditoPolicyFinancialSettings | null;
} & Partial<DataCreditoDecisionAudit>;

export type DataCreditoDecisionResolution = {
  decision: DataCreditoDecision;
  offer: DataCreditoOffer;
} & Partial<DataCreditoDecisionAudit>;

export type DataCreditoOfferFinancingTerms = {
  installmentCount: number;
  maxInstallmentAmount: number | null;
  usedLegacyFallback: boolean;
};

export class DataCreditoPolicyValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues[0] || "La politica de DataCredito no es valida");
    this.name = "DataCreditoPolicyValidationError";
    this.issues = issues;
  }
}

export function parseDataCreditoPolicyProfileName(value: unknown) {
  const name = String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    name.length < 2 ||
    name.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new DataCreditoPolicyValidationError([
      "El nombre de la politica debe tener entre 2 y 80 caracteres validos",
    ]);
  }
  return name;
}

export function parseDataCreditoPolicyProfileDescription(value: unknown) {
  const description = String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (description.length > 240 || /[\u0000-\u001f\u007f]/u.test(description)) {
    throw new DataCreditoPolicyValidationError([
      "La descripcion de la politica no puede superar 240 caracteres",
    ]);
  }
  return description || null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function parseDataCreditoPolicyPriorityRules(
  value: unknown,
  options: {
    optional?: boolean;
    requireTotalDelinquency?: boolean;
  } = {}
): DataCreditoPolicyPriorityRules | null {
  if ((value === null || value === undefined) && options.optional) {
    return null;
  }

  const rules = recordValue(value);
  const telcoDelinquency = recordValue(rules?.telcoDelinquency);
  if (!rules || !telcoDelinquency) {
    throw new DataCreditoPolicyValidationError([
      "Debes configurar la regla prioritaria de mora vigente Telcos",
    ]);
  }

  const enabled = telcoDelinquency.enabled;
  const hasPlatformThresholds = Object.prototype.hasOwnProperty.call(
    telcoDelinquency,
    "rejectAboveCopByPlatform"
  );
  const hasLegacyThreshold = Object.prototype.hasOwnProperty.call(
    telcoDelinquency,
    "rejectAboveCop"
  );
  const rejectAboveCopByPlatform = hasPlatformThresholds
    ? recordValue(telcoDelinquency.rejectAboveCopByPlatform)
    : null;
  const legacyRejectAboveCop =
    !hasPlatformThresholds && hasLegacyThreshold
      ? finiteNumber(telcoDelinquency.rejectAboveCop)
      : null;
  const androidRejectAboveCop = finiteNumber(
    rejectAboveCopByPlatform?.ANDROID ?? legacyRejectAboveCop
  );
  const iphoneRejectAboveCop = finiteNumber(
    rejectAboveCopByPlatform?.IPHONE ?? legacyRejectAboveCop
  );
  const hasTotalDelinquency = Boolean(
    rules &&
      Object.prototype.hasOwnProperty.call(rules, "totalDelinquency")
  );
  const totalDelinquency = recordValue(rules?.totalDelinquency);
  const totalRejectAboveCopByPlatform = recordValue(
    totalDelinquency?.rejectAboveCopByPlatform
  );
  const totalAndroidRejectAboveCop = finiteNumber(
    totalRejectAboveCopByPlatform?.ANDROID
  );
  const totalIphoneRejectAboveCop = finiteNumber(
    totalRejectAboveCopByPlatform?.IPHONE
  );
  const issues: string[] = [];
  if (enabled !== true) {
    issues.push(
      "La regla prioritaria de mora vigente Telcos debe estar habilitada"
    );
  }
  if (hasPlatformThresholds === hasLegacyThreshold) {
    issues.push(
      "La regla prioritaria de mora vigente Telcos debe usar exactamente una configuración de umbrales"
    );
  }
  if (hasPlatformThresholds && !rejectAboveCopByPlatform) {
    issues.push(
      "Los umbrales de mora vigente Telcos por plataforma no son válidos"
    );
  }
  for (const [platform, rejectAboveCop] of [
    ["Android", androidRejectAboveCop],
    ["iPhone", iphoneRejectAboveCop],
  ] as const) {
    if (
      !Number.isSafeInteger(rejectAboveCop) ||
      rejectAboveCop! <= 0 ||
      rejectAboveCop! > DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT
    ) {
      issues.push(
        `El umbral de mora vigente Telcos para ${platform} debe ser un entero en pesos colombianos entre 1 y ${DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT}`
      );
    }
  }
  if (options.requireTotalDelinquency && !hasTotalDelinquency) {
    issues.push(
      "Debes configurar la regla prioritaria de mora vigente total"
    );
  }
  if (hasTotalDelinquency && !totalDelinquency) {
    issues.push(
      "La regla prioritaria de mora vigente total no tiene un formato valido"
    );
  }
  if (totalDelinquency) {
    if (totalDelinquency.enabled !== true) {
      issues.push(
        "La regla prioritaria de mora vigente total debe estar habilitada"
      );
    }
    if (!totalRejectAboveCopByPlatform) {
      issues.push(
        "Los umbrales de mora vigente total por plataforma no son validos"
      );
    }
    for (const [platform, rejectAboveCop] of [
      ["Android", totalAndroidRejectAboveCop],
      ["iPhone", totalIphoneRejectAboveCop],
    ] as const) {
      if (
        !Number.isSafeInteger(rejectAboveCop) ||
        rejectAboveCop! <= 0 ||
        rejectAboveCop! > DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT
      ) {
        issues.push(
          `El umbral de mora vigente total para ${platform} debe ser un entero en pesos colombianos entre 1 y ${DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT}`
        );
      }
    }
  }
  if (issues.length) {
    throw new DataCreditoPolicyValidationError(issues);
  }

  return {
    telcoDelinquency: {
      enabled: enabled as boolean,
      rejectAboveCopByPlatform: {
        ANDROID: androidRejectAboveCop!,
        IPHONE: iphoneRejectAboveCop!,
      },
    },
    ...(totalDelinquency
      ? {
          totalDelinquency: {
            enabled: true,
            rejectAboveCopByPlatform: {
              ANDROID: totalAndroidRejectAboveCop!,
              IPHONE: totalIphoneRejectAboveCop!,
            },
          },
        }
      : {}),
  };
}

export function isDataCreditoNoInformationScore(value: unknown) {
  return finiteNumber(value) === DATACREDITO_NO_INFORMATION_SCORE;
}

export function normalizeDataCreditoPlatform(
  value: unknown
): DataCreditoPlatform | null {
  const normalized = String(value || "").trim().toUpperCase();
  return DATACREDITO_PLATFORMS.includes(normalized as DataCreditoPlatform)
    ? (normalized as DataCreditoPlatform)
    : null;
}

export function normalizeDataCreditoDecision(
  value: unknown
): DataCreditoDecision | null {
  const normalized = String(value || "").trim().toUpperCase();
  return DATACREDITO_DECISIONS.includes(normalized as DataCreditoDecision)
    ? (normalized as DataCreditoDecision)
    : null;
}

export function resolveDataCreditoOfferFinancingTerms(
  platformValue: unknown,
  value?: {
    installmentCount?: unknown;
    maxInstallmentAmount?: unknown;
  } | null
): DataCreditoOfferFinancingTerms | null {
  const platform = normalizeDataCreditoPlatform(platformValue);
  if (!platform) return null;

  const installmentMissing = value?.installmentCount === undefined;
  const rawInstallmentCount = installmentMissing
    ? platform === "IPHONE"
      ? DATACREDITO_DEFAULT_IPHONE_INSTALLMENT_COUNT
      : DATACREDITO_DEFAULT_ANDROID_INSTALLMENT_COUNT
    : finiteNumber(value?.installmentCount);
  if (
    !Number.isSafeInteger(rawInstallmentCount) ||
    rawInstallmentCount! < 1 ||
    rawInstallmentCount! > DATACREDITO_MAX_INSTALLMENT_COUNT
  ) {
    return null;
  }

  const maxInstallmentMissing = value?.maxInstallmentAmount === undefined;
  if (platform === "ANDROID") {
    if (!maxInstallmentMissing && value?.maxInstallmentAmount !== null) {
      return null;
    }
    return {
      installmentCount: rawInstallmentCount!,
      maxInstallmentAmount: null,
      usedLegacyFallback: installmentMissing || maxInstallmentMissing,
    };
  }

  const rawMaxInstallmentAmount = maxInstallmentMissing
    ? DATACREDITO_DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT
    : finiteNumber(value?.maxInstallmentAmount);
  if (
    !Number.isSafeInteger(rawMaxInstallmentAmount) ||
    rawMaxInstallmentAmount! <= 0 ||
    rawMaxInstallmentAmount! > DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT
  ) {
    return null;
  }

  return {
    installmentCount: rawInstallmentCount!,
    maxInstallmentAmount: rawMaxInstallmentAmount!,
    usedLegacyFallback: installmentMissing || maxInstallmentMissing,
  };
}

export function parseDataCreditoPolicyFinancialSettings(
  value: unknown,
  options: { optional?: boolean } = {}
): DataCreditoPolicyFinancialSettings | null {
  if ((value === null || value === undefined) && options.optional) {
    return null;
  }

  const row = recordValue(value);
  if (!row) {
    throw new DataCreditoPolicyValidationError([
      "Debes configurar los parametros financieros de la politica",
    ]);
  }

  const calculoVersion = String(row.calculoVersion || "")
    .trim()
    .toUpperCase();
  const tasaInteresEa = finiteNumber(row.tasaInteresEa);
  const seguroCuotaPorcentaje = finiteNumber(row.seguroCuotaPorcentaje);
  const frecuenciaPago = String(row.frecuenciaPago || "")
    .trim()
    .toUpperCase();
  const issues: string[] = [];

  if (!DATACREDITO_FINANCIAL_CALCULATION_VERSIONS.includes(
    calculoVersion as DataCreditoFinancialCalculationVersion
  )) {
    issues.push("El sistema de calculo debe ser una version francesa soportada");
  }
  if (tasaInteresEa === null || tasaInteresEa < 0 || tasaInteresEa > 100) {
    issues.push("El interes E.A. debe estar entre 0 y 100");
  }
  if (
    seguroCuotaPorcentaje === null ||
    seguroCuotaPorcentaje < 0 ||
    seguroCuotaPorcentaje > 100
  ) {
    issues.push("El seguro por cuota debe estar entre 0 y 100");
  }
  if (
    !DATACREDITO_FINANCIAL_PAYMENT_FREQUENCIES.includes(
      frecuenciaPago as DataCreditoFinancialPaymentFrequency
    )
  ) {
    issues.push("La frecuencia debe ser semanal, quincenal o mensual");
  }

  if (issues.length) {
    throw new DataCreditoPolicyValidationError(issues);
  }

  const precise = (numberValue: number) =>
    Math.round(numberValue * 1_000_000) / 1_000_000;

  const base = {
    tasaInteresEa: precise(tasaInteresEa!),
    seguroCuotaPorcentaje: precise(seguroCuotaPorcentaje!),
    frecuenciaPago:
      frecuenciaPago as DataCreditoFinancialPaymentFrequency,
  };

  if (calculoVersion === "FRANCES_V1") {
    const fianzaCuotaPorcentaje = finiteNumber(row.fianzaCuotaPorcentaje);
    if (
      fianzaCuotaPorcentaje === null ||
      fianzaCuotaPorcentaje < 0 ||
      fianzaCuotaPorcentaje > 100
    ) {
      throw new DataCreditoPolicyValidationError([
        "La fianza por cuota legada debe estar entre 0 y 100",
      ]);
    }
    return {
      calculoVersion: "FRANCES_V1",
      ...base,
      fianzaCuotaPorcentaje: precise(fianzaCuotaPorcentaje),
    };
  }

  const fianzaTotalPorcentaje = finiteNumber(row.fianzaTotalPorcentaje);
  const tasaPeriodoDecimales = finiteNumber(row.tasaPeriodoDecimales);
  const redondeo = recordValue(row.redondeoComercial);
  const redondeoModo = String(redondeo?.modo || "").trim().toUpperCase();
  const redondeoMultiplo = finiteNumber(redondeo?.multiplo);
  const aresIssues: string[] = [];
  if (
    fianzaTotalPorcentaje === null ||
    fianzaTotalPorcentaje < 0 ||
    fianzaTotalPorcentaje > 100
  ) {
    aresIssues.push("La fianza total ARES debe estar entre 0 y 100");
  }
  if (tasaPeriodoDecimales !== 6) {
    aresIssues.push("ARES_FRANCES_V1 usa exactamente 6 decimales en la tasa periodica");
  }
  if (redondeoModo !== "PISO" || redondeoMultiplo !== 50) {
    aresIssues.push("ARES_FRANCES_V1 usa redondeo comercial al piso en multiplos de 50");
  }
  if (aresIssues.length) {
    throw new DataCreditoPolicyValidationError(aresIssues);
  }

  return {
    calculoVersion: "ARES_FRANCES_V1",
    ...base,
    fianzaTotalPorcentaje: precise(fianzaTotalPorcentaje!),
    tasaPeriodoDecimales: 6,
    redondeoComercial: {
      modo: "PISO",
      multiplo: 50,
    },
  };
}

/**
 * Validates a complete policy. Gaps are intentionally invalid: a score must
 * never fall through to an implicit decision or an implicit financial offer.
 */
export function parseDataCreditoPolicyBands(
  value: unknown,
  options: { requireFinancingTerms?: boolean } = {}
): DataCreditoPolicyBand[] {
  const issues: string[] = [];

  if (!Array.isArray(value) || value.length === 0) {
    throw new DataCreditoPolicyValidationError([
      "Debes configurar bandas para Android y iPhone",
    ]);
  }

  const seenIds = new Set<string>();
  const bands = value.flatMap((item, index) => {
    const row = recordValue(item);
    if (!row) {
      issues.push(`La banda ${index + 1} no tiene un formato valido`);
      return [];
    }

    const id = String(row.id || "").trim();
    const platform = normalizeDataCreditoPlatform(row.platform);
    const decision = normalizeDataCreditoDecision(row.decision);
    const scoreMin = finiteNumber(row.scoreMin);
    const scoreMax = finiteNumber(row.scoreMax);
    const noInformationBand =
      isDataCreditoNoInformationScore(scoreMin) &&
      isDataCreditoNoInformationScore(scoreMax);
    const initialPaymentPercentage = finiteNumber(row.initialPaymentPercentage);
    const suretyPercentage = finiteNumber(row.suretyPercentage);
    const maxFinancedAmount = finiteNumber(row.maxFinancedAmount);
    const hasInstallmentCount = row.installmentCount !== undefined;
    const installmentCount = finiteNumber(row.installmentCount);
    const hasMaxInstallmentAmount = row.maxInstallmentAmount !== undefined;
    const maxInstallmentAmount =
      row.maxInstallmentAmount === null
        ? null
        : finiteNumber(row.maxInstallmentAmount);

    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
      issues.push(`La banda ${index + 1} debe tener un id estable y valido`);
    } else if (seenIds.has(id)) {
      issues.push(`El id de banda ${id} esta repetido`);
    } else {
      seenIds.add(id);
    }

    if (!platform) {
      issues.push(`La banda ${id || index + 1} debe indicar ANDROID o IPHONE`);
    }
    if (!decision) {
      issues.push(`La banda ${id || index + 1} debe indicar APROBADO o RECHAZADO`);
    }
    if (
      !Number.isInteger(scoreMin) ||
      (scoreMin !== DATACREDITO_NO_INFORMATION_SCORE &&
        (scoreMin! < DATACREDITO_MIN_SCORE ||
        scoreMin! > DATACREDITO_MAX_SCORE))
    ) {
      issues.push(`El puntaje minimo de ${id || `la banda ${index + 1}`} debe ser -1 o estar entre 0 y 950`);
    }
    if (
      !Number.isInteger(scoreMax) ||
      (scoreMax !== DATACREDITO_NO_INFORMATION_SCORE &&
        (scoreMax! < DATACREDITO_MIN_SCORE ||
        scoreMax! > DATACREDITO_MAX_SCORE))
    ) {
      issues.push(`El puntaje maximo de ${id || `la banda ${index + 1}`} debe ser -1 o estar entre 0 y 950`);
    }
    if (
      (scoreMin === DATACREDITO_NO_INFORMATION_SCORE ||
        scoreMax === DATACREDITO_NO_INFORMATION_SCORE) &&
      !noInformationBand
    ) {
      issues.push(`La regla sin informacion de ${id || `la banda ${index + 1}`} debe usar exactamente -1 en ambos limites`);
    }
    if (scoreMin !== null && scoreMax !== null && scoreMin > scoreMax) {
      issues.push(`El rango de ${id || `la banda ${index + 1}`} esta invertido`);
    }
    if (
      initialPaymentPercentage === null ||
      initialPaymentPercentage < 0 ||
      initialPaymentPercentage > 100
    ) {
      issues.push(`La cuota inicial de ${id || `la banda ${index + 1}`} debe estar entre 0 y 100`);
    }
    if (suretyPercentage === null || suretyPercentage < 0 || suretyPercentage > 100) {
      issues.push(`La fianza de ${id || `la banda ${index + 1}`} debe estar entre 0 y 100`);
    }
    if (
      !Number.isInteger(maxFinancedAmount) ||
      maxFinancedAmount! <= 0 ||
      maxFinancedAmount! > DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT
    ) {
      issues.push(
        `El credito maximo de ${id || `la banda ${index + 1}`} debe ser un entero en COP entre 1 y ${DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT}`
      );
    }
    if (
      (options.requireFinancingTerms || hasInstallmentCount) &&
      (!Number.isSafeInteger(installmentCount) ||
        installmentCount! < 1 ||
        installmentCount! > DATACREDITO_MAX_INSTALLMENT_COUNT)
    ) {
      issues.push(
        `El plazo de ${id || `la banda ${index + 1}`} debe ser un entero entre 1 y ${DATACREDITO_MAX_INSTALLMENT_COUNT} cuotas`
      );
    }
    if (platform === "IPHONE") {
      if (
        (options.requireFinancingTerms || hasMaxInstallmentAmount) &&
        (!Number.isSafeInteger(maxInstallmentAmount) ||
          maxInstallmentAmount! <= 0 ||
          maxInstallmentAmount! > DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT)
      ) {
        issues.push(
          `El tope de cuota iPhone de ${id || `la banda ${index + 1}`} debe ser un entero en COP entre 1 y ${DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT}`
        );
      }
    } else if (
      (options.requireFinancingTerms && !hasMaxInstallmentAmount) ||
      (hasMaxInstallmentAmount && row.maxInstallmentAmount !== null)
    ) {
      issues.push(
        `El tope de cuota de ${id || `la banda ${index + 1}`} debe ser nulo para Android`
      );
    }

    if (
      !id ||
      !platform ||
      !decision ||
      scoreMin === null ||
      scoreMax === null ||
      initialPaymentPercentage === null ||
      suretyPercentage === null ||
      maxFinancedAmount === null
    ) {
      return [];
    }

    return [
      {
        id,
        platform,
        scoreMin,
        scoreMax,
        decision,
        initialPaymentPercentage,
        suretyPercentage,
        maxFinancedAmount,
        ...(hasInstallmentCount ? { installmentCount: installmentCount! } : {}),
        ...(hasMaxInstallmentAmount ? { maxInstallmentAmount } : {}),
      } satisfies DataCreditoPolicyBand,
    ];
  });

  for (const platform of DATACREDITO_PLATFORMS) {
    const platformBands = bands
      .filter((band) => band.platform === platform)
      .sort((a, b) => a.scoreMin - b.scoreMin || a.scoreMax - b.scoreMax);

    if (!platformBands.length) {
      issues.push(`Faltan las bandas de ${platform}`);
      continue;
    }

    const noInformationBands = platformBands.filter(
      (band) =>
        isDataCreditoNoInformationScore(band.scoreMin) &&
        isDataCreditoNoInformationScore(band.scoreMax)
    );
    if (noInformationBands.length !== 1) {
      issues.push(
        `Debe existir exactamente una regla sin informacion para ${platform}`
      );
    }

    const scoreBands = platformBands.filter(
      (band) =>
        !isDataCreditoNoInformationScore(band.scoreMin) &&
        !isDataCreditoNoInformationScore(band.scoreMax)
    );

    if (!scoreBands.length || scoreBands[0].scoreMin !== DATACREDITO_MIN_SCORE) {
      issues.push(`Las bandas de ${platform} deben comenzar en el puntaje 0`);
    }

    scoreBands.forEach((band, index) => {
      if (index === 0) return;
      const previous = scoreBands[index - 1];

      if (band.scoreMin <= previous.scoreMax) {
        issues.push(`Las bandas ${previous.id} y ${band.id} de ${platform} se superponen`);
      } else if (band.scoreMin !== previous.scoreMax + 1) {
        issues.push(`Hay un puntaje sin configurar entre ${previous.id} y ${band.id} de ${platform}`);
      }
    });

    if (scoreBands.at(-1)?.scoreMax !== DATACREDITO_MAX_SCORE) {
      issues.push(`Las bandas de ${platform} deben terminar en el puntaje 950`);
    }
  }

  if (issues.length) {
    throw new DataCreditoPolicyValidationError(issues);
  }

  return DATACREDITO_PLATFORMS.flatMap((platform) =>
    bands
      .filter((band) => band.platform === platform)
      .sort((a, b) => a.scoreMin - b.scoreMin || a.scoreMax - b.scoreMax)
  );
}

export function resolveDataCreditoPolicyBand(
  policy: Pick<DataCreditoPolicy, "version" | "bands">,
  platformValue: unknown,
  scoreValue: unknown
) {
  const platform = normalizeDataCreditoPlatform(platformValue);
  const score = finiteNumber(scoreValue);

  const validScore =
    isDataCreditoNoInformationScore(score) ||
    (Number.isInteger(score) && score! >= DATACREDITO_MIN_SCORE &&
      score! <= DATACREDITO_MAX_SCORE);

  if (!platform || !validScore) {
    return null;
  }

  return (
    policy.bands.find(
      (band) =>
        band.platform === platform && score! >= band.scoreMin && score! <= band.scoreMax
    ) || null
  );
}

export function resolveDataCreditoDecision(
  policy: Pick<DataCreditoPolicy, "version" | "bands"> &
    Partial<Pick<DataCreditoPolicy, "financialSettings" | "priorityRules">>,
  platform: unknown,
  score: unknown,
  riskContext?: DataCreditoDecisionRiskContext
): DataCreditoDecisionResolution | null {
  const normalizedPlatform = normalizeDataCreditoPlatform(platform);
  if (!normalizedPlatform) return null;

  const telcoDelinquencyRule = policy.priorityRules?.telcoDelinquency;
  const priorityRuleEnabled = telcoDelinquencyRule?.enabled === true;
  const configuredPlatformThreshold =
    telcoDelinquencyRule?.rejectAboveCopByPlatform?.[normalizedPlatform];
  const telcoRejectionThresholdCop =
    priorityRuleEnabled &&
    Number.isSafeInteger(configuredPlatformThreshold) &&
    configuredPlatformThreshold! > 0
      ? configuredPlatformThreshold!
      : null;
  const telcoInformationAvailable =
    riskContext?.telcoDelinquencyInformationAvailable;
  const observedTelcoDelinquency =
    riskContext?.telcoDelinquentBalanceCop;
  const validObservedTelcoDelinquency =
    typeof observedTelcoDelinquency === "number" &&
    Number.isSafeInteger(observedTelcoDelinquency) &&
    observedTelcoDelinquency >= 0;
  if (
    priorityRuleEnabled &&
    (telcoRejectionThresholdCop === null ||
      telcoInformationAvailable === null ||
      telcoInformationAvailable === undefined ||
      (telcoInformationAvailable &&
        !validObservedTelcoDelinquency))
  ) {
    return null;
  }
  const priorityRejection =
    telcoRejectionThresholdCop !== null &&
    telcoInformationAvailable === true &&
    validObservedTelcoDelinquency &&
    observedTelcoDelinquency! > telcoRejectionThresholdCop;
  const totalDelinquencyRule = policy.priorityRules?.totalDelinquency;
  const totalPriorityRuleEnabled = totalDelinquencyRule?.enabled === true;
  const configuredTotalPlatformThreshold =
    totalDelinquencyRule?.rejectAboveCopByPlatform?.[normalizedPlatform];
  const totalDelinquencyRejectionThresholdCop =
    totalPriorityRuleEnabled &&
    Number.isSafeInteger(configuredTotalPlatformThreshold) &&
    configuredTotalPlatformThreshold! > 0
      ? configuredTotalPlatformThreshold!
      : null;
  const totalInformationAvailable =
    riskContext?.totalDelinquencyInformationAvailable;
  const observedTotalDelinquency =
    riskContext?.totalDelinquentBalanceCop;
  const validObservedTotalDelinquency =
    typeof observedTotalDelinquency === "number" &&
    Number.isSafeInteger(observedTotalDelinquency) &&
    observedTotalDelinquency >= 0;
  if (
    !priorityRejection &&
    totalPriorityRuleEnabled &&
    (totalDelinquencyRejectionThresholdCop === null ||
      totalInformationAvailable === null ||
      totalInformationAvailable === undefined ||
      (totalInformationAvailable && !validObservedTotalDelinquency))
  ) {
    return null;
  }
  const totalPriorityRejection =
    !priorityRejection &&
    totalDelinquencyRejectionThresholdCop !== null &&
    totalInformationAvailable === true &&
    validObservedTotalDelinquency &&
    observedTotalDelinquency! > totalDelinquencyRejectionThresholdCop;
  const includeDecisionAudit = riskContext !== undefined;
  const decisionAudit: DataCreditoDecisionAudit = {
    decisionRule: priorityRejection
      ? "TELCO_DELINQUENCY_THRESHOLD"
      : totalPriorityRejection
        ? "TOTAL_DELINQUENCY_THRESHOLD"
      : "SCORE_BAND",
    telcoRejectionThresholdCop,
    totalDelinquencyRejectionThresholdCop,
    riskMetricVersion: DATACREDITO_RISK_METRIC_VERSION,
  };
  const band = resolveDataCreditoPolicyBand(policy, normalizedPlatform, score);
  if (!band) return null;
  const financingTerms = resolveDataCreditoOfferFinancingTerms(
    band.platform,
    band
  );
  if (!financingTerms) return null;

  const offer: DataCreditoOffer = {
    initialPaymentPercentage: band.initialPaymentPercentage,
    suretyPercentage: band.suretyPercentage,
    maxFinancedAmount: band.maxFinancedAmount,
    installmentCount: financingTerms.installmentCount,
    maxInstallmentAmount: financingTerms.maxInstallmentAmount,
    policyVersion: policy.version,
    ...(policy.financialSettings
      ? { financialSettings: policy.financialSettings }
      : {}),
    ...(includeDecisionAudit ? decisionAudit : {}),
  };

  return {
    decision:
      priorityRejection || totalPriorityRejection
        ? "RECHAZADO"
        : band.decision,
    offer,
    ...(includeDecisionAudit ? decisionAudit : {}),
  };
}
