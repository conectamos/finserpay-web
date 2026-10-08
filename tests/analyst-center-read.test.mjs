import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(path, dependencies = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { module, exports: module.exports, Date,
    require(name) {
      if (name === "server-only") return {};
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return module.exports;
}
const errors = load("lib/credit-approval-errors.ts");
const operational = load("lib/approval-operations-read.ts", {
  "@/lib/prisma": { default: {} }, "@/lib/ally-payments-core": {},
  "@/lib/credit-amortization-contract": {}, "@/lib/firmaseguro-status": {},
  "@/lib/credit-device-replacement-remission": {}, "@/lib/approval-operations-core": {},
});
const history = load("lib/analyst-center-history.ts", {
  "@/lib/prisma": { default: {} }, "@/lib/credit-approval-errors": errors,
});
let selected = { kind: "CREDIT", id: 1, status: "INSCRITO", document: "001.000.001", signature: { status: "SIGNED" },
  capabilities: { canChangeImei: true, canFinalizeImei: false, canRedirectPendingSignature: false, reason: "Remisión pendiente" } };
let heavyDetailReads = 0;
const reader = load("lib/analyst-center-read.ts", {
  "@/lib/prisma": { default: {} }, "@/lib/approval-operations-read": { ...operational,
    getOperationalCase: async () => { heavyDetailReads += 1; return selected; } },
});
const plain = value => JSON.parse(JSON.stringify(value));

test("paginación valida antes de leer y rechaza identificadores de actor inválidos", async () => {
  const db = { $queryRawUnsafe: () => assert.fail("No debería consultar antes de validar.") };
  assert.deepEqual(plain(history.analystCenterPagination(null, null)), { page: 1, pageSize: 20 });
  for (const page of ["-1", "0", "1e2", "1.2", "100001", ""]) {
    await assert.rejects(history.getAnalystCenterManagements(17, { page }, db), { code: "INVALID_PAGE" });
  }
  for (const pageSize of ["0", "101", "x", "1.2"]) {
    await assert.rejects(history.getAnalystCenterManagements(17, { pageSize }, db), { code: "INVALID_PAGE" });
  }
  for (const actor of [0, -1, NaN, "17"]) {
    await assert.rejects(history.getAnalystCenterManagements(actor, {}, db), { code: "UNAUTHORIZED" });
  }
});

test("ausencia de historial crítico produce 503 y nunca finge cero gestiones", async () => {
  await assert.rejects(history.getAnalystCenterManagements(17, {}, {
    $queryRawUnsafe: async () => [],
  }), { code: "HISTORY_UNAVAILABLE", status: 503 });
});

const postgres = process.env.ANALYST_CENTER_PGLITE_MODULE
  ? await import(pathToFileURL(process.env.ANALYST_CENTER_PGLITE_MODULE).href)
  : await import("@electric-sql/pglite").catch(() => null);
const optionalPostgres = { skip: postgres ? false : "PGlite local no instalado; no se consulta producción." };

async function fixture() {
  const db = new postgres.PGlite();
  await db.exec(`SET TIME ZONE 'America/Bogota';
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY,"folio" TEXT,"clienteNombre" TEXT,"clienteDocumento" TEXT,
      "clienteTelefono" TEXT,"clienteCorreo" TEXT,"estado" TEXT,"imei" TEXT,"deviceUid" TEXT,
      "referenciaEquipo" TEXT,"equipoMarca" TEXT,"equipoModelo" TEXT,"createdAt" TIMESTAMP,"updatedAt" TIMESTAMP,
      "equalityService" TEXT,"contratoSnapshot" JSONB);
    CREATE TABLE "CreditoBorrador" ("id" INTEGER PRIMARY KEY,"estado" TEXT,"closedReason" TEXT,"creditoId" INTEGER,
      "currentStep" INTEGER,"clienteNombre" TEXT,"clienteDocumento" TEXT,"clienteTelefono" TEXT,"imei" TEXT,
      "plataforma" TEXT,"payload" JSONB,"createdAt" TIMESTAMP,"updatedAt" TIMESTAMP,"expiresAt" TIMESTAMP);
    CREATE TABLE "CreditSadminRegistration" ("creditoId" INTEGER PRIMARY KEY,"numeroCredito" TEXT,"numeroCreditoConfirmado" BOOLEAN);
    CREATE TABLE "CreditApprovalEvent" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"actorKind" TEXT,"eventType" TEXT,"createdAt" TIMESTAMP);
    CREATE TABLE "CreditSadminEvent" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"actorKind" TEXT,"payload" JSONB,"createdAt" TIMESTAMP);
    CREATE TABLE "ApprovalOperationalAction" ("id" UUID,"targetKind" TEXT,"targetId" INTEGER,"creditId" INTEGER,
      "actorUserId" INTEGER,"eventType" TEXT,"status" TEXT,"createdAt" TIMESTAMP);
    CREATE TABLE "ApprovalOperationalContractVersion" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"status" TEXT,"requestedAt" TIMESTAMP);
    CREATE TABLE "CreditApprovalInitialSignature" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"status" TEXT,"requestedAt" TIMESTAMP);
    CREATE TABLE "CreditApprovalReissue" ("id" UUID,"creditoId" INTEGER,"requestedByUserId" INTEGER,"requestedByKind" TEXT,"status" TEXT,"requestedAt" TIMESTAMP);
    CREATE TABLE "FirmaSeguroDraftDispatch" ("id" UUID,"draftId" INTEGER,"actorUserId" INTEGER,"status" TEXT,"createdAt" TIMESTAMP);
    CREATE TABLE "CreditApprovalCallRecording" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"actorKind" TEXT,"createdAt" TIMESTAMP);
    CREATE TABLE "CreditDeviceReplacement" ("id" UUID,"creditId" INTEGER);
    CREATE TABLE "CreditDeviceReplacementRemission" ("id" UUID,"replacementId" UUID);
    CREATE TABLE "CreditDeviceReplacementRemissionEvent" ("id" UUID,"remissionId" UUID,"actorUserId" INTEGER,"eventType" TEXT,"createdAt" TIMESTAMPTZ);
    CREATE TABLE "CreditApprovalNovelty" ("id" UUID,"creditoId" INTEGER);
    CREATE TABLE "CreditApprovalNoveltyEvent" ("id" UUID,"noveltyId" UUID,"actorUserId" INTEGER,"actorKind" TEXT,"type" TEXT,"createdAt" TIMESTAMP);
    CREATE TABLE "CreditApprovalDataCorrection" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"actorKind" TEXT,"resultingRevision" INTEGER,"createdAt" TIMESTAMP);
    CREATE TABLE "CreditApprovalEvidenceRevision" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"actorKind" TEXT,"evidenceKey" TEXT,"createdAt" TIMESTAMP);
    CREATE TABLE "CreditMoraManagementEvent" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"responsibleUserId" INTEGER,"action" TEXT,"result" TEXT,"actedAt" TIMESTAMPTZ);
    CREATE TABLE "CreditMoraSupport" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"createdAt" TIMESTAMPTZ);
    CREATE TABLE "CreditMoraExceptionEvent" ("id" UUID,"creditoId" INTEGER,"actorUserId" INTEGER,"action" TEXT,"toStatus" TEXT,"createdAt" TIMESTAMPTZ);
    CREATE TABLE "DataCreditoAssessment" ("id" UUID,"creditId" INTEGER);
    CREATE TABLE "DataCreditoAdminAccessAudit" ("id" UUID,"assessmentId" UUID,"actorUserId" INTEGER,"action" TEXT,"outcome" TEXT,"createdAt" TIMESTAMP);
    CREATE TABLE "SolicitudImeiCorrectionAudit" ("id" UUID,"draftId" INTEGER,"actorUserId" INTEGER,"eventType" TEXT,"createdAt" TIMESTAMPTZ);
    CREATE TABLE "SolicitudNombreCorrectionAudit" ("id" UUID,"draftId" INTEGER,"actorUserId" INTEGER,"eventType" TEXT,"createdAt" TIMESTAMPTZ);
    INSERT INTO "Credito" VALUES
      (1,'000000-F-01','Cliente uno','001.000.001','03000000001','uno@test.invalid','INSCRITO','000123456789012','device-1','iPhone 15','Apple','iPhone','2026-10-01','2026-10-03',NULL,'{}'),
      (2,'000000-F-02','Cliente dos','002000002','03000000002','dos@test.invalid','FINALIZADO','000223456789012','device-2','Android','Android','Android','2026-10-01','2026-10-02',NULL,'{}'),
      (3,'000000-F-03','Importado','003000003','03000000003','tres@test.invalid','GENERADO','000323456789012','device-3','Android','Android','Android','2026-10-01','2026-10-02','IMPORTACION_MASIVA','{"origen":{"tipo":"IMPORTACION_MASIVA"}}');
    INSERT INTO "CreditSadminRegistration" VALUES (1,'00003001',TRUE),(2,'00003002',FALSE);
    INSERT INTO "CreditoBorrador" VALUES
      (51,'CERRADO','FINALIZADA',1,6,'Cliente uno','001000001','03000000001','000123456789012','IPHONE','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '15 days'),
      (52,'ABIERTO',NULL,NULL,3,'Cliente abierto','001000001','03000000004','000423456789012','IPHONE','{"clienteCorreo":"draft@test.invalid","referenciaEquipo":"iPhone pendiente"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '15 days'),
      (53,'CERRADO','DESISTIDA',NULL,3,'No permitido','001000001','03000000005','000523456789012','IPHONE','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+INTERVAL '15 days');`);
  const calls = [];
  const prisma = { $queryRawUnsafe: async (sql, ...values) => {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/);
    calls.push({ sql, values });
    return (await db.query(sql, values)).rows;
  } };
  return { db, prisma, calls };
}

test("SQL real: buscador limitado al set permitido, batch de identidad completa y ceros sin alterar el endpoint enmascarado", optionalPostgres, async () => {
  const { db, prisma, calls } = await fixture();
  try {
    heavyDetailReads = 0;
    const results = await reader.searchAnalystCenterCases("001000001", prisma);
    assert.deepEqual(plain(results.map(item => item.kind).sort()), ["CREDIT", "DRAFT"]);
    const credit = results.find(item => item.kind === "CREDIT");
    assert.equal(credit.document, "001000001");
    assert.equal(credit.phone, "03000000001");
    assert.equal(credit.email, "uno@test.invalid");
    assert.equal(credit.numeroSadmin, "00003001");
    assert.equal(credit.folio, "000000-F-01");
    assert.equal(credit.imei, "000123456789012");
    const draft = results.find(item => item.kind === "DRAFT");
    assert.equal(draft.id, 52);
    assert.equal(draft.numeroSadmin, null);
    assert.equal(draft.folio, null);
    assert.equal(draft.creditId, null);
    assert.equal(draft.email, "draft@test.invalid");
    assert.equal(draft.equipment, "iPhone pendiente");
    assert.equal(calls.length, 4, "Dos búsquedas existentes + máximo dos consultas batch; sin historial por cada resultado.");
    assert.equal(heavyDetailReads, 0);
    for (const q of ["00003001", "000000-F-01", "000123456789012"]) {
      assert.equal((await reader.searchAnalystCenterCases(q, prisma)).find(item => item.kind === "CREDIT").id, 1);
    }
    const noConfirmedSadmin = await reader.searchAnalystCenterCases("002000002", prisma);
    assert.equal(noConfirmedSadmin[0].numeroSadmin, null);
    assert.equal(noConfirmedSadmin[0].number, "000000-F-02");
    const masked = await operational.searchOperationalCases("001000001", prisma);
    assert.ok(masked.every(item => item.document.startsWith("•••• ") && item.phone === null && item.email === null && item.imei === ""));
    const before = calls.length;
    for (const q of ["ab", "a".repeat(101), "123\n456", null]) {
      await assert.rejects(reader.searchAnalystCenterCases(q, prisma), { code: "INVALID_SEARCH" });
    }
    assert.equal(calls.length, before);
    assert.equal((await reader.searchAnalystCenterCases("_%' OR 1=1 --", prisma)).length, 0);
  } finally { await db.close(); }
});

test("SQL real: bienvenida depende de cierre de creación y conserva capacidades reales, nunca del préstamo pagado", optionalPostgres, async () => {
  const { db, prisma } = await fixture();
  try {
    const original = selected;
    const closed = await reader.getAnalystCenterCase("CREDIT", 1, prisma);
    assert.equal(closed.welcome.creditFinalized, true, "INSCRITO con solicitud finalizada tiene creación cerrada.");
    assert.equal(closed.welcome.available, false);
    assert.match(closed.welcome.reason, /dentro de Aprobaciones/);
    assert.deepEqual(plain(closed.item.capabilities), original.capabilities);
    assert.equal(closed.item.numeroSadmin, "00003001");
    assert.equal(closed.item.folio, "000000-F-01");
    selected = { ...original, id: 2, status: "FINALIZADO" };
    assert.equal((await reader.getAnalystCenterCase("CREDIT", 2, prisma)).welcome.creditFinalized, false);
    selected = { ...original, id: 3, status: "GENERADO" };
    assert.equal((await reader.getAnalystCenterCase("CREDIT", 3, prisma)).welcome.creditFinalized, true, "Importación comprometida no requiere liquidación del préstamo.");
    selected = { ...original, kind: "DRAFT", id: 52 };
    const draft = await reader.getAnalystCenterCase("DRAFT", 52, prisma);
    assert.equal(draft.welcome.creditFinalized, false);
    assert.equal(draft.welcome.available, false);
    assert.match(draft.welcome.reason, /finalice la creación/);
    assert.equal(draft.item.numeroSadmin, null);
    selected = original;
  } finally { await db.close(); }
});

test("SQL real: gestiones propias unen resultados persistidos y paginan todas las fuentes con fechas UTC independientes de zona SQL", optionalPostgres, async () => {
  const { db, prisma, calls } = await fixture();
  try {
    await db.exec(`
      INSERT INTO "CreditApprovalEvent" SELECT ('10000000-0000-4000-8000-'||LPAD(value::text,12,'0'))::uuid,1,17,'USER','APPROVED','2026-10-03 19:00:00'::timestamp+value*INTERVAL '1 minute' FROM generate_series(1,21) AS value;
      INSERT INTO "CreditApprovalEvent" VALUES ('10000000-0000-4000-8000-000000000099',1,18,'USER','APPROVED','2026-10-04');
      INSERT INTO "CreditSadminEvent" VALUES
        ('20000000-0000-4000-8000-000000000001',1,17,'USER','{"field":"estadoCreacion","after":{"estadoCreacion":"ERROR_CREACION"}}','2026-10-03 19:00:00'),
        ('20000000-0000-4000-8000-000000000002',1,17,'USER','{}','2026-10-03 19:00:00');
      INSERT INTO "ApprovalOperationalAction" VALUES ('30000000-0000-4000-8000-000000000001','CREDIT',1,1,17,'SIGNATURE_REQUESTED','PREPARING','2026-10-03 19:00:00');
      INSERT INTO "ApprovalOperationalContractVersion" VALUES ('30000000-0000-4000-8000-000000000001',1,17,'AWAITING_SIGNATURE','2026-10-03 19:00:00');
      INSERT INTO "CreditApprovalNovelty" VALUES ('40000000-0000-4000-8000-000000000001',1);
      INSERT INTO "CreditApprovalNoveltyEvent" VALUES ('40000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001',17,'USER','ANALYST_VERIFIED','2026-10-03 19:00:00');
      INSERT INTO "CreditApprovalDataCorrection" VALUES ('50000000-0000-4000-8000-000000000001',1,17,'USER',3,'2026-10-03 19:00:00');
      INSERT INTO "CreditMoraManagementEvent" VALUES
        ('60000000-0000-4000-8000-000000000001',1,17,18,'LLAMADA','Promesa registrada','2026-10-03 14:00:00-05'),
        ('60000000-0000-4000-8000-000000000002',1,18,17,'LLAMADA','No es gestión propia','2026-10-03 14:00:00-05');
      INSERT INTO "CreditMoraExceptionEvent" VALUES ('70000000-0000-4000-8000-000000000001',1,17,'SUBMITTED','PENDING','2026-10-03 14:00:00-05');
      INSERT INTO "DataCreditoAssessment" VALUES ('80000000-0000-4000-8000-000000000001',NULL);
      INSERT INTO "DataCreditoAdminAccessAudit" VALUES
        ('80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000001',17,'OPS_TX06_RETRY_AUTHORIZED','AUTHORIZED','2026-10-03 19:00:00'),
        ('80000000-0000-4000-8000-000000000003','80000000-0000-4000-8000-000000000001',17,'VIEW_DOSSIER','SUCCESS','2026-10-03 19:00:00');
      INSERT INTO "SolicitudImeiCorrectionAudit" VALUES ('90000000-0000-4000-8000-000000000001',51,17,'CORRECTED','2026-10-03 14:00:00-05');
      INSERT INTO "SolicitudNombreCorrectionAudit" VALUES ('90000000-0000-4000-8000-000000000002',52,17,'REISSUED','2026-10-03 14:00:00-05');`);
    await db.exec(`
      INSERT INTO "CreditApprovalInitialSignature" VALUES
        ('31000000-0000-4000-8000-000000000001',1,17,'COMPLETED','2026-10-03 19:00:00'),
        ('31000000-0000-4000-8000-000000000002',1,18,'FAILED_SAFE','2026-10-03 19:00:00');
      INSERT INTO "CreditApprovalReissue" VALUES
        ('32000000-0000-4000-8000-000000000001',1,17,'USER','TECHNICAL_ERROR','2026-10-03 19:00:00'),
        ('32000000-0000-4000-8000-000000000002',1,18,'USER','FAILED_SAFE','2026-10-03 19:00:00'),
        ('32000000-0000-4000-8000-000000000003',1,17,'SHARED_LINK','UNCERTAIN','2026-10-03 19:00:00');
      INSERT INTO "FirmaSeguroDraftDispatch" VALUES
        ('33000000-0000-4000-8000-000000000001',52,17,'AWAITING_SIGNATURE','2026-10-03 19:00:00'),
        ('33000000-0000-4000-8000-000000000002',52,18,'UNCERTAIN','2026-10-03 19:00:00');
      INSERT INTO "CreditApprovalCallRecording" VALUES
        ('34000000-0000-4000-8000-000000000001',1,17,'USER','2026-10-03 19:00:00'),
        ('34000000-0000-4000-8000-000000000002',1,18,'USER','2026-10-03 19:00:00'),
        ('34000000-0000-4000-8000-000000000003',1,17,'SHARED_LINK','2026-10-03 19:00:00');
      INSERT INTO "CreditDeviceReplacement" VALUES ('35000000-0000-4000-8000-000000000001',1);
      INSERT INTO "CreditDeviceReplacementRemission" VALUES ('35000000-0000-4000-8000-000000000002','35000000-0000-4000-8000-000000000001');
      INSERT INTO "CreditDeviceReplacementRemissionEvent" VALUES
        ('35000000-0000-4000-8000-000000000003','35000000-0000-4000-8000-000000000002',17,'VERIFIED','2026-10-03 14:00:00-05'),
        ('35000000-0000-4000-8000-000000000004','35000000-0000-4000-8000-000000000002',18,'REJECTED','2026-10-03 14:00:00-05');
      INSERT INTO "CreditApprovalEvidenceRevision" VALUES
        ('36000000-0000-4000-8000-000000000001',1,17,'USER','cedula-frente','2026-10-03 19:00:00'),
        ('36000000-0000-4000-8000-000000000002',1,18,'USER','cedula-posterior','2026-10-03 19:00:00'),
        ('36000000-0000-4000-8000-000000000003',1,17,'SHARED_LINK','foto-entrega','2026-10-03 19:00:00');
      INSERT INTO "CreditMoraSupport" VALUES
        ('37000000-0000-4000-8000-000000000001',1,17,'2026-10-03 14:00:00-05'),
        ('37000000-0000-4000-8000-000000000002',1,18,'2026-10-03 14:00:00-05');
      INSERT INTO "ApprovalOperationalContractVersion" VALUES ('38000000-0000-4000-8000-000000000001',1,17,'AWAITING_SIGNATURE','2026-10-03 19:00:00');
      INSERT INTO "ApprovalOperationalAction" VALUES ('38000000-0000-4000-8000-000000000001','CREDIT',1,1,17,'IMEI_APPLIED','APPLIED_SIGNATURE_PENDING','2026-10-03 19:00:00');`);
    const all = await history.getAnalystCenterManagements(17, { pageSize: 100 }, prisma);
    assert.equal(all.total, 40);
    assert.equal(all.items.length, 40);
    assert.ok(all.items.every(item => item.at.startsWith("2026-10-03T19:")));
    assert.ok(!all.items.some(item => item.result === "No es gestión propia" || item.result === "SUCCESS"));
    assert.equal(all.items.find(item => item.id.startsWith("firma:")).result, "AWAITING_SIGNATURE");
    assert.equal(all.items.find(item => item.id.startsWith("firma-inicial:")).result, "COMPLETED");
    assert.equal(all.items.find(item => item.id.startsWith("firma-aprobacion:")).result, "TECHNICAL_ERROR");
    assert.equal(all.items.filter(item => item.source === "FIRMA").length, 5);
    const draftSignature = all.items.find(item => item.id.startsWith("firma-solicitud:"));
    assert.equal(draftSignature.kind, "DRAFT");
    assert.equal(draftSignature.targetId, 52);
    assert.equal(draftSignature.result, "AWAITING_SIGNATURE");
    assert.equal(all.items.filter(item => item.source === "GRABACION").length, 1);
    assert.equal(all.items.find(item => item.source === "GRABACION").result, null,
      "La grabación no guarda outcome: persistir el archivo no autoriza a inventar éxito.");
    assert.equal(all.items.filter(item => item.source === "REMISION_GARANTIA").length, 1);
    assert.equal(all.items.find(item => item.source === "REMISION_GARANTIA").result, "VERIFIED");
    const evidence = all.items.filter(item => item.id.startsWith("evidencia:"));
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].action, "Corrección de evidencia · Cédula frontal");
    assert.equal(evidence[0].result, null);
    const support = all.items.filter(item => item.id.startsWith("soporte-mora:"));
    assert.equal(support.length, 1);
    assert.equal(support[0].action, "Carga de soporte de mora");
    assert.equal(support[0].result, null);
    assert.ok(!all.items.some(item => item.result === "FAILED_SAFE" || item.result === "UNCERTAIN"), "Otros actores y shared se excluyen de ambos ledgers.");
    assert.equal(all.items.filter(item => item.source === "OPERATIVO").length, 1,
      "SIGNATURE_REQUESTED no se duplica; IMEI_APPLIED es otra acción real y se conserva.");
    assert.equal(all.items.find(item => item.source === "OPERATIVO").result, "APPLIED_SIGNATURE_PENDING");
    assert.equal(all.items.find(item => item.source === "MORA" && item.result !== null).result, "Promesa registrada");
    const sadmin = all.items.filter(item => item.source === "SADMIN");
    assert.ok(sadmin.some(item => item.result === "ERROR_CREACION"));
    assert.ok(sadmin.some(item => item.result === null), "Sin outcome almacenado no se inventa uno.");
    const release = all.items.find(item => item.source === "DATACREDITO_LIBERACION");
    assert.equal(release.kind, "ASSESSMENT");
    assert.equal(release.targetId, "80000000-0000-4000-8000-000000000001");
    assert.equal(release.creditId, null);
    assert.equal(release.creditNumber, null);
    assert.equal(release.result, "AUTHORIZED");
    assert.equal(all.items.find(item => item.source === "IMEI_SOLICITUD").creditNumber, "00003001");
    assert.equal(all.items.find(item => item.source === "NOMBRE_SOLICITUD").creditNumber, "SOL-000052");
    const paged = [];
    for (let page = 1; page <= 4; page++) {
      const result = await history.getAnalystCenterManagements(17, { page, pageSize: 10 }, prisma);
      assert.equal(result.total, 40);
      assert.equal(result.totalPages, 4);
      assert.equal(result.items.length, 10);
      paged.push(...result.items.map(item => item.id));
    }
    assert.deepEqual(paged, all.items.map(item => item.id));
    const emptyPage = await history.getAnalystCenterManagements(17, { page: 99, pageSize: 10 }, prisma);
    assert.equal(emptyPage.total, 40);
    assert.equal(emptyPage.items.length, 0);
    for (const call of calls.filter(call => call.sql.startsWith("WITH history"))) {
      assert.equal(call.values[0], 17);
      assert.match(call.sql, /COUNT\(\*\).*FROM enriched/);
      assert.doesNotMatch(call.sql, /evidenceData|signedDocumentBase64|requestPayload|providerPayload|previousDataUrl|bytes|comment|phone/);
    }
    await db.exec('DROP TABLE "SolicitudNombreCorrectionAudit"');
    assert.equal((await history.getAnalystCenterManagements(17, { pageSize: 100 }, prisma)).total, 39);
    await db.exec('DROP TABLE "CreditApprovalInitialSignature"; DROP TABLE "CreditApprovalReissue"');
    assert.equal((await history.getAnalystCenterManagements(17, { pageSize: 100 }, prisma)).total, 37,
      "Ledgers opcionales ausentes no bloquean los módulos históricos existentes.");
    await db.exec('DROP TABLE "CreditSadminEvent"');
    await assert.rejects(history.getAnalystCenterManagements(17, {}, prisma), { code: "HISTORY_UNAVAILABLE" });
  } finally { await db.close(); }
});
