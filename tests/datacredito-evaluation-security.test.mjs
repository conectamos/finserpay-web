import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.doesNotMatch(post, /riskSummary\?\.totals\.delinquentBalance/);
  assert.match(post, /priorityRuleEnabled/);
  assert.match(post, /telcoRiskMetricValid/);
  assert.match(post, /telcoRiskMetricUnavailable/);
  assert.match(
    post,
    /failDataCreditoAssessmentWithSecureRecord[\s\S]*?TELCO_RISK_METRIC_UNAVAILABLE/
  );
  assert.match(
    post,
    /resolveDataCreditoDecision\([\s\S]*?telcoDelinquentBalanceCop,[\s\S]*?telcoDelinquencyInformationAvailable/
  );
  assert.match(post, /\.\.\.serializeDataCreditoAssessment\(completed\)/);
  assert.doesNotMatch(
    post,
    /NextResponse\.json\([\s\S]{0,300}providerPayload:\s*result\.providerPayload/
  );

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
