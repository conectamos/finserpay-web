import { MASS_CREDIT_SOURCE } from "./credit-import-flags";

// Only server-owned import markers qualify: free-form observations never exempt
// a new factory credit. Missing policy fails closed and is reported by the API.
export function buildCreditApprovalRequiredSql(alias = "credit") {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
    throw new Error("Invalid credit SQL alias");
  }
  return `(
    NOT EXISTS (SELECT 1 FROM "CreditApprovalPolicy" WHERE "id" = 1)
    OR EXISTS (SELECT 1 FROM "CreditApprovalReview" approval_scope WHERE approval_scope."creditoId" = ${alias}."id")
    OR (
      ${alias}."createdAt" >= (SELECT "activatedAt" FROM "CreditApprovalPolicy" WHERE "id" = 1)
      AND NOT (
        COALESCE(${alias}."equalityService", '') = '${MASS_CREDIT_SOURCE}'
        AND COALESCE(${alias}."contratoSnapshot" #>> '{origen,tipo}', '') = '${MASS_CREDIT_SOURCE}'
      )
    )
  )`;
}
