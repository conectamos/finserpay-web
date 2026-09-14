import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import * as musicMetadata from "music-metadata";
import ts from "typescript";

export function loadCallModule(path, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const loaded = { exports: {} };
  runInNewContext(outputText, {
    module: loaded, exports: loaded.exports,
    require(name) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return crypto;
      if (name in dependencies) return dependencies[name];
      if (name === "music-metadata") return musicMetadata;
      assert.fail(`Unexpected call dependency: ${name}`);
    }, Buffer, Uint8Array, console, URL, URLSearchParams, Date, Request, Response, TextDecoder,
  }, { filename: path });
  return loaded.exports;
}
export const errors = loadCallModule("lib/credit-approval-errors.ts");
export const actors = loadCallModule("lib/credit-approval-actor.ts");
export const files = loadCallModule("lib/credit-approval-call-file.ts", { "@/lib/credit-approval-errors": errors });
export const stateModule = loadCallModule("lib/credit-approval-call-state.ts");
export const baseHttp = loadCallModule("lib/credit-approval-http.ts", {
  "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
  "@/lib/auth": { getCreditApprovalSessionUser: async () => null },
  "@/lib/roles": { canReviewCreditApprovals: () => false },
  "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => undefined },
  "@/lib/credit-approval-actor": actors,
  "@/lib/credit-approval": errors,
});
export const http = loadCallModule("lib/credit-approval-call-http.ts", {
  "@/lib/credit-approval-errors": errors, "@/lib/credit-approval-http": baseHttp, "@/lib/credit-approval-call-file": files,
});
const OGG_SERIAL = 0x46505352;
const opusHead = () => {
  const packet = Buffer.alloc(19);
  packet.write("OpusHead", 0, "ascii");
  packet[8] = 1;
  packet[9] = 1;
  packet.writeUInt16LE(0, 10);
  packet.writeUInt32LE(16_000, 12);
  packet.writeInt16LE(0, 16);
  packet[18] = 0;
  return packet;
};
const opusTags = () => {
  const vendor = Buffer.from("FINSER PAY synthetic test tone", "utf8");
  const packet = Buffer.alloc(16 + vendor.length);
  packet.write("OpusTags", 0, "ascii");
  packet.writeUInt32LE(vendor.length, 8);
  vendor.copy(packet, 12);
  packet.writeUInt32LE(0, 12 + vendor.length);
  return packet;
};

export function oggCrc32(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

export function rawOggPage({ flags, granule, sequence, segments, payload, serial = OGG_SERIAL }) {
  const page = Buffer.alloc(27 + segments.length + payload.length);
  page.write("OggS", 0, "ascii");
  page[4] = 0; page[5] = flags;
  page.writeBigInt64LE(BigInt(granule), 6);
  page.writeUInt32LE(serial >>> 0, 14);
  page.writeUInt32LE(sequence >>> 0, 18);
  page.writeUInt32LE(0, 22);
  page[26] = segments.length;
  Buffer.from(segments).copy(page, 27);
  payload.copy(page, 27 + segments.length);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

function oggPage({ flags, granule, sequence, packets, serial = OGG_SERIAL }) {
  const segments = [];
  const payloads = [];
  for (const packet of packets) {
    let offset = 0;
    while (packet.length - offset >= 255) {
      segments.push(255); payloads.push(packet.subarray(offset, offset + 255)); offset += 255;
    }
    segments.push(packet.length - offset); payloads.push(packet.subarray(offset));
  }
  const payload = Buffer.concat(payloads);
  const page = Buffer.alloc(27 + segments.length + payload.length);
  page.write("OggS", 0, "ascii");
  page[4] = 0; page[5] = flags;
  page.writeBigInt64LE(BigInt(granule), 6);
  page.writeUInt32LE(serial >>> 0, 14);
  page.writeUInt32LE(sequence >>> 0, 18);
  page.writeUInt32LE(0, 22);
  page[26] = segments.length;
  Buffer.from(segments).copy(page, 27);
  payload.copy(page, 27 + segments.length);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

export function syntheticOggOpusTone() {
  const silencePacket = Buffer.from([0xf8, 0xff, 0xfe]);
  return Buffer.concat([
    oggPage({ flags: 0x02, granule: 0, sequence: 0, packets: [opusHead()] }),
    oggPage({ flags: 0, granule: 0, sequence: 1, packets: [opusTags()] }),
    oggPage({ flags: 0x04, granule: 24_000, sequence: 2, packets: Array.from({ length: 25 }, () => silencePacket) }),
  ]);
}

export function oggPageOffsets(bytes) {
  const offsets = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.subarray(offset, offset + 4).toString("ascii") !== "OggS" || offset + 27 > bytes.length) throw new Error("Invalid synthetic Ogg fixture");
    const segmentCount = bytes[offset + 26];
    const headerEnd = offset + 27 + segmentCount;
    let payloadLength = 0;
    for (let index = offset + 27; index < headerEnd; index++) payloadLength += bytes[index];
    const end = headerEnd + payloadLength;
    if (end > bytes.length) throw new Error("Invalid synthetic Ogg fixture");
    offsets.push({ offset, end }); offset = end;
  }
  return offsets;
}

export function rewriteOggPage(bytes, pageIndex, mutate) {
  const output = Buffer.from(bytes);
  const page = oggPageOffsets(output)[pageIndex];
  mutate(output, page);
  output.writeUInt32LE(0, page.offset + 22);
  output.writeUInt32LE(oggCrc32(output.subarray(page.offset, page.end)), page.offset + 22);
  return output;
}

export const tone = (extension = "wav") => extension === "ogg"
  ? syntheticOggOpusTone()
  : readFileSync(new URL(`fixtures/approval-call/tone.${extension}`, import.meta.url));
export const requestHeaders = (overrides = {}) => ({
  host: "finserpay.test", origin: "https://finserpay.test", "sec-fetch-site": "same-origin", "content-type": "application/octet-stream",
  "x-recording-file-name": encodeURIComponent("llamada.wav"), "x-review-revision": "1", "x-review-hash": "a".repeat(64),
  "idempotency-key": "12345678-1234-4234-9234-123456789abc", ...overrides,
});
export const request = (body = tone(), headers = {}) => new Request("https://finserpay.test/api/aprobaciones/81/grabaciones", {
  method: "POST", headers: requestHeaders(headers), body,
});
export const plain = (value) => JSON.parse(JSON.stringify(value));
