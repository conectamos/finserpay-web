import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("credit-factory-console.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNodes(predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return matches;
}

function declaration(name) {
  const matches = findNodes(node => ts.isVariableDeclaration(node) && node.name.getText(parsed) === name);
  assert.equal(matches.length, 1, `Debe existir una sola declaración real de ${name}`);
  return `const ${matches[0].getText(parsed)};`;
}

function execute(code, context) {
  return runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, Object.assign(context, { require, Error, URLSearchParams, exports: {} }), { timeout: 1000 });
}

const currency = value => `$${Number(value).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
const uuid = "00000000-0000-4000-8000-000000000001";
const originalProcess = "signed-process-23";
const checksum = "a".repeat(64);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(overrides = {}) {
  const requests = [];
  const changes = [];
  const confirmations = [];
  let nextKey = 0;
  let confirmResult = true;
  let nextResult = async () => ({ ok: true, data: { ok: true } });
  const context = {
    canSeeInternalPricing: true,
    canCorrectStepTwoInstallments: true,
    createClientMode: true,
    simulatorMode: false,
    draftId: 23,
    wizardStep: 2,
    firmaSeguroDraftProcess: { processUuid: originalProcess, financialTermsChecksum: checksum },
    firmaSeguroProcessSigned: true,
    signedCreditRemission: { valorVenta: 3_575_000, valorInicial: 1_160_000, numeroCuotas: 30 },
    signedTermsCorrectionSale: "999999999",
    signedTermsCorrectionInitial: "1",
    signedTermsCorrectionInstallments: "24",
    signedTermsCorrectionReason: "Cliente solicita un plazo más corto",
    creditInstallmentOptions: ["16", "24", "30"],
    factoryClosingOperationInFlightRef: { current: false },
    signedTermsCorrectionRequestRef: { current: null },
    firmaSeguroRefreshGenerationRef: { current: 10 },
    firmaSeguroRefreshBindingRef: { current: { draftId: 23, processUuid: originalProcess } },
    currency,
    window: {
      confirm: message => { confirmations.push(message); return confirmResult; },
      crypto: { randomUUID: () => { nextKey++; return nextKey === 1 ? uuid : `00000000-0000-4000-8000-${String(nextKey).padStart(12, "0")}`; } },
    },
    requestJson: async (url, init) => { requests.push({ url, ...init }); return nextResult(url, init); },
    cancelPendingDraftAutosave: force => changes.push(["cancelPendingDraftAutosave", force]),
    applyDraftPayload: draft => changes.push(["applyDraftPayload", draft]),
    ...overrides,
  };
  for (const name of [
    "setNotice", "setFirmaSeguroRefreshing", "setSignedTermsCorrectionBusy", "setValorEquipoTotal",
    "setCuotaInicial", "setPlazoMeses", "setFirmaSeguroFinancialCorrectionPending", "setFirmaSeguroDraftProcess",
    "setFirmaSeguroPendingDraftId", "setFotoRemisionDataUrl", "setFotoRemisionAudit",
    "setPersistedIphoneClosureFingerprint", "setWizardStep", "setDraftStatus", "setSignedTermsCorrectionReason",
  ]) {
    context[name] = value => {
      changes.push([name, value]);
      if (name === "setSignedTermsCorrectionReason") context.signedTermsCorrectionReason = value;
    };
  }
  const handler = execute(`${declaration("correctSignedFinancialTerms")}\ncorrectSignedFinancialTerms`, context);
  return {
    context, requests, changes, confirmations,
    run: options => handler(options ?? { installmentsOnly: true }),
    respondWith: callback => { nextResult = callback; },
    cancel: () => { confirmResult = false; },
    get generatedKeys() { return nextKey; },
  };
}

test("la corrección de cuotas del paso 2 solo se habilita al administrador central con contrato firmado", () => {
  for (const createClientMode of [false, true]) for (const simulatorMode of [false, true]) {
    for (const canSeeInternalPricing of [false, true]) for (const draftId of [null, 23]) {
      for (const firmaSeguroProcessSigned of [false, true]) for (const signedCreditRemission of [null, { numeroCuotas: 30 }]) {
        const allowed = execute(`${declaration("canCorrectStepTwoInstallments")}\ncanCorrectStepTwoInstallments`, {
          createClientMode, simulatorMode, canSeeInternalPricing, draftId, firmaSeguroProcessSigned, signedCreditRemission,
        });
        assert.equal(allowed, Boolean(createClientMode && !simulatorMode && canSeeInternalPricing && draftId && firmaSeguroProcessSigned && signedCreditRemission));
      }
    }
  }
});

test("el formulario de corrección está fuera del plan bloqueado y abrirlo no guarda ni modifica valores", () => {
  const panels = findNodes(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(parsed) === "details" &&
    node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(parsed) === "data-testid" &&
      attribute.initializer?.getText(parsed) === '"step-two-signed-installment-correction"'));
  assert.equal(panels.length, 1);
  const panel = panels[0];
  assert.doesNotMatch(panel.openingElement.getText(parsed), /\bopen(?:\s|=|>)/);
  for (let ancestor = panel.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isJsxElement(ancestor)) assert.notEqual(ancestor.openingElement.tagName.getText(parsed), "fieldset", "la acción privilegiada no debe quedar deshabilitada por el plan original");
  }
  const summary = panel.children.find(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(parsed) === "summary");
  assert.ok(summary);
  assert.match(summary.getText(parsed), /Editar cuotas/);
  assert.doesNotMatch(summary.getText(parsed), /onClick|requestJson|setPlazoMeses|setCuotaInicial|setValorEquipoTotal/);
  assert.match(panel.getText(parsed), /correctSignedFinancialTerms\(\{\s*installmentsOnly: true\s*\}\)/);
  assert.match(panel.getText(parsed), /signedTermsCorrectionInstallments/);
  assert.match(panel.getText(parsed), /signedTermsCorrectionReason/);
  assert.doesNotMatch(panel.getText(parsed), /setPlazoMeses\(|setCuotaInicial\(|setValorEquipoTotal\(/);
});

test("los controles reales permiten elegir cuotas y motivo sin alterar el plan antes de confirmar", () => {
  const panels = findNodes(node => ts.isJsxElement(node) && node.openingElement.getText(parsed).includes('data-testid="step-two-signed-installment-correction"'));
  assert.equal(panels.length, 1);
  const panel = panels[0];
  let visibility = panel.parent;
  while (visibility && !ts.isConditionalExpression(visibility)) visibility = visibility.parent;
  assert.ok(visibility);
  const changes = [];
  const Button = () => null;
  const icons = Object.fromEntries(["SquarePen", "ChevronRight", "LoaderCircle", "RotateCcw"].map(name => [name, () => null]));
  const render = (overrides = {}) => execute(`(${visibility.getText(parsed)})`, {
    canCorrectStepTwoInstallments: true, stepFourStyles: {}, Button, ...icons,
    signedTermsCorrectionBusy: false, creating: false, firmaSeguroImeiCorrecting: false,
    firmaSeguroSubmitting: false, firmaSeguroRefreshing: false,
    signedTermsCorrectionInstallments: "24", signedTermsCorrectionInstallmentOptions: [16, 24, 30],
    signedTermsCorrectionReason: "Plazo solicitado por el cliente", signedCreditRemission: { numeroCuotas: 30 },
    creditInstallmentOptions: ["16", "24", "30"],
    setSignedTermsCorrectionInstallments: value => changes.push(["cuotas", value]),
    setSignedTermsCorrectionReason: value => changes.push(["motivo", value]),
    correctSignedFinancialTerms: options => changes.push(["confirmar", options.installmentsOnly]),
    ...overrides,
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [value, ...nodes(value.props?.children)];
  const all = nodes(render());
  const selector = all.find(node => node.type === "select");
  assert.equal(selector.props.value, "24");
  assert.equal(all.find(node => node.type === "fieldset").props.disabled, false);
  assert.deepEqual([...nodes(selector.props.children).filter(node => node.type === "option").map(node => node.props.value)], [16, 24, 30]);
  selector.props.onChange({ target: { value: "16" } });
  all.find(node => node.type === "input").props.onChange({ target: { value: "Motivo revisado" } });
  assert.deepEqual(changes, [["cuotas", "16"], ["motivo", "Motivo revisado"]]);
  const button = all.find(node => node.type === Button);
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.deepEqual(changes.at(-1), ["confirmar", true]);
  for (const override of [{ signedTermsCorrectionReason: "" }, { signedTermsCorrectionInstallments: "30" }, { signedTermsCorrectionInstallments: "60" }]) {
    assert.equal(nodes(render(override)).find(node => node.type === Button).props.disabled, true);
  }
  for (const key of ["signedTermsCorrectionBusy", "creating", "firmaSeguroImeiCorrecting", "firmaSeguroSubmitting", "firmaSeguroRefreshing"]) {
    assert.equal(nodes(render({ [key]: true })).find(node => node.type === "fieldset").props.disabled, true);
  }
  assert.equal(render({ canCorrectStepTwoInstallments: false }), null);
});

test("el handler rechaza perfiles no centrales, firma no vigente y navegación fuera de Equipo", async () => {
  for (const overrides of [
    { canSeeInternalPricing: false, canCorrectStepTwoInstallments: false },
    { draftId: null, canCorrectStepTwoInstallments: false },
    { firmaSeguroProcessSigned: false, canCorrectStepTwoInstallments: false },
    { signedCreditRemission: null, canCorrectStepTwoInstallments: false },
    { canCorrectStepTwoInstallments: false },
    { wizardStep: 4 },
  ]) {
    const f = fixture(overrides);
    await f.run();
    assert.equal(f.requests.length, 0);
    assert.equal(f.confirmations.length, 0);
    assert.ok(f.changes.some(([name, value]) => name === "setNotice" && value?.text));
  }
});

test("no confirma plazos fuera de la política ni un plazo idéntico al firmado", async () => {
  for (const value of ["", "0", "-1", "1.5", "240", "31", "30"]) {
    const f = fixture({ signedTermsCorrectionInstallments: value });
    await f.run();
    assert.equal(f.requests.length, 0, value);
    assert.equal(f.confirmations.length, 0, value);
    assert.ok(f.changes.some(([name, notice]) => name === "setNotice" && notice?.text), value);
  }
});

test("el motivo es obligatorio y cancelar conserva los datos sin enviar ni detener autosave", async () => {
  const missing = fixture({ signedTermsCorrectionReason: " abc " });
  await missing.run();
  assert.equal(missing.requests.length, 0);
  assert.equal(missing.confirmations.length, 0);
  const cancelled = fixture();
  cancelled.cancel();
  await cancelled.run();
  assert.equal(cancelled.confirmations.length, 1);
  assert.match(cancelled.confirmations[0], /24 cuotas/);
  assert.match(cancelled.confirmations[0], /histórico|historial/);
  assert.match(cancelled.confirmations[0], /nueva versión|nueva firma/);
  assert.equal(cancelled.requests.length, 0);
  assert.equal(cancelled.generatedKeys, 0);
  assert.equal(cancelled.context.signedTermsCorrectionReason, "Cliente solicita un plazo más corto");
  assert.equal(cancelled.changes.some(([name]) => name === "cancelPendingDraftAutosave" || name === "setPlazoMeses"), false);
});

test("el PATCH de cuotas toma venta e inicial selladas y exige firmar una nueva versión", async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, "/api/creditos/borradores/23/terminos-firmados");
  assert.equal(request.method, "PATCH");
  assert.deepEqual(JSON.parse(request.body), {
    idempotencyKey: uuid, expectedProcessUuid: originalProcess, expectedFinancialTermsChecksum: checksum,
    reason: "Cliente solicita un plazo más corto", valorEquipoTotal: 3_575_000, cuotaInicial: 1_160_000, plazoMeses: 24,
  });
  assert.match(f.confirmations[0], /3\.575\.000/);
  assert.match(f.confirmations[0], /1\.160\.000/);
  assert.ok(f.changes.some(([name, value]) => name === "cancelPendingDraftAutosave" && value === true));
  assert.ok(f.changes.some(([name, value]) => name === "setFirmaSeguroFinancialCorrectionPending" && value === true));
  assert.ok(f.changes.some(([name, value]) => name === "setFirmaSeguroDraftProcess" && value === null));
  assert.ok(f.changes.some(([name, value]) => name === "setFotoRemisionDataUrl" && value === ""));
  assert.ok(f.changes.some(([name, value]) => name === "setWizardStep" && value === 4), "el paso interno 4 es Identidad y firma");
  assert.equal(f.requests.some(request => /firma-seguro$/.test(request.url)), false, "corregir no envía contratos automáticamente");
  assert.equal(f.context.factoryClosingOperationInFlightRef.current, false);
  assert.equal(f.context.signedTermsCorrectionRequestRef.current, null);
});

test("un doble clic envía una sola corrección mientras la primera sigue pendiente", async () => {
  const pending = deferred();
  const f = fixture();
  f.respondWith(() => pending.promise);
  const first = f.run();
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.context.factoryClosingOperationInFlightRef.current, true);
  pending.resolve({ ok: true, data: { ok: true } });
  await first;
  assert.equal(f.context.factoryClosingOperationInFlightRef.current, false);
});

test("un error conserva cuotas y motivo y reintentar exactamente el mismo cambio reusa la clave", async () => {
  const f = fixture();
  f.respondWith((url, init) => init?.method === "PATCH"
    ? { ok: false, data: { ok: false, error: "El plazo supera el máximo autorizado." } }
    : { ok: true, data: { ok: true, item: { id: 23, payload: {} } } });
  await f.run();
  assert.equal(f.context.signedTermsCorrectionInstallments, "24");
  assert.equal(f.context.signedTermsCorrectionReason, "Cliente solicita un plazo más corto");
  assert.ok(f.changes.some(([name, notice]) => name === "setNotice" && notice?.text === "El plazo supera el máximo autorizado."));
  assert.equal(f.changes.some(([name]) => name === "setPlazoMeses" || name === "setWizardStep"), false);
  const firstKey = JSON.parse(f.requests.find(request => request.method === "PATCH").body).idempotencyKey;
  f.respondWith(() => ({ ok: true, data: { ok: true } }));
  await f.run();
  const patches = f.requests.filter(request => request.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.equal(JSON.parse(patches[1].body).idempotencyKey, firstKey);
  assert.equal(f.generatedKeys, 1);
});

test("un cambio del motivo después de un fallo obtiene su propia clave de corrección", async () => {
  const f = fixture();
  f.respondWith((url, init) => init?.method === "PATCH" ? { ok: false, data: { error: "No disponible." } } : { ok: false });
  await f.run();
  f.context.signedTermsCorrectionReason = "Nuevo motivo verificado por el administrador";
  f.respondWith(() => ({ ok: true, data: { ok: true } }));
  await f.run();
  const patches = f.requests.filter(request => request.method === "PATCH");
  assert.notEqual(JSON.parse(patches[0].body).idempotencyKey, JSON.parse(patches[1].body).idempotencyKey);
});

test("una respuesta incierta se reconcilia con la corrección ya guardada sin repetir el PATCH", async () => {
  const f = fixture();
  const authoritative = { id: 23, payload: {
    firmaSeguroFinancialCorrectionPending: true, firmaSeguroFinancialCorrectionId: uuid,
    valorEquipoTotal: "3575000", cuotaInicial: "1160000", plazoMeses: "24",
  } };
  f.respondWith((url, init) => {
    if (init?.method === "PATCH") throw new Error("Conexión interrumpida");
    if (url.startsWith("/api/creditos/borradores?")) return { ok: true, data: { item: authoritative } };
    if (url === "/api/creditos/borradores/23/firma-seguro") return { ok: true, data: { ok: true, process: null } };
    throw new Error("Consulta inesperada: " + url);
  });
  await f.run();
  assert.equal(f.requests.filter(request => request.method === "PATCH").length, 1);
  assert.ok(f.changes.some(([name, value]) => name === "applyDraftPayload" && value === authoritative));
  assert.ok(f.changes.some(([name, value]) => name === "setWizardStep" && value === 4));
  assert.ok(f.changes.some(([name, notice]) => name === "setNotice" && /confirmamos que los valores sí fueron corregidos/.test(notice?.text || "")));
});

test("la conciliación solo acepta el expediente y la clave de corrección esperados", async () => {
  for (const item of [
    { id: 99, payload: { firmaSeguroFinancialCorrectionPending: true, firmaSeguroFinancialCorrectionId: uuid } },
    { id: 23, payload: { firmaSeguroFinancialCorrectionPending: true, firmaSeguroFinancialCorrectionId: "otra-correccion" } },
  ]) {
    const f = fixture();
    f.respondWith((url, init) => init?.method === "PATCH"
      ? { ok: false, data: { error: "Resultado no confirmado" } }
      : { ok: true, data: { item } });
    await f.run();
    assert.equal(f.requests.length, 2);
    assert.equal(f.changes.some(([name]) => name === "applyDraftPayload" || name === "setWizardStep"), false);
    assert.equal(f.context.signedTermsCorrectionReason, "Cliente solicita un plazo más corto");
    assert.equal(f.context.signedTermsCorrectionRequestRef.current.idempotencyKey, uuid);
  }
});

test("la corrección completa de cierre conserva los valores editados del flujo existente", async () => {
  const f = fixture({ signedTermsCorrectionSale: "3600000", signedTermsCorrectionInitial: "1200000" });
  await f.run({ installmentsOnly: false });
  assert.equal(f.requests.length, 1);
  const body = JSON.parse(f.requests[0].body);
  assert.equal(body.valorEquipoTotal, 3_600_000);
  assert.equal(body.cuotaInicial, 1_200_000);
  assert.equal(body.plazoMeses, 24);
});

test("una respuesta de corrección tardía no aplica cambios a otro expediente o versión", async () => {
  for (const binding of [{ draftId: 99, processUuid: "otro-expediente" }, { draftId: 23, processUuid: "nueva-version" }]) {
    for (const result of [{ ok: true, data: { ok: true } }, { ok: false, data: { error: "Versión reemplazada" } }]) {
      const pending = deferred();
      const f = fixture();
      f.respondWith(() => pending.promise);
      const running = f.run();
      f.context.firmaSeguroRefreshBindingRef.current = binding;
      pending.resolve(result);
      await running;
      assert.equal(f.requests.length, 1, "no consulta ni reconcilia una respuesta de otro expediente");
      assert.equal(f.changes.some(([name]) => ["setValorEquipoTotal", "setCuotaInicial", "setPlazoMeses", "setWizardStep", "applyDraftPayload"].includes(name)), false);
      assert.equal(f.context.signedTermsCorrectionReason, "Cliente solicita un plazo más corto");
    }
  }
});

test("también descarta conciliaciones tardías después de cargar borrador o estado de firma", async () => {
  for (const stopAt of ["draft", "process"]) {
    const pending = deferred();
    const f = fixture();
    const authoritative = { id: 23, payload: { firmaSeguroFinancialCorrectionPending: true, firmaSeguroFinancialCorrectionId: uuid } };
    f.respondWith((url, init) => {
      if (init?.method === "PATCH") throw new Error("Resultado incierto");
      if (url.startsWith("/api/creditos/borradores?")) return stopAt === "draft" ? pending.promise : { ok: true, data: { item: authoritative } };
      if (url.endsWith("/firma-seguro")) return pending.promise;
      throw new Error("Consulta inesperada");
    });
    const running = f.run();
    await setImmediate();
    assert.equal(f.requests.length, stopAt === "draft" ? 2 : 3);
    f.context.firmaSeguroRefreshBindingRef.current = { draftId: 99, processUuid: "otra-firma" };
    pending.resolve(stopAt === "draft" ? { ok: true, data: { item: authoritative } } : { ok: true, data: { ok: true, process: null } });
    await running;
    assert.equal(f.changes.some(([name]) => ["setValorEquipoTotal", "setCuotaInicial", "setPlazoMeses", "setWizardStep", "applyDraftPayload"].includes(name)), false);
    assert.equal(f.context.signedTermsCorrectionReason, "Cliente solicita un plazo más corto");
  }
});
