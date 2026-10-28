// Read-only eligibility used by application listings and enrollment. Financial
// actions still resolve and consume the independently authorized decision.
export function activeRiskExceptionSql(input: {
  draft: "d";
  assessment: "dc";
  allyId: 's."aliadoId"' | 'aliado."id"';
}) {
  const { draft: d, assessment: a, allyId } = input;
  return `EXISTS (
    SELECT 1 FROM "CreditRiskException" risk_exception
    WHERE risk_exception."id" = ${d}."creditRiskExceptionId"
      AND risk_exception."solicitudId" = ${d}."id"
      AND risk_exception."assessmentId" = ${a}."id"
      AND risk_exception."solicitudId" = 4098
      AND risk_exception."assessmentId" = '4d14cb36-dec9-4b08-9532-ed0739bdcbc4'::uuid
      AND risk_exception."documentHash" = ${a}."documentHash"
      AND risk_exception."surnameHash" = ${a}."surnameHash"
      AND risk_exception."platform" = ${a}."platform"
      AND risk_exception."providerEnvironment" = ${a}."providerEnvironment"
      AND risk_exception."userId" = ${d}."usuarioId"
      AND risk_exception."sellerId" IS NOT DISTINCT FROM ${d}."vendedorId"
      AND risk_exception."sedeId" = ${d}."sedeId"
      AND risk_exception."aliadoId" IS NOT DISTINCT FROM ${allyId}
      AND ${a}."userId" = risk_exception."userId"
      AND ${a}."sellerId" IS NOT DISTINCT FROM risk_exception."sellerId"
      AND ${a}."sedeId" = risk_exception."sedeId"
      AND ${a}."aliadoId" IS NOT DISTINCT FROM risk_exception."aliadoId"
      AND UPPER(COALESCE(NULLIF(${d}."plataforma", ''), ${d}."payload"->>'plataformaDispositivo')) = risk_exception."platform"
      AND ${d}."estado" = 'ABIERTO' AND ${d}."creditoId" IS NULL
      AND COALESCE(${d}."expiresAt", ${d}."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
      AND ${a}."status" = 'NO_EVALUADO' AND ${a}."errorCode" = 'NO_EVALUABLE_INFORMATION'
      AND ${a}."providerStatus" = 'ACCEPTED' AND ${a}."transactionCode" = '07'
      AND ${a}."score" IS NULL AND ${a}."decision" IS NULL AND ${a}."offer" IS NULL
      AND ${a}."reusedFromAssessmentId" IS NULL
      AND ${a}."consumedAt" IS NULL AND ${a}."creditId" IS NULL
      AND ${a}."expiresAt" > CURRENT_TIMESTAMP AND ${a}."retainedUntil" > CURRENT_TIMESTAMP
      AND risk_exception."riskAcknowledged" = TRUE
      AND risk_exception."providerStatus" = 'ACCEPTED'
      AND risk_exception."transactionCode" = '07' AND risk_exception."historyCode" = '09'
      AND risk_exception."errorCode" = 'NO_EVALUABLE_INFORMATION'
      AND risk_exception."expiresAt" > CURRENT_TIMESTAMP
      AND risk_exception."revokedAt" IS NULL AND risk_exception."consumedAt" IS NULL
      AND risk_exception."creditId" IS NULL
  )`;
}
