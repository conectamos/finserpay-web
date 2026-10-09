import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const base = new URL("../docs/integrations/dapta-welcome-voice/", import.meta.url);
const identity = JSON.parse(readFileSync(new URL("identity-flow.draft.json", base), "utf8"));
const call = JSON.parse(readFileSync(new URL("call-flow.draft.json", base), "utf8"));

function runCode(flow, nodeId, params) {
  const node = flow.api_nodes.find(candidate => candidate.id === nodeId);
  assert.equal(node?.api_action?.action_type, "code");
  const context = { params, module: { exports: {} } };
  runInNewContext(node.api_action.code_action.code, context, { timeout: 500 });
  return JSON.parse(JSON.stringify(context.module.exports));
}

const validIdentity = {
  event_token: "synthetic-event-token",
  customer_name: "Persona de Prueba",
  customer_document: "12345678",
};
const validCall = {
  event_id: "cce44e9a-3f06-4f1b-8c9f-88c9c1f9f931",
  credito_id: "42",
  event_token: "synthetic-event-token",
  to_number: "+573001234567",
};
const accepted = { ok: true, call_id: "call_123", code: null };
const failed = { ok: false, call_id: null, code: "NATIVE_CALL_ERROR" };
const unknown = { ok: false, call_id: null, code: "NATIVE_CALL_UNKNOWN" };

test("identity body JSON preserves quotes, slashes and allowed control characters without field injection", () => {
  const supplied = {
    ...validIdentity,
    customer_name: 'Ana "Prueba" \\ Pérez\nLínea\tDos\r"},"customer_document":"99999',
  };
  const output = runCode(identity, "nrmId", { trigger: { body: supplied } });
  const body = JSON.parse(output.request_body);
  assert.deepEqual(body, supplied);
  assert.deepEqual(Object.keys(body), ["event_token", "customer_name", "customer_document"]);
});

test("identity normalization rejects forbidden controls, missing values and excessive input", () => {
  for (const body of [
    { ...validIdentity, customer_name: "Ana\u0000Pérez" },
    { ...validIdentity, customer_document: "123\u001f456" },
    { ...validIdentity, event_token: "token\u007f" },
    { ...validIdentity, customer_name: "a".repeat(241) },
    { ...validIdentity, customer_document: "1".repeat(81) },
    { ...validIdentity, event_token: "a".repeat(1001) },
    { ...validIdentity, customer_document: 12345678 },
    { ...validIdentity, customer_name: " " },
    {},
  ]) {
    assert.throws(() => runCode(identity, "nrmId", { trigger: { body } }), /Solicitud de identidad invalida/);
  }
});

test("identity HTTP action sends only safe serialized JSON and no backend secret", () => {
  const api = identity.api_nodes.find(node => node.id === "qryId").api_action.external_api_action;
  assert.equal(api.request_type, "post");
  assert.equal(api.url, "https://finserpay.com/api/integraciones/dapta/bienvenida-voz/identidad");
  assert.equal(api.body, "{{normalizar_identidad.request_body}}");
  assert.deepEqual(api.headers, [{ key: "Content-Type", value: "application/json" }]);
  assert.equal(api.authorization.token, "");
});

test("identity success requires a conditions object and strict booleans", () => {
  const conditions = { monto: "1000", cuota: "100", frecuencia: "MENSUAL" };
  assert.deepEqual(runCode(identity, "chkId", {
    verificar_identidad: { ok: true, verificado: true, condiciones: conditions },
  }), { ok: true, verificado: true, condiciones: conditions, code: null });
  for (const condiciones of [undefined, null, "conditions", []]) {
    assert.deepEqual(runCode(identity, "chkId", {
      verificar_identidad: { ok: true, verificado: true, condiciones },
    }), { ok: false, verificado: false, condiciones: null, code: "IDENTITY_UNAVAILABLE" });
  }
  for (const ok of [false, "true", undefined]) {
    assert.deepEqual(runCode(identity, "chkId", {
      verificar_identidad: { ok, verificado: true, condiciones: conditions },
    }), { ok: false, verificado: false, condiciones: null, code: "IDENTITY_UNAVAILABLE" });
  }
});

test("identity mismatch never exposes supplied conditions", () => {
  for (const verificado of [false, "true", undefined]) {
    assert.deepEqual(runCode(identity, "chkId", {
      verificar_identidad: { ok: true, verificado, condiciones: { monto: "confidential" } },
    }), { ok: true, verificado: false, condiciones: null, code: null });
  }
});

test("call inputs preserve the scoped token and reject an unsafe destination or identifier", () => {
  assert.deepEqual(runCode(call, "nrmCl", { trigger: { body: validCall } }), validCall);
  for (const body of [
    { ...validCall, to_number: "+573001234567\n" },
    { ...validCall, to_number: "+18005550123" },
    { ...validCall, to_number: "573001234567" },
    { ...validCall, credito_id: "0" },
    { ...validCall, credito_id: "42;drop" },
    { ...validCall, event_id: "not-a-uuid" },
    { ...validCall, event_token: 123 },
  ]) {
    assert.throws(() => runCode(call, "nrmCl", { trigger: { body } }), /Solicitud de llamada invalida/);
  }
});

for (const [name, native] of [
  ["direct native receipt", { response: { call_id: "call_123" } }],
  ["wrapped native receipt", { response: { response: { result: { call_id: "call_123" } } } }],
  ["JSON encoded native receipt", { response: JSON.stringify({ data: { call_id: "call_123" } }) }],
  ["empty native error collections", { response: { call_id: "call_123", errors: [] }, error: {} }],
]) {
  test(name + " exports a boolean acceptance", () => {
    const receipt = runCode(call, "chkCl", { llamada_bienvenida: native });
    assert.deepEqual(receipt, accepted);
    assert.equal(typeof receipt.ok, "boolean");
  });
}

for (const [name, native] of [
  ["top-level ok false", { ok: false, response: { call_id: "call_123" } }],
  ["top-level success false", { success: false, response: { call_id: "call_123" } }],
  ["native error sibling", { error: "provider-error", response: { call_id: "call_123" } }],
  ["error alongside nested receipt", { response: { response: { call_id: "call_123" }, error: "provider-error" } }],
  ["alternate result branch error", { response: { call_id: "call_123", result: { success: false } } }],
  ["alternate data branch error", { response: { call_id: "call_123", data: { error: { code: "REJECTED" } } } }],
  ["JSON encoded error sibling", { response: { call_id: "call_123", data: JSON.stringify({ ok: false }) } }],
  ["nested errors array", { response: { call_id: "call_123", errors: [{ message: "rejected" }] } }],
  ["node errors sibling", { response: { call_id: "call_123" }, node_errors: [{ error: true }] }],
  ["false flag inside an array", { response: { call_id: "call_123", steps: [{ ok: false }] } }],
  ["failed status", { response: { call_id: "call_123", status: "failed" } }],
  ["conflicting status fields", { response: { call_id: "call_123", call_status: "queued", status: "failed" } }],
]) {
  test(name + " overrides a valid call identifier", () => {
    assert.deepEqual(runCode(call, "chkCl", { llamada_bienvenida: native }), failed);
  });
}

for (const [name, native] of [
  ["HTTP 200 without native receipt", { response: { ok: true } }],
  ["missing native result", {}],
  ["malformed native JSON", { response: "{" }],
  ["array result", { response: [{ call_id: "call_123" }] }],
  ["invalid call identifier", { response: { call_id: "call 123" } }],
  ["numeric call identifier", { response: { call_id: 123 } }],
]) {
  test(name + " remains unknown", () => {
    assert.deepEqual(runCode(call, "chkCl", { llamada_bienvenida: native }), unknown);
  });
}

test("receipt traversal fails closed for cyclic or excessively deep contradictory structures", () => {
  const cyclic = { call_id: "call_123" };
  cyclic.data = cyclic;
  assert.deepEqual(runCode(call, "chkCl", { llamada_bienvenida: { response: cyclic } }), failed);
  let deep = { ok: false };
  for (let i = 0; i < 15; i++) deep = { data: deep };
  assert.deepEqual(runCode(call, "chkCl", { llamada_bienvenida: { response: { call_id: "call_123", data: deep } } }), failed);
});

test("HTTP response maps exported booleans without a literal true string", () => {
  for (const [flow, responseId, reference] of [
    [identity, "rspId", "{{preparar_respuesta_identidad.ok}}"],
    [call, "rspCl", "{{confirmar_recepcion.ok}}"],
  ]) {
    const terminal = flow.api_nodes.find(node => node.id === responseId);
    assert.equal(terminal.type, "response");
    assert.equal(terminal.api_response.response_params.find(field => field.key === "ok").value, reference);
  }
  // This asserts the checked-in mapping; only a Dapta runtime response can prove its type-preserving interpolation.
});

test("native draft retains the template and scoped variables with credentials redacted", () => {
  const native = call.api_nodes.find(node => node.id === "natCl");
  assert.equal(native.template_id, "a9bb5e23-e7f9-4f16-b382-5e062db2b10c");
  assert.equal(native.api_action.action_type, "custom.dapta_phonecall");
  assert.equal(native.api_action.custom_action.values.agent_id, "NEW_WELCOME_VOICE_AGENT_UUID");
  assert.equal(native.api_action.custom_action.values.from_number, "+573124085562");
  assert.deepEqual(native.api_action.custom_action.values.variables, [
    { key: "event_id", value: "{{normalizar_llamada.event_id}}" },
    { key: "credito_id", value: "{{normalizar_llamada.credito_id}}" },
    { key: "event_token", value: "{{normalizar_llamada.event_token}}" },
  ]);
  for (const text of [JSON.stringify(identity), JSON.stringify(call)]) {
    assert.doesNotMatch(text, /x-api-key[=:%]|Authorization[=:]/i);
    assert.doesNotMatch(text, /https:\/\/[^"\s]+[?&](?:token|api_key|key|x-api-key)=/i);
  }
  assert.equal((JSON.stringify(call).match(/__REHYDRATE_DAPTA_NATIVE_TEMPLATE_URL__/g) || []).length, 4);
});
