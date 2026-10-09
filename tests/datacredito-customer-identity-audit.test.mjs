import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {after, test} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);const {extractDataCreditoIdentity,resolveDataCreditoIdentity}=await jiti.import('../lib/datacredito/identity.ts');
const dir=await mkdtemp(path.join(tmpdir(),'finser-identity-audit-'));after(()=>rm(dir,{recursive:true,force:true}));
const source=(await readFile(new URL('../lib/datacredito/customer-identity.ts',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
await writeFile(path.join(dir,'identity.ts'),'const { prisma, extractDataCreditoIdentity, resolveDataCreditoIdentity, getDataCreditoAssessmentById, readDataCreditoIdentitySource, dataCreditoAssessmentMatchesScope } = globalThis.__finserIdentityTest;\n'+source);
const db = new PGlite();after(()=>db.close());
await db.exec(`CREATE TABLE "DataCreditoAssessment" ("id" UUID PRIMARY KEY); INSERT INTO "DataCreditoAssessment" VALUES ('12345678-1234-4234-8234-123456789012')`);
const rows=[];let authorized=true;
let missingPrimary = false;
const original={names:'María del Mar',firstSurname:'De la Peña',secondSurname:'Muñoz',documentType:'CEDULA_DE_CIUDADANIA',documentNumber:'1234567',fullName:'',missing:[]};
globalThis.__finserIdentityTest={extractDataCreditoIdentity,resolveDataCreditoIdentity,
 prisma:{$executeRawUnsafe:async(sql,...args)=>{await db.query(sql,args);if(sql.startsWith('INSERT'))rows.push({effective:JSON.parse(args[5]),original:JSON.parse(args[3]),previous:JSON.parse(args[4]),userId:args[1],sellerId:args[2]});},$queryRawUnsafe:async()=>rows.slice(-1)},
 getDataCreditoAssessmentById:async()=>({id:'12345678-1234-4234-8234-123456789012',status:'APROBADO'}),dataCreditoAssessmentMatchesScope:()=>authorized,
 readDataCreditoIdentitySource:async()=>({documentNumber:'1234567',firstSurname:'DIGITADO',providerPayload:{content:{respuesta:{validacion:{datosBasicos:{conInformacion:true,primerNombre:original.names,primerApellido:missingPrimary ? "" : original.firstSurname,segundoApellido:original.secondSurname,tipoDocumento:'CC',numeroDocumento:original.documentNumber}}}}}})};
const {enforceDataCreditoCustomerIdentity:enforce,getDataCreditoCustomerIdentity:get,completeMissingDataCreditoIdentity:complete}=await jiti.import(path.join(dir,'identity.ts'));
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
