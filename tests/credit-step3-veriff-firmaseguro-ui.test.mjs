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

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontro ${start}`);
  assert.notEqual(endIndex, -1, `No se encontro ${end}`);
  return source.slice(startIndex, endIndex);
}

test("el modal QR bloquea el fondo, conserva el foco y usa estados reales", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const dialog = sourceBetween(
    source,
    "function IdentityValidationDialog",
    "export default function CreditFactoryConsole"
  );
  const modal = sourceBetween(
    source,
    "<IdentityValidationDialog",
    "{false && ("
  );

  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-describedby="fp-identity-modal-description"/);
  assert.match(dialog, /dismissible = true/);
  assert.match(dialog, /tabIndex={-1}/);
  assert.match(dialog, /element\.setAttribute\("inert", ""\)/);
  assert.match(dialog, /previousActiveElement\?\.focus\(\)/);
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(dialog, /if \(dismissible\) \{/);
  assert.match(dialog, /dismissible && event\.target === event\.currentTarget/);
  assert.match(modal, /dismissible={!identityValidationLocked}/);
  assert.match(modal, /VALIDACIÓN DE IDENTIDAD/);
  assert.match(modal, /Valida la identidad del cliente/);
  assert.match(
    modal,
    /Genera el código QR y solicita al cliente escanearlo desde\s+su celular\./
  );
  assert.match(modal, /GENERAR CÓDIGO QR/);
  assert.match(modal, /Generando QR…/);
  assert.match(modal, /Esperando validación/);
  assert.match(
    modal,
    /La firma del contrato se habilitará cuando la identidad\s+sea aprobada\./
  );
  assert.match(modal, /Cancelar y volver/);
  assert.match(modal, /disabled={!veriffCanGenerateNewQr \|\| veriffQrGenerated}/);
  assert.match(modal, /QR generado/);
  assert.match(modal, /Cliente valida/);
  assert.match(modal, /Aprobación/);
  assert.match(modal, /Regenerar QR/);
  assert.match(
    source,
    /wizardStep !== 4 \|\|[\s\S]*setIdentityValidationModalOpen\(true\)/
  );
  assert.match(source, /const veriffQrGenerated = Boolean\(veriffValidation\?\.sessionUrl\)/);
  assert.match(source, /veriffRequestInFlightRef\.current/);
  assert.match(source, /title="Regenerar código QR"/);
  assert.match(source, /currentValidationId: options\.expectedValidationId \|\| null/);
  assert.match(source, /regenerate: options\.regenerate === true/);
  assert.match(source, /const responseValidation = result\.data\?\.validation \|\| null/);
  assert.match(source, /if \(!result\.ok && responseValidation\.id && currentDraftId\)/);
  assert.match(source, /veriffValidationId: responseValidation\.id/);
});

test("la aprobacion real muestra el resumen y habilita el envio compacto a FirmaSeguro", async () => {
  const source = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const step = sourceBetween(
    source,
    "{wizardStep === 4 && (",
    "{wizardStep === 5 && ("
  );
  const firma = sourceBetween(
    step,
    "className=\"fp-step3-firma\"",
    "<div className=\"hidden\">"
  );

  assert.match(step, /\{!veriffApproved \? \(/);
  assert.match(step, /className="fp-step3-identity-pending"/);
  assert.match(step, /FirmaSeguro permanecerá oculto/);
  assert.match(step, /\{veriffApproved \? \([\s\S]*className="fp-step3-firma"/);
  assert.match(step, /className="fp-step3-identity-approved"/);
  assert.match(step, /La identidad fue aprobada\. Envía el contrato para continuar\./);
  assert.match(step, /IDENTIDAD APROBADA/);
  assert.match(step, /Identidad validada/);
  assert.match(step, /El cliente completó correctamente la validación\./);
  assert.match(step, /QR generado/);
  assert.match(step, /Cliente validado/);
  assert.match(step, /Aprobación recibida/);
  assert.match(firma, /className="fp-step3-firma-compact"/);
  assert.match(firma, /Expediente listo/);
  assert.match(firma, /ENVIAR CONTRATO A FIRMASEGURO/);
  assert.match(firma, /Enviando…/);
  assert.match(firma, /handleFirmaSeguroStepReady\(\)/);
  assert.doesNotMatch(firma, /fp-step3-firma-grid/);
  assert.doesNotMatch(firma, /Revisar documentos/);
  assert.doesNotMatch(firma, /Expediente preparado/);
  assert.match(
    source,
    /if \(firmaSeguroRequestInFlightRef\.current \|\| firmaSeguroProcessSent\)/
  );
  assert.match(source, /firmaSeguroRequestInFlightRef\.current = true/);
  assert.match(source, /firmaSeguroRequestInFlightRef\.current = false/);
});

test("el Paso 3 usa el sistema visual sobrio y responde en pantallas pequeñas", async () => {
  const css = await readProjectFile("app/globals.css");
  const redesign = sourceBetween(
    css,
    "/* Credit factory: approved step 3 visual reference */",
    ".fp-enrollment-success-header {"
  );

  assert.match(redesign, /backdrop-filter: blur\(8px\)/);
  assert.match(css, /\.fp-step3-identity-pending/);
  assert.match(css, /\.fp-step3-progress/);
  assert.match(redesign, /\.fp-step3-identity-approved/);
  assert.match(redesign, /\.fp-step3-veriff-complete/);
  assert.match(redesign, /\.fp-step3-firma-compact/);
  assert.match(redesign, /\.fp-identity-modal \{[\s\S]*width: min\(620px, 100%\)/);
  assert.match(redesign, /width: min\(100%, 390px\)/);
  assert.match(redesign, /@media \(max-width: 760px\)/);
  assert.match(redesign, /@media \(max-width: 480px\)/);
  assert.match(redesign, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(redesign, /#0e7a6f|#0a655d|turquoise|gradient/i);
});
