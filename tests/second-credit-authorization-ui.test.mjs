import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("app/dashboard/parametros-credito/second-credit-authorization-console.tsx", root), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const jsx = (type, props) => ({ type, props });
const controls = new Proxy({}, { get: (_, key) => String(key) });
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number" ? String(node) : text(node?.props?.children ?? node?.props?.title ?? "");
const endpoint = "/api/creditos/autorizaciones-segundo-credito";
const documentNumber = "1065845982";
const authorization = (active, version = 1) => ({
  id: "authorization-1", documento: documentNumber, active, version,
  reason: "Revisión aprobada por administración", createdAt: "2026-09-27T12:00:00.000Z",
  updatedAt: "2026-09-27T13:00:00.000Z", createdByName: "Administrador", updatedByName: "Administrador",
});
const lookup = (auth = null, activeCredits = 1) => ({
  ok: true, documento: documentNumber, activeCredits,
  activeFolios: activeCredits ? ["FC-775"] : [],
  canCreate: activeCredits === 0 || (auth?.active === true && activeCredits < 2), authorization: auth,
});

function mount(fetch) {
  const slots = []; let index = 0, dirty = true, effects = [], tree;
  const hooks = {
    useState(initial) { const i = index++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, value => { slots[i].value = typeof value === "function" ? value(slots[i].value) : value; dirty = true; }]; },
    useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    useEffect(effect) { const i = index++; if (!slots[i]) { slots[i] = {}; effects.push(effect); } },
  };
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, fetch, console, Intl, Date, Error,
    AbortController, crypto: { randomUUID }, require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name === "@/app/_components/finser-ui") return controls;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: "ConfirmDialog" };
      throw new Error(name);
    },
  });
  return {
    async flush() { for (let n = 0; n < 25; n++) {
      if (dirty) { dirty = false; index = 0; effects = []; tree = loaded.exports.default(); for (const effect of effects) effect(); }
      await setImmediate(); if (!dirty) return;
    } throw new Error("UI did not settle"); },
    find(predicate) { const found = nodes(tree).find(predicate); assert.ok(found, "Expected rendered control"); return found; },
    has(predicate) { return nodes(tree).some(predicate); },
    text: () => text(tree),
  };
}
const button = (h, label) => h.find(node => node.type === "Button" && text(node).trim() === label);
const dialog = h => h.find(node => node.type === "ConfirmDialog");
async function search(h, value = documentNumber) {
  h.find(node => node.type === "Input" && node.props.id === "second-credit-document").props.onChange({ target: { value } });
  await h.flush(); h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await h.flush();
}
async function reason(h, value) {
  h.find(node => node.type === "textarea" && node.props.id === "second-credit-reason").props.onChange({ target: { value } }); await h.flush();
}

// Operates the component's real event handlers and request payloads rather than matching implementation text.
test("exact lookup sends private POST; grant requires a reason and confirmation with version0", async () => {
  const requests = [];
  const h = mount(async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, options, body });
    return Response.json(url.endsWith("/buscar") ? lookup() : lookup(authorization(true)));
  });
  await h.flush(); assert.equal(requests.length, 0);
  assert.match(h.text(), /Consulta una cédula/);
  await search(h); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${endpoint}/buscar`);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.cache, "no-store");
  assert.deepEqual(requests[0].body, { documentNumber });
  assert.ok(requests.every(request => !request.url.includes(documentNumber)));
  assert.match(h.text(), /1 crédito\(s\) vigente\(s\)/);
  assert.match(h.text(), /Cédula terminada en 5982/);
  assert.doesNotMatch(h.text(), new RegExp(documentNumber));
  assert.equal(button(h, "Autorizar segundo crédito").props.disabled, true);
  await reason(h, "abcd"); assert.equal(button(h, "Autorizar segundo crédito").props.disabled, true);
  await reason(h, "  Revisión documental completa  ");
  button(h, "Autorizar segundo crédito").props.onClick(); await h.flush();
  assert.equal(requests.length, 1); assert.equal(dialog(h).props.open, true);
  assert.match(dialog(h).props.description, /hasta dos créditos vigentes/);
  assert.match(dialog(h).props.description, /evaluaciones y aprobaciones/);
  assert.equal(dialog(h).props.danger, false);
  dialog(h).props.onConfirm(); await h.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, endpoint);
  assert.deepEqual({ ...requests[1].body, mutationId: "uuid" }, {
    documentNumber, action: "AUTHORIZE", reason: "Revisión documental completa", mutationId: "uuid", expectedVersion: 0,
  });
  assert.match(requests[1].body.mutationId, /^[0-9a-f-]{36}$/);
  assert.match(h.text(), /Autorización registrada/);
  assert.match(h.text(), /Autorización activa · máximo 2/);
  assert.equal(button(h, "Revocar autorización").props.disabled, true);
  assert.equal(dialog(h).props.open, false);
});

test("revoke requires its own reason, confirms existing credits stay, and posts current version", async () => {
  const requests = [];
  const h = mount(async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return Response.json(url.endsWith("/buscar") ? lookup(authorization(true, 7), 2) : lookup(authorization(false, 8), 2));
  });
  await h.flush(); await search(h);
  assert.match(h.text(), /No puede crear otro aunque la autorización esté activa/);
  assert.equal(button(h, "Revocar autorización").props.disabled, true);
  await reason(h, "No mantener la excepción para nuevas solicitudes");
  button(h, "Revocar autorización").props.onClick(); await h.flush();
  assert.equal(dialog(h).props.danger, true);
  assert.match(dialog(h).props.description, /créditos existentes se conservan/);
  assert.equal(requests.length, 1);
  dialog(h).props.onConfirm(); await h.flush();
  assert.equal(requests[1].action, "REVOKE"); assert.equal(requests[1].expectedVersion, 7);
  assert.match(h.text(), /Autorización revocada/); assert.match(h.text(), /Sin autorización activa/);
});

test("canceling confirmation performs no mutation and changing document clears loaded permission", async () => {
  const requests = [];
  const h = mount(async (url) => { requests.push(url); return Response.json(lookup(authorization(false, 3))); });
  await h.flush(); await search(h); await reason(h, "Autorizar otro crédito después de revisión");
  button(h, "Autorizar segundo crédito").props.onClick(); await h.flush();
  dialog(h).props.onCancel(); await h.flush(); assert.equal(requests.length, 1);
  assert.equal(dialog(h).props.open, false);
  h.find(node => node.type === "Input").props.onChange({ target: { value: "1193031137" } }); await h.flush();
  assert.equal(h.has(node => node.type === "textarea"), false);
  assert.match(h.text(), /Consulta una cédula/);
  assert.doesNotMatch(h.text(), /Último motivo/);
});

test("failed mutation reports error and retries only the same confirmed request and mutationID", async () => {
  const requests = []; let fail = true;
  const h = mount(async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    if (url.endsWith("/buscar")) return Response.json(lookup());
    if (fail) { fail = false; throw new Error("Error de conexión"); }
    return Response.json({ ...lookup(authorization(true)), idempotent: true });
  });
  await h.flush(); await search(h); await reason(h, "Revisión realizada por el administrador");
  button(h, "Autorizar segundo crédito").props.onClick(); await h.flush(); dialog(h).props.onConfirm(); await h.flush();
  assert.match(h.text(), /Error de conexión/); assert.doesNotMatch(h.text(), /Autorización registrada/);
  assert.match(h.text(), /Sin autorización activa/);
  assert.equal(dialog(h).props.open, false);
  button(h, "Reintentar autorización").props.onClick(); await h.flush();
  assert.equal(requests.length, 2); assert.equal(dialog(h).props.open, true);
  dialog(h).props.onConfirm(); await h.flush();
  assert.deepEqual(requests[1].body, requests[2].body);
  assert.match(h.text(), /Autorización registrada/);
});

test("409 version conflict discards stale permission and requires a fresh lookup", async () => {
  const h = mount(async (url) => url.endsWith("/buscar") ? Response.json(lookup(authorization(false, 2)))
    : Response.json({ error: "La autorización cambió. Consulta de nuevo." }, { status: 409 }));
  await h.flush(); await search(h); await reason(h, "Nueva evaluación documental completa");
  button(h, "Autorizar segundo crédito").props.onClick(); await h.flush(); dialog(h).props.onConfirm(); await h.flush();
  assert.match(h.text(), /La autorización cambió/);
  assert.equal(h.has(node => node.type === "textarea"), false);
  assert.doesNotMatch(h.text(), /Autorización registrada/);
  assert.ok(button(h, "Reintentar consulta"));
  assert.equal(h.has(node => node.type === "Button" && text(node).trim() === "Reintentar autorización"), false);
});

test("lookup failures are retryable and cannot expose actionable permissions or report success", async () => {
  let fail = true;
  const h = mount(async () => {
    if (fail) return Response.json({ error: "Solo el administrador central puede autorizar" }, { status: 403 });
    return Response.json({ ...lookup(), documento: "otro-documento" });
  });
  await h.flush(); await search(h);
  assert.match(h.text(), /Solo el administrador central/);
  assert.equal(h.has(node => node.type === "textarea"), false);
  fail = false; button(h, "Reintentar consulta").props.onClick(); await h.flush();
  assert.match(h.text(), /No se pudo confirmar el estado de la cédula/);
  assert.equal(h.has(node => node.type === "textarea"), false);
});

test("double confirmation is ignored while the first mutation is pending", async () => {
  let resolveSave; let mutationCalls = 0;
  const h = mount(async (url) => {
    if (url.endsWith("/buscar")) return Response.json(lookup());
    mutationCalls++; await new Promise(resolve => { resolveSave = resolve; });
    return Response.json(lookup(authorization(true)));
  });
  await h.flush(); await search(h); await reason(h, "Revisión aprobada y documentada");
  button(h, "Autorizar segundo crédito").props.onClick(); await h.flush();
  const confirm = dialog(h).props.onConfirm; confirm(); confirm(); await h.flush();
  assert.equal(mutationCalls, 1); assert.equal(dialog(h).props.busy, true);
  assert.equal(h.find(node => node.type === "Input").props.disabled, true);
  resolveSave(); await h.flush(); assert.match(h.text(), /Autorización registrada/);
});

test("second-credit tab preserves existing policies, assignments and manual financial limits", () => {
  const catalog = readFileSync(new URL("app/dashboard/parametros-credito/datacredito-policy-console.tsx", root), "utf8");
  const page = readFileSync(new URL("app/dashboard/parametros-credito/page.tsx", root), "utf8");
  assert.match(page, /requireCentralAdminDashboardAccess\(\)/);
  for (const panel of ["policies", "assignments", "document-limits", "second-credit"]) {
    assert.match(catalog, new RegExp(`id="datacredito-${panel}-tab"`));
    assert.match(catalog, new RegExp(`aria-controls="datacredito-${panel}-panel"`));
    assert.match(catalog, new RegExp(`id="datacredito-${panel}-panel"`));
  }
  assert.match(catalog, /<ManualCreditCapConsole \/>/);
  assert.match(catalog, /<SecondCreditAuthorizationConsole \/>/);
  assert.match(catalog, /Guardar políticas y cupos diarios/);
  assert.doesNotMatch(page, /CreditParametersConsole/);
});
 test("document normalization accepts short cedulas and leading zeros without mismatching server identity", async () => {
  const requests = [];
  const h = mount(async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return Response.json({ ...lookup(null, 0), documento: body.documentNumber });
  });
  await h.flush(); await search(h, "000123");
  assert.equal(requests[0].documentNumber, "123");
  assert.match(h.text(), /Cédula terminada en 123/);
  assert.doesNotMatch(h.text(), /No se pudo confirmar/);
  await reason(h, "Autorización por revisión administrativa");
  assert.equal(button(h, "Autorizar segundo crédito").props.disabled, false);
 });

 test("two active credits cannot be authorized to create a third even without a current authorization", async () => {
  const requests = [];
  const h = mount(async (url) => { requests.push(url); return Response.json(lookup(null, 2)); });
  await h.flush(); await search(h); await reason(h, "Solicitud revisada por administración");
  assert.match(h.text(), /No puede crear otro aunque la autorización esté activa/);
  assert.equal(button(h, "Autorizar segundo crédito").props.disabled, true);
  button(h, "Autorizar segundo crédito").props.onClick(); await h.flush();
  assert.equal(dialog(h).props.open, false);
  assert.equal(requests.length, 1);
 });