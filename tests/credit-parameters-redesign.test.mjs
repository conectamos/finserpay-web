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
const savedCap = { id: "cap-1", documentLast4: "6789", maxFinancedAmount: 3_200_000,
  reason: "Revisión administrativa completa", active: true, version: 4,
  createdAt: "2026-09-20T13:00:00.000Z", updatedAt: "2026-10-14T15:00:00.000Z" };

function mountConsole(sourceName, fetch, { renderTabChildren = false } = {}) {
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
    document: { getElementById: () => ({ scrollIntoView() {}, focus() {} }) },
    window: { addEventListener() {}, removeEventListener() {}, requestAnimationFrame(callback) { callback(); } },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name === "@/app/_components/finser-ui" || name === "./credit-parameters-ui") return controls;
      if (name === "./credit-parameters.module.css") return { default: controls };
      if (name === "@/app/_components/finser-confirm-dialog") return { default: "ConfirmDialog" };
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

test("policy draft survives tab navigation and failed publication without changing historical versions", async () => {
  const requests = [];
  const h = mountPolicy(async (url, options) => {
    requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return options?.method === "PATCH" ? Response.json({ ok: false, error: "No se guardó la revisión" }, { status: 503 }) : Response.json(catalog());
  });
  await h.flush();
  assert.equal(requests.length, 1);
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
  await h.flush();
  platformEditor(h).props.onChange("android-high", "maxFinancedAmount", "3100000"); await h.flush();
  policyButton(h, "Publicar nueva versión").props.onClick(); await h.flush();
  const confirm = policyDialog(h, "Publicar nueva revisión").props.onConfirm;
  confirm(); confirm(); await h.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.expectedVersion, 10);
  const saved = catalog(); saved.profiles[0].version = 11; saved.profiles[0].bands.find(band => band.id === "android-high").maxFinancedAmount = 3_100_000;
  resolveMutation(Response.json(saved)); await h.flush();
  assert.match(h.text(), /Nueva revisión publicada: versión 11/);
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
  await h.flush();
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
