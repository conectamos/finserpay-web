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
const validSpeech = {
  initialPayment: "cero pesos",
  installmentAmount: "ciento cincuenta y nueve mil ciento cincuenta pesos",
  installmentCount: "dieciocho cuotas quincenales",
  firstDueDate: "diecisiete de octubre de dos mil veintiséis",
  installmentAmounts: Array.from({ length: 18 }, () => "ciento cincuenta y nueve mil ciento cincuenta pesos"),
};
const validConditions = { initialPayment: 0, installmentAmount: 159150, installmentCount: 18, speech: validSpeech };
const validCall = {
  event_id: "cce44e9a-3f06-4f1b-8c9f-88c9c1f9f931",
  credito_id: "42",
  event_token: "synthetic-event-token",
  to_number: "+573001234567",
  customer_name: "Persona de Prueba",
  customer_document: "12345678",
  customer_name_spoken: "Persona de Prueba",
  customer_document_spoken: "doce; trescientos cuarenta y cinco; seiscientos setenta y ocho",
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

test("voice tool args envelope serializes only the identity fields", () => {
  const supplied = {
    ...validIdentity,
    customer_name: 'Ana "Prueba" \\ Pérez\nDos\tTres',
  };
  const output = runCode(identity, "nrmId", {
    trigger: { body: { args: { ...supplied, dapta_api_id: "synthetic-flow", dapta_webhook: "ignored" }, call: { id: "synthetic-call" } } },
  });
  assert.deepEqual(JSON.parse(output.request_body), supplied);
});

test("identity envelope rejects malformed args and mixed locations instead of falling back", () => {
  for (const body of [
    undefined, null, [], "not-json",
    { args: null }, { args: [] }, { args: "not-json" }, { args: false },
    { ...validIdentity, args: null },
    { ...validIdentity, args: { ...validIdentity } },
    { event_token: validIdentity.event_token, args: { customer_name: validIdentity.customer_name, customer_document: validIdentity.customer_document } },
  ]) {
    assert.throws(() => runCode(identity, "nrmId", { trigger: { body } }), /Solicitud de identidad invalida/);
  }
});

test("direct and args identity bodies require their own valid token", () => {
  for (const wrap of [body => body, body => ({ args: body })]) {
    for (const token of [undefined, null, 123, "", " ", "token\u0000", "a".repeat(1001)]) {
      assert.throws(() => runCode(identity, "nrmId", {
        trigger: { body: wrap({ ...validIdentity, event_token: token }) },
      }), /Solicitud de identidad invalida/);
    }
  }
});

test("identity response remains strict boolean after args normalization and has no invented conditions fallback", () => {
  const normalized = runCode(identity, "nrmId", { trigger: { body: { args: validIdentity } } });
  assert.deepEqual(JSON.parse(normalized.request_body), validIdentity);
  for (const response of [
    undefined, {}, { ok: false }, { ok: "true", verificado: true },
    { ok: true, verificado: true, condiciones: null },
  ]) {
    const result = runCode(identity, "chkId", {
      verificar_identidad: response,
      invented_conditions: { monto: "999999", cuota: "1" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.verificado, false);
    assert.equal(result.condiciones, null);
    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.verificado, "boolean");
  }
});

test("identity speech patch changes only the live verified response Code field", () => {
  const patch = JSON.parse(readFileSync(new URL("identity-normalizer.patch.json", base), "utf8"));
  assert.equal(patch.flow_id, "YxVoY");
  assert.match(patch.expected_content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(patch.ops.length, 1);
  assert.deepEqual(
    { op: patch.ops[0].op, node_id: patch.ops[0].node_id, path: patch.ops[0].path },
    { op: "set_param", node_id: "chkId", path: "api_action.code_action.code" },
  );
  assert.equal(patch.ops[0].value, identity.api_nodes.find(node => node.id === "chkId").api_action.code_action.code);
  assert.doesNotMatch(JSON.stringify(patch), /https:\/\/|x-api-key|previewToken|preview_token/);
  assert.equal(identity.api_nodes.find(node => node.id === "nrmId").api_action.on_error, "stop");
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
  const conditions = validConditions;
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

test("identity reply rejects raw-only conditions or incomplete spoken financial fields", () => {
  const rawOnly = { initialPayment: 0, installmentAmount: 159150, installmentCount: 18, firstDueDate: "2026-10-17" };
  const invalid = [
    { ...rawOnly },
    { ...validConditions, speech: null },
    { ...validConditions, speech: [] },
    { ...validConditions, speech: "words" },
    { ...validConditions, speech: { ...validSpeech, installmentAmounts: [] } },
    { ...validConditions, speech: { ...validSpeech, installmentAmounts: [""] } },
    { ...validConditions, speech: { ...validSpeech, installmentAmounts: [159150] } },
  ];
  for (const key of ["initialPayment", "installmentAmount", "installmentCount", "firstDueDate"]) {
    for (const value of [undefined, null, 159150, "", " ", [], {}]) {
      invalid.push({ ...validConditions, speech: { ...validSpeech, [key]: value } });
    }
  }
  for (const condiciones of invalid) {
    assert.deepEqual(runCode(identity, "chkId", {
      verificar_identidad: { ok: true, verificado: true, condiciones },
      invented_conditions: { speech: validSpeech },
    }), { ok: false, verificado: false, condiciones: null, code: "IDENTITY_UNAVAILABLE" });
  }
});

test("identity reply preserves exact backend speech without converting raw amounts", () => {
  const result = runCode(identity, "chkId", {
    verificar_identidad: { ok: true, verificado: true, condiciones: validConditions },
  });
  assert.equal(result.ok, true);
  assert.equal(result.verificado, true);
  assert.equal(result.condiciones.installmentAmount, 159150);
  assert.equal(result.condiciones.speech.installmentAmount, "ciento cincuenta y nueve mil ciento cincuenta pesos");
  assert.equal(result.condiciones.speech.installmentCount, "dieciocho cuotas quincenales");
  assert.equal(result.condiciones.speech.firstDueDate, "diecisiete de octubre de dos mil veintiséis");
  assert.deepEqual(result.condiciones.speech.installmentAmounts, validSpeech.installmentAmounts);
});

test("call preserves prepared document blocks and the zero-preserving raw document", () => {
  const supplied = { ...validCall, customer_document: "00123456", customer_document_spoken: "cero cero; ciento veintitrés; cuatrocientos cincuenta y seis" };
  const normalized = runCode(call, "nrmCl", { trigger: { body: supplied } });
  assert.equal(normalized.customer_document, "00123456");
  assert.equal(normalized.customer_document_spoken, supplied.customer_document_spoken);
  for (const key of ["customer_name_spoken", "customer_document_spoken"]) {
    for (const invalid of [undefined, null, 123, "", " ", [], {}, "value\n", "value\u0000", "a".repeat(241)]) {
      assert.throws(() => runCode(call, "nrmCl", {
        trigger: { body: { ...validCall, [key]: invalid } },
      }), /Solicitud de llamada invalida/);
    }
  }
});

test("voice tool retains raw identity constants while the prompt requires literal speech and consent", () => {
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  const prompt = readFileSync(new URL("agent-instructions.txt", base), "utf8");
  const tool = config.pendingIdentityTool;
  assert.match(tool.parameters.properties.customer_name.description, /\{\{customer_name\}\}/);
  assert.match(tool.parameters.properties.customer_document.description, /\{\{customer_document\}\}/);
  assert.doesNotMatch(tool.parameters.properties.customer_document.description, /\{\{customer_document_spoken\}\}/);
  assert.equal(tool.parameters.properties.dapta_webhook.const, "NEW_PRIVATE_IDENTITY_FLOW_URL");
  assert.equal(tool.parameters.properties.dapta_api_id.const, "NEW_IDENTITY_FLOW_ID");
  for (const param of Object.values(tool.parameters.properties)) assert.equal(param.type, "string");
  assert.equal(config.updateAfterCreate.begin_message, "Hola, soy Sofía de FINSER PAY. Esta llamada se graba para confirmar su crédito. ¿Podemos continuar?");
  for (const affirmative of ["sí", "ok", "vale", "claro", "de acuerdo"]) assert.ok(prompt.includes("«" + affirmative + "»"));
  for (const field of ["initialPayment", "installmentAmount", "installmentCount", "firstDueDate"]) {
    assert.ok(prompt.includes("[speech." + field + "]"));
    assert.ok(!prompt.includes("[" + field + "]"));
  }
  assert.ok(prompt.includes("customer_name_spoken") && prompt.includes("customer_document_spoken"));
  assert.match(prompt, /speech incompleto/);
  assert.match(prompt, /sin decir ningún importe o fecha/);
  assert.match(prompt, /calendar confirma/);
  assert.match(prompt, /el sistema genera un bloqueo/);
  assert.doesNotMatch(prompt, /<\s*(?:speak|break|say-as|prosody)\b/i);
});

test("voice configuration uses conversational multilingual delivery without changing the voice", () => {
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  assert.equal(config.updateAfterCreate.voice_speed, 1);
  assert.equal(config.updateAfterCreate.voice_temperature, 1);
  assert.equal(config.updateAfterCreate.normalize_for_speech, true);
  assert.equal(config.createArguments.voice_language, "es-419");
  assert.equal(config.createArguments.voice, "custom_voice_fd6d90e0e756bbb2e81c101bba");
  assert.equal(config.updateAfterCreate.voice_model, "eleven_multilingual_v2");
});


test("optional equipment speech is preserved only inside verified conditions", () => {
  for (const equipmentReference of [undefined, null, "Equipo de prueba de ciento veintiocho gigabytes"]) {
    const speech = { ...validSpeech };
    if (equipmentReference !== undefined) speech.equipmentReference = equipmentReference;
    const condiciones = { ...validConditions, speech };
    const verified = runCode(identity, "chkId", {
      verificar_identidad: { ok: true, verificado: true, condiciones },
    });
    assert.equal(verified.verificado, true);
    assert.deepEqual(verified.condiciones, condiciones);
    for (const result of [
      { ok: false, verificado: true, condiciones },
      { ok: true, verificado: false, condiciones },
    ]) {
      const blocked = runCode(identity, "chkId", { verificar_identidad: result });
      assert.equal(blocked.verificado, false);
      assert.equal(blocked.condiciones, null);
    }
  }
});

test("equipment reference guard precedes the plan and handles missing data or discrepancies", () => {
  const prompt = readFileSync(new URL("agent-instructions.txt", base), "utf8");
  const referenceAt = prompt.indexOf("REFERENCIA DEL CELULAR");
  const planAt = prompt.indexOf("PLAN Y CONFIRMACIÓN DE LA PRIMERA CUOTA");
  assert.ok(referenceAt > 0 && referenceAt < planAt);
  const reference = prompt.slice(referenceAt, planAt);
  for (const guard of ["ok=true", "verificado=true", "condiciones.speech completo"]) assert.ok(reference.includes(guard));
  assert.ok(reference.includes("[speech.equipmentReference]"));
  assert.match(reference, /referencia exacta/);
  assert.match(reference, /equipmentReference falta, es null o está vacío/);
  assert.match(reference, /no adivines/);
  assert.match(reference, /Si el cliente señala una diferencia/);
  assert.match(reference, /pregunta una sola vez/);
  assert.match(reference, /Un asesor debe revisar esa diferencia/);
  assert.match(reference, /sin.*inventar otra referencia/);
});

test("conversational document instructions use prepared blocks without changing identity", () => {
  const prompt = readFileSync(new URL("agent-instructions.txt", base), "utf8");
  assert.match(prompt, /tono cordial y conversacional/);
  assert.match(prompt, /cada bloque completo tal como lo recibes/);
  assert.match(prompt, /sin cambiar los ceros/);
  assert.match(prompt, /repite únicamente ese bloque tal como está/);
  assert.match(prompt, /No conviertas los bloques/);
  assert.match(prompt, /No hables lentamente palabra por palabra/);
  assert.match(prompt, /no uses tono cantado ni una cadencia de lista/);
  assert.match(prompt, /valores originales customer_name y customer_document/);
  assert.doesNotMatch(prompt, /palabras de cada dígito, despacio/);
});

test("analysis definitions distinguish verified identity and yes to date from all terms", () => {
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  const definitions = Object.fromEntries(config.createArguments.post_call_analysis_data.map(field => [field.name, field.description]));
  assert.match(definitions.identity_confirmed, /respuesta real de la herramienta/);
  assert.match(definitions.identity_confirmed, /ok=true, verificado=true/);
  assert.match(definitions.first_payment_confirmed, /speech.firstDueDate/);
  for (const affirmative of ["sí", "ok", "vale", "claro", "de acuerdo"]) assert.ok(definitions.first_payment_confirmed.includes(affirmative));
  assert.match(definitions.terms_confirmed, /Confirmar identidad, referencia del celular o primera fecha por separado no confirma todos los términos/);
  assert.match(definitions.customer_discrepancies, /referencia del celular/);
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

test("call requires both analyst identity fields and preserves quoted names as strings", () => {
  const supplied = { ...validCall, customer_name: 'Ana "Prueba" \\ Pérez' };
  assert.deepEqual(runCode(call, "nrmCl", { trigger: { body: supplied } }), supplied);
  for (const key of ["customer_name", "customer_document", "customer_name_spoken", "customer_document_spoken"]) {
    for (const invalid of [undefined, null, 123, "", " ", [], {}, "value\n", "value\u0000"]) {
      assert.throws(() => runCode(call, "nrmCl", {
        trigger: { body: { ...validCall, [key]: invalid } },
      }), /Solicitud de llamada invalida/);
    }
  }
  for (const body of [
    { ...validCall, customer_name: "a".repeat(241) },
    { ...validCall, customer_document: "1".repeat(81) },
  ]) {
    assert.throws(() => runCode(call, "nrmCl", { trigger: { body } }), /Solicitud de llamada invalida/);
  }
});

test("native call variables receive exported analyst identity and no financial conditions", () => {
  const normalized = runCode(call, "nrmCl", { trigger: { body: validCall } });
  const normalizer = call.api_nodes.find(node => node.id === "nrmCl");
  const trigger = call.api_nodes.find(node => node.id === "trgCl");
  const native = call.api_nodes.find(node => node.id === "natCl");
  for (const key of ["customer_name", "customer_document", "customer_name_spoken", "customer_document_spoken"]) {
    assert.equal(typeof normalized[key], "string");
    assert.equal(normalizer.api_action.response.find(field => field.variable_name === key).response_value_path, key);
    assert.equal(trigger.api_trigger.trigger_params.find(field => field.key === key).required, true);
    assert.equal(native.api_action.custom_action.values.variables.find(field => field.key === key).value, "{{normalizar_llamada." + key + "}}");
  }
  assert.deepEqual(native.api_action.custom_action.values.variables.map(field => field.key),
    ["event_id", "credito_id", "event_token", "customer_name", "customer_document", "customer_name_spoken", "customer_document_spoken"]);
  assert.equal(trigger.api_trigger.trigger_params.length, 8);
  assert.equal(normalizer.api_action.response.length, 8);
  assert.equal(native.api_action.custom_action.values.variables.length, 7);
});

test("call variable patch preserves native identifiers, template attributes and credentials by omission", () => {
  const patch = JSON.parse(readFileSync(new URL("call-identity-variables.patch.json", base), "utf8"));
  assert.equal(patch.flow_id, "WdOvp");
  assert.match(patch.expected_content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(patch.ops.map(op => [op.op, op.node_id, op.path]), [
    ["set_param", "trgCl", "api_trigger.trigger_params"],
    ["set_param", "nrmCl", "api_action.code_action.code"],
    ["set_param", "nrmCl", "api_action.response"],
    ["set_param", "natCl", "api_action.custom_action.values.variables"],
  ]);
  assert.equal(patch.ops[1].value, call.api_nodes.find(node => node.id === "nrmCl").api_action.code_action.code);
  assert.deepEqual(patch.ops[3].value, call.api_nodes.find(node => node.id === "natCl").api_action.custom_action.values.variables);
  assert.doesNotMatch(JSON.stringify(patch), /https:\/\/|x-api-key|previewToken|preview_token/);
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
    { key: "customer_name", value: "{{normalizar_llamada.customer_name}}" },
    { key: "customer_document", value: "{{normalizar_llamada.customer_document}}" },
    { key: "customer_name_spoken", value: "{{normalizar_llamada.customer_name_spoken}}" },
    { key: "customer_document_spoken", value: "{{normalizar_llamada.customer_document_spoken}}" },
  ]);
  for (const text of [JSON.stringify(identity), JSON.stringify(call)]) {
    assert.doesNotMatch(text, /x-api-key[=:%]|Authorization[=:]/i);
    assert.doesNotMatch(text, /https:\/\/[^"\s]+[?&](?:token|api_key|key|x-api-key)=/i);
  }
  assert.equal((JSON.stringify(call).match(/__REHYDRATE_DAPTA_NATIVE_TEMPLATE_URL__/g) || []).length, 4);
});
