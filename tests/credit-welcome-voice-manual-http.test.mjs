import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const http = loadReissueModule("lib/credit-welcome-voice-http.ts", {
  "@/lib/roles": loadReissueModule("lib/roles.ts"),
  "@/lib/aliados": loadReissueModule("lib/aliados.ts"),
  "@/lib/credit-route-lookup": loadReissueModule("lib/credit-route-lookup.ts"),
  "@/lib/credit-welcome-voice-document": loadReissueModule("lib/credit-welcome-voice-document.ts"),
  "@/lib/credit-welcome-voice-phone": loadReissueModule("lib/credit-welcome-voice-phone.ts"),
});
const uuid = "1b088834-d9a8-4052-841f-68cf734160a8";
const actor = patch => ({ id: 7, activo: true, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY",
  aliadoAccesoId: 2, sedeId: 5, sedeAccesoActiva: true, aliadoAccesoActivo: true, ...patch });
function fixture(options = {}) {
  const calls = { find: [], prepare: [], dispatch: [], list: [] }, seen = new Set();
  let status = "DISPATCHING";
  const POST = http.createCreditWelcomeVoiceManualHandler({
    getUser: async () => options.user === undefined ? actor() : options.user,
    sameOrigin: () => options.sameOrigin !== false,
    configured: () => options.configured !== false,
    findCredit: async (id, access) => { calls.find.push({ id, access: JSON.parse(JSON.stringify(access)) }); return options.allowed === false ? null : { id }; },
    prepare: async input => {
      calls.prepare.push(input);
      if (options.error) throw options.error;
      const created = !seen.has(input.requestId); seen.add(input.requestId);
      return { created, eventId: input.requestId, creditId: input.creditId, snapshot: { phone: "573000000001" } };
    },
    dispatch: async claim => { calls.dispatch.push(claim); if (options.dispatchError) throw options.dispatchError; status = options.status ?? "ACCEPTED"; },
    listCalls: async id => { calls.list.push(id); return [{ id: uuid, creditId: id, status, snapshot: "private", eventToken: "private" }]; },
  });
  const post = (body = { requestId: uuid }, id = "72", headers = {}) => POST(new Request(`https://finser.test/api/creditos/${id}/bienvenida-voz`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
  return { calls, post };
}

test("manual welcome requires an active authorized operator and same-origin request before preparing or dispatching", async () => {
  for (const options of [{ user: null }, { user: actor({ activo: false }) }, { user: actor({ sedeAccesoActiva: false }) },
    { user: actor({ aliadoAccesoActivo: false }) }, { user: actor({ rolNombre: "VENDEDOR" }) },
    { user: actor({ rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "OTHER" }) }, { sameOrigin: false }]) {
    const f = fixture(options), response = await f.post();
    assert.ok([401, 403].includes(response.status)); assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.dispatch.length, 0);
  }
  const denied = fixture({ allowed: false });
  assert.equal((await denied.post()).status, 404); assert.equal(denied.calls.prepare.length, 0);
  const ally = fixture({ user: actor({ aliadoAccesoCodigo: "OTHER", aliadoAccesoId: 9 }) });
  await ally.post(); assert.equal(ally.calls.find[0].access.sede.aliadoId, 9);
});

test("manual welcome rejects invalid destinations, financial data or impersonated actor and requires a UUID", async () => {
  const f = fixture();
  for (const body of [{}, { requestId: "wrong" }, { requestId: uuid, phone: "123" },
    { requestId: uuid, actorId: 1 }, { requestId: uuid, source: "CONTROLLED_TEST" },
    { requestId: uuid, installmentAmount: 1 }, { requestId: uuid, origin: "CODEX_AUTHORIZED" }, { requestId: "a".repeat(1100) }]) {
    assert.ok([400, 413].includes((await f.post(body)).status));
  }
  assert.equal((await f.post({ requestId: uuid }, "72", { "content-type": "text/plain" })).status, 415);
  for (const id of ["0", "-1", "72bad", "9007199254740992"]) assert.equal((await f.post({ requestId: uuid }, id)).status, 400);
  assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.dispatch.length, 0);
});

test("manual destination is validated and normalized before preparing the authorized operator call", async () => {
  for (const phone of ["3018297193", "573018297193", "+57 (301) 829-7193"]) {
    const f = fixture();
    const result = await f.post({ requestId: uuid, phone });
    assert.equal(result.status, 202);
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.prepare[0])), { creditId: 72, requestId: uuid, actorId: 7, phone: "573018297193" });
    assert.equal(f.calls.dispatch.length, 1);
    const body = await result.json();
    assert.equal("phone" in body, false);
    assert.equal("snapshot" in body, false);
  }
  for (const phone of [null, false, 3018297193, "", " ", "hello3018297193", "3018297193 ext 7", "+1 3018297193",
    "001573018297193", "6018297193", "30182971939", "++573018297193", "+3018297193", "3018297193\n", " ".repeat(41)]) {
    const f = fixture();
    assert.equal((await f.post({ requestId: uuid, phone })).status, 400, JSON.stringify(phone));
    assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.dispatch.length, 0);
  }
  for (const options of [{ user: actor({ rolNombre: "VENDEDOR" }) }, { user: actor({ activo: false }) }, { sameOrigin: false }, { allowed: false }]) {
    const f = fixture(options);
    assert.ok([403, 404].includes((await f.post({ requestId: uuid, phone: "3018297193" })).status));
    assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.dispatch.length, 0);
  }
});

test("double click or network replay queries the same manual event and sends exactly one provider request", async () => {
  const f = fixture();
  const first = await f.post(); assert.equal(first.status, 202);
  const body = await first.json(); assert.deepEqual(Object.keys(body).sort(), ["eventId", "message", "ok", "status"]);
  assert.equal(body.status, "ACCEPTED"); assert.equal(body.eventId, uuid);
  const replay = await f.post(); assert.equal(replay.status, 200); assert.equal((await replay.json()).eventId, uuid);
  assert.equal(f.calls.dispatch.length, 1); assert.equal(f.calls.prepare.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.prepare[0])), { creditId: 72, requestId: uuid, actorId: 7 });
  assert.equal(first.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(first.headers.get("vary"), "Authorization, Cookie");
});

test("unknown manual result remains a status query and never claims contact or retries a second call", async () => {
  const f = fixture({ status: "UNKNOWN" });
  const result = await (await f.post()).json(); assert.equal(result.status, "UNKNOWN");
  assert.match(result.message, /por confirmar/);
  assert.equal((await (await f.post()).json()).status, "UNKNOWN"); assert.equal(f.calls.dispatch.length, 1);
});

test("definite store rejections release the UUID without claiming an ambiguous call", async () => {
  for (const code of ["OTHER_CALL_IN_FLIGHT", "OPT_OUT", "OPERATOR_EXCLUDED", "OPERATOR_CALL_REQUEST_MISMATCH",
    "OPERATOR_CALL_INELIGIBLE", "OPERATOR_CALL_DOCUMENT_MISMATCH", "OPERATOR_CALL_ATTEMPT_LIMIT"]) {
    const blocked = fixture({ error: Object.assign(new Error("private provider token"), { code, status: 409 }) });
    const response = await blocked.post(); assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, code); assert.equal(body.requestCreated, false);
    assert.equal(JSON.stringify(body).includes("private provider token"), false);
    assert.equal(blocked.calls.dispatch.length, 0);
  }
  // A replay can lose its session/configuration after an earlier reservation.
  // These gates do not consult the ledger and cannot release its saved UUID.
  for (const options of [{ user: null }, { sameOrigin: false }, { configured: false }, { allowed: false }]) {
    assert.equal((await (await fixture(options).post()).json()).requestCreated, undefined);
  }
});

test("unknown prepare failures and errors after reservation preserve the UUID for status recovery", async () => {
  for (const options of [{ error: new Error("database commit unknown") },
    { dispatchError: new Error("provider timeout private token") },
    { dispatchError: Object.assign(new Error("after reservation"), { code: "OTHER_CALL_IN_FLIGHT" }) }]) {
    const f = fixture(options), response = await f.post();
    assert.equal(response.status, 503);
    const body = await response.json(); assert.equal(body.requestCreated, undefined);
    assert.equal(JSON.stringify(body).includes("private token"), false);
  }
});
