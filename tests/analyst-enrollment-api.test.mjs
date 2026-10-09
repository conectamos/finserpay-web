import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule as load } from "./credit-approval-reissue-fixture.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const errors = load("lib/credit-approval-errors.ts");
const roles = load("lib/roles.ts");
class IphoneEnrollmentDiagnosticError extends Error {}
class IphoneEnrollmentGrantError extends Error {}
class IphoneEnrollmentApprovalError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
class CreditDeviceReplacementError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
const paths = {
  session: "app/api/aprobaciones/enrolamiento/session/route.ts",
  cases: "app/api/aprobaciones/enrolamiento/cases/route.ts",
  approve: "app/api/aprobaciones/enrolamiento/cases/approve/route.ts",
};
const document = "1000000001", imei = "123456789012345";
const grantId = "11111111-1111-4111-8111-111111111111";
const nominalCookie = "approval_analyst_session", accessCookie = "approval_access_session";

function harness(options = {}) {
  const calls = [];
  const env = {
    NODE_ENV: options.production ? "production" : "test",
    IPHONE_ENROLLMENT_ENABLED: "true",
    IPHONE_ENROLLMENT_SESSION_SECRET: "nominal-session-secret-for-tests-0123456789",
    IPHONE_ENROLLMENT_IDENTITY_PEPPER: "nominal-identity-pepper-for-tests-0123456789",
    IPHONE_ENROLLMENT_IDENTITY_KEY_VERSION: "nominal-test-v1",
    IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET: "S".repeat(43),
    IPHONE_ENROLLMENT_PUBLIC_ORIGIN: "https://finserpay.test",
    NEXT_PUBLIC_APP_URL: "https://finserpay.test",
  };
  const globals = { process: { env }, console: { error: () => {} } };
  const enrollment = load("lib/iphone-enrollment.ts", {}, globals);
  const publicSecret = enrollment.createIphoneEnrollmentGrantSecret();
  const ownerId = options.ownerId ?? 7;
  const issued = options.sharedGrant ? enrollment.issueIphoneEnrollmentSharedPortalSession()
    : enrollment.issueIphoneEnrollmentPortalSession({ grantId,
      analyst: { name: "Analista QA", externalId: options.externalId || `FINSER-USER:${ownerId}` },
      grantExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000) });
  if (options.disabled) env.IPHONE_ENROLLMENT_ENABLED = "false";
  const grant = {
    accessMode: issued.payload.accessMode, grantId: issued.payload.grantId,
    analyst: { name: issued.payload.analystName, externalId: issued.payload.analystExternalId },
    issuedBy: options.sharedGrant ? null : { userId: ownerId, name: "Analista QA" },
    expiresAt: issued.expiresAt, session: issued.payload,
  };
  const role = options.role || "ANALISTA_APROBACION";
  const cookies = options.cookies || [nominalCookie];
  const database = {
    usuario: { findUnique: async () => ({ id: 7, nombre: "Analista QA", usuario: "qa", activo: options.active !== false,
      claveHash: "credential", updatedAt: new Date(), sedeId: 1, rolId: 8, rol: { id: 8, nombre: role },
      sede: { id: 1, nombre: "Central", activa: options.siteActive !== false, aliadoId: 1,
        aliado: { id: 1, nombre: "FINSER PAY", codigo: options.allyCode || "FINSERPAY", activo: options.allyActive !== false } } }) },
    $queryRawUnsafe: async (sql, id) => {
      calls.push(["database-identity", id, sql]);
      assert.match(sql, /FOR SHARE OF u,s,a/);
      if (options.revokedInDatabase || options.siteActive === false || options.allyActive === false ||
          options.active === false || !["ADMIN", "ANALISTA_APROBACION"].includes(role) ||
          (options.allyCode && options.allyCode !== "FINSERPAY")) return [];
      return [{ nombre: "Analista QA", role }];
    },
    $transaction: work => work(database),
  };
  const auth = load("lib/auth.ts", {
    "next/headers": { cookies: async () => ({ get: key => cookies.includes(key) ? { value: key } : undefined }) },
    "@/lib/prisma": { default: database }, "@/lib/roles": roles,
    "@/lib/session": {
      SELLER_SESSION_COOKIE_NAME: "seller", SESSION_COOKIE_NAME: "session",
      APPROVAL_ANALYST_SESSION_COOKIE_NAME: nominalCookie, APPROVAL_ACCESS_COOKIE_NAME: accessCookie,
      getSessionCredentialVersion: () => "current", verifySellerSessionToken: () => null,
      verifyApprovalAnalystSessionToken: value => value === nominalCookie && !options.expiredLogin
        ? { userId: 7, credentialVersion: options.staleCredential ? "old" : "current" } : null,
      verifySessionToken: value => value ? { userId: 7, credentialVersion: "current",
        approvalAccessGrantId: value === accessCookie ? "personal-link" : undefined } : null,
    },
    "@/lib/aliados": { ensureAliadoSchema: async () => {}, ensureFinserPayCentralAdmin: async () => {} },
  }, globals);
  const actorAccess = load("lib/analyst-mora-access.ts", {
    "@/lib/auth": auth,
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => options.sharedApproval },
    "@/lib/roles": roles, "@/lib/credit-approval-errors": errors,
  }, globals);
  const storage = {
    IphoneEnrollmentGrantError, IphoneEnrollmentApprovalError,
    isNominalIphoneEnrollmentGrant: grant => grant.analyst.externalId.startsWith("FINSER-USER:"),
    validateIphoneEnrollmentPortalSession: async signed => {
      calls.push(["read-grant", signed.grantId]); return options.revokedGrant ? null : grant;
    },
    consumeIphoneEnrollmentRateLimit: async input => {
      calls.push(["limit", plain(input)]);
      return { allowed: !options.limited, retryAfterSeconds: 23 };
    },
    createIphoneEnrollmentAccessGrant: async input => {
      calls.push(["create-grant", plain(input)]);
      return { token: "PRIVATE-ISSUED-GRANT-SECRET", item: { tokenHash: "PRIVATE-HASH" } };
    },
    exchangeIphoneEnrollmentAccessGrant: async token => {
      calls.push(["exchange-grant", token]);
      assert.equal(token, options.publicRoutes ? publicSecret : "PRIVATE-ISSUED-GRANT-SECRET");
      if (options.publicRoutes) return { session: issued, grant };
      const newSession = enrollment.issueIphoneEnrollmentPortalSession({ grantId,
        analyst: { name: "Analista QA", externalId: "FINSER-USER:7" },
        grantExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000) });
      return { session: newSession, grant: { analyst: { name: "Analista QA", externalId: "FINSER-USER:7" } } };
    },
    findIphoneEnrollmentCase: async input => {
      calls.push(["lookup", plain(input)]);
      if (options.lookupError) throw options.lookupError;
      return { kind: options.kind || "FOUND", item: {
        targetType: options.replacement ? "DEVICE_REPLACEMENT" : "APPLICATION",
        targetId: options.replacement ? "22222222-2222-4222-8222-222222222222" : null,
        solicitudId: 28, solicitudNumero: "SOL-000028", currentStep: 5,
        clienteNombre: "CLIENTE QA", documentoMasked: "******0001", imeiMasked: "123********2345", equipo: "IPHONE TEST", aliado: "ALIADO QA", sede: "SEDE QA",
        operationLabel: options.replacement ? "Cambio por garantía" : "Venta nueva",
        privateDocumentHash: "NO-EXPOSE-HASH", score: 900,
        review: options.alreadyApproved ? { id: "review-28", decision: "APROBADO", analystName: "Analista QA",
          analystExternalId: "FINSER-USER:7", approvedAt: "2026-10-09T12:00:00Z", documentHash: "PRIVATE-HASH" } : null,
      } };
    },
    approveIphoneEnrollmentCase: async input => {
      calls.push(["approve", plain(input)]);
      if (options.approveError) throw options.approveError;
      return { alreadyApproved: Boolean(options.alreadyApproved), review: {
        id: "review-28", decision: "APROBADO", analystName: "Analista QA", analystExternalId: "FINSER-USER:7",
        approvedAt: "2026-10-09T12:00:00Z", documentHash: "PRIVATE-HASH", grantId,
      } };
    },
  };
  const NextResponse = { json: (body, init) => {
    const response = Response.json(body, init);
    response.cookieRecords = [];
    response.cookies = { set: item => response.cookieRecords.push(item) };
    return response;
  } };
  const helper = load("lib/analyst-enrollment-access.ts", {
    "next/server": { NextResponse }, "@/lib/prisma": { default: database },
    "@/lib/analyst-mora-access": actorAccess, "@/lib/credit-approval-errors": errors,
    "@/lib/credit-device-replacement-storage": { CreditDeviceReplacementError },
    "@/lib/iphone-enrollment": enrollment, "@/lib/iphone-enrollment-storage": storage,
    "@/lib/iphone-enrollment-diagnostics": { IphoneEnrollmentDiagnosticError },
  }, globals);
  const dependencies = {
    "next/server": { NextResponse }, "@/lib/analyst-enrollment-access": helper,
    "@/lib/credit-device-replacement-storage": { CreditDeviceReplacementError },
    "@/lib/iphone-enrollment": enrollment, "@/lib/iphone-enrollment-storage": storage,
    "@/lib/iphone-enrollment-diagnostics": { lookupNominalIphoneEnrollmentDiagnostics: async (input, actor) => {
      calls.push(["diagnostics", plain(input), plain(actor)]);
      return { kind: options.mismatch ? "MISMATCH" : "MATCHED", items: [{ solicitudId: 28, stage: "CONTRATOS" }] };
    } },
  };
  const routes = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, load(path, dependencies, globals)]));
  const publicRoutes = options.publicRoutes ? Object.fromEntries([
    ["session", "session/route.ts"], ["access", "access/route.ts"],
    ["cases", "cases/route.ts"], ["approve", "cases/approve/route.ts"],
  ].map(([name, file]) => [name, load("app/api/public/iphone-enrollment/" + file, dependencies, globals)])) : null;
  function request(body = {}, patch = {}) {
    const headers = { "Content-Type": "application/json", Origin: "https://finserpay.test", ...patch.headers };
    const req = new Request("https://finserpay.test/api/aprobaciones/enrolamiento/" + (patch.path || "cases"), {
      method: "POST", headers, body: patch.rawBody ?? JSON.stringify(body),
    });
    req.cookies = { get: key => (key === helper.analystEnrollmentCookieName() || (options.publicRoutes && key === enrollment.getIphoneEnrollmentPortalCookieName())) && !options.noGrantCookie
      ? { value: options.tamperedGrantCookie ? issued.value + "tamper" : issued.value } : undefined };
    return req;
  }
  const caseToken = (patch = {}) => enrollment.createIphoneEnrollmentCaseToken({ solicitudId: 28,
    documentHash: enrollment.hashIphoneEnrollmentDocument(document), imeiHash: enrollment.hashIphoneEnrollmentImei(imei),
    session: issued.payload, ...patch });
  return { calls, routes, publicRoutes, helper, enrollment, grant, issued, request, caseToken, publicSecret };
}

function privateResponse(response) {
  assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
}
const sensitiveCalls = f => f.calls.filter(([name]) => ["read-grant", "create-grant", "exchange-grant", "lookup", "diagnostics", "approve"].includes(name));

test("las tres rutas rechazan CSRF antes de consultar sesión, grants o datos", async () => {
  const f = harness();
  for (const route of Object.values(f.routes)) {
    const response = await route.POST(f.request({}, { headers: { Origin: "https://evil.test" } }));
    assert.equal(response.status, 403); privateResponse(response);
    assert.equal((await response.json()).code, "INVALID_ORIGIN");
  }
  assert.equal(f.calls.length, 0);
});

test("enrolamiento exige cuenta nominal o admin central vigente; enlaces y otros perfiles no heredan acceso", async () => {
  const scenarios = [{ cookies: [] }, { cookies: [accessCookie] }, { cookies: ["session"], role: "VENDEDOR" },
    { cookies: ["session"], role: "ADMIN", allyCode: "OTRO" }, { role: "ADMIN" }, { active: false },
    { siteActive: false }, { allyActive: false }, { allyCode: "OTRO" }, { expiredLogin: true },
    { staleCredential: true }, { revokedInDatabase: true }, { sharedApproval: null },
    { sharedApproval: { kind: "SHARED_LINK", id: null } }];
  for (const scenario of scenarios) {
    const f = harness(scenario);
    for (const [name, route] of Object.entries(f.routes)) {
      const response = await route.POST(f.request({ document, imei }));
      assert.equal(response.status, 403, `${name}: ${JSON.stringify(scenario)}`); privateResponse(response);
    }
    assert.equal(sensitiveCalls(f).length, 0, JSON.stringify(scenario));
  }
  for (const options of [{}, { cookies: ["session"], role: "ADMIN" }]) {
    const f = harness(options);
    assert.equal((await f.routes.cases.POST(f.request({ document, imei }))).status, 200);
  }
});

test("cases y approve niegan grants ajenos, compartidos, revocados, manipulados o ausentes", async () => {
  for (const options of [{ ownerId: 8 }, { externalId: "FINSER-USER:8" }, { sharedGrant: true },
    { revokedGrant: true }, { tamperedGrantCookie: true }, { noGrantCookie: true }]) {
    const f = harness(options);
    for (const name of ["cases", "approve"]) {
      const response = await f.routes[name].POST(f.request({ document, imei, caseToken: f.caseToken(), enrollmentApproved: true }));
      assert.equal(response.status, 401, `${name}: ${JSON.stringify(options)}`); privateResponse(response);
      assert.equal((await response.json()).code, "UNAUTHENTICATED");
    }
    assert.equal(f.calls.filter(([name]) => ["lookup", "diagnostics", "approve"].includes(name)).length, 0);
  }
});

test("session reutiliza el grant propio sin crear secretos adicionales", async () => {
  const f = harness();
  const response = await f.routes.session.POST(f.request());
  assert.equal(response.status, 200); privateResponse(response);
  const body = await response.json();
  assert.equal(body.authorized, true); assert.equal(body.analyst.externalId, "FINSER-USER:7");
  assert.equal(response.cookieRecords.length, 0);
  assert.deepEqual(sensitiveCalls(f).map(([name]) => name), ["read-grant"]);
  assert.doesNotMatch(JSON.stringify(body), /token|secret|sessionId|accessFingerprint|PRIVATE/);
});

test("session crea un grant privado de ocho horas del actor real y limita cookie a rutas nominales", async () => {
  for (const production of [false, true]) {
    const f = harness({ noGrantCookie: true, production });
    const response = await f.routes.session.POST(f.request({ analystName: "SUPLANTADOR", issuedByUserId: 999 }));
    assert.equal(response.status, 200); privateResponse(response);
    const creation = f.calls.find(([name]) => name === "create-grant")[1];
    assert.deepEqual(creation, { analystName: "Analista QA", analystExternalId: "FINSER-USER:7",
      expiresInMinutes: 480, issuedByUserId: 7, issuedByName: "Analista QA" });
    assert.equal(response.cookieRecords.length, 1);
    const cookie = response.cookieRecords[0];
    assert.equal(cookie.path, "/api/aprobaciones/enrolamiento"); assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "strict"); assert.equal(cookie.secure, production);
    assert.equal(cookie.name.startsWith("__Secure-"), production);
    assert.ok(f.enrollment.verifyIphoneEnrollmentPortalSession(cookie.value));
    assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE|token|secret|sessionId|accessFingerprint|SUPLANTADOR|999/);
  }
});

test("módulo deshabilitado no crea sesión ni lee información de solicitudes", async () => {
  const f = harness({ disabled: true });
  for (const route of Object.values(f.routes)) {
    const response = await route.POST(f.request({ document, imei }));
    assert.equal(response.status, 503); privateResponse(response);
    assert.equal((await response.json()).code, "ENROLLMENT_UNAVAILABLE");
  }
  assert.equal(sensitiveCalls(f).length, 0);
});

test("los límites se aplican al usuario nominal y devuelven Retry-After sin ejecutar operación", async () => {
  for (const [name, action, maximum] of [["session", "ACCESS", 12], ["cases", "LOOKUP", 30], ["approve", "APPROVE", 15]]) {
    const f = harness({ limited: true, noGrantCookie: name === "session" });
    const response = await f.routes[name].POST(f.request({ document, imei, caseToken: f.caseToken(), enrollmentApproved: true }));
    assert.equal(response.status, 429); assert.equal(response.headers.get("Retry-After"), "23"); privateResponse(response);
    const limit = f.calls.find(([key]) => key === "limit")[1];
    assert.equal(limit.action, action); assert.equal(limit.maximum, maximum);
    assert.equal(limit.subjectHash, f.enrollment.hashIphoneEnrollmentRateLimitKey("session", "nominal-user:7"));
    assert.equal(f.calls.filter(([key]) => ["create-grant", "lookup", "diagnostics", "approve"].includes(key)).length, 0);
  }
});

test("datos inválidos y cuerpos mal formados no ejecutan búsqueda ni aprobación", async () => {
  for (const input of [{ document: "1234", imei }, { document, imei: "123" }, { document: {}, imei }]) {
    const f = harness();
    const response = await f.routes.cases.POST(f.request(input));
    assert.equal(response.status, 400); privateResponse(response);
    assert.equal(f.calls.filter(([key]) => ["lookup", "diagnostics"].includes(key)).length, 0);
  }
  for (const name of Object.keys(paths)) {
    const f = harness();
    const response = await f.routes[name].POST(f.request({}, { rawBody: "{" }));
    assert.equal(response.status, 400); privateResponse(response);
    assert.equal(f.calls.filter(([key]) => ["create-grant", "lookup", "diagnostics", "approve"].includes(key)).length, 0);
  }
});

for (const kind of ["NOT_READY", "FINALIZED", "NOT_FOUND", "AMBIGUOUS"]) {
  test(`${kind} devuelve diagnóstico nominal, pero nunca una autorización de enrolamiento`, async () => {
    const f = harness({ kind, mismatch: kind === "NOT_FOUND" });
    const response = await f.routes.cases.POST(f.request({ document, imei, actorUserId: 999 }));
    assert.equal(response.status, kind === "NOT_FOUND" ? 404 : 409); privateResponse(response);
    const body = await response.json();
    assert.equal(body.code, kind); assert.equal(body.caseToken, undefined);
    assert.deepEqual(body.submitted, { document, imei });
    assert.deepEqual(f.calls.find(([key]) => key === "diagnostics").slice(1), [{ document, imei }, { userId: 7 }]);
    if (kind === "NOT_FOUND") assert.equal(body.diagnostics.kind, "MISMATCH");
    assert.equal(f.calls.filter(([key]) => key === "approve").length, 0);
  });
}

test("solo FOUND emite token ligado a la sesión y al par exacto, para venta y garantía", async () => {
  for (const replacement of [false, true]) {
    const f = harness({ replacement, alreadyApproved: true });
    const response = await f.routes.cases.POST(f.request({ document: "1.000.000.001", imei: "123-456-789-012-345" }));
    assert.equal(response.status, 200); privateResponse(response);
    const body = await response.json(), token = f.enrollment.verifyIphoneEnrollmentCaseToken(body.caseToken);
    assert.ok(token); assert.equal(token.solicitudId, 28);
    assert.equal(token.targetType, replacement ? "DEVICE_REPLACEMENT" : "APPLICATION");
    assert.equal(f.enrollment.isIphoneEnrollmentCaseTokenForSession(token, f.issued.payload), true);
    assert.equal(token.documentHash, f.enrollment.hashIphoneEnrollmentDocument(document));
    assert.equal(token.imeiHash, f.enrollment.hashIphoneEnrollmentImei(imei));
    assert.equal(body.item.documento, document); assert.equal(body.item.imei, imei);
    assert.equal(body.item.enrollmentStatus, "ENROLADO_CORRECTAMENTE");
    assert.equal(body.item.operationType, replacement ? "WARRANTY_REPLACEMENT" : "SALE");
    assert.equal(f.calls.filter(([key]) => key === "diagnostics").length, 0);
    assert.doesNotMatch(JSON.stringify(body.item), /PRIVATE|NO-EXPOSE|documentHash|score/);
  }
});

test("approve rechaza token manipulado, vencido o de otra sesión y exige confirmación literal", async () => {
  const f = harness();
  const otherSession = f.enrollment.issueIphoneEnrollmentPortalSession({ grantId,
    analyst: { name: "Analista QA", externalId: "FINSER-USER:7" }, grantExpiresAt: f.issued.expiresAt });
  const inputs = [{ caseToken: "invalid", enrollmentApproved: true },
    { caseToken: f.caseToken() + "tamper", enrollmentApproved: true },
    { caseToken: f.caseToken({ now: new Date(Date.now() - 2 * 60 * 60 * 1000) }), enrollmentApproved: true },
    { caseToken: f.caseToken({ session: otherSession.payload }), enrollmentApproved: true },
    { caseToken: f.caseToken(), enrollmentApproved: false }, { caseToken: f.caseToken(), enrollmentApproved: "true" }];
  for (const input of inputs) {
    const response = await f.routes.approve.POST(f.request(input));
    assert.equal(response.status, 400); privateResponse(response);
  }
  assert.equal(f.calls.filter(([key]) => key === "approve").length, 0);
});

test("approve transmite el actor verificado y conserva resultado idempotente sin aceptar identidad del body", async () => {
  const f = harness({ alreadyApproved: true });
  const response = await f.routes.approve.POST(f.request({ caseToken: f.caseToken(), enrollmentApproved: true,
    nominalActor: { id: 999 }, analystName: "SUPLANTADOR", analystExternalId: "FINSER-USER:999" }));
  assert.equal(response.status, 200); privateResponse(response);
  const call = f.calls.find(([key]) => key === "approve")[1];
  assert.deepEqual(call.nominalActor, { id: 7, nombre: "Analista QA", centralAdmin: false });
  assert.equal(call.grant.analyst.externalId, "FINSER-USER:7");
  assert.deepEqual(call.checklist, { documentMatched: true, imeiMatched: true, enrollmentApproved: true });
  const body = await response.json(); assert.equal(body.alreadyApproved, true);
  assert.equal(body.review.analystExternalId, "FINSER-USER:7");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|grantId|documentHash|SUPLANTADOR|999/);
});

test("conflictos de confirmación son 409; fallos internos son 503 privados y no aparentan enrolamiento exitoso", async () => {
  const conflict = harness({ approveError: new IphoneEnrollmentApprovalError("CASE_IDENTITY_CHANGED", "La identidad cambió.") });
  const response = await conflict.routes.approve.POST(conflict.request({ caseToken: conflict.caseToken(), enrollmentApproved: true }));
  assert.equal(response.status, 409); privateResponse(response);
  assert.equal((await response.json()).code, "CASE_IDENTITY_CHANGED");
  const failed = harness({ lookupError: new Error("PRIVATE SQL SELECT documentHash secret") });
  const error = await failed.routes.cases.POST(failed.request({ document, imei }));
  assert.equal(error.status, 503); privateResponse(error);
  const body = await error.json(); assert.equal(body.ok, false); assert.equal(body.caseToken, undefined);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|SQL|documentHash|secret/);
});


test("un token nominal copiado a la cookie pública no autoriza sesión, búsqueda ni aprobación", async () => {
  const f = harness({ publicRoutes: true, revokedInDatabase: true });
  for (const name of ["session", "cases", "approve"]) {
    const method = name === "session" ? "GET" : "POST";
    const response = await f.publicRoutes[name][method](f.request({ document, imei,
      caseToken: f.caseToken(), enrollmentApproved: true }));
    assert.equal(response.status, 401, name); privateResponse(response);
    const body = await response.json();
    assert.equal(body.caseToken, undefined); assert.equal(body.item, undefined); assert.equal(body.review, undefined);
  }
  assert.equal(f.calls.filter(([key]) => ["lookup", "approve"].includes(key)).length, 0);
});

test("el secreto de un grant nominal tampoco puede canjearse por cookie pública", async () => {
  const f = harness({ publicRoutes: true });
  const response = await f.publicRoutes.access.POST(f.request({ token: f.publicSecret }));
  assert.equal(response.status, 401); privateResponse(response);
  assert.equal(response.cookieRecords.length, 0);
  assert.equal((await response.json()).authorized, undefined);
});

test("el portal público conserva grants externos y el acceso compartido original", async () => {
  for (const options of [{ externalId: "ESPECIALISTA-EXTERNO" }, { sharedGrant: true }]) {
    const f = harness({ ...options, publicRoutes: true });
    const session = await f.publicRoutes.session.GET(f.request());
    assert.equal(session.status, 200); privateResponse(session);
    const found = await f.publicRoutes.cases.POST(f.request({ document, imei }));
    assert.equal(found.status, 200); privateResponse(found);
    const body = await found.json();
    assert.equal(body.item.documento, "******0001"); assert.equal(body.item.imei, "123********2345");
    const approved = await f.publicRoutes.approve.POST(f.request({ caseToken: body.caseToken, enrollmentApproved: true }));
    assert.equal(approved.status, 200); privateResponse(approved);
    assert.equal(f.calls.find(([key]) => key === "approve")[1].nominalActor, undefined);
  }
  const external = harness({ externalId: "ESPECIALISTA-EXTERNO", publicRoutes: true });
  const access = await external.publicRoutes.access.POST(external.request({ token: external.publicSecret }));
  assert.equal(access.status, 200); assert.equal(access.cookieRecords.length, 1);
  assert.equal(access.cookieRecords[0].path, "/api/public/iphone-enrollment");
});
