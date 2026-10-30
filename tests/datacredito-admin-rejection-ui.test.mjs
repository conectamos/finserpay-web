import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function load(file, dependencies, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL("../" + file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; }, ...globals });
  return loaded.exports;
}
const ui = load("app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const response = (data, ok = true) => ({ ok, json: async () => data });
const documentNumber = "0001234567";
const reason = "Respuesta revisada sin datos suficientes para evaluar la solicitud.";
const assessmentId = "6c592d2b-6036-422a-b5a4-e55c85ce37f6";
const decision = { id: "f5d8e282-0062-44c2-990f-37db9a404151", assessmentId, solicitudId: 15,
  actorUserId: 9, reason, rejectedAt: "2026-10-30T18:00:00Z", expiresAt: "2026-11-14T18:00:00Z",
  source: "FINSER_ADMIN", status: "RECHAZADA" };
const candidate = patch => ({
  assessmentId, documentLabel: "•••• 4567", eligible: false, eligibilityMessage: "Este caso no permite liberación TX06.",
  alreadyAuthorized: false, status: "NO_EVALUADO", errorCode: "NO_EVALUABLE_INFORMATION",
  providerStatus: "ACCEPTED", transactionCode: "07", platform: "IPHONE", createdAt: "2026-10-30T17:00:00Z",
  expiresAt: "2026-11-14T17:00:00Z", actor: { userName: "Prueba", sellerName: "Asesor", sedeName: "Sede prueba", aliadoName: "Aliado prueba" },
  draftId: 15, authorizedAt: null, requiresNewSolicitud: false,
  adminRejection: { canReject: true, eligible: true, eligibilityMessage: "Requiere revisión administrativa de la respuesta guardada.", solicitudId: 15, decision: null }, ...patch,
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function text(node) {
  return Array.isArray(node) ? node.map(text).join("") : node == null || typeof node === "boolean" ? ""
    : typeof node === "object" ? text(node.props?.children) : String(node);
}
function walk(node) {
  return !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
}
function ConfirmDialog({ open, title, description }) {
  return open ? jsxRuntime.jsxs("section", { role: "alertdialog", children: [title, description] }) : null;
}
function harness({ result = candidate(), mutation = async () => response({ ok: true, result: { rejection: decision, idempotent: false } }), mode = "admin" } = {}) {
  const states = [], refs = [], effects = [], pending = new Set(), requests = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const changed = (a, b) => !a || a.length !== b.length || b.some((value, i) => value !== a[i]);
  const hooks = {
    useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
    useRef(initial) { return refs[refIndex++] ??= { current: initial }; },
    useEffect(fn, deps) { const i = effectIndex++, old = effects[i]; if (changed(old?.deps, deps)) {
      effects[i] = { fn, deps, cleanup: old?.cleanup }; pending.add(i);
    } },
  };
  const Component = load("app/dashboard/datacredito/liberaciones/tx06-release-console.tsx", {
    react: hooks, "react/jsx-runtime": jsxRuntime, "@/app/_components/finser-ui": ui,
    "next/link": { default: ({ href, children, ...props }) => jsxRuntime.jsx("a", { href, ...props, children }) },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/app/_components/finser-confirm-dialog": { default: ConfirmDialog },
    "./tx06-release-console.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  }, {
    window: { setTimeout: () => 1, clearTimeout() {} }, document: { getElementById: () => null },
    crypto: { randomUUID }, AbortController, DOMException,
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return url.endsWith("/buscar") ? response({ ok: true, result }) : mutation(url, options);
    },
  }).default;
  const tree = () => { stateIndex = refIndex = effectIndex = 0; return Component({ mode }); };
  const render = () => renderToStaticMarkup(tree());
  const runEffects = () => { for (const i of pending) { const e = effects[i]; e.cleanup?.(); e.cleanup = e.fn(); } pending.clear(); };
  const settle = async () => { for (let i = 0; i < 4; i++) { tree(); runEffects(); await flush(); } return render(); };
  const field = id => walk(tree()).find(node => node.props?.id === id)?.props;
  const form = id => walk(tree()).find(node => node.type === "form" && walk(node).some(n => n.props?.id === id))?.props;
  const dialog = () => walk(tree()).find(node => node.type === ConfirmDialog && node.props.title === "Rechazo administrativo de FINSER").props;
  const checkbox = () => walk(tree()).find(node => node.type === "input" && node.props.type === "checkbox")?.props;
  return { requests, tree, render, settle, field, dialog, checkbox,
    setDocument: value => field("tx06-document").onChange({ target: { value } }),
    search: () => form("tx06-document").onSubmit({ preventDefault() {} }),
    setReason: value => field("dc-rejection-reason").onChange({ target: { value } }),
    acknowledge: value => checkbox().onChange({ target: { checked: value } }),
    prepare: () => form("dc-rejection-reason").onSubmit({ preventDefault() {} }),
    confirm: () => dialog().onConfirm(), cancel: () => dialog().onCancel(),
    get mutations() { return requests.filter(r => !r.url.endsWith("/buscar")); },
    button: label => walk(tree()).find(node => node.type === ui.Button && text(node) === label)?.props,
  };
}
async function searched(options = {}) {
  const f = harness(options); await f.settle(); f.setDocument(documentNumber); f.search(); await f.settle(); return f;
}
function prepare(f) { f.setReason(reason); f.acknowledge(true); f.prepare(); }

test("opening the screen or looking up a stored case never rejects or queries the provider", async () => {
  const f = harness(); await f.settle(); assert.equal(f.requests.length, 0);
  f.setDocument(documentNumber); f.search(); await f.settle();
  assert.equal(f.requests.length, 1); assert.equal(f.mutations.length, 0);
  assert.equal(f.requests[0].body.documentNumber, documentNumber);
  assert.equal(f.field("tx06-document").value, documentNumber);
  assert.match(f.render(), /Revisar rechazo administrativo/);
  assert.equal(f.dialog().open, false);
});

test("the server capability and eligibility control rejection visibility, including the analyst route", async () => {
  for (const adminRejection of [undefined, { canReject: false, eligible: true, solicitudId: 15 }, { canReject: true, eligible: false, solicitudId: 15 }]) {
    const f = await searched({ result: candidate({ adminRejection }), mode: "analyst" });
    assert.equal(f.field("dc-rejection-reason"), undefined); assert.equal(f.mutations.length, 0);
  }
  const centralOnAnalyst = await searched({ mode: "analyst" });
  assert.ok(centralOnAnalyst.field("dc-rejection-reason"));
});

test("manual review acknowledgement and a meaningful reason are required before confirmation", async () => {
  const f = await searched(); f.prepare();
  assert.match(f.render(), /entre 10 y 500 caracteres/); assert.equal(f.dialog().open, false);
  f.setReason(reason); f.prepare();
  assert.match(f.render(), /Confirma que revisaste/); assert.equal(f.dialog().open, false);
  f.acknowledge(true); f.setReason("x".repeat(501)); f.prepare();
  assert.equal(f.dialog().open, false); assert.equal(f.mutations.length, 0);
});

test("confirmation identifies the decision as FINSER administrative, freezes the case, and cancel does nothing", async () => {
  const f = await searched(); prepare(f);
  assert.equal(f.dialog().open, true); assert.equal(f.dialog().danger, true);
  assert.match(f.dialog().description, /solicitud #15/); assert.ok(f.dialog().description.includes(reason));
  assert.match(f.dialog().description, /DataCrédito conservará su resultado original sin evaluar/);
  assert.equal(f.field("tx06-document").disabled, true);
  f.setDocument("9999999"); assert.equal(f.field("tx06-document").value, documentNumber);
  f.cancel(); assert.equal(f.dialog().open, false);
  assert.equal(f.field("dc-rejection-reason").value, reason); assert.equal(f.mutations.length, 0);
});

test("a double confirmation writes once and renders the actual administrative decision without altering provider status", async () => {
  const pending = deferred(); const f = await searched({ mutation: () => pending.promise }); prepare(f);
  const confirm = f.dialog().onConfirm; confirm(); confirm();
  assert.equal(f.mutations.length, 1); assert.equal(f.dialog().busy, true);
  assert.deepEqual({ ...f.mutations[0].body, mutationId: null }, { documentNumber, solicitudId: 15, reason, reviewed: true, confirmed: true, mutationId: null });
  assert.ok(f.mutations[0].url.endsWith(`/${assessmentId}/rechazo-administrativo`));
  f.cancel(); assert.equal(f.dialog().open, true);
  pending.resolve(response({ ok: true, result: { rejection: decision, idempotent: false } })); await f.settle();
  assert.equal(f.dialog().open, false); assert.equal(f.field("dc-rejection-reason"), undefined);
  assert.match(f.render(), /Rechazo administrativo de FINSER/); assert.match(f.render(), /No evaluado/);
  assert.match(f.render(), /Solicitud #15 cerrada/); assert.equal(f.requests.length, 2);
});

test("a failed or ambiguous write preserves reason and acknowledgement and retries using the same mutation ID", async () => {
  let attempt = 0;
  const f = await searched({ mutation: async () => {
    attempt++; if (attempt === 1) throw new Error("Connection lost");
    return response({ ok: true, result: { rejection: decision, idempotent: true } });
  } });
  prepare(f); f.confirm(); await f.settle();
  assert.match(f.render(), /Se conserva el motivo/); assert.equal(f.field("dc-rejection-reason").value, reason);
  assert.equal(f.checkbox().checked, true); assert.equal(f.dialog().open, false);
  f.prepare(); f.confirm(); await f.settle();
  assert.equal(f.mutations.length, 2); assert.equal(f.mutations[0].body.mutationId, f.mutations[1].body.mutationId);
  assert.match(f.render(), /Rechazo administrativo de FINSER/);
});

test("a saved decision is shown separately and cannot be resubmitted", async () => {
  const f = await searched({ result: candidate({ adminRejection: { canReject: true, eligible: false, solicitudId: 15, decision } }) });
  assert.match(f.render(), /Rechazo administrativo de FINSER/); assert.match(f.render(), /No evaluado/);
  assert.equal(f.field("dc-rejection-reason"), undefined); assert.equal(f.mutations.length, 0);
});

test("a mismatched server response never confirms another case and leaves the reason available", async () => {
  const f = await searched({ mutation: async () => response({ ok: true, result: {
    rejection: { ...decision, solicitudId: 987 }, idempotent: false,
  } }) });
  prepare(f); f.confirm(); await f.settle();
  assert.match(f.render(), /No se recibió una confirmación válida para esta solicitud/);
  assert.equal(f.field("dc-rejection-reason").value, reason);
  assert.doesNotMatch(f.render(), /Solicitud #987 cerrada/);
});

test("changing the document clears the previous review and no rejection can target the old case", async () => {
  const f = await searched(); f.setReason(reason); f.acknowledge(true); f.setDocument("99999999");
  assert.equal(f.field("dc-rejection-reason"), undefined); assert.equal(f.dialog().open, false);
  assert.equal(f.mutations.length, 0); assert.equal(f.field("tx06-document").value, "99999999");
});

test("the existing TX06 surname correction remains available without the rejection form", async () => {
  const f = await searched({ result: candidate({ eligible: true, transactionCode: "06", adminRejection: undefined }) });
  assert.ok(f.field("tx06-first-surname")); assert.ok(f.button("Revisar liberación"));
  assert.equal(f.field("dc-rejection-reason"), undefined); assert.equal(f.mutations.length, 0);
});
