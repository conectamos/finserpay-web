import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
function compile(file, mocks) {
  const source = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(name => { assert.ok(name in mocks, `Unexpected dependency: ${name}`); return mocks[name]; }, loaded, loaded.exports);
  return loaded.exports;
}
class AttentionError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Array(20).fill(0)]);
const ogg = Buffer.from("OggS mock OpusHead");
function harness(mode = "success") {
  const calls = []; const children = [];
  const audio = compile("lib/atencion-audio.ts", {
    "server-only": {}, "./atencion-core": { AttentionError },
    "./atencion-meta-http": { readAttentionBody: async (request, max) => { const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.length > max) throw new AttentionError("Too big", 413); return bytes; } },
    "./atencion-meta": { validateMetaAttentionMedia: input => { if(input.mimeType==="audio/mp4"){assert.equal(Buffer.from(input.bytes).toString("ascii",4,8),"ftyp");return;}assert.equal(input.mimeType, "audio/ogg"); assert.deepEqual(Buffer.from(input.bytes), ogg); } },
    "node:child_process": { spawn: (...args) => {
      calls.push(args); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", -1)); };
      child.stdin.on("finish", () => queueMicrotask(() => {
        if (mode === "success") { child.stdout.write(ogg); child.emit("close", 0); }
        if (mode === "invalid") child.emit("close", 1);
        if (mode === "missing") child.emit("error", new Error("private process detail"));
      }));
      children.push(child); return child;
    } },
  });
  return { ...audio, calls, children };
}
function request(bytes = webm, type = "audio/webm", extras) {
  const body = new FormData(); body.set("file", new File([bytes], "voice.webm", { type })); extras?.(body);
  return new Request("https://finser.example/api/atencion/id/audio", { method: "POST", body });
}
test("recordings require one bounded browser audio, reject forged types and fields", async () => {
  const h = harness(); assert.deepEqual(Buffer.from(await h.readAttentionRecording(request())), webm);
  await assert.rejects(h.readAttentionRecording(request(webm, "video/webm")), { status: 415 });
  await assert.rejects(h.readAttentionRecording(request(Buffer.from("not a webm recording"))), { status: 415 });
  await assert.rejects(h.readAttentionRecording(request(webm, "audio/webm", form => form.append("file", new File([webm], "extra.webm", { type: "audio/webm" })))), { status: 400 });
  await assert.rejects(h.readAttentionRecording(request(webm, "audio/webm", form => form.set("url", "file:///etc/passwd"))), { status: 400 });
  await assert.rejects(h.readAttentionRecording(request(Buffer.alloc(8 * 1024 * 1024 + 1))), { status: 413 });
});

test("WebM,OGG yMP4 grabados se convierten con demuxerfijo aOGGOpus sin confiar en extensión",async()=>{
  const mp4=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from("ftypisom00000000")]);
  for(const [bytes,type,format] of [[webm,"audio/webm","matroska"],[ogg,"audio/ogg;codecs=opus","ogg"],[mp4,"audio/mp4","mov"]]) {
    const h=harness();assert.deepEqual(Buffer.from(await h.readAttentionRecording(request(bytes,type))),bytes);
    assert.deepEqual(Buffer.from(await h.convertAttentionRecording(bytes)),ogg);
    const args=h.calls[0][1];assert.equal(args[args.indexOf("-f")+1],format);assert.equal(args[args.indexOf("-protocol_whitelist")+1],"pipe");
  }
  await assert.rejects(harness().readAttentionRecording(request(webm,"audio/mp4")),{status:415});
  await assert.rejects(harness().convertAttentionRecording(Buffer.from("playlist https://outside.invalid/file")),{status:415});
});
test("conversion uses pipe-only forced WebM, Opus mono, bounded duration, no shell", async () => {
  const h = harness(); assert.deepEqual(Buffer.from(await h.convertAttentionRecording(webm)), ogg);
  const [binary, args, options] = h.calls[0]; assert.equal(binary, "ffmpeg"); assert.equal(options.shell, false);
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "pipe");
  assert.equal(args[args.indexOf("-f") + 1], "matroska");
  assert.equal(args[args.indexOf("-t") + 1], "300"); assert.equal(args[args.indexOf("-ac") + 1], "1");
  assert.equal(args[args.indexOf("-c:a") + 1], "libopus"); assert.equal(args.at(-1), "pipe:1");
});
test("cancel stops conversion and capacity is released; aborted requests never spawn", async () => {
  const h = harness("wait"); const controller = new AbortController();
  const pending = h.convertAttentionRecording(webm, controller.signal); controller.abort();
  await assert.rejects(pending, { status: 408 }); assert.equal(h.children[0].killed, true);
  await assert.rejects(h.convertAttentionRecording(webm, controller.signal), { status: 408 }); assert.equal(h.calls.length, 1);
});
test("decoder errors are sanitized and conversions enforce concurrency bound", async () => {
  await assert.rejects(harness("missing").convertAttentionRecording(webm), error => error.status === 503 && !error.message.includes("private"));
  await assert.rejects(harness("invalid").convertAttentionRecording(webm), { status: 415 });
  const h = harness("wait"); const a = new AbortController(); const b = new AbortController();
  const one = h.convertAttentionRecording(webm, a.signal); const two = h.convertAttentionRecording(webm, b.signal);
  await assert.rejects(h.convertAttentionRecording(webm), { status: 429 }); a.abort(); b.abort();
  await Promise.all([assert.rejects(one, { status: 408 }), assert.rejects(two, { status: 408 })]);
});
test("route checks scope and reply window before reading and again before returning audio", async () => {
  for (const mode of ["closed", "reassigned", "allowed"]) {
    let reads = 0; let checks = 0;
    const route = compile("app/api/atencion/[id]/audio/route.ts", {
      "@/lib/atencion-core": { AttentionError, getAttentionAccess: async () => ({ userId: 1 }) },
      "@/lib/atencion-http": { assertAttentionOrigin: () => {}, attentionUuid: value => value, attentionHttpError: error => Response.json({ error: error.message }, { status: error.status }) },
      "@/lib/atencion-audio": { readAttentionRecording: async () => { reads++; return webm; }, convertAttentionRecording: async () => ogg },
      "@/lib/atencion-meta-service": { attentionMetaRuntime: async () => ({ store: { getMessaging: async () => {
        checks++; if (mode === "reassigned" && checks === 2) throw new AttentionError("Not found", 404);
        return { canReply: mode !== "closed", reason: "Window closed" };
      } } }) },
    });
    const response = await route.POST(request(), { params: Promise.resolve({ id: "fixture" }) });
    assert.equal(response.status, mode === "allowed" ? 200 : mode === "closed" ? 409 : 404);
    assert.equal(reads, mode === "closed" ? 0 : 1);
    if (mode === "allowed") { assert.match(response.headers.get("cache-control"), /private, no-store/); assert.equal(response.headers.get("content-type"), "audio/ogg"); }
  }
});
