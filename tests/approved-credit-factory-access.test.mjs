import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");

const [page, factory, wall, dashboard, creditRoute, gallery] = await Promise.all([
  readProjectFile("app/dashboard/creditos/page.tsx"),
  readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
  readProjectFile("app/dashboard/solicitudes/solicitudes-wall-client.tsx"),
  readProjectFile("app/dashboard/_components/seller-commercial-dashboard.tsx"),
  readProjectFile("app/api/creditos/route.ts"),
  readProjectFile("app/dashboard/creditos/credit-evidence-gallery.tsx"),
]);

test("solo central puede abrir un credito finalizado dentro de la fabrica", () => {
  assert.match(
    page,
    /!adminCentral && \(rawEntryMode === "delivery" \|\| hasSelectedCredit\)/
  );
  assert.match(
    page,
    /hasSelectedCredit[\s\S]{0,220}redirect\("\/dashboard\/solicitudes"\)/
  );
  assert.match(
    factory,
    /adminFactoryAssistAvailable\s*=\s*canSeeInternalPricing && createClientMode/
  );
  assert.doesNotMatch(dashboard, /href: "\/dashboard\/creditos\?mode=delivery"/);
  assert.match(dashboard, /label: "Retomar solicitud"/);
});

test("el enlace de fabrica conserva filtros y solo acepta retorno al muro", () => {
  assert.match(wall, /const wallReturnHref = `\/dashboard\/solicitudes/);
  assert.match(wall, /params\.set\("returnTo", returnTo\)/);
  assert.match(
    wall,
    /factoryHref\((?:item|detail), viewerRole, wallReturnHref\)/
  );
  assert.match(page, /function solicitudesReturnHref/);
  assert.match(page, /candidate\.startsWith\("\/dashboard\/solicitudes\?"\)/);
  assert.match(page, /href=\{returnTo\}/);
});

test("el asesor solo consulta sus ventas y la API oculta datos sensibles", () => {
  assert.match(
    creditRoute,
    /sedeId: sellerSession!\.sedeId,[\s\S]{0,100}vendedorId: sellerSession!\.id/
  );
  assert.match(creditRoute, /function redactCreditForNonAdmin/);
  for (const field of [
    "equalityPayload: null",
    "observacionAdmin: null",
    "contratoIp: null",
    "contratoFotoDataUrl: null",
    "contratoSelfieDataUrl: null",
    "referenciasFamiliares: []",
  ]) {
    assert.ok(creditRoute.includes(field), `falta ocultar ${field}`);
  }
  assert.match(
    creditRoute,
    /return admin \? serialized : redactCreditForNonAdmin\(serialized\)/
  );
});

test("la correccion nueva usa tokens visuales de FINSER PAY", () => {
  const correction = gallery.slice(
    gallery.indexOf("export function ApprovedCreditEvidenceCorrection")
  );
  assert.ok(correction.length > 0);
  assert.doesNotMatch(correction, /#[0-9a-f]{3,8}|rgba\(/i);
  for (const token of [
    "--fp-border",
    "--fp-radius-lg",
    "--fp-lime-soft",
    "--fp-danger-soft",
  ]) {
    assert.ok(correction.includes(token), `falta token ${token}`);
  }
});
