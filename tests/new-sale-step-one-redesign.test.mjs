import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file, encoding = "utf8") =>
  readFile(path.join(projectRoot, file), encoding);

test("el paso 1 conserva la consulta real y presenta el contenido solicitado", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/datacredito-prequalification-gate.tsx",
  );

  for (const text of [
    "Validemos al cliente",
    "Ingresa la cédula y el primer apellido para continuar.",
    "Paso 1 · Datos básicos",
    "2 datos requeridos",
    "Número de cédula",
    "Primer apellido",
    "Evaluar solicitud",
  ]) {
    assert.ok(source.includes(text), `Falta el contenido: ${text}`);
  }

  assert.doesNotMatch(source, /Consulta previa para iPhone/);
  assert.doesNotMatch(source, />\s*Precalificación\s*</);
  assert.doesNotMatch(
    source,
    /FINSER PAY no muestra el puntaje al asesor\. Los errores técnicos/,
  );

  assert.match(source, /pattern="\[0-9\]\{3,13\}"/);
  assert.match(source, /maxLength=\{13\}/);
  assert.match(source, /maxLength=\{80\}/);
  assert.match(source, /if \(!consentAccepted\)/);
  assert.match(source, /if \(submissionInFlightRef\.current\) return/);
  assert.match(source, /"\/api\/creditos\/datacredito\/evaluaciones"/);
  assert.match(source, /documentNumber:\s*validation\.documentNumber/);
  assert.match(source, /firstSurname:\s*validation\.firstSurname/);
  assert.match(source, /platform,/);
  assert.match(source, /consentAccepted:\s*true/);
});

test("la tarjeta usa la mascota aislada y respeta movimiento reducido", async () => {
  const [source, css, mascot] = await Promise.all([
    readProjectFile("app/dashboard/creditos/datacredito-prequalification-gate.tsx"),
    readProjectFile("app/dashboard/creditos/datacredito-prequalification-gate.module.css"),
    readProjectFile(
      "public/assets/creditos/datacredito-client-check-mascot.png",
      null,
    ),
  ]);

  assert.match(source, /datacredito-client-check-mascot\.png/);
  assert.equal(mascot.subarray(1, 4).toString("ascii"), "PNG");
  assert.match(css, /grid-template-columns:\s*minmax\(290px, 0\.78fr\) minmax\(0, 2fr\)/);
  assert.match(css, /@keyframes mascotEnter/);
  assert.match(css, /@keyframes mascotFloat/);
  assert.match(css, /\.mascot\s*\{[^}]*border:\s*0 !important/);
  assert.match(css, /translateY\(-6px\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media \(max-width:\s*860px\)/);
  assert.match(css, /@media \(max-width:\s*640px\)/);
});

test("Nueva venta usa marca textual, perfil, menú compacto y cuatro pasos lineales", async () => {
  const [source, css] = await Promise.all([
    readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
    readProjectFile("app/globals.css"),
  ]);
  const headerStart = source.indexOf("{createClientMode ? (");
  const headerEnd = source.indexOf(") : simulatorMode || deliveryMode ? (", headerStart);
  const header = source.slice(headerStart, headerEnd);

  assert.ok(headerStart >= 0 && headerEnd > headerStart);
  assert.match(header, /fp-new-sale-wordmark/);
  assert.match(header, /<span>FINSER<\/span>\s+<span>PAY<\/span>/);
  assert.match(header, /fp-new-sale-title">Nueva venta/);
  assert.match(header, /fp-new-sale-profile/);
  assert.match(header, /fp-new-sale-menu/);
  assert.match(header, /href="\/dashboard"/);
  assert.doesNotMatch(header, /<FinserBrand/);

  for (const label of [
    'label: "Cliente"',
    'label: "Equipo"',
    'label: "Identidad y firma"',
    'label: "Enrolamiento y entrega"',
  ]) {
    assert.ok(source.includes(label), `Falta el paso: ${label}`);
  }

  assert.match(source, /factorySteps\.filter\(\(step\) => step\.id !== 3\)/);
  assert.match(source, /createClientMode \? "fp-new-sale-stepper"/);
  assert.match(source, /showDataCreditoGate \? "fp-prequalification-stage"/);
  assert.match(css, /\.fp-credit-factory \.fp-new-sale-header\s*{[^}]*border-radius:\s*0 0 50% 50%/);
  assert.match(css, /\.fp-new-sale-wordmark > span:first-child\s*{[^}]*color:\s*var\(--fp-lime\)/);
  assert.match(css, /\.fp-credit-factory \.fp-new-sale-stepper \.fp-seller-step-button\s*{[^}]*border:\s*0 !important/);
  assert.match(css, /\.fp-credit-factory \.fp-prequalification-stage\s*{[^}]*background:\s*transparent !important/);
});
