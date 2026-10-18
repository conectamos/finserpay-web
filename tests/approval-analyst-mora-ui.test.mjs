import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Cartera en mora usa el guard compartido y permanece bajo Aprobaciones", () => {
  const page = read("app/dashboard/aprobaciones/cartera-mora/page.tsx");
  assert.match(page, /requireMoraDashboardAccess\(\)/);
  assert.match(page, /activeHref="\/dashboard\/aprobaciones\/cartera-mora"/);
  assert.match(page, /<MoraPortfolioClient \/>/);
});

test("la cartera conserva filtros y datos operativos dentro de la vista agrupada", () => {
  const source = read("app/dashboard/aprobaciones/cartera-mora/mora-portfolio-client.tsx");
  for (const filter of ["q", "ally", "responsible", "minDays", "maxDays", "status", "followUp"]) {
    assert.match(source, new RegExp(`${filter}: ""`));
  }
  assert.match(source, /const apiBase = allCredits \? "\/api\/aprobaciones\/gestion-cartera" : "\/api\/aprobaciones\/cartera-mora"/);
  assert.match(source, /`\$\{apiBase\}\?\$\{params\.toString\(\)\}`/);
  for (const label of ["Cliente", "Cédula", "Aliado", "Equipo", "IMEI", "Valor vencido", "Último pago", "Última gestión", "Responsable", "Resultado", "Próxima gestión", "Estado"]) {
    assert.ok(source.toLowerCase().includes(label.toLowerCase()), `falta ${label}`);
  }
  assert.match(source, /FinserSidePanel/);
  assert.doesNotMatch(source, /min-w-\[126rem\]/, "el detalle no debe reducir una tabla de quince columnas dentro de la página");
  assert.match(source, /MORA_PORTFOLIO_STATES/);
  assert.match(source, /prorrogaActiva/);
});

test("la gestión exige datos completos y agrega eventos sin reemplazar el historial", () => {
  const source = read("app/dashboard/aprobaciones/cartera-mora/mora-portfolio-client.tsx");
  assert.match(source, /timeZone: "America\/Bogota"/);
  assert.match(source, /Date\.parse\(nextFollowUpAt\) <= Date\.parse\(actedAt\)/);
  assert.match(source, /history: \[result\.item, \.\.\.current\.history\.filter/);
  assert.match(source, /managementFingerprint === lastSavedFingerprint/);
  for (const label of ["Fecha y hora de gestión", "Responsable", "Resultado", "Comentario", "Próxima gestión", "Estado de gestión"]) {
    assert.ok(source.includes(label), `falta ${label}`);
  }
});

test("los soportes validan archivo y motivo y conservan la idempotencia al reintentar", () => {
  const source = read("app/dashboard/aprobaciones/mora-supports.tsx");
  assert.match(source, /subjectKind: "GESTION" \| "EXCEPCION"/);
  assert.match(source, /canUpload\?: boolean/);
  assert.match(source, /10 \* 1024 \* 1024/);
  assert.match(source, /\.\(pdf\|png\|jpe\?g\)\$/);
  for (const header of ["x-credit-id", "x-subject-kind", "x-subject-id", "x-support-file-name", "x-support-reason", "idempotency-key"]) {
    assert.ok(source.includes(`"${header}"`), `falta header ${header}`);
  }
  assert.match(source, /idempotencyKey\.current \?\? crypto\.randomUUID\(\)/);
  assert.match(source, /href=\{item\.href\} download=\{item\.fileName\}/);
});

test("el sidebar de analista y cartera usa wordmark sin escudo sobre graphite", () => {
  const source = read("app/dashboard/_components/admin-sidebar.tsx");
  assert.match(source, /analystNavigation \|\| portfolioNavigation \? "bg-\[var\(--fp-graphite\)\]"/);
  assert.match(source, /accentPay=\{analystNavigation \|\| portfolioNavigation\} wordmarkOnly=\{analystNavigation \|\| portfolioNavigation\}/);
});
