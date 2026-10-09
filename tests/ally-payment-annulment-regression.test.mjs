import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { calculateAllySettlementBalance } from "../lib/ally-payments-core.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (relativePath) =>
  readFile(path.join(projectRoot, relativePath), "utf8");

const [
  schema,
  predeploy,
  paymentsStorage,
  annulmentService,
  annulCreditRoute,
  paymentTypes,
  paymentConsole,
  paymentViews,
  historicalDetail,
  paymentStyles,
  paymentViewStyles,
  historicalStyles,
  pdfRoute,
  pdfBuilder,
] = await Promise.all([
  readProjectFile("prisma/schema.prisma"),
  readProjectFile("scripts/ensure-ally-payments-schema.mjs"),
  readProjectFile("lib/ally-payments.ts"),
  readProjectFile("lib/ally-payment-annulments.ts"),
  readProjectFile("app/api/creditos/[id]/command/route.ts"),
  readProjectFile("app/dashboard/pagos-aliados/ally-payment-types.ts"),
  readProjectFile("app/dashboard/pagos-aliados/ally-payments-console.tsx"),
  readProjectFile("app/dashboard/pagos-aliados/ally-payment-views.tsx"),
  readProjectFile("app/dashboard/pagos-aliados/historical-settlement-detail.tsx"),
  readProjectFile("app/dashboard/pagos-aliados/ally-payments-console.module.css"),
  readProjectFile("app/dashboard/pagos-aliados/ally-payment-views.module.css"),
  readProjectFile("app/dashboard/pagos-aliados/historical-settlement-detail.module.css"),
  readProjectFile("app/api/pagos-aliados/[id]/comprobante/route.ts"),
  readProjectFile("lib/ally-payment-settlement-pdf.ts"),
]);

function modelBlock(modelName) {
  const startMarker = `model ${modelName} {`;
  const start = schema.indexOf(startMarker);
  assert.notEqual(start, -1, `No se encontro el modelo ${modelName}`);
  const nextModel = schema.indexOf("\nmodel ", start + startMarker.length);
  return schema.slice(start, nextModel === -1 ? schema.length : nextModel);
}

function functionBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `No se encontro ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1;
  return source.slice(start, end === -1 ? source.length : end);
}

test("descuenta exactamente el valor historico pagado sin recalcularlo", () => {
  const valorPagadoHistorico = 1_275_000;

  assert.deepEqual(calculateAllySettlementBalance(0, 0, valorPagadoHistorico), {
    totalPagarCreditos: 0,
    totalRecaudosAliado: 0,
    totalAjustesAnulacion: valorPagadoHistorico,
    saldoNeto: -valorPagadoHistorico,
    direccionSaldo: "CONSIGNACION_ALIADO",
    valorPagarAliado: 0,
    valorConsignarAliado: valorPagadoHistorico,
  });
});

test("un ajuste solo genera consignacion y la mezcla resta recaudos y anulaciones una vez", () => {
  assert.equal(
    calculateAllySettlementBalance(0, 0, 1_275_000).direccionSaldo,
    "CONSIGNACION_ALIADO"
  );

  assert.deepEqual(calculateAllySettlementBalance(5_000_000, 700_000, 1_275_000), {
    totalPagarCreditos: 5_000_000,
    totalRecaudosAliado: 700_000,
    totalAjustesAnulacion: 1_275_000,
    saldoNeto: 3_025_000,
    direccionSaldo: "PAGO_ALIADO",
    valorPagarAliado: 3_025_000,
    valorConsignarAliado: 0,
  });

  assert.equal(
    calculateAllySettlementBalance(2_000_000, 900_000, 1_275_000).saldoNeto,
    -175_000
  );
});

test("el esquema conserva un evento pendiente y una aplicacion inmutable e idempotente", () => {
  const pending = modelBlock("AjusteAnulacionCreditoAliado");
  const applied = modelBlock("LiquidacionAliadoAjusteAnulacion");
  const settlement = modelBlock("LiquidacionAliado");

  assert.match(pending, /creditoId\s+Int\s+@unique/);
  assert.match(pending, /liquidacionCreditoOrigenId\s+Int\s+@unique/);
  assert.match(pending, /valorDescuento\s+Decimal/);
  assert.match(pending, /fechaAnulacion\s+DateTime/);
  assert.match(applied, /ajusteId\s+Int\s+@unique/);
  assert.match(applied, /liquidacionId\s+Int/);
  assert.match(applied, /valorDescuento\s+Decimal/);
  assert.match(settlement, /numeroAjustesAnulacion\s+Int/);
  assert.match(settlement, /totalAjustesAnulacion\s+Decimal/);
});

test("el backfill descubre cualquier credito pagado y anulado, sin casos particulares", () => {
  const transactionStart = predeploy.indexOf('client.query("BEGIN")');
  const readCommitted = predeploy.indexOf(
    'client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")'
  );
  const firstTransactionalSnapshot = predeploy.indexOf(
    "SELECT pg_advisory_xact_lock"
  );
  const cutoverLock = predeploy.indexOf(
    'LOCK TABLE public."Credito" IN SHARE ROW EXCLUSIVE MODE'
  );
  const compatibilityTrigger = predeploy.indexOf(
    'CREATE TRIGGER "Credito_capture_paid_annulment_adjustment"'
  );
  const backfill = predeploy.lastIndexOf(
    'INSERT INTO public."AjusteAnulacionCreditoAliado"'
  );

  assert.match(predeploy, /INSERT\s+INTO\s+(?:public\.)?"AjusteAnulacionCreditoAliado"/i);
  assert.match(predeploy, /FROM\s+(?:public\.)?"LiquidacionAliadoCredito"/i);
  assert.match(predeploy, /JOIN\s+(?:public\.)?"Credito"/i);
  assert.match(predeploy, /ANULAD[OA]|CANCELAD[OA]/i);
  assert.match(predeploy, /ON\s+CONFLICT[\s\S]*?DO\s+NOTHING/i);
  assert.match(predeploy, /try_parse_ally_payment_annulment_timestamp/);
  assert.match(predeploy, /Credito_capture_paid_annulment_adjustment/);
  assert.match(predeploy, /AFTER\s+UPDATE\s+OF\s+"estado"\s+ON\s+public\."Credito"/i);
  assert.match(predeploy, /clock_timestamp\(\)\s+AT\s+TIME\s+ZONE\s+'UTC'/i);
  assert.doesNotMatch(predeploy, /WHERE\s+credit\."id"\s*=\s*\d+/i);
  assert.ok(
    transactionStart >= 0 &&
      transactionStart < readCommitted &&
      readCommitted < firstTransactionalSnapshot
  );
  assert.ok(cutoverLock >= 0 && cutoverLock < compatibilityTrigger);
  assert.ok(compatibilityTrigger < backfill);
});

test("anular un credito registra el ajuste dentro de la misma transaccion", () => {
  const handler = functionBlock(
    annulCreditRoute,
    'case "annul-credit"',
    "default:"
  );

  assert.match(
    annulCreditRoute,
    /import\s*{[^}]*registerPaidCreditAnnulmentAdjustment[^}]*}\s*from\s*["']@\/lib\/ally-payment-annulments["']/s
  );
  assert.match(handler, /prisma\.\$transaction\s*\(/);
  assert.match(handler, /transaction\.credito\.update|tx\.credito\.update/);
  assert.match(handler, /registerPaidCreditAnnulmentAdjustment\s*\(/);
  assert.ok(
    handler.indexOf("registerPaidCreditAnnulmentAdjustment") <
      handler.indexOf("const updated = await tx.credito.update"),
    "El evento auditado debe existir antes del UPDATE que activa el trigger de compatibilidad."
  );
  assert.match(
    handler,
    /registerPaidCreditAnnulmentAdjustment\s*\(\s*(?:transaction|tx)\s*,|(?:transaction|tx)\s*:/
  );
});

test("el servidor carga, congela y expone ajustesAnulacion sin editar la liquidacion original", () => {
  const registration = functionBlock(
    annulmentService,
    "export async function registerPaidCreditAnnulmentAdjustment",
    "export async function loadPendingAllyPaymentAnnulmentAdjustments"
  );

  assert.match(
    annulmentService,
    /export\s+async\s+function\s+registerPaidCreditAnnulmentAdjustment/
  );
  assert.match(
    annulmentService,
    /export\s+async\s+function\s+loadPendingAllyPaymentAnnulmentAdjustments/
  );
  assert.match(registration, /LiquidacionAliadoCredito|liquidacionAliadoCredito/);
  assert.match(registration, /paid_credit\."valorPagar"/);
  assert.match(registration, /ON\s+CONFLICT\s*\(\s*"creditoId"\s*\)\s+DO\s+NOTHING/i);
  assert.doesNotMatch(
    registration,
    /UPDATE\s+(?:public\.)?"LiquidacionAliado(?:Credito)?"/i
  );
  assert.match(
    annulmentService,
    /LEFT\s+JOIN\s+(?:public\.)?"LiquidacionAliadoAjusteAnulacion"\s+application/i
  );
  assert.match(annulmentService, /application\."id"\s+IS\s+NULL/i);
  assert.match(paymentsStorage, /ajustesAnulacion/);
  assert.match(paymentsStorage, /numeroAjustesAnulacion/);
  assert.match(paymentsStorage, /totalAjustesAnulacion/);
});

test("UI e historico muestran el descuento en rojo y el PDF recibe el mismo snapshot", () => {
  const ui = paymentConsole + paymentViews + historicalDetail;
  const styles = paymentStyles + paymentViewStyles + historicalStyles;
  for (const source of [paymentTypes, ui]) {
    assert.match(source, /ajustesAnulacion/);
  }
  assert.match(paymentTypes, /PaymentAnnulmentAdjustmentItem/);
  assert.match(ui, /Cr[eé]ditos anulados/);
  assert.match(ui, /Descuentos por cr[eé]ditos anulados/);
  assert.match(ui, /Pendiente de descuento/i);
  assert.match(annulmentService, /estado:\s*"DESCONTADO"/);
  assert.match(
    historicalDetail,
    /annulmentCount\s*>\s*0\s*\?\s*annulmentDetail\s*:\s*null/
  );
  assert.match(
    paymentConsole,
    /annulmentDetail=\{<AnnulmentAdjustmentItems\s+items=\{annulmentAdjustmentItems\(selectedSettlement\)}/
  );
  assert.match(ui, /styles\.annulledRow/);
  assert.match(styles, /\.annulledRow\s*{/);
  assert.match(styles, /--fp-danger|#(?:b91c1c|dc2626|ef4444)/i);

  assert.match(pdfRoute, /ajustesAnulacion/);
  assert.match(pdfRoute, /annulmentAdjustments/);
  assert.match(pdfRoute, /totalAnnulmentAdjustments/);
  assert.match(pdfBuilder, /annulmentAdjustments/);
  assert.match(pdfBuilder, /Descuentos por cr[eé]ditos anulados/);
  assert.match(pdfBuilder, /Descontado/i);
});
