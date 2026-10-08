import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const roles = loadReissueModule("lib/roles.ts");
const allies = loadReissueModule("lib/aliados.ts");
const lookup = loadReissueModule("lib/credit-route-lookup.ts");
const core = loadReissueModule("lib/credit-welcome-voice-core.ts");
const http = loadReissueModule("lib/credit-welcome-voice-http.ts", {
  "@/lib/roles": roles, "@/lib/aliados": allies, "@/lib/credit-route-lookup": lookup,
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
  assert.deepEqual(f.calls, [{ ...identity, customerName: "Ana María Pérez", customerDocument: "00.123.456-78" }]);
  assert.deepEqual(await response.json(), { ok: true, verificado: true, condiciones: { installmentCount: 4, installmentAmount: 130000 } });
  const denied = identityFixture({ result: { verificado: false, condiciones: { secret: "hidden" }, customer_document: "hidden" } });
  assert.deepEqual(await (await denied.POST(request(validIdentity()))).json(), { ok: true, verificado: false });
});

test("identity validates strings and enforces actual byte limits, JSON object and content type before backend matching", async () => {
  const f = identityFixture();
  for (const body of [[], null, "{", { ...validIdentity(), customer_name: 1 }, { ...validIdentity(), customer_name: "" },
    { ...validIdentity(), customer_name: "a".repeat(241) }, { ...validIdentity(), customer_document: 12345678 },
    { ...validIdentity(), customer_document: "12abc345" }, { ...validIdentity(), customer_document: "1234" },
    { ...validIdentity(), customer_name: "Ana\u0000Pérez" }]) {
    assert.equal((await f.POST(request(body))).status, 400);
  }
  assert.equal((await f.POST(request(validIdentity(), "identidad", { "content-type": "text/plain" }))).status, 415);
  const tooLarge = { ...validIdentity(), ignored: "ñ".repeat(2100) };
  assert.equal((await f.POST(request(tooLarge, "identidad", { "content-length": "1" }))).status, 413);
  assert.equal((await f.POST(request(validIdentity(), "identidad", { "content-length": "5000" }))).status, 413);
  assert.equal(f.calls.length, 0);
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
    listCalls: async id => { calls.list.push(id); if (error) throw error; return [call]; }, safeUrl: core.safeDaptaWelcomeVoiceUrl });
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
  for (const key of ["transcript", "snapshot", "event_token", "document", "phone"]) assert.equal(key in body.items[0], false);
  const failing = readFixture({ error: new Error("private customer data database") });
  const failed = await failing.read("72"); assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private|customer|database/);
});

test("GET route wires a scoped id-only lookup and accepts nominal analysts after a regular session lookup", async () => {
  const seen = [];
  const store = { listCreditWelcomeVoiceCallsForCredit: async id => { seen.push(["list", id]); return [callView()]; } };
  const route = loadReissueModule("app/api/creditos/[id]/bienvenida-voz/route.ts", {
    "@/lib/auth": { getSessionUser: async options => { seen.push(["auth", options]); return options ? user({ rolNombre: "ANALISTA_APROBACION" }) : null; } },
    "@/lib/seller-auth": { getSellerSessionUser: async () => assert.fail("Analysts do not use seller auth") },
    "@/lib/prisma": { default: { credito: { findFirst: async options => { seen.push(["credit", plain(options)]); return { id: 72 }; } } } },
    "@/lib/credit-welcome-voice-http": http, "@/lib/credit-welcome-voice-core": core, "@/lib/credit-welcome-voice-store": store,
  });
  const response = await route.GET(new Request("https://finser.test/api/creditos/72/bienvenida-voz"), { params: Promise.resolve({ id: "72" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(plain(seen), [["auth", null], ["auth", { allowApprovalAnalyst: true }], ["credit", { where: { AND: [{ id: 72 }, {}] }, select: { id: true } }], ["list", 72]]);
  assert.equal("POST" in route, false);
});
