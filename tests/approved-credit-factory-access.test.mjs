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

const [page, factory, wall, dashboard, creditRoute, gallery, commandRoute] = await Promise.all([
  readProjectFile("app/dashboard/creditos/page.tsx"),
  readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
  readProjectFile("app/dashboard/solicitudes/solicitudes-wall-client.tsx"),
  readProjectFile("app/dashboard/_components/seller-commercial-dashboard.tsx"),
  readProjectFile("app/api/creditos/route.ts"),
  readProjectFile("app/dashboard/creditos/credit-evidence-gallery.tsx"),
  readProjectFile("app/api/creditos/[id]/command/route.ts"),
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

test("el menu de supervision permanece visible en escritorio", () => {
  assert.doesNotMatch(
    dashboard,
    /<details className="group mt-5 border-t border-white\/10 pt-4">/
  );
  assert.match(
    dashboard,
    /<div className="mt-5 border-t border-white\/10 pt-4">[\s\S]{0,260}Supervisi&oacute;n[\s\S]{0,260}SUPERVISOR_NAV_ITEMS/
  );
});

test("el supervisor no puede modificar fechas ni condiciones del plan", () => {
  const paymentControlsStart = factory.lastIndexOf(
    "{canAdmin ? (",
    factory.indexOf("Fechas de pago")
  );
  const paymentControlsEnd = factory.indexOf(
    "Ajustar plan de pagos",
    paymentControlsStart
  );
  const paymentControls = factory.slice(
    paymentControlsStart,
    paymentControlsEnd + "Ajustar plan de pagos".length
  );

  assert.ok(paymentControlsStart >= 0, "falta el permiso del panel de pagos");
  assert.ok(paymentControlsEnd > paymentControlsStart, "falta el panel de pagos");
  assert.doesNotMatch(paymentControls, /canSupervisor/);
  assert.match(
    factory,
    /!canAdmin && command === "update-due-date"[\s\S]{0,220}Solo el administrador puede actualizar la fecha de pago/
  );
  assert.match(
    factory,
    /const updateCreditPlan = async \(\) => \{[\s\S]{0,180}if \(!canAdmin\)/
  );

  const supervisorCommands = commandRoute.slice(
    commandRoute.indexOf("const SUPERVISOR_COMMANDS"),
    commandRoute.indexOf("];", commandRoute.indexOf("const SUPERVISOR_COMMANDS")) + 2
  );
  assert.doesNotMatch(supervisorCommands, /update-due-date|update-plan/);
  assert.match(
    commandRoute,
    /case "update-due-date":[\s\S]{0,180}if \(!admin\)[\s\S]{0,220}Solo el administrador puede actualizar la fecha de pago/
  );
  assert.match(
    commandRoute,
    /case "update-plan":[\s\S]{0,180}if \(!admin\)[\s\S]{0,220}Solo el administrador puede ajustar el plan del credito/
  );
});
