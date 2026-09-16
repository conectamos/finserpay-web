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

const factoryPromise = readProjectFile(
  "app/dashboard/creditos/credit-factory-console.tsx"
);
const stylesPromise = readProjectFile("app/globals.css");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.ok(start >= 0, `No se encontró ${startMarker}`);
  assert.ok(end > start, `No se encontró ${endMarker}`);
  return source.slice(start, end);
}

function sourceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);

  assert.ok(start >= 0, `No se encontró ${startMarker}`);
  return source.slice(start);
}

function sourceWindow(source, marker, length = 6_000) {
  const start = source.indexOf(marker);

  assert.ok(start >= 0, `No se encontró ${marker}`);
  return source.slice(start, start + length);
}

async function stepTwoSources() {
  const factory = await factoryPromise;
  return {
    factory,
    derived: sourceBetween(
      factory,
      "const financialPreviewReady =",
      "const contratoListo ="
    ),
    step: sourceBetween(
      factory,
      "{wizardStep === 2 && (",
      "{!hideIdentityWizardStep && wizardStep === 3 && ("
    ),
  };
}

test("el equipo cuenta cuatro campos y exige un IMEI de exactamente 15 dígitos", async () => {
  const { factory, derived, step } = await stepTwoSources();

  assert.match(
    derived,
    /const stepTwoEquipmentFieldChecks = \[[\s\S]*Boolean\(equipoMarca\.trim\(\)\)[\s\S]*Boolean\(equipoModelo\.trim\(\)\)[\s\S]*simulatorMode \|\| imeiValido[\s\S]*valorTotalEquipoNumero > 0[\s\S]*\];/
  );
  assert.match(
    derived,
    /stepTwoEquipmentFieldChecks\.filter\(Boolean\)\.length/
  );
  assert.match(derived, /stepTwoEquipmentValidCount === 4/);
  assert.match(step, /stepTwoEquipmentValidCount \+\s*" de 4 datos del equipo válidos"/);
  assert.match(step, /\{stepTwoEquipmentValidCount\} de 4/);

  assert.match(factory, /const imeiDigits = imei\.replace\(\/\\D\/g, ""\);/);
  assert.match(factory, /const imeiValido = imeiDigits\.length === 15;/);
  assert.match(
    step,
    /setImei\([\s\S]*?event\.target\.value\.replace\(\/\\D\/g, ""\)\.slice\(0, 15\)[\s\S]*?\)/
  );
  assert.match(step, /inputMode="numeric"/);
  assert.match(step, /maxLength=\{15\}/);
  assert.match(step, /imeiDigits\.length > 0 && !imeiValido/);
  assert.match(step, /imeiDigits\.length \+ "\/15 dígitos"/);
});

test("el plan permanece en un fieldset bloqueado hasta tener equipo y política", async () => {
  const { derived, step } = await stepTwoSources();

  assert.match(
    derived,
    /const stepTwoPolicyAvailable = simulatorMode[\s\S]*\? simulationPolicyReady[\s\S]*!dataCreditoCreditCreationMode \|\|[\s\S]*dataCreditoBypassed \|\|[\s\S]*Boolean\(activeDataCreditoOffer\);/
  );
  assert.match(
    derived,
    /const stepTwoPlanLocked = !stepTwoEquipmentReady \|\| !stepTwoPolicyAvailable;/
  );
  assert.match(step, /stepTwoPlanLocked \? "is-locked" : ""/);
  assert.match(step, /id="step-two-plan-availability"/);
  assert.match(step, /"Política no disponible"/);
  assert.match(step, /"Disponible al completar el equipo\."/);
  assert.match(
    step,
    /<fieldset[\s\S]*?disabled=\{stepTwoPlanLocked\}[\s\S]*?aria-describedby="step-two-plan-availability"[\s\S]*?className="fp-step2-plan-fields"/
  );
});

test("la inicial sincroniza input y range y los plazos provienen de opciones dinámicas", async () => {
  const { derived, step } = await stepTwoSources();

  assert.match(step, /value=\{currencyInputValue\(cuotaInicial\)\}/);
  assert.match(
    step,
    /setCuotaInicial\([\s\S]*?event\.target\.value\.replace\(\/\\D\/g, ""\)[\s\S]*?\)/
  );
  assert.match(
    step,
    /type="range"[\s\S]*?min=\{stepTwoInitialMinimum\}[\s\S]*?max=\{stepTwoInitialMaximum\}[\s\S]*?value=\{stepTwoInitialRangeValue\}[\s\S]*?setCuotaInicial\(event\.target\.value\)/
  );
  assert.match(step, /Mínimo: \{currency\(stepTwoInitialMinimum\)\}/);
  assert.match(step, /Máximo: \{currency\(stepTwoInitialMaximum\)\}/);
  assert.match(
    derived,
    /creditInstallmentOptions\.length > 0 &&[\s\S]*creditInstallmentOptions\.includes\(plazoMeses\)/
  );
  assert.match(step, /creditInstallmentOptions\.length <= 6/);
  assert.equal(
    (step.match(/creditInstallmentOptions\.map\(\(option\) => \(/g) || []).length,
    2
  );
  assert.match(step, /role="radiogroup"[\s\S]*checked=\{plazoMeses === option\}/);
  assert.match(
    step,
    /<select[\s\S]*?id="step-two-installments"[\s\S]*?setPlazoMeses\(event\.target\.value\)/
  );
  assert.doesNotMatch(
    step,
    /<option[^>]*value="(?:6|12|18|24|36|48)"/
  );
});

test("la propuesta se recalcula con las variables financieras reales", async () => {
  const { step } = await stepTwoSources();
  const proposal = sourceBetween(
    step,
    'className="fp-step2-proposal"',
    "</section>"
  );

  assert.match(proposal, /aria-live="polite"/);
  assert.match(proposal, /<dt>Equipo<\/dt>[\s\S]*referenciaEquipo/);
  assert.match(
    proposal,
    /<dt>Valor<\/dt>[\s\S]*currency\(valorTotalEquipoNumero\)/
  );
  assert.match(
    proposal,
    /<dt>Inicial<\/dt>[\s\S]*currency\(cuotaInicialNumero\)/
  );
  assert.match(
    proposal,
    /<dt>Financiado<\/dt>[\s\S]*currency\(saldoBaseFinanciado\)/
  );
  assert.match(
    proposal,
    /<dt>Plazo<\/dt>[\s\S]*plazoMesesNumero \+ " cuotas"/
  );
  assert.match(
    proposal,
    /Cuota \{frecuenciaPagoLabel\.toLowerCase\(\)\}[\s\S]*stepTwoProposalReady \? currency\(valorCuota\) : "—"/
  );
  assert.doesNotMatch(proposal, />\s*\$\s*0\s*</);
});

test("Continuar refleja pending, expone aria-busy y evita envíos duplicados", async () => {
  const { factory, derived } = await stepTwoSources();
  const handler = sourceBetween(
    factory,
    "const handleStepTwoContinue = async () => {",
    "const createWhatsAppOtp"
  );
  const actions = sourceWindow(factory, ") : wizardStep === 2 ? (", 5_000);

  assert.match(factory, /const stepTwoContinueInFlightRef = useRef\(false\);/);
  assert.match(
    derived,
    /const stepTwoOperationPending =[\s\S]*creating \|\|[\s\S]*firmaSeguroSubmitting \|\|[\s\S]*iphoneFactorySignaturePending \|\|[\s\S]*draftStatus === "loading" \|\|[\s\S]*draftStatus === "saving" \|\|[\s\S]*stepTwoContinuing;/
  );
  assert.match(
    derived,
    /const stepTwoContinueDisabled =[\s\S]*!stepTwoComplete \|\| stepTwoOperationPending;/
  );
  assert.match(
    handler,
    /stepTwoContinueInFlightRef\.current \|\|[\s\S]*stepTwoContinueDisabled[\s\S]*return;/
  );
  assert.match(handler, /stepTwoContinueInFlightRef\.current = true;/);
  assert.match(handler, /setStepTwoContinuing\(true\);/);
  assert.match(
    handler,
    /try \{[\s\S]*await advanceToStep\(nextVisibleWizardStep\(wizardStep\)\);[\s\S]*\} finally \{[\s\S]*stepTwoContinueInFlightRef\.current = false;[\s\S]*setStepTwoContinuing\(false\);/
  );
  assert.match(actions, /onClick=\{\(\) => void handleStepTwoContinue\(\)\}/);
  assert.match(actions, /disabled=\{stepTwoContinueDisabled\}/);
  assert.match(actions, /aria-disabled=\{stepTwoContinueDisabled\}/);
  assert.match(
    actions,
    /aria-busy=\{[\s\S]*?stepTwoContinuing \|\| draftStatus === "saving"[\s\S]*?\}/
  );
  assert.match(actions, /draftStatus === "saving"[\s\S]*?"Guardando…"/);
  assert.match(actions, /stepTwoContinuing[\s\S]*?"Continuando…"[\s\S]*?: "Continuar"/);
});

test("un precio temporalmente inválido conserva la inicial y el borrador restaura el paso 2", async () => {
  const { factory } = await stepTwoSources();
  const preserveInitial = sourceWindow(
    factory,
    "setCuotaInicial((currentValue) => {",
    1_200
  );
  const restore = sourceBetween(
    factory,
    "const applyDraftPayload = (draft: CreditDraftItem) => {",
    "const createNewSaleFromClient"
  );

  assert.match(
    preserveInitial,
    /if \(!valorTotalEquipoNumero && currentValue\) \{[\s\S]*return currentValue;[\s\S]*\}/
  );
  assert.match(
    preserveInitial,
    /resolveInitialPaymentAfterMinimumRefresh\(\{[\s\S]*currentValue,[\s\S]*totalValue: valorEquipoTotal,[\s\S]*minimumValue: cuotaInicialMinimaNumero,[\s\S]*preserveCurrent: draftResumeHydrating \|\| firmaSeguroProcessExists/
  );

  assert.match(
    restore,
    /const restoredInstallments = value\("plazoMeses"\) \|\| plazoMeses;/
  );
  assert.match(
    restore,
    /pendingDraftFinancialTermsRef\.current = \{[\s\S]*plazoMeses: restoredInstallments,[\s\S]*fechaPrimerPago: restoredFirstPaymentDate,[\s\S]*frecuenciaPago: restoredPaymentFrequency,[\s\S]*restoringDraft: true,/
  );
  assert.match(restore, /setEquipoMarca\(restoredEquipoMarca\);/);
  assert.match(restore, /setEquipoModelo\(restoredEquipoModelo\);/);
  assert.match(restore, /setImei\(restoredImei\);/);
  assert.match(
    restore,
    /setValorEquipoTotal\(value\("valorEquipoTotal"\)\);/
  );
  assert.match(restore, /setCuotaInicial\(value\("cuotaInicial"\)\);/);
  assert.match(restore, /setPlazoMeses\(restoredInstallments\);/);
  assert.match(restore, /setFechaPrimerPago\(restoredFirstPaymentDate\);/);
});

test("Limpiar usa ConfirmDialog y solo borra los datos editables del paso 2", async () => {
  const { factory } = await stepTwoSources();
  const clear = sourceBetween(
    factory,
    "const clearStepTwoFields = () => {",
    "const resetForm = () => {"
  );
  const dialog = sourceWindow(
    factory,
    "open={stepTwoClearConfirmOpen}",
    1_000
  );

  assert.match(clear, /if \(firmaSeguroProcessExists\)/);
  for (const setter of [
    "setEquipoMarca",
    "setEquipoModelo",
    "setImei",
    "setValorEquipoTotal",
    "setCuotaInicial",
    "setPlazoMeses",
  ]) {
    assert.match(clear, new RegExp(`${setter}\\(\"\"\\)`));
  }
  assert.match(
    clear,
    /Se limpiaron únicamente los datos editables de equipo y plan\./
  );
  assert.doesNotMatch(
    clear,
    /(?:setCliente|setReferenciaFamiliar|setDataCredito|setDraftId|setWizardStep|setContrato|setFechaPrimerPago|setFrecuenciaPagoCredito)\(/
  );

  assert.match(dialog, /title="Limpiar equipo y plan"/);
  assert.match(dialog, /Los datos del cliente, la oferta y los demás pasos se conservarán\./);
  assert.match(dialog, /confirmLabel="Limpiar paso 2"/);
  assert.match(dialog, /onCancel=\{\(\) => setStepTwoClearConfirmOpen\(false\)\}/);
  assert.match(dialog, /onConfirm=\{clearStepTwoFields\}/);
});

test("el equipo usa un Smartphone local como fallback y no solicita una imagen externa", async () => {
  const { step } = await stepTwoSources();
  const devicePreview = sourceBetween(
    step,
    'className="fp-step2-device-preview"',
    'className="fp-step2-equipment-details"'
  );
  const styles = sourceFrom(
    await stylesPromise,
    "/* Step 2 — equipment and plan */"
  );

  assert.match(devicePreview, /<Smartphone strokeWidth=\{1\.55\} \/>/);
  assert.match(devicePreview, /referenciaEquipo \|\| "Sin equipo seleccionado"/);
  assert.match(devicePreview, /Selecciona una marca y modelo/);
  assert.doesNotMatch(devicePreview, /<(?:img|NextImage)\b/i);
  assert.doesNotMatch(styles, /url\(/i);
});

test("el CSS del paso 2 responde sin overflow horizontal y respeta reduced motion", async () => {
  const styles = sourceFrom(
    await stylesPromise,
    "/* Step 2 — equipment and plan */"
  );

  assert.match(styles, /\.fp-step2 \{[\s\S]*?min-width: 0;/);
  assert.match(
    styles,
    /\.fp-step2-card \{[\s\S]*?grid-template-columns: minmax\(0, 1\.05fr\) minmax\(0, 0\.95fr\);[\s\S]*?overflow: hidden;/
  );
  assert.match(
    styles,
    /\.fp-step2-proposal \{[\s\S]*?grid-template-columns: minmax\(190px, 0\.95fr\) minmax\(0, 4fr\);[\s\S]*?overflow: hidden;/
  );
  assert.ok(
    (styles.match(/min-width: 0;/g) || []).length >= 6,
    "Los contenedores del paso 2 deben poder encogerse sin desbordar"
  );
  assert.match(
    styles,
    /@media \(max-width: 1180px\)[\s\S]*?\.fp-step2-card \{[\s\S]*?grid-template-columns: 1fr;[\s\S]*?\.fp-step2-proposal-metrics \{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*?\.fp-step2-equipment-fields,[\s\S]*?\.fp-step2-equipment-lower,[\s\S]*?\.fp-step2-plan-meta \{[\s\S]*?grid-template-columns: 1fr;[\s\S]*?\.fp-step2-proposal-metrics \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/
  );
  assert.match(
    styles,
    /@media \(max-width: 440px\)[\s\S]*?\.fp-step2-proposal-metrics \{[\s\S]*?grid-template-columns: 1fr;[\s\S]*?\.fp-step2-action-buttons \{[\s\S]*?grid-template-columns: 1fr;/
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.fp-step2 \*,[\s\S]*?\.fp-step2-actions \*[\s\S]*?transition: none !important;/
  );
  assert.doesNotMatch(styles, /overflow-x:\s*(?:auto|scroll)/);
});
