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

test("identity transport patch is scoped to input, safe JSON, private header and verified response", () => {
  const patch = JSON.parse(readFileSync(new URL("identity-normalizer.patch.json", base), "utf8"));
  assert.equal(patch.flow_id, "YxVoY");
  assert.match(patch.expected_content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(patch.ops.map(op => [op.op, op.node_id, op.path]), [
    ["set_param", "trgId", "api_trigger.trigger_params"],
    ["set_param", "nrmId", "api_action.code_action.code"],
    ["set_param", "qryId", "api_action.external_api_action.headers"],
    ["set_param", "qryId", "api_action.response"],
    ["set_param", "chkId", "api_action.code_action.code"],
  ]);
  assert.deepEqual(patch.ops[0].value, identity.api_nodes.find(node => node.id === "trgId").api_trigger.trigger_params);
  assert.equal(patch.ops[1].value, identity.api_nodes.find(node => node.id === "nrmId").api_action.code_action.code);
  assert.deepEqual(patch.ops[2].value, identity.api_nodes.find(node => node.id === "qryId").api_action.external_api_action.headers);
  assert.deepEqual(patch.ops[3].value, identity.api_nodes.find(node => node.id === "qryId").api_action.response);
  assert.equal(patch.ops[4].value, identity.api_nodes.find(node => node.id === "chkId").api_action.code_action.code);
  assert.doesNotMatch(JSON.stringify(patch), /https:\/\/|x-api-key|previewToken|preview_token/);
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

test("only an explicit unverified document clarification code is exposed without financial conditions", () => {
  assert.deepEqual(runCode(identity, "chkId", {
    verificar_identidad: { ok: true, verificado: false, code: "DOCUMENT_NOT_UNDERSTOOD", condiciones: validConditions },
  }), { ok: true, verificado: false, condiciones: null, code: "DOCUMENT_NOT_UNDERSTOOD" });
  for (const response of [
    { ok: true, verificado: false, code: "private-error-details" },
    { ok: true, verificado: "false", code: "DOCUMENT_NOT_UNDERSTOOD" },
    { ok: true, code: "DOCUMENT_NOT_UNDERSTOOD" },
  ]) assert.deepEqual(runCode(identity, "chkId", {
    verificar_identidad: response,
  }), { ok: true, verificado: false, condiciones: null, code: null });
  assert.deepEqual(runCode(identity, "chkId", {
    verificar_identidad: { ok: false, verificado: false, code: "DOCUMENT_NOT_UNDERSTOOD" },
  }), { ok: false, verificado: false, condiciones: null, code: "IDENTITY_UNAVAILABLE" });
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
  assert.match(prompt, /Acepta la cédula en bloques hablados, dígito a dígito o como números/);
  assert.match(prompt, /No exijas un formato ni ofrezcas ejemplos/);
  assert.match(prompt, /code=DOCUMENT_NOT_UNDERSTOOD/);
  assert.match(prompt, /Si ya pediste repetir/);
  assert.doesNotMatch(prompt, /solo (?:en )?(?:dígitos|números)|por ejemplo/i);
  for (const field of ["initialPayment", "installmentAmount", "installmentCount", "firstDueDate"]) {
    assert.ok(prompt.includes("[speech." + field + "]"));
    assert.ok(!prompt.includes("[" + field + "]"));
  }
  assert.doesNotMatch(prompt, /customer_(?:name|document)/);
  assert.match(prompt, /speech incompleto/);
  assert.match(prompt, /sin decir ningún importe o fecha/);
  assert.match(prompt, /calendar confirma/);
  assert.match(prompt, /El dispositivo cuenta con un aplicativo de bloqueo/);
  assert.doesNotMatch(prompt, /<\s*(?:speak|break|say-as|prosody)\b/i);
});

test("voice configuration selects Angie with conversational multilingual delivery", () => {
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  assert.equal(config.updateAfterCreate.voice_speed, 1);
  assert.equal(config.updateAfterCreate.voice_temperature, 1);
  assert.equal(config.updateAfterCreate.normalize_for_speech, true);
  assert.equal(config.createArguments.voice_language, "es-419");
  assert.equal(config.createArguments.voice, "custom_voice_b7f9d4e2175e188767738b4a1c");
  assert.equal(config.updateAfterCreate.voice, config.createArguments.voice);
  assert.equal(config.updateAfterCreate.voice_model, "eleven_multilingual_v2");
});

test("identity recovery is bounded, scoped and uses one new literal response at a time", () => {
  const prompt = readFileSync(new URL("agent-instructions.txt", base), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("draft-manifest.json", base), "utf8"));
  const policy = manifest.identityBackend.identityClarification;
  assert.equal(policy.maxToolConsultations, 3);
  assert.equal(policy.maxClarificationsPerField, 1);
  assert.equal(policy.includesPreverificationRepetitions, true);
  assert.equal(policy.countsDocumentNotUnderstood, true);
  assert.equal(policy.neverExpectedData, true);
  assert.deepEqual(policy.mismatchPriority, ["customer_name", "customer_document"]);
  assert.deepEqual(policy.documentNotUnderstoodPriority, ["customer_document"]);
  assert.equal(policy.stopOnDocumentNotUnderstoodAfterDocumentClarification, true);
  const recovery = prompt.slice(prompt.indexOf("RECUPERACIÓN DE IDENTIDAD"), prompt.indexOf("REGLA BLOQUEANTE PARA PRODUCTO"));
  assert.match(recovery, /como máximo tres consultas/);
  assert.match(recovery, /incluida la primera y las que devuelvan DOCUMENT_NOT_UNDERSTOOD/);
  assert.match(recovery, /una aclaración del nombre y una aclaración de la cédula en toda la llamada/);
  assert.match(recovery, /también cuentan las repeticiones pedidas antes de la primera consulta/);
  assert.match(recovery, /Antes de pedir una aclaración, comprueba que queda una consulta disponible/);
  assert.match(recovery, /Disculpe, no alcancé a confirmar sus datos\. ¿Me repite su nombre completo, por favor\?/);
  assert.match(recovery, /Termina ese turno y espera el nuevo nombre completo/);
  assert.match(recovery, /ese nuevo nombre literal, la última cédula literal comunicada por la persona y el mismo event_id/);
  assert.match(recovery, /code=DOCUMENT_NOT_UNDERSTOOD, prioriza la aclaración de cédula/);
  assert.match(recovery, /Si vuelve DOCUMENT_NOT_UNDERSTOOD o la cédula ya se había aclarado/);
  assert.match(recovery, /end_call sin otra consulta ni condiciones financieras/);
  assert.match(recovery, /No pidas repetir el nombre mientras el documento siga sin interpretarse/);
  assert.match(recovery, /Solo si la nueva consulta devuelve ok=true, verificado=false y condiciones=null sin code=DOCUMENT_NOT_UNDERSTOOD, aplica la aclaración de nombre/);
  assert.match(recovery, /esa nueva transcripción literal, el último nombre literal comunicado y el mismo event_id/);
  assert.match(recovery, /cambia solo el dato que la persona acaba de repetir/);
  assert.match(recovery, /no afirmes que el nombre o la cédula están mal ni reveles los registrados/);
  assert.match(recovery, /Un error no permite otra consulta ni cambiar de evento/);
  assert.match(recovery, /permite avanzar al plan, también si llega en la tercera consulta/);
  assert.match(prompt, /identidad no verificada después de agotar la recuperación permitida/);
  assert.match(prompt, /verificado=false y condiciones=null no es un error de herramienta/);
  // The executable flow still withholds supplied financial conditions for either recoverable result.
  for (const code of [undefined, "DOCUMENT_NOT_UNDERSTOOD"]) {
    const result = runCode(identity, "chkId", {
      verificar_identidad: { ok: true, verificado: false, code, condiciones: validConditions },
    });
    assert.equal(result.ok, true);
    assert.equal(result.verificado, false);
    assert.equal(result.condiciones, null);
  }
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
    assert.match(block, /entonación interrogativa, como una pregunta real/);
    assert.match(block, /Termina esa salida sin herramientas y espera una nueva intervención/);
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
  assert.match(config.pendingEndCallTool.description, /No ejecutes end_call si esta salida todavía hace una pregunta ni mientras esperas una respuesta/);
  for (const reason of ["rechazo de grabación", "petición expresa de terminar", "identidad no verificada", "fallo", "discrepancia", "buzón"]) {
    assert.ok(config.pendingEndCallTool.description.includes(reason));
  }
  assert.match(prompt, /No hables lentamente palabra por palabra/);
  assert.match(prompt, /no uses tono cantado ni una cadencia de lista/);
  assert.match(prompt, /Gracias por su tiempo/);
});

test("agent speaks goodbye before end_call and its sparse patch preserves other tools", () => {
  const prompt = readFileSync(new URL("agent-instructions.txt", base), "utf8");
  const config = JSON.parse(readFileSync(new URL("agent-config.draft.json", base), "utf8"));
  const patch = JSON.parse(readFileSync(new URL("end-call-goodbye.patch.json", base), "utf8"));
  const endCall = config.pendingEndCallTool;
  assert.equal(endCall.speak_during_execution, false);
  assert.equal(endCall.execution_message_type, "static_text");
  assert.equal(endCall.execution_message_description, "Gracias por su tiempo.");
  assert.equal(Object.hasOwn(endCall, "finish_delay"), false);
  assert.equal(Object.hasOwn(endCall, "speak_after_execution"), false);
  assert.match(prompt, /Solo después de escuchar la tercera respuesta afirmativa, di tú misma en voz alta exactamente «Gracias por su tiempo\.» y solo después ejecuta end_call/);
  assert.match(prompt, /No agregues otra frase de cierre ni una cuarta pregunta/);
  assert.match(prompt, /no dependas de un mensaje nativo de ejecución/);
  assert.match(endCall.description, /La despedida debe ser una salida hablada previa a esta herramienta/);
  assert.match(endCall.description, /No reutilices un sí u ok entre acuerdos/);
  assert.match(prompt, /En cada salida anticipada dirigida a una persona, da primero la explicación apropiada sin preguntas, di en voz alta «Gracias por su tiempo\.» y solo después ejecuta end_call/);
  assert.doesNotMatch(prompt, /No digas esa despedida por separado/);
  assert.deepEqual(Object.keys(patch).sort(), ["agent_id", "tools_patch_by_name", "workspace_id"]);
  assert.equal(patch.tools_patch_by_name.length, 1);
  assert.equal(patch.tools_patch_by_name[0].name, "end_call");
  assert.deepEqual(Object.keys(patch.tools_patch_by_name[0]).sort(), ["name", "set"]);
  const set = patch.tools_patch_by_name[0].set;
  assert.deepEqual(Object.keys(set).sort(), ["description", "execution_message_description", "execution_message_type", "speak_during_execution"]);
  for (const key of Object.keys(set)) assert.equal(set[key], endCall[key]);
  // This checks the configuration contract, not actual playback or runtime drain before hangup.
  assert.doesNotMatch(JSON.stringify(patch), /verificar_cliente_bienvenida|dapta_webhook|https?:/);
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
