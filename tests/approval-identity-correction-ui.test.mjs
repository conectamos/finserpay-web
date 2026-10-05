import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

test("la corrección de identidad exige evidencia, conserva el apellido verificado y espera una nueva firma", async () => {
  const source = readFileSync(new URL("../app/dashboard/aprobaciones/approval-operations.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const components = Object.fromEntries(["Badge", "Button", "Card", "Input", "LoadingState", "Select", "StatusPill"]
    .map(name => [name, Object.defineProperty(() => null, "name", { value: name })]));
  const ConfirmDialog = () => null;
  const node = (type, props) => ({ type, props });
  const slots = [];
  const scheduledEffects = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }];
    },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies?.some((value, position) => !Object.is(value, previous.dependencies?.[position]))) {
        previous?.cleanup?.();
        const slot = { dependencies, cleanup: null };
        slots[index] = slot;
        scheduledEffects.push(() => { slot.cleanup = effect(); });
      }
    },
  };
  const draft = {
    kind: "DRAFT", id: 12, number: "B-12", clientName: "NOMBRE INCORRECTO APELLIDO",
    document: "1111111111", phone: "3001234567", email: "cliente@example.com",
    status: "EN_FIRMA", equipment: "iPhone", imei: "111111111111111", updatedAt: "2026-10-05T12:00:00Z", timeline: [],
    signature: { status: "SIGNED", rawStatus: "COMPLETED", processUuid: "original-signed-process",
      sentPhone: "3001234567", sentEmail: "cliente@example.com", sentAt: null, signedAt: "2026-10-05T12:00:00Z" },
    enrollmentReviewId: null, requiresEnrollmentReapproval: false, pendingVersion: null,
    replacement: null, remission: null,
    capabilities: { preSettlementApprovalCreditId: null, canChangeImei: false,
      canDispatchSignatureWithImei: false, canFinalizeImei: false, canConfirmReplacement: false,
      canUpdateContact: false, canSendSignature: false, canResendSignature: false, reason: null },
  };
  const info = {
    ok: true, draftId: draft.id, clienteNombre: draft.clientName, clienteDocumento: draft.document,
    clientePrimerNombre: "NOMBRE INCORRECTO", clientePrimerApellido: "APELLIDO",
    clienteSegundoApellido: "", expectedProcessUuid: "original-signed-process", canCorrect: true,
    reason: null, availableEvidenceTypes: ["CEDULA"],
  };
  let correction = null;
  const attempts = [];
  let nextKey = 0;
  let gateReads = 0;
  const response = value => ({ ok: true, json: async () => value });
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, AbortController, Intl, Date,
    crypto: { randomUUID: () => `correction-key-${++nextKey}` },
    fetch: async (url, init) => {
      if (url.startsWith("/api/aprobaciones/operativo?q=")) return response({ ok: true, items: [draft] });
      if (url === "/api/aprobaciones/operativo/draft/12") return response({ ok: true, item: draft });
      if (url === "/api/creditos/borradores/12/corregir-identidad" && init?.method === "POST") {
        correction = JSON.parse(init.body);
        attempts.push(correction);
        if (attempts.length < 3) return response({ ok: false, error: "No se pudo confirmar el resultado." });
        draft.clientName = "NOMBRES APELLIDO SEGUNDO";
        draft.signature = { ...draft.signature, status: "NOT_SENT", processUuid: null, signedAt: null };
        draft.capabilities.canResendSignature = true;
        return response({ ok: true, correctionId: "correction-1", clienteNombre: draft.clientName, requiresNewSignature: true });
      }
      if (url === "/api/creditos/borradores/12/corregir-identidad") {
        gateReads++;
        return response(info);
      }
      throw new Error("Unexpected request: " + url);
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node, Fragment: "fragment" };
      if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (name === "@/app/_components/finser-ui") return components;
      if (name === "@/app/_components/finser-confirm-dialog") return { default: ConfirmDialog };
      if (name === "./approval-operations.module.css") return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error("Unexpected import: " + name);
    },
  });
  const render = () => {
    cursor = 0;
    const tree = loaded.exports.default({});
    for (const effect of scheduledEffects.splice(0)) effect();
    return tree;
  };
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] :
    [value, ...nodes(value.props?.children)];
  const textOf = value => Array.isArray(value) ? value.map(textOf).join(" ") : typeof value === "string" ? value :
    value && typeof value === "object" ? textOf(value.props?.children) : "";
  const find = (tree, predicate) => nodes(tree).find(predicate);
  const button = (tree, label) => find(tree, item => item.type === components.Button && textOf(item.props.children).includes(label));
  const input = (tree, id) => find(tree, item => item.type === components.Input && item.props.id === id);

  let tree = render();
  input(tree, "approval-operations-search").props.onChange({ target: { value: draft.number } });
  tree = render();
  await find(tree, item => item.type === "form" && item.props.role === "search")
    .props.onSubmit({ preventDefault() {} });
  await setImmediate();
  tree = render();
  assert.equal(button(tree, "Corregir identidad"), undefined, "la acción espera la elegibilidad del servidor");
  await setImmediate();
  tree = render();
  assert.equal(gateReads, 1);
  assert.ok(button(tree, "Corregir identidad"));
  button(tree, "Corregir identidad").props.onClick();
  tree = render();
  assert.equal(input(tree, "approval-identity-first-surname").props.readOnly, true);
  assert.equal(input(tree, "approval-identity-first-surname").props.value, "APELLIDO");
  assert.equal(button(tree, "Guardar corrección y preparar nueva firma").props.disabled, true);

  input(tree, "approval-identity-first-names").props.onChange({ target: { value: "NOMBRES" } });
  input(tree, "approval-identity-second-surname").props.onChange({ target: { value: "SEGUNDO" } });
  input(tree, "approval-identity-reason").props.onChange({ target: { value: "Error en nombre del contrato firmado" } });
  tree = render();
  assert.equal(button(tree, "Guardar corrección y preparar nueva firma").props.disabled, true,
    "la declaración de verificación es obligatoria");
  find(tree, item => item.type === "input" && item.props.id === "approval-identity-attestation")
    .props.onChange({ target: { checked: true } });
  tree = render();
  assert.equal(button(tree, "Guardar corrección y preparar nueva firma").props.disabled, false);
  find(tree, item => item.type === "form" && item.props.className === "identityForm")
    .props.onSubmit({ preventDefault() {} });
  tree = render();
  const confirm = find(tree, item => item.type === ConfirmDialog && item.props.title === "Confirmar corrección de identidad");
  assert.match(confirm.props.description, /NOMBRES APELLIDO SEGUNDO/);
  assert.match(confirm.props.description, /firma actual se conservará/);
  await confirm.props.onConfirm();
  await setImmediate();
  tree = render();
  find(tree, item => item.type === "form" && item.props.className === "identityForm")
    .props.onSubmit({ preventDefault() {} });
  tree = render();
  await find(tree, item => item.type === ConfirmDialog && item.props.title === "Confirmar corrección de identidad")
    .props.onConfirm();
  await setImmediate();
  assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey,
    "un resultado incierto reusa la clave al reintentar exactamente el mismo cambio");
  tree = render();
  input(tree, "approval-identity-reason").props.onChange({ target: { value: "Nombre revisado nuevamente con cédula" } });
  tree = render();
  find(tree, item => item.type === "form" && item.props.className === "identityForm")
    .props.onSubmit({ preventDefault() {} });
  tree = render();
  await find(tree, item => item.type === ConfirmDialog && item.props.title === "Confirmar corrección de identidad")
    .props.onConfirm();
  await setImmediate();
  assert.notEqual(attempts[2].idempotencyKey, attempts[1].idempotencyKey,
    "editar el cambio tras un fallo requiere una nueva clave de idempotencia");
  assert.equal(correction.expectedCurrentName, info.clienteNombre);
  assert.equal(correction.expectedProcessUuid, info.expectedProcessUuid);
  assert.equal(correction.firstNames, "NOMBRES");
  assert.equal(correction.secondSurname, "SEGUNDO");
  assert.equal(correction.evidenceType, "CEDULA");
  assert.equal(correction.attestation, true);
  assert.equal(correction.idempotencyKey, "correction-key-2");
  assert.equal("firstSurname" in correction, false, "el apellido verificado no se envía como dato editable");
  tree = render();
  assert.equal(button(tree, "Corregir identidad"), undefined);
  assert.ok(button(tree, "Reenviar firma"), "la corrección lleva al envío de la nueva firma");
  assert.equal(draft.signature.status, "NOT_SENT", "la corrección no simula que el nuevo contrato esté firmado");
});
