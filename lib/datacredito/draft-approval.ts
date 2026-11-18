/** SQL fragments accept only internal aliases/placeholders, never request text. */
export function boundDataCreditoDraftExpirySql(
  assessment: "assessment" | "target",
  draftParameter: "$10" | "$11" | "$3",
  documentParameter: "$11" | "$12" | "$4",
  finalizedCreditParameter?: "$5"
) {
  const state = finalizedCreditParameter
    ? `d."estado" = 'CERRADO' AND d."closedReason" = 'FINALIZADA' AND d."creditoId" = ${finalizedCreditParameter}::integer`
    : `d."estado" = 'ABIERTO' AND d."creditoId" IS NULL`;
  return `(SELECT COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days')
    FROM "CreditoBorrador" d JOIN "Sede" s ON s."id" = d."sedeId"
    WHERE d."id" = ${draftParameter}::integer AND (${state})
      AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > clock_timestamp()
      AND COALESCE(d."dataCreditoAssessmentId"::text, NULLIF(d."payload"->>'dataCreditoAssessmentId','')) = ${assessment}."id"::text
      AND (NULLIF(d."payload"->>'dataCreditoAssessmentId','') IS NULL OR d."payload"->>'dataCreditoAssessmentId' = ${assessment}."id"::text)
      AND REGEXP_REPLACE(COALESCE(d."clienteDocumento",''),'[^0-9]','','g') = ${documentParameter}::text
      AND REGEXP_REPLACE(COALESCE(d."clienteDocumento",''),'[^0-9]','','g') ~ '^[0-9]{3,13}$'
      AND REGEXP_REPLACE(COALESCE(d."payload"->>'clienteDocumento',''),'[^0-9]','','g') = ${documentParameter}::text
      AND RIGHT(REGEXP_REPLACE(COALESCE(d."clienteDocumento",''),'[^0-9]','','g'),4) = ${assessment}."documentLast4"
      AND UPPER(COALESCE(NULLIF(d."plataforma",''),d."payload"->>'plataformaDispositivo')) = ${assessment}."platform"
      AND d."usuarioId" = ${assessment}."userId" AND d."vendedorId" IS NOT DISTINCT FROM ${assessment}."sellerId"
      AND d."sedeId" = ${assessment}."sedeId" AND s."aliadoId" IS NOT DISTINCT FROM ${assessment}."aliadoId"
      AND ${assessment}."status" = 'APROBADO' AND ${assessment}."retainedUntil" > clock_timestamp()
      AND ${assessment}."consumedAt" IS NULL AND ${assessment}."creditId" IS NULL
    LIMIT 1)`;
}

export function dataCreditoApprovalDraftId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value : null;
}
