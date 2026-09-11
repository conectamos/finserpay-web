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
      if (name === "music-metadata") return musicMetadata;
      assert.ok(name in dependencies, `Unexpected call dependency: ${name}`);
      return dependencies[name];
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
export const tone = (extension = "wav") => readFileSync(new URL(`fixtures/approval-call/tone.${extension}`, import.meta.url));
export const requestHeaders = (overrides = {}) => ({
  host: "finserpay.test", origin: "https://finserpay.test", "sec-fetch-site": "same-origin", "content-type": "application/octet-stream",
  "x-recording-file-name": encodeURIComponent("llamada.wav"), "x-review-revision": "1", "x-review-hash": "a".repeat(64),
  "idempotency-key": "12345678-1234-4234-9234-123456789abc", ...overrides,
});
export const request = (body = tone(), headers = {}) => new Request("https://finserpay.test/api/aprobaciones/81/grabaciones", {
  method: "POST", headers: requestHeaders(headers), body,
});
export const plain = (value) => JSON.parse(JSON.stringify(value));
