import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const identityHelpers = await jiti.import("../lib/datacredito/identity.ts");
const compile = source => ts.transpileModule(source.replace(/^import\b[^;]*;\r?\n/gm, ""), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const customerSource = compile(readFileSync(new URL("../lib/datacredito/customer-identity.ts", import.meta.url), "utf8"));
const routeSource = compile(readFileSync(new URL("../app/api/creditos/veriff/route.ts", import.meta.url), "utf8"));
const assessmentId = "12345678-1234-4234-8234-123456789012";
const fullName = "María del Mar  De la Peña Muñoz del Río";

function fixture({ storedDocument = "123456789", requestedDocument = "123456789", storedName = fullName } = {}) {
  const calls = { provider: 0, reservation: 0, assessment: [], release: 0, source: 0, audit: 0 };
  const row = { id: assessmentId, status: "APROBADO", userId: 23, sellerId: 45, sedeId: 1, aliadoId: null };
  const customer = { exports: {} };
  runInNewContext(customerSource, {
    module: customer, exports: customer.exports, Error, console,
    ...identityHelpers,
    prisma: {
      $executeRawUnsafe: async sql => { if (sql.startsWith("INSERT")) calls.audit++; },
      $queryRawUnsafe: async () => [],
    },
    getDataCreditoAssessmentById: async id => id === assessmentId ? row : null,
    dataCreditoAssessmentMatchesScope: (assessment, scope) => assessment.userId === scope.userId && assessment.sellerId === scope.sellerId && assessment.sedeId === scope.sedeId && assessment.aliadoId === scope.aliadoId,
    readDataCreditoIdentitySource: async () => {
      calls.source++;
      return { documentNumber: "123456789", firstSurname: "APELLIDO DIGITADO",
        providerPayload: { content: { respuesta: { validacion: { datosBasicos: {
          conInformacion: true, nombreCompleto: fullName, tipoDocumento: "CC", numeroDocumento: "123.456.789",
        } } } } } };
    },
  });
  const draft = {
    id: 2876, estado: "ABIERTO", usuarioId: 23, vendedorId: 45, sedeId: 1, aliadoId: null,
    clienteDocumento: "123456789", currentStep: 4, plataforma: "IPHONE",
    payload: { equipoMarca: "Apple", equipoModelo: "iPhone 15", imei: "123456789012345",
      valorEquipoTotal: 2000000, cuotaInicial: 400000, plazoMeses: 12,
      frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-11-09", clienteNombre: storedName,
      clientePrimerNombre: "NO VERIFICADO", clientePrimerApellido: "APELLIDO DIGITADO", clienteSegundoApellido: "NO VERIFICADO",
      clienteDocumento: storedDocument, clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", dataCreditoAssessmentId: assessmentId },
  };
  const validation = { id: 38, draftId: draft.id, clienteDocumento: "123456789", clienteNombre: fullName, status: "CREATED", sessionUrl: "https://veriff.example/existing-session" };
  const loaded = { exports: {} };
  runInNewContext(routeSource, {
    module: loaded, exports: loaded.exports, Error,
    NextResponse: { json: (body, init) => Response.json(body, init) },
    VeriffApiError: class extends Error {},
    getSessionUser: async () => ({ id: 23, sedeId: 1 }),
    isVeriffConfigured: () => true,
    getSellerSessionUser: async () => ({ id: 45 }),
    expireStaleSolicitudes: async () => {},
    prisma: { $queryRawUnsafe: async () => [draft] },
    canOperateVeriffDraft: () => true,
    tryAcquireSolicitudOperationLock: async () => ({ release: async () => { calls.release++; } }),
    assertDocumentNotBlacklisted: async () => {},
    documentBlacklistErrorResponse: () => null,
    sanitizeText: value => String(value ?? "").trim(),
    toNumber: value => Number(value) || 0,
    PAYMENT_FREQUENCY_OPTIONS: [{ value: "MENSUAL" }],
    getDataCreditoPublicConfig: () => ({ enabled: true, environment: "production" }),
    enforceDataCreditoCustomerIdentity: customer.exports.enforceDataCreditoCustomerIdentity,
    getApprovedDataCreditoAssessmentForCredit: async input => { calls.assessment.push(input); return row; },
    getVeriffRetryPolicy: async () => ({ applicationRejected: false }),
    getReusableVeriffValidationForDraft: async () => validation,
    serializeVeriffValidation: value => value,
    getVeriffPublicSummary: () => ({ configured: true }),
    createVeriffValidation: async () => { calls.reservation++; throw new Error("Unexpected session reservation"); },
    veriffCreateSession: async () => { calls.provider++; throw new Error("Unexpected provider call"); },
  });
  const request = () => new Request("https://finserpay.example/api/creditos/veriff", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draftId: draft.id, clienteDocumento: requestedDocument,
      clientePrimerNombre: "INVENTADO", clientePrimerApellido: "INVENTADO", clienteTipoDocumento: "PASAPORTE" }),
  });
  return { route: loaded.exports, request, draft, calls };
}

test("FULL_NAME_ONLY llega a Veriff con identidad real recuperada y reutiliza el QR sin otra sesión", async () => {
  const f = fixture();
  const response = await f.route.POST(f.request());
  assert.equal(response.status, 200);
  const body = await response.json();assert.equal(body.ok, true);assert.equal(body.reused, true);assert.equal(body.validation.id, 38);
  assert.equal(f.draft.payload.clienteNombre, fullName);assert.equal(f.draft.payload.clientePrimerNombre, "");
  assert.equal(f.draft.payload.clientePrimerApellido, "");assert.equal(f.draft.payload.clienteSegundoApellido, "");
  assert.equal(f.calls.assessment[0].documentNumber, "123456789");assert.equal(f.calls.assessment[0].firstSurname, "APELLIDO DIGITADO");
  assert.equal(f.calls.source, 1);assert.equal(f.calls.audit, 0);assert.equal(f.calls.provider, 0);assert.equal(f.calls.reservation, 0);assert.equal(f.calls.release, 1);
});

test("documento distinto o nombre completo alterado fallan antes de consultar o reservar Veriff", async () => {
  for (const [input, code] of [
    [{ storedDocument: "987654321" }, "DATACREDITO_IDENTITY_DOCUMENT_MISMATCH"],
    [{ storedName: "Otra Persona" }, "DATACREDITO_IDENTITY_LOCKED_FIELDS"],
  ]) {
    const f = fixture(input);const response = await f.route.POST(f.request());
    assert.equal(response.status, 409);assert.equal((await response.json()).code, code);
    assert.equal(f.calls.provider, 0);assert.equal(f.calls.reservation, 0);assert.equal(f.calls.assessment.length, 0);assert.equal(f.calls.release, 1);
  }
});

test("la consulta de configuración de Veriff no recupera identidad ni crea sesiones", async () => {
  const f = fixture();const response = await f.route.GET();
  assert.equal(response.status, 200);assert.equal((await response.json()).veriff.configured, true);
  assert.equal(f.calls.source, 0);assert.equal(f.calls.provider, 0);assert.equal(f.calls.reservation, 0);
});
