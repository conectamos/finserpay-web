import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { clientCorrectionCase, clone, core, load, seals, statuses } from "./firmaseguro-client-correction-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const solicitudes = await jiti.import("../lib/solicitudes.ts");
const blacklistLocks = await jiti.import("../lib/solicitud-blacklist-locks.ts");
const delivery = await jiti.import("../lib/delivery-evidence-draft.ts");
const financial = await jiti.import("../lib/approval-request-financial-correction-core.ts");
const evidence = await jiti.import("../lib/approval-request-evidence-correction-core.ts");

async function fixture(t) {
  const database = new PGlite(); t.after(() => database.close());
  await database.exec(`CREATE TABLE "CreditoBorrador" (
    "id" INTEGER PRIMARY KEY,"estado" TEXT DEFAULT 'ABIERTO',"usuarioId" INTEGER,"vendedorId" INTEGER,"sedeId" INTEGER,
    "currentStep" INTEGER DEFAULT 4,"clienteNombre" TEXT,"clienteDocumento" TEXT,"clienteTelefono" TEXT,"imei" TEXT,
    "plataforma" TEXT,"dataCreditoAssessmentId" UUID,"dataCreditoStatus" TEXT,"dataCreditoErrorCode" TEXT,"creditoId" INTEGER,
    "closedReason" TEXT,"payload" JSONB NOT NULL,"createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"closedAt" TIMESTAMPTZ,
    "expiresAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP + INTERVAL '15 days',"desistedByUserId" INTEGER,"desistedBySellerId" INTEGER);
    CREATE TABLE "FirmaSeguroProcess"("id" INTEGER,"processUuid" TEXT PRIMARY KEY,"draftId" INTEGER,"status" TEXT,
      "supersededAt" TIMESTAMPTZ,"completedAt" TIMESTAMPTZ,"signedDocumentBase64" TEXT,"lastError" TEXT,"draftPayload" JSONB);
    CREATE TABLE "VeriffIdentityValidation"("id" INTEGER,"draftId" INTEGER,"creditoId" INTEGER,"status" TEXT,
      "veriffSessionId" TEXT,"attemptId" TEXT,"createPayload" JSONB,"mediaPayload" JSONB,"submitPayload" JSONB,
      "decisionPayload" JSONB,"webhookPayload" JSONB,"submittedAt" TIMESTAMPTZ,"decidedAt" TIMESTAMPTZ,
      "decision" TEXT,"code" TEXT,"reason" TEXT,"reasonCode" TEXT);
    CREATE TABLE "Sede"("id" INTEGER,"aliadoId" INTEGER);
    CREATE TABLE "CreditDeviceReplacement"("id" TEXT,"newImei" TEXT,"status" TEXT);`);
  const state = clientCorrectionCase({ signed: true });
  const assessment = randomUUID();
  for (const payload of [state.original, state.updatedPayload, state.process.draftPayload]) {
    payload.dataCreditoAssessmentId = assessment;
    payload.firmaSeguroDraftFolio = state.seal.snapshot.folio;
  }
  const calls = { operationLocks: 0, mutations: 0, unresolved: null };
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => {
      // PGlite has no advisory locks. Fresh fixture rows never need expiration;
      // all canonical reads, signature checks and save UPDATE run as real SQL.
      if (sql.includes("WITH stale AS MATERIALIZED")) return [];
      if (/^\s*UPDATE "CreditoBorrador"/.test(sql)) calls.mutations++;
      return (await connection.query(sql, values)).rows;
    },
    $executeRawUnsafe: async (sql, ...values) => {
      if (sql.includes("pg_advisory_xact_lock")) return 0;
      return (await connection.query(sql, values)).affectedRows;
    },
  });
  const prisma = { ...adapter(database), $transaction: work => database.transaction(db => work(adapter(db))) };
  const firmaStorage = { ensureFirmaSeguroSchema: async () => {},
    lockSolicitudOperationMutation: async () => { calls.operationLocks++; }, SOLICITUD_OPERATION_LOCK_NAMESPACE: 9001 };
  const storage = load("lib/solicitudes-storage.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async () => {} },
    "@/lib/solicitud-blacklist-locks": blacklistLocks,
    "@/lib/datacredito/storage": { ensureDataCreditoSchema: async () => {} },
    "@/lib/firmaseguro-status": statuses, "@/lib/firmaseguro-storage": firmaStorage,
    "@/lib/delivery-evidence-draft": delivery,
    "@/lib/veriff-storage": { ensureVeriffSchema: async () => {} },
    "@/lib/firmaseguro-draft-dispatch-ledger": { getUnresolvedDraftDispatch: async () => calls.unresolved },
    "@/lib/approval-request-correction-core": core,
    "@/lib/approval-request-financial-correction-core": financial,
    "@/lib/approval-request-evidence-correction-core": evidence,
    "@/lib/solicitudes": solicitudes,
  }, { process: { env: { NODE_ENV: "production" } } });
  const completion = load("lib/firmaseguro-client-correction-complete.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/firmaseguro-storage": firmaStorage,
    "@/lib/approval-request-correction-core": core, "@/lib/credit-amortization-contract": seals,
    "@/lib/firmaseguro-status": statuses,
  });
  async function reset({ payload = state.updatedPayload, signed = false } = {}) {
    await database.exec('TRUNCATE TABLE "CreditoBorrador", "FirmaSeguroProcess"');
    await database.query(`INSERT INTO "CreditoBorrador"("id","usuarioId","sedeId","clienteNombre","clienteDocumento",
      "clienteTelefono","imei","plataforma","dataCreditoAssessmentId","payload") VALUES($1,11,1,$2,$3,$4,$5,'IPHONE',$6,$7::jsonb)`,
      [state.draft.id, payload.clienteNombre, payload.clienteDocumento, payload.clienteTelefono, payload.imei, assessment, JSON.stringify(payload)]);
    await database.query(`INSERT INTO "FirmaSeguroProcess" VALUES($1,$2,$3,$4,NULL,$5,$6,NULL,$7::jsonb)`,
      [state.process.id, state.process.processUuid, state.draft.id, signed ? "COMPLETED" : "CREATED",
        signed ? state.process.completedAt : null, signed ? state.process.signedDocumentBase64 : null,
        JSON.stringify(state.process.draftPayload)]);
    calls.operationLocks = 0; calls.mutations = 0; calls.unresolved = null;
  }
  async function read() { return (await database.query('SELECT * FROM "CreditoBorrador"')).rows[0]; }
  function incoming(payload = state.original) {
    const factory = clone(payload); delete factory.financialTermsSeal; delete factory.firmaSeguroDraftFolio;
    for (const field of core.CLIENT_CORRECTION_MARKER_FIELDS) delete factory[field];
    return { id: state.draft.id, usuarioId: 11, vendedorId: null, sedeId: 1,
      clienteNombre: factory.clienteNombre, clienteDocumento: factory.clienteDocumento, clienteTelefono: factory.clienteTelefono,
      imei: factory.imei, plataforma: "IPHONE", dataCreditoAssessmentId: assessment, currentStep: 5, payload: factory };
  }
  await reset();
  return { ...state, calls, reset, read, incoming, storage, complete: completion.completeDraftClientCorrection };
}

test("autosave real anterior conserva sello y folio corregidos, fuerza paso 4 y luego permite completar la nueva firma", async t => {
  const f = await fixture(t);
  const request = f.incoming();
  for (const field of ["fotoEntregaDataUrl", "fotoRemisionDataUrl", "contratoCedulaFrenteDataUrl"])
    delete request.payload[field];
  Object.assign(request.payload, { cuotaInicial: 100000, fechaPrimerPago: "2026-11-17", plazoMeses: 40,
    tasaInteresEa: 99, montoCreditoTotal: 9999999 });
  const result = await f.storage.saveSolicitudDraft(request);
  assert.equal(result.id, f.draft.id);
  const saved = await f.read();
  assert.equal(saved.currentStep, 4); assert.equal(saved.payload.wizardStep, 4);
  assert.equal(saved.clienteNombre, f.updatedPayload.clienteNombre);
  assert.equal(saved.clienteTelefono, f.updatedPayload.clienteTelefono);
  assert.equal(saved.payload.firmaSeguroClientCorrectionPending, true);
  assert.deepEqual(saved.payload.financialTermsSeal, f.built.seal);
  assert.equal(saved.payload.firmaSeguroDraftFolio, f.seal.snapshot.folio);
  for (const field of ["cuotaInicial", "plazoMeses", "fechaPrimerPago", "fotoEntregaDataUrl", "fotoRemisionDataUrl",
    "contratoCedulaFrenteDataUrl", ...core.REQUEST_CORRECTION_FIELDS])
    assert.equal(saved.payload[field], f.updatedPayload[field], field);
  assert.equal(Object.hasOwn(saved.payload, "tasaInteresEa"), false);
  assert.equal(Object.hasOwn(saved.payload, "montoCreditoTotal"), false);
  assert.equal(f.calls.operationLocks, 1); assert.equal(f.calls.mutations, 1);
  await f.reset({ payload: saved.payload, signed: true });
  assert.equal(await f.complete(f.process), true);
  const completed = (await f.read()).payload;
  assert.equal(Object.hasOwn(completed, "firmaSeguroClientCorrectionPending"), false);
  assert.equal(completed.firmaSeguroClientCorrectionReissueProcessUuid, f.process.processUuid);
  assert.deepEqual(completed.financialTermsSeal, f.built.seal);
  // Once signed, the ordinary final-step autosave can proceed without losing the seal.
  await f.storage.saveSolicitudDraft(f.incoming(completed));
  const final = await f.read();
  assert.equal(final.currentStep, 5);
  assert.deepEqual(final.payload.financialTermsSeal, f.built.seal);
  assert.equal(Object.hasOwn(final.payload, "firmaSeguroClientCorrectionPending"), false);
});

test("un autosave no modifica el snapshot durante el envío o conciliación pendiente", async t => {
  const f = await fixture(t); const baseline = await f.read();
  for (const status of ["PREPARING", "DISPATCHING", "UNCERTAIN"]) {
    f.calls.unresolved = { status };
    await assert.rejects(f.storage.saveSolicitudDraft(f.incoming()), { code: "SOLICITUD_TERMINOS_FIRMADOS_INMUTABLE" });
    assert.deepEqual(await f.read(), baseline, status);
    assert.equal(f.calls.mutations, 0);
  }
});

test("retomar sin id una solicitud corregida exige su id y no altera paso ni datos", async t => {
  const f = await fixture(t);
  for (const marker of [{ firmaSeguroClientCorrectionPending: true },
    { firmaSeguroClientCorrectionReissueProcessUuid: f.process.processUuid }]) {
    const payload = { ...f.updatedPayload }; delete payload.firmaSeguroClientCorrectionPending;
    Object.assign(payload, marker);
    await f.reset({ payload }); const before = await f.read();
    const request = f.incoming(); delete request.id;
    await assert.rejects(f.storage.saveSolicitudDraft(request), {
      code: "SOLICITUD_ACTIVA_EXISTENTE", resumeSolicitudId: f.draft.id,
    });
    assert.deepEqual(await f.read(), before);
    assert.equal(f.calls.mutations, 0);
  }
});
