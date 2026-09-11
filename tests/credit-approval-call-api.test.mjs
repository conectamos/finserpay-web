import test from "node:test";
import assert from "node:assert/strict";
import { loadCallModule, errors, actors, files, http, baseHttp, tone, request } from "./credit-approval-call-test-loader.mjs";

function setup(fail = "") {
  const events = [];
  const maybeFail = (name) => { events.push(name); if (fail === name) throw new errors.CreditApprovalError(name, "Operación rechazada", name === "auth" ? 401 : 403); };
  const deps = {
    "next/server": { NextResponse: { json: (value, init) => Response.json(value, init) } },
    "@/lib/credit-approval": { approvalCreditId: value => Number(value), getCreditApprovalDetail: async () => ({ callRecording: { available: true, recording: { id: "12345678-1234-4234-9234-123456789abc" } } }) },
    "@/lib/credit-approval-http": { ...baseHttp, getApprovalActor: async () => { maybeFail("auth"); return { id: 1, nombre: "Analista" }; } },
    "@/lib/credit-approval-actor": { ...actors,
      assertApprovalActorActive: async () => maybeFail("active"),
      assertApprovalActorCreditAccess: async () => maybeFail("writeScope"),
      assertApprovalActorCreditReadAccess: async () => maybeFail("readScope"),
    },
    "@/lib/credit-approval-call-http": { ...http, readApprovalCallBytes: async req => { maybeFail("readBody"); return http.readApprovalCallBytes(req); } },
    "@/lib/credit-approval-call-file": files,
    "@/lib/credit-approval-call-store": {
      saveCreditApprovalCall: async (db, id, input, actor) => { maybeFail("save"); return { unchanged: false, state: { available: true, recording: { id: "12345678-1234-4234-9234-123456789abc", sha256: input.sha256, actorName: actor.nombre } } }; },
      readCreditApprovalCallBytes: async () => { maybeFail("readBytes"); return { bytes: tone(), mimeType: "audio/wav", fileName: "x.wav" }; },
    },
    "@/lib/prisma": { default: { $transaction: async (fn, options) => { events.push(options.isolationLevel); return fn({}); } } },
  };
  return { events, upload: loadCallModule("app/api/aprobaciones/[id]/grabaciones/route.ts", deps),
    download: loadCallModule("app/api/aprobaciones/[id]/grabaciones/[recordingId]/route.ts", deps) };
}
const context = { params: Promise.resolve({ id: "81", recordingId: "12345678-1234-4234-9234-123456789abc" }) };

test("upload authenticates and checks active scope before consuming audio", async () => {
  const { upload, events } = setup();
  const response = await upload.POST(request(), context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(events, ["auth", "ReadCommitted", "active", "writeScope", "readBody", "ReadCommitted", "save"]);
  const body = await response.json(); assert.equal(body.ok, true); assert.equal(body.state.available, true);
  assert.equal("bytes" in body.state.recording, false);
});
test("unauthenticated, revoked and out-of-scope uploads do not consume the body or save", async () => {
  for (const fail of ["auth", "active", "writeScope"]) {
    const { upload, events } = setup(fail); const incoming = request();
    const response = await upload.POST(incoming, context);
    assert.ok([401, 403].includes(response.status));
    assert.equal(incoming.bodyUsed, false); assert.equal(events.includes("readBody"), false); assert.equal(events.includes("save"), false);
  }
});
test("cross-origin upload is denied before storage and body processing", async () => {
  const { upload, events } = setup(); const incoming = request(tone(), { origin: "https://hostile.test" });
  const response = await upload.POST(incoming, context);
  assert.equal(response.status, 403); assert.deepEqual(events, ["auth"]); assert.equal(incoming.bodyUsed, false);
});
test("invalid content never reaches the recording write transaction", async () => {
  const { upload, events } = setup();
  const response = await upload.POST(request(Buffer.from("<html>not audio</html>")), context);
  assert.equal(response.status, 415); assert.equal(events.includes("save"), false);
});
test("each audio request, including a range request, verifies read permission before bytes", async () => {
  const { download, events } = setup();
  for (const headers of [{}, { range: "bytes=0-7" }]) {
    const response = await download.GET(new Request("https://finserpay.test/audio", { headers }), context);
    assert.equal(response.status, headers.range ? 206 : 200);
    assert.match(response.headers.get("cache-control"), /private, no-store/);
  }
  assert.deepEqual(events, ["auth", "RepeatableRead", "active", "readScope", "readBytes", "auth", "RepeatableRead", "active", "readScope", "readBytes"]);
});
test("revoked or unauthorized playback never reads stored bytes", async () => {
  for (const fail of ["auth", "active", "readScope"]) {
    const { download, events } = setup(fail);
    const response = await download.GET(new Request("https://finserpay.test/audio", { headers: { range: "bytes=0-7" } }), context);
    assert.ok([401, 403].includes(response.status)); assert.equal(events.includes("readBytes"), false);
  }
});
test("metadata route uses read scope and exposes no media bytes", async () => {
  const { upload, events } = setup();
  const response = await upload.GET(new Request("https://finserpay.test/api/aprobaciones/81/grabaciones"), context);
  assert.equal(response.status, 200); assert.equal(events.includes("readScope"), true); assert.equal(events.includes("readBytes"), false);
  assert.equal("bytes" in (await response.json()).state.recording, false);
});
