import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { splitOutstandingBalance } from "../lib/credit-outstanding-balance.ts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

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
