import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const readSource = (name) => readFileSync(new URL(`app/dashboard/parametros-credito/${name}`, root), "utf8");
const jsx = (type, props) => ({ type, props });
const controls = new Proxy({}, { get: (_, key) => String(key) });
const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" ? [node, ...nodes(node.props?.children), ...nodes(node.props?.action)] : [];
const text = (node) => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number"
  ? String(node) : text(node?.props?.children ?? node?.props?.title ?? "");
const endpoint = "/api/creditos/datacredito/cupos-manuales";
const removalModule = { exports: {} };
runInNewContext(ts.transpileModule(readFileSync(new URL("lib/datacredito/policy-band-removal.ts", root), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: removalModule, exports: removalModule.exports, require(name) {
  assert.equal(name, "./policy");
  return { DATACREDITO_MIN_SCORE: 0, DATACREDITO_MAX_SCORE: 950, DATACREDITO_NO_INFORMATION_SCORE: -1 };
} });
const savedCap = { id: "cap-1", documentLast4: "6789", maxFinancedAmount: 3_200_000,
  reason: "Revisión administrativa completa", active: true, version: 4,
  createdAt: "2026-09-20T13:00:00.000Z", updatedAt: "2026-10-14T15:00:00.000Z" };

function mountConsole(sourceName, fetch, { renderTabChildren = false } = {}) {
  const focusedIds = [], scrolledIds = [];
  let slots = [];
  const scopes = new Map();
  let seenScopes = new Set();
  const modules = new Map();
  const childComponents = new Set();
  let index = 0, dirty = true, pendingEffects = [], tree;
  const hooks = {
    useState(initial) { const i = index++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[i]; return [slot.value, value => { slot.value = typeof value === "function" ? value(slot.value) : value; dirty = true; }]; },
    useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    useMemo(factory, dependencies) { const i = index++; if (!slots[i] || !sameDeps(slots[i].deps, dependencies)) slots[i] = { value: factory(), deps: dependencies }; return slots[i].value; },
    useCallback(callback, dependencies) { return hooks.useMemo(() => callback, dependencies); },
    useEffect(effect, dependencies) { const i = index++; if (!slots[i] || !sameDeps(slots[i].deps, dependencies)) {
      const previous = slots[i]; slots[i] = { deps: dependencies, cleanup: previous?.cleanup };
      const slot = slots[i]; pendingEffects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
    } },
  };
  function loadModule(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const compiled = ts.transpileModule(readSource(filename), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const loaded = { exports: {} }; modules.set(filename, loaded.exports);
    runInNewContext(compiled, { module: loaded, exports: loaded.exports, fetch, console, Intl, Date, Error,
    AbortController, DOMException, URLSearchParams, crypto: { randomUUID },
    document: { getElementById: id => ({ scrollIntoView() { scrolledIds.push(id); }, focus() { focusedIds.push(id); } }) },
    window: { addEventListener() {}, removeEventListener() {}, requestAnimationFrame(callback) { callback(); } },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name === "@/app/_components/finser-ui" || name === "./credit-parameters-ui") return controls;
      if (name === "./credit-parameters.module.css") return { default: controls };
      if (name === "@/app/_components/finser-confirm-dialog") return { default: "ConfirmDialog" };
      if (name === "@/lib/datacredito/policy-band-removal") return removalModule.exports;
      if (name.endsWith("/manual-credit-cap-console") || name.endsWith("/second-credit-authorization-console")) {
        const isManual = name.endsWith("/manual-credit-cap-console");
        if (!renderTabChildren) return { default: isManual ? "ManualCreditCapConsole" : "SecondCreditAuthorizationConsole" };
        const loadedChild = loadModule(isManual ? "manual-credit-cap-console.tsx" : "second-credit-authorization-console.tsx");
        childComponents.add(loadedChild.default); return loadedChild;
      }
      if (name === "@/lib/datacredito/policy") return {
        DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT: 100_000_000, DATACREDITO_MIN_SCORE: 0, DATACREDITO_MAX_SCORE: 950,
        DATACREDITO_NO_INFORMATION_SCORE: -1, DATACREDITO_MAX_INSTALLMENT_COUNT: 60,
        DATACREDITO_DEFAULT_ANDROID_INSTALLMENT_COUNT: 16, DATACREDITO_DEFAULT_IPHONE_INSTALLMENT_COUNT: 24,
        DATACREDITO_DEFAULT_IPHONE_MAX_INSTALLMENT_AMOUNT: 160_000, DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS: financialDefaults,
      };
      throw new Error(name);
    },
    });
    modules.set(filename, loaded.exports); return loaded.exports;
  }
  const loaded = loadModule(sourceName);
  function renderScope(name, component, props) {
    const previousSlots = slots, previousIndex = index;
    if (!scopes.has(name)) scopes.set(name, []);
    slots = scopes.get(name); index = 0; seenScopes.add(name);
    const result = component(props);
    slots = previousSlots; index = previousIndex; return result;
  }
  function expandChildren(node) {
    if (Array.isArray(node)) return node.map(expandChildren);
    if (!node || typeof node !== "object") return node;
    if (childComponents.has(node.type)) return { ...node, props: { ...node.props, children: expandChildren(renderScope(node.type.name, node.type, node.props)) } };
    return { ...node, props: { ...node.props, children: expandChildren(node.props?.children), action: expandChildren(node.props?.action) } };
  }
  return {
    focusedIds, scrolledIds,
    async flush() { for (let n = 0; n < 25; n++) {
      if (dirty) {
        dirty = false; pendingEffects = []; seenScopes = new Set();
        tree = expandChildren(renderScope("root", loaded.default));
        for (const [name, state] of scopes) if (!seenScopes.has(name)) { state.forEach(slot => slot?.cleanup?.()); scopes.delete(name); }
        for (const effect of pendingEffects) effect();
      }
      await setImmediate(); if (!dirty) return;
    } throw new Error("Manual cap UI did not settle"); },
    find(predicate) { const found = nodes(tree).find(predicate); assert.ok(found, "Expected rendered control"); return found; },
    all(predicate) { return nodes(tree).filter(predicate); },
    text: () => text(tree),
  };
}
const mountManual = (fetch) => mountConsole("manual-credit-cap-console.tsx", fetch);
const mountPolicy = (fetch) => mountConsole("datacredito-policy-console.tsx", fetch);
function sameDeps(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, i) => Object.is(value, right[i])); }
const byId = (h, id) => h.find(node => node.props?.id === id);
const dialog = h => h.find(node => node.type === "ConfirmDialog");
async function fillCreate(h, documentNumber = "00123456789") {
  byId(h, "manual-cap-document").props.onChange({ target: { value: documentNumber } });
  byId(h, "manual-cap-amount").props.onChange({ target: { value: "3200000" } });
  byId(h, "manual-cap-reason").props.onChange({ target: { value: "Revisión administrativa completa" } });
  await h.flush();
  h.find(node => node.type === "form" && node.props.noValidate).props.onSubmit({ preventDefault() {} });
  await h.flush();
}

test("manual cap preserves document zeros, confirms explicitly, and prevents two saves in the same event cycle", async () => {
  const requests = [];
  let resolveMutation;
  const h = mountManual(async (url, options) => {
    requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    if (options?.method === "POST") return await new Promise(resolve => { resolveMutation = resolve; });
    return Response.json({ ok: true, items: [savedCap] });
  });
  await h.flush();
  assert.equal(requests.length, 1);
  assert.match(h.text(), /•••• 6789/);
  assert.doesNotMatch(h.text(), /00123456789/);
  await fillCreate(h);
  assert.equal(requests.length, 1, "Opening confirmation must not save");
  assert.equal(dialog(h).props.open, true);
  const confirm = dialog(h).props.onConfirm;
  confirm(); confirm();
  await h.flush();
  assert.equal(requests.filter(request => request.options?.method === "POST").length, 1);
  assert.equal(requests[1].url, endpoint);
  assert.equal(requests[1].body.documentNumber, "00123456789");
  assert.equal(requests[1].body.maxFinancedAmount, 3_200_000);
  assert.match(requests[1].body.mutationId, /^[0-9a-f-]{36}$/);
  dialog(h).props.onCancel(); await h.flush();
  assert.equal(dialog(h).props.open, true, "Backdrop cancel must be blocked while saving");
  resolveMutation(Response.json({ ok: true })); await h.flush();
  assert.equal(dialog(h).props.open, false);
  assert.match(h.text(), /creado correctamente/);
});

test("failed manual save retains the editable data and reuses the confirmed mutation id on retry", async () => {
  const requests = [];
  let fail = true;
  const h = mountManual(async (url, options) => {
    requests.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    if (options?.method === "POST") {
      if (fail) { fail = false; return Response.json({ ok: false, error: "Guardado no disponible", correlationId: "QA-RETRY" }, { status: 503 }); }
      return Response.json({ ok: true });
    }
    return Response.json({ ok: true, items: [] });
  });
  await h.flush(); await fillCreate(h); dialog(h).props.onConfirm(); await h.flush();
  assert.equal(dialog(h).props.open, true);
  assert.match(dialog(h).props.description, /Guardado no disponible/);
  assert.match(dialog(h).props.description, /QA-RETRY/);
  assert.equal(byId(h, "manual-cap-document").props.value, "00123456789");
  assert.equal(byId(h, "manual-cap-amount").props.value, "3200000");
  assert.equal(byId(h, "manual-cap-reason").props.value, "Revisión administrativa completa");
  dialog(h).props.onConfirm(); await h.flush();
  const saves = requests.filter(request => request.body?.mutationId);
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[0].body, saves[1].body);
  assert.equal(dialog(h).props.open, false);
});

test("manual search sends exact identifier privately and status toggles preserve expected version", async () => {
  const requests = [];
  const h = mountManual(async (url, options) => {
    requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return Response.json({ ok: true, items: [savedCap] });
  });
  await h.flush();
  byId(h, "manual-cap-search").props.onChange({ target: { value: "00123456789" } }); await h.flush();
  h.find(node => node.type === "form" && !node.props.noValidate).props.onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(requests[1].url, `${endpoint}/buscar`);
  assert.equal(requests[1].options.method, "POST");
  assert.deepEqual(requests[1].body, { documentNumber: "00123456789", estado: "ALL" });
  assert.ok(requests.every(request => !request.url.includes("00123456789")));
  h.find(node => node.type === "Button" && node.props["aria-label"] === "Desactivar cupo de cédula terminada en 6789").props.onClick(); await h.flush();
  assert.equal(requests.length, 2, "Opening status confirmation is read-only");
  dialog(h).props.onConfirm(); await h.flush();
  assert.equal(requests[2].options.method, "PATCH");
  assert.equal(requests[2].body.expectedVersion, 4);
  assert.equal(requests[2].body.active, false);
  assert.equal(requests[2].body.id, "cap-1");
  assert.ok(requests[2].body.mutationId);
});

const financialDefaults = {
  calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 25.2, fianzaTotalPorcentaje: 75,
  seguroCuotaPorcentaje: 0.5, frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6,
  redondeoComercial: { modo: "PISO", multiplo: 50 },
};
function catalog() {
  const bands = ["ANDROID", "IPHONE"].flatMap(platform => [
    { id: `${platform.toLowerCase()}-empty`, platform, scoreMin: -1, scoreMax: -1, decision: "RECHAZADO", initialPaymentPercentage: 40, suretyPercentage: 75, maxFinancedAmount: 600_000, installmentCount: 16, maxInstallmentAmount: platform === "IPHONE" ? 160_000 : null },
    { id: `${platform.toLowerCase()}-low`, platform, scoreMin: 0, scoreMax: 499, decision: "RECHAZADO", initialPaymentPercentage: 30, suretyPercentage: 75, maxFinancedAmount: 850_000, installmentCount: 24, maxInstallmentAmount: platform === "IPHONE" ? 160_000 : null },
    { id: `${platform.toLowerCase()}-high`, platform, scoreMin: 500, scoreMax: 950, decision: "APROBADO", initialPaymentPercentage: 20, suretyPercentage: 75, maxFinancedAmount: 3_500_000, installmentCount: 48, maxInstallmentAmount: platform === "IPHONE" ? 160_000 : null },
  ]);
  const priorityRules = {
    telcoDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 2_000_000, IPHONE: 2_000_000 } },
    totalDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 3_000_000, IPHONE: 3_000_000 } },
  };
  return { ok: true, defaultPolicyId: "general", financialDefaults,
    provider: { enabled: true, configured: true, environment: "PRODUCTION", productionReady: true },
    profiles: ["general", "other"].map((id, index) => ({ id, name: index ? "Otra política" : "Política general", description: null,
      active: true, version: index ? 3 : 10, bands, priorityRules, financialSettings: financialDefaults,
      createdAt: "2026-09-20T13:00:00.000Z", updatedAt: "2026-10-14T15:00:00.000Z", revisionCreatedAt: "2026-10-14T15:00:00.000Z", assignedAlliesCount: index ? 0 : 2 })),
    allies: ["Aliado Alfa QA", "Aliado Beta QA"].map((name, i) => ({ id: i + 1, name, code: `QA${i + 1}`, active: true,
      policyId: "general", policyName: "Política general", dailyQueryLimit: 20, dailyQueriesUsed: 3,
      dailyQueriesRemaining: 17, dailyQuotaResetsAt: "2026-10-15T05:00:00.000Z" })),
  };
}
const policyButton = (h, label) => h.find(node => node.type === "Button" && text(node).trim() === label);
const policyDialog = (h, title) => h.find(node => node.type === "ConfirmDialog" && node.props.title === title);
const platformEditor = (h, platform = "ANDROID") => h.find(node => typeof node.type === "function" && node.type.name === "PlatformEditor" && node.props.platform === platform);

const createStepTitles = ["Datos de la política", "Reglas de evaluación", "Condiciones del crédito", "Revisar nueva política"];
const currentCopyStep = h => createStepTitles.indexOf(text(byId(h, "policy-create-step-title")).trim()) + 1;
async function goCopyStep(h, destination) {
  for (let tries = 0; currentCopyStep(h) !== destination && tries < 8; tries += 1) {
    const current = currentCopyStep(h);
    assert.ok(current >= 1 && current <= 4, "La etapa de creación debe estar identificada");
    const control = byId(h, current > destination ? "new-policy-back" : "new-policy-continue");
    assert.ok(!control.props.disabled, `La etapa ${current} válida permite navegar a ${destination}`);
    control.props.onClick(); await h.flush();
  }
  assert.equal(currentCopyStep(h), destination);
}
async function beginPolicyCopy(h, name = "Recuperar cartera", step = 3) {
  policyButton(h, "Nueva política").props.onClick();
  await h.flush();
  byId(h, "new-policy-name").props.onChange({ target: { value: name } });
  await h.flush();
  await goCopyStep(h, step);
}
async function enablePolicyEditing(h) {
  const edit = h.all(node => node.type === "Button" && text(node).trim() === "Editar política")[0];
  if (edit) { edit.props.onClick(); await h.flush(); }
}
async function openCopyFinancialSettings(h) {
  const panel = h.find(node => node.type === "details" && nodes(node.props.children).some(child => child.type === "summary" && /^Parámetros de la cuota/.test(text(child))));
  if (!panel.props.open) { panel.props.onToggle({ currentTarget: { open: true } }); await h.flush(); }
}
async function assertCopyName(h, expected) {
  const previous = currentCopyStep(h);
  await goCopyStep(h, 1);
  assert.equal(byId(h, "new-policy-name").props.value, expected);
  await goCopyStep(h, previous);
}

test("creation validates each stage, preserves values backwards and keeps the source read-only", async () => {
  const original = catalog(), before = JSON.stringify(original), requests = [];
  const h = mountPolicy(async (url, options) => { requests.push({ url, options }); return Response.json(original); });
  await h.flush();
  assert.equal(h.all(node => typeof node.type === "function" && node.type.name === "PlatformEditor").length, 0);
  policyButton(h, "Nueva política").props.onClick(); await h.flush();
  assert.equal(currentCopyStep(h), 1);
  byId(h, "new-policy-name").props.onChange({ target: { value: "ab" } }); await h.flush();
  assert.equal(byId(h, "new-policy-continue").props.disabled, true);
  byId(h, "new-policy-continue").props.onClick(); await h.flush();
  assert.equal(currentCopyStep(h), 1);
  assert.equal(h.all(node => node.props?.id === "new-policy-submit").length, 0);
  const stages = h.find(node => node.type === "ol" && node.props["aria-label"] === "Etapas de creación");
  const futureStage = nodes(stages).find(node => node.props?.onClick && /Revisar/.test(text(node)));
  assert.ok(futureStage.props.disabled, "No se puede saltar la validación hacia el resumen");
  futureStage.props.onClick(); await h.flush(); assert.equal(currentCopyStep(h), 1);
  byId(h, "new-policy-name").props.onChange({ target: { value: "Política validada" } }); await h.flush();
  await goCopyStep(h, 2);
  const priorities = () => h.find(node => typeof node.type === "function" && node.type.name === "PriorityRuleEditor");
  priorities().props.onThresholdChange("totalDelinquency", "ANDROID", ""); await h.flush();
  assert.equal(byId(h, "new-policy-continue").props.disabled, true);
  byId(h, "new-policy-continue").props.onClick(); await h.flush(); assert.equal(currentCopyStep(h), 2);
  priorities().props.onThresholdChange("totalDelinquency", "ANDROID", "1234567"); await h.flush();
  await goCopyStep(h, 3); await openCopyFinancialSettings(h);
  h.find(node => node.type === "Input" && node.props.value === "25.2").props.onChange({ target: { value: "-1" } });
  platformEditor(h).props.onChange("android-high", "scoreMin", "501"); await h.flush();
  assert.equal(byId(h, "new-policy-continue").props.disabled, true);
  byId(h, "new-policy-continue").props.onClick(); await h.flush(); assert.equal(currentCopyStep(h), 3);
  h.find(node => node.type === "Input" && node.props.value === "-1").props.onChange({ target: { value: "26.5" } });
  platformEditor(h).props.onChange("android-high", "scoreMin", "500"); await h.flush();
  await goCopyStep(h, 1);
  assert.equal(byId(h, "new-policy-name").props.value, "Política validada");
  await goCopyStep(h, 2);
  assert.equal(priorities().props.rules.totalDelinquency.rejectAboveCopByPlatform.ANDROID, "1234567");
  await goCopyStep(h, 3);
  assert.equal(h.find(node => node.type === "Input" && node.props.value === "26.5").props.value, "26.5");
  await goCopyStep(h, 4);
  assert.equal(byId(h, "new-policy-submit").props.disabled, false);
  assert.match(text(byId(h, "new-policy-review")), /Política validada/);
  assert.match(text(byId(h, "new-policy-review")), /26[.,]5/);
  assert.match(text(byId(h, "new-policy-review")), /1\.234\.567/);
  assert.equal(h.focusedIds.at(-1), "policy-create-step-title");
  assert.equal(JSON.stringify(original), before);
  assert.equal(requests.length, 1, "La navegación y el resumen no escriben políticas");
});

test("a historical policy without total delinquency keeps its empty thresholds during editing and copying", async () => {
  const original = catalog();
  delete original.profiles[0].priorityRules.totalDelinquency;
  const before = JSON.stringify(original), requests = [];
  const h = mountPolicy(async (url, options) => { requests.push({ url, options }); return Response.json(original); });
  await h.flush(); await enablePolicyEditing(h);
  const priorities = () => h.find(node => typeof node.type === "function" && node.type.name === "PriorityRuleEditor");
  assert.equal(priorities().props.rules.totalDelinquency.rejectAboveCopByPlatform.ANDROID, "");
  assert.equal(priorities().props.rules.totalDelinquency.rejectAboveCopByPlatform.IPHONE, "");
  assert.equal(priorities().props.validation.valid, false);
  assert.equal(policyButton(h, "Publicar nueva versión").props.disabled, true);
  await beginPolicyCopy(h, "Copia histórica", 2);
  assert.equal(priorities().props.rules.totalDelinquency.rejectAboveCopByPlatform.ANDROID, "");
  assert.equal(priorities().props.rules.totalDelinquency.rejectAboveCopByPlatform.IPHONE, "");
  assert.equal(byId(h, "new-policy-continue").props.disabled, true);
  byId(h, "new-policy-continue").props.onClick(); await h.flush();
  assert.equal(currentCopyStep(h), 2);
  assert.equal(JSON.stringify(original), before);
  assert.equal(requests.length, 1, "Las reglas faltantes no se rellenan ni se publican automáticamente");
});

test("editing a published policy requires an explicit action and discarding returns to its summary", async () => {
  const original = catalog(), before = JSON.stringify(original), requests = [];
  const h = mountPolicy(async (url, options) => { requests.push({ url, options }); return Response.json(original); });
  await h.flush();
  assert.equal(h.all(node => typeof node.type === "function" && node.type.name === "PlatformEditor").length, 0);
  assert.equal(h.all(node => node.type === "Button" && text(node).trim() === "Publicar nueva versión").length, 0);
  assert.equal(policyButton(h, "Editar política").props.disabled, false);
  await enablePolicyEditing(h);
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "2300000"); await h.flush();
  assert.equal(policyButton(h, "Publicar nueva versión").props.disabled, false);
  h.find(node => node.type === "Button" && node.props["aria-label"] === "Actualizar políticas").props.onClick(); await h.flush();
  assert.equal(policyDialog(h, "Descartar cambios y recargar").props.open, true);
  policyDialog(h, "Descartar cambios y recargar").props.onConfirm(); await h.flush();
  assert.equal(h.all(node => typeof node.type === "function" && node.type.name === "PlatformEditor").length, 0);
  assert.equal(policyButton(h, "Editar política").props.disabled, false);
  assert.equal(JSON.stringify(original), before);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => !request.options?.method || request.options.method === "GET"));
});

test("canceling an explicit policy edit preserves independent ally drafts without reloading the catalog", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => { requests.push({ url, options }); return Response.json(catalog()); });
  await h.flush();
  byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Alfa QA").props.onChange({ target: { value: "other" } });
  byId(h, "datacredito-daily-limit-1").props.onChange({ target: { value: "35" } }); await h.flush();
  byId(h, "datacredito-policies-tab").props.onClick(); await h.flush();
  await enablePolicyEditing(h);
  policyButton(h, "Cancelar edición").props.onClick(); await h.flush();
  assert.equal(policyButton(h, "Editar política").props.disabled, false, "Una edición intacta se cierra directamente");
  await enablePolicyEditing(h);
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "2300000"); await h.flush();
  policyButton(h, "Cancelar edición").props.onClick(); await h.flush();
  assert.equal(policyDialog(h, "Descartar edición de política").props.open, true);
  policyDialog(h, "Descartar edición de política").props.onCancel(); await h.flush();
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").maxFinancedAmount, "2300000");
  policyButton(h, "Cancelar edición").props.onClick(); await h.flush();
  policyDialog(h, "Descartar edición de política").props.onConfirm(); await h.flush();
  assert.equal(h.all(node => typeof node.type === "function" && node.type.name === "PlatformEditor").length, 0);
  assert.equal(policyButton(h, "Editar política").props.disabled, false);
  byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  assert.equal(h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Alfa QA").props.value, "other");
  assert.equal(byId(h, "datacredito-daily-limit-1").props.value, "35");
  assert.equal(requests.length, 1, "Descartar esta edición no recarga ni escribe los borradores de aliados");
});

test("duplicating isolates bands, finances and priorities and creates only the new profile", async () => {
  const original = catalog(), before = JSON.stringify(original), requests = [];
  let resolveCreate;
  const h = mountPolicy(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    if (options?.method === "POST") return await new Promise(resolve => { resolveCreate = () => {
      const updated = structuredClone(original);
      updated.profiles.push({ ...updated.profiles[0], id: "new-copy", name: body.name, version: 1,
        bands: body.bands, financialSettings: body.financialSettings, priorityRules: body.priorityRules, assignedAlliesCount: 0 });
      resolve(Response.json({ ...updated, createdPolicyId: "new-copy" }));
    }; });
    return Response.json(original);
  });
  await h.flush(); await beginPolicyCopy(h);
  assert.equal(h.all(node => node.type === "Button" && text(node).trim() === "Publicar nueva versión").length, 0,
    "El formulario de copia no presenta la publicación del origen");
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "2500000");
  await h.flush(); await openCopyFinancialSettings(h);
  h.find(node => node.type === "Input" && node.props.value === "25.2").props.onChange({ target: { value: "24" } });
  await h.flush(); await goCopyStep(h, 2);
  h.find(node => typeof node.type === "function" && node.type.name === "PriorityRuleEditor")
    .props.onThresholdChange("telcoDelinquency", "ANDROID", "1500000");
  await h.flush(); await goCopyStep(h, 3);
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").maxFinancedAmount, "2500000");
  assert.equal(JSON.stringify(original), before, "El catálogo y los objetos del origen conservan todos sus términos");
  await goCopyStep(h, 4);
  const review = text(byId(h, "new-policy-review"));
  assert.match(review, /Recuperar cartera/);
  assert.match(review, /2\.500\.000/);
  assert.match(review, /1\.500\.000/);
  assert.match(review, /24/);
  assert.equal(policyButton(h, "Crear política").props.disabled, false);
  const create = policyButton(h, "Crear política").props.onClick;
  create(); create(); await h.flush();
  assert.equal(requests.filter(request => request.options?.method === "POST").length, 1);
  assert.equal(requests.filter(request => request.options?.method === "PATCH").length, 0);
  const sent = requests.find(request => request.body)?.body;
  assert.equal(sent.bands.find(band => band.id === "android-high").maxFinancedAmount, 2_500_000);
  assert.equal(sent.financialSettings.tasaInteresEa, 24);
  assert.equal(sent.priorityRules.telcoDelinquency.rejectAboveCopByPlatform.ANDROID, 1_500_000);
  resolveCreate(); await h.flush();
  assert.match(h.text(), /Recuperar cartera.*creada como versión 1.*Política general.*v10/);
  const requestsBeforeAssignment = requests.length;
  policyButton(h, "Asignar a aliado").props.onClick(); await h.flush();
  assert.equal(byId(h, "datacredito-assignments-tab").props["aria-selected"], true);
  assert.equal(h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Alfa QA").props.value, "general");
  assert.equal(requests.length, requestsBeforeAssignment, "El acceso a asignación no asigna ni guarda automáticamente");
  assert.equal(requests.filter(request => request.options?.method === "PATCH").length, 0);
  byId(h, "datacredito-policies-tab").props.onClick(); await h.flush();
  await enablePolicyEditing(h);
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").maxFinancedAmount, "2500000");
  assert.equal(JSON.stringify(original), before);
});

test("changing the copy source requires discard and cancel keeps its snapshot and editable values", async () => {
  const requests = [], h = mountPolicy(async (url, options) => {
    requests.push({ url, options }); return Response.json(catalog());
  });
  await h.flush(); await beginPolicyCopy(h, "Mi nueva política");
  platformEditor(h).props.onChange("android-high", "initialPaymentPercentage", "35"); await h.flush();
  const select = () => h.find(node => node.type === "Select" && node.props.value === "general");
  select().props.onChange({ target: { value: "other" } }); await h.flush();
  const discard = policyDialog(h, "Descartar borrador y cambiar de política");
  assert.equal(discard.props.open, true);
  discard.props.onCancel(); await h.flush();
  await assertCopyName(h, "Mi nueva política");
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").initialPaymentPercentage, "35");
  assert.match(h.text(), /Base:.*Política general.*versión 10.*política independiente/);
  select().props.onChange({ target: { value: "other" } }); await h.flush();
  policyDialog(h, "Descartar borrador y cambiar de política").props.onConfirm(); await h.flush();
  assert.equal(h.all(node => node.props?.id === "new-policy-name").length, 0);
  assert.equal(h.find(node => node.type === "Select" && node.props.value === "other").props.value, "other");
  await enablePolicyEditing(h);
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").initialPaymentPercentage, "20");
  assert.equal(requests.length, 1, "Cambiar el origen no publica ni duplica perfiles");
});

test("tab navigation and reload confirm discarding the independent copy", async () => {
  const requests = [], h = mountPolicy(async (url, options) => {
    requests.push({ url, options }); return Response.json(catalog());
  });
  await h.flush(); await beginPolicyCopy(h);
  byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  assert.equal(policyDialog(h, "Descartar la nueva política").props.open, true);
  assert.equal(byId(h, "datacredito-policies-tab").props["aria-selected"], true);
  policyDialog(h, "Descartar la nueva política").props.onCancel(); await h.flush();
  await assertCopyName(h, "Recuperar cartera");
  h.find(node => node.type === "Button" && node.props["aria-label"] === "Actualizar políticas").props.onClick(); await h.flush();
  assert.equal(policyDialog(h, "Descartar cambios y recargar").props.open, true);
  assert.equal(requests.length, 1);
  policyDialog(h, "Descartar cambios y recargar").props.onCancel(); await h.flush();
  await assertCopyName(h, "Recuperar cartera");
  byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  policyDialog(h, "Descartar la nueva política").props.onConfirm(); await h.flush();
  assert.equal(byId(h, "datacredito-assignments-tab").props["aria-selected"], true);
  assert.equal(requests.length, 1);
});

test("a rejected creation retains the copy and retries its edited bands without publishing the source", async () => {
  const requests = [], h = mountPolicy(async (url, options) => {
    requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return options?.method === "POST"
      ? Response.json({ ok: false, code: "POLICY_NAME_CONFLICT", error: "Ya existe una política con ese nombre", correlationId: "COPY-409" }, { status: 409 })
      : Response.json(catalog());
  });
  await h.flush(); await beginPolicyCopy(h, "Nombre repetido");
  platformEditor(h).props.onChange("android-high", "installmentCount", "36"); await h.flush();
  await goCopyStep(h, 4);
  policyButton(h, "Crear política").props.onClick(); await h.flush();
  assert.match(h.text(), /Ya existe una política con ese nombre/);
  assert.match(h.text(), /COPY-409/);
  assert.equal(byId(h, "new-policy-name").props.value, "Nombre repetido");
  await goCopyStep(h, 3);
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").installmentCount, "36");
  await goCopyStep(h, 1);
  byId(h, "new-policy-name").props.onChange({ target: { value: "Nombre corregido" } }); await h.flush();
  await goCopyStep(h, 4);
  policyButton(h, "Crear política").props.onClick(); await h.flush();
  const sends = requests.filter(request => request.body);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].body.name, "Nombre corregido");
  assert.deepEqual(sends[1].body.bands, sends[0].body.bands);
  assert.ok(sends.every(request => request.options.method === "POST"));
});

for (const failure of [
  { code: "POLICY_VALIDATION_ERROR", error: "El umbral de mora TELCOS debe ser válido", status: 400, stage: 2 },
  { code: "POLICY_VALIDATION_ERROR", error: "La tasa efectiva anual debe ser válida", status: 400, stage: 3 },
  { code: "POLICY_CATALOG_ERROR", error: "El servicio no está disponible", status: 503, stage: 4 },
]) {
  test(`a creation error returns to stage ${failure.stage} without losing its independent conditions`, async () => {
    const requests = [];
    const h = mountPolicy(async (url, options) => {
      requests.push({ url, options });
      return options?.method === "POST" ? Response.json({ ok: false, ...failure }, { status: failure.status }) : Response.json(catalog());
    });
    await h.flush(); await beginPolicyCopy(h, "Copia con revisión");
    platformEditor(h).props.onChange("android-high", "initialPaymentPercentage", "35"); await h.flush();
    await goCopyStep(h, 4);
    byId(h, "new-policy-submit").props.onClick(); await h.flush();
    assert.equal(currentCopyStep(h), failure.stage);
    assert.ok(h.text().includes(failure.error));
    assert.equal(requests.filter(request => request.options?.method === "POST").length, 1);
    if (failure.stage === 4) assert.match(text(byId(h, "new-policy-review")), /35 %/);
    else {
      await goCopyStep(h, 3);
      assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").initialPaymentPercentage, "35");
    }
    assert.equal(requests.filter(request => request.options?.method === "PATCH").length, 0);
  });
}

test("copy band removal merges the isolated ranges and leaves the published source unchanged", async () => {
  const original = catalog(), before = JSON.stringify(original);
  const h = mountPolicy(async () => Response.json(original));
  await h.flush(); await beginPolicyCopy(h);
  platformEditor(h).props.onRemove("android-low"); await h.flush();
  byId(h, "policy-band-removal-target").props.onChange({ target: { value: "android-high" } }); await h.flush();
  policyButton(h, "Revisar eliminación").props.onClick(); await h.flush();
  policyDialog(h, "Confirmar eliminación de banda").props.onConfirm(); await h.flush();
  const copied = platformEditor(h).props.bands;
  assert.equal(copied.some(band => band.id === "android-low"), false);
  assert.equal(copied.find(band => band.id === "android-high").scoreMin, "0");
  assert.equal(JSON.stringify(original), before);
  policyButton(h, "Cancelar").props.onClick(); await h.flush();
  policyDialog(h, "Descartar la nueva política").props.onConfirm(); await h.flush();
  await enablePolicyEditing(h);
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").scoreMin, "500");
  assert.equal(policyButton(h, "Publicar nueva versión").props.disabled, true);
});

const committedCatalogFailure = (operation, extra = {}) => ({ ok: true, operationCommitted: true,
  catalogReloadRequired: true, committedOperation: operation, code: "POLICY_CATALOG_REFRESH_FAILED",
  message: "El cambio quedó guardado. Actualiza el listado.", correlationId: "COMMITTED-QA", ...extra });
const recoveryFieldset = h => h.find(node => node.type === "fieldset" && node.props["aria-label"] === "Configuración de políticas");

test("a committed creation blocks resend and recovers its exact new profile through GET even after another read failure", async () => {
  const requests = [], server = catalog();
  let reads = 0;
  const h = mountPolicy(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    if (options?.method === "POST") {
      server.profiles.push({ ...structuredClone(server.profiles[0]), id: "saved-copy", name: body.name, version: 1,
        bands: body.bands, financialSettings: body.financialSettings, priorityRules: body.priorityRules, assignedAlliesCount: 0 });
      return Response.json(committedCatalogFailure("CREATE_POLICY", { createdPolicyId: "saved-copy" }), { status: 201 });
    }
    reads += 1;
    return reads === 2 ? Response.json({ ok: false, error: "Lectura todavía no disponible" }, { status: 503 }) : Response.json(server);
  });
  await h.flush(); await beginPolicyCopy(h, "Copia guardada");
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "2100000"); await h.flush();
  await goCopyStep(h, 4);
  const staleCreate = policyButton(h, "Crear política").props.onClick;
  staleCreate(); await h.flush();
  assert.match(h.text(), /Copia guardada.*quedó creada/);
  assert.equal(recoveryFieldset(h).props.disabled, true);
  assert.match(text(byId(h, "new-policy-review")), /Copia guardada/);
  assert.match(text(byId(h, "new-policy-review")), /2\.100\.000/);
  staleCreate(); await h.flush();
  assert.equal(requests.filter(request => request.options?.method === "POST").length, 1);
  policyButton(h, "Actualizar listado").props.onClick(); await h.flush();
  assert.match(h.text(), /Lectura todavía no disponible/);
  assert.equal(recoveryFieldset(h).props.disabled, true);
  policyButton(h, "Actualizar listado").props.onClick(); await h.flush();
  assert.equal(recoveryFieldset(h).props.disabled, false);
  assert.equal(h.all(node => node.props?.id === "new-policy-name").length, 0);
  assert.equal(h.find(node => node.type === "Select" && node.props.value === "saved-copy").props.value, "saved-copy");
  assert.match(h.text(), /catálogo ya está actualizado/);
  assert.equal(requests.filter(request => request.options?.method === "POST").length, 1);
});

test("a committed revision recovers the published version without repeating the PATCH", async () => {
  const requests = [], server = catalog();
  const h = mountPolicy(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    if (body?.action === "SAVE_REVISION") {
      server.profiles[0] = { ...server.profiles[0], version: 11, bands: body.bands, financialSettings: body.financialSettings, priorityRules: body.priorityRules };
      return Response.json(committedCatalogFailure("SAVE_REVISION", { updatedPolicyId: "general" }));
    }
    return Response.json(server);
  });
  await h.flush(); await enablePolicyEditing(h);
  platformEditor(h).props.onChange("android-high", "initialPaymentPercentage", "35"); await h.flush();
  policyButton(h, "Publicar nueva versión").props.onClick(); await h.flush();
  const staleConfirm = policyDialog(h, "Publicar nueva revisión").props.onConfirm;
  staleConfirm(); await h.flush();
  assert.match(h.text(), /Política general.*quedó publicada/);
  assert.equal(recoveryFieldset(h).props.disabled, true);
  staleConfirm(); await h.flush();
  policyButton(h, "Actualizar listado").props.onClick(); await h.flush();
  assert.equal(recoveryFieldset(h).props.disabled, false);
  await enablePolicyEditing(h);
  assert.equal(policyButton(h, "Publicar nueva versión").props.disabled, true);
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").initialPaymentPercentage, "35");
  assert.equal(requests.filter(request => request.body?.action === "SAVE_REVISION").length, 1);
  assert.equal(requests.find(request => request.body?.action === "SAVE_REVISION").body.expectedVersion, 10);
});

for (const committedAction of ["ASSIGN_ALLY", "SET_ALLY_DAILY_QUOTA"]) {
  test(`committed ${committedAction} preserves the unfinished ally changes and never repeats the saved operation`, async () => {
    const requests = [], server = catalog();
    let returnedMarker = false;
    const h = mountPolicy(async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      requests.push({ url, options, body });
      if (body?.action === "ASSIGN_ALLY") {
        const ally = server.allies.find(item => item.id === body.allyId);
        ally.policyId = body.policyId; ally.policyName = "Otra política";
      }
      if (body?.action === "SET_ALLY_DAILY_QUOTA") {
        const ally = server.allies.find(item => item.id === body.allyId);
        ally.dailyQueryLimit = body.dailyQueryLimit; ally.dailyQueriesRemaining = body.dailyQueryLimit - ally.dailyQueriesUsed;
      }
      if (body?.action === committedAction && !returnedMarker) {
        returnedMarker = true;
        return Response.json(committedCatalogFailure(committedAction, committedAction === "ASSIGN_ALLY" ? { assignedAllyId: body.allyId } : { dailyQuotaUpdatedAllyId: body.allyId }));
      }
      return Response.json(server);
    });
    await h.flush(); byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
    h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Alfa QA").props.onChange({ target: { value: "other" } });
    byId(h, "datacredito-daily-limit-1").props.onChange({ target: { value: "35" } });
    h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Beta QA").props.onChange({ target: { value: "other" } });
    await h.flush();
    const save = () => h.find(node => node.type === "Button" && node.props["aria-describedby"] === "datacredito-assignment-save-help");
    save().props.onClick(); await h.flush();
    const staleConfirm = policyDialog(h, "Guardar políticas y cupos diarios").props.onConfirm;
    staleConfirm(); await h.flush();
    assert.equal(recoveryFieldset(h).props.disabled, true);
    staleConfirm(); await h.flush();
    policyButton(h, "Actualizar listado").props.onClick(); await h.flush();
    assert.equal(byId(h, "datacredito-daily-limit-1").props.value, "35");
    assert.equal(h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Beta QA").props.value, "other");
    save().props.onClick(); await h.flush();
    policyDialog(h, "Guardar políticas y cupos diarios").props.onConfirm(); await h.flush();
    assert.equal(requests.filter(request => request.body?.action === "ASSIGN_ALLY" && request.body.allyId === 1).length, 1);
    assert.equal(requests.filter(request => request.body?.action === "SET_ALLY_DAILY_QUOTA" && request.body.allyId === 1).length, 1);
    assert.equal(requests.filter(request => request.body?.action === "ASSIGN_ALLY" && request.body.allyId === 2).length, 1);
    assert.equal(save().props.disabled, true);
  });
}

test("a committed retirement is displayed as saved and recovers the default selection through GET", async () => {
  const requests = [], server = catalog();
  const h = mountPolicy(async (url, options) => {
    requests.push({ url, options });
    if (options?.method === "DELETE") {
      server.profiles[1].active = false;
      return Response.json(committedCatalogFailure("RETIRE_POLICY", { deletionMode: "RETIRED", policy: { id: "other", active: false } }));
    }
    return Response.json(server);
  });
  await h.flush();
  h.find(node => node.type === "Select" && node.props.value === "general").props.onChange({ target: { value: "other" } }); await h.flush();
  h.find(node => node.type === "Button" && node.props["aria-label"] === "Retirar política").props.onClick(); await h.flush();
  const staleConfirm = policyDialog(h, "Retirar política").props.onConfirm;
  staleConfirm(); await h.flush();
  assert.match(h.text(), /Otra política.*quedó retirada/);
  assert.equal(recoveryFieldset(h).props.disabled, true);
  staleConfirm(); await h.flush();
  policyButton(h, "Actualizar listado").props.onClick(); await h.flush();
  assert.equal(h.find(node => node.type === "Select" && node.props.value === "general").props.value, "general");
  assert.equal(requests.filter(request => request.options?.method === "DELETE").length, 1);
});

test("policy draft survives tab navigation and failed publication without changing historical versions", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => {
    requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return options?.method === "PATCH" ? Response.json({ ok: false, error: "No se guardó la revisión" }, { status: 503 }) : Response.json(catalog());
  });
  await h.flush();
  assert.equal(requests.length, 1);
  await enablePolicyEditing(h);
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "3100000"); await h.flush();
  byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  byId(h, "datacredito-policies-tab").props.onClick(); await h.flush();
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").maxFinancedAmount, "3100000");
  assert.equal(policyButton(h, "Publicar nueva versión").props.disabled, false);
  policyButton(h, "Publicar nueva versión").props.onClick(); await h.flush();
  assert.equal(requests.length, 1, "Preview confirmation must not publish");
  policyDialog(h, "Publicar nueva revisión").props.onConfirm(); await h.flush();
  assert.equal(requests[1].body.action, "SAVE_REVISION");
  assert.equal(requests[1].body.expectedVersion, 10);
  assert.equal(requests[1].body.bands.find(band => band.id === "android-high").maxFinancedAmount, 3_100_000);
  assert.match(h.text(), /No se guardó la revisión/);
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").maxFinancedAmount, "3100000");
  assert.equal(policyButton(h, "Publicar nueva versión").props.disabled, false);
});

test("ally search does not discard assignment or daily quota drafts and sends their original concurrency values", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => {
    requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    const next = catalog();
    if (options?.method === "PATCH") {
      const body = JSON.parse(options.body);
      if (body.action === "ASSIGN_ALLY") { next.allies[0].policyId = "other"; next.allies[0].policyName = "Otra política"; }
      if (body.action === "SET_ALLY_DAILY_QUOTA") { next.allies[0].policyId = "other"; next.allies[0].policyName = "Otra política"; next.allies[0].dailyQueryLimit = 35; next.allies[0].dailyQueriesRemaining = 32; }
    }
    return Response.json(next);
  });
  await h.flush(); byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  const allySelector = () => h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Alfa QA");
  allySelector().props.onChange({ target: { value: "other" } });
  byId(h, "datacredito-daily-limit-1").props.onChange({ target: { value: "35" } }); await h.flush();
  const query = () => h.find(node => node.type === "Input" && node.props.placeholder === "Nombre, código o política");
  query().props.onChange({ target: { value: "Beta" } }); await h.flush();
  assert.equal(h.all(node => node.type === "Select" && String(node.props["aria-label"]).startsWith("Política para ")).length, 1);
  query().props.onChange({ target: { value: "" } }); await h.flush();
  assert.equal(allySelector().props.value, "other");
  assert.equal(byId(h, "datacredito-daily-limit-1").props.value, "35");
  h.find(node => node.type === "Button" && node.props["aria-describedby"] === "datacredito-assignment-save-help").props.onClick(); await h.flush();
  assert.equal(requests.length, 1, "Filtering and preparing confirmation must never save");
  policyDialog(h, "Guardar políticas y cupos diarios").props.onConfirm(); await h.flush();
  assert.deepEqual(requests[1].body, { action: "ASSIGN_ALLY", allyId: 1, policyId: "other", expectedPolicyId: "general" });
  assert.deepEqual(requests[2].body, { action: "SET_ALLY_DAILY_QUOTA", allyId: 1, dailyQueryLimit: 35, expectedDailyQueryLimit: 20 });
});

test("a policy publication double confirmation sends one revision and publishes against the original version", async () => {
  const requests = [];
  let resolveMutation;
  const h = mountPolicy(async (url, options) => {
    requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    if (options?.method === "PATCH") return await new Promise(resolve => { resolveMutation = resolve; });
    return Response.json(catalog());
  });
  await h.flush(); await enablePolicyEditing(h);
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "3100000"); await h.flush();
  policyButton(h, "Publicar nueva versión").props.onClick(); await h.flush();
  const confirm = policyDialog(h, "Publicar nueva revisión").props.onConfirm;
  confirm(); confirm(); await h.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.expectedVersion, 10);
  const saved = catalog(); saved.profiles[0].version = 11; saved.profiles[0].bands.find(band => band.id === "android-high").maxFinancedAmount = 3_100_000;
  resolveMutation(Response.json(saved)); await h.flush();
  assert.match(h.text(), /Nueva revisión publicada: versión 11/);
  await enablePolicyEditing(h);
  assert.equal(policyButton(h, "Publicar nueva versión").props.disabled, true);
});

test("visited document and second-credit panels retain the same mounted components while hidden", async () => {
  const h = mountPolicy(async () => Response.json(catalog()));
  await h.flush();
  assert.equal(h.all(node => node.type === "ManualCreditCapConsole").length, 0);
  assert.equal(h.all(node => node.type === "SecondCreditAuthorizationConsole").length, 0);
  byId(h, "datacredito-document-limits-tab").props.onClick(); await h.flush();
  assert.equal(h.all(node => node.type === "ManualCreditCapConsole").length, 1);
  assert.equal(byId(h, "datacredito-document-limits-panel").props.hidden, false);
  byId(h, "datacredito-second-credit-tab").props.onClick(); await h.flush();
  assert.equal(h.all(node => node.type === "ManualCreditCapConsole").length, 1);
  assert.equal(byId(h, "datacredito-document-limits-panel").props.hidden, true);
  assert.equal(h.all(node => node.type === "SecondCreditAuthorizationConsole").length, 1);
  assert.equal(byId(h, "datacredito-second-credit-panel").props.hidden, false);
  byId(h, "datacredito-policies-tab").props.onClick(); await h.flush();
  assert.equal(h.all(node => node.type === "ManualCreditCapConsole").length, 1);
  assert.equal(h.all(node => node.type === "SecondCreditAuthorizationConsole").length, 1);
  assert.equal(byId(h, "datacredito-second-credit-panel").props.hidden, true);
});

test("switching a dirty policy or refreshing requires an explicit discard and cancel keeps all edits", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => { requests.push({ url, options }); return Response.json(catalog()); });
  await h.flush(); await enablePolicyEditing(h);
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "3100000"); await h.flush();
  h.find(node => node.type === "Select" && node.props.value === "general").props.onChange({ target: { value: "other" } }); await h.flush();
  assert.equal(policyDialog(h, "Descartar borrador y cambiar de política").props.open, true);
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").maxFinancedAmount, "3100000");
  policyDialog(h, "Descartar borrador y cambiar de política").props.onCancel(); await h.flush();
  h.find(node => node.type === "Button" && node.props["aria-label"] === "Actualizar políticas").props.onClick(); await h.flush();
  assert.equal(policyDialog(h, "Descartar cambios y recargar").props.open, true);
  assert.equal(requests.length, 1, "Refresh cannot fetch over a dirty draft without confirmation");
  policyDialog(h, "Descartar cambios y recargar").props.onCancel(); await h.flush();
  assert.equal(platformEditor(h).props.bands.find(band => band.id === "android-high").maxFinancedAmount, "3100000");
  assert.equal(policyButton(h, "Publicar nueva versión").props.disabled, false);
});

test("partial ally save retains only the unfinished quota edit and retry does not repeat the confirmed assignment", async () => {
  const requests = [];
  const current = catalog();
  let failQuota = true;
  const h = mountPolicy(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (body?.action === "ASSIGN_ALLY") { current.allies[0].policyId = "other"; current.allies[0].policyName = "Otra política"; }
    if (body?.action === "SET_ALLY_DAILY_QUOTA") {
      if (failQuota) { failQuota = false; return Response.json({ ok: false, error: "El cupo no se guardó" }, { status: 503 }); }
      current.allies[0].dailyQueryLimit = 35; current.allies[0].dailyQueriesRemaining = 32;
    }
    return Response.json(current);
  });
  await h.flush(); byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  const selector = () => h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Alfa QA");
  selector().props.onChange({ target: { value: "other" } });
  byId(h, "datacredito-daily-limit-1").props.onChange({ target: { value: "35" } }); await h.flush();
  const save = () => h.find(node => node.type === "Button" && node.props["aria-describedby"] === "datacredito-assignment-save-help");
  save().props.onClick(); await h.flush(); policyDialog(h, "Guardar políticas y cupos diarios").props.onConfirm(); await h.flush();
  assert.match(h.text(), /El cupo no se guardó/);
  assert.equal(selector().props.value, "other");
  assert.equal(byId(h, "datacredito-daily-limit-1").props.value, "35");
  assert.equal(save().props.disabled, false);
  save().props.onClick(); await h.flush(); policyDialog(h, "Guardar políticas y cupos diarios").props.onConfirm(); await h.flush();
  assert.equal(requests.filter(request => request.body?.action === "ASSIGN_ALLY").length, 1);
  assert.equal(requests.filter(request => request.body?.action === "SET_ALLY_DAILY_QUOTA").length, 2);
  assert.equal(requests.at(-1).body.expectedDailyQueryLimit, 20);
  assert.equal(save().props.disabled, true);
});

test("catalog refresh keeps mounted cap and second-credit forms and preserves their unfinished identifiers and reasons", async () => {
  const requests = [];
  let resolveRefresh;
  const secondDocument = "1065845982";
  const h = mountConsole("datacredito-policy-console.tsx", async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith(endpoint)) return Response.json({ ok: true, items: [savedCap] });
    if (url === "/api/creditos/autorizaciones-segundo-credito/buscar") return Response.json({
      ok: true, documento: secondDocument, activeCredits: 1, activeFolios: ["FC-QA-0001"], canCreate: false, authorization: null,
    });
    if (requests.filter(request => request.url === "/api/creditos/datacredito/politicas").length === 1) return Response.json(catalog());
    return await new Promise(resolve => { resolveRefresh = resolve; });
  }, { renderTabChildren: true });
  await h.flush();
  byId(h, "datacredito-document-limits-tab").props.onClick(); await h.flush();
  byId(h, "manual-cap-document").props.onChange({ target: { value: "00123456789" } });
  byId(h, "manual-cap-amount").props.onChange({ target: { value: "3200000" } });
  byId(h, "manual-cap-reason").props.onChange({ target: { value: "Motivo de cupo todavía sin guardar" } }); await h.flush();
  byId(h, "datacredito-second-credit-tab").props.onClick(); await h.flush();
  byId(h, "second-credit-document").props.onChange({ target: { value: secondDocument } }); await h.flush();
  h.find(node => node.type === "form" && nodes(node.props.children).some(child => child.props?.id === "second-credit-document")).props.onSubmit({ preventDefault() {} }); await h.flush();
  byId(h, "second-credit-reason").props.onChange({ target: { value: "Motivo de autorización todavía sin guardar" } }); await h.flush();
  const requestsBeforeRefresh = requests.length;
  h.find(node => node.type === "Button" && node.props["aria-label"] === "Actualizar políticas").props.onClick(); await h.flush();
  const busyConsole = h.find(node => node.props?.["aria-labelledby"] === "datacredito-policy-title");
  assert.equal(busyConsole.props["aria-busy"], true);
  assert.equal(h.find(node => node.type === "Button" && node.props["aria-label"] === "Actualizar políticas").props.disabled, true);
  assert.equal(byId(h, "manual-cap-document").props.value, "00123456789");
  assert.equal(byId(h, "manual-cap-amount").props.value, "3200000");
  assert.equal(byId(h, "manual-cap-reason").props.value, "Motivo de cupo todavía sin guardar");
  assert.equal(byId(h, "second-credit-document").props.value, secondDocument);
  assert.equal(byId(h, "second-credit-reason").props.value, "Motivo de autorización todavía sin guardar");
  assert.equal(requests.length, requestsBeforeRefresh + 1, "Refreshing catalog must not remount or refetch child forms");
  resolveRefresh(Response.json(catalog())); await h.flush();
  assert.equal(requests.length, requestsBeforeRefresh + 1);
  assert.equal(byId(h, "manual-cap-document").props.value, "00123456789");
  assert.equal(byId(h, "manual-cap-reason").props.value, "Motivo de cupo todavía sin guardar");
  assert.equal(byId(h, "second-credit-document").props.value, secondDocument);
  assert.equal(byId(h, "second-credit-reason").props.value, "Motivo de autorización todavía sin guardar");
  assert.equal(byId(h, "datacredito-document-limits-panel").props.hidden, true);
  assert.equal(byId(h, "datacredito-second-credit-panel").props.hidden, false);
  byId(h, "datacredito-document-limits-tab").props.onClick(); await h.flush();
  assert.equal(byId(h, "manual-cap-document").props.value, "00123456789");
  assert.equal(requests.filter(request => request.url.startsWith(endpoint)).length, 1);
  assert.equal(requests.filter(request => request.url.includes("autorizaciones-segundo-credito")).length, 1);
});

test("tab keyboard navigation supports arrows, Home and End with one selected tab stop and no financial requests", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => { requests.push({ url, options }); return Response.json(catalog()); });
  await h.flush();
  let focusedId;
  async function press(key, sourceId) {
    const buttons = h.all(node => node.props?.role === "tab").map(node => ({
      id: node.props.id, click: () => node.props.onClick(), focus: () => { focusedId = node.props.id; },
    }));
    let prevented = false;
    h.find(node => node.type === "Tabs").props.onKeyDown({ key, target: buttons.find(button => button.id === sourceId),
      currentTarget: { querySelectorAll: () => buttons }, preventDefault() { prevented = true; } });
    await h.flush(); assert.equal(prevented, true);
    const selected = h.all(node => node.props?.role === "tab" && node.props["aria-selected"]);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].props.tabIndex, 0);
    assert.equal(selected[0].props.id, focusedId);
    assert.equal(h.all(node => node.props?.role === "tab" && node.props.tabIndex === 0).length, 1);
  }
  await press("End", "datacredito-policies-tab"); assert.equal(focusedId, "datacredito-second-credit-tab");
  await press("Home", "datacredito-second-credit-tab"); assert.equal(focusedId, "datacredito-policies-tab");
  await press("ArrowLeft", "datacredito-policies-tab"); assert.equal(focusedId, "datacredito-second-credit-tab");
  await press("ArrowRight", "datacredito-second-credit-tab"); assert.equal(focusedId, "datacredito-policies-tab");
  assert.equal(requests.length, 1);
});

test("catalog reload locks the catalog selector and ally edits until the response completes", async () => {
  const requests = [];
  let resolveRefresh;
  const h = mountPolicy(async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return Response.json(catalog());
    return await new Promise(resolve => { resolveRefresh = resolve; });
  });
  await h.flush(); byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  const policySelector = () => h.find(node => node.type === "Select" && !node.props["aria-label"] && node.props.value === "general");
  const allySelector = () => h.find(node => node.type === "Select" && node.props["aria-label"] === "Política para Aliado Alfa QA");
  const save = () => h.find(node => node.type === "Button" && node.props["aria-describedby"] === "datacredito-assignment-save-help");
  h.find(node => node.type === "Button" && node.props["aria-label"] === "Actualizar políticas").props.onClick(); await h.flush();
  assert.equal(policySelector().props.disabled, true);
  assert.equal(allySelector().props.disabled, true);
  assert.equal(byId(h, "datacredito-daily-limit-1").props.disabled, true);
  assert.equal(save().props.disabled, true);
  // Deliberately exercise stale events as well as the disabled controls.
  policySelector().props.onChange({ target: { value: "other" } });
  allySelector().props.onChange({ target: { value: "other" } });
  byId(h, "datacredito-daily-limit-1").props.onChange({ target: { value: "35" } });
  save().props.onClick(); await h.flush();
  assert.equal(policySelector().props.value, "general");
  assert.equal(allySelector().props.value, "general");
  assert.equal(byId(h, "datacredito-daily-limit-1").props.value, "20");
  assert.equal(policyDialog(h, "Guardar políticas y cupos diarios").props.open, false);
  assert.equal(requests.length, 2);
  resolveRefresh(Response.json(catalog())); await h.flush();
  assert.equal(policySelector().props.disabled, false);
  assert.equal(allySelector().props.disabled, false);
  assert.equal(byId(h, "datacredito-daily-limit-1").props.disabled, false);
  assert.equal(requests.length, 2);
});

const removalDialog = h => policyDialog(h, "Confirmar eliminación de banda");
async function chooseRemoval(h, source = "android-low", target = "android-high") {
  await enablePolicyEditing(h);
  platformEditor(h, source.startsWith("iphone") ? "IPHONE" : "ANDROID").props.onRemove(source);
  await h.flush();
  byId(h, "policy-band-removal-target").props.onChange({ target: { value: target } });
  await h.flush();
  policyButton(h, "Revisar eliminación").props.onClick();
  await h.flush();
}

test("band removal requires a receiving rule, previews financial changes, and cancel preserves the draft", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => { requests.push({url, options}); return Response.json(catalog()); });
  await h.flush(); await enablePolicyEditing(h);
  const before = JSON.stringify(platformEditor(h).props.bands);
  platformEditor(h).props.onRemove("android-low"); await h.flush();
  assert.equal(h.focusedIds.at(-1), "policy-band-removal-target");
  assert.equal(h.scrolledIds.at(-1), "policy-band-removal-target");
  const selectorFocusCount = h.focusedIds.filter(id => id === "policy-band-removal-target").length;
  assert.equal(byId(h, "policy-band-removal-target").props.value, "");
  assert.equal(policyButton(h, "Revisar eliminación").props.disabled, true);
  policyButton(h, "Revisar eliminación").props.onClick(); await h.flush();
  assert.equal(removalDialog(h).props.open, false);
  byId(h, "policy-band-removal-target").props.onChange({target: {value: "android-high"}}); await h.flush();
  assert.equal(h.focusedIds.filter(id => id === "policy-band-removal-target").length, selectorFocusCount,
    "Selecting a receiving rule must not move focus back to the start of the form");
  assert.match(text(byId(h, "policy-band-removal-preview")), /0–499 pasarán a APROBADO/);
  assert.match(text(byId(h, "policy-band-removal-preview")), /inicial 20 %/);
  assert.match(text(byId(h, "policy-band-removal-preview")), /3\.500\.000/);
  assert.match(text(byId(h, "policy-band-removal-preview")), /48 cuotas/);
  assert.match(text(byId(h, "policy-band-removal-preview")), /0–950/);
  policyButton(h, "Revisar eliminación").props.onClick(); await h.flush();
  assert.equal(removalDialog(h).props.open, true);
  assert.match(removalDialog(h).props.description, /APROBADO.*inicial 20 %.*3\.500\.000.*48 cuotas.*0–950/);
  removalDialog(h).props.onCancel(); await h.flush();
  assert.equal(JSON.stringify(platformEditor(h).props.bands), before);
  policyButton(h, "Cancelar eliminación").props.onClick(); await h.flush();
  assert.equal(h.focusedIds.at(-1), "datacredito-policy-band-android-low");
  assert.equal(h.all(n => n.props?.id === "policy-band-removal").length, 0);
  assert.equal(JSON.stringify(platformEditor(h).props.bands), before);
  assert.equal(requests.length, 1);
});

test("confirmed band removal keeps the chosen terms and only publishes through the existing revision confirmation", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({url, body});
    const result = catalog();
    if (body?.action === "SAVE_REVISION") {
      result.profiles[0].bands = body.bands;
      result.profiles[0].version = 11;
    }
    return Response.json(result);
  });
  await h.flush(); await enablePolicyEditing(h);
  const iphoneBefore = JSON.stringify(platformEditor(h, "IPHONE").props.bands);
  const targetBefore = platformEditor(h).props.bands.find(b => b.id === "android-high");
  await chooseRemoval(h);
  const confirm = removalDialog(h).props.onConfirm;
  confirm(); confirm(); await h.flush();
  const after = platformEditor(h).props.bands;
  assert.equal(after.length, 2);
  assert.equal(after.some(b => b.id === "android-low"), false);
  assert.equal(JSON.stringify(after.find(b => b.id === "android-high")), JSON.stringify({...targetBefore, scoreMin: "0"}));
  assert.equal(JSON.stringify(platformEditor(h, "IPHONE").props.bands), iphoneBefore);
  assert.equal(requests.length, 1, "Draft confirmation never saves a policy or calls a provider");
  policyButton(h, "Publicar nueva versión").props.onClick(); await h.flush();
  assert.equal(policyDialog(h, "Publicar nueva revisión").props.open, true);
  assert.equal(requests.length, 1);
  await policyDialog(h, "Publicar nueva revisión").props.onConfirm(); await h.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.action, "SAVE_REVISION");
  assert.equal(requests[1].body.expectedVersion, 10);
  assert.equal(requests[1].body.bands.length, 5);
  assert.equal(requests[1].body.bands.find(b => b.id === "android-high").scoreMin, 0);
});

test("Sin información and the last numeric band show an explanation; blank new rows can be removed", async () => {
  const h = mountPolicy(async () => Response.json(catalog()));
  await h.flush(); await enablePolicyEditing(h);
  platformEditor(h).props.onRemove("android-empty"); await h.flush();
  assert.match(h.text(), /Sin información es obligatoria/);
  assert.equal(platformEditor(h).props.bands.length, 3);
  platformEditor(h).props.onAdd("ANDROID"); await h.flush();
  const newBand = platformEditor(h).props.bands.find(b => !["android-empty", "android-low", "android-high"].includes(b.id));
  platformEditor(h).props.onRemove(newBand.id); await h.flush();
  assert.equal(platformEditor(h).props.bands.length, 3);
  assert.equal(h.all(n => n.props?.id === "policy-band-removal").length, 0);
  platformEditor(h).props.onAdd("ANDROID"); await h.flush();
  const overlapping = platformEditor(h).props.bands.find(b => !["android-empty", "android-low", "android-high"].includes(b.id));
  platformEditor(h).props.onChange(overlapping.id, "scoreMin", "0");
  platformEditor(h).props.onChange(overlapping.id, "scoreMax", "499"); await h.flush();
  platformEditor(h).props.onRemove(overlapping.id); await h.flush();
  assert.equal(platformEditor(h).props.bands.length, 3, "Discarding a redundant new row restores valid coverage");
  await chooseRemoval(h); removalDialog(h).props.onConfirm(); await h.flush();
  platformEditor(h).props.onRemove("android-high"); await h.flush();
  assert.match(h.text(), /al menos una banda/);
  assert.equal(platformEditor(h).props.bands.length, 2);
});

test("published invalid ranges and stale financial previews cannot remove a band", async () => {
  const h = mountPolicy(async () => Response.json(catalog()));
  await h.flush(); await enablePolicyEditing(h);
  platformEditor(h).props.onChange("android-low", "scoreMin", ""); await h.flush();
  platformEditor(h).props.onRemove("android-low"); await h.flush();
  assert.match(h.text(), /Completa o restaura/);
  assert.equal(platformEditor(h).props.bands.length, 3);
  platformEditor(h).props.onChange("android-low", "scoreMin", "0"); await h.flush();
  await chooseRemoval(h);
  const staleConfirm = removalDialog(h).props.onConfirm;
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "3100000"); await h.flush();
  staleConfirm(); await h.flush();
  assert.match(h.text(), /Las bandas cambiaron/);
  assert.equal(platformEditor(h).props.bands.length, 3);
  assert.equal(platformEditor(h).props.bands.find(b => b.id === "android-high").maxFinancedAmount, "3100000");
});

test("iPhone confirmation names its installment cap and changing policy clears the pending removal", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => { requests.push({url, options}); return Response.json(catalog()); });
  await h.flush();
  await chooseRemoval(h, "iphone-low", "iphone-high");
  const staleConfirm = removalDialog(h).props.onConfirm;
  assert.match(removalDialog(h).props.description, /iPhone.*APROBADO.*160\.000/);
  removalDialog(h).props.onCancel(); await h.flush();
  h.find(node => node.type === "Select" && node.props.value === "general").props.onChange({target: {value: "other"}});
  await h.flush();
  assert.equal(removalDialog(h).props.open, false);
  assert.equal(h.all(n => n.props?.id === "policy-band-removal").length, 0);
  staleConfirm(); await h.flush();
  await enablePolicyEditing(h);
  assert.equal(platformEditor(h, "IPHONE").props.bands.length, 3);
  assert.equal(requests.length, 1);
});


test("pending band removal blocks other confirmations and tab navigation cancels its preparation", async () => {
  const h = mountPolicy(async () => Response.json(catalog()));
  await h.flush(); await enablePolicyEditing(h);
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "3100000"); await h.flush();
  const previousPublishClick = policyButton(h, "Publicar nueva versión").props.onClick;
  platformEditor(h).props.onRemove("android-low"); await h.flush();
  previousPublishClick(); await h.flush();
  assert.equal(policyDialog(h, "Publicar nueva revisión").props.open, false);
  assert.match(h.text(), /Confirma o cancela la eliminación/);
  byId(h, "datacredito-assignments-tab").props.onClick(); await h.flush();
  assert.equal(h.all(n => n.props?.id === "policy-band-removal").length, 0);
  assert.equal(removalDialog(h).props.open, false);
  byId(h, "datacredito-policies-tab").props.onClick(); await h.flush();
  assert.equal(platformEditor(h).props.bands.length, 3);
  assert.equal(platformEditor(h).props.bands.find(b => b.id === "android-high").maxFinancedAmount, "3100000");
});
