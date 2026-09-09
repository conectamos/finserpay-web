import { buildCreditApprovalRequiredSql } from "./credit-approval-policy";
import {
  ALLY_PAYMENTS_AVAILABLE_FROM,
  resolveColombiaPaymentPeriod,
} from "./ally-payments-core";

// One-time opening-period exception authorized on 2026-09-08.
// Evidence and rollback: docs/ALLY_PAYMENT_DATE_EXCEPTION_20260908.md.
export const ALLY_PAYMENT_DATE_EXCEPTION = Object.freeze({
  creditId: 189,
  allyId: 65588,
  originalDate: "2026-08-31T17:08:40.184Z",
  effectiveDate: "2026-09-01T05:00:00.000Z",
  reference: "ALLY_PAYMENT_20260908_C189",
});

export function buildAllyPaymentEligibilityQuery(input: {
  allyId: number | null;
  start?: Date;
  endExclusive?: Date;
  lock?: boolean;
}) {
  const exception = ALLY_PAYMENT_DATE_EXCEPTION;
  const approvalRequired = buildCreditApprovalRequiredSql("credit");
  const query = `
      SELECT credit."id", credit."fechaCredito", credit."folio",
        eligibility."fechaLiquidacion",
        CASE WHEN ${approvalRequired} THEN approval."revision" ELSE NULL END AS "approvalRevision",
        credit."clienteNombre", credit."clienteDocumento", credit."imei",
        credit."deviceUid", credit."referenciaEquipo", credit."equipoMarca",
        credit."equipoModelo", credit."valorEquipoTotal", credit."cuotaInicial",
        credit."contratoSnapshot", ally."id" AS "aliadoId",
        ally."nombre" AS "aliadoNombre",
        ally."redescuentoPorcentaje",
        ally."redescuentoAndroidPorcentaje",
        ally."redescuentoIphonePorcentaje"
      FROM "Credito" credit
      JOIN "Sede" site ON site."id" = credit."sedeId"
      JOIN "Aliado" ally ON ally."id" = site."aliadoId"
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN credit."id" = $7::integer
            AND ally."id" = $8::integer
            AND credit."fechaCredito" = $9::timestamp
          THEN $10::timestamp
          ELSE credit."fechaCredito"
        END AS "fechaLiquidacion"
      ) eligibility
      LEFT JOIN "CreditApprovalReview" approval ON approval."creditoId" = credit."id"
      LEFT JOIN "LiquidacionAliadoCredito" paid
        ON paid."creditoId" = credit."id"
      WHERE paid."id" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "CreditApprovalNovelty" novelty WHERE novelty."creditoId"=credit."id" AND novelty."status"<>'RESOLVED')
        AND EXISTS (SELECT 1 FROM "CreditApprovalPolicy" WHERE "id" = 1)
        AND (NOT ${approvalRequired} OR
          (approval."status" = 'APPROVED' AND approval."approvedRevision" = approval."revision"))
        AND UPPER(BTRIM(COALESCE(credit."estado", ''))) <> ALL($4::text[])
        AND UPPER(BTRIM(COALESCE(ally."codigo", ''))) <> $5
        AND ($1::integer IS NULL OR ally."id" = $1)
        AND eligibility."fechaLiquidacion" >= $6::timestamp
        AND ($2::timestamp IS NULL OR eligibility."fechaLiquidacion" >= $2)
        AND ($3::timestamp IS NULL OR eligibility."fechaLiquidacion" < $3)
      ORDER BY eligibility."fechaLiquidacion" ASC, credit."id" ASC` +
    (input.lock ? " FOR UPDATE OF credit" : "");

  return {
    query,
    values: [
      input.allyId,
      input.start?.toISOString() || null,
      input.endExclusive?.toISOString() || null,
      ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"],
      "FINSERPAY",
      resolveColombiaPaymentPeriod(
        ALLY_PAYMENTS_AVAILABLE_FROM,
        ALLY_PAYMENTS_AVAILABLE_FROM
      ).start.toISOString(),
      exception.creditId,
      exception.allyId,
      exception.originalDate,
      exception.effectiveDate,
    ],
  };
}
