import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const factorySource = readFileSync(
  new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
  "utf8"
);
const creditRouteSource = readFileSync(
  new URL("../app/api/creditos/route.ts", import.meta.url),
  "utf8"
);

test("el servidor confirma el cierre atomico de la solicitud", () => {
  assert.match(creditRouteSource, /completeSolicitudForCredit\(/);
  assert.match(creditRouteSource, /estado:\s*"CERRADO"/);
  assert.match(creditRouteSource, /creditoId:\s*created\.id/);
});

test("la fabrica conserva una confirmacion visible tras cerrar el credito", () => {
  assert.match(factorySource, /Credito cerrado correctamente/);
  assert.match(factorySource, /setCompletedCredit\(/);
  assert.match(factorySource, /Plan de pagos/);
  assert.match(factorySource, /href="\/dashboard"/);
});

test("el navegador no repite el cierre ni redirige silenciosamente al inicio", () => {
  assert.doesNotMatch(factorySource, /window\.location\.assign\("\/app"\)/);
  assert.doesNotMatch(
    factorySource,
    /JSON\.stringify\(\{ id: closedDraftId, estado: "CERRADO" \}\)/
  );
});

test("el estado y el boton final comparten todas las condiciones de cierre", () => {
  assert.match(
    factorySource,
    /const creditClosureReady =[\s\S]{0,140}firmaSeguroProcessSigned/
  );
  assert.match(
    factorySource,
    /creditClosureReady[\s\S]{0,240}"Lista para cierre"/
  );
  assert.match(
    factorySource,
    /disabled=\{[\s\S]{0,180}!creditClosureReady/
  );
});
