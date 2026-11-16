import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../app/api/aprobaciones/excepciones-mora/[id]/whatsapp/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
class CreditApprovalError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function fixture({ actorError, requestError, retryError, body = {} } = {}) {
  const calls = [], loaded = { exports: {} };
  const actor = { id: 9, nombre: "Analista nominal", centralAdmin: false };
  const privateHeaders = { "Cache-Control": "private, no-store" };
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers }) } },
    "@/lib/analyst-mora-access": { getMoraActor: async () => { calls.push("actor"); if (actorError) throw actorError; return actor; } },
    "@/lib/credit-approval-errors": { CreditApprovalError },
    "@/lib/credit-approval-http": {
      approvalPrivateHeaders: privateHeaders,
      readApprovalRequest: async (_request, options) => { calls.push(["read", options.maxBytes]); if (requestError) throw requestError; return body; },
      approvalErrorResponse: error => ({ status: error.status || 503, body: { ok: false, code: error.code }, headers: privateHeaders }),
    },
    "@/lib/mora-extension-whatsapp": { retryMoraExtensionWhatsApp: async (id, verifiedActor) => {
      calls.push(["retry", id, verifiedActor]); if (retryError) throw retryError;
      return { status: "PENDING", canRetry: false };
    } },
  };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, Array, Object,
    require(name) { assert.ok(name in dependencies, `Dependencia inesperada: ${name}`); return dependencies[name]; },
  });
  return { route: loaded.exports, calls, actor };
}
const id = "50000000-0000-4000-8000-000000000010";
const context = { params: Promise.resolve({ id }) };

test("reintento autentica actor, valida cuerpo y delega a la cola del servidor", async () => {
  const f = fixture(), response = await f.route.POST({}, context);
  assert.equal(response.status, 200); assert.equal(response.body.ok, true);
  assert.equal(response.body.whatsApp.status, "PENDING");
  assert.deepEqual(f.calls, ["actor", ["read", 100], ["retry", id, f.actor]]);
  assert.match(response.headers["Cache-Control"], /private, no-store/);
});

test("sesión no autorizada no lee contenido ni programa envío", async () => {
  const f = fixture({ actorError: new CreditApprovalError("FORBIDDEN", "No autorizado", 403) });
  assert.equal((await f.route.POST({}, context)).status, 403);
  assert.deepEqual(f.calls, ["actor"]);
});

test("origen o JSON inválido no llega a la cola", async () => {
  const f = fixture({ requestError: new CreditApprovalError("INVALID_ORIGIN", "Origen ajeno", 403) });
  assert.equal((await f.route.POST({}, context)).status, 403);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === "retry"), false);
});

for (const body of [null, [], "invalid", { phone: "573001234567" }, { approvedDays: 999 }, { centralAdmin: true }]) {
  test(`reintento no acepta destino, días ni permisos desde cliente: ${JSON.stringify(body)}`, async () => {
    const f = fixture({ body }), response = await f.route.POST({}, context);
    assert.equal(response.status, 400); assert.equal(response.body.code, "INVALID_REQUEST");
    assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === "retry"), false);
  });
}

test("rechazo de reenvío inseguro conserva conflicto e impide éxito aparente", async () => {
  const f = fixture({ retryError: new CreditApprovalError("WHATSAPP_CONFIRMATION_PENDING", "Pendiente", 409) });
  const response = await f.route.POST({}, context);
  assert.equal(response.status, 409); assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "WHATSAPP_CONFIRMATION_PENDING");
});
