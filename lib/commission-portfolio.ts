import { buildCreditPaymentPlan } from "./credit-payment-plan";
import type { AdminCommissionBag } from "./commissions";
import type { CommissionDbClient } from "./commissions-storage";

type PortfolioRow = {
  allyId: number; allyName: string; creditId: number | null;
  montoCredito: number; valorCuota: number; plazoMeses: number;
  frecuenciaPago: string; fechaPrimerPago: Date | null; fechaProximoPago: Date | null;
  planCapitalVigente: unknown; pazYSalvoEmitidoAt: Date | null; paid: number;
};

/** Same outstanding-credit / overdue-installment criterion as the central portfolio.
 * Compare cents before formatting percentages: 7.999% must not become an 8% block. */
export function commissionBagFromBalances(allyId: number, allyName: string, totalCents: number, overdueCents: number): AdminCommissionBag {
  return {
    allyId, allyName, totalBalance: totalCents / 100, overdueBalance: overdueCents / 100,
    overduePercent: totalCents > 0 ? overdueCents * 100 / totalCents : 0,
    paused: totalCents > 0 && BigInt(overdueCents) * BigInt(100) >= BigInt(totalCents) * BigInt(8),
  };
}

/** One SQL snapshot includes credit terms and real, non-annulled payments.
 * Membership is server-owned: active assignments plus allies backing unpaid
 * commission periods, so switching branches cannot bypass a paused bag. */
export async function readCommissionBags(tx: CommissionDbClient, now: Date, sellerId?: number): Promise<AdminCommissionBag[]> {
  const rows = await tx.$queryRawUnsafe<PortfolioRow[]>(`
    WITH selected_allies AS (
      SELECT a.id, a.nombre FROM "Aliado" a
      WHERE $1::integer IS NULL OR a.id IN (
        SELECT s."aliadoId" FROM "SedeVendedor" sv JOIN "Sede" s ON s.id=sv."sedeId"
        WHERE sv."vendedorId"=$1 AND sv.activo=true
        UNION
        SELECT COALESCE((item->>'allyId')::integer,s."aliadoId") FROM "CommissionPeriod" p
        CROSS JOIN LATERAL jsonb_array_elements(p.credits) item
        JOIN "Credito" c ON c.id=(item->>'id')::integer
        JOIN "Sede" s ON s.id=c."sedeId"
        WHERE p."sellerId"=$1 AND p.generated > (
          SELECT COALESCE(sum(r.amount),0) FROM "CommissionRequest" r
          WHERE r."sellerId"=p."sellerId" AND r.period=p.period AND r.status='PAID'
        )
      )
    )
    SELECT a.id AS "allyId",a.nombre AS "allyName",c.id AS "creditId",
      c."montoCredito",c."valorCuota",c."plazoMeses",c."frecuenciaPago",
      c."fechaPrimerPago",c."fechaProximoPago",c."planCapitalVigente",c."pazYSalvoEmitidoAt",
      COALESCE(payments.paid,0)::double precision AS paid
    FROM selected_allies a
    LEFT JOIN "Sede" s ON s."aliadoId"=a.id
    LEFT JOIN "Credito" c ON c."sedeId"=s.id
      AND upper(c.estado) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA','BORRADOR','PENDIENTE')
      AND COALESCE(c."contratoSnapshot"#>>'{comisiones,isTest}','false')<>'true'
      AND COALESCE(c."contratoSnapshot"->>'isTest','false')<>'true'
      AND COALESCE(c."contratoSnapshot"->>'testMode','false')<>'true'
      AND COALESCE(c."contratoSnapshot"->>'modoPrueba','false')<>'true'
      AND COALESCE(c."contratoSnapshot"->>'duplicateOfCreditId','')=''
      AND NOT EXISTS(SELECT 1 FROM "CommissionCreditSource" cs WHERE cs."creditId"=c.id AND cs."isTest"=true)
    LEFT JOIN LATERAL (
      SELECT sum(ab.valor) AS paid FROM "CreditoAbono" ab
      WHERE ab."creditoId"=c.id AND upper(ab.estado) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA') AND ab.valor>0
    ) payments ON true
    ORDER BY a.nombre,a.id,c.id`, sellerId ?? null);
  const balances = new Map<number, { name: string; total: number; overdue: number }>();
  for (const row of rows) {
    const balance = balances.get(row.allyId) ?? { name: row.allyName, total: 0, overdue: 0 };
    balances.set(row.allyId, balance);
    if (!row.creditId || row.pazYSalvoEmitidoAt) continue;
    const plan = buildCreditPaymentPlan({
      ...row, abonos: [{ valor: Number(row.paid) }], today: now,
    });
    const cents = Math.round(plan.saldoPendiente * 100);
    if (cents <= 0) continue;
    balance.total += cents;
    if (plan.installments.some(installment => installment.estaEnMora && installment.saldoPendiente > 0)) balance.overdue += cents;
  }
  return [...balances].map(([id, value]) => commissionBagFromBalances(id, value.name, value.total, value.overdue));
}
