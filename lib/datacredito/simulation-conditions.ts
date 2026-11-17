import {
  resolveDataCreditoDecision,
  type DataCreditoOffer,
  type DataCreditoPlatform,
  type DataCreditoPolicy,
} from "./policy";

export type DataCreditoSimulationCondition = {
  id: string;
  offer: DataCreditoOffer;
};

/** Quotes approved terms without evaluating a person or disclosing score bands. */
export function getDataCreditoSimulationConditions(
  policy: DataCreditoPolicy,
  platform: DataCreditoPlatform
): DataCreditoSimulationCondition[] {
  const conditions: DataCreditoSimulationCondition[] = [];
  const seen = new Set<string>();
  const approvedBands = policy.bands
    .filter((band) => band.platform === platform && band.decision === "APROBADO" &&
      Number.isFinite(band.initialPaymentPercentage) &&
      band.initialPaymentPercentage >= 0 && band.initialPaymentPercentage <= 100)
    .sort((left, right) => left.scoreMin - right.scoreMin || left.scoreMax - right.scoreMax);

  for (const band of approvedBands) {
    const resolution = resolveDataCreditoDecision(
      { ...policy, bands: [band], priorityRules: null },
      platform,
      band.scoreMin
    );
    if (resolution?.decision !== "APROBADO") continue;
    const offer = resolution.offer;
    const fingerprint = JSON.stringify(offer);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    conditions.push({ id: `condition-${conditions.length + 1}`, offer });
  }
  return conditions;
}
