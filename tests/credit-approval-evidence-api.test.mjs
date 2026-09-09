import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { evidence, actor, photos, evidenceDatabase, correctionInput, loadApprovalModule, service } from "./credit-approval-evidence-test-loader.mjs";
import { roles, approvalActors } from "./credit-approval-test-loader.mjs";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "../app/dashboard/aprobaciones/approval-client" && context.parentURL?.endsWith("/credit-approval-evidence-client.ts")) return next(specifier + ".ts", context);
  return next(specifier, context);
} });
const { submitEvidenceCorrection } = await import("../lib/credit-approval-evidence-client.ts");
hooks.deregister();
const analyst = { ...actor, rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "FINSERPAY", activo: true };
const context = { params: Promise.resolve({ id: "81" }) };
const request = (body, headers = {}) => new Request("https://finser.test/api/aprobaciones/81/evidencias", {
  method: "PATCH", headers: { "content-type": "application/json", origin: "https://finser.test", ...headers }, body: JSON.stringify(body),
});

function harness(user) {
  const { db, state } = evidenceDatabase();
  const calls = [];
  const http = loadApprovalModule("lib/credit-approval-http.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": { getCreditApprovalSessionUser: async () => user },
    "@/lib/roles": roles, "@/lib/credit-approval": service,
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => undefined }, "@/lib/credit-approval-actor": approvalActors,
  });
  const route = loadApprovalModule("app/api/aprobaciones/[id]/evidencias/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/credit-approval": service,
    "@/lib/credit-approval-actor": approvalActors,
    "@/lib/credit-approval-evidence": evidence, "@/lib/credit-approval-http": http,
    "@/lib/prisma": { default: { $transaction: async (callback, options) => { calls.push(options); return callback(db); } } },
  });
  return { route, calls, db, state };
}

test("PATCH niega sesiones y roles ajenos antes de consultar o escribir", async (t) => {
  for (const [user, status] of [[null, 401], [{ ...analyst, rolNombre: "VENDEDOR" }, 403],
    [{ ...analyst, aliadoAccesoCodigo: "ALIADO" }, 403], [{ ...analyst, activo: false }, 403],
    [{ ...analyst, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO" }, 403]]) await t.test(String(user?.rolNombre || "anónimo") + status, async () => {
    const api = harness(user);
    const result = await api.route.PATCH(request({}), context);
    assert.equal(result.status, status);
    assert.equal(api.calls.length, 0);
    assert.equal(api.state.queries.length, 0);
    assert.match(result.headers.get("cache-control"), /private, no-store/);
  });
});

test("PATCH conserva validación de origen y límite acotado de subida", async () => {
  const api = harness(analyst);
  assert.equal((await api.route.PATCH(request({}, { origin: "https://other.test" }), context)).status, 403);
  assert.equal((await api.route.PATCH(request({ dataUrl: "a".repeat(3 * 1024 * 1024) }), context)).status, 400);
  assert.equal(api.calls.length, 0);
});

test("PATCH aplica imagen, revisión y actor de la sesión en una única transacción", async () => {
  const api = harness(analyst);
  const input = await correctionInput(api.db);
  const result = await api.route.PATCH(request(input), context);
  assert.equal(result.status, 200);
  const payload = await result.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.item.id, 81);
  assert.equal(payload.item.review.status, "PENDING");
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].isolationLevel, "ReadCommitted");
  assert.equal(api.state.archives[0][6], analyst.id);
});

test("el cliente envía una sola foto y no adjunta datos comerciales ni actor", async (t) => {
  const input = { key: "foto-remision", dataUrl: photos[0], revision: 2, reviewHash: "a".repeat(64) };
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, unchanged: false, item: { id: 81 } }));
  await submitEvidenceCorrection(81, input);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, "/api/aprobaciones/81/evidencias");
  assert.equal(options.method, "PATCH");
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.cache, "no-store");
  assert.deepEqual(JSON.parse(options.body), input);
});

test("el cliente nunca reintenta conflictos ni escrituras con resultado incierto", async (t) => {
  for (const response of [() => Response.json({ error: "Revisión obsoleta" }, { status: 409 }),
    () => Response.json({ ok: true, item: { id: 99 }, unchanged: false }),
    () => { throw new TypeError("Connection closed"); }]) {
    const fetch = t.mock.method(globalThis, "fetch", response);
    await assert.rejects(submitEvidenceCorrection(81, { key: "foto-entrega", dataUrl: photos[0], revision: 1, reviewHash: "a".repeat(64) }));
    assert.equal(fetch.mock.calls.length, 1);
    fetch.mock.restore();
  }
});
