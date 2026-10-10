import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";
const jiti = createJiti(import.meta.url);
const { isAdminRole } = await jiti.import("../lib/roles.ts");
const { canOperateSolicitud } = await jiti.import("../lib/solicitud-operation-access.ts");
const { isFinserPayCentralAlly } = await jiti.import("../lib/aliados.ts");
const { FirmaSeguroFullNameIdentityError } = await jiti.import("../lib/datacredito/firmaseguro-identity.ts");
const canonical = "María del Mar De la Peña Muñoz";
const user = { id: 91, nombre: "Admin servidor", rolNombre: "ADMIN", aliadoId: 7, aliadoAccesoCodigo: "ALIADO" };
class FirmaSeguroIdentityReviewError extends Error {
  constructor(code, message, status = 409) { super(message);this.code = code;this.status = status; }
}
const routeSource = readFileSync(new URL("../app/api/creditos/borradores/[id]/identidad-firma/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(routeSource.replace(/^import\b[^;]*;\r?\n/gm, ""), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(options = {}) {
  const loaded = { exports: {} };const calls = [];
  const item = { draftId: 530, canonicalFullName: canonical, canReview: true, canSave: true, validationId: 42, eligible: true };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, Error, NextResponse: { json: (body, init) => Response.json(body, init) },
    getSessionUser: async () => options.session === undefined ? user : options.session,
    getSellerSessionUser: async () => options.seller || null,
    getActiveSolicitudCreditContext: async id => { calls.push(["scope", id]);return options.owner === undefined ? { vendedorId: 8, aliadoId: 7 } : options.owner; },
    isAdminRole, canOperateSolicitud, isFinserPayCentralAlly, FirmaSeguroIdentityReviewError, FirmaSeguroFullNameIdentityError,
    getFirmaSeguroIdentityReviewDetail: async (id, actor) => { calls.push(["detail", id, actor]);if (options.error) throw options.error;return { ...item, canReview: actor.admin, canSave: actor.admin }; },
    saveFirmaSeguroIdentityReview: async (id, body, actor) => { calls.push(["save", id, body, actor]);if (options.error) throw options.error;return { ...item, canSave: false }; },
  });
  return { ...loaded.exports, calls };
}
const context = (id = "530") => ({ params: Promise.resolve({ id }) });
const request = body => new Request("https://local.invalid/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET no revela nombre ni revisión sin sesión, con id inválido o fuera del aliado", async () => {
  for (const [options, id, status] of [[{ session: null }, "530", 401], [{}, "530xyz", 404], [{ session: { ...user, aliadoId: 9 } }, "530", 404], [{ owner: null }, "530", 404]]) {
    const f = fixture(options);const response = await f.GET(new Request("https://local.invalid"), context(id));
    assert.equal(response.status, status);assert.equal((await response.text()).includes(canonical), false);
    assert.equal(f.calls.some(call => call[0] === "detail"), false);
  }
});

test("asesor propietario puede consultar estado y no puede registrar componentes", async () => {
  const f = fixture({ session: { ...user, rolNombre: "ASESOR" }, seller: { id: 8, tipoPerfil: "VENDEDOR" } });
  const response = await f.GET(new Request("https://local.invalid"), context());
  const body = await response.json();assert.equal(response.status, 200);assert.equal(body.item.canReview, false);assert.equal(body.item.canSave, false);
  const denied = await f.POST(request({}), context());assert.equal(denied.status, 403);assert.equal(f.calls.some(call => call[0] === "save"), false);
  const other = fixture({ session: { ...user, rolNombre: "ASESOR" }, seller: { id: 9, tipoPerfil: "VENDEDOR" } });
  assert.equal((await other.GET(new Request("https://local.invalid"), context())).status, 404);
});

test("ADMIN autorizado registra metadata con actor de sesión y no despacha proveedor", async () => {
  const f = fixture();const input = { firstNames: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz", reason: "Cotejado con la cédula", attestation: true,
    expectedValidationId: 42, expectedCanonicalFullName: canonical, idempotencyKey: "12345678-1234-4234-8234-123456789012" };
  const response = await f.POST(request(input), context());assert.equal(response.status, 200);assert.equal((await response.json()).ok, true);
  const saved = f.calls.find(call => call[0] === "save");assert.equal(saved[1], 530);assert.deepEqual(saved[2], input);
  assert.equal(saved[3].id, user.id);assert.equal(saved[3].nombre, user.nombre);assert.equal(saved[3].admin, true);assert.equal(saved[3].central, false);assert.equal(saved[3].aliadoId, 7);
});

test("ADMIN central accede a otro aliado y ADMIN no central sin aliado no accede", async () => {
  const central = fixture({ session: { ...user, aliadoId: 1, aliadoAccesoCodigo: "FINSERPAY" } });
  assert.equal((await central.GET(new Request("https://local.invalid"), context())).status, 200);
  assert.equal(central.calls.find(call => call[0] === "detail")[2].central, true);
  const missing = fixture({ session: { ...user, aliadoId: null } });assert.equal((await missing.POST(request({}), context())).status, 404);
});

test("POST exige objeto JSON y conserva conflictos controlados sin exponer errores técnicos", async () => {
  for (const body of [null, [], "forjado"]) {
    const f = fixture();assert.equal((await f.POST(request(body), context())).status, 400);assert.equal(f.calls.some(call => call[0] === "save"), false);
  }
  const cases = [
    [new FirmaSeguroIdentityReviewError("FIRMASEGURO_REVIEW_STALE", "Actualiza la solicitud"), 409, "FIRMASEGURO_REVIEW_STALE"],
    [new Error("DATACREDITO_IDENTITY_DOCUMENT_MISMATCH"), 409, "DATACREDITO_IDENTITY_DOCUMENT_MISMATCH"],
    [new Error("secret document number 123456789"), 500, "FIRMASEGURO_REVIEW_UNAVAILABLE"],
  ];
  for (const [error, status, code] of cases) {
    const f = fixture({ error });const response = await f.POST(request({}), context());const body = await response.json();
    assert.equal(response.status, status);assert.equal(body.code, code);assert.equal(body.error.includes("123456789"), false);
  }
});
