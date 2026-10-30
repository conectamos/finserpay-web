import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../lib/datacredito/admin-rejection-storage.ts", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../app/api/creditos/datacredito/admin/evaluaciones/[id]/rechazo-administrativo/route.ts", import.meta.url), "utf8");
const assessmentId = "11111111-1111-4111-8111-111111111111";
const documentNumber = "0001234567";
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
async function fixture(options = {}) {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Rol"("id" int,"nombre" text);
    CREATE TABLE "Aliado"("id" int,"codigo" text,"activo" boolean);
    CREATE TABLE "Sede"("id" int,"aliadoId" int,"activa" boolean);
    CREATE TABLE "Usuario"("id" int,"rolId" int,"sedeId" int,"activo" boolean);
    CREATE TABLE "DataCreditoAssessment"("id" uuid PRIMARY KEY,"documentHash" text,"surnameHash" text,"providerEnvironment" text,"platform" text,
      "status" text,"errorCode" text,"providerStatus" text,"transactionCode" text,"score" int,"decision" text,"offer" jsonb,"durationMs" int,
      "reusedFromAssessmentId" uuid,"consumedAt" timestamptz,"creditId" int,"claimTokenHash" text,"claimExpiresAt" timestamptz,
      "userId" int,"sellerId" int,"sedeId" int,"aliadoId" int,"correlationId" uuid,
      "expiresAt" timestamptz DEFAULT NOW()+INTERVAL '10 days',"retainedUntil" timestamptz DEFAULT NOW()+INTERVAL '20 days');
    CREATE TABLE "DataCreditoAssessmentSecurePayload"("assessmentId" uuid,"ciphertext" bytea);
    CREATE TABLE "DataCreditoAdminAccessAudit"("id" uuid PRIMARY KEY,"assessmentId" uuid,"actorUserId" int,"action" text,"outcome" text,
      "requestCorrelationId" uuid,"ipHash" text,"userAgentHash" text,"createdAt" timestamptz,"retainedUntil" timestamptz,"metadata" jsonb);
    CREATE TABLE "CreditoBorrador"("id" int PRIMARY KEY,"estado" text DEFAULT 'ABIERTO',"closedReason" text,"closedAt" timestamptz,
      "currentStep" int DEFAULT 1,"creditoId" int,"usuarioId" int,"vendedorId" int,"sedeId" int,"clienteDocumento" text,"imei" text,
      "plataforma" text,"dataCreditoAssessmentId" uuid,"dataCreditoStatus" text,"dataCreditoErrorCode" text,"creditRiskExceptionId" uuid,
      "payload" jsonb DEFAULT '{}',"expiresAt" timestamptz DEFAULT NOW()+INTERVAL '10 days',"createdAt" timestamptz DEFAULT NOW(),"updatedAt" timestamptz DEFAULT NOW());
    CREATE TABLE "CreditRiskException"("assessmentId" uuid,"solicitudId" int);
    CREATE TABLE "FirmaSeguroProcess"("draftId" int);
    CREATE TABLE "VeriffIdentityValidation"("draftId" int);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'USUARIO');
    INSERT INTO "Aliado" VALUES(1,'FINSERPAY',TRUE),(2,'ALIADO',TRUE);
    INSERT INTO "Sede" VALUES(1,1,TRUE),(2,2,TRUE);
    INSERT INTO "Usuario" VALUES(1,1,1,TRUE),(2,2,2,TRUE),(3,1,2,TRUE);
    INSERT INTO "DataCreditoAssessment"("id","documentHash","surnameHash","providerEnvironment","platform","status","errorCode","providerStatus","transactionCode","durationMs","userId","sedeId","aliadoId","correlationId")
      VALUES('${assessmentId}','document:${documentNumber}','surname:PRUEBA','production','IPHONE','NO_EVALUADO','NO_EVALUABLE_INFORMATION','ACCEPTED','07',300,2,2,2,'${randomUUID()}');
    INSERT INTO "DataCreditoAssessmentSecurePayload" VALUES('${assessmentId}',decode('010203','hex'));
    INSERT INTO "CreditoBorrador"("id","usuarioId","sedeId","clienteDocumento","plataforma","dataCreditoAssessmentId","dataCreditoStatus","dataCreditoErrorCode")
      VALUES(4340,2,2,'${documentNumber}','IPHONE','${assessmentId}','NO_EVALUADO','NO_EVALUABLE_INFORMATION');
    INSERT INTO "CreditoBorrador"("id","usuarioId","sedeId","clienteDocumento") VALUES(4344,2,2,'${documentNumber}');
  `);
  const saved = { documentNumber, firstSurname: "PRUEBA", providerPayload: { status: "ACCEPTED", content: {
    infoTransaccion: { codigosRespuesta: [{ clave: "TX", valor: "07" }, { clave: "HC", valor: "09" }] }, respuesta: { informacionRiesgo: null } } } };
  const calls = []; let failClosure = false; let tail = Promise.resolve();
  const db = {
    $queryRawUnsafe: async (sql, ...args) => { calls.push(sql); if (failClosure && sql.includes('UPDATE "CreditoBorrador"')) return []; return (await pg.query(sql, args)).rows; },
    $executeRawUnsafe: async (sql, ...args) => { calls.push(sql); return (await pg.query(sql, args)).affectedRows; },
    $transaction: callback => { const task = tail.then(async () => { await pg.exec('BEGIN'); try { const value = await callback(db); await pg.exec('COMMIT'); return value; } catch (error) { await pg.exec('ROLLBACK'); throw error; } }); tail = task.catch(() => {}); return task; },
  };
  const loaded = { exports: {} };
  runInNewContext(compile(source), { module: loaded, exports: loaded.exports, require: name => {
    if (name === 'server-only') return {};
    if (name === '@/lib/prisma') return { default: db };
    if (name === '@/lib/firmaseguro-storage') return { lockSolicitudOperationMutation: async (tx,id) => tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(177,$1::integer)',id) };
    if (name === '@/lib/solicitudes-storage') return { ensureSolicitudSchema: async () => {} };
    if (name === './storage') return { ensureDataCreditoSchema: async () => {
      calls.push("ENSURE_DATACREDITO_SCHEMA");
      if (options.schemaFailure) throw new Error("SCHEMA_NOT_READY");
    }, buildDataCreditoIdentityHashes: ({documentNumber,firstSurname}) => ({ documentHash: `document:${documentNumber}`, surnameHash: `surname:${firstSurname}` }) };
    if (name === './secure-record') return { decryptDataCreditoSecureRecord: () => saved };
    return require(name);
  }, Date, Number, String, Array, Object, JSON, Buffer, Error, RegExp, console });
  const input = { assessmentId, solicitudId: 4340, documentNumber, providerEnvironment: 'production', actorUserId: 1,
    reason: 'Sin información evaluable tras revisión administrativa', reviewed: true, confirmed: true, mutationId: randomUUID() };
  const rows = table => pg.query(`SELECT * FROM "${table}" ORDER BY 1`).then(r=>r.rows);
  return { pg, db, saved, calls, input, operations: loaded.exports, rows, failClosure: () => { failClosure = true; } };
}

test('lectores verifican esquema antes de consultar y reutilizan la precondición de una transacción', async () => {
  const f = await fixture({ schemaFailure: true });
  try {
    for (const operation of [
      () => f.operations.getDataCreditoAdministrativeRejection({ assessmentId }),
      () => f.operations.findRecentDataCreditoAdministrativeRejection({ documentHash: `document:${documentNumber}`, providerEnvironment: 'production' }),
      () => f.operations.getDataCreditoAdministrativeRejectionCandidate(f.input),
    ]) {
      f.calls.length = 0;
      await assert.rejects(operation(), /SCHEMA_NOT_READY/);
      assert.deepEqual(f.calls, ['ENSURE_DATACREDITO_SCHEMA']);
    }
    const transaction = { $queryRawUnsafe: f.db.$queryRawUnsafe, $executeRawUnsafe: f.db.$executeRawUnsafe };
    f.calls.length = 0;
    assert.equal(await f.operations.getDataCreditoAdministrativeRejection({ assessmentId }, transaction), null);
    assert.equal(await f.operations.findRecentDataCreditoAdministrativeRejection({ documentHash: `document:${documentNumber}`, providerEnvironment: 'production' }, transaction), null);
    assert.equal(f.calls.includes('ENSURE_DATACREDITO_SCHEMA'), false);
    assert.equal(f.calls.length, 2);
  } finally { await f.pg.close(); }
});

test('preflight exige metadata presente y no nula antes de acceder a decisiones administrativas', async () => {
  const storage = readFileSync(new URL('../lib/datacredito/storage.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('storage.ts', storage, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(node =>
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast).startsWith('REQUIRED_'))) ||
    (ts.isFunctionDeclaration(node) && ['schemaNotReady', 'verifyDataCreditoSchema'].includes(node.name?.text)));
  const exportCode = '\nexport { verifyDataCreditoSchema, REQUIRED_POLICY_COLUMNS, REQUIRED_ASSESSMENT_COLUMNS, REQUIRED_SECURE_PAYLOAD_COLUMNS, REQUIRED_ADMIN_AUDIT_COLUMNS };';
  for (const metadataState of ['missing', 'nullable', 'ready']) {
    let columns = [];
    let reachedConstraintChecks = false;
    class SchemaError extends Error { constructor(message, code) { super(message); this.code = code; } }
    const loaded = { exports: {} };
    runInNewContext(compile(declarations.map(node => node.getText(ast)).join('\n') + exportCode), {
      module: loaded, exports: loaded.exports,
      DataCreditoStorageConfigurationError: SchemaError,
      verifyDataCreditoPolicyProfileSchema: async () => {}, verifyDataCreditoDailyQuotaSchema: async () => {},
      prisma: { $queryRawUnsafe: async sql => {
        if (sql.includes('FROM pg_attribute')) return columns;
        if (sql.includes('AS "adminAuditTable"')) return [{
          policyTable: 'DataCreditoPolicy', assessmentTable: 'DataCreditoAssessment', securePayloadTable: 'DataCreditoAssessmentSecurePayload', adminAuditTable: 'DataCreditoAdminAccessAudit',
          policyHasPrimaryKey: true, assessmentHasPrimaryKey: true, securePayloadHasPrimaryKey: true, adminAuditHasPrimaryKey: true,
        }];
        reachedConstraintChecks = true;
        throw new Error('COLUMN_VERIFICATION_PASSED');
      } },
    });
    for (const [tableName, key] of [
      ['DataCreditoPolicy', 'REQUIRED_POLICY_COLUMNS'], ['DataCreditoAssessment', 'REQUIRED_ASSESSMENT_COLUMNS'],
      ['DataCreditoAssessmentSecurePayload', 'REQUIRED_SECURE_PAYLOAD_COLUMNS'], ['DataCreditoAdminAccessAudit', 'REQUIRED_ADMIN_AUDIT_COLUMNS'],
    ]) columns.push(...Array.from(loaded.exports[key], columnName => ({ tableName, columnName, isNotNull: true })));
    const metadata = column => column.tableName === 'DataCreditoAdminAccessAudit' && column.columnName === 'metadata';
    if (metadataState === 'missing') columns = columns.filter(column => !metadata(column));
    if (metadataState === 'nullable') columns = columns.map(column => metadata(column) ? { ...column, isNotNull: false } : column);
    if (metadataState === 'ready') {
      await assert.rejects(loaded.exports.verifyDataCreditoSchema(), /COLUMN_VERIFICATION_PASSED/);
      assert.equal(reachedConstraintChecks, true);
    } else {
      await assert.rejects(loaded.exports.verifyDataCreditoSchema(), error => error.code === 'SCHEMA_NOT_READY');
      assert.equal(reachedConstraintChecks, false);
    }
  }
});
test('rechazo interno auditado preserva evaluación, sobre cifrado, cupo y solicitud ajena; lectores acotados', async () => {
  const f = await fixture(); try {
    const before = await f.rows('DataCreditoAssessment'), secure = await f.rows('DataCreditoAssessmentSecurePayload'), other = (await f.rows('CreditoBorrador'))[1];
    const candidate = await f.operations.getDataCreditoAdministrativeRejectionCandidate(f.input);
    assert.equal(candidate.eligible,true); assert.equal(candidate.solicitudId,4340);
    const result = await f.operations.rejectDataCreditoAdministratively(f.input);
    assert.equal(result.idempotent,false); assert.equal(result.rejection.source,'FINSER_ADMIN'); assert.equal(result.rejection.reason,f.input.reason);
    assert.deepEqual(await f.rows('DataCreditoAssessment'),before); assert.deepEqual(await f.rows('DataCreditoAssessmentSecurePayload'),secure);
    const [draft,untouched] = await f.rows('CreditoBorrador'); assert.equal(draft.closedReason,'RECHAZADA'); assert.equal(draft.dataCreditoStatus,'NO_EVALUADO'); assert.deepEqual(untouched,other);
    assert.equal((await f.operations.getDataCreditoAdministrativeRejection({assessmentId})).id,f.input.mutationId);
    assert.equal(await f.operations.getDataCreditoAdministrativeRejection({assessmentId,solicitudId:4344}),null);
    assert.equal((await f.operations.findRecentDataCreditoAdministrativeRejection({documentHash:`document:${documentNumber}`,providerEnvironment:'production'})).id,f.input.mutationId);
    assert.equal(await f.operations.findRecentDataCreditoAdministrativeRejection({documentHash:'document:another',providerEnvironment:'production'}),null);
    const locks=f.calls.filter(sql=>sql.includes('pg_advisory')); assert.match(locks[0],/177/); assert.match(locks[1],/hashtextextended/);
  } finally { await f.pg.close(); }
});
test('reintentos concurrentes devuelven una sola decisión y conflicto si cambia motivo o identidad', async () => {
  const f=await fixture(); try {
    const results=await Promise.all([f.operations.rejectDataCreditoAdministratively(f.input),f.operations.rejectDataCreditoAdministratively(f.input)]);
    assert.deepEqual(results.map(r=>r.idempotent),[false,true]); assert.equal((await f.rows('DataCreditoAdminAccessAudit')).length,1);
    for(const change of [{reason:'Otro motivo distinto de revisión'},{documentNumber:'1234567'},{solicitudId:4344}])
      await assert.rejects(f.operations.rejectDataCreditoAdministratively({...f.input,...change}),e=>e.code==='ADMINISTRATIVE_REJECTION_CONFLICT');
    const repeat=await f.operations.rejectDataCreditoAdministratively({...f.input,mutationId:randomUUID()}); assert.equal(repeat.idempotent,true);
  } finally {await f.pg.close();}
});
test('fallo de cierre revierte la auditoría y conserva los datos',async()=>{
  const f=await fixture();try {const before=await f.rows('CreditoBorrador');f.failClosure();await assert.rejects(f.operations.rejectDataCreditoAdministratively(f.input),e=>e.code==='ADMINISTRATIVE_REJECTION_STATE_CHANGED');assert.deepEqual(await f.rows('CreditoBorrador'),before);assert.equal((await f.rows('DataCreditoAdminAccessAudit')).length,0);}finally{await f.pg.close();}
});
test('desistimiento previo permanece histórico y no reabre ni altera otro borrador',async()=>{
 const f=await fixture();try{await f.pg.exec(`UPDATE "CreditoBorrador" SET "estado"='CERRADO',"closedReason"='DESISTIDA',"closedAt"='2026-10-30T17:44:12Z' WHERE "id"=4340`);await f.operations.rejectDataCreditoAdministratively(f.input);const audit=(await f.rows('DataCreditoAdminAccessAudit'))[0];assert.equal(audit.metadata.previousDraft.closedReason,'DESISTIDA');assert.equal(audit.metadata.previousDraft.closedAt,'2026-10-30T17:44:12.000Z');assert.equal((await f.rows('CreditoBorrador'))[0].estado,'CERRADO');}finally{await f.pg.close();}
});
test('servidor rechaza asesor, admin aliado, actor inactivo y falta de revisión o confirmación',async()=>{
 const f=await fixture();try{for(const actorUserId of [2,3,999])await assert.rejects(f.operations.rejectDataCreditoAdministratively({...f.input,actorUserId}),e=>e.status===403);await f.pg.exec('UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=1');await assert.rejects(f.operations.rejectDataCreditoAdministratively(f.input),e=>e.status===403);for(const change of [{reviewed:false},{confirmed:false},{reason:'corto'},{documentNumber:1234567}])await assert.rejects(f.operations.rejectDataCreditoAdministratively({...f.input,...change}),e=>e.status===400);assert.equal((await f.rows('DataCreditoAdminAccessAudit')).length,0);}finally{await f.pg.close();}
});
test('no transforma una respuesta evaluable, indicador falso explícito, código diferente ni documento distinto',async()=>{
 const f=await fixture();try{for(const risk of [{conInformacion:true,score:700},{conInformacion:false},{},false]){f.saved.providerPayload.content.respuesta.informacionRiesgo=risk;assert.equal((await f.operations.getDataCreditoAdministrativeRejectionCandidate(f.input)).eligible,false);await assert.rejects(f.operations.rejectDataCreditoAdministratively(f.input),e=>e.code==='ADMINISTRATIVE_REJECTION_NOT_ELIGIBLE');}delete f.saved.providerPayload.content.respuesta.informacionRiesgo;f.saved.providerPayload.content.infoTransaccion.codigosRespuesta[1].valor='00';await assert.rejects(f.operations.rejectDataCreditoAdministratively(f.input));f.saved.providerPayload.content.infoTransaccion.codigosRespuesta[1].valor='09';f.saved.documentNumber='1234567';await assert.rejects(f.operations.rejectDataCreditoAdministratively(f.input));assert.equal((await f.rows('DataCreditoAdminAccessAudit')).length,0);}finally{await f.pg.close();}
});
test('rechaza estado cambiado, firma/Veriff, autorización previa, crédito y reserva',async()=>{
 const cases=[`UPDATE "CreditoBorrador" SET "currentStep"=2 WHERE "id"=4340`,`UPDATE "CreditoBorrador" SET "imei"='000000000000001' WHERE "id"=4340`,`UPDATE "CreditoBorrador" SET "usuarioId"=3 WHERE "id"=4340`,`UPDATE "DataCreditoAssessment" SET "score"=0`,`UPDATE "DataCreditoAssessment" SET "creditId"=1`,`UPDATE "DataCreditoAssessment" SET "claimTokenHash"='claim'`,`INSERT INTO "FirmaSeguroProcess" VALUES(4340)`,`INSERT INTO "VeriffIdentityValidation" VALUES(4340)`,`INSERT INTO "CreditRiskException" VALUES('${assessmentId}',4340)`,`INSERT INTO "DataCreditoAdminAccessAudit"("id","assessmentId","action") VALUES('${randomUUID()}','${assessmentId}','OPS_NO_EVALUABLE_RETRY_AUTH')`];
 for(const sql of cases){const f=await fixture();try{await f.pg.exec(sql);await assert.rejects(f.operations.rejectDataCreditoAdministratively(f.input),e=>e.code==='ADMINISTRATIVE_REJECTION_NOT_ELIGIBLE');assert.equal((await f.rows('CreditoBorrador'))[0].closedReason,null);}finally{await f.pg.close();}}
});
test('decisión vencida no impone bloqueo permanente',async()=>{
 const f=await fixture();try{await f.operations.rejectDataCreditoAdministratively(f.input);await f.pg.exec(`UPDATE "DataCreditoAdminAccessAudit" SET "metadata"=jsonb_set("metadata",'{expiresAt}','"2000-01-01T00:00:00Z"')`);assert.equal(await f.operations.findRecentDataCreditoAdministrativeRejection({documentHash:`document:${documentNumber}`,providerEnvironment:'production'}),null);}finally{await f.pg.close();}
});
test('endpoint autentica antes de leer cuerpo y transmite actor servidor; rechaza propiedades inesperadas',async()=>{
 let allowed=false,received=null,reads=0;
 class ApprovalError extends Error {constructor(code,message,status=400){super(message);this.code=code;this.status=status;}}
 const loaded={exports:{}};runInNewContext(compile(routeSource),{module:loaded,exports:loaded.exports,require:name=>{
  if(name==='next/server')return{NextResponse:{json:(body,init)=>Response.json(body,init)}};
  if(name==='@/lib/datacredito')return{getDataCreditoPublicConfig:()=>({environment:'production'})};
  if(name==='@/lib/datacredito/admin-access')return{getDataCreditoCentralAdmin:async()=>allowed?{ok:true,user:{id:1}}:{ok:false,status:403}};
  if(name==='@/lib/datacredito/admin-rejection-storage')return{DataCreditoAdministrativeRejectionError:ApprovalError,rejectDataCreditoAdministratively:async input=>{received=input;return{rejection:{},idempotent:false}}};
  if(name==='@/lib/datacredito/storage')return{hashDataCreditoRequestMetadata:()=>null};
  if(name==='@/lib/credit-approval-http')return{readApprovalRequest:async request=>{reads++;return request.json()}};
  if(name==='@/lib/credit-approval')return{CreditApprovalError:ApprovalError};return require(name);
 },Request,Response,console});
 const post=body=>loaded.exports.POST(new Request('https://finserpay.test/api',{method:'POST',body:JSON.stringify(body)}),{params:Promise.resolve({id:assessmentId})});
 assert.equal((await post({})).status,403);assert.equal(reads,0);allowed=true;assert.equal((await post({actorUserId:99})).status,400);assert.equal(received,null);
 assert.equal((await post({documentNumber,solicitudId:4340,reason:'Razón administrativa',reviewed:true,confirmed:true,mutationId:randomUUID()})).status,200);assert.equal(received.actorUserId,1);
});
