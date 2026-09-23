import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const factorySource = readFileSync(
  new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
  "utf8",
);
const remissionSource = readFileSync(
  new URL("../app/dashboard/creditos/credit-remission-note.tsx", import.meta.url),
  "utf8",
);

function sourceBlock(source, start, end, fromIndex = 0) {
  const startIndex = source.indexOf(start, fromIndex);
  const endIndex = source.indexOf(end, startIndex);

  assert.notEqual(startIndex, -1, `No se encontró el inicio: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

const deliveryStep = sourceBlock(
  factorySource,
  "{wizardStep === 5 && (",
  "{false && wizardStep === 4 && (",
);

test("el paso 4 presenta el encabezado, estado y resumen compacto solicitados", () => {
  assert.match(
    deliveryStep,
    /\{hideIdentityWizardStep \? "PASO 4" : "PASO 5"\}/,
  );
  assert.match(deliveryStep, /<h3>Entrega del equipo<\/h3>/);
  assert.match(
    deliveryStep,
    /Completa cada acción para finalizar el crédito\./,
  );
  assert.match(deliveryStep, /PENDIENTE DE ENROLAMIENTO/);
  assert.match(deliveryStep, /aria-label="Resumen de la venta"/);

  for (const label of [
    "Referencia del equipo",
    "Cliente",
    "Número de solicitud",
    "Ver detalles",
  ]) {
    assert.ok(deliveryStep.includes(label), `Falta el dato del resumen: ${label}`);
  }
});

test("el flujo visual conserva remisión, enrolamiento y evidencias en ese orden", () => {
  const remissionIndex = deliveryStep.indexOf("<CreditRemissionNote");
  const enrollmentIndex = deliveryStep.indexOf("Confirma el enrolamiento");
  const evidenceIndex = deliveryStep.indexOf("Carga las evidencias");

  assert.ok(remissionIndex >= 0, "Debe renderizarse la remisión");
  assert.ok(
    enrollmentIndex > remissionIndex,
    "La confirmación de enrolamiento debe ir después de la remisión",
  );
  assert.ok(
    evidenceIndex > enrollmentIndex,
    "El cargue de evidencias debe ir después del enrolamiento",
  );
  assert.match(deliveryStep, /Esperando confirmación del analista\./);
  assert.match(
    deliveryStep,
    /\{deliveryEnrollmentReady \? "COMPLETADO" : "EN PROCESO"\}/,
  );
  assert.match(deliveryStep, /5 fotografías obligatorias\./);
  assert.match(deliveryStep, /autoOpen=\{wizardStep === 5\}/);
  assert.match(deliveryStep, /evidenceFinalizationReady/);
  assert.match(deliveryStep, /GUARDANDO/);
  assert.match(deliveryStep, /ERROR AL GUARDAR/);
  assert.match(deliveryStep, /aria-disabled=\{!deliveryEvidenceUnlocked \|\| undefined\}/);
  assert.match(deliveryStep, /\? "BLOQUEADO"/);
});

test("las cinco evidencias existentes permanecen detrás del enrolamiento", () => {
  assert.match(
    deliveryStep,
    /\{deliveryEvidenceUnlocked \? \(\s*<section id="delivery-evidence-upload"/,
  );

  const evidenceCards = deliveryStep.match(/<DeliveryEvidenceCard\b/g) ?? [];
  const disabledBindings =
    deliveryStep.match(/disabled=\{!deliveryEvidenceUnlocked\}/g) ?? [];
  assert.equal(evidenceCards.length, 5);
  assert.equal(disabledBindings.length, 5);

  const expectedCards = [
    [1, "Cédula frontal", "cedula-frente", "setContratoCedulaFrenteDataUrl"],
    [2, "Cédula posterior", "cedula-respaldo", "setContratoCedulaRespaldoDataUrl"],
    [3, "Selfie con cédula", "selfie-cedula", "setIphoneSelfieCedulaDataUrl"],
    [4, "Foto de entrega", "foto-entrega", "setFotoEntregaDataUrl"],
    [5, "Foto de remisión", "foto-remision", "setFotoRemisionDataUrl"],
  ];

  for (const [index, title, cameraSlot, setter] of expectedCards) {
    assert.match(deliveryStep, new RegExp(`index=\\{${index}\\}`));
    assert.ok(deliveryStep.includes(`title="${title}"`), `Falta ${title}`);
    assert.ok(
      deliveryStep.includes(`setCameraSlot("${cameraSlot}")`),
      `Falta el acceso a cámara de ${title}`,
    );
    assert.ok(deliveryStep.includes(`${setter}("")`), `Falta eliminar ${title}`);
    assert.ok(
      deliveryStep.includes(`${setter},`),
      `Falta guardar ${title} con el manejador existente`,
    );
  }
});

test("el cierre firmado conserva la acción y todas las condiciones de bloqueo", () => {
  const finalizeButton = sourceBlock(
    factorySource,
    '<div className={stepFourStyles.finalizeGroup}>',
    "{wizardStep !== 5 ? (",
    factorySource.indexOf("{wizardStep === 5 && ("),
  );

  assert.match(
    finalizeButton,
    /onClick=\{\(\) => void finalizeFirmaSeguroDelivery\(\)\}/,
  );
  assert.match(
    finalizeButton,
    /disabled=\{\s*creating \|\|\s*firmaSeguroSubmitting \|\|\s*!creditClosureReady\s*\}/,
  );
  assert.match(finalizeButton, /FINALIZAR CRÉDITO FIRMADO/);
  assert.match(
    finalizeButton,
    /Disponible al completar las evidencias\./,
  );
});

test("la remisión conserva la impresión actual con las nuevas etiquetas", () => {
  assert.match(remissionSource, /const handlePrint = \(\) =>/);
  assert.match(
    remissionSource,
    /window\.requestAnimationFrame\([\s\S]*setPrintInvoked\(true\)[\s\S]*window\.print\(\)/,
  );
  assert.match(remissionSource, /<h4[^>]*>Imprime la remisión<\/h4>/);
  assert.match(
    remissionSource,
    /El cliente debe firmar como en la cédula\./,
  );
  assert.match(remissionSource, /onClick=\{handlePrint\}/);
  assert.match(remissionSource, /IMPRIMIR REMISIÓN/);
});
