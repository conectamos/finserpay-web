import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

const [searchRoute, authorizeRoute, storage, adminConsole, confirmDialog] =
  await Promise.all([
  source("app/api/creditos/datacredito/admin/liberaciones/buscar/route.ts"),
  source(
    "app/api/creditos/datacredito/admin/evaluaciones/[id]/autorizar-reintento/route.ts"
  ),
  source("lib/datacredito/admin-retry-storage.ts"),
  source(
    "app/dashboard/datacredito/liberaciones/tx06-release-console.tsx"
  ),
  source("app/_components/finser-confirm-dialog.tsx"),
  ]);

function exportedFunction(contents, name) {
  const start = contents.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `No se encontró ${name}`);
  const next = contents.indexOf("\nexport ", start + 1);
  return contents.slice(start, next === -1 ? contents.length : next);
}

function assertCentralAccessBeforeInput(contents, label) {
  const post = exportedFunction(contents, "POST");
  const access = post.indexOf("getDataCreditoCentralAdmin(");
  const params = post.indexOf("context.params");
  const body = post.indexOf("request.json(");
  assert.ok(access >= 0, `${label}: falta autenticación central`);
  if (params >= 0) {
    assert.ok(access < params, `${label}: no debe leer params antes de autenticar`);
  }
  assert.ok(
    body >= 0 && access < body,
    `${label}: no debe leer body antes de autenticar`
  );
}

test("las rutas son POST privadas, no cacheables y autentican antes de leer entrada", () => {
  for (const [label, route] of [
    ["buscar", searchRoute],
    ["autorizar", authorizeRoute],
  ]) {
    assert.match(route, /export const runtime = "nodejs"/);
    assert.match(route, /export const dynamic = "force-dynamic"/);
    assert.match(route, /export async function POST\(/);
    assert.doesNotMatch(
      route,
      /export async function (?:GET|PUT|PATCH|DELETE)\(/
    );
    assert.match(
      route,
      /Cache-Control["']?:\s*["']private, no-store, max-age=0["']/
    );
    assertCentralAccessBeforeInput(route, label);
  }
});

test("valida JSON, cédula, apellido e idempotency key antes de autorizar", () => {
  assert.match(searchRoute, /INVALID_REQUEST/);
  assert.match(authorizeRoute, /INVALID_REQUEST/);
  for (const code of [
    "INVALID_DOCUMENT",
    "INVALID_SURNAME",
    "INVALID_ASSESSMENT_ID",
    "INVALID_MUTATION_ID",
  ]) {
    assert.ok(
      storage.includes(code),
      `Storage no expone el error estable ${code}`
    );
  }
  assert.match(storage, /normalizeDataCreditoDocument/);
  assert.match(storage, /normalizeDataCreditoSurname/);
  assert.match(storage, /\^\\d\{3,13\}\$/);
  assert.match(storage, /\\p\{L\}\\p\{M\}/);
  assert.match(storage, /INVALID_ASSESSMENT_ID/);
  assert.match(storage, /INVALID_MUTATION_ID/);
  const sameSurname = storage.indexOf(
    "assessment.surnameHash === surnameHash"
  );
  const unchangedError = storage.indexOf(
    '"RETRY_SURNAME_UNCHANGED"',
    sameSurname
  );
  const firstMutation = storage.indexOf(
    'UPDATE "DataCreditoAssessment"'
  );
  assert.ok(sameSurname >= 0, "Debe comparar el hash del apellido corregido");
  assert.ok(
    unchangedError > sameSurname && unchangedError < firstMutation,
    "Debe rechazar el mismo apellido antes de modificar el expediente"
  );
  assert.doesNotMatch(`${authorizeRoute}\n${storage}`, /forceReentry/i);
});

test("loadCandidate evita el alias SQL reservado authorization", () => {
  const start = storage.indexOf("async function loadCandidate(");
  const end = storage.indexOf(
    "\nexport async function findDataCreditoAdminRetryCandidate",
    start
  );
  assert.ok(start >= 0 && end > start, "No se encontró loadCandidate");
  const loadCandidate = storage.slice(start, end);
  assert.doesNotMatch(loadCandidate, /\)\s+authorization\s+ON\s+TRUE\b/i);
  assert.doesNotMatch(loadCandidate, /\bauthorization\."authorizedAt"/i);
  assert.match(
    loadCandidate,
    /\)\s+retry_authorization\s+ON\s+TRUE\b/i
  );
  assert.match(loadCandidate, /\bretry_authorization\."authorizedAt"/i);
});

test("storage usa una allowlist positiva y jamás libera un RECHAZADO", () => {
  const authorize = exportedFunction(
    storage,
    "authorizeDataCreditoAdminRetry"
  );
  for (const condition of [
    /"reusedFromAssessmentId" IS NULL/,
    /"status" = 'NO_EVALUADO'/,
    /"score" IS NULL/,
    /"errorCode" = 'NO_EVALUABLE_INFORMATION'/,
    /"providerStatus" = 'ACCEPTED'/,
    /"transactionCode" = '06'/,
    /"consumedAt" IS NULL/,
    /"creditId" IS NULL/,
    /"expiresAt" > \$4::timestamp/,
    /"retainedUntil" > \$4::timestamp/,
  ]) {
    assert.match(authorize, condition);
  }
  assert.match(
    storage,
    /\["APROBADO", "RECHAZADO"\]\.includes\(normalizedCode\(row\.status\)\)/
  );
  assert.match(storage, /code: "FINAL_DECISION"/);
  assert.doesNotMatch(
    authorize,
    /"status"\s*(?:<>|!=)\s*'RECHAZADO'/
  );
  assert.doesNotMatch(authorize, /"status"\s+NOT\s+IN/i);
  assert.ok(storage.includes("RETRY_NOT_ELIGIBLE"));
});

test("autoriza bajo locks compartidos antes de bloquear filas", () => {
  const authorize = exportedFunction(
    storage,
    "authorizeDataCreditoAdminRetry"
  );
  const operationLock = authorize.indexOf(
    "lockSolicitudOperationMutation("
  );
  const documentLock = authorize.indexOf("datacredito-document");
  const rowLock = authorize.indexOf("FOR UPDATE");
  const lastRowLock = authorize.lastIndexOf("FOR UPDATE");
  const operationTimestamp = authorize.indexOf("clock_timestamp()");
  assert.ok(
    operationLock >= 0,
    "Falta el lock de operación de la solicitud"
  );
  assert.ok(
    documentLock > operationLock,
    "El lock documental debe ir después del lock de solicitud"
  );
  assert.match(
    authorize,
    /transaction\.\$executeRawUnsafe\(\s*`SELECT pg_advisory_xact_lock/,
    "El lock documental no debe intentar deserializar el retorno void de PostgreSQL"
  );
  assert.doesNotMatch(
    authorize,
    /transaction\.\$queryRawUnsafe(?:<[^>]+>)?\(\s*`SELECT pg_advisory_xact_lock/,
    "Prisma falla si pg_advisory_xact_lock se ejecuta como queryRaw"
  );
  assert.ok(
    rowLock > documentLock,
    "No se deben bloquear filas antes de adquirir ambos advisory locks"
  );
  assert.ok(
    operationTimestamp > lastRowLock,
    "La hora real de autorización debe tomarse después de adquirir todos los locks"
  );
  assert.equal(
    (authorize.match(/clock_timestamp\(\)/g) || []).length,
    1,
    "Toda la mutación debe compartir una sola hora real"
  );
  assert.doesNotMatch(authorize, /SELECT CURRENT_TIMESTAMP AS "authorizedAt"/);
  assert.match(authorize, /prisma\.\$transaction\(/);
});

test("la mutación conserva el expediente y solo vence el root y reabre el borrador", () => {
  const authorize = exportedFunction(
    storage,
    "authorizeDataCreditoAdminRetry"
  );
  assert.match(authorize, /SET "expiresAt" = LEAST\(/);
  const rootUpdateStart = authorize.indexOf(
    'UPDATE "DataCreditoAssessment"'
  );
  const rootWhere = authorize.indexOf("WHERE", rootUpdateStart);
  const rootSet = authorize.slice(rootUpdateStart, rootWhere);
  assert.doesNotMatch(
    rootSet,
    /"status"|"errorCode"|"providerStatus"|"transactionCode"|"score"/,
    "El root histórico solo debe cambiar expiresAt"
  );
  assert.match(authorize, /"dataCreditoAssessmentId" = NULL/);
  assert.match(authorize, /-\s*'dataCreditoAssessmentId'/);
  assert.match(authorize, /'dataCreditoStatus',\s*'PENDING'/);
  assert.match(
    authorize,
    /'dataCreditoErrorCode',\s*'ASSESSMENT_RETRY_AUTHORIZED'/
  );
  assert.match(authorize, /'clientePrimerApellido'/);
  assert.doesNotMatch(
    authorize,
    /DELETE\s+FROM\s+"DataCreditoAssessment"/i
  );
  assert.doesNotMatch(
    authorize,
    /DataCreditoDailyQuotaUsage|reserveDataCreditoDailyQuota/
  );
  assert.doesNotMatch(authorize, /queryDataCreditoNaturalPerson/);
});

test("audita la autorización exacta y soporta replay idempotente", () => {
  const authorize = exportedFunction(
    storage,
    "authorizeDataCreditoAdminRetry"
  );
  assert.match(authorize, /DataCreditoAdminAccessAudit/);
  assert.match(storage, /const RETRY_ACTION = "OPS_TX06_RETRY_AUTHORIZED"/);
  assert.match(storage, /const RETRY_OUTCOME = "AUTHORIZED"/);
  assert.match(authorize, /requestCorrelationId/);
  for (const field of [
    "assessmentId",
    "actorUserId",
    "mutationId",
    "ipHash",
    "userAgentHash",
    "retainedUntil",
  ]) {
    assert.ok(
      authorize.includes(field),
      `La auditoría debe incluir ${field}`
    );
  }
  const rowLock = authorize.indexOf("FOR UPDATE");
  const replayQuery = authorize.indexOf("const previousAuthorization");
  const replayGuard = authorize.indexOf("if (previousAuthorization[0])");
  const expiryUpdate = authorize.indexOf(
    'UPDATE "DataCreditoAssessment"'
  );
  assert.ok(
    replayQuery > rowLock && replayGuard > replayQuery,
    "El replay debe revalidarse bajo los locks"
  );
  assert.ok(
    replayGuard < expiryUpdate,
    "El replay debe resolverse antes de volver a mutar"
  );
  assert.ok(
    authorize.indexOf('INSERT INTO "DataCreditoAdminAccessAudit"') >
      authorize.indexOf('UPDATE "CreditoBorrador"'),
    "La auditoría debe quedar en la misma transacción después de ambas mutaciones"
  );
});

test("la consola usa elegibilidad top-level del servidor y bloquea dobles envíos", () => {
  assert.match(storage, /eligible: eligibility\.eligible/);
  assert.match(storage, /eligibilityMessage: eligibility\.message/);
  assert.match(authorizeRoute, /result:\s*\{\s*\.\.\.result,/);
  assert.match(storage, /draftId: number \| null/);
  assert.match(authorizeRoute, /eligible: false/);
  assert.match(adminConsole, /lookupResult\?\.eligible/);
  assert.match(adminConsole, /lookupResult\.eligibilityMessage/);
  assert.doesNotMatch(
    adminConsole,
    /(?:canAuthorize|eligible)\s*=\s*[^;]*status\s*!==\s*["']RECHAZADO["']/
  );
  assert.match(
    adminConsole,
    /\/api\/creditos\/datacredito\/admin\/liberaciones\/buscar/
  );
  assert.match(adminConsole, /autorizar-reintento/);
  assert.match(adminConsole, /mutationId/);
  assert.match(adminConsole, /if \(!pending \|\| submittingRef\.current\) return/);
  assert.match(adminConsole, /submittingRef\.current = true/);
  assert.match(adminConsole, /submittingRef\.current = false/);
  assert.match(
    adminConsole,
    /disabled=\{[^}]*?(?:authoriz|submitt|saving|loading|busy)/i
  );
  assert.match(adminConsole, /eligible: false/);
  assert.match(adminConsole, /alreadyAuthorized: true/);
  assert.match(adminConsole, /autoComplete="off"/);
  assert.doesNotMatch(adminConsole, /autoComplete="family-name"/);
  assert.match(confirmDialog, /event\.key !== "Tab"/);
  assert.match(confirmDialog, /document\.addEventListener\("focusin"/);
  assert.match(confirmDialog, /previousFocus\?\.isConnected/);
});
