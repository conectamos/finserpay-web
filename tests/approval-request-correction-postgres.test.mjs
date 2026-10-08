import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

function load(file, dependencies = {}) {
  const loaded = { exports: {} };
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Date, URL,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return loaded.exports;
}

const core = load("lib/approval-request-correction-core.ts", {
  "./credit-client-name": load("lib/credit-client-name.ts"),
  "./credit-contact-phones": load("lib/credit-contact-phones.ts"),
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const actor = { id: 17, nombre: "Analista de pruebas" };
const originalPayload = {
  clienteNombre: "ANA PRUEBA DEMO", clientePrimerNombre: "ANA",
  clientePrimerApellido: "PRUEBA", clienteSegundoApellido: "DEMO",
  clienteDocumento: "100000001", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA",
  clienteTelefono: "3001234567", clienteCorreo: "ana@example.test",
  clienteDireccion: "Calle de pruebas 1", clienteDepartamento: "TOLIMA", clienteCiudad: "Ibague",
  clienteFechaNacimiento: "1990-01-02", clienteFechaExpedicion: "2010-01-02",
  referenciaFamiliar1Telefono: "3011234567", referenciaFamiliar2Telefono: "3021234567",
  imei: "350000000000001", equipoMarca: "IPHONE", equipoModelo: "13",
  valorEquipoTotal: "4500000", cuotaInicial: "1500000", plazoMeses: "40",
  frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2030-01-17", wizardStep: 2,
  dataCreditoAssessmentId: "11111111-1111-4111-8111-111111111111",
  contratoCedulaFrenteDataUrl: "cedula-frontal", contratoCedulaRespaldoDataUrl: "cedula-posterior",
  contratoSelfieDataUrl: "selfie", fotoEntregaDataUrl: "entrega", fotoRemisionDataUrl: "remision", recording: "audio",
};

test("SQL real de corrección: actualización atómica, auditoría y restricciones del expediente", async (t) => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY, "estado" TEXT NOT NULL, "creditoId" INTEGER,
      "clienteNombre" TEXT, "clienteTelefono" TEXT, "clienteDocumento" TEXT, "payload" JSONB NOT NULL,
      "currentStep" INTEGER NOT NULL, "dataCreditoAssessmentId" UUID,
      "imei" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" TIMESTAMPTZ, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "FirmaSeguroProcess" ("id" INTEGER PRIMARY KEY, "draftId" INTEGER, "status" TEXT,
      "creditoId" INTEGER,"processUuid" TEXT,"supersededAt" TIMESTAMPTZ,"createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "VeriffIdentityValidation" ("id" INTEGER PRIMARY KEY, "draftId" INTEGER, "status" TEXT);
    CREATE TABLE "FirmaSeguroDraftDispatch" ("id" INTEGER PRIMARY KEY, "draftId" INTEGER, "status" TEXT);
    CREATE TABLE "ApprovalOperationalAction" (
      "id" UUID PRIMARY KEY, "targetKind" TEXT, "targetId" INTEGER,
      "eventType" TEXT, "actorUserId" INTEGER, "actorName" TEXT, "reason" TEXT,
      "beforeContact" JSONB, "afterContact" JSONB, "status" TEXT
    );
  `);
  const trace = [];
  const adapter = (db) => ({
    $queryRawUnsafe: async (sql, ...values) => {
      trace.push({ kind: "read", sql });
      return (await db.query(sql, values)).rows;
    },
    $executeRawUnsafe: async (sql, ...values) => {
      trace.push({ kind: "write", sql });
      return (await db.query(sql, values)).affectedRows;
    },
  });
  const service = load("lib/approval-request-correction.ts", {
    "server-only": {}, "node:crypto": { randomUUID },
    "@/lib/prisma": { default: {
      $transaction: (callback) => pg.transaction((db) => callback(adapter(db))),
    } },
    "@/lib/approval-operations-schema": { ensureApprovalOperationalSchema: async () => {} },
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: async () => {},
      lockSolicitudOperationMutation: async (_db, id) => trace.push({ kind: "operation-lock", id }) },
    "@/lib/solicitudes-storage": { ensureSolicitudSchema: async () => {} },
    "@/lib/veriff-storage": { ensureVeriffSchema: async () => {},
      lockVeriffDraftAttempts: async (_db, id) => trace.push({ kind: "identity-lock", id }) },
    "@/lib/approval-request-correction-core": core,
    "@/lib/approval-request-client-signature-correction": { correctAndReissueAnalystRequestData: async () => {
      trace.push({ kind: "signature-correction" });
      throw new core.RequestDataCorrectionError("CONFIRM_NEW_SIGNATURE", "Confirma la nueva firma", 400);
    } },
  });
  let nextId = 0;
  async function seed(payload = originalPayload) {
    const id = ++nextId;
    await pg.query(`INSERT INTO "CreditoBorrador" (
      "id","estado","clienteNombre","clienteTelefono","clienteDocumento","payload","currentStep",
      "dataCreditoAssessmentId","imei","expiresAt")
      VALUES ($1,'ABIERTO',$2,$3,$4,$5::jsonb,2,$6::uuid,$7,'2300-01-01')`,
    [id, payload.clienteNombre, payload.clienteTelefono, payload.clienteDocumento, JSON.stringify(payload), payload.dataCreditoAssessmentId, payload.imei]);
    return id;
  }
  async function row(id) {
    return (await pg.query('SELECT * FROM "CreditoBorrador" WHERE "id"=$1', [id])).rows[0];
  }
  async function audits(id) {
    return (await pg.query('SELECT * FROM "ApprovalOperationalAction" WHERE "targetId"=$1', [id])).rows;
  }
  function correction(values, expected = originalPayload, revision = 0) {
    return core.parseRequestDataCorrection({ values, expectedValues: Object.fromEntries(
      Object.keys(values).map((field) => [field, String(expected[field] ?? "")]),
    ), expectedRevision: revision, reason: "Corrección cotejada con el cliente" });
  }
  async function unchangedAfterFailure(id, input, expectedError, requestActor = actor) {
    const before = plain(await row(id));
    const beforeAudit = plain(await audits(id));
    await assert.rejects(service.correctAnalystRequestData(id, input, requestActor), expectedError);
    assert.deepEqual(plain(await row(id)), before);
    assert.deepEqual(plain(await audits(id)), beforeAudit);
  }

  await t.test("guarda nombre, teléfono y payload juntos y conserva los términos reales", async () => {
    const id = await seed();
    const before = await row(id);
    trace.length = 0;
    const result = await service.correctAnalystRequestData(id, correction({
      clientePrimerNombre: "Ana Maria", clienteTelefono: "3101234567",
    }), actor);
    const saved = await row(id);
    assert.equal(saved.clienteNombre, "ANA MARIA PRUEBA DEMO");
    assert.equal(saved.payload.clienteNombre, saved.clienteNombre);
    assert.equal(saved.clienteTelefono, "3101234567");
    assert.equal(saved.payload.clienteTelefono, saved.clienteTelefono);
    for (const field of ["currentStep", "dataCreditoAssessmentId", "imei", "estado", "creditoId"])
      assert.equal(saved[field], before[field]);
    for (const field of ["clienteDocumento", "clienteTipoDocumento", "clientePrimerApellido",
      "equipoMarca", "equipoModelo", "valorEquipoTotal", "cuotaInicial", "plazoMeses",
      "frecuenciaPago", "fechaPrimerPago", "wizardStep", "dataCreditoAssessmentId"])
      assert.equal(saved.payload[field], originalPayload[field]);
    assert.equal(result.revision, 1);
    const operationLock = trace.findIndex(event => event.kind === "operation-lock");
    assert.ok(operationLock >= 0);
    assert.deepEqual(trace.slice(operationLock, operationLock + 2), [
      { kind: "operation-lock", id }, { kind: "identity-lock", id },
    ]);
    const firstWrite = trace.findIndex(event => event.kind === "write");
    assert.ok(firstWrite > operationLock + 1);
    assert.ok(trace.slice(operationLock + 2, firstWrite).some(event => event.kind === "read" && /FOR UPDATE/.test(event.sql)));
    const [audit] = await audits(id);
    assert.equal(audit.targetKind, "DRAFT");
    assert.equal(audit.actorUserId, actor.id);
    assert.equal(audit.actorName, actor.nombre);
    assert.equal(audit.status, "DATA_CORRECTED");
    assert.equal(audit.reason, "Corrección cotejada con el cliente");
    assert.deepEqual(audit.beforeContact, { clientePrimerNombre: "ANA", clienteTelefono: "3001234567",
      clienteNombre: "ANA PRUEBA DEMO", analystDataRevision: 0 });
    assert.deepEqual(audit.afterContact, { clientePrimerNombre: "ANA MARIA", clienteTelefono: "3101234567",
      clienteNombre: "ANA MARIA PRUEBA DEMO", analystDataRevision: 1 });
  });

  await t.test("el dato canónico de la columna prevalece sobre un payload histórico", async () => {
    const id = await seed();
    await pg.query('UPDATE "CreditoBorrador" SET "clienteTelefono"=$2 WHERE "id"=$1', [id, "3111234567"]);
    const detail = await service.getAnalystRequestCorrection(id);
    assert.equal(detail.values.clienteTelefono, "3111234567");
    await service.correctAnalystRequestData(id,
      correction({ clienteTelefono: "3101234567" }, { ...originalPayload, clienteTelefono: "3111234567" }), actor);
    const saved = await row(id);
    assert.equal(saved.payload.clienteTelefono, "3101234567");
    assert.equal(saved.clienteTelefono, "3101234567");
  });

  await t.test("rechaza cambios hechos mientras el analista revisaba solo el campo editado", async () => {
    const id = await seed();
    const obsolete = correction({ clienteTelefono: "3101234567" });
    await pg.query('UPDATE "CreditoBorrador" SET "clienteTelefono"=$2 WHERE "id"=$1', [id, "3111234567"]);
    await unchangedAfterFailure(id, obsolete, { code: "REQUEST_CHANGED" });
    const current = { ...originalPayload, clienteTelefono: "3111234567" };
    const valid = correction({ clienteTelefono: "3101234567" }, current);
    await pg.query(`UPDATE "CreditoBorrador" SET "payload"="payload" || '{"valorEquipoTotal":"5000000"}'::jsonb WHERE "id"=$1`, [id]);
    await service.correctAnalystRequestData(id, valid, actor);
    assert.equal((await row(id)).payload.valorEquipoTotal, "5000000");
    await unchangedAfterFailure(id, valid, { code: "REQUEST_CHANGED" });
    assert.equal((await audits(id)).length, 1);
  });

  await t.test("una firma histórica sin fuente vigente y un despacho incierto bloquean antes de mutar", async () => {
    const historicalId = await seed();
    await pg.query(`INSERT INTO "FirmaSeguroProcess" ("id","draftId","status","processUuid","supersededAt")
      VALUES ($1,$1,'FAILED','firma-archivada',CURRENT_TIMESTAMP)`, [historicalId]);
    await unchangedAfterFailure(historicalId, correction({ clienteTelefono: "3101234567" }), { code: "REQUEST_LOCKED" });
    for (const status of ["PREPARING", "DISPATCHING", "UNCERTAIN"]) {
      const id = await seed();
      await pg.query(`INSERT INTO "FirmaSeguroDraftDispatch" VALUES ($1,$1,$2)`, [id, status]);
      await unchangedAfterFailure(id, correction({ clienteTelefono: "3101234567" }), { code: "REQUEST_LOCKED" });
    }
  });

  await t.test("un despacho fallido sin proceso no bloquea para siempre la corrección de datos", async () => {
    const id = await seed();
    await pg.query(`INSERT INTO "FirmaSeguroDraftDispatch" VALUES ($1,$1,'FAILED_SAFE')`, [id]);
    await service.correctAnalystRequestData(id, correction({ clienteTelefono: "3101234567" }), actor);
    assert.equal((await row(id)).clienteTelefono, "3101234567");
    assert.equal((await audits(id)).length, 1);
  });

  await t.test("la firma vigente habilita edición pero dirige la corrección al envío confirmado de la nueva versión", async () => {
    const id = await seed();
    await pg.query(`INSERT INTO "FirmaSeguroProcess" ("id","draftId","status","processUuid")
      VALUES ($1,$1,'PENDING','firma-vigente')`, [id]);
    const detail = await service.getAnalystRequestCorrection(id);
    assert.ok(detail.editableFields.includes("clientePrimerNombre"));
    assert.ok(detail.editableFields.includes("clienteFechaNacimiento"));
    assert.equal(detail.requiresNewSignature, true);
    assert.equal(detail.expectedProcessUuid, "firma-vigente");
    await unchangedAfterFailure(id, correction({ clienteTelefono: "3101234567" }), { code: "CONFIRM_NEW_SIGNATURE" });
    assert.ok(trace.some(event => event.kind === "signature-correction"));
  });

  await t.test("identidad pendiente o aprobada permite nombres y nacimiento sin borrar evidencias o audio", async () => {
    for (const status of ["PENDING", "APPROVED"]) {
      const id = await seed();
      await pg.query('INSERT INTO "VeriffIdentityValidation" VALUES ($1,$1,$2)', [id, status]);
      const detail = await service.getAnalystRequestCorrection(id);
      assert.ok(detail.editableFields.includes("clientePrimerNombre"));
      assert.ok(detail.editableFields.includes("clienteFechaNacimiento"));
      assert.ok(detail.editableFields.includes("clienteTelefono"));
      await service.correctAnalystRequestData(id, correction({ clientePrimerNombre: "ANA MARIA",
        clienteFechaNacimiento: "1991-02-03", clienteTelefono: "3101234567" }), actor);
      const saved = await row(id);
      assert.equal(saved.clienteNombre, "ANA MARIA PRUEBA DEMO");
      assert.equal(saved.clienteTelefono, "3101234567");
      assert.equal(saved.payload.clienteFechaNacimiento, "1991-02-03");
      assert.equal(saved.clienteDocumento, originalPayload.clienteDocumento);
      assert.equal(saved.payload.clientePrimerApellido, originalPayload.clientePrimerApellido);
      for (const field of ["contratoCedulaFrenteDataUrl", "contratoCedulaRespaldoDataUrl", "contratoSelfieDataUrl",
        "fotoEntregaDataUrl", "fotoRemisionDataUrl", "recording"])
        assert.equal(saved.payload[field], originalPayload[field]);
      assert.equal((await audits(id)).length, 1);
    }
  });

  await t.test("la cédula y el primer apellido permanecen bloqueados también dentro de la mutación", async () => {
    const id = await seed();
    for (const field of ["clienteDocumento", "clientePrimerApellido"]) {
      const input = { values: { [field]: "OTRO" }, expectedValues: { [field]: originalPayload[field] },
        expectedRevision: 0, reason: "Intento de edición no permitida" };
      await unchangedAfterFailure(id, input, { code: "FIELD_LOCKED" });
    }
  });

  await t.test("solicitudes vencidas, cerradas y convertidas permanecen intactas", async () => {
    for (const update of [
      '"expiresAt"=\'1900-01-01\'',
      '"estado"=\'CERRADO\'',
      '"creditoId"=99',
      '"expiresAt"=NULL,"createdAt"=\'1900-01-01\'',
    ]) {
      const id = await seed();
      await pg.query(`UPDATE "CreditoBorrador" SET ${update} WHERE "id"=$1`, [id]);
      await unchangedAfterFailure(id, correction({ clienteTelefono: "3101234567" }), { code: "REQUEST_LOCKED" });
    }
  });

  await t.test("un error al insertar auditoría revierte también la actualización del borrador", async () => {
    const id = await seed();
    await pg.exec('ALTER TABLE "ApprovalOperationalAction" ADD CONSTRAINT "audit_test_failure" CHECK ("actorUserId"<>29)');
    await unchangedAfterFailure(id, correction({ clienteTelefono: "3101234567" }),
      /audit_test_failure/, { id: 29, nombre: "Analista de prueba de rollback" });
    await pg.exec('ALTER TABLE "ApprovalOperationalAction" DROP CONSTRAINT "audit_test_failure"');
  });
});
