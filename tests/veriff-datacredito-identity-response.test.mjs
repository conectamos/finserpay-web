import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { imeiConfirmation, loadImeiConfirmationStorage, persistedImeiConfirmation } from "./credit-imei-confirmation-fixture.mjs";

const source = readFileSync(new URL("../app/api/creditos/veriff/route.ts", import.meta.url), "utf8")
  .replace(/^import\b[^;]*;\r?\n/gm, "");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(identityError) {
  const calls = { identity: 0, provider: 0, reserve: 0, release: 0, assessment: 0, reuse: 0 };
  const draft = {
    id: 2876, estado: "ABIERTO", usuarioId: 23, vendedorId: 45, sedeId: 1, aliadoId: null,
    clienteDocumento: "123456789", currentStep: 4, plataforma: "IPHONE", imei: "123456789012345",
    payload: { equipoMarca: "Apple", equipoModelo: "iPhone 15", imei: "123456789012345",
      valorEquipoTotal: 2000000, cuotaInicial: 400000, plazoMeses: 12,
      frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-11-09",
      clienteDocumento: "123456789", dataCreditoAssessmentId: "12345678-1234-4234-8234-123456789012",
      imeiConfirmation: persistedImeiConfirmation("123456789012345", 23, 45) },
  };
  const prisma = { $queryRawUnsafe: async () => [draft] };
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Error,
    NextResponse: { json: (body, init) => Response.json(body, init) },
    VeriffApiError: class extends Error {},
    getSessionUser: async () => ({ id: 23, sedeId: 1 }),
    isVeriffConfigured: () => true,
    getSellerSessionUser: async () => ({ id: 45 }),
    expireStaleSolicitudes: async () => {},
    prisma,
    ...imeiConfirmation,
    ...loadImeiConfirmationStorage(prisma),
    canOperateVeriffDraft: () => true,
    tryAcquireSolicitudOperationLock: async () => ({ release: async () => { calls.release++; } }),
    assertDocumentNotBlacklisted: async () => {},
    documentBlacklistErrorResponse: () => null,
    sanitizeText: value => String(value ?? "").trim(),
    toNumber: value => Number(value) || 0,
    PAYMENT_FREQUENCY_OPTIONS: [{ value: "MENSUAL" }],
    getDataCreditoPublicConfig: () => ({ enabled: true, environment: "production" }),
    enforceDataCreditoCustomerIdentityForVeriff: async () => { calls.identity++; throw identityError; },
    getApprovedDataCreditoAssessmentForCredit: async () => { calls.assessment++; return null; },
    getReusableVeriffValidationForDraft: async () => { calls.reuse++; return null; },
    createVeriffValidation: async () => { calls.reserve++; throw new Error("Unexpected reservation"); },
    veriffCreateSession: async () => { calls.provider++; throw new Error("Unexpected provider call"); },
  });
  return { post: loaded.exports.POST, calls };
}

const request = () => new Request("https://finserpay.example/api/creditos/veriff", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ draftId: 2876, clienteDocumento: "123456789" }),
});

test("Veriff devuelve409 seguro para identidad pendiente de guardar o verificar sin reservar ni llamar al proveedor", async () => {
  for (const code of ["DATACREDITO_IDENTITY_INCOMPLETE", "DATACREDITO_IDENTITY_LOCKED_FIELDS",
    "DATACREDITO_IDENTITY_DOCUMENT_MISMATCH", "DATACREDITO_IDENTITY_SAVE_CORRECTION_FIRST",
    "DATACREDITO_IDENTITY_SOURCE_UNAVAILABLE"]) {
    const f = fixture(new Error(code));
    const response = await f.post(request());
    assert.equal(response.status, 409, code);
    assert.deepEqual(await response.json(), {
      ok: false, code,
      error: "Guarda y verifica la identidad de DataCrédito antes de iniciar Veriff.",
    });
    assert.deepEqual(f.calls, { identity: 1, provider: 0, reserve: 0, release: 1, assessment: 0, reuse: 0 });
  }
});

test("un fallo ajeno a identidad conserva el manejo técnico y libera el lock", async () => {
  const f = fixture(new Error("DEPENDENCY_UNAVAILABLE"));
  const response = await f.post(request());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: "DEPENDENCY_UNAVAILABLE" });
  assert.equal(f.calls.release, 1);assert.equal(f.calls.provider, 0);assert.equal(f.calls.reserve, 0);
});
