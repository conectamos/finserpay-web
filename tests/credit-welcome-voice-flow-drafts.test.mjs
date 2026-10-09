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
  event_id: "cce44e9a-3f06-4f1b-8c9f-88c9c1f9f931",
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
const identityUnavailable = { ok: false, verificado: false, condiciones: null, code: "IDENTITY_UNAVAILABLE",
  nextAction: null, remainingAttempts: null, question: null, mayEndCall: null };
const verifiedIdentity = (condiciones = validConditions, overrides = {}) => ({ ok: true, verificado: true, condiciones,
  code: null, nextAction: "CONTINUE", remainingAttempts: 2, question: null, mayEndCall: false, ...overrides });
const identityQuestions = {
  ASK_NAME: "¿Me dice solo su primer nombre, por favor?",
  ASK_DOCUMENT: "¿Me repite su cédula completa, desde el primer dígito, con una pausa entre cada número?",
  REVIEW: "No pude confirmar sus datos. Un asesor revisará su caso.",
};
const legacyIdentityQuestions = {
  ASK_NAME: "¿Me repite su nombre completo, por favor?",
  ASK_DOCUMENT: "¿Me repite su número de cédula, por favor?",
  REVIEW: identityQuestions.REVIEW,
};
const identityRecovery = (nextAction = "ASK_NAME", remainingAttempts = 2, code = "IDENTITY_NOT_CONFIRMED") => ({
  ok: true, verificado: false, condiciones: null, code, nextAction, remainingAttempts,
  question: identityQuestions[nextAction], mayEndCall: nextAction === "REVIEW",
});
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
  assert.deepEqual(Object.keys(body), ["event_id", "customer_name", "customer_document"]);
});

test("identity normalization rejects forbidden controls, missing values and excessive input", () => {
  for (const body of [
    { ...validIdentity, customer_name: "Ana\u0000Pérez" },
    { ...validIdentity, customer_document: "123\u001f456" },
    { ...validIdentity, event_id: "event\u007f" },
    { ...validIdentity, customer_name: "a".repeat(241) },
    { ...validIdentity, customer_document: "1".repeat(241) },
    { ...validIdentity, event_id: "a".repeat(37) },
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
    { event_id: validIdentity.event_id, args: { customer_name: validIdentity.customer_name, customer_document: validIdentity.customer_document } },
    { event_token: "legacy-token", args: validIdentity },
  ]) {
    assert.throws(() => runCode(identity, "nrmId", { trigger: { body } }), /Solicitud de identidad invalida/);
  }
});

test("direct and args identity bodies require their own scoped event UUID", () => {
  for (const wrap of [body => body, body => ({ args: body })]) {
    for (const eventId of [undefined, null, 123, "", " ", "event\u0000", "a".repeat(37), "not-a-uuid", "synthetic-event-token"]) {
      assert.throws(() => runCode(identity, "nrmId", {
        trigger: { body: wrap({ ...validIdentity, event_id: eventId }) },
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

test("identity recovery patch changes only response mappings and validator, preserving input and private credentials", () => {
  const patch = JSON.parse(readFileSync(new URL("identity-normalizer.patch.json", base), "utf8"));
  assert.equal(patch.flow_id, "YxVoY");
  assert.match(patch.expected_content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(patch.ops.map(op => [op.op, op.node_id, op.path]), [
    ["set_param", "qryId", "api_action.response"],
    ["set_param", "chkId", "api_action.code_action.code"],
    ["set_param", "chkId", "api_action.response"],
    ["set_param", "rspId", "api_response.response_params"],
  ]);
  assert.deepEqual(patch.ops[0].value, identity.api_nodes.find(node => node.id === "qryId").api_action.response);
  assert.equal(patch.ops[1].value, identity.api_nodes.find(node => node.id === "chkId").api_action.code_action.code);
  assert.deepEqual(patch.ops[2].value, identity.api_nodes.find(node => node.id === "chkId").api_action.response);
  assert.deepEqual(patch.ops[3].value, identity.api_nodes.find(node => node.id === "rspId").api_response.response_params);
  assert.doesNotMatch(JSON.stringify(patch), /https:\/\/|Authorization|Bearer|x-api-key|previewToken|preview_token/);
  assert.equal(identity.api_nodes.find(node => node.id === "nrmId").api_action.on_error, "stop");
});

test("identity private bearer is a header placeholder and never a model parameter or JSON body", () => {
  const api = identity.api_nodes.find(node => node.id === "qryId").api_action.external_api_action;
  assert.equal(api.request_type, "post");
  assert.equal(api.url, "https://finserpay.com/api/integraciones/dapta/bienvenida-voz/identidad");
  assert.equal(api.body, "{{normalizar_identidad.request_body}}");
  assert.deepEqual(api.headers, [
    { key: "Content-Type", value: "application/json" },
    { key: "Authorization", value: "Bearer NEW_PRIVATE_IDENTITY_FLOW_TOKEN" },
  ]);
  assert.equal(api.authorization.token, "");
  assert.deepEqual(identity.api_nodes.find(node => node.id === "qryId").api_action.response.find(field => field.variable_name === "code"),
    { variable_name: "code", response_value_path: "response.code" });
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  assert.doesNotMatch(JSON.stringify(config.pendingIdentityTool), /NEW_PRIVATE_IDENTITY_FLOW_TOKEN|event_token|Authorization/);
  const exported = runCode(identity, "nrmId", { trigger: { body: { ...validIdentity, event_token: "ignored-signed-token", authorization: "ignored-bearer" } } });
  assert.deepEqual(JSON.parse(exported.request_body), validIdentity);
});

test("identity document utterances reach the backend literally without numeric conversion or expected values", () => {
  for (const customer_document of [
    "doce, trescientos cuarenta y cinco, cero sesenta y siete",
    "uno dos tres cuatro cinco cero seis siete",
    "00123456",
    "doce; trescientos cuarenta y cinco; cero cero seis",
  ]) {
    const supplied = { ...validIdentity, customer_document };
    const exported = runCode(identity, "nrmId", { trigger: { body: { args: supplied } } });
    assert.deepEqual(JSON.parse(exported.request_body), supplied);
  }
});

test("server recovery is forwarded with exact question, bounded attempts and no financial conditions", () => {
  for (const response of [
    identityRecovery("ASK_NAME", 2), identityRecovery("ASK_DOCUMENT", 1), identityRecovery("REVIEW", 0),
    identityRecovery("ASK_DOCUMENT", 2, "DOCUMENT_NOT_UNDERSTOOD"),
    identityRecovery("REVIEW", 0, "DOCUMENT_NOT_UNDERSTOOD"),
    identityRecovery("ASK_NAME", 1),
  ]) assert.deepEqual(runCode(identity, "chkId", { verificar_identidad: response }), response);
});

test("rolling identity deployments accept only the exact old and new question for each action", () => {
  for (const action of ["ASK_NAME", "ASK_DOCUMENT", "REVIEW"]) {
    for (const question of new Set([identityQuestions[action], legacyIdentityQuestions[action]])) {
      for (const code of action === "ASK_NAME" ? ["IDENTITY_NOT_CONFIRMED"] : ["IDENTITY_NOT_CONFIRMED", "DOCUMENT_NOT_UNDERSTOOD"]) {
        const response = { ...identityRecovery(action, action === "REVIEW" ? 0 : 2, code), question };
        assert.deepEqual(runCode(identity, "chkId", { verificar_identidad: response }), response);
        assert.equal(response.condiciones, null);
      }
    }
  }
});

test("question compatibility cannot retag a recovery action or accept a similar clarification", () => {
  for (const action of ["ASK_NAME", "ASK_DOCUMENT", "REVIEW"]) {
    const response = identityRecovery(action, action === "REVIEW" ? 0 : 1);
    const wrongQuestions = Object.keys(identityQuestions).filter(other => other !== action)
      .flatMap(other => [identityQuestions[other], legacyIdentityQuestions[other]]);
    for (const question of [...wrongQuestions, identityQuestions[action] + " ", [identityQuestions[action]],
      identityQuestions[action].slice(0, -1), "¿Puede repetir los datos esperados?"]) {
      assert.deepEqual(runCode(identity, "chkId", { verificar_identidad: { ...response, question } }), identityUnavailable);
    }
  }
});

test("a name with no matching registered component asks for clarification without altering the mixed spoken document", () => {
  const captured = { ...validIdentity, customer_name: "Cliente Ejemplo.",
    customer_document: "Treinta y ocho, uno cuatro cuatro cero nueve dos." };
  const request = runCode(identity, "nrmId", { trigger: { body: { args: captured } } });
  assert.deepEqual(JSON.parse(request.request_body), captured);
  const first = runCode(identity, "chkId", { verificar_identidad: identityRecovery("ASK_NAME", 2) });
  assert.equal(first.nextAction, "ASK_NAME");
  assert.equal(first.question, identityQuestions.ASK_NAME);
  assert.equal(first.mayEndCall, false);
  assert.equal(first.condiciones, null);
  const clarified = { ...captured, customer_name: "Persona Hernández Prueba" };
  const retry = runCode(identity, "nrmId", { trigger: { body: { args: clarified } } });
  assert.deepEqual(JSON.parse(retry.request_body), clarified);
  assert.equal(JSON.parse(retry.request_body).customer_document, captured.customer_document);
  assert.equal(JSON.parse(retry.request_body).event_id, captured.event_id);
  const verified = runCode(identity, "chkId", { verificar_identidad: verifiedIdentity(validConditions, { remainingAttempts: 1 }) });
  assert.equal(verified.nextAction, "CONTINUE");
  assert.deepEqual(verified.condiciones, validConditions);
});

test("one matching name component and an exact document can continue without a name clarification", () => {
  const captured = { ...validIdentity, customer_name: "Persona Fernández Gil.",
    customer_document: "Treinta y ocho, uno cuatro cuatro cero nueve dos." };
  const request = runCode(identity, "nrmId", { trigger: { body: { args: captured } } });
  assert.deepEqual(JSON.parse(request.request_body), captured);
  const output = runCode(identity, "chkId", { verificar_identidad: verifiedIdentity() });
  assert.equal(output.nextAction, "CONTINUE");
  assert.equal(output.question, null);
  assert.deepEqual(output.condiciones, validConditions);
});

test("both recovery orders preserve server state through the final allowed consultation", () => {
  for (const path of [
    [identityRecovery("ASK_NAME", 2), identityRecovery("ASK_DOCUMENT", 1), identityRecovery("REVIEW", 0)],
    [identityRecovery("ASK_DOCUMENT", 2, "DOCUMENT_NOT_UNDERSTOOD"), identityRecovery("ASK_NAME", 1), verifiedIdentity(validConditions, { remainingAttempts: 0 })],
    [identityRecovery("ASK_DOCUMENT", 2, "DOCUMENT_NOT_UNDERSTOOD"), identityRecovery("REVIEW", 0, "DOCUMENT_NOT_UNDERSTOOD")],
  ]) {
    for (const response of path) {
      const output = runCode(identity, "chkId", { verificar_identidad: response });
      assert.deepEqual(output, response);
      if (!output.verificado) assert.equal(output.condiciones, null);
      if (output.nextAction.startsWith("ASK_")) assert.equal(output.mayEndCall, false);
      if (output.nextAction === "REVIEW") assert.equal(output.remainingAttempts, 0);
    }
  }
});

test("missing, malformed or contradictory recovery fields fail technically without inventing a question", () => {
  const valid = identityRecovery();
  const invalid = [
    { ...valid, ok: "true" }, { ...valid, verificado: "false" },
    { ...valid, nextAction: "ASK_EXPECTED_NAME" }, { ...valid, code: "private-error-details" },
    { ...valid, code: "DOCUMENT_NOT_UNDERSTOOD" },
    { ...valid, condiciones: validConditions }, { ...valid, condiciones: undefined },
    { ...valid, question: "¿Su nombre registrado es Persona Esperada?" },
    { ...valid, mayEndCall: true }, { ...valid, mayEndCall: "false" },
    ...[0, 3, -1, 1.5, "2", null].map(remainingAttempts => ({ ...valid, remainingAttempts })),
    { ...identityRecovery("REVIEW", 0), remainingAttempts: 1 },
    { ...identityRecovery("REVIEW", 0), mayEndCall: false },
    { ok: true, verificado: false, condiciones: null, code: null },
    { ok: true, verificado: false, condiciones: null, code: "DOCUMENT_NOT_UNDERSTOOD" },
  ];
  for (const key of ["nextAction", "remainingAttempts", "question", "mayEndCall", "code"]) {
    const missing = { ...valid }; delete missing[key]; invalid.push(missing);
  }
  for (const response of invalid) assert.deepEqual(runCode(identity, "chkId", { verificar_identidad: response }), identityUnavailable);
});

test("verified finance also requires the complete CONTINUE control contract", () => {
  const valid = verifiedIdentity();
  const invalid = [
    { ...valid, nextAction: "ASK_NAME" }, { ...valid, question: identityQuestions.ASK_NAME },
    { ...valid, mayEndCall: true }, { ...valid, code: "IDENTITY_NOT_CONFIRMED" },
    { ...valid, remainingAttempts: 3 }, { ...valid, remainingAttempts: "0" },
  ];
  for (const key of ["nextAction", "remainingAttempts", "question", "mayEndCall", "code"]) {
    const missing = { ...valid }; delete missing[key]; invalid.push(missing);
  }
  for (const response of invalid) assert.deepEqual(runCode(identity, "chkId", { verificar_identidad: response }), identityUnavailable);
});

test("all response mappings export the full server control contract unchanged", () => {
  const keys = ["ok", "verificado", "condiciones", "code", "nextAction", "remainingAttempts", "question", "mayEndCall"];
  for (const [nodeId, prefix] of [["qryId", "response."], ["chkId", ""]]) {
    assert.deepEqual(identity.api_nodes.find(node => node.id === nodeId).api_action.response,
      keys.map(key => ({ variable_name: key, response_value_path: prefix + key })));
  }
  assert.deepEqual(identity.api_nodes.find(node => node.id === "rspId").api_response.response_params,
    keys.map(key => ({ key, value: "{{preparar_respuesta_identidad." + key + "}}" })));
});

test("the current Diana script waits for the server clarification and preserves the three independent agreements", () => {
  const prompt = readFileSync(new URL("../docs/DAPTA_DIANA_VOICE_PROMPT.md", import.meta.url), "utf8");
  const recovery = prompt.slice(prompt.indexOf("### Recuperación dirigida por el servidor"), prompt.indexOf("### Fuente de las condiciones"));
  for (const action of ["ASK_NAME", "ASK_DOCUMENT", "REVIEW", "CONTINUE"]) assert.ok(recovery.includes("nextAction=" + action));
  assert.ok(recovery.includes(identityQuestions.REVIEW));
  assert.equal((recovery.match(/lee exactamente el campo question recibido del servidor/g) || []).length, 2);
  assert.match(recovery, /solo su primer nombre.*sin volver a exigir el nombre completo/);
  assert.match(recovery, /cédula completa desde el primer dígito.*sin unirla con la cédula anterior ni completar dígitos/);
  assert.match(recovery, /Solo el backend decide si está completa/);
  assert.match(recovery, /Termina ese turno sin despedirte ni ejecutar end_call/);
  assert.match(recovery, /Espera la nueva respuesta/);
  assert.match(recovery, /última cédula literal sin modificar/);
  assert.match(recovery, /último nombre literal sin modificar/);
  assert.match(recovery, /Un verificado=false.*no es un cierre ni autoriza end_call/);
  assert.match(recovery, /El éxito en la tercera consulta permite continuar/);
  assert.match(recovery, /no inventes una aclaración ni otra consulta/);
  assert.doesNotMatch(recovery, /admite condiciones ausente|Aclar[a-z]* primero el nombre si aún puedes/);
  for (const block of ["Primer acuerdo: plan", "Segundo acuerdo: calendario", "Tercer acuerdo: aplicativo"]) assert.ok(prompt.includes(block));
  assert.match(prompt, /Nunca ejecutes end_call en una salida que aún haga una pregunta o mientras esperas respuesta/);
  assert.match(prompt, /Solo después de escuchar la tercera/);
});

test("operational identity instructions and metadata preserve the current matching rule and server-controlled recovery", () => {
  const canonical = readFileSync(new URL("../docs/DAPTA_DIANA_VOICE_PROMPT.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const operational = readFileSync(new URL("agent-instructions.txt", base), "utf8").replace(/\r\n/g, "\n");
  const identitySection = canonical.slice(canonical.indexOf("### Nombre, cédula y validación") + "### Nombre, cédula y validación".length,
    canonical.indexOf("### Fuente de las condiciones")).trim().replace("### Recuperación dirigida por el servidor", "RECUPERACIÓN DIRIGIDA POR EL SERVIDOR");
  assert.ok(operational.includes(identitySection));
  assert.match(identitySection, /al menos un nombre o apellido registrado como palabra completa/);
  assert.match(identitySection, /Siempre exige la cédula completa exacta/);
  assert.match(identitySection, /excluyendo las partículas de, del, la, las, los e y/);
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  assert.match(config.pendingIdentityTool.description, /al menos un nombre o apellido registrado como palabra completa/);
  assert.match(config.pendingIdentityTool.description, /cédula completa exacta/);
  assert.match(config.pendingEndCallTool.description, /ASK_NAME o ASK_DOCUMENT con mayEndCall=false/);
  assert.match(config.pendingEndCallTool.description, /no autoriza cerrar/);
  const manifest = JSON.parse(readFileSync(new URL("draft-manifest.json", base), "utf8"));
  assert.equal(manifest.identityBackend.identityClarification.maximumConsultations, 3);
  assert.deepEqual(manifest.identityBackend.identityClarification.questions, identityQuestions);
  assert.equal(manifest.preparedLivePatches.find(item => item.file === "identity-normalizer.patch.json").expectedContentHash,
    JSON.parse(readFileSync(new URL("identity-normalizer.patch.json", base), "utf8")).expected_content_hash);
});

test("identity success requires a conditions object and strict booleans", () => {
  const conditions = validConditions;
  assert.deepEqual(runCode(identity, "chkId", {
    verificar_identidad: verifiedIdentity(conditions),
  }), verifiedIdentity(conditions));
  for (const condiciones of [undefined, null, "conditions", []]) {
    assert.deepEqual(runCode(identity, "chkId", {
      verificar_identidad: verifiedIdentity(validConditions, { condiciones }),
    }), identityUnavailable);
  }
  for (const ok of [false, "true", undefined]) {
    assert.deepEqual(runCode(identity, "chkId", {
      verificar_identidad: verifiedIdentity(conditions, { ok }),
    }), identityUnavailable);
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
      verificar_identidad: verifiedIdentity(condiciones),
      invented_conditions: { speech: validSpeech },
    }), identityUnavailable);
  }
});

test("identity reply preserves exact backend speech without converting raw amounts", () => {
  const result = runCode(identity, "chkId", {
    verificar_identidad: verifiedIdentity(),
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

test("voice tool captures actual customer identity without prefilled answers or extra authorization", () => {
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  const prompt = readFileSync(new URL("agent-instructions.txt", base), "utf8");
  const tool = config.pendingIdentityTool;
  assert.match(tool.parameters.properties.customer_name.description, /realmente haya dicho/);
  assert.match(tool.parameters.properties.customer_document.description, /literalmente/);
  assert.match(tool.parameters.properties.customer_document.description, /palabras o dígitos/);
  assert.match(tool.parameters.properties.customer_document.description, /No convertir/);
  assert.match(tool.parameters.properties.customer_document.description, /sin exigir un formato/);
  for (const key of ["customer_name", "customer_document"]) {
    assert.doesNotMatch(tool.parameters.properties[key].description, /\{\{/);
    assert.equal(tool.parameters.properties[key].const, undefined);
  }
  assert.equal(tool.parameters.properties.event_token, undefined);
  assert.match(tool.parameters.properties.event_id.description, /\{\{event_id\}\}/);
  assert.deepEqual(tool.parameters.required,
    ["dapta_api_id", "dapta_webhook", "event_id", "customer_name", "customer_document"]);
  assert.equal(tool.parameters.properties.dapta_webhook.const, "NEW_PRIVATE_IDENTITY_FLOW_URL");
  assert.equal(tool.parameters.properties.dapta_api_id.const, "NEW_IDENTITY_FLOW_ID");
  for (const param of Object.values(tool.parameters.properties)) assert.equal(param.type, "string");
  assert.equal(config.createArguments.identity_name, "Diana");
  assert.equal(config.createArguments.company_name, "FINSER PAY");
  assert.equal(config.updateAfterCreate.begin_message,
    "Hola, soy Diana de FINSER PEY y quiero darle la bienvenida y confirmar los datos de la financiación de su celular. Esta llamada está siendo grabada y monitoreada para efectos de calidad y seguridad. ¿Me confirma, por favor, su nombre completo?");
  assert.doesNotMatch(config.updateAfterCreate.begin_message, /podemos continuar|tiene un momento|puede hablar/i);
  assert.ok(prompt.includes("¿Su número de cédula, por favor?"));
  assert.match(prompt, /Acepta la cédula en bloques hablados, dígito a dígito o (?:como|en) números/);
  assert.match(prompt, /No conviertas.*ni ofrezcas ejemplos/);
  assert.match(prompt, /DOCUMENT_NOT_UNDERSTOOD/);
  assert.match(prompt, /nextAction=ASK_DOCUMENT/);
  assert.doesNotMatch(prompt, /solo (?:en )?(?:dígitos|números)|por ejemplo/i);
  for (const field of ["initialPayment", "installmentAmount", "installmentCount", "firstDueDate"]) {
    assert.ok(prompt.includes("[speech." + field + "]"));
    assert.ok(!prompt.includes("[" + field + "]"));
  }
  assert.doesNotMatch(prompt, /\{\{customer_(?:name|document)/);
  assert.match(prompt, /speech incompleto/);
  assert.match(prompt, /sin decir ningún importe o fecha/);
  assert.match(prompt, /calendar confirma/);
  assert.match(prompt, /El dispositivo cuenta con un aplicativo de bloqueo/);
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
      verificar_identidad: verifiedIdentity(condiciones),
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

test("equipment is named only after verification and before verified financial amounts", () => {
  const prompt = readFileSync(new URL("agent-instructions.txt", base), "utf8");
  const planAt = prompt.indexOf("PLAN DE PAGOS: PRIMER ACUERDO");
  const calendarAt = prompt.indexOf("CALENDARIO Y PRIMERA FECHA: SEGUNDO ACUERDO");
  const reference = prompt.slice(planAt, calendarAt);
  for (const guard of ["ok=true", "verificado=true", "condiciones.speech completo"]) assert.ok(reference.includes(guard));
  assert.ok(reference.includes("[speech.equipmentReference]"));
  assert.match(reference, /referencia exacta/);
  assert.ok(reference.indexOf("[speech.equipmentReference]") < reference.indexOf("[speech.initialPayment]"));
  assert.match(reference, /equipmentReference falta, es null o está vacío/);
  assert.match(reference, /no adivines/);
  assert.match(reference, /un asesor debe revisarla/);
  assert.match(reference, /installmentsEqual=false/);
  assert.match(reference, /no afirmes que todas cuestan lo mismo/);
});

test("normal hangup waits for three separate agreements and preserves early exits", () => {
  const prompt = readFileSync(new URL("agent-instructions.txt", base), "utf8");
  assert.match(prompt, /tono cordial y conversacional/);
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  const gates = ["PLAN DE PAGOS: PRIMER ACUERDO", "CALENDARIO Y PRIMERA FECHA: SEGUNDO ACUERDO", "APLICATIVO: TERCER ACUERDO"];
  for (let i = 0; i < gates.length; i++) {
    const start = prompt.indexOf(gates[i]);
    const end = i + 1 < gates.length ? prompt.indexOf(gates[i + 1]) : prompt.indexOf("TURNOS, DIFERENCIAS Y CIERRE");
    const block = prompt.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.match(block, /¿Está de acuerdo\?/);
    assert.match(block, /Espera una respuesta real/);
  }
  // The user requested these sentences verbatim; prepared financial texts replace only their placeholders.
  for (const sentence of [
    "Le confirmo su plan de pagos: [speech.equipmentReference]",
    "Con una cuota inicial de [speech.initialPayment]",
    "Su financiación tiene un plazo de [speech.installmentCount] de [speech.installmentAmount]. ¿Está de acuerdo?",
    "Sus fechas de pago son para todos los dos y diecisiete de cada mes",
    "Su primer pago está para el día [speech.firstDueDate]. ¿Está de acuerdo?",
    "El dispositivo cuenta con un aplicativo de bloqueo. En caso de mora se bloqueará el equipo y su activación podrá tardar hasta veinticuatro horas después de realizar el pago correspondiente. ¿Está de acuerdo?",
  ]) assert.ok(prompt.includes(sentence), sentence);
  assert.match(prompt, /Nunca ejecutes end_call en el mismo turno de una pregunta ni mientras esperas su respuesta/);
  assert.match(prompt, /tres respuestas afirmativas independientes/);
  assert.match(prompt, /Si falta una respuesta o el agente cuelga antes/);
  assert.equal(config.pendingEndCallTool.name, "end_call");
  assert.equal(config.pendingEndCallTool.type, "end_call");
  assert.match(config.pendingEndCallTool.description, /tres respuestas afirmativas reales e independientes/);
  assert.match(config.pendingEndCallTool.description, /Nunca ejecutes esta herramienta en el mismo turno de una pregunta/);
  for (const reason of ["rechazo de grabación", "petición expresa de terminar", "identidad no verificada", "fallo", "discrepancia", "buzón"]) {
    assert.ok(config.pendingEndCallTool.description.includes(reason));
  }
  assert.match(prompt, /No hables lentamente palabra por palabra/);
  assert.match(prompt, /no uses tono cantado ni una cadencia de lista/);
  assert.match(prompt, /Gracias por su tiempo/);
});

test("analysis distinguishes actual identity, continuity after notice and all three agreements", () => {
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  const definitions = Object.fromEntries(config.createArguments.post_call_analysis_data.map(field => [field.name, field.description]));
  assert.match(definitions.identity_confirmed, /resultado real de la herramienta/);
  assert.match(definitions.identity_confirmed, /booleanos verdaderos/);
  assert.match(definitions.first_payment_confirmed, /speech.firstDueDate/);
  for (const affirmative of ["sí", "ok", "vale", "claro", "de acuerdo"]) assert.ok(definitions.first_payment_confirmed.includes(affirmative));
  for (const field of ["identity_confirmed", "payment_plan_confirmed", "first_payment_confirmed", "device_policy_confirmed"]) {
    assert.ok(definitions.terms_confirmed.includes(field));
  }
  assert.match(definitions.terms_confirmed, /tres respuestas afirmativas independientes/);
  assert.match(definitions.payment_plan_confirmed, /primera pregunta/);
  assert.match(definitions.first_payment_confirmed, /segunda pregunta/);
  assert.match(definitions.device_policy_confirmed, /tercera pregunta/);
  assert.match(definitions.recording_accepted, /continuidad tras el aviso/);
  assert.match(definitions.recording_accepted, /no.*consentimiento expreso/);
  assert.match(config.createArguments.analysis_successful_prompt, /Un cierre mientras se esperaba respuesta/);
});

test("identity mismatch never exposes supplied conditions", () => {
  for (const verificado of [false, "true", undefined]) {
    assert.deepEqual(runCode(identity, "chkId", {
      verificar_identidad: { ...identityRecovery(), verificado, condiciones: { monto: "confidential" } },
    }), identityUnavailable);
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

test("native call excludes expected identity while legacy trigger inputs remain compatible", () => {
  const normalized = runCode(call, "nrmCl", { trigger: { body: validCall } });
  const normalizer = call.api_nodes.find(node => node.id === "nrmCl");
  const trigger = call.api_nodes.find(node => node.id === "trgCl");
  const native = call.api_nodes.find(node => node.id === "natCl");
  for (const key of ["customer_name", "customer_document", "customer_name_spoken", "customer_document_spoken"]) {
    assert.equal(typeof normalized[key], "string");
    assert.equal(normalizer.api_action.response.find(field => field.variable_name === key).response_value_path, key);
    assert.equal(trigger.api_trigger.trigger_params.find(field => field.key === key).required, true);
    assert.equal(native.api_action.custom_action.values.variables.find(field => field.key === key), undefined);
  }
  assert.deepEqual(native.api_action.custom_action.values.variables.map(field => field.key),
    ["event_id", "credito_id", "event_token"]);
  assert.equal(trigger.api_trigger.trigger_params.length, 8);
  assert.equal(normalizer.api_action.response.length, 8);
  assert.equal(native.api_action.custom_action.values.variables.length, 3);
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
  ]);
  for (const text of [JSON.stringify(identity), JSON.stringify(call)]) {
    assert.doesNotMatch(text, /x-api-key[=:%]|Authorization[=:]/i);
    assert.doesNotMatch(text, /https:\/\/[^"\s]+[?&](?:token|api_key|key|x-api-key)=/i);
  }
  assert.equal((JSON.stringify(call).match(/__REHYDRATE_DAPTA_NATIVE_TEMPLATE_URL__/g) || []).length, 4);
});
