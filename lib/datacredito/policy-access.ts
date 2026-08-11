export const DATA_CREDITO_INCLUDE_DISABLED_POLICY_PARAM =
  "includeDisabledPolicy";

export function shouldLoadDataCreditoPolicy(input: {
  enabled: boolean;
  centralAdmin: boolean;
  includeDisabledPolicy: boolean;
}) {
  return input.enabled || (input.centralAdmin && input.includeDisabledPolicy);
}
