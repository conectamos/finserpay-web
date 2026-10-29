import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../app/dashboard/creditos/seller-session-recovery-dialog.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = { sellerId: 17, sellerName: "Asesor ficticio", siteId: 2, siteName: "Sede ficticia", userId: 14, draftId: 4276 };
const successful = () => Response.json({ ok: true, seller: { id: 17 }, operationalSede: { id: 2 }, recovery: { sellerId: 17, sedeId: 2, userId: 14, draftId: 4276 } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== "object" ? [] : [tree, ...nodes(tree.props?.children)];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : String(tree ?? "");

function harness(response = successful) {
  const states = [], effects = [], pending = [], requests = [], deadlines = new Map();
  const events = { recovered: 0, cancelled: 0, shown: 0, closed: 0, focused: 0, restored: 0 };
  let cursor = 0, effectCursor = 0, props = { open: true, context };
  class Element { isConnected = true; focus() { events.restored++; } }
  const dialog = { open: false, showModal() { this.open = true; events.shown++; }, close() { this.open = false; events.closed++; } };
  const input = { focus() { events.focused++; } };
  const node = (type, props) => {
    if (props.ref) props.ref.current = type === "dialog" ? dialog : type === "Input" ? input : null;
    return { type, props };
  };
  const loaded = { exports: {} };
  runInNewContext(code, {
    module: loaded, exports: loaded.exports, AbortController, HTMLElement: Element, document: { activeElement: new Element() },
    window: { setTimeout(callback) { const id = Symbol(); deadlines.set(id, callback); return id; }, clearTimeout(id) { deadlines.delete(id); } },
    fetch: async (url, options) => { requests.push({ url, ...options }); return response(options); },
    require(name) {
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "Fragment" };
      if (name === "react") return {
        useState(initial) { const slot = cursor++; if (!(slot in states)) states[slot] = initial; return [states[slot], value => { states[slot] = typeof value === "function" ? value(states[slot]) : value; }]; },
        useRef(initial) { const slot = cursor++; if (!(slot in states)) states[slot] = { current: initial }; return states[slot]; },
        useId() { const slot = cursor++; return `test-${slot}`; },
        useCallback(callback) { const slot = cursor++; if (!(slot in states)) states[slot] = callback; return states[slot]; },
        useEffect(callback, deps) {
          const slot = effectCursor++, previous = effects[slot];
          if (!previous || deps.some((dep, index) => dep !== previous.deps[index])) {
            effects[slot] = { deps }; pending.push(() => { previous?.cleanup?.(); effects[slot].cleanup = callback(); });
          }
        },
      };
      if (name === "@/app/_components/finser-ui" || name === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
      throw Error(`Unexpected import: ${name}`);
    },
  });
  const render = () => { cursor = 0; effectCursor = 0; return loaded.exports.default({ ...props, onRecovered() { events.recovered++; }, onCancel() { events.cancelled++; } }); };
  const find = (type, predicate = () => true) => nodes(render()).find(item => item.type === type && predicate(item.props));
  const flush = async () => { render(); while (pending.length) pending.shift()(); await tick(); render(); };
  const enter = value => find("Input").props.onChange({ target: { value } });
  const submit = () => find("form").props.onSubmit({ preventDefault() {} });
  const cancel = () => find("Button", props => text(props.children) === "Volver al formulario").props.onClick();
  return { events, requests, dialog, render, find, flush, enter, submit, cancel, deadlines,
    timeout() { for (const callback of deadlines.values()) callback(); },
    setProps(value) { props = { ...props, ...value }; },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

test("confirma por PIN el mismo asesor, sede y borrador sin enviar datos del formulario", async () => {
  const h = harness(); await h.flush();
  assert.equal(h.dialog.open, true); assert.equal(h.events.shown, 1); assert.ok(h.events.focused > 0);
  assert.equal(h.find("Input").props.type, "password");
  assert.equal(h.find("Input").props.autoComplete, "off");
  h.enter("01234"); h.submit();
  assert.equal(h.find("Input").props.value, "", "borra el PIN visible inmediatamente al enviar");
  await tick();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, "/api/vendedores/session");
  assert.equal(request.method, "POST");
  assert.equal(request.cache, "no-store");
  assert.deepEqual(JSON.parse(request.body), { vendedorId: 17, pin: "01234", sedeId: 2, recoveryDraftId: 4276, expectedUserId: 14 });
  assert.equal(h.events.recovered, 1);
  assert.equal(h.events.cancelled, 0);
  assert.equal(h.find("Input").props.value, "");
});

test("bloquea doble envío y Escape durante la confirmación", async () => {
  const hold = deferred(), h = harness(() => hold.promise); await h.flush();
  h.enter("1234"); h.submit(); h.submit(); h.cancel();
  let prevented = false;
  h.find("dialog").props.onCancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.events.cancelled, 0);
  assert.equal(h.requests.length, 1); assert.equal(h.find("Input").props.disabled, true);
  hold.resolve(successful()); await tick();
  assert.equal(h.events.recovered, 1); assert.equal(h.find("Input").props.disabled, false);
});

test("PIN incompleto o incorrecto conserva el diálogo y limpia la entrada sin pedir login base", async () => {
  const h = harness(() => Response.json({ code: "INVALID_SELLER_PIN", error: "El PIN ingresado no es correcto" }, { status: 401 })); await h.flush();
  h.enter("123"); h.submit(); await tick();
  assert.equal(h.requests.length, 0); assert.equal(h.find("Input").props.value, "");
  h.enter("1111"); h.submit(); await tick();
  assert.equal(h.events.recovered, 0); assert.equal(h.dialog.open, true);
  assert.equal(h.find("Input").props.value, "");
  assert.match(text(h.find("p", props => props.role === "alert")), /PIN ingresado/);
  assert.equal(h.find("a"), undefined);
});

test("una sesión base perdida o cambiada ofrece recuperación en otra pestaña sin redirigir", async () => {
  for (const [status, code] of [[401, "AUTH_REQUIRED"], [401, undefined], [409, "SESSION_USER_CHANGED"]]) {
    const h = harness(() => Response.json({ code, error: "Sesión requerida" }, { status })); await h.flush();
    h.enter("1234"); h.submit(); await tick();
    const link = h.find("a");
    assert.equal(link.props.href, "/dashboard"); assert.equal(link.props.target, "_blank");
    assert.equal(link.props.rel, "noopener noreferrer");
    assert.equal(h.events.recovered, 0); assert.equal(h.dialog.open, true);
    assert.equal(h.find("Input").props.value, "");
  }
});

test("no continúa ante respuestas de otro perfil, sede, usuario o solicitud, ni selección incompleta", async () => {
  const valid = await successful().json();
  for (const patch of [
    { seller: { id: 18 } }, { operationalSede: { id: 3 } }, { requiresSedeSelection: true },
    { recovery: { ...valid.recovery, draftId: 4277 } }, { recovery: { ...valid.recovery, userId: 99 } },
    { recovery: { ...valid.recovery, sellerId: 99 } }, { recovery: { ...valid.recovery, sedeId: 99 } },
    { recovery: undefined }, { mustChangePin: true },
  ]) {
    const h = harness(() => Response.json({ ...valid, ...patch })); await h.flush();
    h.enter("1234"); h.submit(); await tick();
    assert.equal(h.events.recovered, 0); assert.ok(h.find("p", props => props.role === "alert"));
    assert.equal(h.find("Input").props.value, "");
    if (patch.mustChangePin) assert.equal(h.find("a").props.href, "/dashboard/pin");
  }
});

test("la recuperación aparte distingue la pestaña original donde permanece el formulario", async () => {
  const h = harness(() => Response.json({ code: "AUTH_REQUIRED" }, { status: 401 }));
  h.setProps({ formInAnotherTab: true }); await h.flush();
  assert.match(text(h.find("header")), /pestaña original/);
  h.enter("1234"); h.submit(); await tick();
  assert.match(text(h.find("p", props => props.role === "alert")), /pestaña original/);
});

test("descarta confirmaciones tardías al cerrar, desmontar o cambiar la solicitud", async () => {
  for (const change of ["close", "unmount", "context"]) {
    const hold = deferred(), h = harness(() => hold.promise); await h.flush();
    h.enter("1234"); h.submit();
    if (change === "unmount") h.unmount();
    else { h.setProps(change === "close" ? { open: false } : { context: { ...context, draftId: 4277 } }); await h.flush(); }
    assert.equal(h.requests[0].signal.aborted, true);
    hold.resolve(successful()); await tick();
    assert.equal(h.events.recovered, 0); assert.equal(h.find("Input").props.value, "");
  }
});

test("cancelación devuelve el control sin enviar PIN; fallos de red permiten reintentar sin perder contexto", async () => {
  let fail = true;
  const h = harness(() => { if (fail) throw Error("Network unavailable"); return successful(); }); await h.flush();
  h.enter("1234"); h.cancel();
  assert.equal(h.events.cancelled, 1); assert.equal(h.requests.length, 0); assert.equal(h.find("Input").props.value, "");
  h.enter("1234"); h.submit(); await tick();
  assert.equal(h.events.recovered, 0); assert.equal(h.find("Input").props.value, "");
  assert.match(text(h.find("p", props => props.role === "alert")), /conexión/);
  fail = false; h.enter("1234"); h.submit(); await tick();
  assert.equal(h.events.recovered, 1);
  h.setProps({ open: false }); await h.flush();
  assert.equal(h.dialog.open, false); assert.ok(h.events.restored > 0);
});

test("un servidor que no responde vence a los20segundos y permite otro intento", async () => {
  let stall = true;
  const h = harness(({ signal }) => stall
    ? new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Error("Aborted")), { once: true }))
    : successful());
  await h.flush(); h.enter("1234"); h.submit();
  assert.equal(h.find("Input").props.disabled, true); assert.equal(h.deadlines.size, 1);
  h.timeout(); await tick();
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.find("Input").props.disabled, false); assert.equal(h.deadlines.size, 0);
  assert.match(text(h.find("p", props => props.role === "alert")), /tardó demasiado/);
  assert.equal(h.find("Input").props.value, ""); assert.equal(h.events.recovered, 0);
  stall = false; h.enter("1234"); h.submit(); await tick();
  assert.equal(h.events.recovered, 1); assert.equal(h.deadlines.size, 0);
});
