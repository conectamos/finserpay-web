import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compile = path => ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const source = compile("app/dashboard/aprobaciones/cartera-mora/mora-portfolio-client.tsx");
const types = { exports: {} };
runInNewContext(compile("lib/analyst-mora-types.ts"), { module: types, exports: types.exports });
const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const item = { id: 42, folio: "QA-42", numeroCreditoVisible: "CR-0042", clienteNombre: "Cliente ficticio",
  clienteDocumento: "000042", aliadoId: 3, aliadoNombre: "Aliado ficticio", equipo: "Equipo de prueba",
  imei: "000000000000042", valorVencido: 180000, diasMora: 15, ultimoPago: null, fechaCredito: "2026-01-01",
  ultimaGestion: null, prorrogaActiva: { id: "extension-42", expiresOn: "2026-11-01", reason: "Prueba",
    approvedAt: null, approvedByName: null, installmentNumber: null, installmentDueDate: null }, estadoGestion: "PRORROGA" };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const node = (type, props) => typeof type === "function" ? type(props) : { type, props };
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== "object" ? [] :
  [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.actions)];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : String(tree ?? "");
const excel = disposition => new Response(new Uint8Array([80, 75, 3, 4]), {
  headers: { "Content-Type": mime, ...(disposition ? { "Content-Disposition": disposition } : {}) },
});

function harness({ scope = "overdue", total = 51, exportResponse = () => excel('attachment; filename="cartera-mora-2026-10-28.xlsx"'), holdSave } = {}) {
  const state = [], effects = [], pending = [], requests = [], downloads = [], blobs = [], revoked = [], timers = [];
  let cursor = 0, effectCursor = 0, listResponse;
  const loaded = { exports: {} };
  const doc = { body: { appendChild(anchor) { anchor.appended = true; } }, createElement() {
    return { style: {}, click() { downloads.push({ filename: this.download, href: this.href, appended: this.appended }); }, remove() { this.removed = true; } };
  } };
  class BrowserURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return `blob:fixture-${blobs.length}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  runInNewContext(source, {
    module: loaded, exports: loaded.exports, URL: BrowserURL, URLSearchParams, AbortController,
    document: doc, window: { setTimeout(callback) { timers.push(callback); } }, crypto: { randomUUID: () => "ui-test-key" },
    fetch: async (url, init = {}) => {
      requests.push({ url, ...init });
      if (url.includes("/export?")) return exportResponse();
      if (init.method === "POST") { await holdSave?.promise; return Response.json({ ok: false, error: "Prueba de guardado" }, { status: 400 }); }
      if (url.endsWith("/42")) return Response.json({ ok: true, credit: { ...item, enMora: true }, history: [],
        currentResponsible: { id: 7, nombre: "Analista de prueba" }, responsibles: [], extensionActions: {} });
      if (listResponse) return listResponse();
      const page = Number(new URL(url, "http://localhost").searchParams.get("page") || 1);
      return Response.json({ ok: true, items: total ? [item] : [], total, page, pageSize: 25, hasMore: page < 3,
        allies: [{ id: 3, nombre: "Aliado ficticio" }], responsibles: [{ id: 7, nombre: "Analista de prueba" }] });
    }, require(name) {
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "Fragment" };
      if (name === "react") return {
        useState(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial;
          return [state[slot], value => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }]; },
        useRef(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot]; },
        useMemo: callback => callback(),
        useEffect(callback, deps) { const slot = effectCursor++, previous = effects[slot];
          if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
            effects[slot] = { deps }; pending.push(() => { previous?.cleanup?.(); effects[slot].cleanup = callback(); });
          }
        },
      };
      if (name === "@/lib/analyst-mora-types") return types.exports;
      if (name === "@/app/_components/finser-ui" || name === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (name.endsWith("mora-portfolio-extension-actions")) return { default: "ExtensionActions" };
      if (name.endsWith("finser-side-panel")) return { default: "SidePanel" };
      if (name.endsWith("mora-supports") || name.endsWith("credit-communications")) return { default: "UnusedPanel" };
      throw Error(`Unexpected import ${name}`);
    },
  });
  const render = () => { cursor = 0; effectCursor = 0; return loaded.exports.default({ scope }); };
  const find = (type, predicate = () => true) => nodes(render()).find(entry => entry.type === type && predicate(entry.props));
  const button = label => find("Button", props => text(props.children) === label);
  const flush = async () => { render(); while (pending.length) pending.shift()(); await tick(); render(); };
  return { requests, downloads, blobs, revoked, timers, render, find, button, flush,
    exports: () => requests.filter(request => request.url.includes("/export?")),
    setListResponse: response => { listResponse = response; },
  };
}

test("la exportación sólo existe en mora y espera una cartera cargada con resultados", async () => {
  const h = harness();
  assert.equal(h.button("Exportar Excel").props.disabled, true);
  h.button("Exportar Excel").props.onClick(); assert.equal(h.exports().length, 0);
  await h.flush(); assert.equal(h.button("Exportar Excel").props.disabled, false);
  const empty = harness({ total: 0 }); await empty.flush();
  assert.equal(empty.button("Exportar Excel").props.disabled, true);
  empty.button("Exportar Excel").props.onClick(); assert.equal(empty.exports().length, 0);
  const all = harness({ scope: "all" }); await all.flush();
  assert.equal(all.button("Exportar Excel"), undefined);
  assert.equal(all.find("PageHeader").props.description.includes("Excel"), false);
});

test("usa todos los filtros aplicados y omite la página aunque el listado esté paginado y haya borradores", async () => {
  const h = harness(); await h.flush();
  h.find("Input", props => props.maxLength === 100).props.onChange({ target: { value: "  Cliente  " } });
  const selects = nodes(h.render()).filter(entry => entry.type === "Select");
  selects[0].props.onChange({ target: { value: "3" } });
  selects[1].props.onChange({ target: { value: "PRORROGA" } });
  selects[2].props.onChange({ target: { value: "7" } });
  h.find("Input", props => props.type === "date").props.onChange({ target: { value: "2026-11-01" } });
  const numbers = nodes(h.render()).filter(entry => entry.type === "Input" && entry.props.type === "number");
  numbers[0].props.onChange({ target: { value: "3" } }); numbers[1].props.onChange({ target: { value: "40" } });
  h.find("form").props.onSubmit({ preventDefault() {} }); await h.flush();
  h.button("Siguiente").props.onClick(); await h.flush();
  assert.ok(h.requests.some(request => request.url.includes("page=2")));
  h.find("Input", props => props.maxLength === 100).props.onChange({ target: { value: "Borrador sin aplicar" } });
  h.button("Exportar Excel").props.onClick(); await tick();
  const request = h.exports()[0], url = new URL(request.url, "http://localhost");
  assert.equal(url.pathname, "/api/aprobaciones/cartera-mora/export");
  assert.deepEqual(Object.fromEntries(url.searchParams), { q: "Cliente", ally: "3", responsible: "7", minDays: "3", maxDays: "40", status: "PRORROGA", followUp: "2026-11-01" });
  assert.equal(request.cache, "no-store"); assert.equal(h.downloads.length, 1);
});

test("descarga el Blob con nombre del servidor o fallback y revoca su URL temporal", async () => {
  for (const [header, filename] of [
    ['attachment; filename="cartera-mora-2026-10-28.xlsx"', "cartera-mora-2026-10-28.xlsx"],
    ["attachment; filename*=UTF-8''cartera%20mora.xlsx", "cartera mora.xlsx"],
    ['attachment; filename="../../reporte.xlsx"', "reporte.xlsx"],
    [undefined, "cartera-mora.xlsx"], ['attachment; filename="archivo.html"', "cartera-mora.xlsx"],
  ]) {
    const h = harness({ exportResponse: () => excel(header) }); await h.flush();
    h.button("Exportar Excel").props.onClick(); await tick();
    assert.deepEqual(h.downloads, [{ filename, href: "blob:fixture-1", appended: true }]);
    assert.equal(h.blobs[0].type, mime); assert.equal(h.blobs[0].size, 4);
    h.timers.forEach(callback => callback()); assert.deepEqual(h.revoked, ["blob:fixture-1"]);
    assert.equal(h.button("Exportar Excel").props.disabled, false);
  }
});

test("errores HTTP, contenido no Excel y red conservan listado y permiten reintentar", async () => {
  for (const response of [
    () => Response.json({ error: "Ya se está generando un Excel" }, { status: 429 }),
    () => new Response("Error temporal", { status: 500 }),
    () => Response.json({ ok: true }),
    () => { throw Error("network failed"); },
  ]) {
    const h = harness({ exportResponse: response }); await h.flush();
    h.button("Exportar Excel").props.onClick(); await tick();
    assert.ok(h.find("div", props => props.role === "alert"));
    assert.ok(h.find("strong", props => props.children === item.clienteNombre));
    assert.equal(h.downloads.length, 0); assert.equal(h.blobs.length, 0);
    assert.equal(h.button("Exportar Excel").props.disabled, false);
    h.button("Exportar Excel").props.onClick(); await tick(); assert.equal(h.exports().length, 2);
  }
});

test("un doble clic antes del render sólo genera una descarga y muestra estado ocupado", async () => {
  const gate = deferred(), h = harness({ exportResponse: () => gate.promise }); await h.flush();
  const click = h.button("Exportar Excel").props.onClick; click(); click();
  assert.equal(h.exports().length, 1);
  assert.equal(h.button("Exportando...").props.disabled, true);
  assert.equal(h.button("Exportando...").props["aria-busy"], true);
  gate.resolve(excel()); await tick();
  assert.equal(h.downloads.length, 1); assert.equal(h.button("Exportar Excel").props.disabled, false);
});

test("bloquea exportar al consultar, con listado fallido, al gestionar prórrogas y al guardar", async () => {
  const h = harness(); await h.flush();
  const gate = deferred(); h.setListResponse(() => gate.promise);
  h.button("Actualizar").props.onClick(); await h.flush();
  assert.equal(h.button("Exportar Excel").props.disabled, true);
  gate.resolve(Response.json({ error: "No se pudo consultar" }, { status: 500 })); await tick();
  assert.equal(h.button("Exportar Excel").props.disabled, true);
  h.button("Exportar Excel").props.onClick(); assert.equal(h.exports().length, 0);

  const save = deferred(), active = harness({ holdSave: save }); await active.flush();
  active.button("Gestionar").props.onClick(); await tick();
  const extension = active.find("ExtensionActions"); extension.props.onBusyChange(true);
  assert.equal(active.button("Exportar Excel").props.disabled, true);
  active.button("Exportar Excel").props.onClick(); assert.equal(active.exports().length, 0);
  extension.props.onBusyChange(false);
  active.find("Select", props => props.id === "mora-management-result").props.onChange({ target: { value: "SIN_RESPUESTA" } });
  active.find("textarea").props.onChange({ target: { value: "Gestión ficticia para verificar bloqueo" } });
  active.find("form", props => props["aria-labelledby"] === "mora-management-form").props.onSubmit({ preventDefault() {} });
  assert.ok(active.requests.some(request => request.method === "POST"));
  assert.equal(active.button("Exportar Excel").props.disabled, true);
  active.button("Exportar Excel").props.onClick(); assert.equal(active.exports().length, 0);
  save.resolve(); await tick(); assert.equal(active.button("Exportar Excel").props.disabled, false);
});
