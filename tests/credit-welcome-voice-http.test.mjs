import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const roles = loadReissueModule("lib/roles.ts");
const allies = loadReissueModule("lib/aliados.ts");
const lookup = loadReissueModule("lib/credit-route-lookup.ts");
const core = loadReissueModule("lib/credit-welcome-voice-core.ts", {
  "./credit-welcome-voice-name": loadReissueModule("lib/credit-welcome-voice-name.ts"),
});
const documentParser = loadReissueModule("lib/credit-welcome-voice-document.ts");
const http = loadReissueModule("lib/credit-welcome-voice-http.ts", {
  "@/lib/roles": roles, "@/lib/aliados": allies, "@/lib/credit-route-lookup": lookup,
  "@/lib/credit-welcome-voice-document": documentParser,
  "@/lib/credit-welcome-voice-phone": loadReissueModule("lib/credit-welcome-voice-phone.ts"),
});
const now = new Date("2026-10-08T15:00:00.000Z");
const secret = "test-welcome-voice-secret-at-least-thirty-two-characters";
const identity = { eventId: "25ea074e-a7e5-4f2c-8c8e-e64258fe345d", creditId: 72 };
const token = core.createWelcomeVoiceToken(identity, { secret, now });
const plain = value => JSON.parse(JSON.stringify(value));
const verifyToken = value => core.verifyWelcomeVoiceToken(value, { secret, now });
const request = (body, path = "identidad", headers = {}) => new Request(`https://finser.test/api/integraciones/dapta/bienvenida-voz/${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const validIdentity = () => ({ event_token: token, customer_name: "Ana María Pérez", customer_document: "00.123.456-78" });
const validCall = () => ({ call_id: "call-example-01", agent_id: "sofia-agent", call_status: "ended",
  dynamic_variables: { event_token: token, event_id: identity.eventId, credito_id: String(identity.creditId) },
  duration_ms: 93500, recording_url: "https://app.dapta.ai/call-log/call-example-01",
  transcript: "Conversación de prueba", call_analysis: { call_summary: "Se explicaron las condiciones.",
    in_voicemail: false, custom_analysis_data: { identity_confirmed: true, recording_accepted: true, terms_confirmed: true,
      customer_questions: ["¿Dónde puedo consultar el plan?"], customer_discrepancies: "La fecha necesita revisión." } },
});
function assertPrivate(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("vary"), "Authorization, Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}
function identityFixture({ result = { verificado: true, condiciones: { installmentCount: 4, installmentAmount: 130000 } }, error } = {}) {
  const calls = [];
  const POST = http.createCreditWelcomeVoiceIdentityHandler({ verifyToken, verifyIdentity: async value => {
    calls.push(plain(value)); if (error) throw error; return result;
  } });
  return { POST, calls };
}
function resultFixture({ expectedAgent = "sofia-agent", error } = {}) {
  const calls = [];
  const seen = new Set();
  const POST = http.createCreditWelcomeVoiceResultHandler({ verifyToken, expectedAgent: () => expectedAgent,
    safeUrl: core.safeDaptaWelcomeVoiceUrl, saveResult: async value => {
      calls.push(plain(value)); if (error) throw error;
      const hash = JSON.stringify(value); const unchanged = seen.has(hash); seen.add(hash); return { unchanged };
    } });
  return { POST, calls };
}

test("identity requires the signed event token; expired, forged, header and query credentials cannot reveal credit data", async () => {
  const f = identityFixture();
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), creditId: 73 })).toString("base64url");
  const expired = core.createWelcomeVoiceToken(identity, { secret, now: new Date(now.getTime() - 10000), ttlSeconds: 1 });
  for (const credential of [undefined, "wrong", expired, `${forged}.${signature}`, 12]) {
    const response = await f.POST(request({ ...validIdentity(), event_token: credential }, `identidad?event_token=${token}`, { authorization: `Bearer ${token}` }));
    assert.equal(response.status, 401); assertPrivate(response);
    assert.deepEqual(await response.json(), { ok: false, code: "UNAUTHORIZED", error: "Solicitud no autorizada." });
  }
  assert.equal(f.calls.length, 0);
});

test("identity only returns backend verified conditions and ignores caller financial or verification flags", async () => {
  const f = identityFixture();
  const response = await f.POST(request({ ...validIdentity(), credit_id: 99, verificado: true, identity_confirmed: true, installmentAmount: 1 }));
  assert.equal(response.status, 200); assertPrivate(response);
  assert.deepEqual(f.calls, [{ ...identity, customerName: "Ana María Pérez", customerDocument: "0012345678" }]);
  assert.deepEqual(await response.json(), { ok: true, verificado: true, condiciones: { installmentCount: 4, installmentAmount: 130000 } });
  const denied = identityFixture({ result: { verificado: false, condiciones: { secret: "hidden" }, customer_document: "hidden" } });
  assert.deepEqual(await (await denied.POST(request(validIdentity()))).json(), { ok: true, verificado: false });
});

test("identity validates strings and enforces actual byte limits, JSON object and content type before backend matching", async () => {
  const f = identityFixture();
  for (const body of [[], null, "{", { ...validIdentity(), customer_name: 1 }, { ...validIdentity(), customer_name: "" },
    { ...validIdentity(), customer_name: "a".repeat(241) }, { ...validIdentity(), customer_document: 12345678 },
    { ...validIdentity(), customer_document: "a".repeat(241) },
    { ...validIdentity(), customer_name: "Ana\u0000Pérez" }]) {
    assert.equal((await f.POST(request(body))).status, 400);
  }
  assert.equal((await f.POST(request(validIdentity(), "identidad", { "content-type": "text/plain" }))).status, 415);
  const tooLarge = { ...validIdentity(), ignored: "ñ".repeat(2100) };
  assert.equal((await f.POST(request(tooLarge, "identidad", { "content-length": "1" }))).status, 413);
  assert.equal((await f.POST(request(validIdentity(), "identidad", { "content-length": "5000" }))).status, 413);
  assert.equal(f.calls.length, 0);
});

test("spoken document blocks and individual digits are parsed without an expected document or LLM conversion", async () => {
  const f = identityFixture();
  for (const spoken of ["treinta y ocho, ciento cuarenta y cuatro, cero noventa y dos", "tres ocho uno cuatro cuatro cero nueve dos",
    "treinta y ocho ciento cuarenta y cuatro cero noventa y dos"]) {
    const response = await f.POST(request({ ...validIdentity(), customer_document: spoken }));
    assert.equal(response.status, 200);
    assert.equal(f.calls.at(-1).customerDocument, "38144092");
  }
  for (const spoken of ["12abc345", "1234", "treinta ocho", "doscientos cuarenta y cuatro veinte"]) {
    const response = await f.POST(request({ ...validIdentity(), customer_document: spoken }));
    assert.deepEqual(await response.json(), { ok: true, verificado: false, condiciones: null, code: "DOCUMENT_NOT_UNDERSTOOD" });
  }
  assert.equal(f.calls.length, 3);
});

test("the two observed ASR payloads with sentence punctuation verify the registered components and exact document", async () => {
  const calls = [];
  const flowSecret = "synthetic-dedicated-identity-flow-key-32-or-more";
  const registered = { name: "LUZ HERNANDEZ", document: "38144092" };
  const POST = http.createCreditWelcomeVoiceIdentityHandler({ verifyToken,
    verifyFlowAuthorization: value => core.verifyWelcomeVoiceIdentityFlowAuthorization(value, { secret: flowSecret }),
    verifyIdentity: async input => {
      calls.push(plain(input));
      return core.matchWelcomeVoiceIdentity(registered, { name: input.customerName, document: documentParser.parseWelcomeVoiceSpokenDocument(input.customerDocument) })
        ? { verificado: true, condiciones: { installmentCount: 18 }, remainingAttempts: 2 } : { verificado: false };
    },
  });
  for (const utterance of ["Treinta y ocho, uno cuarenta y cuatro, cero nueve dos.",
    "treinta y ocho, ciento cuarenta y cuatro, cero noventa y dos.", "Tres ocho uno cuatro cuatro cero nueve dos."]) {
    const response = await POST(request({ event_id: identity.eventId, customer_name: "Luz, que esté a la Hernández.",
      customer_document: utterance }, "identidad", { authorization: `Bearer ${flowSecret}` }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, verificado: true, condiciones: { installmentCount: 18 },
      code: null, nextAction: "CONTINUE", remainingAttempts: 2, question: null, mayEndCall: false });
    assert.equal(calls.at(-1).customerDocument, utterance);
  }
  const wrong = await POST(request({ event_id: identity.eventId, customer_name: "Luz, que esté a la Hernández.",
    customer_document: "tres ocho uno cuatro cuatro cero nueve tres." }, "identidad", { authorization: `Bearer ${flowSecret}` }));
  assert.deepEqual(await wrong.json(), { ok: true, verificado: false, condiciones: null, code: "IDENTITY_NOT_CONFIRMED",
    nextAction: "REVIEW", remainingAttempts: 0, question: "No pude confirmar sus datos. Un asesor revisará su caso.", mayEndCall: true });
});

test("trusted identity flow uses a private HTTP bearer and derives credit scope from the event only", async () => {
  const calls = [];
  const flowSecret = "flow-only-private-key-with-at-least-32-characters";
  const POST = http.createCreditWelcomeVoiceIdentityHandler({ verifyToken,
    verifyFlowAuthorization: value => core.verifyWelcomeVoiceIdentityFlowAuthorization(value, { secret: flowSecret }),
    verifyIdentity: async input => { calls.push(plain(input)); return { verificado: true, condiciones: { installmentCount: 4 } }; },
  });
  const body = { event_id: identity.eventId, customer_name: "Ana María Pérez", customer_document: "0012345678", credit_id: 999 };
  for (const header of [undefined, `Bearer ${token}`, "Bearer wrong", `Bearer ${flowSecret}-bad`]) {
    assert.equal((await POST(request(body, "identidad", header ? { authorization: header } : {}))).status, 401);
  }
  assert.equal(calls.length, 0);
  const header = { authorization: `Bearer ${flowSecret}` };
  assert.equal((await POST(request({ ...body, event_token: token }, "identidad", header))).status, 400);
  assert.equal((await POST(request({ ...body, event_id: "not-uuid" }, "identidad", header))).status, 400);
  assert.equal((await POST(request(body, "identidad", header))).status, 200);
  assert.deepEqual(calls, [{ eventId: identity.eventId, requireFreshDispatch: true, customerName: "Ana María Pérez", customerDocument: "0012345678" }]);
});
test("private flow forwards unrecognized literal documents to the locked store and projects server recovery only", async () => {
  const calls = [], header = { authorization: "Bearer private-flow" };
  let result = { verificado: false, condiciones: { secret: "hidden" }, customer_document: "hidden", code: "DOCUMENT_NOT_UNDERSTOOD",
    nextAction: "ASK_DOCUMENT", remainingAttempts: 2, question: "untrusted extra data", mayEndCall: true };
  const POST = http.createCreditWelcomeVoiceIdentityHandler({ verifyToken, verifyFlowAuthorization: value => value === header.authorization,
    verifyIdentity: async input => { calls.push(plain(input)); return result; } });
  const body = { event_id: identity.eventId, customer_name: "Ana Prueba", customer_document: "doscientos cuarenta y cuatro veinte",
    nextAction: "REVIEW", remainingAttempts: 0, mayEndCall: true, identity_confirmed: true };
  assert.deepEqual(await (await POST(request(body, "identidad", header))).json(), { ok: true, verificado: false, condiciones: null,
    code: "DOCUMENT_NOT_UNDERSTOOD", nextAction: "ASK_DOCUMENT", remainingAttempts: 2,
    question: "¿Me repite su cédula completa? Puede decirla seguida o en bloques.", mayEndCall: false });
  assert.equal(calls[0].customerDocument, body.customer_document); assert.equal(calls[0].requireFreshDispatch, true);
  result = { ...result, nextAction: "ASK_NAME", remainingAttempts: 1, code: "IDENTITY_NOT_CONFIRMED" };
  const second = await (await POST(request(body, "identidad", header))).json();
  assert.equal(second.nextAction, "ASK_NAME"); assert.equal(second.mayEndCall, false); assert.equal(second.question, "¿Me dice un nombre o un apellido, por favor?");
  result = { ...result, remainingAttempts: 0 };
  const terminal = await (await POST(request(body, "identidad", header))).json();
  assert.equal(terminal.nextAction, "REVIEW"); assert.equal(terminal.mayEndCall, true); assert.equal(terminal.condiciones, null);
});

test("callback accepts observed call/data envelopes, normalizes milliseconds, and never trusts model identity", async () => {
  const f = resultFixture();
  for (const wrap of [call => ({ call }), call => ({ data: call }), call => call]) {
    const response = await f.POST(request(wrap(validCall()), "resultado"));
    assert.equal(response.status, 200); assertPrivate(response);
  }
  assert.equal(f.calls.length, 3);
  const saved = f.calls[0];
  assert.equal(saved.eventId, identity.eventId); assert.equal(saved.creditId, identity.creditId);
  assert.equal(saved.durationSeconds, 94); assert.equal(saved.status, "COMPLETED");
  assert.equal(saved.resultCode, "CUSTOMER_DISCREPANCY");
  assert.equal(saved.summary, "Se explicaron las condiciones.");
  assert.match(saved.doubts, /Preguntas:.*consultar el plan/);
  assert.match(saved.doubts, /Diferencias reportadas: La fecha/);
  assert.equal(saved.recordingUrl, "https://app.dapta.ai/call-log/call-example-01");
  for (const key of ["identity_confirmed", "identityVerified", "event_token", "dynamic_variables", "customer_document", "call_analysis"]) assert.equal(key in saved, false);
  assert.deepEqual(f.calls[1], saved); assert.deepEqual(f.calls[2], saved);
});

test("callback accepts the observed provider prefix only for the configured agent UUID and preserves its private call link", async () => {
  const expectedAgent = "a5ec9f40-70dd-4e52-8ecb-79b1a0edf263";
  const f = resultFixture({ expectedAgent });
  const call = validCall();
  call.call_id = "call_66a8c4c3-f2f8-4b4d-8518-c242322ff2ca";
  call.duration_ms = 126347;
  call.recording_url = `https://app.dapta.ai/agents-studio/voice-agents/calls-history/66a8c4c3-f2f8-4b4d-8518-c242322ff2ca?agent_id=${expectedAgent}&segment=transcription`;
  for (const [index, agentId] of [expectedAgent, `agent_${expectedAgent}`].entries()) {
    call.agent_id = agentId;
    const response = await f.POST(request({ event: "call_analyzed", call }, "resultado"));
    assert.equal(response.status, 200); assertPrivate(response);
    assert.deepEqual(await response.json(), { ok: true, duplicate: index > 0 });
  }
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls[1].recordingUrl, call.recording_url);
  assert.equal(f.calls[1].providerCallId, call.call_id);
  assert.equal(f.calls[1].durationSeconds, 126);
  assert.equal(f.calls[1].eventId, identity.eventId);
  assert.equal(f.calls[1].creditId, identity.creditId);
  assert.equal("identityVerified" in f.calls[1], false);
});

test("callback rejects other or altered provider agent prefixes before storage and retains signed event/credit scopes", async () => {
  const expectedAgent = "a5ec9f40-70dd-4e52-8ecb-79b1a0edf263";
  const f = resultFixture({ expectedAgent });
  for (const agentId of ["agent_8d541ef0-e066-45b4-a1c3-cf25c01b04f6", `agent_agent_${expectedAgent}`,
    `Agent_${expectedAgent}`, `agent_${expectedAgent}-extra`, `agent_${expectedAgent} `]) {
    const call = validCall(); call.agent_id = agentId;
    const response = await f.POST(request({ call }, "resultado"));
    assert.equal(response.status, 403); assertPrivate(response);
    assert.deepEqual(await response.json(), { ok: false, code: "CALL_SCOPE_MISMATCH", error: "Solicitud de bienvenida no válida." });
  }
  for (const [change, status] of [
    [call => { call.dynamic_variables.event_token = "invalid"; }, 401],
    [call => { call.dynamic_variables.event_id = "different-event"; }, 403],
    [call => { call.dynamic_variables.credito_id = "73"; }, 403],
    [call => { call.dynamic_variables.credito_id = identity.creditId; }, 403],
  ]) {
    const call = validCall(); call.agent_id = `agent_${expectedAgent}`; change(call);
    assert.equal((await f.POST(request({ call }, "resultado"))).status, status);
  }
  assert.equal(f.calls.length, 0);
});

test("callback correlates agent, event and credit before any write and rejects active/invalid calls", async () => {
  const f = resultFixture();
  const changes = [call => { call.dynamic_variables.event_token = "invalid"; }, call => { delete call.dynamic_variables.event_token; },
    call => { call.dynamic_variables.event_id = "different-event"; }, call => { call.dynamic_variables.credito_id = "73"; },
    call => { call.dynamic_variables.credito_id = 72; }, call => { call.agent_id = "another-agent"; },
    call => { call.call_id = "https://malicious.test"; }, call => { call.call_status = "ongoing"; },
    call => { call.duration_ms = -1; }, call => { call.duration_ms = "93500"; }, call => { call.duration_ms = 86_400_001; },
    call => { call.call_analysis.call_summary = "a".repeat(4001); }, call => { call.transcript = "a".repeat(32769); },
    call => { call.call_analysis.custom_analysis_data.customer_questions = { data: "bad" }; }];
  for (const change of changes) {
    const call = validCall(); change(call);
    assert.ok([400, 401, 403].includes((await f.POST(request({ call }, "resultado"))).status));
  }
  assert.equal(f.calls.length, 0);
  const noAgent = resultFixture({ expectedAgent: "" });
  assert.equal((await noAgent.POST(request({ call: validCall() }, "resultado"))).status, 503);
  assert.equal(noAgent.calls.length, 0);
  assert.equal((await f.POST(request({ call: validCall(), large: "a".repeat(131072) }, "resultado"))).status, 413);
});

test("callback accepts exactly the same safe provider identifier alphabet and length as the dispatcher/store", async () => {
  const f = resultFixture();
  for (const id of ["call.safe-01:provider_1", "c".repeat(160)]) {
    const call = validCall(); call.call_id = id;
    assert.equal((await f.POST(request({ call }, "resultado"))).status, 200);
    assert.equal(f.calls.at(-1).providerCallId, id);
  }
  const accepted = f.calls.length;
  for (const id of ["c".repeat(161), "-bad-start", "call/id", "call?id=1", "call@id"]) {
    const call = validCall(); call.call_id = id;
    assert.equal((await f.POST(request({ call }, "resultado"))).status, 400);
  }
  assert.equal(f.calls.length, accepted);
});

test("unsafe recordings are omitted or replaced only with an authenticated Dapta app link", async () => {
  for (const url of ["javascript:alert(1)", "https://app.dapta.ai.attacker.test/audio", "https://public.audio.test/record.mp3", "https://name:password@app.dapta.ai/call/1", "http://app.dapta.ai/call/1"]) {
    const f = resultFixture(); const call = validCall(); call.recording_url = url;
    call.public_log_url = "https://app.dapta.ai/call-log/private-01";
    assert.equal((await f.POST(request({ call }, "resultado"))).status, 200);
    assert.equal(f.calls[0].recordingUrl, "https://app.dapta.ai/call-log/private-01");
    delete call.public_log_url;
    assert.equal((await f.POST(request({ call }, "resultado"))).status, 200);
    assert.equal(f.calls[1].recordingUrl, null);
  }
});

test("callback retries produce the same normalized result and storage conflicts never leak internals", async () => {
  const f = resultFixture();
  assert.deepEqual(await (await f.POST(request({ call: validCall() }, "resultado"))).json(), { ok: true, duplicate: false });
  assert.deepEqual(await (await f.POST(request({ call: validCall(), ignored: "anything" }, "resultado"))).json(), { ok: true, duplicate: true });
  const conflict = new Error("private document token database call"); conflict.code = "CALL_ID_CONFLICT";
  const conflicting = resultFixture({ error: conflict });
  const response = await conflicting.POST(request({ call: validCall() }, "resultado"));
  assert.equal(response.status, 409); assertPrivate(response);
  assert.doesNotMatch(await response.text(), /private|document|token|database/);
  const failing = identityFixture({ error: new Error("private customer document token database") });
  const failure = await failing.POST(request(validIdentity()));
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /private|customer|document|token|database/);
});

function communicationCall({ turns = [], reason, status = "ended", voicemail = false, recordingAccepted = true, transcript = "", duration = 0 } = {}) {
  return { ...validCall(), call_status: status, disconnection_reason: reason, transcript_object: turns,
    transcript, duration_ms: duration, call_analysis: { in_voicemail: voicemail,
      custom_analysis_data: { recording_accepted: recordingAccepted, identity_confirmed: true, terms_confirmed: true } } };
}
const userTurn = content => ({ role: "user", content, words: [], metadata: {} });
const agentTurn = content => ({ role: "agent", content, words: [], metadata: {} });
const humanTurns = () => [userTurn("Buenos días."), agentTurn("Le escucho."), userTurn("Sí, soy yo.")];
async function saveCommunication(call) {
  const fixture = resultFixture();
  const response = await fixture.POST(request({ event: "call_analyzed", call }, "resultado"));
  assert.equal(response.status, 200); assertPrivate(response);
  assert.deepEqual(await response.json(), { ok: true, duplicate: false });
  return fixture.calls[0];
}

test("terminal callbacks classify known unanswered failures and voicemail without relying on duration", async () => {
  for (const reason of ["voicemail_reached", "dial_no_answer", "dial_failed", "dial_busy", "concurrency_limit_reached", "error_connection_failed"]) {
    const saved = await saveCommunication(communicationCall({ reason, duration: 180000 }));
    assert.equal(saved.communicationOutcome, "NO_ANSWER", reason);
    assert.equal(saved.disconnectionReason, reason);
  }
  for (const status of ["failed", "error", "not_connected", "no_answer", "no-answer"]) {
    const saved = await saveCommunication(communicationCall({ status }));
    assert.equal(saved.communicationOutcome, "NO_ANSWER", status);
    assert.equal(saved.status, "FAILED");
  }
  const voicemail = await saveCommunication(communicationCall({ voicemail: true, turns: [userTurn("Deje su mensaje después del tono.")] }));
  assert.equal(voicemail.communicationOutcome, "NO_ANSWER");
});

test("two meaningful structured user turns establish human contact, while contradictory failure evidence stays uncertain", async () => {
  for (const duration of [0, 300000]) {
    const saved = await saveCommunication(communicationCall({ reason: "agent_hangup", turns: humanTurns(), duration }));
    assert.equal(saved.communicationOutcome, "HUMAN_CONTACT");
    assert.equal(saved.disconnectionReason, "agent_hangup");
    assert.equal("identityVerified" in saved, false);
  }
  for (const evidence of [{ voicemail: true }, { reason: "voicemail_reached" }, { reason: "dial_no_answer" }, { reason: "error_connection_failed" }]) {
    const saved = await saveCommunication(communicationCall({ ...evidence, turns: humanTurns() }));
    assert.equal(saved.communicationOutcome, "UNCERTAIN");
  }
  const failedAfterSpeech = await saveCommunication(communicationCall({ status: "failed", transcript: "Conversación existente sin turnos estructurados." }));
  assert.equal(failedAfterSpeech.communicationOutcome, "UNCERTAIN");
  const interrupted = await saveCommunication(communicationCall({ reason: "dial_busy", turns: [userTurn("¿Con quién hablo?")] }));
  assert.equal(interrupted.communicationOutcome, "UNCERTAIN");
});

test("a confused single turn, model flags and unstructured text cannot claim human contact or verified identity", async () => {
  for (const turns of [[userTurn("¿Con quién hablo?")], [userTurn("   "), userTurn("...")],
    [userTurn("[inaudible]"), userTurn("[silencio]")], [agentTurn("No me llame. Número equivocado."), { role: "tool", content: "Sí, soy yo." }],
    [{ role: "user", content: { text: "Hola" } }, { role: "assistant", content: "Hola" }], "user: Hola. user: Sí."]) {
    const saved = await saveCommunication(communicationCall({ turns, duration: 300000,
      transcript: "Agent: No me llame. User: Hola. User: Sí." }));
    assert.equal(saved.communicationOutcome, "UNCERTAIN");
    for (const key of ["identity_confirmed", "identityVerified", "terms_confirmed", "transcript_object", "event_token"]) assert.equal(key in saved, false);
    assert.equal(saved.transcript, "Agent: No me llame. User: Hola. User: Sí.");
  }
});

test("explicit user opt-outs and recording refusal take precedence over contact and voicemail evidence", async () => {
  for (const utterance of ["Por favor, no me llame más.", "No me llamen.", "No me vuelva a llamar.",
    "No quiero llamadas.", "No quiero recibir más llamadas.", "Es un número equivocado."]) {
    const saved = await saveCommunication(communicationCall({ voicemail: true, reason: "dial_busy",
      turns: [...humanTurns(), userTurn(utterance)] }));
    assert.equal(saved.communicationOutcome, "OPT_OUT", utterance);
  }
  const declined = await saveCommunication(communicationCall({ recordingAccepted: false,
    turns: [userTurn("No autorizo que me graben.")] }));
  assert.equal(declined.communicationOutcome, "OPT_OUT");
  assert.equal(declined.resultCode, "RECORDING_DECLINED");
  const forged = communicationCall();
  forged.communicationOutcome = "HUMAN_CONTACT";
  forged.call_analysis.custom_analysis_data.communicationOutcome = "HUMAN_CONTACT";
  assert.equal((await saveCommunication(forged)).communicationOutcome, "UNCERTAIN");
});

test("a bare no followed by a name correction never becomes recording refusal from a model flag", async () => {
  for (const utterance of ["No, mi nombre es Natalia de la Peña.", "No, viene Natalie a la pesca buena.", "No.", "No, gracias, sí pueden grabar."]) {
    const saved = await saveCommunication(communicationCall({ recordingAccepted: false, reason: "agent_hangup",
      turns: [userTurn(utterance)] }));
    assert.equal(saved.communicationOutcome, "UNCERTAIN", utterance);
    assert.notEqual(saved.resultCode, "RECORDING_DECLINED", utterance);
  }
  const missing = communicationCall({ recordingAccepted: false, reason: "agent_hangup", transcript: "No autorizo que me graben." });
  delete missing.transcript_object;
  const saved = await saveCommunication(missing);
  assert.equal(saved.communicationOutcome, "UNCERTAIN");
  assert.notEqual(saved.resultCode, "RECORDING_DECLINED");
});

test("recording refusal requires explicit structured user speech and remains opt-out despite affirmative model flags", async () => {
  for (const utterance of ["No autorizo que me graben.", "No acepto la grabación.", "No quiero ser grabada.",
    "Prefiero que no me graben.", "Deje de grabarme.", "No estoy de acuerdo con la grabación."]) {
    const saved = await saveCommunication(communicationCall({ recordingAccepted: true,
      turns: [...humanTurns(), userTurn(utterance)] }));
    assert.equal(saved.communicationOutcome, "OPT_OUT", utterance);
    assert.equal(saved.resultCode, "RECORDING_DECLINED", utterance);
  }
  const agentOnly = await saveCommunication(communicationCall({ recordingAccepted: false,
    turns: [agentTurn("No autorizo que me graben.")] }));
  assert.equal(agentOnly.communicationOutcome, "UNCERTAIN");
  assert.notEqual(agentOnly.resultCode, "RECORDING_DECLINED");
});

test("known no-answer and voicemail remain retryable despite a false recording model flag", async () => {
  for (const fields of [{ reason: "dial_no_answer" }, { status: "failed", reason: "dial_busy" },
    { reason: "voicemail_reached", turns: [userTurn("Deje su mensaje después del tono.")] }, { voicemail: true }]) {
    const saved = await saveCommunication(communicationCall({ ...fields, recordingAccepted: false }));
    assert.equal(saved.communicationOutcome, "NO_ANSWER");
    assert.notEqual(saved.resultCode, "RECORDING_DECLINED");
  }
});

test("disconnection reasons are bounded safe codes and normalized callbacks remain replay-stable", async () => {
  for (const reason of ["a".repeat(65), "error_bad private-value", "error_bad\nprivate", "https://private.test", { code: "dial_busy" }]) {
    const saved = await saveCommunication(communicationCall({ reason }));
    assert.equal(saved.disconnectionReason, null);
    assert.equal(saved.communicationOutcome, "UNCERTAIN");
  }
  const f = resultFixture();
  const call = communicationCall({ reason: "DIAL_BUSY" });
  assert.deepEqual(await (await f.POST(request({ call }, "resultado"))).json(), { ok: true, duplicate: false });
  assert.deepEqual(await (await f.POST(request({ call }, "resultado"))).json(), { ok: true, duplicate: true });
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls[0].disconnectionReason, "dial_busy");
  assert.equal(f.calls[0].communicationOutcome, "NO_ANSWER");
});

const user = (patch = {}) => ({ id: 7, activo: true, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY",
  aliadoAccesoId: 2, sedeId: 5, sedeAccesoActiva: true, aliadoAccesoActivo: true, ...patch });
const callView = () => ({ id: identity.eventId, creditId: 72, source: "NORMAL", status: "COMPLETED", providerCallId: "call-example-01",
  createdAt: now.toISOString(), dispatchedAt: now.toISOString(), completedAt: now.toISOString(), durationSeconds: 94,
  identityVerified: false, summary: "Resumen", doubts: "Pregunta", recordingUrl: "https://app.dapta.ai/call-log/private-01",
  audioStorage: "DAPTA_PRIVATE_LINK", resultCode: "TERMS_REVIEWED", transcript: "hidden", snapshot: { document: "hidden" }, event_token: "hidden" });
function readFixture({ actor = user(), seller = null, authorized = true, call = callView(), error } = {}) {
  const calls = { find: [], list: [], seller: [] };
  const GET = http.createCreditWelcomeVoiceReadHandler({ getUser: async () => actor,
    getSeller: async value => { calls.seller.push(value); return seller; },
    findCredit: async (id, scope) => { calls.find.push({ id, scope: plain(scope) }); return authorized ? { id } : null; },
    listCalls: async id => { calls.list.push(id); if (error) throw error; return Array.isArray(call) ? call : [call]; }, safeUrl: core.safeDaptaWelcomeVoiceUrl });
  const read = id => GET(new Request(`https://finser.test/api/creditos/${id}/bienvenida-voz`), { params: Promise.resolve({ id }) });
  return { GET, read, calls };
}

test("credit results require an active project session; no actor, disabled site/ally and unauthorized roles never reach storage", async () => {
  for (const actor of [null, user({ activo: false }), user({ sedeAccesoActiva: false }), user({ aliadoAccesoActivo: false }),
    user({ rolNombre: "VENDEDOR" }), user({ rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "OTHER" })]) {
    const f = readFixture({ actor }); const response = await f.read("72");
    assert.equal(response.status, actor ? 403 : 401); assertPrivate(response);
    assert.equal(f.calls.find.length, 0); assert.equal(f.calls.list.length, 0);
  }
});

test("central admin and central analysts can read central credits, while ally admins/sellers retain credit scopes", async () => {
  for (const actor of [user(), user({ rolNombre: "ANALISTA_APROBACION" })]) {
    const f = readFixture({ actor }); assert.equal((await f.read("72")).status, 200);
    assert.deepEqual(f.calls.find[0], { id: 72, scope: {} }); assert.deepEqual(f.calls.list, [72]);
  }
  const ally = readFixture({ actor: user({ aliadoAccesoCodigo: "OTHER", aliadoAccesoId: 9 }) });
  assert.equal((await ally.read("72")).status, 200); assert.deepEqual(ally.calls.find[0].scope, { sede: { aliadoId: 9 } });
  const salesperson = readFixture({ actor: user({ rolNombre: "VENDEDOR", aliadoAccesoCodigo: "OTHER", aliadoAccesoId: 9 }),
    seller: { activo: true, tipoPerfil: "VENDEDOR", sedeId: 5 } });
  assert.equal((await salesperson.read("72")).status, 200); assert.deepEqual(salesperson.calls.find[0].scope, { sedeId: { in: [5] } });
  const supervisor = readFixture({ actor: user({ rolNombre: "VENDEDOR", aliadoAccesoCodigo: "OTHER", aliadoAccesoId: 9 }),
    seller: { activo: true, tipoPerfil: "SUPERVISOR", sedeId: 5 } });
  assert.equal((await supervisor.read("72")).status, 200); assert.deepEqual(supervisor.calls.find[0].scope, { sede: { aliadoId: 9 } });
  const denied = readFixture({ authorized: false });
  assert.equal((await denied.read("72")).status, 404); assert.equal(denied.calls.list.length, 0);
});

test("credit result reads reject invalid ids, suppress raw PII/token/transcript fields and recheck private links", async () => {
  for (const id of ["0", "-1", "1.2", "1e2", "bad", "9007199254740992"]) {
    const f = readFixture(); assert.equal((await f.read(id)).status, 400); assert.equal(f.calls.find.length, 0);
  }
  const f = readFixture({ call: { ...callView(), recordingUrl: "javascript:alert(1)" } });
  const response = await f.read("72"); assert.equal(response.status, 200); assertPrivate(response);
  const body = await response.json();
  assert.equal(body.items[0].identityVerified, false); assert.equal(body.items[0].recordingUrl, null);
  assert.equal(body.items[0].audioStorage, "UNAVAILABLE");
  assert.equal(body.total, 1);
  for (const key of ["transcript", "snapshot", "event_token", "document", "phone"]) assert.equal(key in body.items[0], false);
  const failing = readFixture({ error: new Error("private customer data database") });
  const failed = await failing.read("72"); assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private|customer|database/);
});

test("history reads expose real scoped count and safe per-attempt destination/outcome without opening calls", async () => {
  const records = Array.from({ length: 12 }, (_, index) => ({ ...callView(), id: `attempt-${index}`,
    destinationPhone: "573000000002", communicationOutcome: "NO_ANSWER", disconnectionReason: "voicemail_reached" }));
  records.push({ ...callView(), creditId: 73, destinationPhone: "573000000003", summary: "another credit" });
  const f = readFixture({ call: records });
  const response = await f.read("72");
  const body = await response.json();
  assert.equal(response.status, 200); assertPrivate(response);
  assert.equal(body.total, 12); assert.equal(body.items.length, 12);
  assert.ok(body.items.every(call => call.creditId === 72 && call.destinationPhone === "573000000002"));
  assert.equal(body.items[0].communicationOutcome, "NO_ANSWER");
  assert.equal(body.items[0].disconnectionReason, "voicemail_reached");
  assert.equal(JSON.stringify(body).includes("another credit"), false);
  assert.deepEqual(f.calls.list, [72]);
  const invalid = readFixture({ call: { ...callView(), destinationPhone: "javascript:secret", communicationOutcome: "invented",
    disconnectionReason: "private user text" } });
  const invalidBody = await (await invalid.read("72")).json();
  assert.equal(invalidBody.items[0].destinationPhone, null);
  assert.equal(invalidBody.items[0].communicationOutcome, null);
  assert.equal(invalidBody.items[0].disconnectionReason, null);
});

test("welcome route wires a scoped lookup, nominal analysts and the manual POST", async () => {
  const seen = [];
  const store = { listCreditWelcomeVoiceCallsForCredit: async id => { seen.push(["list", id]); return [callView()]; } };
  const route = loadReissueModule("app/api/creditos/[id]/bienvenida-voz/route.ts", {
    "@/lib/auth": { getSessionUser: async options => { seen.push(["auth", options]); return options ? user({ rolNombre: "ANALISTA_APROBACION" }) : null; } },
    "@/lib/seller-auth": { getSellerSessionUser: async () => assert.fail("Analysts do not use seller auth") },
    "@/lib/prisma": { default: { credito: { findFirst: async options => { seen.push(["credit", plain(options)]); return { id: 72 }; } } } },
    "@/lib/credit-welcome-voice-http": http, "@/lib/credit-welcome-voice-core": core, "@/lib/credit-welcome-voice-store": store,
    "@/lib/credit-welcome-voice-dispatch": { getCreditWelcomeVoiceConfig: () => null },
    "@/lib/credit-approval-http": { isSameApprovalOrigin: () => true },
  });
  const response = await route.GET(new Request("https://finser.test/api/creditos/72/bienvenida-voz"), { params: Promise.resolve({ id: "72" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(plain(seen), [["auth", null], ["auth", { allowApprovalAnalyst: true }], ["credit", { where: { AND: [{ id: 72 }, {}] }, select: { id: true } }], ["list", 72]]);
  assert.equal(typeof route.POST, "function");
});
