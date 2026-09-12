import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { installCreditApprovalSchema } from "../scripts/credit-approval-schema.mjs";
import { installApprovalEvidenceSchema } from "../scripts/approval-evidence-schema.mjs";
import { installCreditApprovalReissueSchema } from "../scripts/credit-approval-reissue-schema.mjs";
import { installCreditApprovalActorSchema } from "../scripts/credit-approval-actor-schema.mjs";
import { installCreditApprovalNoveltiesSchema } from "../scripts/credit-approval-novelties-schema.mjs";
import { installApprovalSharedSchema } from "../scripts/approval-shared-schema.mjs";
import { installCreditApprovalCallSchema } from "../scripts/credit-approval-call-schema.mjs";
import { loadCallModule, stateModule, actors as callActors } from "./credit-approval-call-test-loader.mjs";
import { evidence, history, photos, actor, service, correctionInput } from "./credit-approval-evidence-test-loader.mjs";

const callStore = loadCallModule("lib/credit-approval-call-store.ts", {
  "@/lib/credit-approval": service, "@/lib/credit-approval-errors": service,
  "@/lib/credit-approval-actor": callActors, "@/lib/credit-approval-call-state": stateModule,
});
const callBytes = readFileSync(new URL("fixtures/approval-call/tone.wav", import.meta.url));

// Match Prisma: PostgreSQL DateTime columns without timezone contain UTC values.
pg.types.setTypeParser(1114, (value) => new Date(value.replace(" ", "T") + "Z"));
const connectionString = process.env.CREDIT_APPROVAL_EVIDENCE_TEST_DATABASE_URL;
const adapter = (client) => ({
  $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
  $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount,
});
async function transaction(client, callback) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try { const result = await callback(adapter(client)); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}

test("PostgreSQL aislado: historial de fotos, invalidación y concurrencia", {
  skip: connectionString ? false : "Requiere CREDIT_APPROVAL_EVIDENCE_TEST_DATABASE_URL y base local approval_evidence_test.",
}, async (t) => {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/approval_evidence_test", "Solo la base exclusiva de estas pruebas");
  const client = new pg.Client({ connectionString });
  await client.connect();
  t.after(() => client.end());
  const tables = ["CreditApprovalCallRecording", "CreditApprovalNoveltyEvent", "CreditApprovalNoveltyItem", "CreditApprovalNovelty", "CreditApprovalSharedSession", "CreditApprovalSharedGrant", "CreditApprovalEvidenceRevision", "CreditApprovalReissueEvent", "CreditApprovalReissue", "CreditApprovalEvent", "CreditApprovalReview", "CreditApprovalPolicy", "FirmaSeguroProcess", "DataCreditoAssessment", "LiquidacionAliadoCredito", "CreditoAmortizacion", "Credito", "Usuario", "Sede", "Aliado"];
  const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(existing.rows.every(({ tablename }) => tables.includes(tablename)), "No se reinicia una base con tablas ajenas");
  for (const table of tables) await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
  await client.query(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (7);
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"codigo" TEXT,"nombre" TEXT);
    INSERT INTO "Aliado" VALUES (10,'ALLY','Aliado sintético'),(20,'FINSERPAY','Central');
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER);
    INSERT INTO "Sede" VALUES (10,10),(20,20);
    CREATE TABLE "Credito" (
      "id" SERIAL PRIMARY KEY,"folio" TEXT DEFAULT 'TEST',"clienteNombre" TEXT DEFAULT 'Cliente sintético',
      "clienteDocumento" TEXT DEFAULT '100000001',"clienteCorreo" TEXT,"clienteTelefono" TEXT,
      "clienteDepartamento" TEXT,"clienteCiudad" TEXT,"clienteDireccion" TEXT,
      "plazoMeses" INTEGER,"frecuenciaPago" TEXT,"valorCuota" FLOAT,"fechaPrimerPago" TIMESTAMP(3),
      "fechaCredito" TIMESTAMP DEFAULT '2026-09-10T12:00:00',
      "createdAt" TIMESTAMP(3) DEFAULT '2099-01-01T00:00:00',"updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
      "estado" TEXT DEFAULT 'ACTIVO',"sedeId" INTEGER DEFAULT 10,"imei" TEXT DEFAULT '000000000000001',
      "referenciaEquipo" TEXT DEFAULT 'Samsung Sintético',"equipoMarca" TEXT DEFAULT 'Samsung',"equipoModelo" TEXT DEFAULT 'Sintético',
      "valorEquipoTotal" FLOAT DEFAULT 1000000,"cuotaInicial" FLOAT DEFAULT 200000,
      "saldoBaseFinanciado" FLOAT DEFAULT 800000,"montoCredito" FLOAT DEFAULT 800000,"equalityService" TEXT,
      "contratoSnapshot" JSONB DEFAULT '{"equipo":{"plataforma":"ANDROID"},"financiero":{"condicion":"original"},"firma":{"valor":"original"}}',
      "contratoCedulaFrenteDataUrl" TEXT,"contratoCedulaRespaldoDataUrl" TEXT,"iphoneSelfieCedulaDataUrl" TEXT,
      "fotoEntregaDataUrl" TEXT,"fotoRemisionDataUrl" TEXT
    );
    CREATE TABLE "CreditoAmortizacion" ("creditoId" INTEGER PRIMARY KEY REFERENCES "Credito"("id"),"cuotaComercial" NUMERIC(20,2));
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER UNIQUE REFERENCES "Credito"("id"));
    CREATE TABLE "DataCreditoAssessment" ("id" TEXT PRIMARY KEY,"creditId" INTEGER,"score" INTEGER,"offer" JSONB,
      "status" TEXT,"consumedAt" TIMESTAMP,"retainedUntil" TIMESTAMP);
    CREATE TABLE "FirmaSeguroProcess" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER,"processUuid" TEXT,
      "status" TEXT,"signedDocumentBase64" TEXT,"signedDocumentFileName" TEXT,"draftPayload" JSONB,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"completedAt" TIMESTAMP,"supersededAt" TIMESTAMP);
  `);
  await installCreditApprovalSchema(client);
  await installCreditApprovalReissueSchema(client);
  // Reproduce Prisma-first: no CHECK constraints and a session-local timestamp default.
  await client.query(`CREATE TABLE "CreditApprovalEvidenceRevision" (
    "id" UUID PRIMARY KEY, "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
    "evidenceKey" VARCHAR(32) NOT NULL,"previousDataUrl" TEXT,"previousSha256" VARCHAR(64),"nextSha256" VARCHAR(64) NOT NULL,
    "actorUserId" INTEGER NOT NULL,"actorName" TEXT NOT NULL,"source" VARCHAR(32) NOT NULL,
    "reviewRevision" INTEGER,"reviewHash" VARCHAR(64),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query("SET TIME ZONE 'America/Bogota'");
  await installApprovalEvidenceSchema(client);
  await installCreditApprovalActorSchema(client);
  await installCreditApprovalNoveltiesSchema(client);
  await installApprovalSharedSchema(client);
  await installCreditApprovalCallSchema(client);
  const db = adapter(client);
  const pdf = Buffer.from("%PDF-1.4\nDocumento firmado sintético e inalterable\n%%EOF").toString("base64");
  async function createCredit(overrides = {}) {
    const values = { ...Object.fromEntries(service.APPROVAL_EVIDENCE.map(({ field }, i) => [field, photos[i]])), ...overrides };
    const keys = Object.keys(values);
    const id = (await client.query(`INSERT INTO "Credito" (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING "id"`, Object.values(values))).rows[0].id;
    await client.query(`INSERT INTO "DataCreditoAssessment" VALUES ($1,$2,750,'{"initialPaymentPercentage":20}','APROBADO',CURRENT_TIMESTAMP,'2199-01-01')`, [`assessment-${id}`, id]);
    await client.query(`INSERT INTO "FirmaSeguroProcess" ("creditoId","processUuid","status","signedDocumentBase64","signedDocumentFileName","completedAt") VALUES ($1,$2,'COMPLETED',$3,'firmado.pdf',CURRENT_TIMESTAMP)`, [id, `process-${id}`, pdf]);
    return id;
  }
  const detail = (id) => service.getCreditApprovalDetail(db, id);
  async function approve(id) {
    let current = await detail(id);
    if (current.review.status !== "APPROVED" && !current.callRecording.recording) {
      await transaction(client, (tx) => callStore.saveCreditApprovalCall(tx, id, {
        bytes: callBytes, fileName: "llamada.wav", mimeType: "audio/wav", sizeBytes: callBytes.length,
        sha256: createHash("sha256").update(callBytes).digest("hex"), idempotencyKey: randomUUID(),
        revision: current.review.revision, reviewHash: current.review.reviewHash,
      }, actor));
      current = await detail(id);
    }
    return transaction(client, (tx) => service.approveCredit(tx, id, { revision: current.review.revision,
      reviewHash: current.review.reviewHash, recordingId: current.callRecording.recording?.id }, actor));
  }
  const archives = async (id) => (await client.query('SELECT * FROM "CreditApprovalEvidenceRevision" WHERE "creditoId"=$1 ORDER BY "createdAt"', [id])).rows;

  await t.test("resumen lee cuota comercial persistida y fecha UTC sin alterar crédito, firma ni aprobación", async () => {
    for (const scenario of [
      { stored: 230100, snapshot: 230000, expected: 230100 },
      { stored: null, snapshot: 230000, expected: 230000 },
      { stored: null, snapshot: null, expected: 229999.5 },
    ]) {
      const id = await createCredit({
        clienteCorreo: "cliente@example.invalid", clienteTelefono: "3000000001",
        clienteDepartamento: "VALLE_DEL_CAUCA", clienteCiudad: "  Cali  ", clienteDireccion: "Carrera 7 # 10-20",
        plazoMeses: 12, frecuenciaPago: "QUINCENAL", valorCuota: 229999.5,
        fechaPrimerPago: "2099-02-17T00:00:00.000Z",
        contratoSnapshot: { equipo: { plataforma: "ANDROID" }, financiero: { cuotaComercial: scenario.snapshot }, firma: { valor: "original" } },
      });
      if (scenario.stored !== null) await client.query('INSERT INTO "CreditoAmortizacion" ("creditoId","cuotaComercial") VALUES ($1,$2)', [id, scenario.stored]);
      await approve(id);
      const creditBefore = (await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0];
      const reviewBefore = (await client.query('SELECT * FROM "CreditApprovalReview" WHERE "creditoId"=$1', [id])).rows[0];
      const signatureBefore = (await client.query('SELECT * FROM "FirmaSeguroProcess" WHERE "creditoId"=$1', [id])).rows[0];
      const current = await service.getCreditApprovalDetail({ ...db,
        $executeRawUnsafe: async () => { assert.fail("Consultar el resumen no debe escribir datos"); },
      }, id);
      assert.equal(current.clienteCorreo, "cliente@example.invalid");
      assert.equal(current.clienteTelefono, "3000000001");
      assert.equal(current.clienteDepartamento, "VALLE DEL CAUCA");
      assert.equal(current.clienteCiudad, "Cali");
      assert.equal(current.clienteDireccion, "Carrera 7 # 10-20");
      assert.equal(current.numeroCuotas, 12);
      assert.equal(current.frecuenciaPago, "QUINCENAL");
      assert.equal(current.valorCuota, scenario.expected);
      assert.equal(current.fechaPrimerPago, "2099-02-17", "La medianoche UTC conserva el día en una sesión Bogotá");
      assert.equal(current.review.status, "APPROVED");
      assert.equal(current.review.reviewHash, reviewBefore.reviewHash);
      assert.deepEqual((await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0], creditBefore);
      assert.deepEqual((await client.query('SELECT * FROM "CreditApprovalReview" WHERE "creditoId"=$1', [id])).rows[0], reviewBefore);
      assert.deepEqual((await client.query('SELECT * FROM "FirmaSeguroProcess" WHERE "creditoId"=$1', [id])).rows[0], signatureBefore);
    }
  });

  await t.test("Prisma primero instala todos los CHECK y defaults UTC en Bogotá", async () => {
    const id = await createCredit();
    const base = { creditoId: id, evidenceKey: "foto-entrega", previousDataUrl: null, previousSha256: null,
      nextSha256: "a".repeat(64), actorUserId: 7, actorName: "Admin sintético", source: "ADMIN_CENTRAL", reviewRevision: null, reviewHash: null };
    const insert = (changes = {}) => {
      const values = { ...base, ...changes }; const keys = Object.keys(values);
      return client.query(`INSERT INTO "CreditApprovalEvidenceRevision" (${keys.map((key) => `"${key}"`).join(",")})
        VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING "id",
        ABS(EXTRACT(EPOCH FROM ("createdAt" - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))) < 5 AS utc`, Object.values(values));
    };
    assert.equal((await insert()).rows[0].utc, true);
    for (const invalid of [{ evidenceKey: "otra" }, { source: "INTRUSO" }, { previousSha256: "invalid" },
      { nextSha256: "invalid" }, { reviewRevision: 0 }, { reviewHash: "invalid" }, { previousDataUrl: photos[0] },
      { actorName: " " }, { source: "ANALISTA_APROBACION" }]) await assert.rejects(insert(invalid), { code: "23514" });
    const checks = await client.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='public."CreditApprovalEvidenceRevision"'::regclass AND contype='c'`);
    assert.equal(checks.rowCount, 9);
  });
  await t.test("instalación repetible sin backfill ni cambios en política o contratos", async () => {
    const id = await createCredit({ createdAt: "2020-01-01" });
    const before = (await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0];
    const cutoff = (await client.query('SELECT "activatedAt" FROM "CreditApprovalPolicy"')).rows[0].activatedAt;
    await installApprovalEvidenceSchema(client);
    assert.deepEqual((await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0], before);
    assert.deepEqual((await client.query('SELECT "activatedAt" FROM "CreditApprovalPolicy"')).rows[0].activatedAt, cutoff);
    assert.equal((await archives(id)).length, 0);
  });

  await t.test("acceso compartido rechaza históricos e importados con revisión residual antes de corregir", async () => {
    const grantId = randomUUID(), sessionId = randomUUID();
    await client.query(`INSERT INTO "CreditApprovalSharedGrant" ("id","issuedByUserId") VALUES ($1,7)`, [grantId]);
    await client.query(`INSERT INTO "CreditApprovalSharedSession" ("id","grantId","expiresAt")
      VALUES ($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '8 hours')`, [sessionId, grantId]);
    const sharedActor = { kind: "SHARED_LINK", id: null, nombre: "Acceso compartido", grantId, sessionId };
    for (const overrides of [{ createdAt: "2020-01-01" },
      { equalityService: "IMPORTACION_MASIVA", contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } } },
      { sedeId: 20 }, { estado: "ANULADO" }]) {
      const id = await createCredit(overrides);
      await client.query('INSERT INTO "CreditApprovalReview" ("creditoId") VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      const input = overrides.sedeId
        ? await evidence.prepareEvidenceCorrection({ key: "foto-entrega", dataUrl: photos[5], revision: 1, reviewHash: "a".repeat(64) })
        : await correctionInput(db, photos[5], "foto-entrega", id);
      const before = (await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0];
      const trace = [];
      await assert.rejects(transaction(client, (tx) => evidence.replaceApprovalEvidence({ ...tx,
        $queryRawUnsafe: (sql, ...params) => { trace.push(sql); return tx.$queryRawUnsafe(sql, ...params); },
      }, id, input, sharedActor)), { code: "CREDIT_NOT_FOUND", status: 404 });
      assert.equal(trace.length, 3, "Solo valida sesión, bloquea crédito y comprueba alcance");
      assert.match(trace[0], /FOR SHARE OF access_grant, session/);
      assert.match(trace[1], /FROM "Credito".*FOR UPDATE/);
      assert.match(trace[2], /credit\."createdAt">=policy\."activatedAt"/);
      assert.deepEqual((await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0], before);
      assert.equal((await archives(id)).length, 0);
    }
    const id = await createCredit();
    const input = await correctionInput(db, photos[5], "foto-entrega", id);
    const result = await transaction(client, (tx) => evidence.replaceApprovalEvidence(tx, id, input, sharedActor));
    assert.equal(result.unchanged, false);
    const audit = (await archives(id))[0];
    assert.equal(audit.actorKind, "SHARED_LINK");
    assert.equal(audit.actorUserId, null);
    assert.equal(audit.actorGrantId, grantId);
    assert.equal(audit.actorSessionId, sessionId);
  });

  await t.test("reemplazar cada foto conserva versiones anteriores y congela finanzas y firma", async () => {
    const id = await createCredit();
    const before = (await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0];
    for (const { key, field } of service.APPROVAL_EVIDENCE) {
      await approve(id);
      const input = await correctionInput(db, photos[5], key, id);
      const result = await transaction(client, (tx) => evidence.replaceApprovalEvidence(tx, id, input, actor));
      assert.equal(result.item.review.status, "PENDING");
      assert.equal(result.item.review.revision, input.revision + 1);
      const historyRow = (await archives(id)).find((row) => row.evidenceKey === key);
      assert.equal(historyRow.previousDataUrl, before[field]);
      assert.equal(historyRow.previousSha256, history.evidenceSha256(before[field]));
      assert.equal(historyRow.nextSha256, history.evidenceSha256(photos[5]));
      assert.equal(historyRow.actorUserId, actor.id);
      assert.equal(historyRow.reviewHash, input.reviewHash);
      // Restore a distinct replacement for identity slots so the next slot can
      // be tested without deliberately introducing a duplicated identity photo.
      if (["cedula-frente", "cedula-posterior", "selfie-cedula"].includes(key)) {
        const restore = await correctionInput(db, before[field], key, id);
        await transaction(client, (tx) => evidence.replaceApprovalEvidence(tx, id, restore, actor));
      }
    }
    const after = (await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0];
    assert.deepEqual(after.contratoSnapshot.financiero, before.contratoSnapshot.financiero);
    assert.deepEqual(after.contratoSnapshot.firma, before.contratoSnapshot.firma);
    assert.equal(after.valorEquipoTotal, before.valorEquipoTotal);
    assert.equal((await client.query('SELECT "signedDocumentBase64" FROM "FirmaSeguroProcess" WHERE "creditoId"=$1', [id])).rows[0].signedDocumentBase64, pdf);
    for (const query of ['UPDATE "CreditApprovalEvidenceRevision" SET "actorName"=\'otro\' WHERE "creditoId"=$1',
      'DELETE FROM "CreditApprovalEvidenceRevision" WHERE "creditoId"=$1']) await assert.rejects(client.query(query, [id]), { code: "23514" });
    await assert.rejects(client.query('TRUNCATE "CreditApprovalEvidenceRevision"'), { code: "23514" });
  });

  await t.test("créditos históricos, anulados, pagados e importados no se modifican", async () => {
    for (const overrides of [{ createdAt: "2020-01-01" }, { estado: "ANULADO" },
      { equalityService: "IMPORTACION_MASIVA", contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } } }]) {
      const id = await createCredit(overrides);
      const input = await correctionInput(db, photos[5], "foto-entrega", id);
      await assert.rejects(transaction(client, (tx) => evidence.replaceApprovalEvidence(tx, id, input, actor)), { code: "CORRECTION_NOT_ALLOWED" });
      assert.equal((await archives(id)).length, 0);
    }
    const id = await createCredit(); await approve(id);
    await client.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [id]);
    const input = await correctionInput(db, photos[5], "foto-entrega", id);
    await assert.rejects(transaction(client, (tx) => evidence.replaceApprovalEvidence(tx, id, input, actor)), { code: "CORRECTION_NOT_ALLOWED" });
    assert.equal((await archives(id)).length, 0);
    assert.equal((await detail(id)).review.status, "APPROVED");
  });

  await t.test("un fallo de escritura revierte también el archivo de la imagen anterior", async () => {
    const id = await createCredit();
    const input = await correctionInput(db, photos[5], "foto-entrega", id);
    await assert.rejects(transaction(client, (tx) => evidence.replaceApprovalEvidence({ ...tx,
      $executeRawUnsafe: (sql, ...params) => { if (sql.startsWith('UPDATE "Credito"')) throw new Error("Fallo sintético"); return tx.$executeRawUnsafe(sql, ...params); },
    }, id, input, actor)), /Fallo sintético/);
    assert.equal((await archives(id)).length, 0);
    assert.equal((await client.query('SELECT "fotoEntregaDataUrl" FROM "Credito" WHERE "id"=$1', [id])).rows[0].fotoEntregaDataUrl, photos[3]);
  });

  await t.test("dos correcciones de la misma revisión conservan una sola decisión", async () => {
    const id = await createCredit();
    const input = await correctionInput(db, photos[5], "foto-entrega", id);
    const second = new pg.Client({ connectionString }); await second.connect();
    try {
      const results = await Promise.allSettled([
        transaction(client, (tx) => evidence.replaceApprovalEvidence(tx, id, input, actor)),
        transaction(second, (tx) => evidence.replaceApprovalEvidence(tx, id, input, actor)),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.find((result) => result.status === "rejected").reason.code, "REVIEW_CHANGED");
      assert.equal((await archives(id)).length, 1);
    } finally { await second.end(); }
  });

  await t.test("liquidación que obtiene el lock primero impide la corrección en espera", async () => {
    const id = await createCredit(); await approve(id);
    const input = await correctionInput(db, photos[5], "foto-entrega", id);
    const correctionClient = new pg.Client({ connectionString }); await correctionClient.connect();
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    await client.query("BEGIN");
    try {
      await client.query('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE', [id]);
      await client.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [id]);
      const correction = transaction(correctionClient, (tx) => evidence.replaceApprovalEvidence({ ...tx,
        $queryRawUnsafe: (sql, ...params) => { if (sql.includes('FROM "Credito" WHERE "id" = $1 FOR UPDATE')) notifyStarted(); return tx.$queryRawUnsafe(sql, ...params); },
      }, id, input, actor));
      await started;
      await client.query("COMMIT");
      await assert.rejects(correction, { code: "CORRECTION_NOT_ALLOWED" });
      assert.equal((await archives(id)).length, 0);
      assert.equal((await detail(id)).review.status, "APPROVED");
    } finally { await client.query("ROLLBACK"); await correctionClient.end(); }
  });

  await t.test("firma en curso bloquea corrección sin crear una versión de foto", async () => {
    const id = await createCredit();
    const current = await detail(id);
    await client.query(`INSERT INTO "CreditApprovalReissue" (
      "id","creditoId","previousProcessUuid","sourceRevision","reason","requestedByUserId","requestedByName",
      "frozenCredit","originalContractSnapshot","originalSignedDocumentBase64","originalDocumentHash","sourceTermsHash","status")
      VALUES (gen_random_uuid(),$1,$2,$3,'Corrección sintética',7,'Analista sintético','{}','{}',$4,$5,$5,'PREPARING')`,
    [id, `process-${id}`, current.review.revision, pdf, "a".repeat(64)]);
    const input = await correctionInput(db, photos[5], "foto-entrega", id);
    await assert.rejects(transaction(client, (tx) => evidence.replaceApprovalEvidence(tx, id, input, actor)), { code: "CORRECTION_NOT_ALLOWED" });
    assert.equal((await archives(id)).length, 0);
  });
  await t.test("una foto corregida impide liquidar hasta un nuevo OK", async () => {
    const id = await createCredit(); await approve(id);
    const input = await correctionInput(db, photos[5], "foto-entrega", id);
    await transaction(client, (tx) => evidence.replaceApprovalEvidence(tx, id, input, actor));
    await assert.rejects(client.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [id]), { code: "23514" });
    await assert.rejects(transaction(client, (tx) => service.approveCredit(tx, id, input, actor)), { code: "REVIEW_CHANGED" });
    await approve(id);
    assert.equal((await client.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [id])).rowCount, 1);
  });
});
