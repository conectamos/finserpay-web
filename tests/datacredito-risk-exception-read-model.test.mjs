import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { activeRiskExceptionSql } from "../lib/datacredito/risk-exception-display-sql.ts";
import { resolveSolicitudStage, resolveSolicitudProcessStage } from "../lib/solicitudes.ts";

test("la autorización interna conserva NO_EVALUADO y sólo cambia la etapa con una decisión vigente", () => {
  const signals = { source: "DRAFT", draftState: "ABIERTO", currentStep: 3,
    dataCreditoStatus: "NO_EVALUADO", dataCreditoErrorCode: "NO_EVALUABLE_INFORMATION" };
  assert.equal(resolveSolicitudStage(signals), "ERROR_TECNICO");
  assert.equal(resolveSolicitudStage({ ...signals, creditRiskExceptionAuthorized: true }), "PROCESO");
  assert.equal(resolveSolicitudProcessStage({ ...signals, creditRiskExceptionAuthorized: true }), "VALIDACION_FACIAL");
  assert.equal(resolveSolicitudStage({ ...signals, creditRiskExceptionAuthorized: true, veriffStatus: "ERROR" }), "ERROR_TECNICO");
  assert.equal(resolveSolicitudStage({ ...signals, creditRiskExceptionAuthorized: true, draftState: "CERRADO", closedReason: "DESISTIDA" }), "CANCELADA");
  assert.equal(resolveSolicitudStage({ ...signals, creditRiskExceptionAuthorized: true, dataCreditoStatus: "RECHAZADO" }), "RECHAZADA");
  assert.equal(signals.dataCreditoStatus, "NO_EVALUADO");
});

test("listado y enrolamiento comprueban la misma excepción individual con SQL real", async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE "Sede" ("id" int, "aliadoId" int);
      CREATE TABLE "CreditoBorrador" ("id" int, "creditRiskExceptionId" uuid, "dataCreditoAssessmentId" uuid,
        "usuarioId" int, "vendedorId" int, "sedeId" int, "plataforma" text, "payload" jsonb,
        "estado" text, "creditoId" int, "expiresAt" timestamptz, "createdAt" timestamptz);
      CREATE TABLE "DataCreditoAssessment" ("id" uuid, "documentHash" text, "surnameHash" text,
        "platform" text, "providerEnvironment" text, "userId" int, "sellerId" int, "sedeId" int,
        "aliadoId" int, "status" text, "errorCode" text, "providerStatus" text, "transactionCode" text,
        "score" int, "decision" text, "offer" jsonb, "reusedFromAssessmentId" uuid,
        "consumedAt" timestamptz, "creditId" int, "expiresAt" timestamptz, "retainedUntil" timestamptz);
      CREATE TABLE "CreditRiskException" ("id" uuid, "solicitudId" int, "assessmentId" uuid,
        "documentHash" text, "surnameHash" text, "platform" text, "providerEnvironment" text,
        "userId" int, "sellerId" int, "sedeId" int, "aliadoId" int, "riskAcknowledged" boolean,
        "providerStatus" text, "transactionCode" text, "historyCode" text, "errorCode" text,
        "expiresAt" timestamptz, "revokedAt" timestamptz, "consumedAt" timestamptz, "creditId" int);
      INSERT INTO "Sede" VALUES (65,65588);
      INSERT INTO "CreditoBorrador" VALUES (4098,'10000000-0000-4000-8000-000000000001',
        '4d14cb36-dec9-4b08-9532-ed0739bdcbc4',20,61,65,'IPHONE','{}','ABIERTO',NULL,NOW()+INTERVAL '1 day',NOW());
      INSERT INTO "DataCreditoAssessment" VALUES ('4d14cb36-dec9-4b08-9532-ed0739bdcbc4',
        'test-document-hash','test-surname-hash','IPHONE','production',20,61,65,65588,
        'NO_EVALUADO','NO_EVALUABLE_INFORMATION','ACCEPTED','07',NULL,NULL,NULL,NULL,NULL,NULL,
        NOW()+INTERVAL '1 day',NOW()+INTERVAL '15 days');
      INSERT INTO "CreditRiskException" VALUES ('10000000-0000-4000-8000-000000000001',4098,
        '4d14cb36-dec9-4b08-9532-ed0739bdcbc4','test-document-hash','test-surname-hash','IPHONE','production',
        20,61,65,65588,TRUE,'ACCEPTED','07','09','NO_EVALUABLE_INFORMATION',NOW()+INTERVAL '1 day',NULL,NULL,NULL);
    `);
    const eligibility = activeRiskExceptionSql({ draft: "d", assessment: "dc", allyId: 's."aliadoId"' });
    const query = `SELECT ${eligibility} AS authorized FROM "CreditoBorrador" d
      JOIN "DataCreditoAssessment" dc ON dc."id"=d."dataCreditoAssessmentId"
      JOIN "Sede" s ON s."id"=d."sedeId"`;
    assert.equal((await db.query(query)).rows[0].authorized, true);
    const mutations = {
      "metadato de payload no concede autoridad": `UPDATE "CreditoBorrador" SET "creditRiskExceptionId"=NULL,"payload"='{"creditRiskExceptionId":"10000000-0000-4000-8000-000000000001","creditAuthorizationSource":"INTERNAL_EXCEPTION"}'`,
      "otra solicitud": `UPDATE "CreditoBorrador" SET "id"=4099; UPDATE "CreditRiskException" SET "solicitudId"=4099`,
      "revocada": `UPDATE "CreditRiskException" SET "revokedAt"=NOW()`,
      "vencida": `UPDATE "CreditRiskException" SET "expiresAt"=NOW()-INTERVAL '1 second'`,
      "consumida": `UPDATE "CreditRiskException" SET "consumedAt"=NOW(),"creditId"=77`,
      "otro propietario": `UPDATE "CreditRiskException" SET "userId"=21`,
      "otro asesor": `UPDATE "CreditRiskException" SET "sellerId"=62`,
      "otro aliado": `UPDATE "CreditRiskException" SET "aliadoId"=2`,
      "otro documento": `UPDATE "CreditRiskException" SET "documentHash"='other-document'`,
      "otro apellido consultado": `UPDATE "CreditRiskException" SET "surnameHash"='other-surname'`,
      "otro ambiente": `UPDATE "CreditRiskException" SET "providerEnvironment"='demo'`,
      "otra plataforma": `UPDATE "CreditRiskException" SET "platform"='ANDROID'`,
      "otro código": `UPDATE "CreditRiskException" SET "historyCode"='14'`,
      "sin autorización": `UPDATE "CreditRiskException" SET "riskAcknowledged"=FALSE`,
      "solicitud desistida": `UPDATE "CreditoBorrador" SET "estado"='CERRADO'`,
      "solicitud vencida": `UPDATE "CreditoBorrador" SET "expiresAt"=NOW()-INTERVAL '1 second'`,
      "solicitud convertida": `UPDATE "CreditoBorrador" SET "creditoId"=77`,
      "consulta rechazada": `UPDATE "DataCreditoAssessment" SET "status"='RECHAZADO'`,
      "puntaje presente incluso cero": `UPDATE "DataCreditoAssessment" SET "score"=0`,
      "oferta de proveedor presente": `UPDATE "DataCreditoAssessment" SET "offer"='{}'`,
      "consulta vencida": `UPDATE "DataCreditoAssessment" SET "expiresAt"=NOW()-INTERVAL '1 second'`,
    };
    for (const [name, sql] of Object.entries(mutations)) {
      await t.test(name, async () => {
        await db.exec("BEGIN");
        try { await db.exec(sql); assert.equal((await db.query(query)).rows[0].authorized, false); }
        finally { await db.exec("ROLLBACK"); }
      });
    }
  } finally { await db.close(); }
});
