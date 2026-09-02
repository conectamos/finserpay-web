import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveCapitalOriginal } from "../lib/credit-capital.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("usa el capital financiado y excluye intereses y fianza", () => {
  assert.equal(
    resolveCapitalOriginal({
      montoCredito: 1_300_000,
      saldoBaseFinanciado: 1_000_000,
      valorFianza: 100_000,
      valorInteres: 200_000,
    }),
    1_000_000
  );

  assert.equal(
    resolveCapitalOriginal({
      montoCredito: 1_300_000,
      saldoBaseFinanciado: 0,
      valorFianza: 100_000,
      valorInteres: 200_000,
    }),
    1_000_000
  );

  assert.equal(
    resolveCapitalOriginal({
      cuotaInicial: 300_000,
      montoCredito: 1_450_000,
      saldoBaseFinanciado: 0,
      valorEquipoTotal: 1_300_000,
      valorFianza: 100_000,
      valorInteres: 150_000,
    }),
    1_000_000
  );
});

test("el panel aliado suma capital colocado sin alterar el saldo de salud", async () => {
  const source = await readFile(
    path.join(projectRoot, "app/dashboard/_lib/admin-dashboard-data.ts"),
    "utf8"
  );

  assert.match(source, /capitalColocado:\s*resolveCapitalOriginal/);
  assert.match(source, /activePlacedCapital = activePortfolio\.reduce/);
  assert.match(source, /point\.placedCapital \+= credit\.capitalColocado/);
  assert.match(source, /healthyBalance[\s\S]*credit\.saldoPendiente/);
  assert.doesNotMatch(source, /point\.placedCapital \+= Number\(credit\.montoCredito/);
});

test("la interfaz identifica las cifras como capital colocado", async () => {
  const source = await readFile(
    path.join(projectRoot, "app/dashboard/_components/admin-central-dashboard.tsx"),
    "utf8"
  );

  assert.match(source, /label: "Capital colocado"/);
  assert.match(source, /money\(overview\.monthlyPlacedCapital\)/);
  assert.match(source, /money\(data\.activePlacedCapital\)/);
  assert.match(source, /Capital colocado en \$\{data\.activeCredits\} creditos activos/);
});
