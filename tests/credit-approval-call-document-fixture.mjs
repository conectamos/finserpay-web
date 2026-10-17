import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { creditApprovalSchemaStatements } from "../scripts/credit-approval-schema.mjs";
import { creditApprovalReissueSchemaStatements } from "../scripts/credit-approval-reissue-schema.mjs";
import { creditApprovalActorSchemaStatements } from "../scripts/credit-approval-actor-schema.mjs";
import { creditApprovalNoveltiesSchemaStatements } from "../scripts/credit-approval-novelties-schema.mjs";
import { approvalSharedSchemaStatements } from "../scripts/approval-shared-schema.mjs";
import { approvalEvidenceSchemaStatements } from "../scripts/approval-evidence-schema.mjs";
import { creditApprovalDocumentRefreshSchemaStatements } from "../scripts/credit-approval-document-refresh-schema.mjs";
import { creditApprovalCallSchemaStatements } from "../scripts/credit-approval-call-schema.mjs";

const requireFromFixture = createRequire(import.meta.url);
const modules = new Map();
export function loadDocumentContinuityModule(path, overrides = {}) {
  if (Object.keys(overrides).length === 0 && modules.has(path)) return modules.get(path);
  const loaded = { exports: {} };
  if (Object.keys(overrides).length === 0) modules.set(path, loaded.exports);
  const compiled = ts.transpileModule(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Buffer, Uint8Array, Date, Intl, URL, URLSearchParams,
    Request, Response, TextDecoder, structuredClone, console,
    require(name) {
      if (name in overrides) return overrides[name];
      if (name === "server-only") return {};
      // The integration only persists already retrieved provider data. Never load
      // a production database or an outbound API client in this in-memory test.
      assert.notEqual(name, "@/lib/prisma", "The local fixture must never load production Prisma");
      if (name === "@/lib/firmaseguro") return { isFirmaSeguroCompletedStatus: status => ["COMPLETED", "EXITOSO", "SIGNED"].includes(status) };
      if (name.startsWith("@/lib/")) return loadDocumentContinuityModule(name.slice(2) + ".ts");
      if (name.startsWith("./")) return loadDocumentContinuityModule(path.slice(0, path.lastIndexOf("/") + 1) + name.slice(2) + ".ts");
      return requireFromFixture(name);
    },
  }, { filename: path });
  return loaded.exports;
}

export const service = loadDocumentContinuityModule("lib/credit-approval.ts");
export const callStore = loadDocumentContinuityModule("lib/credit-approval-call-store.ts");
export const evidenceService = loadDocumentContinuityModule("lib/credit-approval-evidence.ts");
export const noveltyService = loadDocumentContinuityModule("lib/credit-approval-novelties.ts");
export const actor = { id: 7, nombre: "Analista de prueba local" };
export const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yFusAAAAASUVORK5CYII=";
export const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF").toString("base64");
const wav = readFileSync(new URL("fixtures/approval-call/tone.wav", import.meta.url));

const fixtureSql = `
  CREATE TABLE "CreditSadminRegistration" ("creditoId" INTEGER PRIMARY KEY,"numeroCredito" TEXT,"numeroCreditoConfirmado" BOOLEAN DEFAULT false);
  CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY,"nombre" TEXT);
  INSERT INTO "Rol" VALUES (1,'ADMIN'),(2,'ANALISTA_APROBACION');
  CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"codigo" TEXT,"nombre" TEXT,"activo" BOOLEAN DEFAULT true);
  INSERT INTO "Aliado" VALUES (10,'ALLY','Aliado sintético',true),(20,'FINSERPAY','Central',true);
  CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER,"nombre" TEXT DEFAULT 'Sede sintética',"activa" BOOLEAN DEFAULT true);
  INSERT INTO "Sede" ("id","aliadoId") VALUES (10,10),(20,20);
  CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY,"sedeId" INTEGER,"rolId" INTEGER,"activo" BOOLEAN DEFAULT true);
  INSERT INTO "Usuario" VALUES (7,20,2),(8,10,1);
  CREATE TABLE "Credito" (
    "id" SERIAL PRIMARY KEY,"folio" TEXT DEFAULT 'TEST',"clienteNombre" TEXT DEFAULT 'Cliente sintético',
    "clienteDocumento" TEXT DEFAULT '100000001',"clienteCorreo" TEXT DEFAULT 'cliente@example.test',"clienteTelefono" TEXT DEFAULT '3001234567',
    "clienteDepartamento" TEXT DEFAULT 'TOLIMA',"clienteCiudad" TEXT DEFAULT 'Ibagué',"clienteDireccion" TEXT DEFAULT 'Calle sintética 1',
    "plazoMeses" INTEGER DEFAULT 12,"frecuenciaPago" TEXT DEFAULT 'QUINCENAL',"valorCuota" FLOAT DEFAULT 98765,
    "fechaPrimerPago" TIMESTAMP(3) DEFAULT '2099-02-02T00:00:00',"fechaCredito" TIMESTAMP DEFAULT '2099-01-01T12:00:00',
    "createdAt" TIMESTAMP(3) DEFAULT '2099-01-01T00:00:00',"updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "estado" TEXT DEFAULT 'ACTIVO',"sedeId" INTEGER DEFAULT 10,"imei" TEXT DEFAULT '000000000000001',
    "referenciaEquipo" TEXT DEFAULT 'iPhone Sintético',"equipoMarca" TEXT DEFAULT 'Apple',"equipoModelo" TEXT DEFAULT 'Sintético',
    "valorEquipoTotal" FLOAT DEFAULT 1000000,"cuotaInicial" FLOAT DEFAULT 200000,
    "saldoBaseFinanciado" FLOAT DEFAULT 800000,"montoCredito" FLOAT DEFAULT 800000,"equalityService" TEXT,
    "contratoSnapshot" JSONB DEFAULT '{"equipo":{"plataforma":"IPHONE","imei":"000000000000001"},"financiero":{"condicion":"original"},"firma":{"valor":"original"}}',
    "contratoCedulaFrenteDataUrl" TEXT,"contratoCedulaRespaldoDataUrl" TEXT,"iphoneSelfieCedulaDataUrl" TEXT,
    "fotoEntregaDataUrl" TEXT,"fotoRemisionDataUrl" TEXT);
  CREATE TABLE "CreditoAmortizacion" ("creditoId" INTEGER PRIMARY KEY REFERENCES "Credito"("id"),"cuotaComercial" NUMERIC(20,2));
  CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER UNIQUE REFERENCES "Credito"("id"));
  CREATE TABLE "DataCreditoAssessment" ("id" TEXT PRIMARY KEY,"creditId" INTEGER,"score" INTEGER,"offer" JSONB,
    "status" TEXT,"consumedAt" TIMESTAMP,"retainedUntil" TIMESTAMP,"updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE "FirmaSeguroProcess" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER,"processUuid" TEXT UNIQUE,
    "status" TEXT,"signedDocumentBase64" TEXT,"signedDocumentFileName" TEXT,"draftPayload" JSONB,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"completedAt" TIMESTAMP,"supersededAt" TIMESTAMP);
  CREATE TABLE "CreditDeviceReplacement" ("id" TEXT PRIMARY KEY,"creditId" INTEGER,"source" TEXT,"status" TEXT,"previousImei" TEXT,"newImei" TEXT);
  CREATE TABLE "CreditDeviceReplacementReview" ("replacementId" TEXT,"decision" TEXT);
  CREATE TABLE "ApprovalOperationalContractVersion" ("creditoId" INTEGER,"version" INTEGER,"status" TEXT);
`;

export async function createDocumentContinuityFixture(t) {
  const database = new PGlite({ parsers: { 1114: value => new Date(value.replace(" ", "T") + "Z") } });
  t.after(() => database.close());
  await database.exec(fixtureSql);
  for (const statements of [creditApprovalSchemaStatements, creditApprovalReissueSchemaStatements,
    creditApprovalActorSchemaStatements, creditApprovalNoveltiesSchemaStatements, approvalSharedSchemaStatements,
    approvalEvidenceSchemaStatements, creditApprovalDocumentRefreshSchemaStatements(), creditApprovalCallSchemaStatements])
    for (const statement of statements) await database.exec(statement);
  const queries = [];
  const adapt = client => ({
    $queryRawUnsafe: async (sql, ...values) => { queries.push({ sql, values }); return (await client.query(sql, values)).rows; },
    $executeRawUnsafe: async (sql, ...values) => { queries.push({ sql, values }); return (await client.query(sql, values)).affectedRows || 0; },
  });
  const db = adapt(database);
  const transaction = work => database.transaction(tx => work(adapt(tx)));
  const read = id => service.getCreditApprovalDetail(db, id, actor);
  async function createCredit() {
    const fields = service.APPROVAL_EVIDENCE.map(({ field }) => field);
    const id = (await database.query(`INSERT INTO "Credito" (${fields.map(field => `"${field}"`).join(",")})
      VALUES (${fields.map((_, index) => `$${index + 1}`).join(",")}) RETURNING "id"`, fields.map(() => png))).rows[0].id;
    await database.query(`INSERT INTO "DataCreditoAssessment"
      ("id","creditId","score","offer","status","consumedAt","retainedUntil")
      VALUES ($1,$2,750,'{"initialPaymentPercentage":20}','APROBADO',CURRENT_TIMESTAMP,'2199-01-01')`, ["assessment-" + id, id]);
    const processUuid = randomUUID();
    await database.query(`INSERT INTO "FirmaSeguroProcess" ("creditoId","processUuid","status","completedAt")
      VALUES ($1,$2,'COMPLETED',CURRENT_TIMESTAMP)`, [id, processUuid]);
    return { id, processUuid };
  }
  async function upload(id, label = "original") {
    const detail = await read(id);
    return transaction(tx => callStore.saveCreditApprovalCall(tx, id, {
      revision: detail.review.revision, reviewHash: detail.review.reviewHash, idempotencyKey: randomUUID(),
      fileName: "llamada-" + label + ".wav", mimeType: "audio/wav", bytes: wav,
      sizeBytes: wav.length, sha256: createHash("sha256").update(wav).digest("hex"),
    }, actor));
  }
  async function audit(id, processUuid, status) {
    await database.query(`INSERT INTO "CreditApprovalDocumentRefreshEvent"
      ("id","creditoId","processUuid","actorKind","actorUserId","actorName","status")
      VALUES ($1::uuid,$2,$3,'USER',7,$4,$5)`, [randomUUID(), id, processUuid, actor.nombre, status]);
  }
  async function recoverPdf(id, processUuid, options = {}) {
    if (options.audit !== false) await audit(id, processUuid, "REQUESTED");
    await database.query(`UPDATE "FirmaSeguroProcess" SET "signedDocumentBase64"=$2,"signedDocumentFileName"='firmado.pdf'
      WHERE "creditoId"=$1 AND "processUuid"=$3`, [id, options.pdf || pdf, processUuid]);
    if (options.audit !== false) await audit(id, processUuid, "RECOVERED");
    return options.read === false ? null : read(id);
  }
  const physical = async recordingId => (await database.query('SELECT * FROM "CreditApprovalCallRecording" WHERE "id"=$1::uuid', [recordingId])).rows[0];
  const bytes = (id, recordingId) => callStore.readCreditApprovalCallBytes(db, id, recordingId);
  async function replacePhoto(id, suffix = "replacement") {
    const detail = await read(id);
    const correctedPhoto = "data:image/png;base64," + Buffer.concat([Buffer.from(png.split(",")[1], "base64"), Buffer.from(suffix)]).toString("base64");
    // Image decoding is independently tested. This regression executes the
    // authenticated replacement service, SQL guards and continuity seals.
    return transaction(tx => evidenceService.replaceApprovalEvidence(tx, id, {
      key: "foto-remision", dataUrl: correctedPhoto, revision: detail.review.revision, reviewHash: detail.review.reviewHash,
    }, actor));
  }
  async function reportNovelty(id) {
    const detail = await read(id);
    const input = noveltyService.parseCreateNovelty({ keys: [], reason: "Observación sintética de seguimiento",
      revision: detail.review.revision, reviewHash: detail.review.reviewHash, idempotencyKey: randomUUID() });
    return transaction(tx => noveltyService.createCreditApprovalNovelty(tx, id, input, actor));
  }
  return { database, db, queries, transaction, read, createCredit, upload, audit, recoverPdf, physical, bytes, replacePhoto, reportNovelty };
}
