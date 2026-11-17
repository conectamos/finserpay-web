import {
  DATACREDITO_MAX_SCORE,
  DATACREDITO_MIN_SCORE,
  DATACREDITO_NO_INFORMATION_SCORE,
  type DataCreditoPlatform,
} from "./policy";

export type RemovablePolicyBand = {
  id: string;
  platform: DataCreditoPlatform;
  scoreMin: string;
  scoreMax: string;
};

export type PolicyBandRemovalOption = {
  targetBandId: string;
  scoreMin: number;
  scoreMax: number;
};

export type PolicyBandRemovalPlan =
  | { kind: "DIRECT"; removedBandId: string }
  | { kind: "BLOCKED"; message: string }
  | {
      kind: "MERGE";
      removedBandId: string;
      options: PolicyBandRemovalOption[];
    };

export type PolicyBandRemovalOptions = {
  isNewBand?: boolean;
};

type NumericRange = { scoreMin: number; scoreMax: number };

function integer(value: string) {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function numericRange(band: RemovablePolicyBand): NumericRange | null {
  const scoreMin = integer(band.scoreMin);
  const scoreMax = integer(band.scoreMax);
  if (
    scoreMin === null || scoreMax === null ||
    scoreMin < DATACREDITO_MIN_SCORE || scoreMax > DATACREDITO_MAX_SCORE ||
    scoreMin > scoreMax
  ) return null;
  return { scoreMin, scoreMax };
}

function noInformation(band: RemovablePolicyBand) {
  return integer(band.scoreMin) === DATACREDITO_NO_INFORMATION_SCORE &&
    integer(band.scoreMax) === DATACREDITO_NO_INFORMATION_SCORE;
}

function completeNumericCoverage(rows: readonly { range: NumericRange | null }[]) {
  return rows[0]?.range?.scoreMin === DATACREDITO_MIN_SCORE &&
    rows.at(-1)?.range?.scoreMax === DATACREDITO_MAX_SCORE &&
    rows.every((item, index) => item.range !== null &&
      (index === 0 || item.range.scoreMin === rows[index - 1].range!.scoreMax + 1));
}

/** Plans a draft edit. The administrator must explicitly choose the receiving rule. */
export function getPolicyBandRemovalPlan(
  bands: readonly RemovablePolicyBand[],
  bandId: string,
  options: PolicyBandRemovalOptions = {},
): PolicyBandRemovalPlan {
  if (new Set(bands.map((band) => band.id)).size !== bands.length) {
    return { kind: "BLOCKED", message: "Corrige los identificadores repetidos antes de quitar una banda." };
  }
  const band = bands.find((item) => item.id === bandId);
  if (!band) {
    return { kind: "BLOCKED", message: "La banda cambió. Vuelve a seleccionarla." };
  }
  if (noInformation(band)) {
    return { kind: "BLOCKED", message: "La regla Sin información es obligatoria. Puedes editar su decisión y sus condiciones." };
  }
  const removedRange = numericRange(band);
  if (!removedRange) {
    return options.isNewBand === true
      ? { kind: "DIRECT", removedBandId: band.id }
      : { kind: "BLOCKED", message: "Completa o restaura el rango de la banda publicada antes de quitarla." };
  }

  const numericBands = bands
    .filter((item) => item.platform === band.platform && !noInformation(item))
    .map((item) => ({ band: item, range: numericRange(item) }))
    .sort((left, right) => (left.range?.scoreMin ?? -1) - (right.range?.scoreMin ?? -1));
  if (options.isNewBand === true &&
    completeNumericCoverage(numericBands.filter((item) => item.band.id !== bandId))) {
    return { kind: "DIRECT", removedBandId: band.id };
  }
  if (numericBands.length === 1) {
    return { kind: "BLOCKED", message: "Conserva al menos una banda que cubra los puntajes de 0 a 950. Puedes editar sus condiciones." };
  }
  if (!completeNumericCoverage(numericBands)) {
    return { kind: "BLOCKED", message: "Completa los rangos de esta plataforma de 0 a 950, sin huecos ni superposiciones, antes de quitar una banda." };
  }

  const removalOptions = numericBands.flatMap(({ band: candidate, range }) => {
    if (candidate.id === band.id || !range) return [];
    if (range.scoreMax + 1 === removedRange.scoreMin) {
      return [{ targetBandId: candidate.id, scoreMin: range.scoreMin, scoreMax: removedRange.scoreMax }];
    }
    if (removedRange.scoreMax + 1 === range.scoreMin) {
      return [{ targetBandId: candidate.id, scoreMin: removedRange.scoreMin, scoreMax: range.scoreMax }];
    }
    return [];
  });
  return { kind: "MERGE", removedBandId: band.id, options: removalOptions };
}

export function applyPolicyBandRemoval<T extends RemovablePolicyBand>(
  bands: readonly T[],
  bandId: string,
  targetBandId?: string,
  options: PolicyBandRemovalOptions = {},
): T[] {
  const plan = getPolicyBandRemovalPlan(bands, bandId, options);
  if (plan.kind === "BLOCKED") throw new Error(plan.message);
  if (plan.kind === "DIRECT") {
    if (targetBandId) throw new Error("La banda nueva se quita sin reasignar puntajes.");
    return bands.filter((band) => band.id !== bandId);
  }
  const target = plan.options.find((item) => item.targetBandId === targetBandId);
  if (!target) throw new Error("Selecciona una banda vecina de la misma plataforma para cubrir el rango eliminado.");
  return bands
    .filter((band) => band.id !== bandId)
    .map((band) => band.id === target.targetBandId
      ? { ...band, scoreMin: String(target.scoreMin), scoreMax: String(target.scoreMax) }
      : band);
}
