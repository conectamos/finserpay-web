import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

function sourceBlock(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  assert.notEqual(startIndex, -1, `No se encontro el inicio: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontro el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("solo el administrador central FINSERPAY puede inspeccionar libremente la fabrica", () => {
  assert.match(
    source,
    /const canAdminMoveFreelyInFactory\s*=\s*canSeeInternalPricing\s*&&\s*createClientMode/
  );
  assert.doesNotMatch(
    source,
    /const canAdminMoveFreelyInFactory\s*=\s*canAdmin\s*&&/
  );
});

test("después de la firma el asesor no puede volver a pasos editables", () => {
  assert.match(
    source,
    /const signedContractEditLocked =\s*!canSeeInternalPricing &&\s*\(firmaSeguroProcessUiState === "signed" \|\|\s*firmaSeguroFinancialCorrectionPending \|\|\s*firmaSeguroIdentityCorrectionPending \|\|\s*firmaSeguroFinancialCorrectionReissue\)/,
  );
  assert.match(
    source,
    /const advisorSignedContractStep =\s*firmaSeguroProcessUiState === "signed" &&\s*!firmaSeguroRequiresFirstPaymentDateReissue &&\s*!firmaSeguroIdentityCorrectionPending\s*\? 5\s*: 4;/,
  );
  for (const start of ["const goToStep", "const advanceToStep"]) {
    const block = sourceBlock(start, start === "const goToStep" ? "const advanceToStep" : "const createWhatsAppOtp");
    assert.match(
      block,
      /signedContractEditLocked &&\s*targetStep !== advisorSignedContractStep/,
    );
  }
  assert.match(
    source,
    /signedContractEditLocked &&\s*step\.id !== advisorSignedContractStep/,
  );
  assert.match(source, /wizardStep > 1 && !signedContractEditLocked/);
});

test("la corrección de valores firmados se muestra solo al administrador central", () => {
  const markerIndex = source.indexOf('data-testid="signed-financial-correction"');
  const panelStart = source.lastIndexOf("{canSeeInternalPricing &&", markerIndex);
  const panelEnd = source.indexOf("{canSeeInternalPricing &&", markerIndex + 1);
  assert.ok(panelStart >= 0);
  assert.ok(panelEnd > markerIndex);
  const panel = source.slice(panelStart, panelEnd);
  assert.match(panel, /canSeeInternalPricing[\s\S]*draftId[\s\S]*firmaSeguroProcessSigned/);
  assert.match(panel, /Corregir valores del cierre/);
  assert.match(panel, /correctSignedFinancialTerms/);
  assert.match(panel, /Corregir y exigir nueva firma/);
  assert.match(source, /creditInstallmentOptions\.map\(Number\)/);
});

test("el paso 2 exige datos completos incluso en la navegacion central", () => {
  const advance = sourceBlock("const advanceToStep", "const createWhatsAppOtp");
  const centralGuard = advance.indexOf("if (canAdminMoveFreelyInFactory)");
  const clientGuard = advance.indexOf("wizardStep === 1 && !stepClienteReady");
  const equipmentGuard = advance.indexOf("wizardStep === 2 && !stepEquipoReady");
  const identityAndSignatureGuard = advance.indexOf(
    "wizardStep === 4 && !stepIdentityContractReady"
  );

  assert.notEqual(centralGuard, -1);
  assert.notEqual(clientGuard, -1);
  assert.notEqual(equipmentGuard, -1);
  assert.notEqual(identityAndSignatureGuard, -1);
  assert.ok(centralGuard < clientGuard);
  assert.ok(equipmentGuard < centralGuard);
  assert.ok(centralGuard < identityAndSignatureGuard);
  assert.match(advance, /wizardStep === 1 && !stepClienteReady/);
  assert.match(advance, /wizardStep === 2 && !stepEquipoReady/);
  assert.match(advance, /wizardStep === 4 && !stepIdentityContractReady/);
  assert.match(advance, /targetStep > nextVisibleWizardStep\(wizardStep\)/);
  assert.doesNotMatch(
    advance,
    /targetStep > 1 && dataCreditoRequiresVeriff|wizardStep === 2 && !veriffApproved/
  );
});

test("el flujo Veriff visible conserva los pasos internos 1, 2, 4 y 5", () => {
  const factorySteps = sourceBlock("const factorySteps = [", "const draftStatusLabel");

  assert.match(factorySteps, /id: 1,[\s\S]*label: "Cliente"[\s\S]*DataCrédito y datos/);
  assert.match(factorySteps, /id: 2,[\s\S]*label: "Equipo"/);
  assert.match(
    factorySteps,
    /id: 4,[\s\S]*label: "Identidad y firma"[\s\S]*ready: stepIdentityContractReady/
  );
  assert.match(factorySteps, /id: 5,[\s\S]*label: "Enrolamiento y entrega"/);
  assert.match(
    factorySteps,
    /const visibleFactorySteps = hideIdentityWizardStep[\s\S]*factorySteps\.filter\(\(step\) => step\.id !== 3\)/
  );
});

test("la precalificacion bloquea el flujo normal pero no la inspeccion central", () => {
  assert.match(
    source,
    /const showDataCreditoGate\s*=\s*dataCreditoGatePending\s*&&\s*\(draftResumeHydrating \|\|\s*dataCreditoFinancialTermsRecovery \|\|\s*!canAdminMoveFreelyInFactory \|\|\s*wizardStep === 1\)/
  );
  assert.match(source, /\{showDataCreditoGate \? \(/);
  const gateDeclaration = source.match(/const showDataCreditoGate\s*=[\s\S]*?;/)?.[0];
  assert.ok(gateDeclaration);
  for (const pending of [true, false]) {
    for (const central of [true, false]) {
      for (const recovery of [true, false]) {
        for (const hydration of [true, false]) {
          for (const step of [1, 2, 4, 5]) {
            const actual = runInNewContext(`${gateDeclaration}\nshowDataCreditoGate`, {
              dataCreditoGatePending: pending, canAdminMoveFreelyInFactory: central,
              dataCreditoFinancialTermsRecovery: recovery, draftResumeHydrating: hydration, wizardStep: step,
            });
            assert.equal(actual, pending && (hydration || recovery || !central || step === 1));
          }
        }
      }
    }
  }
});

test("una inspeccion administrativa no persiste un paso ficticio", () => {
  const autosave = sourceBlock("const persistedWizardStep = canAdminMoveFreelyInFactory ? nextFactoryStep.id : wizardStep", "const handleDataCreditoBypass");

  assert.match(
    autosave,
    /const persistedWizardStep = canAdminMoveFreelyInFactory\s*\? nextFactoryStep\.id\s*:\s*wizardStep/
  );
  assert.match(autosave, /currentStep: persistedWizardStep/);
  assert.match(autosave, /serializeCreditDraftSaveRequest\(\{ draftId, currentStep: persistedWizardStep/);
  assert.match(autosave, /body: requestBody/);
  const serializer = sourceBlock("function serializeCreditDraftSaveRequest(", "function VeriffDraftPreparationFailure(");
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(serializer + "\nmodule.exports = serializeCreditDraftSaveRequest;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: loaded });
  const persistedStepDeclaration = autosave.match(/const persistedWizardStep =[^;]+;/)?.[0];
  assert.ok(persistedStepDeclaration);
  for (const central of [true, false]) {
    const persistedStep = runInNewContext(persistedStepDeclaration + "\npersistedWizardStep", {
      canAdminMoveFreelyInFactory: central, nextFactoryStep: { id: 2 }, wizardStep: 5,
    });
    const serialized = JSON.parse(loaded.exports({
      draftId: 11, currentStep: persistedStep, payload: { wizardStep: 5, clienteDocumento: "123456789" },
    }));
    assert.equal(serialized.id, 11);
    assert.equal(serialized.currentStep, central ? 2 : 5);
    assert.equal(serialized.payload.wizardStep, central ? 2 : 5);
    assert.equal(serialized.payload.clienteDocumento, "123456789");
  }
});

test("el permiso de inspeccion no participa en las validaciones de cierre", () => {
  for (const [start, end] of [
    ["const ventaLista", "const factorySteps"],
    ["const createCredit", "const handleFirmaSeguroStepReady"],
    ["const finalizeFirmaSeguroDelivery", "const registerPayment"],
  ]) {
    const block = sourceBlock(start, end);
    assert.doesNotMatch(block, /canAdminMoveFreelyInFactory/);
  }
});
