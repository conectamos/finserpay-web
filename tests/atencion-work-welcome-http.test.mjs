import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

class AttentionError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
class CreditApprovalError extends AttentionError {}
class CreditWelcomeVoiceStoreError extends AttentionError {}
const id = "a0000000-0000-4000-8000-000000000001", actor = { type: "attention", actor: { key: "user:5" } };
function fixture() {
  const log = []; let allowed = true, scoped = true, failure = null;
  const service = Object.fromEntries(["read", "voices", "call", "upload", "finish", "recording"].map(method => [method, async (...args) => {
    log.push({ method, args }); if (failure) throw failure;
    if (!scoped) throw new AttentionError("Solicitud no encontrada", 404);
    return { ok: true, result: method };
  }]));
  const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const module = { exports: {} };
  const deps = {
    "server-only": {}, "./atencion-core": { AttentionError }, "./credit-approval-errors": { CreditApprovalError },
    "./credit-welcome-voice-store": { CreditWelcomeVoiceStoreError },
    "./atencion-work-access": { getAttentionWorkAccess: async mode => { assert.equal(mode, "attention"); if (!allowed) throw new AttentionError("No autorizado", 403); return actor; } },
    "./atencion-work-welcome": { attentionWorkWelcome: async () => service },
    "./atencion-http": { attentionJson: json, attentionHttpError: () => json({ error: "No disponible" }, 503),
      assertAttentionOrigin: request => { if (request.headers.get("origin") !== new URL(request.url).origin) throw new AttentionError("Origen no permitido", 403); },
      readAttentionJson: async (request, { maxBytes }) => { const text = await request.text(); if (text.length > maxBytes) throw new AttentionError("Solicitud muy grande", 413); return JSON.parse(text); } },
    "./credit-approval-call-http": { approvalCallRequestHeaders: () => ({ idempotencyKey: id, revision: 1, reviewHash: "review", fileName: "audio.ogg" }),
      readApprovalCallBytes: async () => { log.push({ method: "decode" }); return new Uint8Array([1]); },
      approvalCallAudioResponse: (request, data) => { log.push({ method: "audio", range: request.headers.get("range"), data }); return new Response("audio", { status: 206 }); } },
    "./credit-approval-call-file": { prepareApprovalCallFile: async () => ({ sizeBytes: 1, mimeType: "audio/ogg", sha256: "hash" }) },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/atencion-work-welcome-http.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, URL, require: name => { assert.ok(name in deps, name); return deps[name]; } });
  return { handlers: module.exports.attentionWorkWelcomeHandlers, log,
    deny: () => { allowed = false; }, unscope: () => { scoped = false; }, fail: error => { failure = error; } };
}
const context = (recordingId) => ({ params: Promise.resolve({ id, ...(recordingId ? { recordingId } : {}) }) });
const request = (method = "GET", path = "", body = {}) => new Request(`https://finserpay.test/api/atencion/solicitudes/${id}/bienvenida${path}`, {
  method, headers: { origin: "https://finserpay.test", "content-type": "application/json", "x-work-version": "3", "x-work-context": "a".repeat(64) },
  ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
});

test("welcome work routes require staff access and same origin before every mutation", async () => {
  for (const name of ["call", "upload", "finish"]) {
    const f = fixture(), cross = request("POST"); cross.headers.set("origin", "https://attacker.test");
    assert.equal((await f.handlers[name](cross, context())).status, 403); assert.equal(f.log.length, 0);
    f.deny(); assert.equal((await f.handlers[name](request("POST"), context())).status, 403); assert.equal(f.log.length, 0);
  }
  for (const name of ["read", "voices", "recording"]) {
    const f = fixture(); f.deny(); assert.equal((await f.handlers[name](request(), context(id))).status, 403); assert.equal(f.log.length, 0);
  }
});

test("audio decoding occurs only after case access and playback remains scoped with Range support", async () => {
  const denied = fixture(); denied.unscope();
  assert.equal((await denied.handlers.upload(request("POST"), context())).status, 404);
  assert.deepEqual(denied.log.map(item => item.method), ["read"]);
  const f = fixture(); assert.equal((await f.handlers.upload(request("POST"), context())).status, 200);
  assert.deepEqual(f.log.map(item => item.method), ["read", "decode", "upload"]);
  assert.equal(f.log[2].args[0], actor); assert.equal(f.log[2].args[1], id); assert.equal(f.log[2].args[3], 3);
  assert.equal(f.log[2].args[4], "a".repeat(64));
  const audio = request(); audio.headers.set("range", "bytes=0-9");
  assert.equal((await f.handlers.recording(audio, context(id))).status, 206);
  assert.deepEqual(f.log.at(-2).args, [actor, id, id]); assert.equal(f.log.at(-1).range, "bytes=0-9");
});

test("call recovery rejects ambiguous query inputs and only firm pre-reservation failures release the request", async () => {
  for (const path of ["?creditId=123", `?requestId=${id}&requestId=${id}`]) {
    const f = fixture(); assert.equal((await f.handlers.voices(request("GET", path), context())).status, 400); assert.equal(f.log.length, 0);
  }
  const f = fixture(); f.fail(Object.assign(new CreditWelcomeVoiceStoreError("No se creó", 409), { requestCreated: false }));
  const rejected = await f.handlers.call(request("POST"), context()); assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).requestCreated, false);
  f.fail(new Error("Private provider failure")); const uncertain = await f.handlers.call(request("POST"), context());
  assert.equal(uncertain.status, 503); assert.deepEqual(await uncertain.json(), { error: "No disponible" });
});
