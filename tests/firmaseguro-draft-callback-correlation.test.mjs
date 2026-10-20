import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  authorizeFirmaSeguroCallback, buildDraftSignatureCallbackUrl,
  readDraftCallbackDispatchId, readFirmaSeguroCallbackProcessUuid,
} from "../lib/firmaseguro-draft-callback-correlation.ts";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const dispatchId = "00000000-0000-4000-8000-000000003433";
const otherDispatch = "00000000-0000-4000-8000-000000003434";
const processUuid = "a0000000-0000-4000-8000-000000003433";
const secret = "synthetic-callback-secret-only";
const base = "https://finserpay.example.invalid/api/firma-seguro/callback";
const correlation = { authorizeFirmaSeguroCallback, buildDraftSignatureCallbackUrl,
  readDraftCallbackDispatchId, readFirmaSeguroCallbackProcessUuid };
const scoped = (id = dispatchId) => buildDraftSignatureCallbackUrl(base + "?token=" + secret, id, secret);
const authenticate = (url, configured = secret, headers = {}) =>
  authorizeFirmaSeguroCallback(new URL(url), new Headers(headers), configured);

test("el callback nuevo tiene una prueba limitada al despacho y no expone el secreto global", () => {
  const url = new URL(scoped());
  assert.equal(url.searchParams.get("dispatchId"), dispatchId);
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(url.toString().includes(secret), false);
  assert.match(url.searchParams.get("dispatchToken"), /^[a-f0-9]{64}$/);
  assert.equal(authenticate(url).dispatchId, dispatchId);
  assert.equal(authenticate(url).authenticated, true);
  assert.notEqual(new URL(scoped(otherDispatch)).searchParams.get("dispatchToken"), url.searchParams.get("dispatchToken"));
  assert.throws(() => buildDraftSignatureCallbackUrl(base, "not-a-uuid", secret));
});

test("una prueba manipulada, incompleta, duplicada o de otro despacho nunca autoriza", () => {
  const changedId = new URL(scoped()); changedId.searchParams.set("dispatchId", otherDispatch);
  const changedProof = new URL(scoped()); changedProof.searchParams.set("dispatchToken", "0".repeat(64));
  const missingProof = new URL(scoped()); missingProof.searchParams.delete("dispatchToken");
  const duplicateId = new URL(scoped()); duplicateId.searchParams.append("dispatchId", dispatchId);
  const duplicateProof = new URL(scoped()); duplicateProof.searchParams.append("dispatchToken", duplicateProof.searchParams.get("dispatchToken"));
  const fallback = new URL(changedId); fallback.searchParams.set("token", secret);
  for (const url of [changedId, changedProof, missingProof, duplicateId, duplicateProof, fallback]) {
    assert.equal(authenticate(url).authenticated, false);
    assert.equal(authenticate(url).dispatchId, null);
  }
  assert.equal(authenticate(scoped(), "different-secret").authenticated, false);
  assert.equal(authenticate(scoped(), null).authenticated, false);
});

test("se conserva la autenticación global anterior y la ausencia de secreto falla cerrado", () => {
  assert.equal(authenticate(base + "?token=" + secret).authenticated, true);
  for (const header of ["x-firmaseguro-token", "x-webhook-token", "x-callback-token"]) {
    assert.equal(authenticate(base, secret, { [header]: secret }).authenticated, true);
  }
  assert.equal(authenticate(base, secret, { "x-firmaseguro-token": "wrong" }).authenticated, false);
  assert.equal(authenticate(base, null).authenticated, false);
  assert.equal(authenticate(base + "?token=" + secret + "&token=" + secret).authenticated, false);
  for (const missing of [null, "", "   "]) {
    assert.throws(() => buildDraftSignatureCallbackUrl(base, dispatchId, missing), /DRAFT_CALLBACK_AUTH_REQUIRED/);
  }
});

test("los identificadores aceptan sólo las formas UUID documentadas y tienen longitud acotada", () => {
  assert.equal(readDraftCallbackDispatchId(dispatchId), dispatchId);
  assert.equal(readFirmaSeguroCallbackProcessUuid(processUuid), processUuid);
  assert.equal(readFirmaSeguroCallbackProcessUuid(processUuid.replaceAll("-", "")), processUuid.replaceAll("-", ""));
  for (const value of [null, 3433, "current", "1111264415", "x".repeat(10000), processUuid + "\n", "https://evil.invalid/" + processUuid]) {
    assert.equal(readFirmaSeguroCallbackProcessUuid(value), null);
  }
  assert.equal(readDraftCallbackDispatchId(processUuid.replaceAll("-", "")), null);
});

function fixture({ configuredSecret = secret, known = false, receipt = null, dispatch = null, queueFailure = false, queueResult = true } = {}) {
  const calls = { reads: [], receipts: [], finalized: [], queued: [], updated: [], refreshed: [], completed: [] };
  const stored = { processUuid, status: "PENDING" };
  const route = loadReissueModule("app/api/firma-seguro/callback/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/firmaseguro": { getFirmaSeguroConfig: () => ({ callbackSecret: configuredSecret }),
      extractFirmaSeguroUuid: body => body?.uuid, extractFirmaSeguroStatus: body => body?.status },
    "@/lib/firmaseguro-credit": {
      getFirmaSeguroProcessForCallback: async id => { calls.reads.push(id); return known ? stored : null; },
      refreshFirmaSeguroProcess: async item => { calls.refreshed.push(item); return { ...item, status: "PENDING" }; },
      serializeFirmaSeguroProcess: item => item,
    },
    "@/lib/firmaseguro-storage": { updateFirmaSeguroProcess: async (id, data) => { calls.updated.push({ id, data }); return stored; } },
    "@/lib/firmaseguro-draft-dispatch-ledger": {
      getDraftDispatchReceiptByProcessUuid: async id => { calls.receipts.push(id); return receipt; },
      getDraftDispatch: async () => dispatch,
      finalizeDraftDispatch: async id => { calls.finalized.push(id); known = true; },
    },
    "@/lib/firmaseguro-draft-correction-complete": { recordVerifiedDraftCorrectionReissues: async item => calls.completed.push(item) },
    "@/lib/firmaseguro-draft-callback-correlation": correlation,
    "@/lib/firmaseguro-draft-recovery": { enqueueDraftSignatureRecovery: async value => {
      calls.queued.push(value); if (queueFailure) throw new Error("sensitive internal detail");
      return { queued: queueResult, id: "private-queue-id" };
    } },
  });
  const send = (body = { uuid: processUuid, status: "COMPLETED" }, url = scoped(), headers = {}) => route.POST(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  return { calls, route, send };
}

test("un proceso huérfano autenticado se guarda para verificar, sin confiar en estado o tags del callback", async () => {
  const f = fixture(); const body = { uuid: processUuid, status: "COMPLETED", tags: [{ reissue: otherDispatch }], pdf: "untrusted" };
  const response = await f.send(body);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, accepted: true });
  assert.equal(f.calls.queued.length, 1);
  assert.deepEqual({ ...f.calls.queued[0] }, { processUuid, dispatchId,
    payloadSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
  assert.equal(f.calls.updated.length, 0); assert.equal(f.calls.refreshed.length, 0); assert.equal(f.calls.completed.length, 0);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("el callback global antiguo también conserva candidatos; el cuerpo no asigna un despacho", async () => {
  for (const queueResult of [true, false]) {
    const f = fixture({ queueResult });
    const response = await f.send({ uuid: processUuid, tags: [{ reissue: dispatchId }] }, base + "?token=" + secret);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, accepted: true });
    assert.equal(f.calls.queued[0].dispatchId, null);
  }
});

test("sin autenticación o con UUID inválido no hay lectura, cola ni actualización", async () => {
  for (const [configuration, body, url, expected] of [
    [{ configuredSecret: null }, { uuid: processUuid }, base, 401],
    [{}, { uuid: processUuid }, base + "?token=wrong", 401],
    [{}, { uuid: "not-a-uuid" }, scoped(), 400],
    [{}, {}, scoped(), 400],
  ]) {
    const f = fixture(configuration); assert.equal((await f.send(body, url)).status, expected);
    assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.queued.length, 0); assert.equal(f.calls.updated.length, 0);
  }
  const f = fixture(); let bodyRead = false;
  const request = { url: base, headers: new Headers(), get body() { bodyRead = true; throw new Error("must not read"); } };
  assert.equal((await f.route.POST(request)).status, 401); assert.equal(bodyRead, false);
});

test("un fallo al persistir no acusa aceptación ni filtra datos internos", async () => {
  const f = fixture({ queueFailure: true }); const response = await f.send();
  assert.equal(response.status, 500);
  const result = await response.json(); assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /sensitive|queue-id|003433/);
});

test("el cuerpo se limita aun con Content-Length ausente o falso", async () => {
  const f = fixture();
  assert.equal((await f.send({ uuid: processUuid }, scoped(), { "content-length": String(16 * 1024 * 1024 + 1) })).status, 413);
  const request = new Request(scoped(), { method: "POST", headers: { "content-length": "1" }, body: new Uint8Array(16 * 1024 * 1024 + 1) });
  assert.equal((await f.route.POST(request)).status, 413);
  assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.queued.length, 0);
});

test("la conciliación de recibos y el flujo de procesos conocidos siguen consultando al proveedor", async () => {
  for (const options of [{ known: true, receipt: { dispatchId } }, { known: true, dispatch: { processUuid } }, { receipt: { dispatchId } }]) {
    const f = fixture(options); const response = await f.send();
    assert.equal(response.status, 200); assert.equal(f.calls.queued.length, 0);
    assert.equal(f.calls.refreshed.length, 1); assert.equal(f.calls.completed.length, 1);
    assert.equal((await response.json()).process.status, "PENDING", "la respuesta usa el estado verificado y no el COMPLETED declarado");
    if (options.receipt && !options.known) assert.deepEqual(f.calls.finalized, [dispatchId]);
  }
});

test("el preparador coloca el scope del despacho original y nunca realiza el envío durante preparación", async () => {
  const source = readFileSync(new URL("../lib/firmaseguro-credit.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function prepareFirmaSeguroReissue(");
  const code = source.slice(start, source.indexOf("export async function createFirmaSeguroProcessForCredit(", start));
  let callback; let sends = 0; let configuredSecret = secret; let signIns = 0;
  const prepare = runInNewContext(ts.transpileModule(code.replace("export async function", "async function") + "\nprepareFirmaSeguroReissue;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    Buffer, Error, buildDraftSignatureCallbackUrl, isFirmaSeguroConfigured: () => true,
    buildFirmaSeguroCallbackUrl: () => base + "?token=" + secret,
    splitClientName: () => ({ document: "1000000001" }), getFirmaSeguroConfig: () => ({ callbackSecret: configuredSecret }),
    getFirmaSeguroDelivery: () => ({ sendByEmail: true, signerEmail: "synthetic@example.invalid" }),
    firmaSeguroSignIn: async () => { signIns++; return { token: "synthetic-token" }; }, resolveFirmaSeguroDeliveryAuth: async (_token, value) => value,
    buildCreateFullPayload: (_credit, _person, _pdf, url) => { callback = url; return { tags: [] }; },
    redactBase64Payload: value => value,
    firmaSeguroCreateFull: async () => { sends++; throw new Error("not allowed"); },
  });
  await prepare({}, Buffer.from("%PDF-1.7 synthetic"), dispatchId, { callbackScope: "draft_dispatch" });
  assert.equal(sends, 0); assert.equal(authenticate(callback).dispatchId, dispatchId);
  assert.equal(callback.includes(secret), false);
  configuredSecret = null;
  const before = signIns;
  await assert.rejects(prepare({}, Buffer.from("%PDF-1.7 synthetic"), dispatchId, { callbackScope: "draft_dispatch" }), /DRAFT_CALLBACK_AUTH_REQUIRED/);
  assert.equal(signIns, before, "la configuración inválida falla antes de autenticar o enviar al proveedor");
  assert.equal(sends, 0);
  await prepare({}, Buffer.from("%PDF-1.7 synthetic"), dispatchId);
  assert.equal(callback, base + "?token=" + secret, "las otras operaciones compartidas conservan su callback anterior");
});


test("una prueba del despacho A no actualiza ni finaliza un proceso conocido B", async () => {
  for (const options of [{ known: true }, { known: true, receipt: { dispatchId: otherDispatch } },
    { receipt: { dispatchId: otherDispatch } }, { known: true, receipt: { dispatchId: otherDispatch }, dispatch: { processUuid } }, { known: true, dispatch: { processUuid: "b".repeat(32) } }]) {
    const f = fixture(options); const response = await f.send();
    assert.equal(response.status, 202); assert.equal(f.calls.queued.length, 1);
    assert.equal(f.calls.queued[0].dispatchId, dispatchId);
    assert.equal(f.calls.updated.length, 0); assert.equal(f.calls.finalized.length, 0); assert.equal(f.calls.refreshed.length, 0);
  }
});

test("un callback global conocido sin scope conserva su flujo y admite UUID en query con cuerpo vacío", async () => {
  const f = fixture({ known: true });
  const response = await f.route.POST(new Request(base + "?token=" + secret + "&uuid=" + processUuid + "&status=COMPLETED", { method: "POST" }));
  assert.equal(response.status, 200); assert.equal(f.calls.updated.length, 1); assert.equal(f.calls.refreshed.length, 1);
  assert.equal(f.calls.queued.length, 0);
});


test("la lectura conserva la capitalización histórica del UUID para sus búsquedas existentes", async () => {
  const uppercase = processUuid.toUpperCase();
  assert.equal(readFirmaSeguroCallbackProcessUuid(uppercase), uppercase);
  for (const [options, url] of [[{ known: true }, base + "?token=" + secret],
    [{ known: true, dispatch: { processUuid } }, scoped()]]) {
    const f = fixture(options); const response = await f.send({ uuid: uppercase }, url);
    assert.equal(response.status, 200); assert.deepEqual(f.calls.reads, [uppercase]);
    assert.equal(f.calls.updated[0].id, uppercase); assert.equal(f.calls.queued.length, 0);
  }
});
