import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agreementBlocks = ["plan", "calendar", "device"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = value => typeof value === "string" ? value : "";
const normalized = value => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function recordTime(record, last = false) {
  if (number(record.time_sec) !== null) return record.time_sec;
  if (Array.isArray(record.words) && record.words.length) {
    const word = last ? record.words.at(-1) : record.words[0];
    return object(word) ? number(last ? word.end : word.start) : null;
  }
  return null;
}

function questionBlock(content, current) {
  const value = normalized(content);
  if (!/\besta de acuerdo\b/.test(value)) return null;
  if (/\b(?:aplicativo|bloqueo|bloqueara|activacion)\b/.test(value)) return "device";
  if (/\b(?:primer pago|primera cuota|fechas de pago|primera fecha|calendario)\b/.test(value)) return "calendar";
  if (/\b(?:plan de pagos|financiacion|cuotas|cuota inicial|plazo)\b/.test(value)) return "plan";
  return current;
}

function affirmative(content) {
  if (/[?¿]/.test(content)) return false;
  return /^(?:si|ok|okay|vale|claro|de acuerdo)(?: (?:senor|senora|gracias))?$/.test(normalized(content));
}

function verifiedResult(value) {
  if (!object(value) || value.ok !== true || value.verificado !== true || !object(value.condiciones)) return false;
  const speech = value.condiciones.speech;
  return object(speech)
    && ["initialPayment", "installmentAmount", "installmentCount", "firstDueDate"].every(key => text(speech[key]).trim())
    && Array.isArray(speech.installmentAmounts) && speech.installmentAmounts.length > 0
    && speech.installmentAmounts.every(value => text(value).trim());
}

/** Evaluate evidence in an ended call transcript; this cannot verify audio or future model behavior.
 * Input is a sanitized Dapta call (direct, {call}, or {structuredContent:{call}}).
 * Preserve only transcript roles/content/word times and tool name/type/ts/result_ts/result.
 * Tool arguments, dynamic variables, IDs, URLs, analysis flags and credentials are never inspected.
 */
export function evaluateCreditWelcomeVoiceCallSequence(input) {
  const call = object(input?.structuredContent?.call) ? input.structuredContent.call
    : object(input?.call) ? input.call : input;
  if (!object(call)) throw new Error("INVALID_CALL_INPUT");
  const transcript = Array.isArray(call.transcript_with_tool_calls) ? call.transcript_with_tool_calls
    : Array.isArray(call.transcript_object) ? call.transcript_object : null;
  if (!transcript || transcript.length > 10000) throw new Error("INVALID_CALL_INPUT");
  const tools = Array.isArray(call.tool_calls) ? call.tool_calls : [];
  if (tools.length > 1000) throw new Error("INVALID_CALL_INPUT");
  const issues = new Set();
  const uncertain = new Set();
  const timeline = [];
  let timingComplete = true;
  for (const record of transcript) {
    if (!object(record)) continue;
    const role = record.role === "assistant" ? "agent" : record.role;
    if (role === "agent" || role === "user") {
      const content = text(record.content);
      if (content.length > 100000) throw new Error("INVALID_CALL_INPUT");
      const start = recordTime(record), end = recordTime(record, true);
      if (start === null || end === null) timingComplete = false;
      timeline.push({ role, content, start, end });
    } else if (role === "tool_call_invocation" && record.name === "end_call") {
      timeline.push({ role: "end_call", start: recordTime(record), end: recordTime(record) });
    }
  }
  for (const tool of tools) {
    if (!object(tool)) continue;
    if (tool.name === "end_call") {
      const start = number(tool.ts);
      if (!timeline.some(record => record.role === "end_call" && record.start === start)) timeline.push({ role: "end_call", start, end: start });
    }
  }
  if (timeline.some(record => record.start === null)) timingComplete = false;
  if (timingComplete) timeline.sort((a, b) => a.start - b.start);
  else uncertain.add("TIMING_INCOMPLETE");

  const verifications = tools.filter(tool => object(tool) && tool.name === "verificar_cliente_bienvenida" && verifiedResult(tool.result));
  const verifiedAt = verifications.map(tool => number(tool.result_ts)).filter(value => value !== null);
  if (!verifications.length) issues.add("IDENTITY_NOT_VERIFIED_BY_TOOL");
  else if (!verifiedAt.length) uncertain.add("IDENTITY_ORDER_UNPROVEN");

  const blocks = Object.fromEntries(agreementBlocks.map(block => [block, { questions: 0, confirmed: false }]));
  let current = null;
  let pending = null;
  let firstPlanTime = null;
  let endCallCount = 0;
  let farewellSeen = false;
  let farewellBeforeEnd = false;
  let farewellEnd = null;
  let userReplies = 0;
  for (const record of timeline) {
    if (record.role === "agent") {
      const value = normalized(record.content);
      const block = questionBlock(record.content, current);
      if (block) {
        const blockIndex = agreementBlocks.indexOf(block);
        for (const prerequisite of agreementBlocks.slice(0, blockIndex)) {
          if (!blocks[prerequisite].confirmed) issues.add(`ADVANCED_BEFORE_${prerequisite.toUpperCase()}_AGREEMENT`);
        }
        blocks[block].questions++;
        blocks[block].confirmed = false;
        current = block;
        pending = { block, end: record.end };
        if (block === "plan" && firstPlanTime === null) firstPlanTime = record.start;
      } else if (/[?¿]/.test(record.content)) {
        pending = null;
      }
      if (/\bgracias por su tiempo\b/.test(value)) {
        farewellSeen = true;
        farewellEnd = record.end;
        if (!agreementBlocks.every(block => blocks[block].confirmed)) issues.add("FAREWELL_BEFORE_ALL_AGREEMENTS");
      }
    } else if (record.role === "user") {
      userReplies++;
      if (pending) {
        if (record.start !== null && pending.end !== null && record.start < pending.end) {
          uncertain.add("REPLY_OVERLAPS_QUESTION");
        } else if (affirmative(record.content)) {
          blocks[pending.block].confirmed = true;
        }
        pending = null;
      }
    } else if (record.role === "end_call") {
      endCallCount++;
      for (const block of agreementBlocks) if (!blocks[block].confirmed) issues.add(`END_CALL_WITHOUT_${block.toUpperCase()}_AGREEMENT`);
      if (!farewellSeen) issues.add("END_CALL_WITHOUT_SPOKEN_FAREWELL");
      else if (record.start === null || farewellEnd === null) uncertain.add("FAREWELL_ORDER_UNPROVEN");
      else if (farewellEnd > record.start) issues.add("END_CALL_BEFORE_FAREWELL_FINISHED");
      else farewellBeforeEnd = true;
      break;
    }
  }
  if (!endCallCount) issues.add("END_CALL_NOT_OBSERVED");
  for (const block of agreementBlocks) if (!blocks[block].confirmed) issues.add(`${block.toUpperCase()}_AGREEMENT_NOT_OBSERVED`);
  if (firstPlanTime === null) issues.add("PAYMENT_PLAN_QUESTION_NOT_OBSERVED");
  else if (verifiedAt.length && !verifiedAt.some(time => time <= firstPlanTime)) issues.add("PLAN_BEFORE_VERIFIED_TOOL_RESULT");
  if (!farewellSeen) issues.add("SPOKEN_FAREWELL_NOT_OBSERVED");
  return {
    evaluation: "normal-welcome-transcript-contract",
    status: issues.size ? "FAIL" : uncertain.size ? "INCONCLUSIVE" : "PASS",
    identityVerifiedByTool: verifications.length > 0,
    blocks, userReplies, endCallObserved: endCallCount > 0,
    farewellInTranscript: farewellSeen, farewellBeforeEndCall: farewellBeforeEnd,
    issues: [...issues], inconclusive: [...uncertain],
    limits: { audioVerified: false, futureModelBehaviorGuaranteed: false, analysisFlagsTrusted: false },
  };
}

export function runCreditWelcomeVoiceCallEvaluationCli(args = process.argv.slice(2)) {
  try {
    if (args.length !== 0 && !(args.length === 2 && args[0] === "--input" && args[1])) throw new Error("INVALID_ARGUMENTS");
    const raw = readFileSync(args.length ? args[1] : 0, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 5 * 1024 * 1024) throw new Error("INVALID_CALL_INPUT");
    const report = evaluateCreditWelcomeVoiceCallSequence(JSON.parse(raw));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 2;
  } catch {
    process.stdout.write(JSON.stringify({ status: "INCONCLUSIVE", code: "INVALID_CALL_INPUT", audioVerified: false }) + "\n");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCreditWelcomeVoiceCallEvaluationCli();
}
