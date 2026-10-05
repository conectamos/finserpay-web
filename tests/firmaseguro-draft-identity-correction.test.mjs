import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const [service, route, signatureRoute, autosave] = await Promise.all([
  read("lib/firmaseguro-draft-identity-correction.ts"),
  read("app/api/creditos/borradores/[id]/corregir-identidad/route.ts"),
  read("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
  read("lib/solicitudes-storage.ts"),
]);

test("la corrección requiere versión observada, evidencia, motivo y atestación", () => {
  const start = service.indexOf("export function parseSignedDraftIdentityCorrection(");
  const end = service.indexOf("export async function correctSignedDraftIdentity(", start);
  assert.ok(start >= 0 && end > start);
  const fn = stripTypeScriptTypes(service.slice(start, end).replace(/^export /, ""));
  const parse = new Function("record", "name", "UUID", "correctionError", `${fn}\nreturn parseSignedDraftIdentityCorrection;`)(
    (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
    (value, min = 2, max = 120) => typeof value === "string" && value.trim().length >= min &&
      value.trim().length <= max ? value.trim().toUpperCase() : "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    (code, message) => Object.assign(new Error(message), { code }),
  );
  const valid = { attestation: true, evidenceType: "CEDULA", expectedCurrentName: "NOMBRE ANTERIOR",
    expectedProcessUuid: "proceso-1", firstNames: "NOMBRE CORRECTO", secondSurname: "SEGUNDO",
    idempotencyKey: "4f664369-bcbb-4906-a99e-32f35082cd56",
    reason: "Cédula oficial cotejada con el expediente" };
  assert.equal(parse(valid).firstNames, "NOMBRE CORRECTO");
  for (const changes of [
    { attestation: false }, { evidenceType: "NINGUNA" }, { expectedProcessUuid: "" },
    { idempotencyKey: "repetir" }, { reason: "ok" }, { extra: true },
  ]) assert.throws(() => parse({ ...valid, ...changes }), { code: "DATOS_INVALIDOS" });
});

test("la auditoría del nombre es inmutable y solo admite un evento de cada tipo", async () => {
  const statements = [...service.matchAll(/await prisma\.\$executeRawUnsafe\(`([\s\S]*?)`\);/g)]
    .map((match) => match[1]);
  assert.ok(statements.length >= 5);
  const db = new PGlite();
  try {
    for (const statement of statements) await db.exec(statement);
    const id = "4f664369-bcbb-4906-a99e-32f35082cd56";
    const insert = (eventId) => `INSERT INTO "SolicitudNombreCorrectionAudit"
      ("id","correlationId","draftId","eventType","previousName","newName","firstNames",
       "firstSurname","secondSurname","documentSha256","evidenceType","evidenceSha256",
       "sourceSealChecksum","reason","actorUserId","actorName","previousProcessUuid") VALUES
      ('${eventId}','${id}',42,'CORRECTED','NOMBRE ANTERIOR','NOMBRE CORRECTO',
       'NOMBRE','CORRECTO','','${"a".repeat(64)}','CEDULA','${"b".repeat(64)}',
       '${"c".repeat(64)}','Cédula cotejada',3,'Analista','proceso-1')`;
    await db.exec(insert("63f9d76d-6424-48e5-b7ca-98a06bf79fe0"));
    await assert.rejects(db.exec(insert("63f9d76d-6424-48e5-b7ca-98a06bf79fe1")));
    await assert.rejects(db.exec(`UPDATE "SolicitudNombreCorrectionAudit" SET "newName"='OTRO' WHERE "draftId"=42`),
      /immutable/);
    await assert.rejects(db.exec(`DELETE FROM "SolicitudNombreCorrectionAudit" WHERE "draftId"=42`),
      /immutable/);
  } finally { await db.close(); }
});

test("el envío aceptado no cierra la corrección antes del PDF firmado", async () => {
  const start = service.indexOf("export async function recordSignedDraftIdentityCorrectionReissue(");
  assert.ok(start >= 0);
  const fn = stripTypeScriptTypes(service.slice(start).replace(/^export /, ""));
  let databaseTouched = false;
  const recordReissue = new Function(
    "record", "UUID", "Buffer", "readFinancingTermsSeal", "ensureSignedDraftIdentityCorrectionSchema",
    "prisma", "lockSolicitudOperationMutation", "draft", "compare", "correctionError", "randomUUID",
    `${fn}\nreturn recordSignedDraftIdentityCorrectionReissue;`,
  )(
    (value) => value && typeof value === "object" ? value : {},
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    Buffer, () => null, async () => { databaseTouched = true; },
    { $transaction: async () => { databaseTouched = true; } },
    () => {}, () => null, () => "", () => new Error(), () => "unused",
  );
  const unsigned = { draftId: 42, supersededAt: null, processUuid: "firma-2",
    draftPayload: { firmaSeguroIdentityCorrectionId: "4f664369-bcbb-4906-a99e-32f35082cd56" },
    completedAt: null, signedDocumentBase64: null };
  assert.equal(await recordReissue(42, unsigned), true);
  assert.equal(databaseTouched, false);
  assert.equal(await recordReissue(42, { ...unsigned, completedAt: new Date(),
    signedDocumentBase64: Buffer.from("<html>").toString("base64") }), true);
  assert.equal(databaseTouched, false);
});

test("la nueva firma conserva el origen firmado y el autosave no puede restaurar identidad ni fotos viejas", () => {
  assert.match(route, /readApprovalRequest\(request, \{ maxBytes: 16_384 \}\)/);
  assert.match(route, /isAdminRole\(user\.rolNombre\).*isFinserPayCentralAlly\(user\.aliadoAccesoCodigo\)/);
  assert.match(service, /markFirmaSeguroDraftProcessesSuperseded\(db/);
  assert.match(service, /getUnresolvedDraftDispatch\(input\.draftId, db\)/);
  assert.match(service, /signedBytes\.subarray\(0, 5\)\.toString\(\) !== "%PDF-"/);
  assert.match(service, /"archivedEvidence" JSONB/);
  assert.match(service, /delete next\.firmaSeguroDraftFolio/);
  assert.match(signatureRoute, /getPendingSignedDraftIdentityCorrection/);
  assert.match(signatureRoute, /recordSignedDraftIdentityCorrectionReissue\(draftId, process\)/);
  assert.match(autosave, /SOLICITUD_CORRECCION_IDENTIDAD_PENDIENTE/);
  assert.match(autosave, /firmaSeguroIdentityReissueProcessUuid/);
});
