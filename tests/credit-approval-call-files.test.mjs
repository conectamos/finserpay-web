import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { files, http, tone, request, requestHeaders } from "./credit-approval-call-test-loader.mjs";

test("call recordings accept real MP3, M4A AAC and WAV PCM without rewriting the bytes", async () => {
  for (const [extension, mimeType] of [["mp3", "audio/mpeg"], ["m4a", "audio/mp4"], ["wav", "audio/wav"]]) {
    const bytes = tone(extension);
    const result = await files.prepareApprovalCallFile(bytes, `llamada.${extension}`);
    assert.equal(result.mimeType, mimeType);
    assert.equal(result.sizeBytes, bytes.length);
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.ok(result.bytes.equals(bytes));
  }
});
test("audio validates content, complete container and matching extension", async () => {
  for (const [bytes, name] of [
    [Buffer.from("<html><script>alert(1)</script></html>"), "x.mp3"],
    [tone(), "x.mp3"], [Buffer.from("ID3" + "\0".repeat(80)), "x.mp3"],
    [tone().subarray(0, 44), "x.wav"], [tone("m4a").subarray(0, 80), "x.m4a"], [Buffer.alloc(0), "x.wav"],
  ]) await assert.rejects(files.prepareApprovalCallFile(bytes, name), (error) => error.code === "INVALID_CALL_RECORDING");
  const fakeWave = Buffer.from(tone()); fakeWave.writeUInt16LE(6, 20);
  await assert.rejects(files.prepareApprovalCallFile(fakeWave, "x.wav"), (error) => error.code === "INVALID_CALL_RECORDING");
});
test("audio parser rejects header-only MPEG pretending to contain a recording", async () => {
  const invalid = Buffer.alloc(64); invalid.set([255, 251, 144, 100]);
  await assert.rejects(files.prepareApprovalCallFile(invalid, "x.mp3"), (error) => error.code === "INVALID_CALL_RECORDING");
});
test("recording filename is bounded and strips paths and control/bidi characters", () => {
  assert.equal(files.approvalCallFileName(encodeURIComponent("..\\llamada\r\n/\u202ewav.wav")), ".._llamada____wav.wav");
  for (const value of ["%FF", "", encodeURIComponent("x".repeat(160) + ".wav"), "x.html"]) {
    assert.throws(() => files.approvalCallFileName(value), (error) => error.code === "INVALID_CALL_RECORDING");
  }
});
test("upload rejects cross-site requests and malformed version or action headers", () => {
  for (const patch of [{ origin: "https://other.test" }, { "sec-fetch-site": "cross-site" },
    { "content-type": "audio/wav" }, { "content-encoding": "gzip" }, { "x-review-revision": "1e3" },
    { "x-review-revision": "2147483648" }, { "x-review-hash": "wrong" }, { "idempotency-key": "wrong" }]) {
    assert.throws(() => http.approvalCallRequestHeaders(request(tone(), patch)));
  }
  assert.equal(http.approvalCallRequestHeaders(request()).revision, 1);
});
test("bounded streaming accepts exactly 10 MiB and rejects more regardless of declared length", async () => {
  const limit = files.APPROVAL_CALL_MAX_BYTES;
  assert.equal((await http.readApprovalCallBytes(request(Buffer.alloc(limit)))).length, limit);
  for (const headers of [{}, { "content-length": "1" }]) {
    await assert.rejects(http.readApprovalCallBytes(request(Buffer.alloc(limit + 1), headers)), (error) => error.status === 413);
  }
  await assert.rejects(http.readApprovalCallBytes(request(tone(), { "content-length": String(limit + 1) })), (error) => error.status === 413);
  await assert.rejects(http.readApprovalCallBytes(request(Buffer.alloc(0))), (error) => error.code === "INVALID_CALL_RECORDING");
});
test("oversized streaming cancels the reader before requesting more bytes", async () => {
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(files.APPROVAL_CALL_MAX_BYTES + 1)); }, cancel() { cancelled = true; } });
  const upload = new Request("https://finserpay.test/upload", { method: "POST", headers: requestHeaders(), body: stream, duplex: "half" });
  await assert.rejects(http.readApprovalCallBytes(upload), (error) => error.status === 413);
  assert.equal(cancelled, true); assert.ok(pulls <= 2);
});
test("private player returns the complete audio and valid byte ranges", async () => {
  const bytes = tone();
  const recording = { bytes, mimeType: "audio/wav", fileName: "llamada ñ.wav" };
  const full = http.approvalCallAudioResponse(new Request("https://finserpay.test/audio"), recording);
  assert.equal(full.status, 200); assert.match(full.headers.get("cache-control"), /private, no-store/);
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(bytes));
  for (const [range, start, end] of [["bytes=0-7", 0, 7], ["bytes=20-", 20, bytes.length - 1], ["bytes=-8", bytes.length - 8, bytes.length - 1]]) {
    const response = http.approvalCallAudioResponse(new Request("https://finserpay.test/audio", { headers: { range } }), recording);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes.subarray(start, end + 1)));
  }
});
test("private player rejects invalid, multiple and out-of-bounds byte ranges", () => {
  for (const range of ["bytes=-", "bytes=-0", "bytes=9-2", "bytes=999999-", "bytes=0-2,4-6", "items=0-2", "bytes=999999999999999999999-"]) {
    const response = http.approvalCallAudioResponse(new Request("https://finserpay.test/audio", { headers: { range } }), { bytes: tone(), mimeType: "audio/wav", fileName: "x.wav" });
    assert.equal(response.status, 416); assert.equal(response.headers.get("content-range"), `bytes */${tone().length}`);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
});
