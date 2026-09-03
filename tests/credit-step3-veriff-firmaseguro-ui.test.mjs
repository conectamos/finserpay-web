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

test("el modal QR es accesible, conserva foco y confirma la regeneracion", async () => {
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
  assert.match(dialog, /element\.setAttribute\("inert", ""\)/);
  assert.match(dialog, /previousActiveElement\?\.focus\(\)/);
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(modal, />\s*Validar identidad\s*</);
  assert.match(modal, /Esperando validación/);
  assert.match(modal, />\s*Cerrar\s*</);
  assert.match(modal, /Regenerar QR/);
  assert.match(source, /title="Regenerar código QR"/);
  assert.match(source, /currentValidationId: options\.expectedValidationId \|\| null/);
  assert.match(source, /regenerate: options\.regenerate === true/);
});

test("FirmaSeguro permanece oculto hasta la aprobacion real de Veriff", async () => {
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
  assert.match(step, /maskDocument\(clienteDocumento\)/);
  assert.match(step, /dateTime\(veriffValidation\.decidedAt\)/);
  assert.match(firma, /maskImei\(imei\)/);
  assert.match(firma, /firmaSeguroAvailableDocuments\.length/);
  assert.match(firma, /firmaSeguroAvailableDocuments\.map/);
  assert.match(firma, /!firmaSeguroDocumentsReady/);
  assert.match(firma, /handleFirmaSeguroStepReady\(\)/);
});

test("el Paso 3 usa el sistema visual sobrio y responde en pantallas pequeñas", async () => {
  const css = await readProjectFile("app/globals.css");
  const redesign = sourceBetween(
    css,
    "/* Credit factory: Veriff and FirmaSeguro step */",
    "@media (prefers-reduced-motion: reduce) {"
  );

  assert.match(redesign, /\.fp-step3-identity-pending/);
  assert.match(redesign, /\.fp-step3-progress/);
  assert.match(redesign, /\.fp-step3-firma-grid/);
  assert.match(redesign, /\.fp-identity-modal \{[\s\S]*width: min\(488px, 100%\)/);
  assert.match(redesign, /@media \(max-width: 960px\)/);
  assert.match(redesign, /@media \(max-width: 680px\)/);
  assert.doesNotMatch(redesign, /#0e7a6f|#0a655d|turquoise|gradient/i);
});
