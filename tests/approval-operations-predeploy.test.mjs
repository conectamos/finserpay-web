import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const readProjectFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function statementsInRuntime(path, functionName) {
  const source = ts.createSourceFile(path, readProjectFile(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functionNode = source.statements.find((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === functionName);
  assert.ok(functionNode, `${functionName} must exist`);
  const statements = [];
  function visit(node) {
    if (ts.isCallExpression(node) &&
        node.expression.getText(source) === "prisma.$executeRawUnsafe" &&
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) {
      statements.push(node.arguments[0].text.trim());
    }
    ts.forEachChild(node, visit);
  }
  visit(functionNode);
  return statements;
}

function statementsInInstaller(path) {
  const source = ts.createSourceFile(path, readProjectFile(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((entry) => entry.name.getText(source) === "statements");
  assert.ok(declaration && ts.isArrayLiteralExpression(declaration.initializer));
  return declaration.initializer.elements.map((element) => {
    assert.ok(ts.isNoSubstitutionTemplateLiteral(element), "Schema SQL must remain literal");
    return element.text.trim();
  });
}

const operational = statementsInInstaller("scripts/ensure-approval-operations-schema.mjs");
const draft = statementsInInstaller("scripts/ensure-firmaseguro-draft-dispatch-schema.mjs");

test("predeploy matches both runtime schemas and packages their installers", () => {
  assert.deepEqual(operational,
    statementsInRuntime("lib/approval-operations-schema.ts", "ensureApprovalOperationalSchema"));
  assert.deepEqual(draft,
    statementsInRuntime("lib/firmaseguro-draft-dispatch-ledger.ts", "ensureDraftDispatchSchema"));
  assert.equal(operational.length, 18);
  assert.equal(draft.length, 10);
  for (const statement of [...operational, ...draft]) {
    assert.doesNotMatch(statement, /\b(?:DROP TABLE|TRUNCATE)\b/i);
  }
  const predeploy = readProjectFile("scripts/railway-predeploy.mjs");
  const dockerfile = readProjectFile("Dockerfile");
  for (const name of ["ensure-approval-operations-schema.mjs", "ensure-firmaseguro-draft-dispatch-schema.mjs"]) {
    assert.ok(predeploy.includes(`await import("./${name}")`));
    assert.ok(dockerfile.includes(`/app/scripts/${name} ./scripts/${name}`));
    const installer = readProjectFile(`scripts/${name}`);
    assert.match(installer, /await client\.query\("BEGIN"\)/);
    assert.match(installer, /pg_advisory_xact_lock/);
    assert.match(installer, /await client\.query\("COMMIT"\)/);
    assert.match(installer, /await client\.query\("ROLLBACK"\)/);
  }
  assert.ok(predeploy.indexOf("ensure-solicitudes-schema.mjs") <
    predeploy.indexOf("ensure-firmaseguro-draft-dispatch-schema.mjs"));
  assert.ok(predeploy.indexOf("ensure-credit-device-replacement-schema.mjs") <
    predeploy.indexOf("ensure-approval-operations-schema.mjs"));
});

test("operational and draft schemas install twice and preserve immutable history", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "CreditoBorrador" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "FirmaSeguroProcess" (
        "processUuid" TEXT PRIMARY KEY, "creditoId" INTEGER,
        "signedDocumentBase64" TEXT, "signedDocumentFileName" TEXT,
        "draftPayload" JSONB, "completedAt" TIMESTAMP(3), "supersededAt" TIMESTAMP(3));
      INSERT INTO "Credito" VALUES (1);
      INSERT INTO "CreditoBorrador" VALUES (1);
      INSERT INTO "Usuario" VALUES (1);
      INSERT INTO "FirmaSeguroProcess" ("processUuid", "creditoId", "signedDocumentBase64")
        VALUES ('signed-original', 1, 'signed-pdf');
    `);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const statement of [...operational, ...draft]) await database.exec(statement);
    }
    await database.query(`INSERT INTO "ApprovalOperationalAction"
      ("id","targetKind","targetId","creditId","eventType","actorUserId","actorName","reason","status")
      VALUES ('00000000-0000-4000-8000-000000000001','CREDIT',1,1,'IMEI_REQUESTED',1,'Analista','Cambio por garantía','PENDING')`);
    await assert.rejects(database.query(`UPDATE "ApprovalOperationalAction" SET "status"='CHANGED'`),
      /OPERATIONAL_AUDIT_IMMUTABLE/);
    await database.query(`INSERT INTO "ApprovalOperationalContractVersion"
      ("id","creditoId","previousProcessUuid","previousImei","newImei","reason",
       "actorUserId","actorName","status","version","sourceTermsHash","originalDocumentHash","frozenCredit")
      VALUES ('00000000-0000-4000-8000-000000000002',1,'signed-original','123456789012345',
        '123456789012346','Cambio por garantía',1,'Analista','PREPARING',1,$1,$2,'{}'::jsonb)`,
      ["a".repeat(64), "b".repeat(64)]);
    const versionEvents = await database.query(`SELECT "status" FROM "ApprovalOperationalContractVersionEvent"`);
    assert.deepEqual(versionEvents.rows.map((row) => row.status), ["PREPARING"]);
    await assert.rejects(database.query(`UPDATE "ApprovalOperationalContractVersion"
      SET "newImei"='123456789012347'`), /OPERATIONAL_VERSION_IMMUTABLE/);
    await assert.rejects(database.query(`UPDATE "FirmaSeguroProcess"
      SET "signedDocumentBase64"='altered' WHERE "processUuid"='signed-original'`),
    /OPERATIONAL_SIGNATURE_IMMUTABLE/);
    await database.query(`INSERT INTO "FirmaSeguroDraftDispatch"
      ("id","draftId","actorUserId","actorName","reason","status","draftFolio",
       "sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash")
      VALUES ('00000000-0000-4000-8000-000000000003',1,1,'Analista','Corrección de contacto',
        'PREPARING','FC-1','{}','{}','{}','{}','pdf',$1)`, ["c".repeat(64)]);
    const draftEvents = await database.query(`SELECT "status" FROM "FirmaSeguroDraftDispatchEvent"`);
    assert.deepEqual(draftEvents.rows.map((row) => row.status), ["PREPARING"]);
    await assert.rejects(database.query(`UPDATE "FirmaSeguroDraftDispatch"
      SET "documentBase64"='altered'`), /DRAFT_DISPATCH_IMMUTABLE/);
    await assert.rejects(database.query(`DELETE FROM "FirmaSeguroDraftDispatchEvent"`),
      /DRAFT_DISPATCH_AUDIT_IMMUTABLE/);
  } finally {
    await database.close();
  }
});
