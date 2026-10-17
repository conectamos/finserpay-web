import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const components = Object.fromEntries(["Button", "EmptyState"].map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
const source = ts.transpileModule(read("app/dashboard/aprobaciones/approval-signed-document-recovery.tsx"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
  [value, ...nodes(value.props?.children)];
const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value :
  value && typeof value === "object" ? text(value.props?.children) : "";
const credit = (id = 81) => ({ id, document: { available: false, processUuid: "process-" + id, href: "/document/" + id, fileName: null } });
const response = (payload, ok = true) => ({ ok, json: async () => payload });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function mount({ detail = credit(), disabled = false, send = async () => response({ ok: true, item: detail }), update = async () => {} } = {}) {
  const slots = [], requests = [], busyChanges = [];
  let hookIndex = 0, dirty = true, effects = [], tree, updates = 0;
  const props = { detail, disabled,
    onUpdated: async () => { updates++; return update(); }, onBusyChange: value => busyChanges.push(value) };
  const hooks = {
    useState(initial) {
      const index = hookIndex++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; dirty = true; }];
    },
    useRef(initial) { const index = hookIndex++; slots[index] ||= { current: initial }; return slots[index]; },
    useCallback(callback, deps) {
      const index = hookIndex++;
      if (!slots[index] || deps.some((value, part) => !Object.is(value, slots[index].deps[part]))) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!slots[index] || deps.some((value, part) => !Object.is(value, slots[index].deps[part])))
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
  };
  const loaded = { exports: {} };
  runInNewContext(source, {
    module: loaded, exports: loaded.exports, AbortController,
    fetch: async (url, options) => { requests.push({ url, ...options }); return send(url, options); },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "lucide-react") return { RefreshCw: () => null };
      if (name === "@/app/_components/finser-ui") return components;
      throw new Error("Unexpected dependency: " + name);
    },
  });
  return {
    requests, busyChanges,
    async flush() {
      for (let cycle = 0; cycle < 30; cycle++) {
        if (dirty) { dirty = false; hookIndex = 0; effects = []; tree = loaded.exports.default(props); effects.forEach(effect => effect()); }
        await setImmediate();
        if (!dirty) return;
      }
      assert.fail("Document recovery did not settle");
    },
    button() { return nodes(tree).find(node => node.type === components.Button); },
    tree: () => tree,
    updates: () => updates,
    update(next) { Object.assign(props, next); dirty = true; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("abrir el contrato consulta el mismo documento una vez y bloquea solicitudes duplicadas", async () => {
  const pending = deferred();
  const h = mount({ send: () => pending.promise });
  try {
    await h.flush();
    assert.equal(h.requests.length, 1, "la recuperación inicia una sola consulta al montar la sección visible");
    assert.match(text(h.tree()), /no crea ni reenvía una firma/);
    const consult = h.button();
    consult.props.onClick(); consult.props.onClick();
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, "/api/aprobaciones/81/documento");
    assert.equal(h.requests[0].method, "POST");
    assert.deepEqual(JSON.parse(h.requests[0].body), { expectedProcessUuid: "process-81" });
    assert.equal(h.button().props.disabled, true);
    assert.equal(h.button().props["aria-busy"], true);
    assert.equal(h.busyChanges[0], true);
    pending.resolve(response({ ok: true, item: { ...credit(), document: { ...credit().document, available: true } }, message: "PDF firmado recuperado." }));
    await h.flush();
    assert.equal(h.updates(), 1, "recarga la ficha únicamente tras una respuesta válida del mismo crédito");
    assert.match(text(h.tree()), /PDF firmado recuperado/);
    assert.equal(h.busyChanges.at(-1), false);
  } finally { h.unmount(); }
});

test("un 504 conserva la ficha y permite un reintento explícito sin un bucle automático", async () => {
  let attempts = 0;
  const h = mount({ send: async () => ++attempts === 1
    ? response({ ok: false, error: "FirmaSeguro respondió HTTP 504 al descargar el PDF." }, false)
    : response({ ok: true, item: { ...credit(), document: { ...credit().document, available: true } }, message: "PDF firmado recuperado." }) });
  try {
    await h.flush();
    assert.match(text(h.tree()), /HTTP 504 al descargar el PDF/);
    assert.ok(nodes(h.tree()).some(node => node.props?.role === "alert"));
    assert.equal(h.updates(), 0, "un fallo no desmonta la ficha ni sustituye el mensaje del proveedor");
    assert.equal(h.button().props.disabled, false);
    assert.equal(h.busyChanges.at(-1), false);
    await h.flush();
    assert.equal(h.requests.length, 1, "un error no dispara otro intento automático");
    h.button().props.onClick(); await h.flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.updates(), 1);
    assert.match(text(h.tree()), /PDF firmado recuperado/);
  } finally { h.unmount(); }
});

test("una firma completada sin PDF permanece pendiente de recuperación", async () => {
  const message = "FirmaSeguro reporta la firma completada, pero todavía no está disponible su PDF firmado.";
  const h = mount({ send: async () => response({ ok: true, item: credit(), message }) });
  try {
    await h.flush();
    assert.equal(h.updates(), 1);
    assert.ok(nodes(h.tree()).some(node => node.props?.role === "alert" && node.props.children === message));
    assert.equal(h.button().props.disabled, false);
    assert.equal(h.requests.length, 1, "una respuesta sin PDF tampoco se repite automáticamente");
  } finally { h.unmount(); }
});

test("una respuesta de otro proceso no actualiza el expediente", async () => {
  const item = credit(); item.document.processUuid = "different-process";
  const h = mount({ send: async () => response({ ok: true, item }) });
  try {
    await h.flush();
    assert.equal(h.updates(), 0);
    assert.match(text(h.tree()), /La firma vigente cambió/);
  } finally { h.unmount(); }
});

test("cerrar o cambiar la selección aborta y descarta la respuesta anterior", async () => {
  const pending = deferred();
  const h = mount({ send: () => pending.promise });
  await h.flush();
  h.unmount();
  assert.equal(h.requests[0].signal.aborted, true);
  pending.resolve(response({ ok: true, item: { ...credit(), document: { ...credit().document, available: true } } }));
  await h.flush();
  assert.equal(h.updates(), 0);
  assert.equal(h.busyChanges.at(-1), false);
});

test("sin UUID o con documento ya disponible no consulta el proveedor", async () => {
  const absent = credit(); absent.document.processUuid = null;
  const h = mount({ detail: absent });
  try {
    await h.flush();
    assert.equal(h.button(), undefined);
    assert.match(text(h.tree()), /No hay un proceso de FirmaSeguro identificado/);
    assert.equal(h.requests.length, 0);
  } finally { h.unmount(); }
  const ready = credit(); ready.document.available = true;
  const present = mount({ detail: ready });
  try { await present.flush(); assert.equal(present.tree(), null); assert.equal(present.requests.length, 0); }
  finally { present.unmount(); }
});

test("el bloqueo externo impide recuperar mientras se gestiona otra acción", async () => {
  const h = mount({ disabled: true });
  try {
    await h.flush();
    assert.equal(h.button().props.disabled, true);
    h.button().props.onClick(); await h.flush();
    assert.equal(h.requests.length, 0);
    h.update({ disabled: false }); await h.flush();
    assert.equal(h.requests.length, 1, "espera a que termine la otra acción antes de consultar");
    h.update({ disabled: true }); await h.flush();
    h.update({ disabled: false }); await h.flush();
    assert.equal(h.requests.length, 1, "volver a habilitar no repite una consulta ya realizada");
  } finally { h.unmount(); }
});

test("el muro clásico y el tab de contrato usan la recuperación sin crear otra firma", () => {
  const wall = read("app/dashboard/aprobaciones/approval-console.tsx");
  const modern = read("app/revision-creditos/shared-approval-workspace.tsx");
  assert.match(wall, /documentRecoveryPanel: detail \? <ApprovalSignedDocumentRecovery/);
  assert.match(wall, /: <ApprovalSignedDocumentRecovery key=/);
  assert.match(wall, /signatureBusy \|\| documentBusy \|\| noveltyBusy/);
  assert.match(modern, /: activeTab === "document" \? props\.documentRecoveryPanel \|\| <EmptyState/);
});
