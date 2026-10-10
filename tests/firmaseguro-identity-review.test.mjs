import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { runInNewContext } from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
const jiti = createJiti(import.meta.url);
const pure = await jiti.import("../lib/datacredito/firmaseguro-identity.ts");
const { extractVeriffIdentityDataEvidence, extractVeriffIdentityDocumentEvidence } = await jiti.import("../lib/veriff.ts");
const { isFirmaSeguroVerifiedCompletedStatus } = await jiti.import("../lib/firmaseguro-status.ts");
const { compareStrictIdentityDocuments, compareDataCreditoVeriffIdentityEvidence } = await jiti.import("../lib/veriff-identity.ts");
const db = new PGlite();after(() => db.close());
const canonical = "María del Mar  De la Peña Muñoz";
const assessmentId = "12345678-1234-4234-8234-123456789012";
const actor = { id: 91, nombre: "Administradora autorizada", admin: true, central: false, aliadoId: 7 };
const original = { nameMode: "FULL_NAME_ONLY", fullName: canonical, names: "", firstSurname: "", secondSurname: "", documentNumber: "", documentType: "", missing: ["Número de documento", "Tipo de documento"] };
let effective = { ...original }, approved = true, trusted = true, documentStatus = "match", unresolved = false, locks = 0;
const client = driver => ({ $queryRawUnsafe: async (sql, ...args) => (await driver.query(sql, args)).rows,
  $executeRawUnsafe: async (sql, ...args) => (await driver.query(sql, args)).affectedRows });
const prisma = { ...client(db), $transaction: callback => db.transaction(transaction => callback(client(transaction))) };
const compile = source => ts.transpileModule(source.replace(/^import\b[^;]*;\r?\n/gm, ""), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
runInNewContext(compile(readFileSync(new URL("../lib/datacredito/firmaseguro-identity-review.ts", import.meta.url), "utf8")), {
  module: loaded, exports: loaded.exports, Error, Date, createHash, prisma, ...pure,
  ensureSolicitudSchema: async () => {}, ensureVeriffSchema: async () => {}, ensureFirmaSeguroSchema: async () => {},
  lockSolicitudOperationMutation: async () => { locks++; },
  getUnresolvedDraftDispatch: async () => unresolved ? { status: "UNCERTAIN" } : null,
  extractVeriffIdentityDataEvidence, compareStrictIdentityDocuments, isFirmaSeguroVerifiedCompletedStatus,
  isVeriffApproved: row => row.status === "APPROVED" && trusted,
  serializeVeriffValidation: row => {
    const compared = compareDataCreditoVeriffIdentityEvidence([extractVeriffIdentityDocumentEvidence(row.decisionPayload), extractVeriffIdentityDocumentEvidence(row.webhookPayload)], row.clienteDocumento);
    return { identityDocumentStatus: documentStatus === "match" ? compared.status : documentStatus, identityDocumentNumber: compared.ok ? compared.documentNumber : null };
  },
  getDataCreditoPublicConfig: () => ({ enabled: true, environment: "production" }),
  getApprovedDataCreditoAssessmentForCredit: async input => { assert.equal(input.firstSurname, "DIGITADO");assert.equal(input.sedeId, 3);return approved ? { id: assessmentId } : null; },
  enforceDataCreditoCustomerIdentity: async (payload, scope, save) => {
    assert.equal(scope.userId, 4);assert.equal(scope.sellerId, 8);assert.equal(scope.aliadoId, 7);assert.equal(save, false);
    if (payload.clienteDocumento !== "123456789" || payload.clienteNombre !== canonical) throw new Error("DATACREDITO_IDENTITY_LOCKED_FIELDS");
    return { original, effective, querySurname: "DIGITADO" };
  },
});
const lib = loaded.exports;
await db.exec(`CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER);INSERT INTO "Sede" VALUES (3,7);
 CREATE TABLE "CreditoBorrador" ("id" INTEGER PRIMARY KEY,"estado" TEXT,"creditoId" INTEGER,"usuarioId" INTEGER,"vendedorId" INTEGER,"sedeId" INTEGER,
 "clienteDocumento" TEXT,"plataforma" TEXT,"dataCreditoAssessmentId" UUID,"payload" JSONB,"currentStep" INTEGER,"createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"expiresAt" TIMESTAMPTZ);
 CREATE TABLE "VeriffIdentityValidation" ("id" INTEGER PRIMARY KEY,"draftId" INTEGER,"creditoId" INTEGER,"status" TEXT,"clienteDocumento" TEXT,"decisionPayload" JSONB,"webhookPayload" JSONB);
 CREATE TABLE "FirmaSeguroProcess" ("id" INTEGER PRIMARY KEY,"draftId" INTEGER,"completedAt" TIMESTAMPTZ,"supersededAt" TIMESTAMPTZ,"signedDocumentBase64" TEXT,"status" TEXT);`);
await lib.ensureFirmaSeguroIdentityReviewSchema();
async function reset() {
  await db.exec('TRUNCATE "FirmaSeguroIdentityReview","FirmaSeguroProcess","CreditoBorrador","VeriffIdentityValidation"');
  effective = { ...original };approved = true;trusted = true;documentStatus = "match";unresolved = false;locks = 0;
  await db.query(`INSERT INTO "CreditoBorrador" ("id","estado","usuarioId","vendedorId","sedeId","clienteDocumento","plataforma","dataCreditoAssessmentId","payload","currentStep","expiresAt")
    VALUES (530,'ABIERTO',4,8,3,'123456789','IPHONE',$1,$2::jsonb,4,CURRENT_TIMESTAMP + INTERVAL '1 day')`, [assessmentId, JSON.stringify({ clienteDocumento: "123456789", clienteNombre: canonical, dataCreditoAssessmentId: assessmentId, veriffValidationId: 42,
      firmaSeguroIdentity: { source: "AUTHORIZED_REVIEW", reviewId: randomUUID(), firstName: "FORJADO" } })]);
  await db.query(`INSERT INTO "VeriffIdentityValidation" VALUES (42,530,NULL,'APPROVED','123456789',$1::jsonb,NULL)`, [JSON.stringify({ verification: { person: { idNumber: "123456789" }, document: { number: "123456789", type: "ID_CARD", country: "CO" } } })]);
}
const input = (changes = {}) => ({ firstNames: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz",
  reason: "Componentes cotejados con la cédula presentada", attestation: true, expectedValidationId: 42,
  expectedCanonicalFullName: canonical, idempotencyKey: randomUUID(), ...changes });
const binding = { draftId: 530, validationId: 42, documentNumber: "123456789", fullName: canonical };

test("revisión ADMIN persiste actor/fecha/original, recarga y metadata sin simular fuente del proveedor", async () => {
  await reset();const values = input();
  const before = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);assert.equal(before.canSave, true);
  assert.equal(before.signingReady, false);assert.equal(before.signingSource, null);
  assert.equal(await lib.getStoredFirmaSeguroIdentityReview(binding), null, "autosave forged metadata has no authority");
  const saved = await lib.saveFirmaSeguroIdentityReview(530, values, actor);
  assert.equal(saved.canSave, false);assert.equal(saved.review.source, "AUTHORIZED_REVIEW");assert.equal(saved.review.actorName, actor.nombre);assert.ok(saved.review.createdAt);
  assert.equal(saved.signingReady, true);assert.equal(saved.signingSource, "AUTHORIZED_REVIEW");
  assert.equal(saved.canonicalFullName, canonical);assert.equal(saved.documentNumber, "123456789");
  assert.equal(saved.validationId, 42);assert.equal(saved.assessmentId, assessmentId);
  const metadata = await lib.getStoredFirmaSeguroIdentityReview(binding);
  assert.equal(metadata.source, "AUTHORIZED_REVIEW");assert.equal(metadata.reviewId, values.idempotencyKey);
  assert.equal(metadata.firstName, "María del Mar");assert.equal(metadata.firstLastName, "De la Peña");assert.equal(metadata.secondLastName, "Muñoz");assert.equal(metadata.canonicalFullName, canonical);
  assert.deepEqual(pure.readFirmaSeguroFullNameIdentity(metadata, { fullName: canonical, documentNumber: "123456789" }), metadata);
  await lib.saveFirmaSeguroIdentityReview(530, values, actor);
  const audit = (await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows;assert.equal(audit.length, 1);assert.equal(audit[0].actorUserId, actor.id);
  assert.equal(audit[0].original.original.documentNumber, "");assert.equal(audit[0].original.original.firstSurname, "");
  assert.deepEqual(audit[0].original.original.missing, original.missing);assert.ok(locks >= 2);
  await assert.rejects(db.query('UPDATE "FirmaSeguroIdentityReview" SET "firstSurname"=$1', ["Otro"]), /immutable/);
  await assert.rejects(db.query('DELETE FROM "FirmaSeguroIdentityReview"'), /immutable/);
});

test("GET exposes authoritative readiness from complete Veriff evidence without allowing manual replacement", async () => {
  await reset();
  await db.query('UPDATE "VeriffIdentityValidation" SET "webhookPayload"=$1::jsonb', [JSON.stringify({ verification: { person: {
    firstName: "María del Mar", lastName: "De la Peña Muñoz", idNumber: "123456789",
  } } })]);
  for (const reader of [actor, { ...actor, admin: false }]) {
    const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, reader);
    assert.equal(detail.signingReady, true);assert.equal(detail.signingSource, "VERIFF");
    assert.equal(detail.eligible, false);assert.equal(detail.canSave, false);assert.equal(detail.canReview, reader.admin);
    assert.equal(detail.canonicalFullName, canonical);assert.equal(detail.documentNumber, "123456789");
    assert.equal(detail.validationId, 42);assert.equal(detail.assessmentId, assessmentId);assert.equal(detail.review, null);
  }
  assert.equal((await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows.length, 0);
  assert.equal(locks, 0, "reading readiness does not reserve a mutation or send a contract");
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /ya entregó componentes/);
});

test("GET uses a complete Veriff pair without name-content vetoes and rejects separate incomplete names", async () => {
  const payload = person => JSON.stringify({ verification: { person: { idNumber: "123456789", ...person }, document: { number: "123456789", type: "ID_CARD", country: "CO" } } });
  const complete = { firstName: "María del Mar", lastName: "De la Peña Muñoz" };
  const cases = [
    [{ firstName: "María del Mar" }, complete, true],
    [{ lastName: "De la Peña Muñoz" }, complete, true],
    [{ fullName: canonical }, complete, true],
    [complete, { firstName: "María del Mar" }, true],
    [{ firstName: "María del Mar", fullName: "Otro Nombre" }, complete, true],
    [complete, { firstName: "Otro Nombre" }, true],
    [{ firstName: "LUISA MARIA", lastName: "ROJAS PEREZ" }, complete, true],
    [{ firstName: "María del Mar" }, { lastName: "De la Peña Muñoz" }, false],
  ];
  for (const [decision, webhook, ready] of cases) {
    await reset();await db.query('UPDATE "VeriffIdentityValidation" SET "decisionPayload"=$1::jsonb,"webhookPayload"=$2::jsonb', [payload(decision), payload(webhook)]);
    const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
    assert.equal(detail.signingReady, ready);assert.equal(detail.signingSource, ready ? "VERIFF" : null);
    assert.equal(detail.eligible, false);assert.equal(detail.canSave, false);
  }
});

test("GET accepts real Veriff names independently of DataCrédito while preserving strict CC and the canonical binding", async () => {
  const decisionPayload = { verification: { person: { idNumber: "123456789" }, document: { number: "123456789", type: "ID_CARD", country: "CO" } } };
  for (const [person, ready] of [
    [{ firstName: "Maria del Mar", lastName: "De la Peña Muñoz", idNumber: "123456789" }, true],
    [{ firstName: "María del Mar", lastName: "De la Pen\u0303a Mun\u0303oz", idNumber: "123456789" }, true],
    [{ firstName: "María del Mar", lastName: "De la Pena Munoz", idNumber: "123456789" }, true],
    [{ firstName: "Otro", lastName: "Nombre", idNumber: "123456789" }, true],
    [{ firstName: "María del Mar", lastName: "De la Peña Muñoz", idNumber: "987654321" }, false],
    [{ firstName: "Maria del Mar", lastName: "De la Pena Munoz", idNumber: "987654321" }, false],
  ]) {
    await reset();await db.query('UPDATE "VeriffIdentityValidation" SET "decisionPayload"=$1::jsonb', [JSON.stringify({ decisionPayload, personPayload: { person } })]);
    const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
    assert.equal(detail.signingReady, ready);assert.equal(detail.signingSource, ready ? "VERIFF" : null);assert.equal(detail.canSave, false);
    if (ready) { assert.equal(detail.canonicalFullName, canonical);assert.equal(detail.documentNumber, "123456789");assert.equal(detail.validationId, 42); }
  }
});

test("a different CC in a flat person wrapper blocks both readiness and authorized-review fallback", async () => {
  const decisionPayload = { verification: { person: { idNumber: "123456789" }, document: { number: "PHYSICAL-SERIAL", type: "ID_CARD", country: "CO" } } };
  for (const person of [
    { firstName: "María del Mar", lastName: "De la Peña Muñoz", idNumber: "987654321" },
    { fullName: canonical, idNumber: "987654321" },
    { idNumber: "987654321" },
  ]) {
    for (const personPayload of [person, { data: person }, { verification: person }]) {
      await reset();await db.query('UPDATE "VeriffIdentityValidation" SET "decisionPayload"=$1::jsonb', [JSON.stringify({ decisionPayload, personPayload })]);
      const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
      assert.equal(detail.signingReady, false);assert.equal(detail.signingSource, null);assert.equal(detail.eligible, false);assert.equal(detail.canSave, false);
      await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /última aprobación|cédula devuelta/);
      assert.equal((await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows.length, 0);
    }
  }
});

test("GET distinguishes incomplete components from complete Veriff names without changing manual review rules", async () => {
  await reset();
  await db.query('UPDATE "VeriffIdentityValidation" SET "decisionPayload"=jsonb_set("decisionPayload",\'{verification,person}\',$1::jsonb)', [JSON.stringify({ firstName: "María del Mar", idNumber: "123456789" })]);
  const partial = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
  assert.equal(partial.signingReady, false);assert.equal(partial.eligible, false);assert.match(partial.reason, /componentes parciales/);assert.doesNotMatch(partial.reason, /contradictori/);
  await reset();
  await db.query('UPDATE "VeriffIdentityValidation" SET "webhookPayload"=$1::jsonb', [JSON.stringify({ person: { firstName: "Otro", lastName: "Nombre", idNumber: "123456789" } })]);
  const ready = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
  assert.equal(ready.signingReady, true);assert.equal(ready.signingSource, "VERIFF");assert.equal(ready.eligible, false);assert.equal(ready.canonicalFullName, canonical);
  await reset();
  await db.query('UPDATE "VeriffIdentityValidation" SET "webhookPayload"=$1::jsonb', [JSON.stringify({ person: { fullName: "Maria del Mar De la Peña Muñoz", idNumber: "123456789" } })]);
  const fullOnly = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
  assert.equal(fullOnly.signingReady, false);assert.equal(fullOnly.eligible, true);assert.equal(fullOnly.canSave, true);
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input({ firstNames: "Maria del Mar" }), actor), /FirmaSeguro requiere/);
});

test("GET reports Veriff readiness for structured DataCrédito names without broadening manual completion", async () => {
  await reset();effective = { ...original, nameMode: undefined, names: "María del Mar", firstSurname: "De la Peña", secondSurname: "Muñoz" };
  await db.query('UPDATE "VeriffIdentityValidation" SET "webhookPayload"=$1::jsonb', [JSON.stringify({ verification: { person: {
    firstName: "LUISA MARIA", lastName: "ROJAS PEREZ", idNumber: "123456789",
  } } })]);
  const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
  assert.equal(detail.signingReady, true);assert.equal(detail.signingSource, "VERIFF");assert.equal(detail.canonicalFullName, canonical);
  assert.equal(detail.eligible, false);assert.equal(detail.canSave, false);
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /sólo completa/);
  assert.equal((await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows.length, 0);
});

test("GET fails closed for stale or untrusted approval, changed CC and expired DataCrédito assessment", async () => {
  for (const scenario of ["untrusted", "documentConflict", "changedCC", "oldValidation", "assessmentExpired", "notApproved"]) {
    await reset();
    if (scenario === "untrusted") trusted = false;
    if (scenario === "documentConflict") documentStatus = "conflict";
    if (scenario === "changedCC") await db.exec('UPDATE "VeriffIdentityValidation" SET "clienteDocumento"=\'987654321\'');
    if (scenario === "oldValidation") await db.exec('UPDATE "VeriffIdentityValidation" SET "id"=43');
    if (scenario === "assessmentExpired") approved = false;
    if (scenario === "notApproved") await db.exec('UPDATE "VeriffIdentityValidation" SET "status"=\'DECLINED\'');
    const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
    assert.equal(detail.signingReady, false, scenario);assert.equal(detail.signingSource, null, scenario);
    assert.equal(detail.eligible, false);assert.equal(detail.canSave, false);assert.ok(detail.reason);
    assert.equal((await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows.length, 0);
  }
});

test("segundo apellido vacío es válido sin dividir nombre completo ni eliminar tildes", async () => {
  await reset();const values = input({ firstSurname: "De la Peña Muñoz", secondSurname: "" });
  await lib.saveFirmaSeguroIdentityReview(530, values, actor);const metadata = await lib.getStoredFirmaSeguroIdentityReview(binding);
  assert.equal(metadata.firstLastName, "De la Peña Muñoz");assert.equal(metadata.secondLastName, null);
  await reset();await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input({ firstNames: "Maria del Mar" }), actor));
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input({ firstSurname: "De la Pena", secondSurname: "Munoz" }), actor));
  assert.equal((await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows.length, 0);
});

test("asesor, administrador de otro aliado, stale y primer apellido ya completado no pueden reemplazar la revisión", async () => {
  await reset();await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), { ...actor, admin: false }), error => error.status === 403);
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), { ...actor, aliadoId: 99 }), error => error.status === 403);
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input({ expectedValidationId: 43 }), actor), /identidad cambió/);
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input({ expectedCanonicalFullName: "Otro Nombre" }), actor), /identidad cambió/);
  const values = input();await lib.saveFirmaSeguroIdentityReview(530, values, actor);
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, { ...values, firstSurname: "De la Peña Muñoz", secondSurname: "" }, actor), /otros datos/);
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input({ firstSurname: "De la Peña Muñoz", secondSurname: "" }), actor), /primer apellido ya fue completado/);
});

test("dos completados concurrentes no pueden reclasificar el primer apellido", async () => {
  await reset();const outcomes = await Promise.allSettled([
    lib.saveFirmaSeguroIdentityReview(530, input(), actor),
    lib.saveFirmaSeguroIdentityReview(530, input({ firstNames: "María del Mar De", firstSurname: "la Peña" }), actor),
  ]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(value => value.status === "rejected").length, 1);
  assert.equal((await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows.length, 1);assert.equal(locks, 2);
});

test("firma activa, firmada o despacho incierto impiden completar componentes", async () => {
  for (const state of ["active", "signed", "legacyPDF", "legacyStatus", "uncertain"]) {
    await reset();
    if (state === "active") await db.exec(`INSERT INTO "FirmaSeguroProcess" VALUES (1,530,NULL,NULL,NULL,'CREATED')`);
    if (state === "signed") await db.exec(`INSERT INTO "FirmaSeguroProcess" VALUES (1,530,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,'COMPLETED')`);
    if (state === "legacyPDF") await db.exec(`INSERT INTO "FirmaSeguroProcess" VALUES (1,530,NULL,CURRENT_TIMESTAMP,'signed-pdf','CREATED')`);
    if (state === "legacyStatus") await db.exec(`INSERT INTO "FirmaSeguroProcess" VALUES (1,530,NULL,CURRENT_TIMESTAMP,NULL,'SIGNED')`);
    if (state === "uncertain") unresolved = true;
    const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);assert.equal(detail.canSave, false);
    await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /Ya existe una firma/);
    assert.equal((await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows.length, 0);
  }
});

test("Veriff parcial/conflictivo, no confiable, CC distinta, consulta vencida y campos provider presentes permanecen protegidos", async () => {
  await reset();trusted = false;await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /última aprobación/);
  await reset();documentStatus = "conflict";await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /última aprobación/);
  await reset();approved = false;await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /no está vigente/);
  await reset();await db.exec('UPDATE "VeriffIdentityValidation" SET "clienteDocumento"=\'987654321\'');await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /última aprobación/);
  for (const person of [{ firstName: "María del Mar", idNumber: "123456789" }, { fullName: "Otro Nombre", idNumber: "123456789" }]) {
    await reset();await db.query('UPDATE "VeriffIdentityValidation" SET "decisionPayload"=jsonb_set("decisionPayload",\'{verification,person}\',$1::jsonb)', [JSON.stringify(person)]);
    await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input(), actor), /componentes parciales|no coincide/);
  }
  await reset();effective = { ...original, names: "María del Mar" };
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input({ firstNames: "María del Mar De", firstSurname: "la Peña" }), actor), /permanecen bloqueados/);
  await reset();effective = { ...original, secondSurname: "Muñoz" };
  await assert.rejects(lib.saveFirmaSeguroIdentityReview(530, input({ firstSurname: "De la Peña Muñoz", secondSurname: "" }), actor), /permanecen bloqueados/);
});

test("cambiar validación, canónico, documento o vigencia invalida el metadata guardado", async () => {
  await reset();await lib.saveFirmaSeguroIdentityReview(530, input(), actor);
  for (const changes of [{ fullName: "Otro" }, { documentNumber: "987654321" }, { validationId: 43 }]) assert.equal(await lib.getStoredFirmaSeguroIdentityReview({ ...binding, ...changes }), null);
  await db.exec('UPDATE "VeriffIdentityValidation" SET "id"=43');
  await db.exec('UPDATE "CreditoBorrador" SET "payload"=jsonb_set("payload",\'{veriffValidationId}\',\'43\')');
  assert.equal(await lib.getStoredFirmaSeguroIdentityReview({ ...binding, validationId: 43 }), null);
  const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);
  assert.equal(detail.signingReady, false);assert.equal(detail.signingSource, null);
  approved = false;await assert.rejects(lib.getStoredFirmaSeguroIdentityReview({ ...binding, validationId: 43 }), /no está vigente/);
});

test("procesos archivados UNSIGNED/NOT_SIGNED sin PDF no simulan una firma completa", async () => {
  for (const status of ["UNSIGNED", "NOT_SIGNED", "NOT_COMPLETED", "FAILED_SIGNED"]) {
    await reset();await db.query(`INSERT INTO "FirmaSeguroProcess" VALUES (1,530,NULL,CURRENT_TIMESTAMP,NULL,$1)`, [status]);
    const detail = await lib.getFirmaSeguroIdentityReviewDetail(530, actor);assert.equal(detail.canSave, true);
    await lib.saveFirmaSeguroIdentityReview(530, input(), actor);assert.equal((await db.query('SELECT * FROM "FirmaSeguroIdentityReview"')).rows.length, 1);
  }
});


test("setup SQL instala auditoría inmutable e idempotente compatible con el esquema runtime", async () => {
  const installDb = new PGlite();
  try {
    const setup = readFileSync(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
    const block = setup.slice(setup.indexOf('-- Componentes de firma revisados por ADMIN;')).replace(/COMMIT;\s*$/, "");
    assert.match(block, /CREATE TABLE IF NOT EXISTS "FirmaSeguroIdentityReview"/);
    await installDb.exec(block);await installDb.exec(block);
    const values = [randomUUID(), assessmentId, canonical, "María del Mar", "De la Peña", "Muñoz"];
    await installDb.query(`INSERT INTO "FirmaSeguroIdentityReview" ("id","draftId","assessmentId","validationId","documentHash","canonicalFullName","firstNames","firstSurname","secondSurname","actorUserId","actorName","reason","attestation","inputHash","original")
      VALUES ($1,530,$2,42,'hash',$3,$4,$5,$6,91,'Admin','Cotejado cédula',TRUE,'input','{}')`, values);
    await assert.rejects(installDb.exec(`UPDATE "FirmaSeguroIdentityReview" SET "firstSurname"='Otro'`), /immutable/);
    await assert.rejects(installDb.exec(`DELETE FROM "FirmaSeguroIdentityReview"`), /immutable/);
    await assert.rejects(installDb.query(`INSERT INTO "FirmaSeguroIdentityReview" ("id","draftId","assessmentId","validationId","documentHash","canonicalFullName","firstNames","firstSurname","secondSurname","actorUserId","actorName","reason","attestation","inputHash","original")
      VALUES ($1,530,$2,42,'hash',$3,$4,$5,$6,91,'Admin','Cotejado cédula',TRUE,'input2','{}')`, [randomUUID(), ...values.slice(1)]), /unique/);
  } finally { await installDb.close(); }
});
