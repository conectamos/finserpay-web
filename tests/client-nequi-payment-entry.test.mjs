import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("Pagar cuota abre directamente la confirmacion Nequi para la proxima cuota", async () => {
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
    /const openNextInstallmentWompiConfirm = \(credit: ClientCredit\) => \{\s+const nextInstallment = getPayableInstallments\(credit\)\[0\];\s+openWompiConfirm\(credit, "INSTALLMENTS", nextInstallment\?\.numero\);/
  );
  assert.match(
    pageSource,
    /onPayInstallment=\{\(\) => openNextInstallmentWompiConfirm\(activeCredit\)\}/
  );
  assert.doesNotMatch(
    pageSource,
    /onPayInstallment=\{\(\) => openPanel\("payments"\)\}/
  );

  assert.match(pageSource, /Nequi por Wompi/);
  assert.match(pageSource, /Numero Nequi/);
  assert.match(pageSource, /Enviar a Nequi/);
});
