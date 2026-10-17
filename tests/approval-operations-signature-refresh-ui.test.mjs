import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/aprobaciones/approval-operations.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const components = Object.fromEntries(["Badge", "Button", "Card", "Input", "LoadingState", "PageHeader", "Select", "StatusPill"]
  .map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
  [value, ...nodes(value.props?.children)];
const text = value => Array.isArray(value) ? value.map(text).join(" ") : typeof value === "string" ? value :
  value && typeof value === "object" ? text(value.props?.children) : "";
const button = (tree, label) => nodes(tree).find(node => node.type === components.Button && text(node.props.children).trim() === label);
const response = (payload, ok = true) => ({ ok, json: async () => payload });
const fixture = (status = "TECHNICAL_ERROR", id = 18) => ({
  kind: "DRAFT", id, number: "SOL-" + id, clientName: "Cliente " + id, document: "1234567890",
  phone: "3114921873", email: "cliente@example.test", status: "ACTIVO", equipment: "iPhone QA",
  imei: "111111111111111", timeline: [], updatedAt: "2026-10-17T16:32:00Z",
  signature: { status, processUuid: "process-" + id, sentPhone: "3114921873", sentEmail: "cliente@example.test",
    sentAt: "2026-10-17T16:32:00Z", signedAt: null },
  capabilities: { canChangeImei: false, canUpdateContact: false, canSendSignature: false, canResendSignature: false,
    canRedirectPendingSignature: false, preSettlementApprovalCreditId: null, signatureReason: null },
  replacement: null, remission: null,
});

async function workspace({ item = fixture(), sync } = {}) {
  const slots = [], requests = [];
  let hookIndex = 0, dirty = true, effects = [], tree;
  const items = new Map([[item.id, item]]);
  const props = { mode: "signature", initialCase: { kind: item.kind, id: item.id } };
  const loaded = { exports: {} };
  const hooks = {
    useState(initial) {
      const index = hookIndex++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === "function" ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(value) { const index = hookIndex++; slots[index] ||= { current: value }; return slots[index]; },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!slots[index] || deps.some((value, part) => !Object.is(value, slots[index].deps[part]))) {
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, Intl, Date,
    window: { setInterval: () => 1, clearInterval() {} },
    document: { hidden: true, addEventListener() {}, removeEventListener() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || "GET", ...options });
      if (url.endsWith("/firma/actualizar")) return sync({ url, options });
      if (/^\/api\/creditos\/borradores\/\d+\/corregir-identidad$/.test(url)) return response({ ok: true, canCorrect: false });
      const match = /^\/api\/aprobaciones\/operativo\/(?:draft|credit)\/(\d+)$/.exec(url);
      if (match) return response({ ok: true, item: items.get(Number(match[1])) });
      throw new Error("Unexpected request: " + url);
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" };
      if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: () => null };
      if (name === "./credit-welcome-voice-result") return { default: () => null };
      if (name === "./approval-operations.module.css") return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error("Unexpected import: " + name);
    },
  });
  async function flush() {
    for (let cycle = 0; cycle < 30; cycle++) {
      if (dirty) { dirty = false; hookIndex = 0; effects = []; tree = loaded.exports.default(props); effects.forEach(effect => effect()); }
      await setImmediate();
      if (!dirty) return tree;
    }
    assert.fail("The signature component did not settle");
  }
  await flush();
  button(tree, "FirmaSeguro").props.onClick();
  await flush();
  return {
    requests, flush, tree: () => tree,
    async select(next) { items.set(next.id, next); props.initialCase = { kind: next.kind, id: next.id }; dirty = true; return flush(); },
    dispose() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

for (const kind of ["DRAFT", "CREDIT"]) for (const status of ["PENDING", "TECHNICAL_ERROR"])
  test(`consulta manual recupera el mismo contrato ${kind} ${status} sin reenviarlo`, async () => {
  const item = { ...fixture(status), kind };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const view = await workspace({ item, sync: () => pending });
  try {
    assert.equal(view.requests.filter(request => request.method === "POST").length, 0,
      "abrir el panel solo consulta la ficha local");
    const consult = button(view.tree(), "Consultar estado en FirmaSeguro");
    assert.ok(consult, "el estado técnico conserva una salida para consultar al proveedor");
    consult.props.onClick();
    consult.props.onClick();
    await view.flush();
    const posts = view.requests.filter(request => request.method === "POST");
    assert.equal(posts.length, 1, "el doble clic no consulta dos veces");
    assert.equal(posts[0].url, "/api/aprobaciones/operativo/" + kind.toLowerCase() + "/18/firma/actualizar");
    assert.deepEqual(JSON.parse(posts[0].body), { expectedProcessUuid: "process-18" });
    assert.equal(button(view.tree(), "Consultando estado...").props.disabled, true);
    assert.equal(button(view.tree(), "Consultando estado...").props["aria-busy"], true);
    release(response({ ok: true, message: "Firma confirmada. Documento sincronizado.",
      item: { ...item, signature: { ...item.signature, status: "SIGNED", signedAt: "2026-10-17T16:50:00Z" } } }));
    await view.flush();
    assert.match(text(view.tree()), /Firma confirmada\. Documento sincronizado\./);
    assert.ok(nodes(view.tree()).some(node => node.type === components.StatusPill && node.props.children === "Firmada"));
    assert.equal(button(view.tree(), "Consultar estado en FirmaSeguro"), undefined);
    assert.ok(view.requests.every(request => request.method === "GET" || request.url.endsWith("/firma/actualizar")),
      "la recuperación nunca crea ni reenvía otro proceso de firma");
  } finally { view.dispose(); }
});

test("una consulta fallida conserva el crédito, el contacto y el estado anterior", async () => {
  const view = await workspace({ sync: async () => response({ ok: false, error: "FirmaSeguro no está disponible" }, false) });
  try {
    button(view.tree(), "Consultar estado en FirmaSeguro").props.onClick();
    await view.flush();
    assert.match(text(view.tree()), /FirmaSeguro no está disponible/);
    assert.ok(nodes(view.tree()).some(node => node.props?.role === "alert"));
    assert.ok(nodes(view.tree()).some(node => node.type === components.StatusPill && node.props.children === "Error técnico: requiere revisión"));
    assert.equal(nodes(view.tree()).find(node => node.props?.id === "approval-signature-phone").props.value, "3114921873");
    assert.equal(button(view.tree(), "Consultar estado en FirmaSeguro").props.disabled, false);
  } finally { view.dispose(); }
});

test("consultar no marca firmada una respuesta que continúa pendiente", async () => {
  const item = fixture("PENDING");
  const view = await workspace({ item, sync: async () => response({ ok: true, item }) });
  try {
    button(view.tree(), "Consultar estado en FirmaSeguro").props.onClick();
    await view.flush();
    assert.match(text(view.tree()), /sigue pendiente de firma/);
    assert.ok(nodes(view.tree()).some(node => node.type === components.StatusPill && node.props.children === "Pendiente de firma"));
    assert.ok(button(view.tree(), "Consultar estado en FirmaSeguro"));
  } finally { view.dispose(); }
});

test("no aplica una respuesta correspondiente a otro proceso", async () => {
  const item = fixture();
  const view = await workspace({ item, sync: async () => response({ ok: true,
    item: { ...item, signature: { ...item.signature, status: "SIGNED", processUuid: "other-process" } } }) });
  try {
    button(view.tree(), "Consultar estado en FirmaSeguro").props.onClick();
    await view.flush();
    assert.match(text(view.tree()), /La firma vigente cambió/);
    assert.ok(nodes(view.tree()).some(node => node.type === components.StatusPill && node.props.children === "Error técnico: requiere revisión"));
    assert.ok(button(view.tree(), "Consultar estado en FirmaSeguro"));
  } finally { view.dispose(); }
});

test("cambiar la solicitud descarta la respuesta tardía del proceso anterior", async () => {
  const item = fixture();
  let release;
  const view = await workspace({ item, sync: () => new Promise(resolve => { release = resolve; }) });
  try {
    button(view.tree(), "Consultar estado en FirmaSeguro").props.onClick();
    await view.flush();
    const request = view.requests.find(request => request.method === "POST");
    const next = fixture("PENDING", 24);
    await view.select(next);
    assert.equal(request.signal.aborted, true);
    release(response({ ok: true, message: "Mensaje tardío del crédito anterior",
      item: { ...item, signature: { ...item.signature, status: "SIGNED" } } }));
    await view.flush();
    assert.doesNotMatch(text(view.tree()), /Mensaje tardío del crédito anterior/);
    assert.ok(nodes(view.tree()).some(node => node.type === components.StatusPill && node.props.children === "Pendiente de firma"));
    assert.equal(button(view.tree(), "Consultar estado en FirmaSeguro").props.disabled, false);
  } finally { view.dispose(); }
});

for (const status of ["NOT_SENT", "SIGNED"]) test(`no ofrece recuperación manual cuando la firma está ${status}`, async () => {
  const item = fixture(status);
  if (status === "NOT_SENT") item.signature.processUuid = null;
  const view = await workspace({ item, sync: () => assert.fail("No debe consultar el proveedor") });
  try { assert.equal(button(view.tree(), "Consultar estado en FirmaSeguro"), undefined); }
  finally { view.dispose(); }
});

test("sin identificador de proceso no ofrece una consulta ni instrucciones imposibles", async () => {
  const item = fixture();
  item.signature.processUuid = null;
  const view = await workspace({ item, sync: () => assert.fail("No debe consultar el proveedor") });
  try {
    assert.equal(button(view.tree(), "Consultar estado en FirmaSeguro"), undefined);
    assert.doesNotMatch(text(view.tree()), /Consulta el estado en FirmaSeguro/);
  } finally { view.dispose(); }
});

test("el crédito conserva el aviso específico si FirmaSeguro terminó la firma pero falta recuperar el PDF", async () => {
  const item = { ...fixture(), kind: "CREDIT" };
  const message = "FirmaSeguro reporta la firma completada, pero todavía no está disponible su PDF firmado. No se creó ni reenvió otra firma.";
  const view = await workspace({ item, sync: async () => response({ ok: true, item, message }) });
  try {
    button(view.tree(), "Consultar estado en FirmaSeguro").props.onClick();
    await view.flush();
    assert.ok(nodes(view.tree()).some(node => node.props?.role === "alert" && node.props.children === message));
    assert.ok(nodes(view.tree()).some(node => node.type === components.StatusPill && node.props.children === "Error técnico: requiere revisión"));
    assert.equal(button(view.tree(), "Consultar estado en FirmaSeguro").props.disabled, false);
  } finally { view.dispose(); }
});
