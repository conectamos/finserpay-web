import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../app/dashboard/usuarios/central-admin-accounts.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const account = { id: 20, nombre: "Administradora Central", usuario: "central.personal", activo: true,
  rolNombre: "ADMIN", sede: { id: 1, nombre: "FINSER PAY Central" }, updatedAt: "2026-10-28T15:00:00.000Z" };
const node = (type, props) => ({ type, props });
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function harness({ currentUserId = 7, accounts = [account], responseStatus = 200, loadError = "", hold = false } = {}) {
  const state = [];
  let cursor = 0, resolveRequest;
  const writes = [], reloads = [];
  const loadedModule = { exports: {} };
  const props = { currentUserId, accounts, loadError, onReload: async () => {
    reloads.push(true);
    props.accounts = accounts.map(item => ({ ...item, nombre: "Nombre vigente", updatedAt: "2026-10-28T16:00:00.000Z" }));
    props.loadError = "";
    return props.accounts;
  } };
  runInNewContext(source, { module: loadedModule, exports: loadedModule.exports, fetch: async (url, request) => {
    writes.push({ url, ...request, body: JSON.parse(request.body) });
    if (hold) await new Promise(resolve => { resolveRequest = resolve; });
    return { ok: responseStatus === 200, status: responseStatus, json: async () => responseStatus === 200
      ? { mensaje: "Guardado" } : { error: "La cuenta cambió; actualiza la lista" } };
  }, require(name) {
    if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "Fragment" };
    if (name === "react") return {
      useState: initial => { const slot = cursor++; if (!(slot in state)) state[slot] = initial;
        return [state[slot], value => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }]; },
      useRef: initial => { const slot = cursor++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot]; },
    };
    if (name === "next/link") return { default: "Link" };
    if (name === "@/app/_components/finser-confirm-dialog") return { default: "ConfirmDialog" };
    if (name === "@/app/_components/finser-ui") return Object.fromEntries(["Badge", "Button", "Card", "DataTable", "EmptyState", "Input", "LoadingState"].map(type => [type, type]));
    throw Error(`Unexpected import: ${name}`);
  } });
  const render = () => { cursor = 0; return loadedModule.exports.default(props); };
  const find = (type, predicate = () => true) => nodes(render()).find(item => item.type === type && predicate(item.props));
  const open = () => find("Button", props => props["aria-label"] === `Editar ${account.nombre}`).props.onClick();
  return { writes, reloads, render, find, open, release: () => resolveRequest?.(),
    submit: () => find("form").props.onSubmit({ preventDefault() {} }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("lista las cuentas reales sin campos de contraseña y mantiene rol y sede como texto", () => {
  const h = harness();
  h.open();
  const tree = nodes(h.render());
  assert.ok(tree.some(item => item.type === "td" && item.props.children === account.usuario));
  assert.equal(tree.filter(item => item.type === "Input").length, 2);
  assert.equal(tree.some(item => item.props?.type === "password" || item.type === "select"), false);
  assert.ok(tree.some(item => item.type === "p" && item.props.children === account.sede.nombre));
  assert.equal(tree.some(item => item.type === "Link" && item.props.href === "/dashboard/contrasena"), false);
});

test("la cuenta propia no permite desactivación y ofrece cambio de contraseña separado", () => {
  const h = harness({ currentUserId: account.id });
  h.open();
  assert.equal(h.find("input", props => props.type === "checkbox").props.disabled, true);
  assert.equal(h.find("Link").props.href, "/dashboard/contrasena");
});

test("guardar sólo envía datos editables con versión y bloquea envíos duplicados", async () => {
  const h = harness({ hold: true });
  h.open();
  h.find("Input", props => props.maxLength === 120).props.onChange({ target: { value: "Nuevo nombre" } });
  h.submit(); h.submit();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].body, { tipoPerfil: "ADMIN_CENTRAL", administradorId: account.id,
    nombre: "Nuevo nombre", usuario: account.usuario, activo: true, expectedUpdatedAt: account.updatedAt });
  assert.equal(h.find("fieldset").props.disabled, true);
  assert.equal(h.find("Button", props => props.children === "Actualizar lista").props.disabled, true);
  h.release(); await tick();
  assert.equal(h.reloads.length, 1);
  assert.equal(h.find("form"), undefined);
});

test("desactivar espera confirmación explícita y permite cancelar sin solicitud", async () => {
  const h = harness(); h.open();
  h.find("input", props => props.type === "checkbox").props.onChange({ target: { checked: false } });
  h.submit();
  assert.equal(h.writes.length, 0);
  assert.equal(h.find("ConfirmDialog").props.open, true);
  h.find("ConfirmDialog").props.onCancel();
  assert.equal(h.writes.length, 0);
  assert.equal(h.find("ConfirmDialog").props.open, false);
  h.submit(); h.find("ConfirmDialog").props.onConfirm(); await tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].body.activo, false);
});

test("conflicto 409 conserva borrador; recargar recupera la versión vigente", async () => {
  const h = harness({ responseStatus: 409 }); h.open();
  h.find("Input", props => props.maxLength === 120).props.onChange({ target: { value: "Edición pendiente" } });
  h.submit(); await tick();
  assert.equal(h.find("Input", props => props.maxLength === 120).props.value, "Edición pendiente");
  assert.equal(h.find("p", props => props.role === "alert").props.children, "La cuenta cambió; actualiza la lista");
  h.find("Button", props => props.children === "Actualizar lista").props.onClick(); await tick();
  assert.equal(h.find("Input", props => props.maxLength === 120).props.value, "Nombre vigente");
  h.submit();
  assert.equal(h.writes[1].body.expectedUpdatedAt, "2026-10-28T16:00:00.000Z");
});

test("error de carga no se presenta como lista vacía; un resultado vacío sí informa ausencia", () => {
  const failed = harness({ accounts: [], loadError: "No se pudo cargar" });
  assert.equal(failed.find("p", props => props.role === "alert").props.children, "No se pudo cargar");
  assert.equal(failed.find("EmptyState"), undefined);
  assert.ok(harness({ accounts: [] }).find("EmptyState"));
});
