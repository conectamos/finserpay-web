import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import * as identity from "../lib/datacredito/identity.ts";
import * as canonical from "../lib/solicitudes.ts";
import * as clientName from "../lib/credit-client-name.ts";
import * as phones from "../lib/credit-contact-phones.ts";
import * as deliveryEvidence from "../lib/delivery-evidence-draft.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const storage = read("lib/solicitudes-storage.ts");
function section(start, end) {
  const from = storage.indexOf(start);
  const to = storage.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return storage.slice(from, to);
}
function load(source, dependencies = {}, globals = {}) {
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module: loaded, exports: loaded.exports,
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; },
    ...globals,
  });
  return loaded.exports;
}
const dataCorrections = load(read("lib/approval-request-correction-core.ts"), {
  "./credit-client-name": clientName,
  "./credit-contact-phones": phones,
});
const blacklist = load(read("lib/document-blacklist-core.ts"));
const blacklistLocks = load(read("lib/solicitud-blacklist-locks.ts"), {
  "@/lib/document-blacklist-core": blacklist,
});
const document = "123456789";
const assessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fullName = "María del Mar  De la Peña Muñoz";
const scope = { userId: 4, sellerId: 8, sedeId: 3, aliadoId: 7 };

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE "DataCreditoAssessment" ("id" UUID PRIMARY KEY, "status" TEXT);
    INSERT INTO "DataCreditoAssessment" VALUES ('${assessmentId}', 'APROBADO');
    CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY, "usuarioId" INTEGER, "vendedorId" INTEGER,
      "sedeId" INTEGER, "currentStep" INTEGER DEFAULT 3, "clienteNombre" TEXT,
      "clienteDocumento" TEXT, "clienteTelefono" TEXT, "imei" TEXT,
      "plataforma" TEXT DEFAULT 'IPHONE', "dataCreditoAssessmentId" UUID,
      "payload" JSONB, "estado" TEXT DEFAULT 'ABIERTO',
      "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP + INTERVAL '15 days'
    );
    CREATE TABLE "FirmaSeguroProcess" (
      "id" SERIAL PRIMARY KEY, "draftId" INTEGER, "processUuid" TEXT,
      "status" TEXT, "completedAt" TIMESTAMPTZ, "signedDocumentBase64" TEXT,
      "lastError" TEXT, "draftPayload" JSONB, "supersededAt" TIMESTAMPTZ
    );
    CREATE TABLE "VeriffIdentityValidation" ("id" INTEGER, "draftId" INTEGER);
  `);
  const storedPayload = {
    solicitudOrigen: "DATACREDITO", dataCreditoAssessmentId: assessmentId,
    clienteDocumento: document, clienteTipoDocumento: "CEDULA_DE_CIUDADANIA",
    clienteNombre: "PATINO", clientePrimerNombre: "", clientePrimerApellido: "PATINO",
    clienteSegundoApellido: "", clienteTelefono: "3001234567",
    referenciaFamiliar1Nombre: "Ana", referenciaFamiliar1Telefono: "3011234567",
  };
  await db.query(`INSERT INTO "CreditoBorrador" (
    "id", "usuarioId", "vendedorId", "sedeId", "clienteDocumento",
    "dataCreditoAssessmentId", "clienteNombre", "payload"
  ) VALUES (11,4,8,3,$1,$2,'PATINO',$3::jsonb)`, [document, assessmentId, JSON.stringify(storedPayload)]);
  const sqlAdapter = (connection) => ({
    $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).affectedRows,
  });
  const prisma = {
    ...sqlAdapter(db),
    $transaction: (callback) => db.transaction((connection) => callback(sqlAdapter(connection))),
  };
  const providerPayload = { content: { respuesta: { validacion: { datosBasicos: {
    conInformacion: true, nombreCompleto: fullName, tipoDocumento: "CC",
    numeroDocumento: document,
  } } } } };
  const customer = load(read("lib/datacredito/customer-identity.ts"), {
    "server-only": {}, "@/lib/prisma": { default: prisma }, "./identity": identity,
    "./storage": {
      getDataCreditoAssessmentById: async (id) => id === assessmentId ? { id, status: "APROBADO" } : null,
      dataCreditoAssessmentMatchesScope: (_row, candidate) => candidate.userId === scope.userId && candidate.sedeId === scope.sedeId,
      readDataCreditoIdentitySource: async () => ({ documentNumber: document, firstSurname: "PATINO", providerPayload }),
    },
  });
  const productionSave = section("function sameOwner(", "async function lockIdentity(") + "\n" +
    section("const FIRMASEGURO_SIGNED_DRAFT_FIELDS =", "function imeiReissueSignedAt(") + "\n" +
    section("function firmaSeguroTermsAreLocked(", "type BlockingSolicitudIdentityRow") + "\n" +
    section("export async function saveSolicitudDraft(", "export class SolicitudDataCreditoLinkError");
  const { saveSolicitudDraft: save } = load(productionSave, {}, {
    prisma, ...canonical, ...blacklistLocks, ...dataCorrections, ...deliveryEvidence,
    normalizeDigits: (value) => String(value || "").replace(/\D/g, ""),
    normalizePlatform: (value) => value || null,
    normalizeDraftStep: (value, fallback = 1) => value == null ? fallback : Math.max(1, Math.min(5, Number(value))),
    isUuid: (value) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value),
    isCompleteImei: (value) => /^\d{15}$/.test(String(value || "")),
    ensureSolicitudSchema: async () => {}, ensureFirmaSeguroSchema: async () => {},
    expireStaleWith: async () => {}, assertDocumentNotBlacklisted: async () => {},
    lockSolicitudOperationMutation: async () => {}, lockIdentity: async () => {},
    getUnresolvedDraftDispatch: async () => null,
    supersedeLowerPrioritySameOwnerDrafts: async () => 0,
    findActiveByIdentity: async () => null,
    // These unrelated correction paths are absent from this unsigned fixture.
    preserveAnalystFinancialCorrectionAutosave: (_stored, payload) => payload,
    preserveAnalystEvidenceCorrectionAutosave: (_stored, payload) => payload,
    imeiReissueSignedAt: () => null,
    isFirmaSeguroSuccessfulStatus: (status) => status === "COMPLETED",
    isFirmaSeguroFailedStatus: (status) => status === "ERROR",
  });
  const row = async () => (await db.query('SELECT * FROM "CreditoBorrador" WHERE "id"=11')).rows[0];
  const input = (payload, verifiedDataCreditoFirstSurname) => ({
    id: 11, usuarioId: 4, vendedorId: 8, sedeId: 3, currentStep: 4,
    clienteNombre: payload.clienteNombre, clienteDocumento: payload.clienteDocumento,
    clienteTelefono: payload.clienteTelefono, imei: null, plataforma: "IPHONE",
    dataCreditoAssessmentId: assessmentId, payload, verifiedDataCreditoFirstSurname,
  });
  return { db, customer, save, row, input, storedPayload };
}

test("full-name-only autosave removes the query surname and remains valid after reload and before Veriff", async (t) => {
  const f = await fixture(t);
  const payload = { ...f.storedPayload, clienteNombre: fullName };
  const recovered = await f.customer.enforceDataCreditoCustomerIdentity(payload, scope);
  assert.equal(recovered.original.nameMode, "FULL_NAME_ONLY");
  assert.equal(recovered.querySurname, "PATINO");
  assert.equal(recovered.effective.firstSurname, "");
  await f.save(f.input(payload, recovered.effective.firstSurname));

  for (let round = 0; round < 2; round++) {
    const saved = await f.row();
    assert.equal(saved.clienteNombre, fullName);
    assert.equal(saved.payload.clienteNombre, fullName);
    assert.equal(saved.payload.clientePrimerNombre, "");
    assert.equal(saved.payload.clientePrimerApellido ?? "", "");
    assert.equal(saved.payload.clienteSegundoApellido, "");
    assert.equal(saved.payload.clienteDocumento, document);
    assert.equal(saved.payload.clienteTipoDocumento, "CEDULA_DE_CIUDADANIA");
    assert.equal(saved.payload.clienteTelefono, f.storedPayload.clienteTelefono);
    assert.equal(saved.payload.referenciaFamiliar1Nombre, "Ana");
    const reloadedPayload = { ...saved.payload };
    const verified = await f.customer.enforceDataCreditoCustomerIdentity(reloadedPayload, scope, false);
    assert.equal(verified.effective.fullName, fullName);
    await f.save(f.input(reloadedPayload, verified.effective.firstSurname));
  }
  const audits = await f.db.query('SELECT COUNT(*)::integer AS count FROM "DataCreditoIdentityCorrection"');
  assert.equal(audits.rows[0].count, 0, "No surname or name correction is invented");
});

test("legacy, partial and arbitrary autosave names become the trusted whole name; strict operations reject changes", async (t) => {
  const f = await fixture(t);
  for (const submittedName of ["PATINO", "", "María", "Otra Persona"]) {
    const payload = { ...f.storedPayload, clienteNombre: submittedName };
    const recovered = await f.customer.enforceDataCreditoCustomerIdentity(payload, scope);
    assert.equal(payload.clienteNombre, fullName);
    assert.equal(payload.clientePrimerApellido, "");
    await f.save(f.input(payload, recovered.effective.firstSurname));
    const reloaded = await f.row();
    assert.equal(reloaded.clienteNombre, fullName);
    assert.equal(reloaded.payload.clienteNombre, fullName);
    await f.customer.enforceDataCreditoCustomerIdentity({ ...reloaded.payload }, scope, false);
  }
  await assert.rejects(f.customer.enforceDataCreditoCustomerIdentity({ ...f.storedPayload, clienteNombre: "Otra Persona" }, scope, false), /LOCKED_FIELDS/);
  for (const saveCorrection of [true, false]) {
    await assert.rejects(f.customer.enforceDataCreditoCustomerIdentity({ ...f.storedPayload, clienteNombre: fullName, clienteDocumento: "987654321" }, scope, saveCorrection), /DOCUMENT_MISMATCH/);
    await assert.rejects(f.customer.enforceDataCreditoCustomerIdentity({ ...f.storedPayload, clienteNombre: fullName, clienteTipoDocumento: "PASAPORTE" }, scope, saveCorrection), /LOCKED_FIELDS/);
  }
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS count FROM "DataCreditoIdentityCorrection"')).rows[0].count, 0);
});

test("an omitted trusted surname preserves legacy locking; browser fields cannot clear it", async (t) => {
  const f = await fixture(t);
  const payload = { ...f.storedPayload, clientePrimerApellido: "", verifiedDataCreditoFirstSurname: "" };
  await f.save(f.input(payload, undefined));
  assert.equal((await f.row()).payload.clientePrimerApellido, "PATINO");
  for (const [patch, code] of [
    [{ clientePrimerApellido: "Otro" }, "SOLICITUD_APELLIDO_INMUTABLE"],
    [{ clienteDocumento: "987654321" }, "SOLICITUD_DOCUMENTO_INMUTABLE"],
    [{ dataCreditoAssessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, "SOLICITUD_DATACREDITO_INMUTABLE"],
  ]) {
    const changed = f.input({ ...payload, ...patch }, undefined);
    if (patch.dataCreditoAssessmentId) changed.dataCreditoAssessmentId = patch.dataCreditoAssessmentId;
    await assert.rejects(f.save(changed), (error) => error.code === code);
  }
  await assert.rejects(f.customer.enforceDataCreditoCustomerIdentity({ ...payload, clienteNombre: fullName }, { ...scope, userId: 99 }), /UNAUTHORIZED/);
});

test("explicit empty component cannot change the identity already retained by a signed process", async (t) => {
  const f = await fixture(t);
  await f.db.query(`INSERT INTO "FirmaSeguroProcess" (
    "draftId", "processUuid", "status", "completedAt", "draftPayload"
  ) VALUES (11,'signed-process','COMPLETED',CURRENT_TIMESTAMP,$1::jsonb)`, [JSON.stringify(f.storedPayload)]);
  await f.save(f.input({ ...f.storedPayload, clientePrimerApellido: "" }, ""));
  assert.equal((await f.row()).payload.clientePrimerApellido, "PATINO");
  assert.equal((await f.row()).payload.clienteNombre, "PATINO");
});
