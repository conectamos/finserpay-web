import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const source = read("scripts/ensure-credit-device-replacement-remission-schema.mjs");
const file = ts.createSourceFile("installer.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = file.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations)
  .find(node => node.name.getText(file) === "statements");
assert.ok(declaration && ts.isArrayLiteralExpression(declaration.initializer));
const statements = declaration.initializer.elements.map(node => {
  assert.ok(ts.isNoSubstitutionTemplateLiteral(node));
  return node.text;
});

test("predeploy instala remisión en orden y conserva la foto histórica del crédito", () => {
  const predeploy = read("scripts/railway-predeploy.mjs");
  const dockerfile = read("Dockerfile");
  const index = predeploy.indexOf('await import("./ensure-credit-device-replacement-remission-schema.mjs")');
  assert.ok(index > predeploy.indexOf('await import("./ensure-credit-device-replacement-schema.mjs")'));
  assert.ok(dockerfile.includes("ensure-credit-device-replacement-remission-schema.mjs"));
  assert.doesNotMatch(read("lib/credit-device-replacement-remission.ts"), /UPDATE "Credito" SET "fotoRemisionDataUrl"/);
  assert.match(read("lib/credit-device-replacement-storage.ts"), /requestReplacementRemission\(transaction, replacementId/);
  assert.match(read("lib/credit-device-replacement-storage.ts"), /isReplacementRemissionVerified\(transaction, row.id\)/);
});

test("la remisión nueva no bloquea reemplazos del portal central sin un aliado cargador", () => {
  const storage = read("lib/credit-device-replacement-storage.ts");
  assert.match(storage, /if \(input\.source === "APPROVAL_OPERATIONS"\) \{\s*await requestReplacementRemission/);
  assert.match(storage, /if \(row\.source === "APPROVAL_OPERATIONS" && !await isReplacementRemissionVerified/);
  assert.doesNotMatch(storage, /if \(!await isReplacementRemissionVerified\(transaction, row\.id\)\)/);
});

test("evidencia subida queda inmutable y el rechazo permite una nueva versión sin borrar la anterior", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "CreditDeviceReplacement" ("id" UUID PRIMARY KEY);
      INSERT INTO "Usuario" VALUES (1),(2);
      INSERT INTO "CreditDeviceReplacement" VALUES ('00000000-0000-4000-8000-000000000001');`);
    for (let attempt = 0; attempt < 2; attempt++) for (const statement of statements) await db.exec(statement);
    const a = "00000000-0000-4000-8000-000000000002";
    const b = "00000000-0000-4000-8000-000000000003";
    await db.query(`INSERT INTO "CreditDeviceReplacementRemission"
      ("id","replacementId","version","status","requestedByUserId","requestedByName")
      VALUES ($1,'00000000-0000-4000-8000-000000000001',1,'PENDING_UPLOAD',1,'Analista')`, [a]);
    await db.query(`UPDATE "CreditDeviceReplacementRemission" SET
      "status"='PENDING_REVIEW',"photoMime"='image/png',"photoData"=$2,
      "photoSha256"=$3,"uploadedByUserId"=2,"uploadedByName"='Aliado',"uploadedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1`, [a, Buffer.from("foto firmada"), "a".repeat(64)]);
    await assert.rejects(db.query(`UPDATE "CreditDeviceReplacementRemission"
      SET "photoData"='otra foto' WHERE "id"=$1`, [a]), /REMISSION_EVIDENCE_IMMUTABLE/);
    await db.query(`UPDATE "CreditDeviceReplacementRemission" SET
      "status"='REJECTED',"reviewedByUserId"=1,"reviewedByName"='Analista',
      "reviewedAt"=CURRENT_TIMESTAMP,"reviewNote"='Firma ilegible' WHERE "id"=$1`, [a]);
    await db.query(`INSERT INTO "CreditDeviceReplacementRemission"
      ("id","replacementId","version","status","requestedByUserId","requestedByName")
      VALUES ($1,'00000000-0000-4000-8000-000000000001',2,'PENDING_UPLOAD',1,'Analista')`, [b]);
    const rows = await db.query(`SELECT "version","status","photoData" FROM "CreditDeviceReplacementRemission"
      ORDER BY "version"`);
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0].status, "REJECTED");
    assert.ok(rows.rows[0].photoData);
    assert.equal(rows.rows[1].status, "PENDING_UPLOAD");
    await assert.rejects(db.query(`UPDATE "CreditDeviceReplacementRemission"
      SET "status"='VERIFIED' WHERE "id"=$1`, [b]), /REMISSION_STATE_INVALID/);
    await db.query(`INSERT INTO "CreditDeviceReplacementRemissionEvent"
      ("id","remissionId","eventType","actorUserId","actorName")
      VALUES ('00000000-0000-4000-8000-000000000004',$1,'REQUESTED',1,'Analista')`, [b]);
    await assert.rejects(db.query(`DELETE FROM "CreditDeviceReplacementRemissionEvent"`),
      /REMISSION_EVIDENCE_IMMUTABLE/);
  } finally { await db.close(); }
});
