import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { errors, files, http, loadCallModule, tone, request, requestHeaders, oggPageOffsets, rawOggPage, rewriteOggPage } from "./credit-approval-call-test-loader.mjs";

test("call recordings accept real MP3, M4A/MP4 AAC, OGG/Opus and WAV PCM without rewriting the bytes", async () => {
  for (const [fixtureExtension, fileExtension, mimeType] of [
    ["mp3", "mp3", "audio/mpeg"], ["m4a", "m4a", "audio/mp4"],
    ["m4a", "mp4", "audio/mp4"], ["ogg", "ogg", "audio/ogg"], ["wav", "wav", "audio/wav"],
  ]) {
    const bytes = tone(fixtureExtension);
    const result = await files.prepareApprovalCallFile(bytes, `llamada.${fileExtension}`);
    assert.equal(result.fileName, `llamada.${fileExtension}`);
    assert.equal(result.mimeType, mimeType);
    assert.equal(result.sizeBytes, bytes.length);
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.ok(result.bytes.equals(bytes));
  }
});
test("audio-only MP4 with a phone 3gp4 brand accepts AAC without rewriting the recording", async () => {
  const bytes = Buffer.from(tone("m4a"));
  assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  bytes.write("3gp4", 8, "ascii");
  const original = Buffer.from(bytes);
  const result = await files.prepareApprovalCallFile(bytes, "llamada.mp4");
  assert.equal(result.fileName, "llamada.mp4");
  assert.equal(result.mimeType, "audio/mp4");
  assert.equal(result.sizeBytes, original.length);
  assert.equal(result.sha256, createHash("sha256").update(original).digest("hex"));
  assert.ok(result.bytes.equals(original));
});
test("MP4 rejects hasVideo=true when every AAC audio field is otherwise valid", async () => {
  const bytes = tone("m4a");
  const loadWithVideoFlag = (hasVideo) => loadCallModule("lib/credit-approval-call-file.ts", {
    "@/lib/credit-approval-errors": errors,
    "music-metadata": { parseBuffer: async () => ({ format: {
      duration: 0.5, sampleRate: 16000, numberOfChannels: 1,
      hasVideo, container: "M4A", codec: "MPEG-4/AAC",
    } }) },
  });
  const audioOnly = await loadWithVideoFlag(false).prepareApprovalCallFile(bytes, "llamada.mp4");
  assert.equal(audioOnly.mimeType, "audio/mp4");
  await assert.rejects(loadWithVideoFlag(true).prepareApprovalCallFile(bytes, "llamada.mp4"),
    (error) => error.code === "INVALID_CALL_RECORDING");
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
  assert.equal(files.approvalCallFileName("llamada.mp4"), "llamada.mp4");
  assert.equal(files.approvalCallFileName("WhatsApp Audio.ogg"), "WhatsApp Audio.ogg");
  assert.equal(files.approvalCallFileName(encodeURIComponent("..\\llamada\r\n/\u202ewav.wav")), ".._llamada____wav.wav");
  for (const value of ["%FF", "", encodeURIComponent("x".repeat(160) + ".wav"), "x.html", "x.oga"]) {
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

test("OGG/Opus validates every page, logical stream and Opus identification packet", async () => {
  const valid = tone("ogg");
  const corruptCrcPages = oggPageOffsets(valid).map((page) => { const bytes = Buffer.from(valid); bytes[page.offset + 22] ^= 1; return bytes; });
  const change = (pageIndex, mutate) => rewriteOggPage(valid, pageIndex, mutate);
  const invalid = [
    ...corruptCrcPages,
    valid.subarray(0, valid.length - 1),
    Buffer.concat([valid, Buffer.from([0])]),
    change(0, (bytes, page) => { bytes[page.offset + 4] = 1; }),
    change(1, (bytes, page) => { bytes[page.offset + 5] = 0x08; }),
    change(1, (bytes, page) => { bytes[page.offset + 5] = 0x01; }),
    change(0, (bytes, page) => { bytes.writeUInt32LE(1, page.offset + 18); }),
    change(1, (bytes, page) => { bytes.writeUInt32LE(7, page.offset + 18); }),
    change(1, (bytes, page) => { bytes.writeUInt32LE(0x12345678, page.offset + 14); }),
    change(0, (bytes, page) => { const payload = page.offset + 27 + bytes[page.offset + 26]; bytes.write("Vorbis!!", payload, "ascii"); }),
    change(0, (bytes, page) => { const payload = page.offset + 27 + bytes[page.offset + 26]; bytes[payload + 8] = 2; }),
    change(0, (bytes, page) => { const payload = page.offset + 27 + bytes[page.offset + 26]; bytes[payload + 9] = 0; }),
    change(0, (bytes, page) => { const payload = page.offset + 27 + bytes[page.offset + 26]; bytes[payload + 9] = 3; }),
    change(0, (bytes, page) => { const payload = page.offset + 27 + bytes[page.offset + 26]; bytes[payload + 9] = 2; bytes[payload + 18] = 1; }),
    change(1, (bytes, page) => { const payload = page.offset + 27 + bytes[page.offset + 26]; bytes.write("BadTags!", payload, "ascii"); }),
  ];
  const pageAfterEosSource = change(2, (bytes, page) => { bytes[page.offset + 5] = 0; bytes.writeUInt32LE(3, page.offset + 18); });
  const afterEos = oggPageOffsets(pageAfterEosSource)[2];
  const headerPages = valid.subarray(0, oggPageOffsets(valid)[2].offset);
  const brokenContinuation = Buffer.concat([
    headerPages,
    rawOggPage({ flags: 0, granule: -1, sequence: 2, segments: [255], payload: Buffer.alloc(255, 0xf8) }),
    rawOggPage({ flags: 0x01, granule: -1, sequence: 3, segments: [], payload: Buffer.alloc(0) }),
    rawOggPage({ flags: 0x04, granule: 24_000, sequence: 4, segments: [3], payload: Buffer.from([0xf8, 0xff, 0xfe]) }),
  ]);
  invalid.push(Buffer.concat([valid, pageAfterEosSource.subarray(afterEos.offset, afterEos.end)]), brokenContinuation);
  for (const bytes of invalid) {
    await assert.rejects(files.prepareApprovalCallFile(bytes, "llamada.ogg"), (error) => error.code === "INVALID_CALL_RECORDING");
  }
  const withoutEos = change(2, (bytes, page) => { bytes[page.offset + 5] = 0; });
  const accepted = await files.prepareApprovalCallFile(withoutEos, "llamada.ogg");
  assert.ok(accepted.bytes.equals(withoutEos), "EOS is optional when the final packet is complete");
});

test("OGG accepts only audio Opus metadata", async () => {
  const bytes = tone("ogg");
  const base = { duration: 0.5, sampleRate: 16000, numberOfChannels: 1, hasAudio: true, hasVideo: false, container: "Ogg", codec: "Opus" };
  const loadWith = (patch) => loadCallModule("lib/credit-approval-call-file.ts", {
    "@/lib/credit-approval-errors": errors,
    "music-metadata": { parseBuffer: async () => ({ format: { ...base, ...patch } }) },
  });
  assert.equal((await loadWith({}).prepareApprovalCallFile(bytes, "llamada.ogg")).mimeType, "audio/ogg");
  for (const patch of [{ hasVideo: true }, { hasAudio: false }, { codec: "Vorbis" }, { container: "Matroska" },
    { duration: 0 }, { sampleRate: 0 }, { numberOfChannels: 0 }]) {
    await assert.rejects(loadWith(patch).prepareApprovalCallFile(bytes, "llamada.ogg"),
      (error) => error.code === "INVALID_CALL_RECORDING");
  }
});

test("private player preserves OGG headers, filename and byte ranges", async () => {
  const bytes = tone("ogg");
  const recording = { bytes, mimeType: "audio/ogg", fileName: "WhatsApp Audio 2026-09-14 at 3.06.15 PM (1).ogg" };
  const full = http.approvalCallAudioResponse(new Request("https://finserpay.test/audio"), recording);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "audio/ogg");
  assert.match(full.headers.get("content-disposition"), /filename="grabacion\.ogg"/);
  assert.match(full.headers.get("content-disposition"), /filename\*=UTF-8''WhatsApp%20Audio%202026-09-14%20at%203.06.15%20PM%20%281%29\.ogg/);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(bytes));
  const ranged = http.approvalCallAudioResponse(new Request("https://finserpay.test/audio", { headers: { range: "bytes=7-31" } }), recording);
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-type"), "audio/ogg");
  assert.equal(ranged.headers.get("content-range"), "bytes 7-31/" + bytes.length);
  assert.match(ranged.headers.get("content-disposition"), /filename="grabacion\.ogg"/);
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(7, 32)));
});
