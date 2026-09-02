import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveCapitalOriginal } from "../lib/credit-capital.ts";
import { resolveDashboardMonth } from "../lib/dashboard-month.ts";

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

test("el rendimiento agrupa por perfil y muestra monto y unidades de credito", async () => {
  const dataSource = await readFile(
    path.join(projectRoot, "app/dashboard/_lib/admin-dashboard-data.ts"),
    "utf8"
  );
  const uiSource = await readFile(
    path.join(projectRoot, "app/dashboard/_components/admin-central-dashboard.tsx"),
    "utf8"
  );

  assert.match(dataSource, /const performanceGroup = aliadoId \? "sede" : "aliado"/);
  assert.match(
    dataSource,
    /performanceGroup === "aliado" \? credit\.aliadoNombre : credit\.sedeNombre/
  );
  assert.match(dataSource, /units: currentPerformance\.units \+ 1/);
  assert.match(dataSource, /value: currentPerformance\.value \+ credit\.capitalColocado/);
  assert.doesNotMatch(dataSource, /collectionBySede/);
  assert.doesNotMatch(dataSource, /creditPerformance[\s\S]{0,240}\.slice\(0, 5\)/);

  assert.match(uiSource, /adminCentral \? "aliado" : "sede"/);
  assert.match(uiSource, /data\.creditPerformance\.map/);
  assert.match(uiSource, /performance\.units === 1 \? "credito" : "creditos"/);
  assert.match(uiSource, /compactMoney\(performance\.value\)/);
});

test("resuelve meses anteriores en Bogota y rechaza fechas futuras o invalidas", () => {
  const now = new Date("2026-09-02T03:00:00.000Z");
  const previous = resolveDashboardMonth("2026-02", now);

  assert.equal(previous.key, "2026-02");
  assert.equal(previous.currentKey, "2026-09");
  assert.equal(previous.daysInMonth, 28);
  assert.equal(previous.start.toISOString(), "2026-02-01T05:00:00.000Z");
  assert.equal(previous.end.toISOString(), "2026-03-01T05:00:00.000Z");
  assert.match(previous.label, /febrero/i);

  assert.equal(resolveDashboardMonth("2024-02", now).daysInMonth, 29);
  assert.equal(resolveDashboardMonth("2026-10", now).key, "2026-09");
  assert.equal(resolveDashboardMonth("no-es-un-mes", now).key, "2026-09");
});

test("el dashboard conecta el selector mensual con las consultas del servidor", async () => {
  const pageSource = await readFile(path.join(projectRoot, "app/dashboard/page.tsx"), "utf8");
  const dataSource = await readFile(
    path.join(projectRoot, "app/dashboard/_lib/admin-dashboard-data.ts"),
    "utf8"
  );
  const uiSource = await readFile(
    path.join(projectRoot, "app/dashboard/_components/admin-central-dashboard.tsx"),
    "utf8"
  );
  const selectorSource = await readFile(
    path.join(projectRoot, "app/dashboard/_components/dashboard-month-selector.tsx"),
    "utf8"
  );

  assert.match(pageSource, /month: requestedMonth/);
  assert.match(dataSource, /resolveDashboardMonth\(month, today\)/);
  assert.match(dataSource, /fechaAbono:\s*\{[\s\S]*gte: monthStart,[\s\S]*lt: nextMonthStart/);
  assert.match(dataSource, /credit\.fechaCredito >= monthStart/);
  assert.match(uiSource, /<DashboardMonthSelector/);
  assert.match(selectorSource, /type="month"/);
  assert.match(selectorSource, /max=\{currentMonth\}/);
  assert.match(selectorSource, /min="2000-01"/);
  assert.match(selectorSource, /router\.push\(`\/dashboard\?month=/);
});
