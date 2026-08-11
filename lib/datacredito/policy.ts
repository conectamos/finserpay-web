export const DATACREDITO_PLATFORMS = ["ANDROID", "IPHONE"] as const;
export const DATACREDITO_DECISIONS = ["APROBADO", "RECHAZADO"] as const;

export type DataCreditoPlatform = (typeof DATACREDITO_PLATFORMS)[number];
export type DataCreditoDecision = (typeof DATACREDITO_DECISIONS)[number];

export type DataCreditoPolicyBand = {
  id: string;
  platform: DataCreditoPlatform;
  scoreMin: number;
  scoreMax: number;
  decision: DataCreditoDecision;
  initialPaymentPercentage: number;
  suretyPercentage: number;
};

export type DataCreditoPolicy = {
  version: number;
  bands: DataCreditoPolicyBand[];
  createdAt?: string;
};

export type DataCreditoOffer = {
  initialPaymentPercentage: number;
  suretyPercentage: number;
  policyVersion: number;
};

export class DataCreditoPolicyValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues[0] || "La politica de DataCredito no es valida");
    this.name = "DataCreditoPolicyValidationError";
    this.issues = issues;
  }
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

/**
 * Validates a complete policy. Gaps are intentionally invalid: a score must
 * never fall through to an implicit decision or an implicit financial offer.
 */
export function parseDataCreditoPolicyBands(value: unknown): DataCreditoPolicyBand[] {
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
    const initialPaymentPercentage = finiteNumber(row.initialPaymentPercentage);
    const suretyPercentage = finiteNumber(row.suretyPercentage);

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
    if (!Number.isInteger(scoreMin) || scoreMin! < 0 || scoreMin! > 950) {
      issues.push(`El puntaje minimo de ${id || `la banda ${index + 1}`} debe estar entre 0 y 950`);
    }
    if (!Number.isInteger(scoreMax) || scoreMax! < 0 || scoreMax! > 950) {
      issues.push(`El puntaje maximo de ${id || `la banda ${index + 1}`} debe estar entre 0 y 950`);
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
      !id ||
      !platform ||
      !decision ||
      scoreMin === null ||
      scoreMax === null ||
      initialPaymentPercentage === null ||
      suretyPercentage === null
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

    if (platformBands[0].scoreMin !== 0) {
      issues.push(`Las bandas de ${platform} deben comenzar en el puntaje 0`);
    }

    platformBands.forEach((band, index) => {
      if (index === 0) return;
      const previous = platformBands[index - 1];

      if (band.scoreMin <= previous.scoreMax) {
        issues.push(`Las bandas ${previous.id} y ${band.id} de ${platform} se superponen`);
      } else if (band.scoreMin !== previous.scoreMax + 1) {
        issues.push(`Hay un puntaje sin configurar entre ${previous.id} y ${band.id} de ${platform}`);
      }
    });

    if (platformBands[platformBands.length - 1].scoreMax !== 950) {
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

  if (!platform || !Number.isInteger(score) || score! < 0 || score! > 950) {
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
  policy: Pick<DataCreditoPolicy, "version" | "bands">,
  platform: unknown,
  score: unknown
): { decision: DataCreditoDecision; offer: DataCreditoOffer } | null {
  const band = resolveDataCreditoPolicyBand(policy, platform, score);
  if (!band) return null;

  return {
    decision: band.decision,
    offer: {
      initialPaymentPercentage: band.initialPaymentPercentage,
      suretyPercentage: band.suretyPercentage,
      policyVersion: policy.version,
    },
  };
}
