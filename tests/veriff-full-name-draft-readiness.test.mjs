import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import { imeiConfirmation, loadImeiConfirmationStorage, persistedImeiConfirmation } from "./credit-imei-confirmation-fixture.mjs";

const jiti = createJiti(import.meta.url);
const identityHelpers = await jiti.import("../lib/datacredito/identity.ts");
const compile = source => ts.transpileModule(source.replace(/^import\b[^;]*;\r?\n/gm, ""), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const customerSource = compile(readFileSync(new URL("../lib/datacredito/customer-identity.ts", import.meta.url), "utf8"));
const routeSource = compile(readFileSync(new URL("../app/api/creditos/veriff/route.ts", import.meta.url), "utf8"));
const assessmentId = "12345678-1234-4234-8234-123456789012";
const fullName = "María del Mar  De la Peña Muñoz del Río";

function fixture({ storedDocument = "123456789", requestedDocument = "123456789", storedName = fullName,
  providerDocumentNumber = "123.456.789", providerDocumentType = "CC", storedType = "CEDULA_DE_CIUDADANIA", providerFullName = fullName,
  newSession = false, assessmentAvailable = true, assessmentStatus = "APROBADO", assessmentSedeId = 1 } = {}) {
  const calls = { provider: 0, reservation: 0, assessment: [], release: 0, source: 0, audit: 0, identityTransactions: 0, identities: [], sessionInputs: [], reservationInputs: [] };
  const row = { id: assessmentId, status: assessmentStatus, userId: 23, sellerId: 45, sedeId: assessmentSedeId, aliadoId: null };
  let identityTransactionActive = false;
  const identityQuery = async (sql, args, transactional) => {
    assert.equal(args[0], assessmentId);
    if (sql.includes('FROM "DataCreditoAssessment"')) {
      assert.equal(transactional, true, "The mutable assessment must be read under the identity transaction");
      assert.match(sql, /FOR UPDATE/);
      return [row];
    }
    assert.match(sql, /FROM "DataCreditoIdentityCorrection"/);
    return [];
  };
  const identityExecute = async sql => { if (sql.startsWith("INSERT")) calls.audit++; };
  const identityPrisma = {
    $executeRawUnsafe: async (...args) => {
      assert.equal(identityTransactionActive, false, "Schema setup must not use the global client inside the transaction");
      return identityExecute(...args);
    },
    $queryRawUnsafe: async (sql, ...args) => {
      assert.equal(identityTransactionActive, false, "Identity reads must use the active transaction client");
      return identityQuery(sql, args, false);
    },
    $transaction: async callback => {
      assert.equal(identityTransactionActive, false);
      calls.identityTransactions++;
      identityTransactionActive = true;
      try {
        return await callback({
          $queryRawUnsafe: (sql, ...args) => identityQuery(sql, args, true),
          $executeRawUnsafe: identityExecute,
        });
      } finally {
        identityTransactionActive = false;
      }
    },
  };
  const customer = { exports: {} };
  runInNewContext(customerSource, {
    module: customer, exports: customer.exports, Error, console,
    ...identityHelpers,
    prisma: identityPrisma,
    getDataCreditoAssessmentById: async id => id === assessmentId ? row : null,
    dataCreditoAssessmentMatchesScope: (assessment, scope) => assessment.userId === scope.userId && assessment.sellerId === scope.sellerId && assessment.sedeId === scope.sedeId && assessment.aliadoId === scope.aliadoId,
    readDataCreditoIdentitySource: async () => {
      calls.source++;
      return { documentNumber: "123456789", firstSurname: "APELLIDO DIGITADO",
        providerPayload: { content: { respuesta: { validacion: { datosBasicos: {
          conInformacion: true, nombreCompleto: providerFullName, tipoDocumento: providerDocumentType, numeroDocumento: providerDocumentNumber,
        } } } } } };
    },
  });
  const draft = {
    id: 2876, estado: "ABIERTO", usuarioId: 23, vendedorId: 45, sedeId: 1, aliadoId: null,
    clienteDocumento: "123456789", currentStep: 4, plataforma: "IPHONE", imei: "123456789012345",
    payload: { equipoMarca: "Apple", equipoModelo: "iPhone 15", imei: "123456789012345",
      valorEquipoTotal: 2000000, cuotaInicial: 400000, plazoMeses: 12,
      frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-11-09", clienteNombre: storedName,
      clientePrimerNombre: "NO VERIFICADO", clientePrimerApellido: "APELLIDO DIGITADO", clienteSegundoApellido: "NO VERIFICADO",
      clienteDocumento: storedDocument, clienteTipoDocumento: storedType, dataCreditoAssessmentId: assessmentId,
      imeiConfirmation: persistedImeiConfirmation("123456789012345", 23, 45) },
  };
  const prisma = { $queryRawUnsafe: async () => [draft] };
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
    enforceDataCreditoCustomerIdentityForVeriff: async (...args) => {
      const recovered = await customer.exports.enforceDataCreditoCustomerIdentityForVeriff(...args);
      calls.identities.push(recovered); return recovered;
    },
    getApprovedDataCreditoAssessmentForCredit: async input => { calls.assessment.push(input); return assessmentAvailable ? row : null; },
    getVeriffRetryPolicy: async () => ({ applicationRejected: false }),
    getReusableVeriffValidationForDraft: async () => newSession ? null : validation,
    serializeVeriffValidation: value => value,
    getVeriffPublicSummary: () => ({ configured: true }),
    randomUUID: () => "12345678-1234-4234-8234-123456789012",
    buildVeriffCompletionUrl: () => "https://finserpay.example/veriff/completado",
    extractVeriffSessionId: value => value.id, extractVeriffSessionUrl: value => value.url,
    updateVeriffValidation: async (id, input) => ({ ...validation, ...input }),
    createVeriffValidation: async input => {
      calls.reservation++; calls.reservationInputs.push(input);
      return { created: true, row: { ...validation, sessionUrl: null } };
    },
    veriffCreateSession: async input => {
      calls.provider++; calls.sessionInputs.push(input);
      return { id: "mock-session", url: "https://veriff.example/mock-session" };
    },
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

test("campos documentales ausentes en DataCrédito no impiden reutilizar Veriff ni se marcan verificados", async () => {
  for (const fields of [
    { providerDocumentNumber: "", providerDocumentType: "", storedType: "" },
    { providerDocumentNumber: "", providerDocumentType: "CC" },
    { providerDocumentNumber: "123456789", providerDocumentType: "" },
  ]) {
    const f = fixture(fields);const response = await f.route.POST(f.request());
    assert.equal(response.status, 200);assert.equal((await response.json()).reused, true);
    const { original, effective } = f.calls.identities[0];
    assert.equal(original.documentNumber, fields.providerDocumentNumber ? "123456789" : "");
    assert.equal(original.documentType, fields.providerDocumentType ? "CEDULA_DE_CIUDADANIA" : "");
    assert.deepEqual(Array.from(effective.missing), Array.from(original.missing));assert.ok(effective.missing.length > 0);
    assert.equal(effective.documentNumber, original.documentNumber);assert.equal(effective.documentType, original.documentType);
    assert.equal(effective.fullName, fullName);assert.equal(f.calls.assessment[0].documentNumber, "123456789");
    assert.equal(f.calls.provider, 0);assert.equal(f.calls.reservation, 0);assert.equal(f.calls.audit, 0);
  }
});

test("preparar sesión nueva mock con sólo nombre completo usa CC consultada y omite nombres inventados", async () => {
  const f = fixture({ providerDocumentNumber: "", providerDocumentType: "", newSession: true });
  const response = await f.route.POST(f.request());assert.equal(response.status, 200);
  assert.equal(f.calls.provider, 1);assert.equal(f.calls.reservation, 1);
  assert.equal(f.calls.sessionInputs[0].documentNumber, "123456789");
  assert.equal(f.calls.sessionInputs[0].documentType, "CEDULA_DE_CIUDADANIA");
  assert.equal(f.calls.sessionInputs[0].firstName, "");assert.equal(f.calls.sessionInputs[0].lastName, "");
  assert.equal(f.calls.reservationInputs[0].clienteNombre, fullName);
  assert.equal(f.calls.identities[0].effective.documentNumber, "");assert.equal(f.calls.identities[0].effective.documentType, "");
  assert.equal(f.calls.audit, 0);assert.equal(f.calls.release, 1);
});

test("identidad parcial conserva guardas de CC, tipo, aprobación, vigencia y permisos antes de Veriff", async () => {
  for (const input of [
    { storedDocument: "987654321" }, { requestedDocument: "987654321" },
    { providerDocumentNumber: "987654321" }, { providerDocumentType: "PASAPORTE" },
    { storedType: "PASAPORTE" }, { storedName: "Nombre alterado" }, { providerFullName: "" },
    { assessmentStatus: "RECHAZADO" }, { assessmentSedeId: 2 }, { assessmentAvailable: false },
  ]) {
    const f = fixture({ providerDocumentNumber: "", providerDocumentType: "", ...input });
    const response = await f.route.POST(f.request());assert.equal(response.status, 409, JSON.stringify(input));
    assert.equal(f.calls.provider, 0);assert.equal(f.calls.reservation, 0);assert.equal(f.calls.audit, 0);
    if (input.providerFullName === "") {
      assert.equal(f.calls.identityTransactions, 1);
      assert.equal((await response.json()).code, "DATACREDITO_IDENTITY_LOCKED_FIELDS");
    }
  }
});
