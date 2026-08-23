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
const jiti = createJiti(import.meta.url);
const { buildCreditPaymentHref } = await jiti.import(
  "../lib/credit-payment-navigation.ts"
);

test("abre recaudos con el documento y el credito seleccionados", () => {
  assert.equal(
    buildCreditPaymentHref({
      id: 59,
      clienteDocumento: "1234567890",
      clienteTelefono: "3000000000",
      folio: "FC-TEST-59",
    }),
    "/dashboard/abonos?search=1234567890&selected=59"
  );
});

test("usa telefono o folio cuando el credito no tiene documento", () => {
  assert.equal(
    buildCreditPaymentHref({
      id: 7,
      clienteDocumento: " ",
      clienteTelefono: "+57 314 420 1136",
      folio: "FC-7",
    }),
    "/dashboard/abonos?search=%2B57+314+420+1136&selected=7"
  );

  assert.equal(
    buildCreditPaymentHref({ id: 8, folio: "FC/2026 008" }),
    "/dashboard/abonos?search=FC%2F2026+008&selected=8"
  );
});

test("los accesos de abono son enlaces reales y no dependen de window.location", async () => {
  const source = await readFile(
    path.join(
      projectRoot,
      "app",
      "dashboard",
      "creditos",
      "credit-factory-console.tsx"
    ),
    "utf8"
  );

  assert.match(
    source,
    /<Link\s+href=\{buildCreditPaymentHref\(selectedCredit\)\}/
  );
  assert.match(source, /href=\{buildCreditPaymentHref\(credit\)\}/);
  assert.doesNotMatch(
    source,
    /window\.location\.assign\(`\/dashboard\/abonos/
  );
  assert.match(
    source,
    /if \(paymentsView && preserveSelected && selectedId\) \{\s+params\.set\("id", String\(selectedId\)\);/
  );
});
