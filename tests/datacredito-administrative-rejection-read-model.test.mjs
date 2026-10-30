import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const assessmentId = "11111111-1111-4111-8111-111111111111";
const otherAssessmentId = "22222222-2222-4222-8222-222222222222";
const documentNumber = "0001234567";
const firstSurname = "PRUEBA";
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const getSource = read("app/api/creditos/datacredito/evaluaciones/[id]/route.ts");
const baseUser = { id: 20, rolNombre: "VENDEDOR", sedeId: 65, aliadoId: 88 };
const hashes = ({ documentNumber: document, firstSurname: surname }) => ({
  documentHash: `document:${document}`, surnameHash: `surname:${surname}`,
});

function getFixture(options = {}) {
  const calls = [];
  const row = {
    id: assessmentId, ...hashes({ documentNumber, firstSurname }),
    userId: 20, sellerId: 46, sedeId: 65, aliadoId: 88, platform: "IPHONE",
    status: "NO_EVALUADO", errorCode: "NO_EVALUABLE_INFORMATION", score: null,
    providerStatus: "ACCEPTED", transactionCode: "07", providerEnvironment: "production",
    consumedAt: null, creditId: null, expiresAt: new Date("2099-01-01T00:00:00Z"),
    correlationId: "tracking-test", ...options.row,
  };
  const draft = {
    id: 71, usuarioId: 20, vendedorId: 46, sedeId: 65, aliadoId: 88,
    clienteDocumento: documentNumber, clientePrimerApellido: firstSurname,
    dataCreditoAssessmentId: assessmentId, ...options.draft,
  };
  const user = options.user === undefined ? baseUser : options.user;
  const modules = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/seller-auth": { getSellerSessionUser: async () => ({ id: 46, tipoPerfil: options.profile || "VENDEDOR" }) },
    "@/lib/solicitud-operation-access": {
      isDirectSalesProfile: profile => profile === "VENDEDOR",
      canActAsAllySalesAdmin: () => false,
      canOperateSolicitud: input => {
        calls.push("draft-permission");
        return options.canOperate !== false && Boolean(input.owner);
      },
    },
    "@/lib/solicitudes-storage": {
      getActiveSolicitudCreditContext: async (id, includeRejection) => {
        calls.push(["draft-context", id, includeRejection]);
        return options.missingDraft ? null : draft;
      },
    },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ environment: "production" }) },
    "@/lib/datacredito/policy": {
      normalizeDataCreditoPlatform: platform => ["IPHONE", "ANDROID"].includes(platform) ? platform : null,
    },
    "@/lib/datacredito/storage": {
      getDataCreditoAssessmentById: async () => options.missingAssessment ? null : row,
      buildDataCreditoIdentityHashes: hashes,
      dataCreditoAssessmentMatchesScope: (assessment, scope) => {
        calls.push("scope");
        return ["userId", "sellerId", "sedeId", "aliadoId"].every(key => assessment[key] === scope[key]);
      },
      getDataCreditoAssessmentResumeIdentity: async () => null,
      getDataCreditoAssessmentDocumentState: async () => ({ consumedElsewhere: false, inProgress: false, ...options.documentState }),
      normalizeDataCreditoDocument: value => String(value || ""),
      normalizeDataCreditoSurname: value => String(value || ""),
      serializeDataCreditoAssessment: assessment => ({ id: assessment.id, status: assessment.status, score: assessment.score }),
    },
    "@/lib/datacredito/admin-rejection-storage": {
      getDataCreditoAdministrativeRejection: async input => {
        calls.push(["administrative-decision", input]);
        if (options.decisionError) throw new Error("Unavailable");
        return options.decision === false ? null : {
          id: "audit-test", assessmentId, solicitudId: 71, source: "FINSER_ADMIN", status: "RECHAZADA",
          reason: "Private review reason", actorUserId: 1,
        };
      },
    },
    "@/lib/datacredito/risk-exception": {
      getCreditRiskAuthorizationForDraft: async () => { calls.push("risk-exception"); return null; },
    },
    "@/lib/datacredito/customer-identity": {
      getDataCreditoCustomerIdentityForDisplay: async () => null,
    },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async () => { calls.push("blacklist"); } },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
  };
  const loaded = { exports: {} };
  runInNewContext(compile(getSource), {
    module: loaded, exports: loaded.exports, Date, URL, Request, Response,
    console: { error() {} },
    require(name) { assert.ok(name in modules, `Unexpected module: ${name}`); return modules[name]; },
  });
  return {
    row, calls,
    async request(parameters = { documentNumber, firstSurname, platform: "IPHONE" }) {
      const query = new URLSearchParams(parameters);
      const response = await loaded.exports.GET(new Request(`https://finserpay.test/api/evaluaciones/${assessmentId}?${query}`), {
        params: Promise.resolve({ id: assessmentId }),
      });
      return { response, body: await response.json() };
    },
  };
}

const administrativeReads = fixture => fixture.calls.filter(call => Array.isArray(call) && call[0] === "administrative-decision");

test("GET muestra rechazo interno sólo después de validar alcance e identidad y mantiene NO_EVALUADO", async () => {
  const f = getFixture();
  const original = structuredClone(f.row);
  const { response, body } = await f.request();
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.deepEqual(body.administrativeDecision, { source: "FINSER_ADMIN", status: "RECHAZADA" });
  assert.equal(body.code, "ADMINISTRATIVE_REJECTION");
  assert.equal(body.status, "NO_EVALUADO");
  assert.equal(body.ok, false);
  assert.equal("offer" in body, false);
  assert.equal("creditAuthorization" in body, false);
  assert.doesNotMatch(JSON.stringify(body), /Private review reason|actorUserId/);
  assert.equal(administrativeReads(f).length, 1);
  assert.ok(f.calls.indexOf("scope") < f.calls.findIndex(call => Array.isArray(call) && call[0] === "administrative-decision"));
  assert.deepEqual(f.row, original);
});

test("GET no revela la decisión a otra sesión, sede, aliado, solicitud o identidad", async t => {
  const cases = [
    ["sin sesión", { user: null }, undefined, 401, undefined],
    ["perfil no comercial", { profile: "LECTOR" }, undefined, 403, undefined],
    ["otro usuario", { user: { ...baseUser, id: 21 } }, undefined, 404, undefined],
    ["otra sede", { user: { ...baseUser, sedeId: 66 } }, undefined, 404, undefined],
    ["otro aliado", { user: { ...baseUser, aliadoId: 99 } }, undefined, 404, undefined],
    ["solicitud no autorizada", { canOperate: false }, { draftId: "71" }, 404, undefined],
    ["solicitud con otra evaluación", { draft: { dataCreditoAssessmentId: otherAssessmentId } }, { draftId: "71" }, 404, undefined],
    ["cédula distinta", {}, { documentNumber: "1111111111", firstSurname }, 409, "ASSESSMENT_IDENTITY_MISMATCH"],
    ["apellido distinto", {}, { documentNumber, firstSurname: "OTRO" }, 409, "ASSESSMENT_IDENTITY_MISMATCH"],
    ["identidad ausente", {}, {}, 409, "ASSESSMENT_IDENTITY_REQUIRED"],
  ];
  for (const [name, options, query, status, code] of cases) await t.test(name, async () => {
    const f = getFixture(options);
    const { response, body } = await f.request(query);
    assert.equal(response.status, status);
    assert.equal(body.code, code);
    assert.equal(administrativeReads(f).length, 0);
    assert.equal("administrativeDecision" in body, false);
  });
});

test("GET conserva controles de vigencia, ambiente, consumo y plataforma antes del rechazo", async t => {
  const cases = [
    ["vencida", { row: { expiresAt: new Date("2000-01-01T00:00:00Z") } }, "ASSESSMENT_EXPIRED", 410],
    ["otro ambiente", { row: { providerEnvironment: "demo" } }, "ASSESSMENT_ENVIRONMENT_MISMATCH", 409],
    ["otra plataforma", { row: { platform: "ANDROID" } }, "ASSESSMENT_PLATFORM_MISMATCH", 409],
    ["consumida", { row: { consumedAt: new Date(), creditId: 50 } }, "ASSESSMENT_CONSUMED", 409],
    ["consumida en otro expediente", { documentState: { consumedElsewhere: true } }, "ASSESSMENT_CONSUMED_ELSEWHERE", 409],
    ["reserva activa", { documentState: { inProgress: true } }, "EVALUATION_IN_PROGRESS", 409],
    ["consulta pendiente", { row: { status: "PENDING" } }, "EVALUATION_IN_PROGRESS", 202],
  ];
  for (const [name, options, code, status] of cases) await t.test(name, async () => {
    const f = getFixture(options);
    const { response, body } = await f.request();
    assert.equal(response.status, status);
    assert.equal(body.code, code);
    assert.equal(administrativeReads(f).length, 0);
  });
});

test("GET de solicitud rechazada usa contexto autorizado y no concede excepción crediticia", async () => {
  const f = getFixture();
  const { response, body } = await f.request({ draftId: "71", platform: "IPHONE" });
  assert.equal(response.status, 409);
  assert.equal(body.code, "ADMINISTRATIVE_REJECTION");
  assert.deepEqual(f.calls.find(call => Array.isArray(call) && call[0] === "draft-context"), ["draft-context", 71, true]);
  assert.equal(f.calls.includes("risk-exception"), false);
});

test("sin decisión administrativa GET mantiene el error técnico original y nunca inventa un rechazo", async () => {
  for (const errorCode of ["NO_EVALUABLE_INFORMATION", "PROVIDER_OUTCOME_AMBIGUOUS", "AUTHENTICATION_FAILED"]) {
    const f = getFixture({ decision: false, row: { errorCode } });
    const { response, body } = await f.request();
    assert.equal(response.status, 422);
    assert.equal(body.code, errorCode);
    assert.equal(body.status, "NO_EVALUADO");
    assert.equal(body.ok, false);
    assert.equal("administrativeDecision" in body, false);
  }
});

test("una lectura de auditoría fallida no aprueba ni sustituye el resultado por rechazo", async () => {
  const f = getFixture({ decisionError: true });
  const { response, body } = await f.request();
  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.equal("administrativeDecision" in body, false);
  assert.equal("creditAuthorization" in body, false);
});

test("decisiones crediticias evaluadas no se convierten en rechazo administrativo", async () => {
  for (const status of ["APROBADO", "RECHAZADO"]) {
    const f = getFixture({ row: { status, errorCode: null, score: 500 } });
    const { response, body } = await f.request();
    assert.equal(response.status, 200);
    assert.equal(body.status, status);
    assert.equal(administrativeReads(f).length, 0);
    assert.equal("administrativeDecision" in body, false);
  }
});

test("el contexto cerrado sólo se lee con opt-in y resolución auditada para la misma solicitud", async t => {
  const source = read("lib/solicitudes-storage.ts");
  const ast = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getActiveSolicitudCreditContext");
  assert.ok(declaration);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE "Sede" ("id" int, "aliadoId" int);
      CREATE TABLE "CreditoBorrador" ("id" int, "currentStep" int, "usuarioId" int, "vendedorId" int,
        "sedeId" int, "clienteDocumento" text, "imei" text, "plataforma" text, "payload" jsonb,
        "dataCreditoAssessmentId" uuid, "creditRiskExceptionId" uuid, "estado" text, "closedReason" text,
        "expiresAt" timestamptz, "createdAt" timestamptz);
      CREATE TABLE "DataCreditoAdminAccessAudit" ("assessmentId" uuid, "action" text, "outcome" text, "metadata" jsonb);
      INSERT INTO "Sede" VALUES (65,88);
      INSERT INTO "CreditoBorrador" VALUES (71,1,20,46,65,'0001234567',NULL,'IPHONE',
        '{"clientePrimerApellido":"PRUEBA","dataCreditoErrorCode":"NO_EVALUABLE_INFORMATION"}',
        '${assessmentId}',NULL,'CERRADO','RECHAZADA',NOW()+INTERVAL '1 day',NOW());
      INSERT INTO "DataCreditoAdminAccessAudit" VALUES ('${assessmentId}','ADMIN_REJECT_NO_EVALUABLE',
        'REJECTED_BY_FINSER','{"solicitudId":71}');
    `);
    const loaded = { exports: {} };
    let dataCreditoSchemaChecks = 0;
    runInNewContext(compile(declaration.getText(ast)), {
      module: loaded, exports: loaded.exports,
      ensureSolicitudSchema: async () => {}, expireStaleSolicitudes: async () => {},
      ensureDataCreditoSchema: async () => { dataCreditoSchemaChecks += 1; },
      prisma: { $queryRawUnsafe: async (sql, ...parameters) => (await db.query(sql, parameters)).rows },
    });
    const context = loaded.exports.getActiveSolicitudCreditContext;
    assert.equal(await context(71), null);
    assert.equal(dataCreditoSchemaChecks, 0);
    const result = await context(71, true);
    assert.equal(dataCreditoSchemaChecks, 1);
    assert.equal(result.id, 71);
    assert.equal(result.clienteDocumento, documentNumber);
    assert.equal(result.dataCreditoErrorCode, "NO_EVALUABLE_INFORMATION");
    const cases = {
      "otro identificador de solicitud": `UPDATE "DataCreditoAdminAccessAudit" SET "metadata"='{"solicitudId":72}'`,
      "otra evaluación": `UPDATE "DataCreditoAdminAccessAudit" SET "assessmentId"='${otherAssessmentId}'`,
      "auditoría de sólo lectura": `UPDATE "DataCreditoAdminAccessAudit" SET "action"='VIEW_DOSSIER'`,
      "resultado sin rechazo": `UPDATE "DataCreditoAdminAccessAudit" SET "outcome"='GRANTED'`,
      "payload sin auditoría": `DELETE FROM "DataCreditoAdminAccessAudit"; UPDATE "CreditoBorrador" SET "payload"='{"administrativeRejectionSource":"FINSER_ADMIN"}'`,
      "desistimiento sin resolución": `UPDATE "CreditoBorrador" SET "closedReason"='DESISTIDA'`,
      "solicitud vencida": `UPDATE "CreditoBorrador" SET "expiresAt"=NOW()-INTERVAL '1 second'`,
    };
    for (const [name, mutation] of Object.entries(cases)) await t.test(name, async () => {
      await db.exec("BEGIN");
      try { await db.exec(mutation); assert.equal(await context(71, true), null); }
      finally { await db.exec("ROLLBACK"); }
    });
    await db.exec(`UPDATE "CreditoBorrador" SET "estado"='ABIERTO',"closedReason"=NULL`);
    assert.equal((await context(71)).id, 71);
    await t.test("contexto habitual no depende de tabla ni esquema DataCrédito", async () => {
      const beforeChecks = dataCreditoSchemaChecks;
      await db.exec('DROP TABLE "DataCreditoAdminAccessAudit"');
      assert.equal((await context(71)).id, 71);
      await db.exec(`UPDATE "CreditoBorrador" SET "estado"='CERRADO',"closedReason"='RECHAZADA'`);
      assert.equal(await context(71), null);
      assert.equal(dataCreditoSchemaChecks, beforeChecks);
    });
  } finally { await db.close(); }
});

test("migración de metadata es repetible y conserva auditorías y resultados anteriores", async () => {
  const setup = read("scripts/setup-datacredito.sql");
  const migration = setup.match(/ALTER TABLE "DataCreditoAdminAccessAudit"\s+ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '\{\}'::jsonb;/)?.[0];
  assert.ok(migration);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "DataCreditoAdminAccessAudit" ("id" int,"assessmentId" uuid,"action" text,"outcome" text);
      CREATE TABLE "DataCreditoAssessment" ("id" uuid,"status" text,"score" int,"errorCode" text);
      INSERT INTO "DataCreditoAdminAccessAudit" VALUES (1,'${assessmentId}','VIEW_DOSSIER','GRANTED');
      INSERT INTO "DataCreditoAssessment" VALUES ('${assessmentId}','NO_EVALUADO',NULL,'NO_EVALUABLE_INFORMATION');`);
    const original = (await db.query('SELECT * FROM "DataCreditoAssessment"')).rows;
    await db.exec(migration);
    await db.exec(migration);
    assert.deepEqual((await db.query('SELECT * FROM "DataCreditoAssessment"')).rows, original);
    assert.deepEqual((await db.query('SELECT * FROM "DataCreditoAdminAccessAudit"')).rows, [{
      id: 1, assessmentId, action: "VIEW_DOSSIER", outcome: "GRANTED", metadata: {},
    }]);
  } finally { await db.close(); }
});

test("historial administrativo conserva ausencia de puntaje y distingue cero real y sin información", () => {
  const source = read("lib/datacredito/admin-storage.ts");
  const ast = ts.createSourceFile("admin-storage.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["iso", "finiteInteger", "serializeAdminAssessment"];
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(declarations.length, names.length);
  const loaded = { exports: {} };
  runInNewContext(compile(`${declarations.map(node => node.getText(ast)).join("\n")}\nexport { serializeAdminAssessment };`), {
    module: loaded, exports: loaded.exports, Date,
    serializeOffer: value => value,
  });
  const row = {
    id: assessmentId, status: "NO_EVALUADO", documentLast4: "4567", platform: "IPHONE",
    providerEnvironment: "production", providerStatus: "ACCEPTED", transactionCode: "07",
    errorCode: "NO_EVALUABLE_INFORMATION", decision: null, offer: null,
  };
  for (const [input, expected] of [[null, null], [undefined, null], [0, 0], ["0", 0], [-1, -1], [500, 500], [950, 950], [951, null], [NaN, null]]) {
    const result = loaded.exports.serializeAdminAssessment({ ...row, score: input });
    assert.equal(result.score, expected, `score ${String(input)}`);
    assert.equal(result.status, "NO_EVALUADO");
    assert.equal(result.decision, null);
    assert.equal(result.offer, null);
  }
});
