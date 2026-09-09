import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const read = async (file) => (await readFile(new URL(file, root), "utf8")).replace(/\r\n/g, "\n");
const evaluationSource = await read("app/api/creditos/datacredito/evaluaciones/route.ts");
const finalizationSource = await read("app/api/creditos/route.ts");
const assessmentSource = await read("app/api/creditos/datacredito/evaluaciones/[id]/route.ts");

function moduleFromSource(source, mocks, globals = {}) {
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const fixtureModule = { exports: {} };
  const missing = new Proxy({}, {
    get(_target, name) {
      if (name === "__esModule") return true;
      return () => { throw new Error(`Unexpected dependency call: ${String(name)}`); };
    },
  });
  runInNewContext(code, {
    module: fixtureModule, exports: fixtureModule.exports, Buffer, URL, Response, Request, Headers,
    process: { env: { NODE_ENV: "test" } }, console,
    require(specifier) {
      if (specifier.startsWith("node:")) return nativeRequire(specifier);
      return mocks[specifier] || missing;
    },
    ...globals,
  }, { filename: "blacklist-route-fixture.cjs" });
  return fixtureModule.exports;
}

const blockedError = Object.assign(new Error("Esta cédula está en la lista negra."), {
  code: "DOCUMENT_BLACKLISTED", status: 403,
});

function fixtures({ central = false, allyId = 20, guard = async () => { throw blockedError; } } = {}) {
  const activity = { provider: 0, reserve: 0, reuse: 0, guards: 0 };
  const mocks = {
    "next/server": { NextResponse: { json: (data, init) => Response.json(data, init) } },
    "@/lib/auth": { getSessionUser: async () => ({ id: 1, rolNombre: central ? "ADMIN" : "VENDEDOR", aliadoId: allyId, aliadoAccesoCodigo: central ? "FINSER_PAY" : "ALLY", sedeId: 5 }) },
    "@/lib/aliados": { isFinserPayCentralAlly: () => central },
    "@/lib/roles": { isAdminRole: () => central },
    "@/lib/seller-auth": { getSellerSessionUser: async () => ({ id: 3, tipoPerfil: "VENDEDOR" }) },
    "@/lib/solicitud-operation-access": { isDirectSalesProfile: () => true, canOperateSolicitud: () => true },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async (...args) => { activity.guards += 1; return guard(...args); } },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: (error) => error === blockedError ? Response.json({ ok: false, code: error.code, error: error.message }, { status: error.status }) : null },
    "@/lib/credit-factory": { sanitizeText: (value) => String(value || "").trim(), toNullableDate: () => null },
    "@/lib/datacredito": {
      getDataCreditoPublicConfig: () => ({ enabled: true }),
      queryDataCreditoNaturalPerson: async () => { activity.provider += 1; throw new Error("Provider must not be reached"); },
    },
    "@/lib/datacredito/policy": { normalizeDataCreditoPlatform: (value) => String(value).toUpperCase() },
    "@/lib/datacredito/storage": {
      normalizeDataCreditoDocument: (value) => String(value || "").replace(/\D/g, ""),
      normalizeDataCreditoSurname: (value) => String(value || "").trim().toUpperCase(),
      reuseDataCreditoAssessment: async () => { activity.reuse += 1; throw new Error("Cached approval must not be reached"); },
    },
    "@/lib/solicitudes-storage": {
      ActiveSolicitudConflictError: class extends Error {},
      SolicitudDataCreditoLinkError: class extends Error {},
      reserveSolicitudForIdentity: async () => { activity.reserve += 1; throw new Error("Draft must not be reserved"); },
    },
  };
  return { activity, mocks };
}

for (const platform of ["ANDROID", "IPHONE"]) {
  for (const central of [false, true]) {
    test(`consulta ${platform}, ${central ? "central" : "aliado"}: rechaza antes de proveedor, caché y borrador`, async () => {
      const { activity, mocks } = fixtures({ central });
      const { POST } = moduleFromSource(evaluationSource, mocks);
      const response = await POST(new Request("https://fixture.test/api/creditos/datacredito/evaluaciones", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentNumber: "1062402825", firstSurname: "Apellido", platform, consentAccepted: true }),
      }));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "DOCUMENT_BLACKLISTED");
      assert.deepEqual(activity, { provider: 0, reserve: 0, reuse: 0, guards: 1 });
    });
  }
}

test("la misma cédula sigue bloqueada al cambiar de aliado o solicitar sólo reuso", async () => {
  for (const allyId of [20, 42]) {
    const { activity, mocks } = fixtures({ allyId });
    const { POST } = moduleFromSource(evaluationSource, mocks);
    const response = await POST(new Request("https://fixture.test/evaluaciones", {
      method: "POST", body: JSON.stringify({ documentNumber: "1062402825", firstSurname: "Apellido", platform: "ANDROID", consentAccepted: true, reuseOnly: true, solicitudId: 9 }),
    }));
    assert.equal(response.status, 403);
    assert.equal(activity.provider + activity.reserve + activity.reuse, 0);
  }
});

test("el cierre directo también bloquea al administrador central sin DataCrédito", async () => {
  const { activity, mocks } = fixtures({ central: true });
  mocks["@/lib/datacredito"].getDataCreditoPublicConfig = () => ({ enabled: false });
  const { POST } = moduleFromSource(finalizationSource, mocks);
  const response = await POST(new Request("https://fixture.test/api/creditos", {
    method: "POST", body: JSON.stringify({ clienteDocumento: "1062402825", plataformaDispositivo: "IPHONE" }),
  }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "DOCUMENT_BLACKLISTED");
  assert.equal(activity.guards, 1);
});

test("el reintento de un crédito ya creado devuelve el resultado sin nuevas ventas aunque la cédula se bloquee después", async () => {
  const { activity, mocks } = fixtures({ central: true });
  const calls = [];
  Object.assign(mocks["@/lib/solicitudes-storage"], {
    getActiveSolicitudCreditContext: async () => null,
    ensureSolicitudSchema: async () => undefined,
  });
  mocks["@/lib/prisma"] = { __esModule: true, default: {
    $queryRawUnsafe: async () => [{ id: 9, creditoId: 87, clienteDocumento: "1062402825", usuarioId: 1, aliadoId: 20 }],
    credito: {
      findUnique: async () => { calls.push("read-existing"); return { id: 87, clienteDocumento: "1062402825", estado: "ENTREGABLE", montoCredito: 1_000_000 }; },
      create: async () => { calls.push("create"); throw new Error("Must not create again"); },
    },
  } };
  mocks["@/lib/credit-factory"].resolveCreditPaymentSummary = () => ({});
  mocks["@/lib/credit-payment-plan"] = { buildCreditPaymentPlan: () => ({}) };
  mocks["@/lib/credit-early-payoff"] = { calculateCreditEarlyPayoff: () => ({}) };
  const { POST } = moduleFromSource(finalizationSource, mocks);
  const response = await POST(new Request("https://fixture.test/api/creditos", {
    method: "POST", body: JSON.stringify({ solicitudId: 9, clienteDocumento: "1062402825" }),
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.recovered, true);
  assert.equal(result.item.id, 87);
  assert.equal(activity.guards + activity.provider + activity.reserve, 0);
  assert.deepEqual(calls, ["read-existing"]);
});

test("la llamada pagada ejecuta el guard con la misma transacción antes de tocar el proveedor", async () => {
  const start = evaluationSource.indexOf("const providerTimeoutMs =");
  const end = evaluationSource.indexOf("const transactionCode =", start);
  assert.ok(start > 0 && end > start);
  const section = evaluationSource.slice(start, end);
  for (const blocked of [false, true]) {
    const tx = {};
    const calls = [];
    const { run } = moduleFromSource(`exports.run = async function(documentNumber) { let providerStartedAt = null; const correlationId = 'fixture-correlation'; const firstSurname = 'Apellido'; ${section} return result; };`, {}, {
      resolveDataCreditoConfig: () => ({ timeoutMs: 12_000 }),
      prisma: { $transaction: async (callback, options) => { assert.equal(options.timeout, 53_000); calls.push("begin"); try { return await callback(tx); } finally { calls.push("end"); } } },
      assertDocumentNotBlacklisted: async (document, db) => { assert.equal(document, "1062402825"); assert.equal(db, tx); calls.push("guard"); if (blocked) throw blockedError; },
      queryDataCreditoNaturalPerson: async () => { calls.push("provider"); return { providerPayload: { fixture: true } }; },
    });
    if (blocked) {
      await assert.rejects(() => run("1062402825"), (error) => error === blockedError);
      assert.deepEqual(calls, ["begin", "guard", "end"]);
    } else {
      assert.equal((await run("1062402825")).providerPayload.fixture, true);
      assert.deepEqual(calls, ["begin", "guard", "provider", "end"]);
    }
  }
});

test("una activación posterior al preflight impide crear el crédito dentro de su transacción", async () => {
  const start = finalizationSource.indexOf("const createCreditWithAmortization = async");
  const end = finalizationSource.indexOf("\n    };", start) + "\n    };".length;
  assert.ok(start > 0 && end > start);
  const section = finalizationSource.slice(start, end);
  const tx = {};
  const calls = [];
  const { run } = moduleFromSource(`exports.run = async function(transaction) { ${section} return createCreditWithAmortization(transaction); };`, {}, {
    clienteDocumento: "1062402825",
    assertDocumentNotBlacklisted: async (document, db) => { assert.equal(document, "1062402825"); assert.equal(db, tx); calls.push("guard"); throw blockedError; },
  });
  await assert.rejects(() => run(tx), (error) => error === blockedError);
  assert.deepEqual(calls, ["guard"]);
});

test("reanudación y pasos alternos conservan el bloqueo con respuesta explícita", async () => {
  assert.match(assessmentSource, /ASSESSMENT_IDENTITY_REQUIRED/);
  assert.ok(assessmentSource.indexOf("await assertDocumentNotBlacklisted(identityDocument)") < assessmentSource.indexOf("...serializeDataCreditoAssessment(row)"));
  const routes = [
    "app/api/creditos/borradores/route.ts",
    "app/api/creditos/borradores/[id]/firma-seguro/route.ts",
    "app/api/creditos/borradores/[id]/iphone-enrollment/route.ts",
    "app/api/creditos/veriff/route.ts",
    "app/api/creditos/veriff/[id]/route.ts",
    "app/api/creditos/configuracion/cupo-manual/route.ts",
    "app/api/creditos/masivos/route.ts",
  ];
  for (const file of routes) {
    const source = await read(file);
    assert.match(source, /await assertDocumentNotBlacklisted\(/, fileURLToPath(new URL(file, root)));
    assert.match(source, /documentBlacklistErrorResponse\(error\)/);
  }
  const mass = await read("app/api/creditos/masivos/route.ts");
  assert.match(mass, /\.sort\(\);[\s\S]*await assertDocumentNotBlacklisted\(document, tx\)/);
  assert.ok(mass.indexOf("await assertDocumentNotBlacklisted(document, tx)") < mass.indexOf("await tx.credito.create("));
});

test("el bloqueo sobre una reserva pendiente la cierra antes de responder", () => {
  const section = evaluationSource.slice(evaluationSource.indexOf("const blacklistResponse = documentBlacklistErrorResponse(error)"));
  assert.ok(section.indexOf("await failDataCreditoAssessment(") < section.indexOf("return blacklistResponse"));
  assert.ok(section.indexOf("await attachDataCreditoToSolicitud(") < section.indexOf("return blacklistResponse"));
  assert.match(section, /status: "NO_EVALUADO"/);
});

test("GET evaluación exige identidad y niega reanudar aprobaciones anteriores de una cédula bloqueada", async () => {
  const id = "b1763a64-1ac7-48d9-9641-7d8181a4e101";
  const row = { id, documentHash: "document:1062402825", surnameHash: "surname:APELLIDO", status: "APROBADO", platform: "ANDROID", correlationId: "fixture-correlation" };
  for (const query of ["", "?documentNumber=1062402825&firstSurname=APELLIDO", "?draftId=9"]) {
    const { activity, mocks } = fixtures();
    Object.assign(mocks["@/lib/datacredito/storage"], {
      getDataCreditoAssessmentById: async () => row,
      dataCreditoAssessmentMatchesScope: () => true,
      buildDataCreditoIdentityHashes: ({ documentNumber, firstSurname }) => ({ documentHash: `document:${documentNumber}`, surnameHash: `surname:${firstSurname}` }),
    });
    mocks["@/lib/solicitudes-storage"].getActiveSolicitudCreditContext = async () => ({ id: 9, clienteDocumento: "1062402825", clientePrimerApellido: "APELLIDO", dataCreditoAssessmentId: id, aliadoId: 20 });
    const { GET } = moduleFromSource(assessmentSource, mocks);
    const response = await GET(new Request(`https://fixture.test/evaluaciones/${id}${query}`), { params: Promise.resolve({ id }) });
    const result = await response.json();
    assert.equal(response.status, query ? 403 : 409);
    assert.equal(result.code, query ? "DOCUMENT_BLACKLISTED" : "ASSESSMENT_IDENTITY_REQUIRED");
    assert.equal(activity.guards, query ? 1 : 0);
    assert.equal(result.status === "APROBADO", false);
  }
});

test("GET evaluación sigue devolviendo una aprobación vigente cuando el titular no está bloqueado", async () => {
  const id = "b1763a64-1ac7-48d9-9641-7d8181a4e101";
  const { mocks, activity } = fixtures({ guard: async () => undefined });
  Object.assign(mocks["@/lib/datacredito/storage"], {
    getDataCreditoAssessmentById: async () => ({ id, documentHash: "document:1062402825", surnameHash: "surname:APELLIDO", status: "APROBADO", expiresAt: new Date(Date.now() + 60_000), providerEnvironment: "test" }),
    dataCreditoAssessmentMatchesScope: () => true,
    buildDataCreditoIdentityHashes: ({ documentNumber, firstSurname }) => ({ documentHash: `document:${documentNumber}`, surnameHash: `surname:${firstSurname}` }),
    getDataCreditoAssessmentDocumentState: async () => ({ consumedElsewhere: false, inProgress: false }),
    serializeDataCreditoAssessment: () => ({ status: "APROBADO" }),
  });
  mocks["@/lib/datacredito"].getDataCreditoPublicConfig = () => ({ environment: "test" });
  const { GET } = moduleFromSource(assessmentSource, mocks);
  const response = await GET(new Request(`https://fixture.test/evaluaciones/${id}?documentNumber=1062402825&firstSurname=APELLIDO`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "APROBADO");
  assert.equal(activity.guards, 1);
});

test("el catch conserva el resultado de una consulta iniciada y responde el bloqueo original", async () => {
  const start = evaluationSource.indexOf("const blacklistResponse = documentBlacklistErrorResponse(error)");
  const end = evaluationSource.indexOf('console.error("ERROR EVALUACION DATACREDITO:"', start);
  assert.ok(start > 0 && end > start);
  for (const error of [blockedError, Object.assign(new Error("Unavailable"), { code: "DOCUMENT_BLACKLIST_UNAVAILABLE", status: 503 })]) {
    for (const pendingAssessmentId of [null, "pending-fixture"]) {
      for (const providerStartedAt of [null, 1]) {
        if (!pendingAssessmentId && providerStartedAt) continue;
        for (const failAttachment of [false, true]) {
          const expectedCode = providerStartedAt ? "PROVIDER_OUTCOME_AMBIGUOUS" : error.code;
          const calls = [];
          const { run } = moduleFromSource(`exports.run = async function(error) { ${evaluationSource.slice(start, end)} };`, {}, {
            pendingAssessmentId, solicitudId: pendingAssessmentId ? 9 : null, providerStartedAt,
            correlationId: "fixture-correlation",
            ActiveSolicitudConflictError: class extends Error {},
            SolicitudDataCreditoLinkError: class extends Error {},
            DataCreditoError: class extends Error {},
            safeProviderValue: (value) => value,
            documentBlacklistErrorResponse: () => Response.json({ code: error.code }, { status: error.status }),
            failDataCreditoAssessment: async (input) => { assert.equal(input.id, "pending-fixture"); assert.equal(input.errorCode, expectedCode); assert.equal(input.durationMs !== null, Boolean(providerStartedAt)); calls.push("fail"); },
            attachDataCreditoToSolicitud: async (input) => { assert.equal(input.solicitudId, 9); assert.equal(input.assessmentId, "pending-fixture"); assert.equal(input.status, "NO_EVALUADO"); assert.equal(input.errorCode, expectedCode); calls.push("attach"); if (failAttachment) throw new Error("Fixture attachment failed"); },
            markSolicitudDataCreditoTechnicalError: async (input) => { assert.equal(input.solicitudId, 9); assert.equal(input.errorCode, expectedCode); calls.push("fallback"); },
          });
          const response = await run(error);
          assert.equal(response.status, error.status);
          assert.equal((await response.json()).code, error.code);
          assert.deepEqual(calls, pendingAssessmentId ? ["fail", "attach", ...(failAttachment ? ["fallback"] : [])] : []);
        }
      }
    }
  }
});

test("el expediente cifra y conserva la respuesta antes de que lista negra impida publicar la decisión", () => {
  const encryption = evaluationSource.indexOf("const completedSecure =");
  const persistence = evaluationSource.indexOf("await storePendingDataCreditoSecureRecord(completedSecure)", encryption);
  const guard = evaluationSource.indexOf("await assertDocumentNotBlacklisted(documentNumber)", encryption);
  const completion = evaluationSource.indexOf("await completeDataCreditoAssessmentWithSecureRecord(", encryption);
  assert.ok(encryption > 0 && persistence > encryption && guard > persistence && completion > guard);
  assert.match(evaluationSource.slice(encryption, persistence), /envelope: encryptDataCreditoSecureRecord\([\s\S]*providerPayload: result\.providerPayload/);
});
