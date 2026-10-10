import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {after, test} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);const {extractDataCreditoIdentity,resolveDataCreditoIdentity}=await jiti.import('../lib/datacredito/identity.ts');
const dir=await mkdtemp(path.join(tmpdir(),'finser-identity-audit-'));after(()=>rm(dir,{recursive:true,force:true}));
const source=(await readFile(new URL('../lib/datacredito/customer-identity.ts',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
await writeFile(path.join(dir,'identity.ts'),'const { prisma, extractDataCreditoIdentity, resolveDataCreditoIdentity, getDataCreditoAssessmentById, readDataCreditoIdentitySource, dataCreditoAssessmentMatchesScope } = globalThis.__finserIdentityTest;\n'+source);
const db = new PGlite();after(()=>db.close());
await db.exec(`CREATE TABLE "DataCreditoAssessment" ("id" UUID PRIMARY KEY, "status" TEXT NOT NULL DEFAULT 'APROBADO', "consumedAt" TIMESTAMPTZ); INSERT INTO "DataCreditoAssessment" ("id") VALUES ('12345678-1234-4234-8234-123456789012')`);
const rows=[];let authorized=true;
let missingPrimary = false;
let providerIdentityOverride = null;
let transactionActive = false;
function auditInsert(sql, args) {
 if (sql.startsWith('INSERT')) rows.push({effective:JSON.parse(args[5]),original:JSON.parse(args[3]),previous:JSON.parse(args[4]),userId:args[1],sellerId:args[2]});
}
const prisma = {
 $executeRawUnsafe: async(sql,...args)=>{
  assert.equal(transactionActive,false,'No global connection while the identity transaction holds its lock');
  await db.query(sql,args);auditInsert(sql,args);
 },
 $queryRawUnsafe: async(sql,...args)=>{
  assert.equal(transactionActive,false,'Mutable identity reads must use the active transaction client');
  return (await db.query(sql,args)).rows;
 },
 $transaction: async(callback)=>db.transaction(async(transaction)=>{
  transactionActive=true;
  try {
   return await callback({
    $queryRawUnsafe:async(sql,...args)=>(await transaction.query(sql,args)).rows,
    $executeRawUnsafe:async(sql,...args)=>{await transaction.query(sql,args);auditInsert(sql,args);},
   });
  } finally { transactionActive=false; }
 }),
};
const original={names:'María del Mar',firstSurname:'De la Peña',secondSurname:'Muñoz',documentType:'CEDULA_DE_CIUDADANIA',documentNumber:'1234567',fullName:'',missing:[]};
globalThis.__finserIdentityTest={extractDataCreditoIdentity,resolveDataCreditoIdentity,
 prisma,
 getDataCreditoAssessmentById:async()=>({id:'12345678-1234-4234-8234-123456789012',status:'APROBADO'}),dataCreditoAssessmentMatchesScope:()=>authorized,
 readDataCreditoIdentitySource:async()=>({documentNumber:'1234567',firstSurname:'DIGITADO',providerPayload:{content:{respuesta:{validacion:{datosBasicos:{conInformacion:true,primerNombre:original.names,primerApellido:missingPrimary ? "" : original.firstSurname,segundoApellido:original.secondSurname,tipoDocumento:'CC',numeroDocumento:original.documentNumber,...providerIdentityOverride}}}}}})};
const {enforceDataCreditoCustomerIdentity:enforce,getDataCreditoCustomerIdentity:get,completeMissingDataCreditoIdentity:complete,getScopedDataCreditoQueryIdentity:signedQuery}=await jiti.import(path.join(dir,'identity.ts'));
const scope={userId:23,sellerId:45,sedeId:1,aliadoId:null};const payload={dataCreditoAssessmentId:'12345678-1234-4234-8234-123456789012',clientePrimerNombre:'María José',clientePrimerApellido:original.firstSurname,clienteSegundoApellido:'',clienteDocumento:original.documentNumber,clienteTipoDocumento:original.documentType};
test('correction audit preserves provider original, effective value and trusted actor; reload and signing retain correction',async()=>{
 const data={...payload};await enforce(data,scope);assert.equal(rows.length,1);assert.equal(rows[0].userId,23);assert.equal(rows[0].sellerId,45);
 const audit=await db.query('SELECT "createdAt", "userId", "effective" FROM "DataCreditoIdentityCorrection"');assert.ok(audit.rows[0].createdAt);assert.equal(audit.rows[0].userId,23);assert.equal(rows[0].original.names,original.names);assert.equal(rows[0].effective.names,'María José');assert.equal(rows[0].effective.secondSurname,'');assert.equal(data.clienteNombre,'María José De la Peña');
 const reloaded=await get({id:'12345678-1234-4234-8234-123456789012'});assert.equal(reloaded.effective.names,'María José');assert.equal(reloaded.querySurname,'DIGITADO');
 await enforce({...payload},scope,false);assert.equal(rows.length,1);
 await assert.rejects(enforce({...payload,clientePrimerNombre:original.names},scope,false),/SAVE_CORRECTION_FIRST/);
});
test('another document or unauthorized actor cannot modify identity',async()=>{
 await assert.rejects(enforce({...payload,clienteDocumento:'7654321'},scope),/DOCUMENT_MISMATCH/);
 authorized=false;await assert.rejects(enforce({...payload},scope),/UNAUTHORIZED/);authorized=true;assert.equal(rows.length,1);
});

test('authorized completion fills missing primary identity, keeps provenance and survives signing validation',async()=>{
 rows.length=0;await db.query('DELETE FROM "DataCreditoIdentityCorrection"');missingPrimary=true;
 await assert.rejects(enforce({...payload},scope,false),/LOCKED_FIELDS/);
 const review=await complete({id:payload.dataCreditoAssessmentId},{firstSurname:'De la Peña'},{userId:99,sellerId:null});
 assert.equal(review.original.firstSurname,'');assert.deepEqual(review.effective.manuallyCompleted,['firstSurname']);assert.equal(rows[0].userId,99);
 const signed=await enforce({...payload,clientePrimerNombre:original.names,clienteSegundoApellido:original.secondSurname},scope,false);
 assert.equal(signed.effective.firstSurname,'De la Peña');
 await assert.rejects(complete({id:payload.dataCreditoAssessmentId},{firstSurname:'Otro'},{userId:99,sellerId:null}),/LOCKED_FIELDS/);
 missingPrimary=false;
});

test('signed closing validates encrypted query and owner without revalidating provider names',async()=>{
 const previous=original.documentNumber;original.documentNumber='7654321';
 try{
  await assert.rejects(get({id:payload.dataCreditoAssessmentId}),/DOCUMENT_MISMATCH/);
  const signed=await signedQuery(payload.dataCreditoAssessmentId,scope,'1234567');
  assert.equal(signed.querySurname,'DIGITADO');assert.equal(signed.documentNumber,'1234567');
  await assert.rejects(signedQuery(payload.dataCreditoAssessmentId,scope,'7654321'),/DOCUMENT_MISMATCH/);
  authorized=false;await assert.rejects(signedQuery(payload.dataCreditoAssessmentId,scope,'1234567'),/UNAUTHORIZED/);
 }finally{authorized=true;original.documentNumber=previous;}
});

test('simultaneous authorized completions cannot replace a primary field completed by the other request',async()=>{
 rows.length=0;await db.query('DELETE FROM "DataCreditoIdentityCorrection"');missingPrimary=true;
 try {
  const outcomes=await Promise.allSettled([
   complete({id:payload.dataCreditoAssessmentId},{firstSurname:'De la Peña'},{userId:99,sellerId:null}),
   complete({id:payload.dataCreditoAssessmentId},{firstSurname:'Del Río'},{userId:100,sellerId:null}),
  ]);
  const successes=outcomes.filter(outcome=>outcome.status==='fulfilled');
  const failures=outcomes.filter(outcome=>outcome.status==='rejected');
  assert.equal(successes.length,1);assert.equal(failures.length,1);
  assert.match(failures[0].reason.message,/LOCKED_FIELDS/);
  const stored=await db.query('SELECT "original", "previous", "effective", "userId", "createdAt" FROM "DataCreditoIdentityCorrection"');
  assert.equal(stored.rows.length,1);assert.equal(rows.length,1);
  const winner=successes[0].value.effective.firstSurname;
  assert.equal(stored.rows[0].original.firstSurname,'');
  assert.equal(stored.rows[0].previous.firstSurname,'');
  assert.equal(stored.rows[0].effective.firstSurname,winner);
  assert.equal(stored.rows[0].userId,winner==='De la Peña'?99:100);
  assert.ok(stored.rows[0].createdAt);
  assert.equal((await get({id:payload.dataCreditoAssessmentId})).effective.firstSurname,winner);
  await assert.rejects(complete({id:payload.dataCreditoAssessmentId},{firstSurname:'Otro'},{userId:101,sellerId:null}),/LOCKED_FIELDS/);
 } finally {missingPrimary=false;}
});

test('administrative completion rechecks current approval and consumption instead of trusting the caller snapshot',async()=>{
 rows.length=0;await db.query('DELETE FROM "DataCreditoIdentityCorrection"');missingPrimary=true;
 try {
  for (const [status,consumedAt] of [['PENDING',null],['NO_EVALUADO',null],['APROBADO','2026-10-09T23:00:00Z']]) {
   await db.query('UPDATE "DataCreditoAssessment" SET "status"=$1, "consumedAt"=$2',[status,consumedAt]);
   await assert.rejects(complete({id:payload.dataCreditoAssessmentId,status:'APROBADO',consumedAt:null},{firstSurname:'De la Peña'},{userId:99,sellerId:null}),/UNAUTHORIZED/);
   assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM "DataCreditoIdentityCorrection"')).rows[0].count,0);
  }
  assert.equal(rows.length,0);
 } finally {
  missingPrimary=false;await db.query('UPDATE "DataCreditoAssessment" SET "status"=\'APROBADO\', "consumedAt"=NULL');
 }
});

const providerFullName='María del Mar  De la Peña Muñoz';
const fullNameOnlyFields={primerNombre:'',primerApellido:'',segundoApellido:'',nombreCompleto:providerFullName};
test('full provider name survives autosave, reload and signing without inferred components or a correction',async()=>{
 rows.length=0;await db.query('DELETE FROM "DataCreditoIdentityCorrection"');providerIdentityOverride=fullNameOnlyFields;
 try {
  const recovered=await get({id:payload.dataCreditoAssessmentId});
  assert.equal(recovered.original.nameMode,'FULL_NAME_ONLY');assert.equal(recovered.effective.fullName,providerFullName);assert.deepEqual(recovered.effective.missing,[]);
  const data={...payload,clienteNombre:providerFullName,clientePrimerNombre:'No verificado',clienteSegundoNombre:'No verificado',clientePrimerApellido:'DIGITADO',clienteSegundoApellido:'No verificado'};
  await enforce(data,scope);
  assert.equal(data.clienteNombre,providerFullName);assert.equal(data.clientePrimerNombre,'');assert.equal(data.clienteSegundoNombre,'');assert.equal(data.clientePrimerApellido,'');assert.equal(data.clienteSegundoApellido,'');
  const signed=await enforce({...data},scope,false);assert.equal(signed.effective.fullName,providerFullName);
  assert.equal((await get({id:payload.dataCreditoAssessmentId})).effective.fullName,providerFullName);
  assert.equal(rows.length,0);assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM "DataCreditoIdentityCorrection"')).rows[0].count,0);
  await assert.rejects(enforce({...data,clienteNombre:'Otra Persona'},scope,false),/LOCKED_FIELDS/);
  await assert.rejects(enforce({...data,clienteDocumento:'7654321'},scope),/DOCUMENT_MISMATCH/);
  await assert.rejects(enforce({...data,clienteTipoDocumento:'PASAPORTE'},scope),/LOCKED_FIELDS/);
  providerIdentityOverride={...fullNameOnlyFields,tipoDocumento:''};
  await assert.rejects(enforce({...data,clienteTipoDocumento:''},scope),/INCOMPLETE/);
 } finally {providerIdentityOverride=null;}
});

test('legacy administrative surname completion cannot replace the complete provider name with a surname',async()=>{
 rows.length=0;await db.query('DELETE FROM "DataCreditoIdentityCorrection"');providerIdentityOverride=fullNameOnlyFields;
 try {
  const previous={...original,names:'',firstSurname:'',secondSurname:'',fullName:providerFullName,missing:['Nombre(s)','Primer apellido']};
  const legacy={...previous,firstSurname:'De la Peña',fullName:'De la Peña',manuallyCompleted:['firstSurname']};
  await db.query('INSERT INTO "DataCreditoIdentityCorrection" ("assessmentId","userId","original","previous","effective") VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',[payload.dataCreditoAssessmentId,99,JSON.stringify(previous),JSON.stringify(previous),JSON.stringify(legacy)]);
  const recovered=await get({id:payload.dataCreditoAssessmentId});
  assert.equal(recovered.effective.nameMode,'FULL_NAME_ONLY');assert.equal(recovered.effective.fullName,providerFullName);assert.equal(recovered.effective.firstSurname,'De la Peña');assert.deepEqual(recovered.effective.manuallyCompleted,['firstSurname']);assert.deepEqual(recovered.effective.missing,[]);
  const data={...payload,clienteNombre:providerFullName};await enforce(data,scope,false);
  assert.equal(data.clienteNombre,providerFullName);assert.equal(data.clientePrimerNombre,'');assert.equal(data.clientePrimerApellido,'De la Peña');assert.equal(rows.length,0);
 } finally {providerIdentityOverride=null;}
});

test('legacy audited name corrections remain effective after switching to full provider name display',async()=>{
 rows.length=0;await db.query('DELETE FROM "DataCreditoIdentityCorrection"');providerIdentityOverride=fullNameOnlyFields;
 try {
  const previous={...original,names:'',firstSurname:'',secondSurname:'',fullName:providerFullName,missing:['Nombre(s)','Primer apellido']};
  const corrected={...original,names:'María José',secondSurname:'',fullName:'María José De la Peña',manuallyCompleted:['firstSurname']};
  await db.query('INSERT INTO "DataCreditoIdentityCorrection" ("assessmentId","userId","original","previous","effective") VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',[payload.dataCreditoAssessmentId,23,JSON.stringify(previous),JSON.stringify(previous),JSON.stringify(corrected)]);
  const recovered=await get({id:payload.dataCreditoAssessmentId});
  assert.equal(recovered.original.fullName,providerFullName);assert.equal(recovered.effective.fullName,corrected.fullName);assert.equal(recovered.effective.nameMode,'FULL_NAME_ONLY');
  const data={...payload,clienteNombre:corrected.fullName};await enforce(data,scope,false);
  assert.equal(data.clienteNombre,corrected.fullName);assert.equal(data.clientePrimerNombre,'María José');assert.equal(data.clientePrimerApellido,'De la Peña');assert.equal(data.clienteSegundoApellido,'');assert.equal(rows.length,0);
 } finally {providerIdentityOverride=null;}
});
