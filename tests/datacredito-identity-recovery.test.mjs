import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createJiti} from 'jiti';
const dir=await mkdtemp(path.join(tmpdir(),'finser-identity-recovery-'));
const db=new PGlite();after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
const jiti=createJiti(import.meta.url);
const {extractDataCreditoIdentity,resolveDataCreditoIdentity}=await jiti.import('../lib/datacredito/identity.ts');
await writeFile(path.join(dir,'secure.ts'),(await readFile(new URL('../lib/datacredito/secure-record.ts',import.meta.url),'utf8')).replace(/^import "server-only";\s*/,''));
const secure=await jiti.import(path.join(dir,'secure.ts'));
const env={DATACREDITO_RECORD_ENCRYPTION_ACTIVE_KEY_ID:'test',DATACREDITO_RECORD_ENCRYPTION_KEYS_JSON:JSON.stringify({test:Buffer.alloc(32,17).toString('base64')})};
const id='12345678-1234-4234-8234-123456789012',correlationId='12345678-1234-4234-8234-123456789013';
const hash=documentNumber=>createHash('sha256').update(documentNumber).digest('hex');
const envelope=secure.encryptDataCreditoSecureRecord({assessmentId:id,correlationId,documentNumber:'1234567',firstSurname:'DIGITADO',providerPayload:{content:{respuesta:{validacion:{datosBasicos:{conInformacion:true,numeroDocumento:'0000001234567',tipoDocumento:'CC',primerNombre:'María del Mar',primerApellido:'De la Peña'}}}}}},env);
await db.exec(`CREATE TABLE "DataCreditoAssessment" ("id" UUID PRIMARY KEY, "correlationId" UUID, "retainedUntil" TIMESTAMPTZ);
CREATE TABLE "DataCreditoAssessmentSecurePayload" ("assessmentId" UUID PRIMARY KEY,"algorithm" TEXT,"keyId" TEXT,"aadVersion" INT,"plaintextVersion" INT,"nonce" BYTEA,"authTag" BYTEA,"ciphertext" BYTEA,"plaintextBytes" INT);`);
await db.query('INSERT INTO "DataCreditoAssessment" VALUES ($1,$2,CURRENT_TIMESTAMP + INTERVAL \'1 day\')',[id,correlationId]);
await db.query('INSERT INTO "DataCreditoAssessmentSecurePayload" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,envelope.algorithm,envelope.keyId,envelope.aadVersion,envelope.plaintextVersion,envelope.nonce,envelope.authTag,envelope.ciphertext,envelope.plaintextBytes]);
let queries=0,failRead=false;
const prisma={
 $executeRawUnsafe:async(sql,...args)=>db.query(sql,args),
 $queryRawUnsafe:async(sql,...args)=>{
  queries++;if(failRead)throw new Error('DATACREDITO_IDENTITY_DOCUMENT_MISMATCH');
  const result=await db.query(sql,args);
  assert.equal(new Set(result.fields.map(x=>x.name)).size,result.fields.length,'raw query must not duplicate assessmentId columns');
  return result.rows;
 }
};
globalThis.__identityRecoveryTest={prisma,ensureDataCreditoSchema:async()=>{},decryptDataCreditoSecureRecord:input=>secure.decryptDataCreditoSecureRecord(input,env),buildDataCreditoIdentityHashes:input=>({documentHash:hash(input.documentNumber)}),extractDataCreditoIdentity,resolveDataCreditoIdentity};
const storage=await readFile(new URL('../lib/datacredito/storage.ts',import.meta.url),'utf8');
const reader=storage.slice(storage.indexOf('export async function readDataCreditoIdentitySource('),storage.indexOf('export function serializeDataCreditoAssessment('));
await writeFile(path.join(dir,'reader.ts'),'const {prisma,ensureDataCreditoSchema,decryptDataCreditoSecureRecord,buildDataCreditoIdentityHashes}=globalThis.__identityRecoveryTest;\n'+reader);
const {readDataCreditoIdentitySource}=await jiti.import(path.join(dir,'reader.ts'));
globalThis.__identityRecoveryTest.readDataCreditoIdentitySource=readDataCreditoIdentitySource;
let customer=await readFile(new URL('../lib/datacredito/customer-identity.ts',import.meta.url),'utf8');
customer=customer.replace(/^import .*;\r?\n/gm,'');
await writeFile(path.join(dir,'customer.ts'),'const {prisma,extractDataCreditoIdentity,resolveDataCreditoIdentity,readDataCreditoIdentitySource}=globalThis.__identityRecoveryTest;\n'+customer);
const {getDataCreditoCustomerIdentity,getDataCreditoCustomerIdentityForDisplay}=await jiti.import(path.join(dir,'customer.ts'));
const row={id,correlationId,documentHash:hash('1234567')};
test('recover real encrypted retained response and optional surname with no provider call',async()=>{
 const identity=await getDataCreditoCustomerIdentityForDisplay(row);
 assert.equal(identity.effective.names,'María del Mar');assert.equal(identity.effective.firstSurname,'De la Peña');
 assert.equal(identity.effective.documentNumber,'1234567');assert.equal(identity.effective.secondSurname,'');assert.deepEqual(identity.effective.missing,[]);
 assert.equal(identity.querySurname,'DIGITADO');assert.equal(queries,2);
 const restored=await getDataCreditoCustomerIdentityForDisplay(row);assert.deepEqual(restored,identity);assert.equal(queries,4);
});
test('identity failure cannot invalidate completed evaluation; strict signing reader still rejects',async()=>{
 failRead=true;
 const originalError=console.error;const logs=[];console.error=(...args)=>logs.push(args);
 try{
  assert.equal(await getDataCreditoCustomerIdentityForDisplay(row),null);
  assert.equal(logs[0][1].code,'DATACREDITO_IDENTITY_DOCUMENT_MISMATCH');
  assert.equal(logs[0][1].correlationId,correlationId);
  assert.ok(!JSON.stringify(logs).includes('María'));
  await assert.rejects(getDataCreditoCustomerIdentity(row),/DOCUMENT_MISMATCH/);
 }finally{console.error=originalError;failRead=false;}
});
test('assessment whose document does not match encrypted source fails closed',async()=>{
 await assert.rejects(getDataCreditoCustomerIdentity({...row,documentHash:hash('7654321')}),/DOCUMENT_MISMATCH/);
});
