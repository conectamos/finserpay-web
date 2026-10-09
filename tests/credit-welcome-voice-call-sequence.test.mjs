import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { evaluateCreditWelcomeVoiceCallSequence as evaluate } from "../scripts/verify-credit-welcome-voice-call.mjs";

const message = (role, content, start, end = start + 1) => ({ role, content, words: [{ start, end, word: content }], metadata: {} });
const plan = "Su financiación tiene un plazo de varias cuotas. ¿Está de acuerdo?";
const calendar = "Su primer pago está para la fecha informada. ¿Está de acuerdo?";
const device = "El dispositivo cuenta con un aplicativo de bloqueo. ¿Está de acuerdo?";
const endCall = time => ({ role: "tool_call_invocation", name: "end_call", type: "end_call", time_sec: time });
const verified = time => ({ name: "verificar_cliente_bienvenida", type: "custom", ts: time - 1, has_result: true, result_ts: time,
  result: { ok: true, verificado: true, condiciones: { speech: {
    initialPayment: "importe de prueba", installmentCount: "cuotas de prueba", installmentAmount: "importe de prueba",
    firstDueDate: "fecha de prueba", installmentAmounts: ["importe de prueba"],
  } } } });
const complete = () => ({ transcript_with_tool_calls: [
  message("agent", plan, 3), message("user", "Sí.", 5),
  message("agent", calendar, 7), message("user", "Ok.", 9),
  message("agent", device, 11), message("user", "De acuerdo.", 13),
  message("agent", "Gracias por su tiempo.", 15), endCall(17),
], tool_calls: [verified(2), { name: "end_call", ts: 17, result: null, has_result: false }] });

test("a real-format transcript with three independent replies and an explicit farewell passes only the transcript contract", () => {
  const report = evaluate({ structuredContent: { call: complete() } });
  assert.equal(report.status, "PASS");
  assert.equal(report.identityVerifiedByTool, true);
  assert.equal(report.farewellBeforeEndCall, true);
  for (const block of ["plan", "calendar", "device"]) assert.equal(report.blocks[block].confirmed, true);
  assert.deepEqual(report.limits, { audioVerified: false, futureModelBehaviorGuaranteed: false, analysisFlagsTrusted: false });
});

test("the observed anonymized tail fails: a plan clarification is answered, but policy question is followed immediately by end_call", () => {
  const call = { transcript_with_tool_calls: [
    message("agent", plan, 3), message("user", "¿Me confirma el plazo?", 5),
    message("agent", "El plazo es el informado. ¿Está de acuerdo?", 7), message("user", "Sí.", 9),
    message("agent", calendar, 11), message("user", "Ok.", 13),
    message("agent", device, 15), endCall(17),
  ], tool_calls: [verified(2), { name: "end_call", ts: 17, result: null }],
  call_analysis: { call_successful: true, custom_analysis_data: { terms_confirmed: true } },
  general_tools: [{ name: "end_call", speak_during_execution: true, execution_message_description: "Gracias por su tiempo." }] };
  const report = evaluate(call);
  assert.equal(report.status, "FAIL");
  assert.equal(report.blocks.plan.questions, 2);
  assert.equal(report.blocks.plan.confirmed, true);
  assert.equal(report.blocks.calendar.confirmed, true);
  assert.equal(report.blocks.device.confirmed, false);
  assert.ok(report.issues.includes("END_CALL_WITHOUT_DEVICE_AGREEMENT"));
  assert.ok(report.issues.includes("END_CALL_WITHOUT_SPOKEN_FAREWELL"));
});

test("a clarification and repeated agreement question may add turns without becoming a fourth required agreement", () => {
  const call = complete();
  call.transcript_with_tool_calls.splice(1, 1,
    message("user", "¿Me confirma el plazo?", 4.1, 4.4),
    message("agent", "El plazo ya informado. ¿Está de acuerdo?", 4.5, 4.8),
    message("user", "Sí.", 5));
  const report = evaluate(call);
  assert.equal(report.status, "PASS");
  assert.equal(report.blocks.plan.questions, 2);
  assert.equal(report.userReplies, 4);
});

test("previous replies, silence, a question and a qualified yes cannot stand in for the third agreement", () => {
  for (const reply of [null, "", "¿Sí?", "Sí, pero no estoy de acuerdo.", "No."]) {
    const call = complete();
    if (reply === null) call.transcript_with_tool_calls.splice(5, 1);
    else call.transcript_with_tool_calls[5] = message("user", reply, 13);
    const report = evaluate(call);
    assert.equal(report.status, "FAIL");
    assert.equal(report.blocks.device.confirmed, false);
    assert.ok(report.issues.includes("END_CALL_WITHOUT_DEVICE_AGREEMENT"));
  }
});

test("identity must be proven by an earlier successful tool result with complete speech, never by model analysis", () => {
  for (const change of [
    call => { call.tool_calls[0].result.verificado = false; },
    call => { call.tool_calls[0].result.verificado = "true"; },
    call => { delete call.tool_calls[0].result.condiciones.speech.firstDueDate; },
    call => { call.tool_calls[0].result_ts = 8; },
    call => { call.tool_calls = call.tool_calls.slice(1); },
  ]) {
    const call = complete(); change(call);
    call.call_analysis = { custom_analysis_data: { identity_confirmed: true, terms_confirmed: true } };
    assert.equal(evaluate(call).status, "FAIL");
  }
});

test("native farewell configuration is not speech evidence, and end_call cannot precede completion of explicit farewell text", () => {
  const missing = complete();
  missing.transcript_with_tool_calls.splice(6, 1);
  missing.general_tools = [{ name: "end_call", execution_message_description: "Gracias por su tiempo.", speak_during_execution: true }];
  assert.ok(evaluate(missing).issues.includes("END_CALL_WITHOUT_SPOKEN_FAREWELL"));
  const clipped = complete();
  clipped.transcript_with_tool_calls[6].words[0].end = 18;
  assert.ok(evaluate(clipped).issues.includes("END_CALL_BEFORE_FAREWELL_FINISHED"));
});

test("unknown timing is inconclusive rather than claiming a verified ordering or audio", () => {
  const call = complete();
  delete call.tool_calls[0].result_ts;
  const report = evaluate(call);
  assert.equal(report.status, "INCONCLUSIVE");
  assert.ok(report.inconclusive.includes("IDENTITY_ORDER_UNPROVEN"));
  assert.equal(report.limits.audioVerified, false);
});

test("the reusable evaluator never reads or reports arguments, private variables, identifiers or transcript content", () => {
  const call = complete();
  for (const tool of call.tool_calls) Object.defineProperty(tool, "arguments", { get() { throw new Error("Never inspect arguments"); } });
  Object.defineProperty(call, "dynamic_variables", { get() { throw new Error("Never inspect variables"); } });
  call.transcript_with_tool_calls.unshift(message("user", "PRIVATE_CUSTOMER_MARKER", 0));
  call.call_id = "PRIVATE_CALL_MARKER";
  const report = JSON.stringify(evaluate(call));
  assert.doesNotMatch(report, /PRIVATE_|Gracias|financiación|speech|argument/);
});

test("CLI evaluates the same actual function from stdin and emits sanitized failure codes without raw data", () => {
  const call = complete();
  call.transcript_with_tool_calls.splice(5, 1);
  call.dynamic_variables = { event_token: "PRIVATE_TOKEN_MARKER" };
  call.tool_calls[0].arguments = { secret: "PRIVATE_WEBHOOK_MARKER" };
  const result = spawnSync(process.execPath, ["scripts/verify-credit-welcome-voice-call.mjs"], {
    cwd: new URL("../", import.meta.url), input: JSON.stringify(call), encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "FAIL");
  assert.ok(report.issues.includes("END_CALL_WITHOUT_DEVICE_AGREEMENT"));
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|Gracias|financiación/);
});
