import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import ts from "typescript";

function load(file, dependencies = {}) {
  const loaded = { exports: {} };
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, Date, URL, Buffer,
    require(name) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; },
  }, { filename: file });
  return loaded.exports;
}
const dataCore = load("lib/approval-request-correction-core.ts", {
  "./credit-client-name": load("lib/credit-client-name.ts"),
  "./credit-contact-phones": load("lib/credit-contact-phones.ts"),
});
const core = load("lib/approval-request-evidence-correction-core.ts", {
  "node:crypto": { createHash }, "./approval-request-correction-core": dataCore,
});
const decoder = load("lib/iphone-delivery-evidence.ts", { sharp: { default: sharp } });
const statuses = load("lib/firmaseguro-status.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const actor = { id: 23, nombre: "Analista de prueba" };
async function image(color = "red", width = 10) {
  const buffer = await sharp({ create: { width, height: 10, channels: 3, background: color } }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
const firstImage = await image();
const secondImage = await image("green");
function correction(key = "foto-remision", old = "", revision = 0, dataUrl = secondImage) {
  return core.parseRequestEvidenceCorrection({ key, dataUrl, expectedSha256: core.requestEvidenceHash(old),
    expectedRevision: revision, reason: "Evidencia nueva revisada con el cliente" });
}

test("el contrato firmado y los campos financieros nunca son una evidencia editable", () => {
  for (const key of ["documento-firmado", "contratoFirmaDataUrl", "valorCuota", "__proto__"])
    assert.throws(() => correction(key), { code: "INVALID_EVIDENCE" });
  assert.throws(() => core.parseRequestEvidenceCorrection({ ...correction(), creditoId: 42 }), { code: "INVALID_EVIDENCE" });
});
test("baseline, revisión, tamaño y motivo se validan antes de procesar el archivo", () => {
  for (const [changes, code] of [
    [{ expectedSha256: "vieja" }, "INVALID_BASELINE"], [{ expectedRevision: -1 }, "INVALID_REVISION"],
    [{ dataUrl: "x".repeat(2_500_001) }, "INVALID_FILE"], [{ reason: "x" }, "INVALID_REASON"],
  ]) assert.throws(() => core.parseRequestEvidenceCorrection({ ...correction(), ...changes }), { code });
});
test("el decoder rechaza PDF, HTML, MIME falso, archivo truncado y exceso de dimensiones", async () => {
  assert.equal(await decoder.sanitizeIphoneDeliveryEvidenceDataUrl(firstImage), firstImage);
  for (const raw of ["data:application/pdf;base64,JVBERi0=", "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/png;base64,JVBERi0=", firstImage.slice(0, -12), await image("red", 6001)])
    assert.equal(await decoder.sanitizeIphoneDeliveryEvidenceDataUrl(raw), "");
});
test("autoguardado antiguo conserva la foto corregida y trabajo ajeno sin transportar fotos en metadata", () => {
  const initial = { fotoRemisionDataUrl: firstImage, valorEquipoTotal: "4000000", imei: "350000000000001" };
  const changed = core.applyRequestEvidenceCorrection(initial, correction("foto-remision", firstImage), ["foto-remision"], actor.nombre);
  const saved = core.preserveAnalystEvidenceCorrectionAutosave(changed.payload, {
    ...initial, fotoEntregaDataUrl: "otro-trabajo-del-asesor", valorEquipoTotal: "4200000",
    analystEvidenceRevision: 0, analystEvidenceCorrection: { revision: 999, values: { bad: true } },
  });
  assert.equal(saved.fotoRemisionDataUrl, secondImage);
  assert.equal(saved.fotoEntregaDataUrl, "otro-trabajo-del-asesor");
  assert.equal(saved.valorEquipoTotal, "4200000");
  assert.equal(saved.analystEvidenceRevision, 1);
  assert.ok(!JSON.stringify(saved.analystEvidenceCorrection).includes("data:image"));
  const acknowledged = core.preserveAnalystEvidenceCorrectionAutosave(changed.payload,
    { ...changed.payload, fotoRemisionDataUrl: firstImage });
  assert.equal(acknowledged.fotoRemisionDataUrl, firstImage);
  const withoutRevision = core.preserveAnalystEvidenceCorrectionAutosave({}, { analystEvidenceRevision: 99, analystEvidenceCorrection: {} });
  assert.deepEqual(plain(withoutRevision), {});
});
test("metadata acumula las fotos corregidas por campo y no revive evidencias invalidadas", () => {
  const one = core.applyRequestEvidenceCorrection({}, correction(), ["foto-remision"], actor.nombre);
  const two = core.applyRequestEvidenceCorrection(one.payload,
    correction("cedula-frente", "", 1), ["cedula-frente"], actor.nombre);
  assert.equal(two.payload.analystEvidenceCorrection.fieldRevisions.fotoRemisionDataUrl, 1);
  assert.equal(two.payload.analystEvidenceCorrection.fieldRevisions.contratoCedulaFrenteDataUrl, 2);
  assert.equal(two.payload.cedulaFrenteDataUrl, secondImage);
  const invalidated = { ...two.payload };
  delete invalidated.contratoCedulaFrenteDataUrl;
  delete invalidated.cedulaFrenteDataUrl;
  const preserved = core.preserveAnalystEvidenceCorrectionAutosave(invalidated, two.payload);
  // An acknowledged seller may attach fresh evidence; a stale seller cannot restore removed evidence.
  const stale = core.preserveAnalystEvidenceCorrectionAutosave(invalidated, { ...two.payload, analystEvidenceRevision: 1 });
  assert.ok(!("contratoCedulaFrenteDataUrl" in stale));
  assert.equal(preserved.contratoCedulaFrenteDataUrl, secondImage);
});
test("los controles del expediente no cambian validaciones ni habilitan envío en curso", () => {
  const baseline = { open: true, expired: false, identityStarted: false,
    signatureStarted: false, signatureCompleted: false, dispatchPending: false, correctionPending: false };
  const editable = (input) => core.requestEvidenceEligibility({ ...baseline, ...input }).documents.filter((doc) => doc.editable).map((doc) => doc.key);
  assert.equal(editable({}).length, 5);
  assert.deepEqual(plain(editable({ identityStarted: true })), ["foto-entrega", "foto-remision"]);
  assert.deepEqual(plain(editable({ signatureStarted: true })), []);
  assert.equal(editable({ identityStarted: true, signatureStarted: true, signatureCompleted: true }).length, 5);
  for (const restriction of [{ open: false }, { expired: true }, { dispatchPending: true }, { correctionPending: true }])
    assert.deepEqual(plain(editable(restriction)), []);
});

test("API: solo analista nominal, cuerpo acotado y respuesta privada sin bytes", async (t) => {
  let analyst = actor;
  let shared;
  let readCount = 0;
  let writeCount = 0;
  let maximum;
  const route = load("app/api/aprobaciones/solicitudes/[id]/evidencias/route.ts", {
    "next/server": { NextResponse: { json: (value, options = {}) => ({ value, status: options.status ?? 200, headers: options.headers }) } },
    "@/lib/auth": { getNominalApprovalAnalystSessionUser: async () => analyst },
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/credit-approval-http": { approvalErrorResponse: () => ({ status: 503 }),
      readApprovalRequest: async (_request, options) => { maximum = options.maxBytes; return correction(); } },
    "@/lib/approval-request-correction-core": dataCore,
    "@/lib/approval-request-correction": { parseCorrectionDraftId: (value) => {
      if (!/^D-[1-9]\d*$/.test(value)) throw new dataCore.RequestDataCorrectionError("REQUEST_NOT_FOUND", "Solicitud no disponible", 404);
      return Number(value.slice(2));
    } },
    "@/lib/approval-request-evidence-correction-core": core,
    "@/lib/approval-request-evidence-correction": {
      getAnalystRequestEvidence: async () => { readCount++; return { revision: 0, documents: [{ key: "foto-remision", available: false, sha256: null }] }; },
      correctAnalystRequestEvidence: async (_id, input, who) => { writeCount++; assert.equal(who.id, actor.id); assert.equal(input.key, "foto-remision"); return { revision: 1 }; },
    },
  });
  const context = { params: Promise.resolve({ id: "D-1" }) };
  await t.test("GET no traslada fotos y no permite caché compartido", async () => {
    const result = await route.GET({}, context);
    assert.equal(result.status, 200);
    assert.match(result.headers["Cache-Control"], /private.*no-store/);
    assert.equal(result.headers.Vary, "Cookie");
    assert.ok(!JSON.stringify(result.value).includes("data:image"));
  });
  await t.test("PATCH limita a una foto y conserva actor nominal", async () => {
    assert.equal((await route.PATCH({}, context)).status, 200);
    assert.equal(maximum, 2_600_000);
    assert.equal(writeCount, 1);
  });
  await t.test("sin sesión nominal o con cookie compartida no llega al servicio", async () => {
    const reads = readCount;
    const writes = writeCount;
    analyst = null;
    assert.equal((await route.GET({}, context)).status, 401);
    assert.equal((await route.PATCH({}, context)).status, 401);
    analyst = actor;
    for (const session of [null, { kind: "shared" }]) {
      shared = session;
      assert.equal((await route.PATCH({}, context)).status, 401);
    }
    shared = undefined;
    assert.equal(readCount, reads);
    assert.equal(writeCount, writes);
  });
  await t.test("el endpoint DRAFT no acepta un crédito materializado C-id", async () => {
    assert.equal((await route.GET({}, { params: Promise.resolve({ id: "C-1" }) })).status, 404);
    assert.equal((await route.PATCH({}, { params: Promise.resolve({ id: "C-1" }) })).status, 404);
  });
});

test("SQL real: reemplazo, historial y restricciones atómicos", async (t) => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE "CreditoBorrador" (
    "id" INTEGER PRIMARY KEY,"estado" TEXT NOT NULL,"creditoId" INTEGER,"payload" JSONB NOT NULL,
    "imei" TEXT,"currentStep" INTEGER,"createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"expiresAt" TIMESTAMPTZ);
    CREATE TABLE "FirmaSeguroProcess" ("id" SERIAL PRIMARY KEY,"draftId" INTEGER,"processUuid" TEXT,
      "status" TEXT,"completedAt" TIMESTAMPTZ,"signedDocumentBase64" TEXT,"supersededAt" TIMESTAMPTZ);
    CREATE TABLE "VeriffIdentityValidation" ("id" SERIAL PRIMARY KEY,"draftId" INTEGER,"status" TEXT);
    CREATE TABLE "FirmaSeguroDraftDispatch" ("id" SERIAL PRIMARY KEY,"draftId" INTEGER,"status" TEXT);
    CREATE TABLE "SolicitudImeiCorrectionAudit" ("draftId" INTEGER,"eventType" TEXT,"archivedEvidence" JSONB);
    CREATE TABLE "ApprovalOperationalAction" ("id" UUID PRIMARY KEY,"targetKind" TEXT,"targetId" INTEGER,
      "eventType" TEXT,"actorUserId" INTEGER,"actorName" TEXT,"reason" TEXT,"evidenceMime" TEXT,"evidenceName" TEXT,
      "evidenceData" BYTEA,"evidenceSha256" TEXT,"beforeContact" JSONB,"afterContact" JSONB,"status" TEXT);
  `);
  const trace = [];
  const adapter = (db) => ({
    $queryRawUnsafe: async (sql, ...values) => { trace.push(sql); return (await db.query(sql, values)).rows; },
    $executeRawUnsafe: async (sql, ...values) => { trace.push(sql); return (await db.query(sql, values)).affectedRows; },
  });
  const service = load("lib/approval-request-evidence-correction.ts", {
    "server-only": {}, "node:crypto": { randomUUID },
    "@/lib/prisma": { default: { $transaction: (callback) => pg.transaction((db) => callback(adapter(db))) } },
    "@/lib/approval-operations-schema": { ensureApprovalOperationalSchema: async () => {} },
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: async () => {},
      lockSolicitudOperationMutation: async () => trace.push("operation-lock") },
    "@/lib/solicitudes-storage": { ensureSolicitudSchema: async () => {} },
    "@/lib/veriff-storage": { ensureVeriffSchema: async () => {}, lockVeriffDraftAttempts: async () => trace.push("identity-lock") },
    "@/lib/firmaseguro-status": statuses, "@/lib/iphone-delivery-evidence": decoder,
    "@/lib/approval-request-correction-core": dataCore, "@/lib/approval-request-evidence-correction-core": core,
  });
  let nextId = 0;
  async function seed(extra = {}) {
    const id = ++nextId;
    await pg.query(`INSERT INTO "CreditoBorrador" ("id","estado","imei","currentStep","expiresAt","payload")
      VALUES ($1,'ABIERTO','350000000000001',2,'2300-01-01',$2::jsonb)`, [id, JSON.stringify({
      clienteDocumento: "100000001", clienteTelefono: "3000000000", valorEquipoTotal: "4000000",
      cuotaInicial: "1200000", plazoMeses: "40", fotoRemisionDataUrl: firstImage, ...extra,
    })]);
    return id;
  }
  async function row(id) { return (await pg.query('SELECT * FROM "CreditoBorrador" WHERE "id"=$1', [id])).rows[0]; }
  async function failure(id, input, code) {
    const before = plain(await row(id));
    await assert.rejects(service.correctAnalystRequestEvidence(id, input, actor), { code });
    assert.deepEqual(plain(await row(id)), before);
    assert.equal((await pg.query('SELECT "id" FROM "ApprovalOperationalAction" WHERE "targetId"=$1', [id])).rows.length, 0);
  }
  await t.test("guarda evidencia y archiva bytes reales anteriores con actor/motivo/hash sin cambios financieros", async () => {
    const id = await seed();
    const before = await row(id);
    trace.length = 0;
    const result = await service.correctAnalystRequestEvidence(id, correction("foto-remision", firstImage), actor);
    assert.deepEqual(trace.slice(0, 2), ["operation-lock", "identity-lock"]);
    const saved = await row(id);
    assert.equal(saved.payload.fotoRemisionDataUrl, secondImage);
    assert.equal(saved.payload.fotoRemisionSource, "CORRECCION_ANALISTA_SOLICITUD");
    assert.equal(saved.payload.analystEvidenceRevision, 1);
    for (const field of ["estado", "creditoId", "imei", "currentStep"]) assert.equal(saved[field], before[field]);
    for (const field of ["clienteDocumento", "clienteTelefono", "valorEquipoTotal", "cuotaInicial", "plazoMeses"])
      assert.equal(saved.payload[field], before.payload[field]);
    const audit = (await pg.query('SELECT * FROM "ApprovalOperationalAction" WHERE "targetId"=$1', [id])).rows[0];
    assert.equal(audit.status, "EVIDENCE_CORRECTED");
    assert.equal(audit.actorName, actor.nombre);
    assert.equal(audit.reason, correction().reason);
    assert.equal(audit.evidenceSha256, core.requestEvidenceHash(firstImage));
    assert.deepEqual(Buffer.from(audit.evidenceData), Buffer.from(firstImage.split(",")[1], "base64"));
    assert.equal(audit.beforeContact.sha256, core.requestEvidenceHash(firstImage));
    assert.equal(audit.afterContact.sha256, core.requestEvidenceHash(secondImage));
    assert.ok(!JSON.stringify(result).includes("data:image"));
  });
  await t.test("resuelve aliases históricos y agrega foto sin firma ni aprobación artificial", async () => {
    const id = await seed({ cedulaFrenteDataUrl: firstImage });
    const result = await service.getAnalystRequestEvidence(id);
    assert.equal(result.documents.find((doc) => doc.key === "cedula-frente").sha256, core.requestEvidenceHash(firstImage));
    await service.correctAnalystRequestEvidence(id, correction("cedula-frente", firstImage), actor);
    const saved = await row(id);
    assert.equal(saved.payload.contratoCedulaFrenteDataUrl, secondImage);
    assert.equal(saved.payload.cedulaFrenteDataUrl, secondImage);
    assert.equal((await pg.query('SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1', [id])).rows.length, 0);
    assert.equal(saved.payload.firmaSeguroSigned, undefined);
  });
  await t.test("conflicto asesor o revisión de otro analista no modifica nada", async () => {
    await failure(await seed(), correction("foto-remision", ""), "REQUEST_CHANGED");
    await failure(await seed(), correction("foto-remision", firstImage, 1), "REQUEST_CHANGED");
    await failure(await seed(), correction("foto-remision", firstImage, 0, firstImage), "NO_CHANGES");
  });
  await t.test("Veriff ya iniciado conserva identidad y permite foto de remisión ajena a esa validación", async () => {
    const id = await seed({ contratoCedulaFrenteDataUrl: firstImage });
    await pg.query('INSERT INTO "VeriffIdentityValidation" ("draftId","status") VALUES ($1,\'APPROVED\')', [id]);
    await failure(id, correction("cedula-frente", firstImage), "EVIDENCE_LOCKED");
    await service.correctAnalystRequestEvidence(id, correction("foto-remision", firstImage), actor);
    assert.equal((await pg.query('SELECT "status" FROM "VeriffIdentityValidation" WHERE "draftId"=$1', [id])).rows[0].status, "APPROVED");
  });
  await t.test("envío reservado, firma pendiente o corrección central bloquean todos los reemplazos", async () => {
    const dispatched = await seed();
    await pg.query('INSERT INTO "FirmaSeguroDraftDispatch" ("draftId","status") VALUES ($1,\'DISPATCHING\')', [dispatched]);
    await failure(dispatched, correction("foto-remision", firstImage), "EVIDENCE_LOCKED");
    const signature = await seed();
    await pg.query('INSERT INTO "FirmaSeguroProcess" ("draftId","status") VALUES ($1,\'PENDING\')', [signature]);
    await failure(signature, correction("foto-remision", firstImage), "EVIDENCE_LOCKED");
    await failure(await seed({ firmaSeguroFinancialCorrectionPending: true }), correction("foto-remision", firstImage), "EVIDENCE_LOCKED");
  });
  await t.test("firma real completada permite corregir copia de evidencia sin cambiar el PDF/provider", async () => {
    const id = await seed({ contratoCedulaFrenteDataUrl: firstImage });
    await pg.query(`INSERT INTO "FirmaSeguroProcess" ("draftId","status","completedAt","signedDocumentBase64","processUuid")
      VALUES ($1,'COMPLETED',CURRENT_TIMESTAMP,'JVBERi0prueba','firma-original')`, [id]);
    const signature = plain((await pg.query('SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1', [id])).rows[0]);
    await service.correctAnalystRequestEvidence(id, correction("cedula-frente", firstImage), actor);
    assert.deepEqual(plain((await pg.query('SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1', [id])).rows[0]), signature);
  });
  await t.test("la foto archivada del IMEI anterior no puede reaparecer luego de nueva firma", async () => {
    const id = await seed({ firmaSeguroReissueProcessUuid: "firma-nueva" });
    await pg.query(`INSERT INTO "FirmaSeguroProcess" ("draftId","status","completedAt","signedDocumentBase64","processUuid")
      VALUES ($1,'COMPLETED',CURRENT_TIMESTAMP,'JVBERi0prueba','firma-nueva')`, [id]);
    await pg.query('INSERT INTO "SolicitudImeiCorrectionAudit" VALUES ($1,\'CORRECTED\',$2::jsonb)',
      [id, JSON.stringify({ fields: { fotoRemisionDataUrl: secondImage } })]);
    await failure(id, correction("foto-remision", firstImage), "STALE_IMEI_EVIDENCE");
  });
  await t.test("rechaza vencida, convertida, cerrada, actor inválido y decoder falso sin mutaciones", async () => {
    const expired = await seed();
    await pg.query('UPDATE "CreditoBorrador" SET "expiresAt"=\'2000-01-01\' WHERE "id"=$1', [expired]);
    await failure(expired, correction("foto-remision", firstImage), "EVIDENCE_LOCKED");
    const converted = await seed();
    await pg.query('UPDATE "CreditoBorrador" SET "creditoId"=5 WHERE "id"=$1', [converted]);
    await failure(converted, correction("foto-remision", firstImage), "EVIDENCE_LOCKED");
    const closed = await seed();
    await pg.query('UPDATE "CreditoBorrador" SET "estado"=\'DESISTIDA\' WHERE "id"=$1', [closed]);
    await failure(closed, correction("foto-remision", firstImage), "EVIDENCE_LOCKED");
    await failure(await seed(), correction("foto-remision", firstImage, 0, "data:image/png;base64,JVBERi0="), "INVALID_FILE");
    await assert.rejects(service.correctAnalystRequestEvidence(await seed(), correction(), { id: 0, nombre: "" }), { code: "UNAUTHORIZED" });
  });
});
