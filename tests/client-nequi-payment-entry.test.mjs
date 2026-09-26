import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("el pago del inicio abre Nequi con el resumen actual de cuotas", async () => {
  const [pageSource, dashboardSource] = await Promise.all([
    readFile(path.join(projectRoot, "app/clientes/page.tsx"), "utf8"),
    readFile(
      path.join(projectRoot, "app/clientes/client-active-credit-dashboard.tsx"),
      "utf8"
    ),
  ]);

  assert.match(dashboardSource, /onPayInstallment: \(\) => void/);
  assert.match(dashboardSource, /onClick=\{onPayInstallment\}/);
  assert.doesNotMatch(dashboardSource, /onOpenPaymentMethods/);

  assert.match(
    pageSource,
    /const payment = resolveHomeInstallmentPayment\(credit\);[\s\S]*?openWompiConfirm\(credit, "INSTALLMENTS", payment.installmentLimit\);/
  );
  assert.match(
    pageSource,
    /onPayInstallment=\{\(\) => openNextInstallmentWompiConfirm\(activeCredit\)\}/
  );
  assert.doesNotMatch(
    pageSource,
    /onPayInstallment=\{\(\) => openPanel\("payments"\)\}/
  );

  assert.match(pageSource, /<ClientNequiPaymentDialog/);
  assert.match(pageSource, /amount=\{confirmAmount\}/);
  assert.match(pageSource, /installmentLabel=\{confirmPaymentLabel\}/);
  assert.match(pageSource, /onSubmit=\{\(\) => void payWithWompi\(confirmCredit\)\}/);
});
