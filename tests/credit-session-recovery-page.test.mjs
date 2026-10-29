import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compile = path => ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const node = (type, props) => ({ type, props });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== "object" ? [] : [tree, ...nodes(tree.props?.children)];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : String(tree ?? "");
const tick = () => new Promise(resolve => setImmediate(resolve));
const context = { sellerId: 17, sellerName: "Asesor sintético", siteId: 2, siteName: "Sede sintética", userId: 14, draftId: 42 };
const valid = () => Response.json({ ok: true, recoveryContext: context });

function harness({ draftId = 42, response = valid } = {}) {
  const state = [], effects = [], pending = [], requests = [];
  let cursor = 0, effectCursor = 0;
  const loaded = { exports: {} };
  runInNewContext(compile("app/dashboard/creditos/recuperar-sesion/recovery-client.tsx"), {
    module: loaded, exports: loaded.exports, AbortController,
    fetch: async (url, init) => { requests.push({ url, ...init }); return response(); },
    require(name) {
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node };
      if (name === "react") return {
        useState(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = initial;
          return [state[slot], value => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }]; },
        useEffect(callback, deps) { const slot = effectCursor++, previous = effects[slot];
          if (!previous || deps.some((value, i) => previous.deps[i] !== value)) {
            effects[slot] = { deps }; pending.push(() => { previous?.cleanup?.(); effects[slot].cleanup = callback(); });
          }
        },
      };
      if (name === "@/app/_components/finser-ui" || name === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
      if (name.includes("finser-brand")) return { default: "FinserBrand" };
      if (name.endsWith("seller-session-recovery-dialog")) return { default: "RecoveryDialog" };
      throw Error(`Unexpected import ${name}`);
    },
  });
  const render = () => { cursor = 0; effectCursor = 0; return loaded.exports.default({ draftId }); };
  const find = (type, predicate = () => true) => nodes(render()).find(entry => entry.type === type && predicate(entry.props));
  const flush = async () => { render(); while (pending.length) pending.shift()(); await tick(); return render(); };
  return { requests, render, find, flush, unmount() { for (const effect of effects) effect.cleanup?.(); } };
}

test("la página valida un único identificador estricto antes de montar la recuperación", async () => {
  const loaded = { exports: {} };
  runInNewContext(compile("app/dashboard/creditos/recuperar-sesion/page.tsx"), {
    module: loaded, exports: loaded.exports,
    require: name => name === "react/jsx-runtime" ? { jsx: node } : { default: "RecoveryPageClient" },
  });
  assert.equal(loaded.exports.dynamic, "force-dynamic");
  for (const invalid of [undefined, "", "0", "-1", "1.5", "1e3", " 42", "42 ", "01", "2147483648", ["42", "43"]]) {
    assert.equal((await loaded.exports.default({ searchParams: Promise.resolve({ draft: invalid }) })).props.draftId, null);
  }
  assert.equal((await loaded.exports.default({ searchParams: Promise.resolve({ draft: "42" }) })).props.draftId, 42);
  const invalidPage = harness({ draftId: null }); await invalidPage.flush();
  assert.equal(invalidPage.requests.length, 0);
  assert.ok(invalidPage.find("div", props => props.role === "alert"));
});

test("consulta privada solo lectura y pasa al diálogo únicamente contexto verificado sin datos del cliente", async () => {
  const h = harness({ response: () => Response.json({ ok: true, recoveryContext: { ...context, clienteDocumento: "PRIVATE", payload: { secret: true }, pin: "PRIVATE" } }) });
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/vendedores/session?recoveryDraftId=42");
  assert.equal(h.requests[0].cache, "no-store");
  assert.equal(h.requests[0].method, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(h.find("RecoveryDialog").props.context)), context);
  assert.equal(h.find("RecoveryDialog").props.open, true);
  assert.equal(h.find("RecoveryDialog").props.formInAnotherTab, true);
  assert.doesNotMatch(text(h.render()), /PRIVATE|secret/);
});

test("cancelar preserva la página y recuperar muestra instrucciones sin guardar, recargar ni navegar", async () => {
  const h = harness(); await h.flush();
  h.find("RecoveryDialog").props.onCancel();
  assert.equal(h.find("RecoveryDialog").props.open, false);
  h.find("Button", props => text(props.children) === "Confirmar mi perfil").props.onClick();
  assert.equal(h.find("RecoveryDialog").props.open, true);
  h.find("RecoveryDialog").props.onRecovered();
  assert.equal(h.find("RecoveryDialog").props.open, false);
  assert.match(text(h.render()), /Sesión comercial recuperada/);
  assert.match(text(h.render()), /Vuelve a la pestaña de la solicitud 42/);
  assert.equal(h.requests.length, 1, "el callback no guarda ni modifica la solicitud");
  const link = h.find("a", props => props.href === "/dashboard/solicitudes");
  assert.equal(link.props.target, "_blank");
  assert.match(link.props.rel, /noopener/);
});

test("una sesión base ausente permite ingresar en otra pestaña y consultar de nuevo sin cerrar el formulario", async () => {
  let attempts = 0;
  const h = harness({ response: () => ++attempts === 1 ? Response.json({ error: "No autenticado" }, { status: 401 }) : valid() });
  await h.flush();
  assert.equal(h.find("RecoveryDialog"), undefined);
  const login = h.find("a", props => props.href === "/dashboard");
  assert.equal(login.props.target, "_blank");
  h.find("Button", props => text(props.children) === "Reintentar").props.onClick();
  await h.flush();
  assert.equal(h.find("RecoveryDialog").props.open, true);
  assert.equal(h.requests.length, 2);
});

test("no habilita PIN con un caso distinto, contexto incompleto o acceso denegado", async () => {
  for (const body of [
    { ok: false, recoveryContext: context },
    { ok: true, recoveryContext: { ...context, draftId: 43 } },
    { ok: true, recoveryContext: { ...context, sellerId: "17" } },
    { ok: true, recoveryContext: { ...context, siteName: "" } },
    { ok: true, recoveryContext: null },
  ]) {
    const h = harness({ response: () => Response.json(body) }); await h.flush();
    assert.equal(h.find("RecoveryDialog"), undefined);
    assert.ok(h.find("p", props => props.role === "alert"));
  }
  const denied = harness({ response: () => Response.json({ error: "Solicitud no autorizada" }, { status: 403 }) });
  await denied.flush(); assert.equal(denied.find("RecoveryDialog"), undefined);
  assert.match(text(denied.render()), /Solicitud no autorizada/);
});

test("una respuesta tardía tras desmontar no puede abrir la autenticación", async () => {
  let resolve;
  const delayed = new Promise(done => { resolve = done; });
  const h = harness({ response: () => delayed }); await h.flush();
  h.unmount();
  assert.equal(h.requests[0].signal.aborted, true);
  resolve(valid()); await tick();
  assert.equal(h.find("RecoveryDialog"), undefined);
});
