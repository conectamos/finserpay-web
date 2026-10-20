import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const routePath = new URL("../app/api/creditos/borradores/[id]/firma-seguro/route.ts", import.meta.url);
const reconcilePath = new URL("../app/api/creditos/borradores/[id]/firma-seguro/conciliar/route.ts", import.meta.url);
const source = await readFile(routePath, "utf8");
const getSource = source.slice(source.indexOf("async function resumeAcknowledgedDraftDispatch"),
  source.indexOf("async function requireApprovedVeriffBeforeFirmaSeguro"));
const reconcileSource = (await readFile(reconcilePath, "utf8")).split("export async function POST")[1];

function load(code, name, fixtures) {
  return runInNewContext(stripTypeScriptTypes(code.replaceAll("export async function", "async function")) + `\n${name};`, {
    NextResponse: Response, URL, console, ...fixtures,
  });
}

function getFixture({ authorized = true, receipt = true } = {}) {
  const calls = [];
  let current = null;
  const handler = load(getSource, "GET", {
    parseDraftId: Number,
    readAuthorizedDraft: async () => authorized ? { ok: true, centralAdmin: true } : { ok: false, status: 403, error: "No autorizado" },
    getUnresolvedDraftDispatch: async () => { calls.push("pending"); return { id: "dispatch" }; },
    getDraftDispatchReceipt: async () => { calls.push("receipt"); return receipt ? { dispatchId: "dispatch" } : null; },
    finalizeDraftDispatch: async (id) => { assert.equal(id, "dispatch"); calls.push("finalize"); current = { processUuid: "provider-process" }; },
    getLatestFirmaSeguroProcessForDraft: async () => current,
    refreshFirmaSeguroProcess: async () => { throw new Error("Unexpected provider refresh"); },
    serializeDraftFirmaSeguroProcess: (process) => process,
    recordDraftCorrectionReissue: async () => { calls.push("record"); },
    documentBlacklistErrorResponse: () => null,
    logFirmaSeguroDraftError: () => {},
    firmaSeguroErrorResponse: (error) => { throw error; },
  });
  return { calls, invoke: () => handler(new Request("https://example.test/api/creditos/borradores/1/firma-seguro"), { params: Promise.resolve({ id: "1" }) }) };
}

test("GET recupera una confirmación durable sin volver a enviar ni refrescar el proveedor", async () => {
  const fixture = getFixture();
  const response = await fixture.invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, process: { processUuid: "provider-process" } });
  assert.deepEqual(fixture.calls, ["pending", "receipt", "finalize", "record"]);
});

test("GET no libera un envío incierto sin confirmación ni accede a otra solicitud", async () => {
  const uncertain = getFixture({ receipt: false });
  assert.equal((await (await uncertain.invoke()).json()).process, null);
  assert.deepEqual(uncertain.calls, ["pending", "receipt"]);
  const denied = getFixture({ authorized: false });
  assert.equal((await denied.invoke()).status, 403);
  assert.deepEqual(denied.calls, []);
});

function callbackFixture({ receipt = true, authorized = true } = {}) {
  const calls = [], queued = [];
  const processUuid = "a0000000-0000-4000-8000-000000003433";
  const correlation = loadReissueModule("lib/firmaseguro-draft-callback-correlation.ts");
  let current = null;
  const handler = loadReissueModule("app/api/firma-seguro/callback/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/firmaseguro": {
      getFirmaSeguroConfig: () => ({ callbackSecret: "test-secret" }),
      extractFirmaSeguroUuid: (body) => body?.uuid,
      extractFirmaSeguroStatus: () => "CREATED",
    },
    "@/lib/firmaseguro-credit": {
      getFirmaSeguroProcessForCallback: async () => current,
      refreshFirmaSeguroProcess: async (process) => { calls.push("refresh"); return process; },
      serializeFirmaSeguroProcess: (process) => process,
    },
    "@/lib/firmaseguro-draft-dispatch-ledger": {
      getDraftDispatchReceiptByProcessUuid: async (uuid) => { assert.equal(uuid, processUuid); calls.push("receipt"); return receipt ? { dispatchId: "dispatch" } : null; },
      finalizeDraftDispatch: async (id) => { assert.equal(id, "dispatch"); calls.push("finalize"); current = { processUuid }; },
    },
    "@/lib/firmaseguro-storage": { updateFirmaSeguroProcess: async () => { calls.push("update"); return current; } },
    "@/lib/firmaseguro-draft-correction-complete": { recordVerifiedDraftCorrectionReissues: async () => {} },
    "@/lib/firmaseguro-draft-callback-correlation": correlation,
    "@/lib/firmaseguro-draft-recovery": { enqueueDraftSignatureRecovery: async (input) => {
      calls.push("queue"); queued.push(input); return { queued: true, id: "private" };
    } },
  }).POST;
  return { calls, queued, invoke: () => handler(new Request("https://example.test/api/firma-seguro/callback", {
    method: "POST", headers: { "Content-Type": "application/json", "x-firmaseguro-token": authorized ? "test-secret" : "wrong" },
    body: JSON.stringify({ uuid: processUuid, tags: [{ reissue: "untrusted-callback-tag" }] }),
  })) };
}

test("callback materializa una confirmación propia antes de actualizar su estado", async () => {
  const fixture = callbackFixture();
  assert.equal((await fixture.invoke()).status, 200);
  assert.deepEqual(fixture.calls, ["receipt", "finalize", "update", "refresh"]);
  assert.equal(fixture.queued.length, 0);
});

test("callback desconocido conserva un candidato durable sin conciliar por etiquetas ni omitir autenticación", async () => {
  const unknown = callbackFixture({ receipt: false });
  const response = await unknown.invoke();
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, accepted: true });
  assert.deepEqual(unknown.calls, ["receipt", "queue"]);
  assert.equal(unknown.queued.length, 1);
  assert.equal(unknown.queued[0].dispatchId, null, "el tag no confiable del cuerpo no vincula un despacho");
  assert.match(unknown.queued[0].payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(unknown.queued[0], "tags"), false);
  const denied = callbackFixture({ authorized: false });
  assert.equal((await denied.invoke()).status, 401);
  assert.deepEqual(denied.calls, []);
  assert.equal(denied.queued.length, 0);
});

function reconciliationFixture({ user = { id: 7, nombre: "Admin", rolNombre: "ADMIN", aliadoAccesoCodigo: "CENTRAL" }, draftId = 1, status = "AWAITING_SIGNATURE" } = {}) {
  const calls = [];
  const handler = load(`async function POST${reconcileSource}`, "POST", {
    getSessionUser: async () => user,
    isAdminRole: (role) => role === "ADMIN",
    isFinserPayCentralAlly: (ally) => ally === "CENTRAL",
    getDraftDispatch: async () => { calls.push("lookup"); return { id: "dispatch", draftId }; },
    reconcileDraftDispatchFromProvider: async (input) => {
      calls.push("reconcile");
      assert.equal(input.actor.id, 7);
      assert.equal(input.dispatchId, "dispatch");
      return { status, processUuid: "provider-process" };
    },
    DraftDispatchError: class extends Error {},
  });
  return { calls, invoke: () => handler(new Request("https://example.test/conciliar", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dispatchId: "dispatch", processUuid: "provider-process", actor: { id: 999 } }),
  }), { params: Promise.resolve({ id: "1" }) }) };
}

test("conciliación usa administrador central real y valida pertenencia del envío", async () => {
  const allowed = reconciliationFixture();
  assert.equal((await allowed.invoke()).status, 200);
  assert.deepEqual(allowed.calls, ["lookup", "reconcile"]);
  const wrongDraft = reconciliationFixture({ draftId: 2 });
  assert.equal((await wrongDraft.invoke()).status, 404);
  assert.deepEqual(wrongDraft.calls, ["lookup"]);
  const signedOut = reconciliationFixture({ user: null });
  assert.equal((await signedOut.invoke()).status, 401);
  assert.deepEqual(signedOut.calls, []);
  const allyAdmin = reconciliationFixture({ user: { rolNombre: "ADMIN", aliadoAccesoCodigo: "ALLY" } });
  assert.equal((await allyAdmin.invoke()).status, 403);
  assert.deepEqual(allyAdmin.calls, []);
});

test("conciliación distingue una confirmación recuperada que aún requiere revisión", async () => {
  const fixture = reconciliationFixture({ status: "UNCERTAIN" });
  const response = await fixture.invoke();
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.equal(result.recovered, true);
  assert.equal(result.requiresReview, true);
});
