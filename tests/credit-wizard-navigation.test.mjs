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
  const sourceFile = ts.createSourceFile("credit-factory-console.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const autosaveCallbacks = [];
  const visitEffect = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect") {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback) && callback.getText(sourceFile).includes("closureFingerprintAtSchedule")) {
        autosaveCallbacks.push(callback);
      }
    }
    ts.forEachChild(node, visitEffect);
  };
  visitEffect(sourceFile);
  assert.equal(autosaveCallbacks.length, 1, "Debe encontrarse el efecto real de autoguardado");
  const autosave = autosaveCallbacks[0].getText(sourceFile);
  assert.match(autosave, /currentStep: persistedWizardStep/);
  assert.match(autosave, /serializeCreditDraftSaveRequest\(\{ draftId, currentStep: persistedWizardStep/);
  assert.match(autosave, /body: requestBody/);
  const serializer = sourceBlock("function serializeCreditDraftSaveRequest(", "function VeriffDraftPreparationFailure(");
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(serializer + "\nmodule.exports = serializeCreditDraftSaveRequest;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: loaded });
  const persistedStepInitializers = [];
  let resolvePersistedDraftStep;
  const visitDeclaration = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "persistedWizardStep" && node.initializer) {
      persistedStepInitializers.push(node.initializer.getText(sourceFile));
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "resolvePersistedDraftStep") resolvePersistedDraftStep = node.initializer?.getText(sourceFile);
    ts.forEachChild(node, visitDeclaration);
  };
  visitDeclaration(autosaveCallbacks[0]);
  assert.equal(persistedStepInitializers.length, 1);
  visitDeclaration(sourceFile);
  assert.ok(resolvePersistedDraftStep);
  const scenarios = [
    { central: true, visible: 2, available: 4, expected: 2, label: "Equipo listo no avanza sin confirmar el IMEI" },
    { central: true, visible: 2, available: 5, expected: 2, label: "Equipo no salta a entrega por autoguardado" },
    { central: true, visible: 4, available: 5, expected: 4, label: "Firma no avanza a entrega por autoguardado" },
    { central: true, visible: 5, available: 2, expected: 2, label: "Inspeccionar entrega no inventa progreso" },
    { central: true, visible: 4, available: 2, expected: 2, label: "Inspeccionar firma conserva el progreso real" },
    { central: true, visible: 5, available: 4, expected: 4, label: "Inspeccionar entrega conserva firma pendiente" },
    { central: true, visible: 1, available: 1, expected: 1, label: "Cliente incompleto sigue en Cliente" },
    { central: true, visible: 1, available: 4, expected: 2, label: "Volver a Cliente no restaura un paso posterior a Equipo" },
    { central: false, visible: 1, available: 4, expected: 1, label: "Asesor conserva Cliente visible" },
    { central: false, visible: 2, available: 4, expected: 2, label: "Asesor conserva Equipo visible" },
    { central: false, visible: 4, available: 5, expected: 4, label: "Asesor conserva Firma visible" },
    { central: false, visible: 5, available: 2, expected: 5, label: "Asesor conserva Entrega visible" },
    { central: true, visible: 4, available: 4, confirmed: false, expected: 2, label: "Inspeccionar Identidad no confirma el IMEI" },
    { central: false, visible: 4, available: 4, confirmed: false, expected: 2, label: "Identidad restaurada sin confirmación no persiste un avance" },
  ];
  for (const { central, visible, available, confirmed = true, expected, label } of scenarios) {
    const evaluated = ts.transpileModule(`const resolvePersistedDraftStep = ${resolvePersistedDraftStep};\n(${persistedStepInitializers[0]})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const persistedStep = runInNewContext(evaluated, {
      canAdminMoveFreelyInFactory: central, nextFactoryStep: { id: available }, wizardStep: visible,
      draftId: 2887, imeiDigits: "035809100123456",
      equipmentImeiConfirmationRef: { current: confirmed ? { draftId: 2887, imei: "035809100123456" } : null },
    });
    assert.equal(persistedStep, expected, label);
    const serialized = JSON.parse(loaded.exports({
      draftId: 11, currentStep: persistedStep, payload: { wizardStep: visible, clienteDocumento: "123456789" },
    }));
    assert.equal(serialized.id, 11);
    assert.equal(serialized.currentStep, expected, label);
    assert.equal(serialized.payload.wizardStep, expected, label);
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
