import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { splitOutstandingBalance } = await jiti.import("../lib/credit-outstanding-balance.ts");
const { createPrincipalPaymentQuote, parseCapitalPlanSnapshot } = await jiti.import("../lib/credit-principal-payment.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");

test("separa el saldo pendiente sin cambiar la proporcion financiera", () => {
  assert.deepEqual(
    splitOutstandingBalance({
      cuotaInicial: 0,
      montoCredito: 1_000_000,
      saldoBaseFinanciado: 800_000,
      saldoPendiente: 500_000,
      valorEquipoTotal: 800_000,
      valorFianza: 100_000,
      valorInteres: 100_000,
    }),
    {
      saldoCapital: 400_000,
      saldoFianza: 50_000,
      saldoIntereses: 50_000,
    }
  );
});

test("atribuye al capital un saldo legado sin desglose financiero", () => {
  assert.deepEqual(
    splitOutstandingBalance({
      cuotaInicial: 0,
      montoCredito: 0,
      saldoBaseFinanciado: 0,
      saldoPendiente: 250_000,
      valorEquipoTotal: 0,
      valorFianza: 0,
      valorInteres: 0,
    }),
    {
      saldoCapital: 250_000,
      saldoFianza: 0,
      saldoIntereses: 0,
    }
  );
});

test("cartera muestra el capital comprometido total y por credito en mora", async () => {
  const source = await readFile(
    path.join(projectRoot, "app/dashboard/cartera/page.tsx"),
    "utf8"
  );

  assert.match(source, /label="Capital comprometido"/);
  assert.match(source, /value=\{money\(totalCapitalComprometidoMora\)\}/);
  assert.match(source, />Capital pendiente</);
  assert.match(source, /money\(item\.saldoCapital\)/);
  assert.match(source, /const overdueCredits = activeCredits\.filter/);
});

test("un abono extraordinario usa capital real del calendario revisado y no la proporcion original", () => {
  const terms = { montoCredito: 149700 * 48, valorCuota: 149700, plazoMeses: 48,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26" };
  const abonos = [{ id: 1, valor: 150000 }, { id: 2, valor: 300000 }];
  const quote = createPrincipalPaymentQuote({
    plan: buildCreditPaymentPlan({ ...terms, abonos }), abonos,
    valor: 700000, capitalOriginal: 3500000, cuotaHabitual: 149700,
    conciliacion: { capitalPendiente: 3347264, tasaPeriodo: 0.010881, cuotaCredito: 94470,
      fianzaCuota: 54180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Referencia de prueba sin datos personales" },
  });
  const snapshot = parseCapitalPlanSnapshot({ ...quote.planCapitalVigente,
    abonosAlCorte: [...abonos, { id: 3, valor: 700000 }] });
  const result = splitOutstandingBalance({ montoCredito: quote.montoCreditoActualizado,
    saldoBaseFinanciado: 3500000, saldoPendiente: quote.saldoPendienteDespues,
    valorEquipoTotal: 4500000, cuotaInicial: 1000000, valorFianza: 2600640,
    valorInteres: 1000000, totalAbonado: 1150000, planCapitalVigente: snapshot });
  assert.equal(result.saldoCapital, 2647264);
  assert.equal(result.saldoFianza, 34 * 54180);
  assert.equal(result.saldoSeguro, 34 * 1050);
  assert.equal(Object.values(result).reduce((sum, value) => sum + value, 0), quote.saldoPendienteDespues);
});
