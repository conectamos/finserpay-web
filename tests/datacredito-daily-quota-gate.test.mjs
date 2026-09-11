import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT,
  DATACREDITO_MAX_INSTALLMENT_COUNT,
} from "../lib/datacredito/policy.ts";
import { resolveMissingAssessmentGateView } from "../lib/datacredito/resume-gate.ts";
import { normalizeSolicitudFilters } from "../lib/solicitudes.ts";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [gate, factory, creditPage, wall, modal] = await Promise.all([
  readSource("../app/dashboard/creditos/datacredito-prequalification-gate.tsx"),
  readSource("../app/dashboard/creditos/credit-factory-console.tsx"),
  readSource("../app/dashboard/creditos/page.tsx"),
  readSource("../app/dashboard/solicitudes/solicitudes-wall-client.tsx"),
  readSource("../app/dashboard/creditos/datacredito-daily-quota-modal.tsx"),
]);
const ast = ts.createSourceFile("gate.tsx", gate, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Execute the real component's helpers and callbacks, retaining their branches.
// Only React state, refs and HTTP transport are replaced by an in-memory harness.
function realDeclaration(name) {
  let declaration;
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name?.getText(ast) === name
    ) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(declaration, `Missing real gate declaration: ${name}`);
  if (ts.isFunctionDeclaration(declaration)) return declaration.getText(ast);
  const initializer = declaration.initializer;
  assert.ok(initializer);
  const callback = ts.isCallExpression(initializer) && initializer.expression.getText(ast) === "useCallback"
    ? initializer.arguments[0]
    : initializer;
  return `const ${name} = ${callback.getText(ast)};`;
}

function mountQuotaRecheckEffect(harness, clockTimestamp) {
  let callback;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      node.arguments[0]?.getText(ast).includes("checkDailyQueryQuota()") &&
      node.arguments[0]?.getText(ast).includes("daily-limit-reached")
    ) callback = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback, "Must exercise the actual quota recheck effect");
  const intervals = new Map();
  const clearedIntervals = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let clockReads = 0;
  harness.context.Date = class extends Date {
    static now() { clockReads++; return clockTimestamp; }
  };
  harness.context.window = {
    ...harness.context.window,
    setInterval(handler, duration) {
      const id = intervals.size + 1;
      intervals.set(id, { handler, duration });
      return id;
    },
    clearInterval(id) { clearedIntervals.push(id); intervals.delete(id); },
    addEventListener(name, handler) { windowListeners.set(name, handler); },
    removeEventListener(name) { windowListeners.delete(name); },
  };
  harness.context.document = {
    visibilityState: "visible",
    addEventListener(name, handler) { documentListeners.set(name, handler); },
    removeEventListener(name) { documentListeners.delete(name); },
  };
  harness.context.checkDailyQueryQuota = harness.functions.checkDailyQueryQuota;
  const { outputText } = ts.transpileModule(`(${callback.getText(ast)})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const cleanup = runInNewContext(outputText, harness.context, { timeout: 1000 });
  return {
    intervals, clearedIntervals, windowListeners, documentListeners, cleanup,
    getClockReads: () => clockReads,
  };
}

const helperNames = [
  "isRecord", "readString", "readNumber", "readPlatform", "readJson",
  "getCorrelationId", "getResponseCode", "normalizeDecision",
  "normalizeApprovedAssessment", "normalizeDailyQueryLimitReached", "isRecoverableInitialAssessmentFailure",
];

const exhausted = {
  limit: 5, used: 5, remaining: 0, percentUsed: 100, exhausted: true,
  resetsAt: "2026-09-12T05:00:00.000Z",
};
const available = { ...exhausted, used: 4, remaining: 1, percentUsed: 80, exhausted: false };
const policy = {
  ok: true, enabled: true, configured: true, hasPolicy: true,
  policy: { version: 1 }, dailyQuota: exhausted,
};
const approved = {
  ok: true, assessment: {
    assessmentId: "b13a8110-bd5c-4307-9d0e-deed918fdbe5",
    status: "APROBADO", platform: "IPHONE", solicitudId: 12,
    documentNumber: "123456789", firstSurname: "PRUEBA",
    expiresAt: "2026-09-25T05:00:00.000Z",
    offer: {
      initialPaymentPercentage: 30, suretyPercentage: 10,
      maxFinancedAmount: 1_000_000, installmentCount: 16, maxInstallmentAmount: null,
    },
  },
};

function createGateHarness({ responses = [], overrides = {}, callbacks = ["checkDailyQueryQuota", "submitAssessment"] } = {}) {
  const requests = [];
  const approvals = [];
  const state = {
    view: "ready", documentNumber: "123456789", firstSurname: "PRUEBA",
    consentAccepted: true, dailyQueryLimitReached: null, dailyQuotaModalOpen: false,
    ...overrides,
  };
  const context = {
    ...state,
    platform: "IPHONE", initialSolicitudId: null, initialAssessmentId: null,
    normalizedInitialDocument: "123456789", normalizedInitialSurname: "PRUEBA",
    normalizedInitialErrorCode: "", identityMismatchRecovery: false, newQueryRetryRecovery: false,
    quotaRefreshAbortRef: { current: null }, submissionInFlightRef: { current: false },
    expiredRequerySolicitudIdRef: { current: null },
    approvedAssessmentIdsRef: { current: new Set() },
    onAssessmentInvalidatedRef: { current: () => assert.fail("Must retain the approved assessment") },
    onApprovedRef: { current: (result) => approvals.push(result) },
    showApproved: (result) => { state.view = "approved"; approvals.push(result); },
    finishBypass: () => { state.view = "bypassing"; },
    resolveMissingAssessmentGateView,
    DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT, DATACREDITO_MAX_INSTALLMENT_COUNT,
    CONSENT_ATTESTATION: "Autorización del titular requerida",
    URLSearchParams, Response, DOMException, Date, AbortController, console,
    window: { setTimeout, clearTimeout },
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || "GET", body: options.body });
      assert.ok(responses.length, `Unexpected request: ${url}`);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next();
      return Response.json(next.body, { status: next.status || 200 });
    },
    ...overrides,
  };
  for (const key of [
    "view", "dailyQueryLimitReached", "dailyQuotaModalOpen", "correlationId",
    "conflictMessage", "retryMode", "formErrors", "consentAccepted", "consentText",
    "consumedCreditId", "approvedResult", "documentNumber", "firstSurname",
    "checkingDailyQuota", "dailyQuotaCheckError",
  ]) {
    context[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => {
      state[key] = typeof value === "function" ? value(state[key]) : value;
      context[key] = state[key];
    };
  }
  const names = [...helperNames, "validateForm", ...callbacks];
  const { outputText } = ts.transpileModule(
    `${names.map(realDeclaration).join("\n")}\n({ ${names.join(", ")} })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  );
  const functions = runInNewContext(outputText, context, { timeout: 1000 });
  return { state, requests, approvals, functions, context };
}

test("validates complete server snapshots without inventing exhausted or available quota", () => {
  const { functions } = createGateHarness({ callbacks: [] });
  const parse = (quota) => functions.normalizeDailyQueryLimitReached({ dailyQuota: quota });
  const valid = parse(exhausted);
  assert.equal(valid.percentUsed, 100);
  assert.equal(valid.limit, 5);
  assert.equal(parse(available).exhausted, false);
  assert.equal(parse({ ...exhausted, limit: null, remaining: null, percentUsed: null, exhausted: false }).exhausted, false);
  assert.equal(parse({ ...exhausted, limit: 0, used: 0 })?.percentUsed, 100);
  for (const quota of [
    undefined, null, {},
    { ...exhausted, exhausted: false }, { ...exhausted, exhausted: "true" },
    { ...exhausted, percentUsed: 99 }, { ...exhausted, remaining: 1 },
    { ...exhausted, used: 4 }, { ...exhausted, limit: null },
    { ...exhausted, limit: -1 }, { ...exhausted, limit: 1.5 },
    { ...exhausted, used: "5" }, { ...exhausted, resetsAt: "not-a-date" },
  ]) assert.equal(parse(quota), null, JSON.stringify(quota));
});

test("closing then attempting again reopens by read-only quota check without a paid POST", async () => {
  const harness = createGateHarness({
    overrides: { view: "daily-limit-reached", dailyQueryLimitReached: exhausted },
    responses: [{ body: policy }],
  });
  await harness.functions.submitAssessment({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(harness.state.dailyQuotaModalOpen, true);
  assert.equal(harness.state.view, "daily-limit-reached");
  assert.deepEqual(harness.requests.map(({ url, method }) => ({ url, method })), [
    { url: "/api/creditos/datacredito/politica", method: "GET" },
  ]);
});

test("server-confirmed next-day or increased quota releases the form without consulting automatically", async () => {
  for (const quota of [available, { ...available, used: 0, remaining: 5, percentUsed: 0 }]) {
    const harness = createGateHarness({
      overrides: { view: "daily-limit-reached", dailyQueryLimitReached: exhausted, dailyQuotaModalOpen: true },
      responses: [{ body: { ...policy, dailyQuota: quota } }, { body: approved }],
    });
    await harness.functions.checkDailyQueryQuota(true);
    assert.equal(harness.state.view, "ready");
    assert.equal(harness.state.dailyQuotaModalOpen, false);
    assert.equal(harness.state.dailyQueryLimitReached, null);
    assert.deepEqual(harness.requests.map(({ method }) => method), ["GET"]);
    await harness.functions.submitAssessment({ preventDefault() {} });
    assert.deepEqual(harness.requests.map(({ method }) => method), ["GET", "POST"]);
    assert.equal(harness.state.view, "approved");
  }
});

test("failed or incomplete quota rechecks retain the block and never perform a credit query", async () => {
  for (const response of [
    { status: 500, body: { ok: false } },
    { body: { ok: true, dailyQuota: {} } },
    new Error("Connection unavailable"),
  ]) {
    const harness = createGateHarness({
      overrides: { view: "daily-limit-reached", dailyQueryLimitReached: exhausted },
      responses: [response],
    });
    await harness.functions.checkDailyQueryQuota(true);
    assert.equal(harness.state.view, "daily-limit-reached");
    assert.equal(harness.state.dailyQueryLimitReached, exhausted);
    assert.match(harness.state.dailyQuotaCheckError, /No pudimos verificar/);
    assert.deepEqual(harness.requests.map(({ method }) => method), ["GET"]);
  }
});

test("simultaneous clicks cannot dispatch duplicate credit queries", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = createGateHarness({ responses: [() => pending] });
  const first = harness.functions.submitAssessment({ preventDefault() {} });
  const second = harness.functions.submitAssessment({ preventDefault() {} });
  assert.equal(harness.requests.length, 1);
  release(Response.json(approved));
  await Promise.all([first, second]);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.context.submissionInFlightRef.current, false);
});

test("approved assessments retain their existing authorization path even with exhausted quota and a prior quota marker", async () => {
  const harness = createGateHarness({
    callbacks: ["loadInitialState"],
    overrides: {
      initialSolicitudId: 12,
      initialAssessmentId: approved.assessment.assessmentId,
      normalizedInitialErrorCode: "ALLY_DAILY_QUERY_LIMIT_REACHED",
    },
    responses: [{ body: policy }, { body: approved }],
  });
  await harness.functions.loadInitialState();
  assert.equal(harness.state.view, "bypassing");
  assert.equal(harness.state.dailyQuotaModalOpen, false);
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.approvals[0].solicitudId, 12);
  assert.deepEqual(harness.requests.map(({ method }) => method), ["GET", "GET"]);
  assert.equal(harness.requests[0].url, "/api/creditos/datacredito/politica",
    "restoring an existing approval must not impose the new-query owner's policy scope");
  assert.match(harness.requests[1].url, /\/evaluaciones\/b13a8110-bd5c-4307-9d0e-deed918fdbe5\?/);
});

test("only restored quota failures show the modal during bootstrap, using current server quota", async () => {
  for (const [initialErrorCode, quota, expected] of [
    ["ALLY_DAILY_QUERY_LIMIT_REACHED", exhausted, "daily-limit-reached"],
    ["ALLY_DAILY_QUERY_LIMIT_REACHED", available, "ready"],
    ["ASSESSMENT_RETRY_AUTHORIZED", exhausted, "ready"],
  ]) {
    const harness = createGateHarness({
      callbacks: ["loadInitialState"],
      overrides: { initialSolicitudId: 12, newQueryRetryRecovery: true, normalizedInitialErrorCode: initialErrorCode },
      responses: [{ body: { ...policy, dailyQuota: quota } }],
    });
    await harness.functions.loadInitialState();
    assert.equal(harness.state.view, expected);
    assert.equal(harness.state.dailyQuotaModalOpen, expected === "daily-limit-reached");
    assert.deepEqual(harness.requests.map(({ method }) => method), ["GET"]);
    assert.equal(harness.requests[0].url, initialErrorCode === "ALLY_DAILY_QUERY_LIMIT_REACHED"
      ? "/api/creditos/datacredito/politica?solicitudId=12"
      : "/api/creditos/datacredito/politica");
  }
});

test("quota rechecks retain the resumed request scope instead of using the viewer's ally", async () => {
  const harness = createGateHarness({
    overrides: { initialSolicitudId: 12, view: "daily-limit-reached", dailyQueryLimitReached: exhausted },
    responses: [{ body: policy }],
  });
  await harness.functions.checkDailyQueryQuota(true);
  assert.equal(harness.requests[0].url, "/api/creditos/datacredito/politica?solicitudId=12");
  assert.equal(harness.requests[0].method, "GET");
  assert.equal(harness.state.dailyQuotaModalOpen, true);
});

test("changing request context aborts a pending quota read, clears disabled state and ignores its stale response", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = createGateHarness({
    callbacks: ["checkDailyQueryQuota", "loadInitialState"],
    overrides: { initialSolicitudId: 12, view: "daily-limit-reached", dailyQueryLimitReached: exhausted },
    responses: [() => pending, { body: { ...policy, dailyQuota: available } }],
  });
  const previousRead = harness.functions.checkDailyQueryQuota(true);
  const previousController = harness.context.quotaRefreshAbortRef.current;
  assert.equal(harness.state.checkingDailyQuota, true);
  harness.context.initialSolicitudId = null;
  await harness.functions.loadInitialState();
  assert.equal(previousController.signal.aborted, true);
  assert.equal(harness.context.quotaRefreshAbortRef.current, null);
  assert.equal(harness.state.checkingDailyQuota, false);
  assert.equal(harness.state.view, "ready");
  assert.equal(harness.state.dailyQuotaModalOpen, false);
  release(Response.json(policy));
  await previousRead;
  assert.equal(harness.state.view, "ready");
  assert.equal(harness.state.dailyQuotaModalOpen, false);
  assert.equal(harness.state.dailyQueryLimitReached, null);
  assert.equal(harness.state.checkingDailyQuota, false);
  assert.deepEqual(harness.requests.map(({ url }) => url), [
    "/api/creditos/datacredito/politica?solicitudId=12",
    "/api/creditos/datacredito/politica",
  ]);
});

test("HTTP 429 with confirmed quota opens the modal and preserves entered identity", async () => {
  const harness = createGateHarness({ responses: [{ status: 429, body: {
    ok: false, code: "ALLY_DAILY_QUERY_LIMIT_REACHED", dailyQuota: exhausted,
  } }] });
  await harness.functions.submitAssessment({ preventDefault() {} });
  assert.equal(harness.state.view, "daily-limit-reached");
  assert.equal(harness.state.dailyQuotaModalOpen, true);
  assert.equal(harness.state.documentNumber, "123456789");
  assert.equal(harness.state.firstSurname, "PRUEBA");
  assert.equal(harness.state.dailyQueryLimitReached.percentUsed, 100);
  assert.deepEqual(harness.requests.map(({ method }) => method), ["POST"]);
  assert.equal(harness.approvals.length, 0);
});

test("generic throttling, server failures, malformed quota and connection errors never show the quota modal", async () => {
  for (const response of [
    { status: 429, body: { ok: false, code: "RATE_LIMITED", dailyQuota: exhausted } },
    { status: 500, body: { ok: false, code: "ALLY_DAILY_QUERY_LIMIT_REACHED", dailyQuota: exhausted } },
    { status: 429, body: { ok: false, code: "ALLY_DAILY_QUERY_LIMIT_REACHED" } },
    { status: 429, body: { ok: false, code: "ALLY_DAILY_QUERY_LIMIT_REACHED", dailyQuota: available } },
    new Error("Connection unavailable"),
  ]) {
    const harness = createGateHarness({ responses: [response] });
    await harness.functions.submitAssessment({ preventDefault() {} });
    assert.equal(harness.state.view, "technical-error");
    assert.equal(harness.state.dailyQuotaModalOpen, false);
    assert.equal(harness.approvals.length, 0);
  }
});

test("an ordinary approved or rejected response retains its credit decision flow", async () => {
  for (const [body, expectedView, approvalCount] of [
    [approved, "approved", 1],
    [{ ok: true, status: "RECHAZADO" }, "rejected", 0],
  ]) {
    const harness = createGateHarness({ responses: [{ body }] });
    await harness.functions.submitAssessment({ preventDefault() {} });
    assert.equal(harness.state.view, expectedView);
    assert.equal(harness.approvals.length, approvalCount);
    assert.equal(harness.state.dailyQuotaModalOpen, false);
  }
});

test("uses the existing approved filter and simulator without changing the factory gate scope", () => {
  assert.match(gate, /\/dashboard\/solicitudes\?estado=APROBADA/);
  assert.equal(normalizeSolicitudFilters(new URLSearchParams("estado=APROBADA")).estado, "APROBADA");
  assert.match(wall, /estado:\s*params\.get\("estado"\)/);
  assert.match(gate, /\/dashboard\/creditos\?mode=simulator/);
  assert.match(creditPage, /rawEntryMode === "simulator"/);
  assert.match(factory, /const dataCreditoCreditCreationMode\s*=\s*!paymentsView && !lookupMode && !simulatorMode/);
  assert.match(modal, /href=\{approvedHref\}/);
  assert.match(modal, /href=\{simulatorHref\}/);
  assert.match(modal, /Estimado aliado, hoy alcanzó el \{percentUsed\} % de consultas permitidas/);
  assert.doesNotMatch(modal, /percentUsed\s*=\s*100/);
});

test("automatic quota checks use a fixed visible-page interval regardless of the client's clock", async () => {
  for (const localClock of ["1990-01-01T00:00:00.000Z", "2099-12-31T23:59:59.000Z"]) {
    const harness = createGateHarness({
      overrides: { view: "daily-limit-reached", dailyQueryLimitReached: exhausted },
      responses: [{ body: policy }, { body: policy }, { body: { ...policy, dailyQuota: available } }],
    });
    const effect = mountQuotaRecheckEffect(harness, Date.parse(localClock));
    assert.equal(effect.intervals.size, 1);
    const interval = [...effect.intervals.values()][0];
    assert.equal(interval.duration, 30_000);
    interval.handler();
    await new Promise(setImmediate);
    assert.equal(harness.state.view, "daily-limit-reached", "An expired local date cannot release exhausted quota");
    assert.equal(harness.requests.length, 1);

    harness.context.document.visibilityState = "hidden";
    interval.handler();
    effect.windowListeners.get("focus")();
    effect.documentListeners.get("visibilitychange")();
    await new Promise(setImmediate);
    assert.equal(harness.requests.length, 1, "No automatic requests while the page is hidden");

    harness.context.document.visibilityState = "visible";
    effect.documentListeners.get("visibilitychange")();
    await new Promise(setImmediate);
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.state.view, "daily-limit-reached");
    effect.windowListeners.get("focus")();
    await new Promise(setImmediate);
    assert.equal(harness.state.view, "ready", "Only an available server snapshot releases the form");
    assert.deepEqual(harness.requests.map(({ method }) => method), ["GET", "GET", "GET"]);
    assert.equal(effect.getClockReads(), 0);
    effect.cleanup();
    assert.equal(effect.intervals.size, 0);
    assert.equal(effect.clearedIntervals.length, 1);
    assert.equal(effect.windowListeners.size, 0);
    assert.equal(effect.documentListeners.size, 0);
  }
});

test("automatic recheck cleanup aborts an outstanding read and cannot reopen the closed context", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = createGateHarness({
    overrides: { view: "daily-limit-reached", dailyQueryLimitReached: exhausted },
    responses: [() => pending],
  });
  const effect = mountQuotaRecheckEffect(harness, Date.parse("2099-12-31T23:59:59.000Z"));
  const read = harness.functions.checkDailyQueryQuota(true);
  const controller = harness.context.quotaRefreshAbortRef.current;
  effect.cleanup();
  assert.equal(controller.signal.aborted, true);
  assert.equal(harness.context.quotaRefreshAbortRef.current, null);
  assert.equal(effect.intervals.size, 0);
  release(Response.json(policy));
  await read;
  assert.equal(harness.state.dailyQuotaModalOpen, false);
  assert.deepEqual(harness.requests.map(({ method }) => method), ["GET"]);
});

test("approved and ready states never install the quota recheck interval", () => {
  for (const view of ["approved", "ready", "bypassing"]) {
    const harness = createGateHarness({ overrides: { view, dailyQueryLimitReached: exhausted } });
    const effect = mountQuotaRecheckEffect(harness, Date.parse("2099-12-31T23:59:59.000Z"));
    assert.equal(effect.intervals.size, 0);
    assert.equal(effect.windowListeners.size, 0);
    assert.equal(effect.documentListeners.size, 0);
    assert.equal(harness.requests.length, 0);
  }
});
