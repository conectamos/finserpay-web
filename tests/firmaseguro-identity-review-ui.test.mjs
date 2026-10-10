import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/creditos/firma-seguro-identity-review.tsx", import.meta.url), "utf8");
const consoleSource = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const fullName = "María del Mar De la Peña Muñoz del Río";
const baseProps = { canAdmin: true, draftId: 2887, fullName, documentNumber: "1110477922", validationId: 42, veriffApproved: true, onSaved() {} };
const baseItem = { draftId: 2887, canReview: true, canSave: true, eligible: true, canonicalFullName: fullName, documentNumber: "1110477922", validationId: 42, assessmentId: "test-assessment", lockedFirstSurname: "",
  providerComponents: { names: "", firstSurname: "", secondSurname: "" }, review: null, reason: null };
function fixture(props = baseProps) {
  const states = []; const refs = []; const effectDeps = []; const cleanups = []; const requests = []; const saved = [];
  let stateIndex = 0; let refIndex = 0; let effectIndex = 0; let effects = []; let timerId = 0; let time = 0; const timers = new Map();
  const React = { useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useEffect(callback, deps) { const index = effectIndex++; const before = effectDeps[index]; if (!before || deps.some((value, i) => value !== before[i])) { effectDeps[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = callback(); }); } } };
  let transport = async (_url, options) => options.method === "POST" ? { ok: true, item: { ...baseItem, canSave: false, review: { id: "review-id", source: "AUTHORIZED_REVIEW", ...JSON.parse(options.body), actorName: "Administrador", createdAt: "2026-10-10T03:00:00Z" } } } : { ok: true, item: baseItem };
  const context = { module: { exports: {} }, Error, Date, AbortController, JSON, setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: time + delay }); return id; }, clearTimeout(id) { timers.delete(id); }, crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    fetch: async (url, options = {}) => { requests.push({ url, method: options.method || "GET", body: options.body && JSON.parse(options.body), signal: options.signal }); const result = await transport(url, options); return { ok: result.ok !== false, status: result.status || 200, json: async () => result }; },
    require(name) { if (name === "react") return React; if (name === "react/jsx-runtime") return jsxRuntime; if (name.endsWith("finser-ui")) return { Button: "button", Input: "input" }; if (name.endsWith("finser-side-panel")) return { __esModule: true, default: "aside" }; assert.fail(name); } };
  context.exports = context.module.exports;
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, context);
  const functions = context.module.exports;
  let currentProps = { ...props, onSaved: message => saved.push(message) };
  const render = () => {
    stateIndex = 0; refIndex = 0; effectIndex = 0; const element = functions.default(currentProps); const pending = effects; effects = []; pending.forEach(effect => effect()); return element;
  };
  render();
  return { functions, requests, saved, render, pendingTimers: () => timers.size, async advance(ms) { time += ms; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.callback(); } await flush(); }, setTransport(value) { transport = value; }, updateProps(value) { currentProps = { ...currentProps, ...value }; render(); }, unmount() { cleanups.forEach(cleanup => cleanup?.()); } };
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  const children = node.props?.children;
  return (Array.isArray(children) ? children.flat(Infinity) : [children]).map(child => find(child, predicate)).find(Boolean) || null;
}
const text = node => typeof node === "string" ? node : !node || typeof node !== "object" ? "" : (Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).map(text).join(" ");
const button = (tree, label) => find(tree, node => node.type === "button" && text(node).includes(label));
function inputFor(tree, label) { return find(find(tree, node => node.type === "label" && text(node).startsWith(label)), node => node.type === "input" || node.type === "textarea"); }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function open(f) { button(f.render(), "Revisar datos para firma").props.onClick(); await flush(); return f.render(); }
function fill(f, updates) { for (const [label, value] of updates) inputFor(f.render(), label).props.onChange({ target: { value } }); }

test("el asesor sólo ve la solicitud de revisión y no puede abrir ni guardar componentes", () => {
  const f = fixture({ ...baseProps, canAdmin: false }); const tree = f.render();
  assert.ok(text(tree).includes("El asesor no puede editar el primer apellido"));
  assert.equal(button(tree, "Revisar datos para firma"), null); assert.equal(f.requests.length, 0);
  assert.equal(f.functions.canSaveFirmaSeguroIdentityReview(baseItem, { firstNames: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz del Río", reason: "Documento revisado", attestation: true }, { ...baseProps, canAdmin: false }), false);
});

test("sólo el GET autorizado de la misma solicitud, CC y última Veriff abre el formulario, sin separar el nombre", async () => {
  const f = fixture(); const tree = await open(f);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, "GET");
  assert.equal(f.requests[0].url, "/api/creditos/borradores/2887/identidad-firma");
  assert.equal(find(tree, node => node.type === "aside").props.open, true);
  assert.equal(inputFor(tree, "Nombres y apellidos de DataCrédito").props.value, fullName);
  assert.equal(inputFor(tree, "Nombres y apellidos de DataCrédito").props.readOnly, true);
  assert.equal(inputFor(tree, "Cédula consultada").props.value, "1110477922");
  for (const field of ["Nombre(s)", "Primer apellido", "Segundo apellido"]) assert.equal(inputFor(tree, field).props.value, "");
  assert.equal(button(tree, "Guardar revisión autorizada").props.disabled, true);
  for (const changed of [{ draftId: 9999 }, { documentNumber: "987654321" }, { validationId: 41 }, { canonicalFullName: "Otra persona" }, { canReview: false }]) {
    const denied = fixture(); denied.setTransport(async () => ({ ok: true, item: { ...baseItem, ...changed } }));
    const deniedTree = await open(denied); assert.equal(find(deniedTree, node => node.type === "aside").props.open, false); assert.ok(text(deniedTree).includes("no corresponde"));
  }
});

test("componentes manuales compuestos deben coincidir con el nombre completo, respetar proveedor y admitir segundo vacío", async () => {
  const f = fixture(); let tree = await open(f);
  fill(f, [["Nombre(s)", "María del Mar"], ["Primer apellido", "De la Peña"], ["Segundo apellido", "Muñoz del Río"], ["Motivo", "Documento contrastado"]]);
  find(f.render(), node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  tree = f.render(); assert.equal(button(tree, "Guardar revisión autorizada").props.disabled, false);
  const values = { firstNames: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz del Río", reason: "Documento revisado", attestation: true };
  assert.equal(f.functions.canSaveFirmaSeguroIdentityReview(baseItem, { ...values, firstNames: "Maria del Mar" }, baseProps), false);
  assert.equal(f.functions.canSaveFirmaSeguroIdentityReview(baseItem, values, { ...baseProps, veriffApproved: false }), false);
  assert.equal(f.functions.canSaveFirmaSeguroIdentityReview({ ...baseItem, canSave: false }, values, baseProps), false);
  assert.equal(f.functions.canSaveFirmaSeguroIdentityReview({ ...baseItem, providerComponents: { names: "", firstSurname: "Otro apellido", secondSurname: "" } }, values, baseProps), false);
  assert.equal(f.functions.canSaveFirmaSeguroIdentityReview({ ...baseItem, canonicalFullName: "María del Mar De la Peña" }, { ...values, secondSurname: "" }, { ...baseProps, fullName: "María del Mar De la Peña" }), true);
  const provided = fixture(); provided.setTransport(async () => ({ ok: true, item: { ...baseItem, providerComponents: { names: "", firstSurname: "De la Peña", secondSurname: "" } } }));
  const providedTree = await open(provided); assert.equal(inputFor(providedTree, "Primer apellido").props.readOnly, true); assert.equal(inputFor(providedTree, "Primer apellido").props.value, "De la Peña");
});

test("el apellido de una revisión previa permanece bloqueado aunque cambie la validación y no se admita puntuación ajena al contrato", async () => {
  const item = { ...baseItem, lockedFirstSurname: "De la Peña" };
  const f = fixture(); f.setTransport(async () => ({ ok: true, item })); const tree = await open(f);
  assert.equal(inputFor(tree, "Primer apellido").props.value, "De la Peña");
  assert.equal(inputFor(tree, "Primer apellido").props.readOnly, true);
  assert.ok(text(tree).includes("Dato ya registrado; permanece bloqueado."));
  const values = { firstNames: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz del Río", reason: "Documento revisado", attestation: true };
  assert.equal(f.functions.canSaveFirmaSeguroIdentityReview(item, { ...values, firstSurname: "De la Peña Muñoz", secondSurname: "del Río" }, baseProps), false);
  assert.equal(f.functions.canSaveFirmaSeguroIdentityReview({ ...baseItem, canonicalFullName: "María. De la Peña" }, { ...values, firstNames: "María.", secondSurname: "" }, { ...baseProps, fullName: "María. De la Peña" }), false);
  for (const documentNumber of ["123", "1234567890123"]) assert.equal(f.functions.firmaSeguroReviewMatchesContext({ ...baseItem, documentNumber }, { ...baseProps, documentNumber }), true);
  for (const documentNumber of ["12", "12345678901234"]) assert.equal(f.functions.firmaSeguroReviewMatchesContext({ ...baseItem, documentNumber }, { ...baseProps, documentNumber }), false);
});

test("guardar revisión envía sólo metadata auditada y nunca firma, consulta DataCrédito o sesión Veriff", async () => {
  const f = fixture(); await open(f);
  fill(f, [["Nombre(s)", "María del Mar"], ["Primer apellido", "De la Peña"], ["Segundo apellido", "Muñoz del Río"], ["Motivo", "Documento contrastado"]]);
  find(f.render(), node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  await find(f.render(), node => node.type === "form").props.onSubmit({ preventDefault() {} }); await flush();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].method, "POST"); assert.equal(f.requests[1].url, f.requests[0].url);
  assert.deepEqual(Object.keys(f.requests[1].body).sort(), ["firstNames", "firstSurname", "secondSurname", "reason", "attestation", "expectedValidationId", "expectedCanonicalFullName", "idempotencyKey"].sort());
  assert.equal(f.requests[1].body.expectedCanonicalFullName, fullName); assert.equal(f.requests[1].body.firstSurname, "De la Peña");
  assert.equal(f.saved.length, 1); assert.ok(f.saved[0].includes("Usa Enviar contrato"));
  assert.equal(find(f.render(), node => node.type === "aside").props.open, false);
  assert.equal(f.requests.some(request => /datacredito|veriff|\/firma-seguro$/.test(request.url)), false);
});

test("errores de revisión conservan código y valores y una respuesta de otro contexto no se aplica", async () => {
  const f = fixture(); await open(f);
  fill(f, [["Nombre(s)", "María del Mar"], ["Primer apellido", "De la Peña"], ["Segundo apellido", "Muñoz del Río"], ["Motivo", "Documento contrastado"]]);
  find(f.render(), node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  f.setTransport(async () => ({ ok: false, status: 409, code: "VERIFF_CHANGED", error: "La validación cambió." }));
  await find(f.render(), node => node.type === "form").props.onSubmit({ preventDefault() {} }); await flush();
  assert.ok(text(f.render()).includes("Código: VERIFF_CHANGED.")); assert.equal(inputFor(f.render(), "Primer apellido").props.value, "De la Peña");
  assert.equal(f.saved.length, 0);
  let complete; const stale = fixture(); stale.setTransport(() => new Promise(resolve => { complete = resolve; }));
  button(stale.render(), "Revisar datos para firma").props.onClick(); stale.updateProps({ draftId: 9999 });
  complete({ ok: true, item: baseItem }); await flush();
  assert.equal(find(stale.render(), node => node.type === "aside").props.open, false);
  assert.equal(stale.requests[0].signal.aborted, true);
  let finishPermission; const revoked = fixture(); revoked.setTransport(() => new Promise(resolve => { finishPermission = resolve; }));
  button(revoked.render(), "Revisar datos para firma").props.onClick(); revoked.updateProps({ canAdmin: false });
  finishPermission({ ok: true, item: baseItem }); await flush();
  assert.equal(find(revoked.render(), node => node.type === "aside").props.open, false);
  assert.equal(revoked.requests[0].signal.aborted, true);
});

test("una red colgada agota 20 segundos, desbloquea cierre y permite reintento manual con la misma operación", async () => {
  const get = fixture(); get.setTransport(() => new Promise(() => {}));
  button(get.render(), "Revisar datos para firma").props.onClick();
  assert.equal(button(get.render(), "Consultando").props.disabled, true);
  await get.advance(19_999); assert.equal(button(get.render(), "Consultando").props.disabled, true);
  await get.advance(1); let tree = get.render();
  assert.ok(text(tree).includes("La consulta de la revisión superó 20 segundos"));
  assert.equal(button(tree, "Revisar datos para firma").props.disabled, false);
  assert.equal(get.requests.length, 1); assert.equal(get.requests[0].signal.aborted, true); assert.equal(get.pendingTimers(), 0);
  get.setTransport(async () => ({ ok: true, item: baseItem })); await open(get); assert.equal(get.requests.length, 2);

  const post = fixture(); await open(post);
  fill(post, [["Nombre(s)", "María del Mar"], ["Primer apellido", "De la Peña"], ["Segundo apellido", "Muñoz del Río"], ["Motivo", "Documento contrastado"]]);
  find(post.render(), node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  post.setTransport(() => new Promise(() => {}));
  const pending = find(post.render(), node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(find(post.render(), node => node.type === "aside").props.busy, true);
  await post.advance(20_000); await pending; tree = post.render();
  assert.ok(text(tree).includes("No se confirmó el guardado en 20 segundos"));
  assert.equal(find(tree, node => node.type === "aside").props.busy, false);
  assert.equal(button(tree, "Cerrar").props.disabled, false);
  assert.equal(inputFor(tree, "Primer apellido").props.value, "De la Peña");
  assert.equal(inputFor(tree, "Motivo").props.value, "Documento contrastado");
  assert.equal(post.requests.length, 2); assert.equal(post.requests[1].signal.aborted, true); assert.equal(post.pendingTimers(), 0);
  const retryKey = post.requests[1].body.idempotencyKey;
  post.setTransport(async (_url, options) => ({ ok: true, item: { ...baseItem, canSave: false, review: { id: retryKey, source: "AUTHORIZED_REVIEW", ...JSON.parse(options.body), actorName: "Administrador", createdAt: "2026-10-10T03:00:00Z" } } }));
  await find(post.render(), node => node.type === "form").props.onSubmit({ preventDefault() {} }); await flush();
  assert.equal(post.requests.length, 3); assert.equal(post.requests[2].body.idempotencyKey, retryKey); assert.equal(post.saved.length, 1);
  assert.equal(post.requests.some(request => /datacredito|veriff|\/firma-seguro$/.test(request.url)), false); assert.equal(post.pendingTimers(), 0);

  get.setTransport(() => new Promise(() => {})); button(get.render(), "Revisar datos para firma").props.onClick();
  await get.advance(20_000); button(get.render(), "Cerrar").props.onClick();
  assert.equal(find(get.render(), node => node.type === "aside").props.open, false);
  const unmounted = fixture(); unmounted.setTransport(() => new Promise(() => {}));
  button(unmounted.render(), "Revisar datos para firma").props.onClick(); unmounted.unmount(); await flush();
  assert.equal(unmounted.requests[0].signal.aborted, true); assert.equal(unmounted.pendingTimers(), 0);
});

test("el envío conserva revisión y sólo el flujo legado avanza automáticamente tras firma", async () => {
  const ast = ts.createSourceFile("console.tsx", consoleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let submit; let handler;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "submitFirmaSeguroDraft") submit = node.initializer; if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleFirmaSeguroStepReady") handler = node.initializer; ts.forEachChild(node, visit); } visit(ast);
  const seen = []; const context = { Error, Object, resolvePersistedDraftStep: step => step,
    recoverEquipmentImeiConfirmation() { assert.fail("IMEI confirmado no requiere recuperación"); },
    setFirmaSeguroIdentityReviewDraftId: value => seen.push(value),
    CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE: "OUTDATED", formatFirmaSeguroApiFailure: value => value.error,
    requestJson: async () => ({ ok: false, data: { ok: false, code: "FIRMASEGURO_IDENTITY_COMPONENTS_REQUIRED", error: "Requiere revisión." } }) };
  const send = runInNewContext(ts.transpileModule("(" + submit.getText(ast) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await assert.rejects(() => send(2887), failure => failure.code === "FIRMASEGURO_IDENTITY_COMPONENTS_REQUIRED" && failure.message.includes("Código: FIRMASEGURO_IDENTITY_COMPONENTS_REQUIRED.")); assert.deepEqual(seen, [2887]);
  const recovered = [];
  const blockedSend = runInNewContext(ts.transpileModule("(" + submit.getText(ast) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { ...context, resolvePersistedDraftStep: () => 2, recoverEquipmentImeiConfirmation: id => recovered.push(id),
      requestJson() { assert.fail("Sin confirmación IMEI no puede intentar enviar FirmaSeguro"); } });
  await assert.rejects(() => blockedSend(2887), failure => failure.code === "IMEI_CONFIRMATION_REQUIRED");
  assert.deepEqual(recovered, [2887]);
  let branch;
  function findSigned(node) { if (ts.isIfStatement(node) && node.expression.getText(ast) === "signed && !createClientMode") branch = node; ts.forEachChild(node, findSigned); } findSigned(handler);
  assert.ok(branch, "Nueva venta debe esperar la continuación explícita del usuario");
  const calls = [];
  const contextForSigned = (createClientMode) => ({
    signed: true, createClientMode,
    correctionDraft: null, factoryDraftPayload: { clienteNombre: fullName }, currentDraftId: 2887, cancelPendingDraftAutosave() {}, setWizardStep: value => calls.push(value),
    saveDraftPayloadForVeriff: async (...args) => calls.push(args),
  });
  const signedBranch = ts.transpileModule("(async () => {" + branch.getText(ast) + "})()", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  await runInNewContext(signedBranch, contextForSigned(true));
  assert.equal(calls.length, 0, "Una firma confirmada no debe cambiar de pantalla en Nueva venta");
  await runInNewContext(signedBranch, contextForSigned(false));
  assert.equal(calls[0][0].clienteNombre, fullName); assert.equal(calls[0][3], "DELIVERY_EVIDENCE"); assert.equal(calls[1], 5);
});
