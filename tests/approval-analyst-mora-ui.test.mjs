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

test("la cartera envía todos los filtros y muestra todas las columnas operativas", () => {
  const source = read("app/dashboard/aprobaciones/cartera-mora/mora-portfolio-client.tsx");
  for (const filter of ["q", "ally", "responsible", "minDays", "maxDays", "status", "followUp"]) {
    assert.match(source, new RegExp(`${filter}: ""`));
  }
  assert.match(source, /\/api\/aprobaciones\/cartera-mora\?\$\{params\.toString\(\)\}/);
  for (const column of ["Número", "Cliente", "Cédula", "Aliado", "Equipo", "IMEI", "Valor vencido", "Días en mora", "Último pago", "Última gestión", "Responsable", "Resultado", "Próxima gestión", "Estado", "Acciones"]) {
    assert.match(source, new RegExp(`>${column}<`));
  }
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
