import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveAllyPaymentViewerScope } from "../lib/ally-payments-core.ts";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (relativePath) =>
  readFile(path.join(projectRoot, relativePath), "utf8");

const [
  accessSource,
  collectionRoute,
  detailRoute,
  storage,
  schema,
  preflight,
  railwayPredeploy,
  dockerfile,
  packageJson,
  sidebarSource,
  consoleSource,
  pageSource,
] = await Promise.all([
  readProjectFile("lib/ally-payment-access.ts"),
  readProjectFile("app/api/pagos-aliados/route.ts"),
  readProjectFile("app/api/pagos-aliados/[id]/route.ts"),
  readProjectFile("lib/ally-payments.ts"),
  readProjectFile("prisma/schema.prisma"),
  readProjectFile("scripts/ensure-ally-payments-schema.mjs"),
  readProjectFile("scripts/railway-predeploy.mjs"),
  readProjectFile("Dockerfile"),
  readProjectFile("package.json"),
  readProjectFile("app/dashboard/_components/admin-sidebar.tsx"),
  readProjectFile("app/dashboard/pagos-aliados/ally-payments-console.tsx"),
  readProjectFile("app/dashboard/pagos-aliados/page.tsx"),
]);

function sectionBetween(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker);
  assert.notEqual(start, -1, "No se encontro el inicio: " + startMarker);

  const end = contents.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, "No se encontro el final: " + endMarker);
  return contents.slice(start, end);
}

function sectionFrom(contents, startMarker) {
  const start = contents.indexOf(startMarker);
  assert.notEqual(start, -1, "No se encontro la seccion: " + startMarker);
  return contents.slice(start);
}

function assertInOrder(contents, markers, message) {
  let previous = -1;
  for (const marker of markers) {
    const position = contents.indexOf(marker, previous + 1);
    assert.ok(position >= 0, message + ": falta " + marker);
    assert.ok(position > previous, message + ": " + marker + " esta fuera de orden");
    previous = position;
  }
}

function modelBlock(modelName) {
  const startMarker = "model " + modelName + " {";
  const start = schema.indexOf(startMarker);
  assert.notEqual(start, -1, "No se encontro el modelo " + modelName);

  const nextModel = schema.indexOf("\nmodel ", start + startMarker.length);
  return schema.slice(start, nextModel === -1 ? schema.length : nextModel);
}

function fieldLine(model, fieldName) {
  const line = model
    .split(/\r?\n/)
    .find((candidate) =>
      new RegExp("^\\s*" + fieldName + "\\s+").test(candidate)
    );
  assert.ok(line, "No se encontro el campo " + fieldName);
  return line;
}

test("resuelve permisos ejecutables para central, aliado y fallo cerrado", () => {
  const base = {
    authenticated: true,
    roleName: "ADMIN",
    allyAccessCode: "ALIADO",
    allyAccessId: 27,
  };

  assert.deepEqual(
    resolveAllyPaymentViewerScope({ ...base, authenticated: false }),
    { kind: "UNAUTHENTICATED" }
  );
  assert.deepEqual(
    resolveAllyPaymentViewerScope({ ...base, roleName: "ASESOR" }),
    { kind: "FORBIDDEN" }
  );
  assert.deepEqual(
    resolveAllyPaymentViewerScope({
      ...base,
      allyAccessCode: " finserpay ",
      allyAccessId: null,
    }),
    { kind: "CENTRAL_ADMIN", allyId: null }
  );
  assert.deepEqual(resolveAllyPaymentViewerScope(base), {
    kind: "ALLY_ADMIN",
    allyId: 27,
  });
  assert.deepEqual(
    resolveAllyPaymentViewerScope({ ...base, allyAccessId: null }),
    { kind: "FORBIDDEN" }
  );
  assert.deepEqual(
    resolveAllyPaymentViewerScope({ ...base, allyAccessId: 0 }),
    { kind: "FORBIDDEN" }
  );
});

test("la capa server-only delega el permiso puro y solo el central crea", () => {
  const resolver = sectionBetween(
    accessSource,
    "export function resolveAllyPaymentAccessForUser",
    "export async function getAllyPaymentAccess"
  );
  const createPermission = sectionFrom(
    accessSource,
    "export function canCreateAllyPayment"
  );

  assert.match(resolver, /resolveAllyPaymentViewerScope\s*\(/);
  assert.match(resolver, /authenticated:\s*Boolean\(user\)/);
  assert.match(resolver, /roleName:\s*user\?\.rolNombre/);
  assert.match(resolver, /allyAccessCode:\s*user\?\.aliadoAccesoCodigo/);
  assert.match(resolver, /allyAccessId:\s*user\?\.aliadoAccesoId/);
  assert.match(
    resolver,
    /scope\.kind\s*===\s*"UNAUTHENTICATED"[\s\S]*?status:\s*401/
  );
  assert.match(
    resolver,
    /scope\.kind\s*===\s*"FORBIDDEN"[\s\S]*?status:\s*403/
  );
  assert.match(
    resolver,
    /scope\.kind\s*===\s*"CENTRAL_ADMIN"[\s\S]*?allyId:\s*null/
  );
  assert.match(resolver, /kind:\s*"ALLY_ADMIN"[\s\S]*?allyId:\s*scope\.allyId/);
  assert.match(
    createPermission,
    /return\s+access\.kind\s*===\s*"CENTRAL_ADMIN"/
  );
});

test("las rutas aplican alcance por aliado y reservan escritura al central", () => {
  const scopeResolver = sectionBetween(
    collectionRoute,
    "function resolveAllyScope",
    "function errorResponse"
  );
  const getHandler = sectionBetween(
    collectionRoute,
    "export async function GET",
    "export async function POST"
  );
  const postHandler = sectionFrom(collectionRoute, "export async function POST");
  const detailGet = sectionFrom(detailRoute, "export async function GET");

  assert.match(
    scopeResolver,
    /access\.kind\s*===\s*"CENTRAL_ADMIN"[\s\S]*?allyId:\s*requestedAllyId/
  );
  assert.match(
    scopeResolver,
    /requestedAllyId\s*!==\s*null[\s\S]*?requestedAllyId\s*!==\s*access\.allyId[\s\S]*?scopeError/
  );
  assert.match(scopeResolver, /return\s*{\s*allyId:\s*access\.allyId/);

  assert.match(getHandler, /await\s+getAllyPaymentAccess\(\)/);
  assert.match(
    getHandler,
    /listAllyPaymentPending\(\s*{\s*allyId:\s*scope\.allyId\s*}\s*\)/
  );
  assert.match(
    getHandler,
    /listAllyPaymentHistory\(\s*{\s*allyId:\s*scope\.allyId\s*}\s*\)/
  );
  assert.match(
    getHandler,
    /getAllyPaymentPreview\(\s*{[\s\S]*?allyId:\s*scope\.allyId/
  );
  assert.match(
    getHandler,
    /access\.kind\s*===\s*"CENTRAL_ADMIN"[\s\S]*?listAllyPaymentAllies\(\)/
  );

  assertInOrder(
    postHandler,
    [
      "await getAllyPaymentAccess()",
      "canCreateAllyPayment(access)",
      "await request.json()",
      "await createAllyPayment({",
    ],
    "La autorizacion de escritura debe preceder al body y a la mutacion"
  );
  assert.match(
    postHandler,
    /canCreateAllyPayment\(access\)[\s\S]*?status:\s*403/
  );
  assert.match(postHandler, /registradoPorUsuarioId:\s*access\.user\.id/);
  assert.match(postHandler, /registradoPorNombre:\s*access\.user\.nombre/);

  assert.match(detailGet, /await\s+getAllyPaymentAccess\(\)/);
  assert.match(
    detailGet,
    /allyId:\s*access\.kind\s*===\s*"CENTRAL_ADMIN"\s*\?\s*null\s*:\s*access\.allyId/
  );
});

test("las consultas excluyen pagados y acotan aliado y periodo en base de datos", () => {
  const eligibleQuery = sectionBetween(
    storage,
    "async function loadEligibleCreditRows",
    "async function loadEligibleLines"
  );
  const history = sectionBetween(
    storage,
    "export async function listAllyPaymentHistory",
    "export async function getAllyPaymentDetail"
  );
  const detail = sectionBetween(
    storage,
    "export async function getAllyPaymentDetail",
    "function moneyForDatabase"
  );

  assert.match(
    eligibleQuery,
    /JOIN\s+"Sede"\s+site[\s\S]*?JOIN\s+"Aliado"\s+ally/
  );
  assert.match(
    eligibleQuery,
    /LEFT JOIN\s+"LiquidacionAliadoCredito"\s+paid[\s\S]*?WHERE\s+paid\."id"\s+IS NULL/
  );
  assert.match(
    eligibleQuery,
    /\(\$1::integer\s+IS NULL\s+OR\s+ally\."id"\s*=\s*\$1\)/
  );
  assert.match(eligibleQuery, /credit\."fechaCredito"\s*>=\s*\$2/);
  assert.match(eligibleQuery, /credit\."fechaCredito"\s*<\s*\$3/);
  assert.match(eligibleQuery, /credit\."fechaCredito"\s*>=\s*\$6/);
  assert.match(
    eligibleQuery,
    /UPPER\(BTRIM\(COALESCE\(ally\."codigo",\s*''\)\)\)\s*<>\s*\$5/
  );
  assert.match(eligibleQuery, /FOR UPDATE OF credit/);

  assert.match(
    history,
    /periodoInicio:\s*{\s*gte:\s*dateForDatabase\(ALLY_PAYMENTS_AVAILABLE_FROM\)\s*}/
  );
  assert.match(history, /\.\.\.\(allyId\s*===\s*null\s*\?\s*{}\s*:\s*{\s*aliadoId:\s*allyId\s*}\)/);
  assert.match(
    detail,
    /\.\.\.\(allyId\s*===\s*null\s*\?\s*{}\s*:\s*{\s*aliadoId:\s*allyId\s*}\)/
  );
  assert.match(
    detail,
    /periodoInicio:\s*{\s*gte:\s*dateForDatabase\(ALLY_PAYMENTS_AVAILABLE_FROM\)\s*}/
  );
});

test("el modulo usa el rotulo solicitado y limita las fechas desde septiembre", () => {
  assert.match(sidebarSource, /label:\s*"PAGOS ALIADO"/);
  assert.doesNotMatch(sidebarSource, /Pagos recibidos \/ Pagos pendientes/);
  assert.match(pageSource, /current="PAGOS ALIADO"/);
  assert.match(consoleSource, /title="PAGOS ALIADO"/);
  assert.match(consoleSource, /min={ALLY_PAYMENTS_AVAILABLE_FROM}/);
  assert.match(
    consoleSource,
    /fechaInicio\s*<\s*ALLY_PAYMENTS_AVAILABLE_FROM[\s\S]*?fechaFin\s*<\s*ALLY_PAYMENTS_AVAILABLE_FROM/
  );
  assert.match(
    storage,
    /return\s+resolveAvailableAllyPaymentPeriod\(startDate,\s*endDate\)/
  );
});

test("la creacion es serializable e idempotente bajo locks de mutacion y aliado", () => {
  const create = sectionFrom(storage, "export async function createAllyPayment");
  const requestHash = sectionBetween(
    storage,
    "function requestFingerprint",
    "function serializeStoredLine"
  );

  assert.match(create, /prisma\.\$transaction\(/);
  assert.match(create, /isolationLevel:\s*"Serializable"/);
  assert.equal(
    (create.match(/pg_advisory_xact_lock/g) || []).length,
    2,
    "La mutacion y el aliado requieren locks independientes"
  );
  assertInOrder(
    create,
    [
      '"ALLY_PAYMENT_MUTATION:" + mutationId',
      "const existing =",
      '"ALLY_PAYMENT_ALLY:" + allyId',
      "const approvalAlreadyUsed =",
      "lock: true",
      "const currentPreviewToken =",
      "await tx.liquidacionAliado.create",
    ],
    "La secuencia transaccional"
  );
  assert.match(
    create,
    /existing\.requestHash\s*!==\s*requestHash[\s\S]*?"ALLY_PAYMENT_MUTATION_CONFLICT"/
  );
  assert.match(
    create,
    /serializeSettlement\(existing\)[\s\S]*?idempotent:\s*true/
  );
  assert.match(
    create,
    /currentPreviewToken\s*!==\s*previewToken[\s\S]*?"ALLY_PAYMENT_PREVIEW_CHANGED"/
  );

  for (const field of [
    "aliadoId",
    "periodoInicio",
    "periodoFin",
    "numeroAprobacionNormalizado",
    "previewToken",
  ]) {
    assert.match(requestHash, new RegExp("\\b" + field + ":"));
  }
  assert.match(create, /requestHash,/);
});

test("aprobacion, mutationId y credito tienen defensa duplicada en app y base", () => {
  const header = modelBlock("LiquidacionAliado");
  const credit = modelBlock("LiquidacionAliadoCredito");
  const create = sectionFrom(storage, "export async function createAllyPayment");

  assert.match(fieldLine(header, "mutationId"), /\bString\b.*@unique.*@db\.Uuid/);
  assert.match(
    fieldLine(header, "numeroAprobacionNormalizado"),
    /\bString\b.*@unique/
  );
  assert.match(fieldLine(credit, "creditoId"), /\bInt\b.*@unique/);

  assert.match(
    create,
    /findUnique\(\s*{[\s\S]*?numeroAprobacionNormalizado:\s*approval\.normalized/
  );
  assert.match(
    create,
    /approvalAlreadyUsed[\s\S]*?"ALLY_PAYMENT_DUPLICATE"/
  );
  assert.match(
    create,
    /isDataCreditoUniqueViolation\(error\)[\s\S]*?"ALLY_PAYMENT_DUPLICATE"/
  );

  for (const indexName of [
    "LiquidacionAliado_mutationId_key",
    "LiquidacionAliado_numeroAprobacionNormalizado_key",
    "LiquidacionAliadoCredito_creditoId_key",
  ]) {
    assert.match(
      preflight,
      new RegExp(
        "CREATE UNIQUE INDEX IF NOT EXISTS [\"']?" + indexName + "[\"']?"
      )
    );
  }
});

test("persiste y devuelve snapshots historicos sin recalcular el detalle", () => {
  const create = sectionFrom(storage, "export async function createAllyPayment");
  const lineSerializer = sectionBetween(
    storage,
    "function serializeStoredLine",
    "function serializeSettlement"
  );
  const settlementSerializer = sectionBetween(
    storage,
    "function serializeSettlement",
    "async function requirePayableAlly"
  );

  for (const field of [
    "folio",
    "clienteNombre",
    "equipo",
    "plataforma",
    "valorVenta",
    "creditoAutorizado",
    "cuotaInicial",
    "porcentajeIntermediacion",
    "valorIntermediacion",
    "valorPagar",
  ]) {
    assert.match(
      create,
      new RegExp(
        "\\b" +
          field +
          ":\\s*(?:moneyForDatabase\\(|percentageForDatabase\\()?\\s*item\\." +
          field
      )
    );
    assert.match(lineSerializer, new RegExp("detail\\." + field));
  }
  assert.match(
    create,
    /fechaCredito:\s*creditDateForDatabase\(item\.fechaCredito\)/
  );
  assert.match(create, /estado:\s*"PAGADO"/);
  assert.match(lineSerializer, /estado:\s*(?:"PAGADO"|detail\.estado)/);
  assert.doesNotMatch(
    lineSerializer,
    /resolveRedescuentoPercentageByPlatform|calculateAllyPaymentAmounts/
  );

  for (const field of [
    "mutationId",
    "periodoInicio",
    "periodoFin",
    "numeroAprobacionBancaria",
    "estado",
    "numeroCreditos",
    "totalValorVenta",
    "totalCreditoAutorizado",
    "totalCuotaInicial",
    "totalIntermediacion",
    "totalPagar",
    "registradoPorNombre",
    "pagadoAt",
    "createdAt",
  ]) {
    assert.match(settlementSerializer, new RegExp("settlement\\." + field));
  }
  assert.doesNotMatch(
    settlementSerializer,
    /requestHash:\s*settlement\.requestHash/,
    "El hash de idempotencia es interno y no pertenece al DTO publico"
  );
});

test("Prisma conserva relaciones restrictivas, fechas, estados y precision decimal", () => {
  const header = modelBlock("LiquidacionAliado");
  const credit = modelBlock("LiquidacionAliadoCredito");

  assert.match(fieldLine(header, "requestHash"), /\bString\b.*@db\.Char\(64\)/);
  assert.match(fieldLine(header, "periodoInicio"), /\bDateTime\b.*@db\.Date/);
  assert.match(fieldLine(header, "periodoFin"), /\bDateTime\b.*@db\.Date/);
  assert.match(fieldLine(header, "estado"), /@default\("PAGADA"\)/);
  assert.match(fieldLine(header, "registradoPorUsuarioId"), /\bInt\b/);
  assert.match(fieldLine(header, "registradoPorNombre"), /\bString\b/);
  for (const field of [
    "totalValorVenta",
    "totalCreditoAutorizado",
    "totalCuotaInicial",
    "totalIntermediacion",
    "totalPagar",
  ]) {
    assert.match(
      fieldLine(header, field),
      /\bDecimal\b.*@db\.Decimal\(20,\s*2\)/
    );
  }
  for (const relation of ["aliado", "registradoPor"]) {
    assert.match(fieldLine(header, relation), /onDelete:\s*Restrict/);
  }

  for (const field of [
    "fechaCredito",
    "folio",
    "clienteNombre",
    "equipo",
    "plataforma",
    "estado",
    "createdAt",
  ]) {
    fieldLine(credit, field);
  }
  for (const field of [
    "valorVenta",
    "creditoAutorizado",
    "cuotaInicial",
    "valorIntermediacion",
    "valorPagar",
  ]) {
    assert.match(
      fieldLine(credit, field),
      /\bDecimal\b.*@db\.Decimal\(20,\s*2\)/
    );
  }
  assert.match(
    fieldLine(credit, "porcentajeIntermediacion"),
    /\bDecimal\b.*@db\.Decimal\(7,\s*4\)/
  );
  assert.match(fieldLine(credit, "estado"), /@default\("PAGADO"\)/);
  for (const relation of ["liquidacion", "credito"]) {
    assert.match(fieldLine(credit, relation), /onDelete:\s*Restrict/);
  }
});

test("el preflight es idempotente, transaccional y valida el contrato instalado", () => {
  const compactSql = preflight.replace(/\s+/g, " ");

  assert.match(
    compactSql,
    /CREATE TABLE IF NOT EXISTS public\."LiquidacionAliado" \(/
  );
  assert.match(
    compactSql,
    /CREATE TABLE IF NOT EXISTS public\."LiquidacionAliadoCredito" \(/
  );
  assert.ok(
    (preflight.match(/ON DELETE RESTRICT/g) || []).length >= 4,
    "Las cuatro relaciones deben impedir borrados historicos"
  );
  assert.match(
    compactSql,
    /CHECK \("plataforma" IN \('ANDROID', 'IPHONE'\)\)/
  );
  assert.match(
    compactSql,
    /"porcentajeIntermediacion" >= 0 AND "porcentajeIntermediacion" <= 100/
  );
  assert.match(
    compactSql,
    /"creditoAutorizado" = "valorVenta" - "cuotaInicial"/
  );
  assert.match(
    compactSql,
    /ARRAY_AGG\(attribute\.attname::text ORDER BY key_column\.ordinality\) AS columns/
  );
  assert.match(
    compactSql,
    /"valorPagar" = "creditoAutorizado" - "valorIntermediacion"/
  );
  assert.match(compactSql, /"estado" = 'PAGADA'/);
  assert.match(compactSql, /"estado" = 'PAGADO'/);

  for (const contract of [
    "expectedColumns",
    "expectedIndexes",
    "expectedConstraints",
    "assertCompatibleColumns",
    "assertCompatibleIndexes",
    "assertCompatibleConstraints",
  ]) {
    assert.match(preflight, new RegExp("\\b" + contract + "\\b"));
  }
  assertInOrder(
    preflight,
    [
      'client.query("BEGIN")',
      "pg_advisory_xact_lock",
      "for (const statement of statements)",
      "await assertCompatibleColumns()",
      "await assertCompatibleIndexes()",
      "await assertCompatibleConstraints()",
      'client.query("COMMIT")',
    ],
    "El preflight"
  );
  assert.match(preflight, /client\.query\("ROLLBACK"\)/);

  assert.match(
    railwayPredeploy,
    /import\(\s*"\.\/ensure-ally-payments-schema\.mjs"\s*\)/
  );
  assert.match(
    dockerfile,
    /COPY\s+--from=builder\s+\/app\/scripts\/ensure-ally-payments-schema\.mjs\s+\.\/scripts\/ensure-ally-payments-schema\.mjs/
  );
});

test("el script npm ejecuta las pruebas de nucleo y contrato juntas", () => {
  const command = JSON.parse(packageJson).scripts["test:pagos-aliados"];

  assert.equal(typeof command, "string");
  assert.match(command, /(?:^|\s)--test(?:\s|$)/);
  assert.match(command, /tests\/ally-payments-core\.test\.mjs/);
  assert.match(command, /tests\/ally-payments\.test\.mjs/);
});
