import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import test from "node:test";
import ts from "typescript";

function load(path, dependencies = {}, loose = false) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, Buffer, Uint8Array, Date, URL, Request, Response,
    FormData, File, TextDecoder, console,
    require(name) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return crypto;
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (loose && name.startsWith("@/")) return {};
      assert.fail("Unexpected dependency in " + path + ": " + name);
    },
  }, { filename: path });
  return loadedModule.exports;
}

const { CreditApprovalError } = load("lib/credit-approval-errors.ts");
const writer = load("lib/approval-operations-write.ts", {}, true);
const read = load("lib/approval-operations-read.ts", {
  "@/lib/prisma": { default: {} },
  "@/lib/ally-payments-core": {},
  "@/lib/credit-amortization-contract": { readFinancingTermsSeal: () => null },
  "@/lib/firmaseguro-status": {},
  "@/lib/credit-device-replacement-remission": { getReplacementRemission: async () => null },
  "@/lib/approval-operations-core": { isVerifiedTerminalSignatureFailure: () => false },
});
class OtherOperationalError extends Error {}
const next = { NextResponse: Response };
const origin = "https://finser.test";
const operationId = "10000000-0000-4000-8000-000000000001";
const routePaths = {
  contact: "app/api/aprobaciones/operativo/[kind]/[id]/contacto/route.ts",
  signature: "app/api/aprobaciones/operativo/[kind]/[id]/firma/route.ts",
  redirect: "app/api/aprobaciones/operativo/[kind]/[id]/firma/redireccion/route.ts",
  imei: "app/api/aprobaciones/operativo/[kind]/[id]/imei/route.ts",
};
const context = (kind = "CREDIT", id = "31") => ({ params: Promise.resolve({ kind, id }) });
const endpoint = (suffix) => origin + "/api/aprobaciones/operativo/CREDIT/31/" + suffix;

function jsonRequest(suffix, method, body, headers = {}) {
  return new Request(endpoint(suffix), {
    method, headers: { "content-type": "application/json", origin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function formRequest(entries, headers = {}) {
  const body = new FormData();
  for (const [key, value] of entries) body.append(key, value);
  return new Request(endpoint("imei"), { method: "POST", headers: { origin, ...headers }, body });
}

const imeiFields = [
  ["action", "REQUEST"], ["idempotencyKey", operationId], ["confirmed", "true"],
  ["newImei", "355063664500617"], ["expectedImei", "355063664500618"],
  ["expectedProcessUuid", "20000000-0000-4000-8000-000000000002"],
  ["reason", "Corrección documentada"],
];
const signatureBody = {
  idempotencyKey: operationId, confirmed: true,
  expectedProcessUuid: "20000000-0000-4000-8000-000000000002",
  expectedRevision: 3, expectedReviewHash: "a".repeat(64),
  reason: "Reenviar contrato corregido",
};
const redirectBody = {
  phone: "+57 311 987 6543", reason: "Número anterior sin WhatsApp",
  idempotencyKey: operationId, expectedProcessUuid: "20000000-0000-4000-8000-000000000002",
  confirmed: true,
};

function redirectRequest(body = redirectBody, headers = {}) {
  return new Request(origin + "/api/aprobaciones/operativo/DRAFT/31/firma/redireccion", {
    method: "POST", headers: { "content-type": "application/json", origin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function harness({ user = { id: 7, nombre: "Analista" }, shared = undefined, realWriter = false } = {}) {
  const calls = { session: 0, contact: [], signature: [], redirect: [], imei: [], evidence: [] };
  const auth = { getCreditApprovalSessionUser: async () => { calls.session++; return user; } };
  const sharedSession = { getApprovalSharedRequestActor: async () => shared };
  const approvalHttp = load("lib/credit-approval-http.ts", {
    "next/server": next, "@/lib/auth": auth, "@/lib/roles": {},
    "@/lib/approval-shared-session": sharedSession,
    "@/lib/credit-approval-actor": {
      ApprovalActorAccessError: OtherOperationalError,
      ApprovalActorCreditAccessError: OtherOperationalError,
    },
    "@/lib/credit-approval": { CreditApprovalError },
  });
  const http = load("lib/approval-operations-http.ts", {
    "next/server": next, "@/lib/auth": auth,
    "@/lib/approval-shared-session": sharedSession,
    "@/lib/credit-approval": { CreditApprovalError },
    "@/lib/credit-device-replacement-storage": { CreditDeviceReplacementError: OtherOperationalError },
    "@/lib/firmaseguro-imei-correction": { FirmaSeguroImeiCorrectionError: OtherOperationalError },
    "@/lib/firmaseguro-draft-dispatch-ledger": { DraftDispatchError: OtherOperationalError },
    "@/lib/credit-approval-http": approvalHttp,
    "@/lib/approval-operations-read": read,
    "@/lib/approval-operations-write": { ApprovalOperationalError: writer.ApprovalOperationalError },
  });
  const write = realWriter ? writer : {
    updateOperationalContact: async (...args) => { calls.contact.push(args); return { id: "contact" }; },
    requestOperationalSignature: async (...args) => { calls.signature.push(args); return { id: "signature" }; },
    redirectPendingDraftSignature: async (...args) => { calls.redirect.push(args); return {
      id: operationId, status: "AWAITING_SIGNATURE", message: "Firma reenviada",
      processUuid: "30000000-0000-4000-8000-000000000003",
    }; },
    mutateOperationalImei: async (...args) => { calls.imei.push(args); return { id: "imei" }; },
    parseOperationalEvidence: async (value) => { calls.evidence.push(value); return null; },
  };
  const routes = Object.fromEntries(Object.entries(routePaths).map(([key, path]) => [
    key, load(path, {
      "next/server": next, "@/lib/approval-operations-http": http,
      "@/lib/approval-operations-write": write,
    }),
  ]));
  return { calls, routes, http };
}

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control") || "", /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("la sesión personal ejecuta las rutas operativas con actor, expediente y respuesta privados", async () => {
  const { routes, calls } = harness();
  const contact = await routes.contact.PATCH(jsonRequest("contacto", "PATCH", {
    phone: "3180000000", reason: "Actualización de contacto",
    idempotencyKey: operationId, expectedProcessUuid: signatureBody.expectedProcessUuid,
    expectedRevision: signatureBody.expectedRevision, expectedReviewHash: signatureBody.expectedReviewHash,
  }), context());
  const signature = await routes.signature.POST(jsonRequest("firma", "POST", signatureBody), context());
  const redirect = await routes.redirect.POST(redirectRequest(), context("DRAFT"));
  const imei = await routes.imei.POST(formRequest(imeiFields), context());
  for (const response of [contact, signature, redirect, imei]) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assertPrivate(response);
  }
  assert.equal(calls.session, 4);
  for (const [kind, received] of [["CREDIT", calls.contact], ["CREDIT", calls.signature],
    ["DRAFT", calls.redirect], ["CREDIT", calls.imei]]) {
    assert.equal(received.length, 1);
    assert.equal(received[0][0], kind);
    assert.equal(received[0][1], 31);
    assert.equal(received[0][3].id, 7);
    assert.equal(received[0][3].nombre, "Analista");
  }
  assert.equal(calls.signature[0][2].confirmed, true);
  assert.equal(calls.signature[0][2].expectedRevision, 3);
  assert.equal(calls.contact[0][2].expectedReviewHash, "a".repeat(64));
  assert.equal(calls.redirect[0][2].phone, "+57 311 987 6543");
  assert.equal(calls.redirect[0][2].expectedProcessUuid, redirectBody.expectedProcessUuid);
  assert.equal(calls.redirect[0][2].confirmed, true);
  assert.equal(calls.imei[0][2].confirmed, "true");
  assert.equal(calls.evidence.length, 1);
});

test("sin sesión o con cookie compartida nunca llega al escritor", async () => {
  for (const [settings, status] of [
    [{ user: null }, 401],
    [{ shared: { kind: "SHARED_LINK", id: null } }, 403],
    [{ shared: null }, 403],
  ]) {
    const { routes, calls } = harness(settings);
    for (const [route, method, request] of [
      [routes.contact, "PATCH", jsonRequest("contacto", "PATCH", {})],
      [routes.signature, "POST", jsonRequest("firma", "POST", signatureBody)],
      [routes.redirect, "POST", redirectRequest()],
      [routes.imei, "POST", formRequest(imeiFields)],
    ]) {
      const response = await route[method](request, context());
      assert.equal(response.status, status);
      assertPrivate(response);
    }
    assert.equal(calls.contact.length + calls.signature.length + calls.redirect.length + calls.imei.length, 0);
    assert.equal(calls.evidence.length, 0);
    if (settings.shared !== undefined) assert.equal(calls.session, 0);
  }
});

test("origen ajeno, Fetch Metadata y expediente inválido detienen las escrituras", async () => {
  const { routes, calls } = harness();
  const attempts = [
    [routes.contact, "PATCH", jsonRequest("contacto", "PATCH", {}, { origin: "https://other.test" }), context(), 403],
    [routes.signature, "POST", jsonRequest("firma", "POST", signatureBody,
      { "sec-fetch-site": "cross-site" }), context(), 403],
    [routes.redirect, "POST", redirectRequest(redirectBody, { origin: "https://other.test" }), context("DRAFT"), 403],
    [routes.imei, "POST", formRequest(imeiFields, { origin: "https://other.test" }), context(), 403],
    [routes.contact, "PATCH", jsonRequest("contacto", "PATCH", {}), context("ANDROID"), 400],
    [routes.signature, "POST", jsonRequest("firma", "POST", signatureBody), context("CREDIT", "0"), 400],
  ];
  for (const [route, method, request, target, status] of attempts) {
    const response = await route[method](request, target);
    assert.equal(response.status, status);
    assertPrivate(response);
  }
  assert.equal(calls.contact.length + calls.signature.length + calls.redirect.length + calls.imei.length, 0);
});

test("JSON malformado, no objeto, excesivo o con campos extra no invoca al escritor", async () => {
  const { routes, calls } = harness();
  for (const request of [
    jsonRequest("contacto", "PATCH", "{"),
    jsonRequest("contacto", "PATCH", "[]"),
    jsonRequest("contacto", "PATCH", { phone: "3180000000", actorUserId: 1 }),
    jsonRequest("contacto", "PATCH", { reason: "x".repeat(16 * 1024 + 1) }),
  ]) {
    const response = await routes.contact.PATCH(request, context());
    assert.equal(response.status, 400);
    assertPrivate(response);
  }
  const signature = await routes.signature.POST(jsonRequest("firma", "POST",
    { ...signatureBody, creditId: 999 }), context());
  assert.equal(signature.status, 400);
  const redirect = await routes.redirect.POST(redirectRequest({ ...redirectBody, creditId: 999 }), context("DRAFT"));
  assert.equal(redirect.status, 400);
  assert.equal(calls.contact.length + calls.signature.length + calls.redirect.length, 0);
});

test("multipart malformado, excesivo, duplicado o con campos extra no invoca al escritor", async () => {
  const { routes, calls } = harness();
  const maximum = 10 * 1024 * 1024 + 256 * 1024;
  const attempts = [
    [new Request(endpoint("imei"), {
      method: "POST", headers: { origin, "content-type": "text/plain" }, body: "invalid",
    }), 400],
    [new Request(endpoint("imei"), {
      method: "POST", headers: { origin, "content-type": "multipart/form-data; boundary=missing" },
      body: "invalid",
    }), 400],
    [new Request(endpoint("imei"), {
      method: "POST", headers: {
        origin, "content-type": "multipart/form-data; boundary=x",
        "content-length": String(maximum + 1),
      }, body: "x",
    }), 413],
    [new Request(endpoint("imei"), {
      method: "POST", headers: { origin, "content-type": "multipart/form-data; boundary=x" },
      body: new Uint8Array(maximum + 1),
    }), 413],
    [formRequest([...imeiFields, ["action", "REQUEST"]]), 400],
    [formRequest([...imeiFields, ["actorUserId", "1"]]), 400],
  ];
  for (const [request, status] of attempts) {
    const response = await routes.imei.POST(request, context());
    assert.equal(response.status, status);
    assertPrivate(response);
  }
  assert.equal(calls.imei.length, 0);
  assert.equal(calls.evidence.length, 0);
});

test("IMEI, firma y redirección exigen confirmación explícita antes de consultar esquemas o datos", async () => {
  const { routes } = harness({ realWriter: true });
  const signature = await routes.signature.POST(jsonRequest("firma", "POST",
    { ...signatureBody, confirmed: false }), context());
  const imei = await routes.imei.POST(formRequest(
    imeiFields.map(([key, value]) => [key, key === "confirmed" ? "false" : value])), context());
  const redirect = await routes.redirect.POST(redirectRequest({ ...redirectBody, confirmed: false }), context("DRAFT"));
  for (const response of [signature, redirect, imei]) {
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "CONFIRMATION_REQUIRED");
    assertPrivate(response);
  }
});
