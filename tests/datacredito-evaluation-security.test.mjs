import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function source(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

const [
  evaluationRoute,
  advisorAssessmentRoute,
  adminAssessmentRoute,
  storage,
  adminStorage,
] = await Promise.all([
  source("app/api/creditos/datacredito/evaluaciones/route.ts"),
  source("app/api/creditos/datacredito/evaluaciones/[id]/route.ts"),
  source("app/api/creditos/datacredito/admin/evaluaciones/[id]/route.ts"),
  source("lib/datacredito/storage.ts"),
  source("lib/datacredito/admin-storage.ts"),
]);

function sectionBetween(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker);
  assert.notEqual(start, -1, `No se encontro el inicio: ${startMarker}`);

  const end = contents.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `No se encontro el final: ${endMarker}`);
  return contents.slice(start, end);
}

test("produccion bloquea un proveedor demo o UAT antes de reservar o consultar", () => {
  const post = evaluationRoute.slice(
    evaluationRoute.indexOf("export async function POST")
  );
  const guardStart = post.indexOf('process.env.NODE_ENV === "production"');
  const reservationStart = post.indexOf("reserveDataCreditoAssessment({");
  const providerCallStart = post.indexOf("await queryDataCreditoNaturalPerson({");

  assert.ok(guardStart >= 0, "Falta el guard explicito de NODE_ENV=production");
  assert.ok(guardStart < reservationStart, "El guard debe ejecutarse antes de reservar");
  assert.ok(guardStart < providerCallStart, "El guard debe ejecutarse antes del proveedor");

  const guard = post.slice(
    guardStart,
    post.indexOf("assertDataCreditoSecureRecordConfigured", guardStart)
  );
  assert.match(guard, /!provider\.productionReady/);
  assert.match(guard, /!allowsDataCreditoNonProductionProvider\(\)/);
  assert.match(guard, /code:\s*"DATACREDITO_NON_PRODUCTION_PROVIDER"/);
  assert.match(guard, /status:\s*503/);

  assert.match(evaluationRoute, /allowsDataCreditoNonProductionProvider/);
  assert.doesNotMatch(evaluationRoute, /function allowsNonProductionProvider/);
});

test("la reserva fija y persiste el ambiente efectivo del proveedor", () => {
  const reservation = sectionBetween(
    evaluationRoute,
    "reservation = await reserveDataCreditoAssessment({",
    "} catch (error)"
  );
  assert.match(
    reservation,
    /providerEnvironment:\s*provider\.environment/
  );

  assert.match(storage, /providerEnvironment:\s*string/);
  assert.match(storage, /input\.providerEnvironment/);
  assert.match(storage, /"providerEnvironment"/);
});

test("el payload crudo del proveedor nunca se serializa al asesor", () => {
  const serializer = sectionBetween(
    storage,
    "export function serializeDataCreditoAssessment",
    "export async function"
  );
  assert.doesNotMatch(serializer, /providerPayload|secureRecord/);
  assert.doesNotMatch(serializer, /documentNumber|firstSurname/);

  assert.doesNotMatch(advisorAssessmentRoute, /providerPayload|secureRecord/);
  assert.match(
    advisorAssessmentRoute,
    /serializeDataCreditoAssessment\(row\)/
  );

  const post = evaluationRoute.slice(
    evaluationRoute.indexOf("export async function POST")
  );
  assert.equal(
    (post.match(/result\.providerPayload/g) || []).length,
    2,
    "La respuesta cruda solo debe entrar al sobre cifrado y al normalizador de riesgo"
  );
  assert.match(
    post,
    /encryptDataCreditoSecureRecord\([\s\S]*?providerPayload:\s*result\.providerPayload[\s\S]*?\}\)/
  );
  assert.match(
    post,
    /const riskSummary = buildDataCreditoAdminRiskSummary\([\s\S]*?result\.providerPayload[\s\S]*?\)/
  );
  assert.match(post, /riskSummary\?\.telcos\.delinquentBalance/);
  assert.match(post, /riskSummary\?\.totals\?\.delinquentBalance/);
  assert.match(post, /telcoPriorityRuleEnabled/);
  assert.match(post, /totalPriorityRuleEnabled/);
  assert.match(post, /telcoRiskMetricValid/);
  assert.match(post, /telcoRiskMetricUnavailable/);
  assert.match(post, /totalDelinquencyInformationAvailable/);
  assert.match(post, /totalRiskMetricValid/);
  assert.match(post, /totalRiskMetricUnavailable/);
  assert.match(
    post,
    /failDataCreditoAssessmentWithSecureRecord[\s\S]*?TELCO_RISK_METRIC_UNAVAILABLE/
  );
  assert.match(
    post,
    /failDataCreditoAssessmentWithSecureRecord[\s\S]*?TOTAL_DELINQUENCY_RISK_METRIC_UNAVAILABLE/
  );
  const decisionCall = sectionBetween(
    post,
    "const resolution = resolveDataCreditoDecision(",
    "if (!resolution)"
  );
  for (const riskField of [
    "telcoDelinquentBalanceCop",
    "telcoDelinquencyInformationAvailable",
    "totalDelinquentBalanceCop",
    "totalDelinquencyInformationAvailable",
  ]) {
    assert.ok(decisionCall.includes(riskField), `Falta ${riskField}`);
  }
  assert.match(post, /\.\.\.serializeDataCreditoAssessment\(completed\)/);
  assert.doesNotMatch(
    post,
    /NextResponse\.json\([\s\S]{0,300}providerPayload:\s*result\.providerPayload/
  );
  assert.doesNotMatch(serializer, /totalDelinquentBalanceCop/);

  assert.match(
    adminAssessmentRoute,
    /providerData:\s*providerPayload\s*\?\s*sanitizeDataCreditoProviderPayload\(providerPayload\)/
  );
  assert.doesNotMatch(
    adminAssessmentRoute,
    /providerData:\s*providerPayload\s*[,}]/
  );
});

test("el expediente PENDING se guarda antes de llamar al proveedor", () => {
  const post = evaluationRoute.slice(
    evaluationRoute.indexOf("export async function POST")
  );
  const pendingWrite = post.indexOf(
    "await storePendingDataCreditoSecureRecord(pendingSecure)"
  );
  const providerCall = post.indexOf("await queryDataCreditoNaturalPerson({");

  assert.ok(pendingWrite >= 0, "Falta persistir el expediente PENDING");
  assert.ok(providerCall >= 0, "Falta la consulta al proveedor");
  assert.ok(
    pendingWrite < providerCall,
    "El expediente cifrado debe existir antes de iniciar el consumo facturable"
  );

  const pendingStorage = sectionBetween(
    adminStorage,
    "export async function storePendingDataCreditoSecureRecord",
    "export async function completeDataCreditoAssessmentWithSecureRecord"
  );
  assert.match(pendingStorage, /await ensureDataCreditoSchema\(\)/);
  assert.match(pendingStorage, /await upsertSecureRecord\(prisma,\s*input\)/);
});

test("completion y failure guardan payload y estado en una sola transaccion", () => {
  const complete = sectionBetween(
    adminStorage,
    "export async function completeDataCreditoAssessmentWithSecureRecord",
    "export async function failDataCreditoAssessmentWithSecureRecord"
  );
  const failStart = adminStorage.indexOf(
    "export async function failDataCreditoAssessmentWithSecureRecord"
  );
  assert.notEqual(failStart, -1);
  const fail = adminStorage.slice(failStart);

  for (const [name, operation] of [
    ["completion", complete],
    ["failure", fail],
  ]) {
    assert.match(operation, /return prisma\.\$transaction\(async \(transaction\) =>/);
    assert.match(
      operation,
      /await upsertSecureRecord\(transaction,\s*input\.secure\)/
    );
    assert.match(operation, /transaction\.\$queryRawUnsafe/);
    assert.doesNotMatch(operation, /upsertSecureRecord\(prisma,\s*input\.secure\)/);
    assert.ok(
      operation.indexOf("upsertSecureRecord(transaction, input.secure)") <
        operation.indexOf("transaction.$queryRawUnsafe"),
      `${name}: el sobre cifrado debe escribirse dentro de la misma transaccion`
    );
  }

  const post = evaluationRoute.slice(
    evaluationRoute.indexOf("export async function POST")
  );
  assert.ok(
    (post.match(/await failDataCreditoAssessmentWithSecureRecord\(/g) || [])
      .length >= 2,
    "Los fallos evaluables deben persistir el payload de forma atomica"
  );
  assert.equal(
    (post.match(/await completeDataCreditoAssessmentWithSecureRecord\(/g) || [])
      .length,
    1
  );
});

// Execute the production POST handler. HTTP transport, persistence and the paid
// provider are isolated in memory; these tests never reach external services.
const compiledEvaluationRoute = ts.transpileModule(evaluationRoute, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const storageAst = ts.createSourceFile("storage.ts", storage, ts.ScriptTarget.Latest, true);
const realNormalizers = storageAst.statements.filter(node =>
  ts.isFunctionDeclaration(node) &&
  ["normalizeDataCreditoDocument", "normalizeDataCreditoSurname"].includes(node.name?.text)
).map(node => node.getText(storageAst).replace(/^export /, "")).join("\n");
const normalizers = runInNewContext(`${ts.transpileModule(realNormalizers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText}\n({normalizeDataCreditoDocument, normalizeDataCreditoSurname})`);

function evaluationFixture(options = {}) {
  class DataCreditoError extends Error {
    constructor(code, httpStatus = 504) {
      super(code);
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }
  class DataCreditoStorageConfigurationError extends Error {}
  class DataCreditoSecureRecordConfigurationError extends Error {}
  class DataCreditoSecureRecordValidationError extends Error {}
  class ActiveSolicitudConflictError extends Error {}
  class SolicitudDataCreditoLinkError extends Error {}
  const calls = [];
  const state = { cached: options.cached || null, locked: false };
  const user = { id: 4, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSER", aliadoId: 7, sedeId: 9 };
  const owner = { id: 21, usuarioId: 4, vendedorId: null, sedeId: 9, aliadoId: 7,
    clienteDocumento: "0001234567890", clientePrimerApellido: "DE LA PEÑA", plataforma: "IPHONE" };
  const pending = { id: "c23ad54f-3f60-42f6-9941-311c2db08a26", status: "PENDING" };
  const identity = { effective: { names: "María José", firstSurname: "De la Peña", secondSurname: "Muñoz" } };
  const record = (name, input) => calls.push({ name, input });
  const storageMocks = {
    ...normalizers,
    DataCreditoStorageConfigurationError,
    hashDataCreditoRequestMetadata: () => "metadata-hash",
    isDataCreditoAuditConfigured: () => true,
    buildDataCreditoIdentityHashes: input => ({ documentHash: input.documentNumber, surnameHash: input.firstSurname }),
    getAssignedDataCreditoPolicy: async () => ({ kind: "READY", policy: { version: 3, revisionId: 8 } }),
    getDataCreditoAssessmentById: async () => null,
    reuseDataCreditoAssessment: async input => { record("reuse", input); return state.cached; },
    reserveDataCreditoAssessment: async input => {
      record("reserve", input);
      return options.reservation || { kind: "CREATED", assessment: pending,
        dailyQuotaReservation: { allyId: 7, businessDate: "2026-10-09" } };
    },
    serializeDataCreditoAssessment: assessment => ({ assessment: { ...assessment } }),
    failDataCreditoAssessmentBeforeProviderDispatch: async input => record("fail-before-provider", input),
    failDataCreditoAssessment: async input => {
      record("fail", input);
      if (input.errorCode === "PROVIDER_OUTCOME_AMBIGUOUS") state.cached = { kind: "REQUIRES_REVIEW" };
    },
  };
  const dependencies = {
    "node:crypto": { randomUUID },
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getSessionUser: async () => options.authenticated === false ? null : user },
    "@/lib/roles": { isAdminRole: () => options.central !== false },
    "@/lib/aliados": { isFinserPayCentralAlly: () => options.central !== false },
    "@/lib/seller-auth": { getSellerSessionUser: async () => options.seller || null },
    "@/lib/solicitud-operation-access": {
      isDirectSalesProfile: type => type === "ASESOR",
      canOperateSolicitud: () => options.authorized !== false,
    },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async input => record("blacklist", input) },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
    "@/lib/datacredito/config": { resolveDataCreditoConfig: () => ({ timeoutMs: 1000 }) },
    "@/lib/prisma": { default: { $transaction: async operation => operation({}) } },
    "@/lib/datacredito": {
      DataCreditoError,
      allowsDataCreditoNonProductionProvider: () => false,
      getDataCreditoPublicConfig: () => ({ enabled: true, configured: true, productionReady: true, environment: "prod" }),
      queryDataCreditoNaturalPerson: async input => {
        record("provider", input);
        if (options.provider) return options.provider(input, DataCreditoError);
        return { outcome: "SCORE", score: 700, providerPayload: {}, durationMs: 5, transactionCode: "00" };
      },
    },
    "@/lib/datacredito/admin-report": { buildDataCreditoAdminRiskSummary: () => null },
    "@/lib/datacredito/database-errors": { isDataCreditoUniqueViolation: () => false },
    "@/lib/datacredito/daily-quota": { serializeDataCreditoDailyQuota: value => value },
    "@/lib/datacredito/policy": {
      DATACREDITO_MAX_SCORE: 999, DATACREDITO_MIN_SCORE: 0, DATACREDITO_NO_INFORMATION_SCORE: -1,
      isDataCreditoNoInformationScore: score => score === -1,
      normalizeDataCreditoPlatform: platform => ["IPHONE", "ANDROID"].includes(platform) ? platform : null,
      resolveDataCreditoDecision: () => ({ decision: options.decision || "APROBADO", offer: {} }),
    },
    "@/lib/datacredito/admin-storage": {
      storePendingDataCreditoSecureRecord: async input => record("secure", input),
      failDataCreditoAssessmentWithSecureRecord: async input => record("fail-secure", input),
      completeDataCreditoAssessmentWithSecureRecord: async input => {
        record("complete", input);
        const assessment = { id: input.id, status: input.decision, offer: input.offer };
        state.cached = { kind: "REUSED", assessment };
        return assessment;
      },
    },
    "@/lib/datacredito/secure-record": {
      DataCreditoSecureRecordConfigurationError, DataCreditoSecureRecordValidationError,
      assertDataCreditoSecureRecordConfigured() {}, encryptDataCreditoSecureRecord: () => "encrypted-test-envelope",
    },
    "@/lib/datacredito/storage": storageMocks,
    "@/lib/datacredito/resume-gate": { canRecoverAssessmentIdentityMismatch: () => false },
    "@/lib/firmaseguro-storage": {
      getLatestFirmaSeguroProcessByDraft: async () => null,
      tryAcquireSolicitudOperationLock: async () => {
        record("lock");
        if (state.locked) return null;
        state.locked = true;
        return { release: async () => { state.locked = false; record("release"); } };
      },
    },
    "@/lib/firmaseguro-status": { isFirmaSeguroFailedStatus: () => false },
    "@/lib/credit-current-origination-terms": { hasCurrentCreditOriginationTerms: () => true },
    "@/lib/solicitudes-storage": {
      ActiveSolicitudConflictError, SolicitudDataCreditoLinkError,
      getActiveSolicitudCreditContext: async () => owner,
      reserveSolicitudForIdentity: async input => {
        record("solicitud", input);
        owner.clienteDocumento = input.clienteDocumento;
        owner.clientePrimerApellido = input.clientePrimerApellido;
        owner.plataforma = input.plataforma;
        return { id: owner.id };
      },
      attachDataCreditoToSolicitud: async input => record("attach", input),
      markSolicitudDataCreditoRecoverablePending: async input => record("recoverable", input),
      markSolicitudDataCreditoTechnicalError: async input => record("technical", input),
    },
    "@/lib/datacredito/customer-identity": { getDataCreditoCustomerIdentityForDisplay: async () => identity },
  };
  const loaded = { exports: {} };
  runInNewContext(compiledEvaluationRoute, {
    module: loaded, exports: loaded.exports, Date, process: { env: { NODE_ENV: "production" } },
    console: { error: (...args) => record("log", args) },
    require(name) { assert.ok(name in dependencies, `Unexpected endpoint dependency: ${name}`); return dependencies[name]; },
  });
  return {
    calls, state, identity,
    request: body => loaded.exports.POST(new Request("https://qa.invalid/api/creditos/datacredito/evaluaciones", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentNumber: "0001234567890", firstSurname: "De la Peña", platform: "IPHONE", consentAccepted: true, ...body }),
    })),
  };
}

test("el endpoint exige autorización expresa e identidad válida antes de reservar o consultar", async t => {
  for (const [body, code] of [
    [{ consentAccepted: false }, "CONSENT_REQUIRED"],
    [{ consentAccepted: "true" }, "CONSENT_REQUIRED"],
    [{ consentAccepted: null }, "CONSENT_REQUIRED"],
    [{ documentNumber: "12" }, "INVALID_DOCUMENT"],
    [{ documentNumber: "12345678901234" }, "INVALID_DOCUMENT"],
    [{ documentNumber: "1.234.567" }, "INVALID_DOCUMENT"],
    [{ documentNumber: "123 4567" }, "INVALID_DOCUMENT"],
    [{ documentNumber: "123e5" }, "INVALID_DOCUMENT"],
    [{ firstSurname: "" }, "INVALID_SURNAME"],
    [{ firstSurname: "Peña3" }, "INVALID_SURNAME"],
    [{ firstSurname: "A".repeat(81) }, "INVALID_SURNAME"],
  ]) await t.test(`${code}: ${JSON.stringify(body)}`, async () => {
    const api = evaluationFixture();
    const response = await api.request(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, code);
    assert.equal(api.calls.length, 0, "Invalid input must not reserve, audit or contact a provider.");
  });
});

test("el endpoint conserva ceros iniciales, tildes, ñ y apellidos compuestos al consultar", async () => {
  const api = evaluationFixture();
  const response = await api.request({ firstSurname: "  de   la   Pen\u0303a  " });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.assessment.status, "APROBADO");
  assert.deepEqual(payload.identity, api.identity, "Keep the identity returned by the existing display reader.");
  const provider = api.calls.find(call => call.name === "provider").input;
  assert.equal(provider.documentNumber, "0001234567890");
  assert.equal(provider.firstSurname, "DE LA PEÑA");
  assert.ok(api.calls.find(call => call.name === "reserve").input.consentAt instanceof Date);
  assert.equal(api.state.locked, false);
});

test("las credenciales y el alcance bloquean consultas sin permisos", async t => {
  for (const [options, body, status, code] of [
    [{ authenticated: false }, {}, 401, "UNAUTHENTICATED"],
    [{ central: false }, {}, 403, "SELLER_SESSION_REQUIRED"],
    [{ authorized: false }, { solicitudId: 21 }, 403, "SOLICITUD_NOT_AUTHORIZED"],
  ]) await t.test(code, async () => {
    const api = evaluationFixture(options);
    const response = await api.request(body);
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.ok(!api.calls.some(call => ["provider", "reserve", "solicitud"].includes(call.name)));
  });
});

test("doble envío concurrente y reintento posterior despachan una sola consulta simulada", async () => {
  let finishProvider;
  let notifyProvider;
  const providerStarted = new Promise(resolve => { notifyProvider = resolve; });
  const providerPending = new Promise(resolve => { finishProvider = resolve; });
  const api = evaluationFixture({ provider: () => { notifyProvider(); return providerPending; } });
  const first = api.request({});
  await providerStarted;
  const simultaneous = await api.request({});
  assert.equal(simultaneous.status, 409);
  assert.equal((await simultaneous.json()).code, "SOLICITUD_OPERATION_IN_PROGRESS");
  finishProvider({ outcome: "SCORE", score: 700, providerPayload: {}, durationMs: 5 });
  assert.equal((await first).status, 200);
  const retry = await api.request({});
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).reused, true);
  assert.equal(api.calls.filter(call => call.name === "provider").length, 1);
  assert.equal(api.calls.filter(call => call.name === "reserve").length, 1);
  assert.equal(api.state.locked, false);
});

test("un resultado ambiguo no se repite automáticamente ni con un nuevo envío manual", async () => {
  const api = evaluationFixture({ provider: (_input, ProviderError) => { throw new ProviderError("PROVIDER_TIMEOUT"); } });
  const first = await api.request({});
  assert.equal(first.status, 504);
  assert.equal((await first.json()).code, "PROVIDER_TIMEOUT");
  assert.equal(api.calls.find(call => call.name === "fail").input.errorCode, "PROVIDER_OUTCOME_AMBIGUOUS");
  const retry = await api.request({});
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, "ASSESSMENT_REQUIRES_REVIEW");
  assert.equal(api.calls.filter(call => call.name === "provider").length, 1);
  assert.equal(api.state.locked, false);
});

test("reutilizar una aprobación o rechazo vigente conserva la decisión sin consumo del proveedor", async t => {
  for (const status of ["APROBADO", "RECHAZADO"]) await t.test(status, async () => {
    const api = evaluationFixture({ cached: { kind: "REUSED", assessment: { id: "saved-assessment", status } } });
    const response = await api.request({});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.reused, true);
    assert.equal(payload.assessment.status, status);
    assert.ok(!api.calls.some(call => ["provider", "reserve"].includes(call.name)));
  });
});
