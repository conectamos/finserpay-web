import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createJiti} from 'jiti';
import {loadApprovalModule} from './credit-approval-test-loader.mjs';
const policy=await createJiti(import.meta.url).import('../lib/collection-voice-policy.ts');

test('libro PostgreSQL: firma, verificación limitada, exclusión y cierre idempotente',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY); INSERT INTO "Credito" VALUES (81)');
  const adapter={
    $executeRawUnsafe:async(sql,...params)=>(await db.query(sql,params)).affectedRows,
    $queryRawUnsafe:async(sql,...params)=>(await db.query(sql,params)).rows,
  };
  const secret='synthetic-ledger-test-secret-000000000';
  const runtime=loadApprovalModule('lib/collection-voice-runtime.ts',{
    '@/lib/prisma':{default:adapter},
    '@/lib/analyst-mora-management':{getMoraManagement:async()=>({credit:{clienteNombre:'Prueba',clienteDocumento:'100000001',enMora:true,valorVencido:50000,diasMora:5},history:[]})},
    '@/lib/analyst-mora-schema':{ensureAnalystMoraSchema:async()=>{}},
    '@/lib/credit-welcome-voice-core':{matchWelcomeVoiceIdentity:(_e,p)=>p.document==='100000001'},
    '@/lib/credit-welcome-voice-document':{parseWelcomeVoiceSpokenDocument:v=>v},
    '@/lib/dapta-welcome':{},'@/lib/dapta-collections-http':{},
    '@/lib/collection-voice-policy':policy,
  });
  // Exercise the runtime's schema against PostgreSQL with synthetic records.
  assert.ok(runtime.ensureCollectionVoiceSchema);
  await runtime.ensureCollectionVoiceSchema();
  const id='00000000-0000-4000-8000-000000000081';
  await db.query(`INSERT INTO "CollectionVoiceAttempt"("id","creditoId","debtorKey","phone","slot","status") VALUES($1,81,'synthetic','573001234567','test','DISPATCHING')`,[id]);
  const claim=()=>db.query(`UPDATE "CollectionVoiceAttempt" SET "status"='DIALING' WHERE "id"=$1 AND "status"='DISPATCHING' RETURNING "id"`,[id]);
  const claims=await Promise.all([claim(),claim()]);
  assert.equal(claims.reduce((n,r)=>n+r.rows.length,0),1,'only one dispatch claim');
  await assert.rejects(db.query(`INSERT INTO "CollectionVoiceAttempt"("id","creditoId","debtorKey","phone","slot","status") VALUES('00000000-0000-4000-8000-000000000082',81,'synthetic','573009999999','test','DISPATCHING')`),/duplicate key/);
  const attempts=await Promise.all(Array.from({length:5},()=>db.query(`UPDATE "CollectionVoiceAttempt" SET "identityAttempts"="identityAttempts"+1 WHERE "id"=$1 AND "identityAttempts"<3 RETURNING "identityAttempts"`,[id])));
  assert.equal(attempts.reduce((n,r)=>n+r.rows.length,0),3);
  const close=()=>db.query(`UPDATE "CollectionVoiceAttempt" SET "status"='COMPLETED',"callbackHash"='synthetic-hash' WHERE "id"=$1 AND "callbackHash" IS NULL RETURNING "id"`,[id]);
  const closures=await Promise.all([close(),close()]);assert.equal(closures.reduce((n,r)=>n+r.rows.length,0),1);
  const token=policy.collectionSessionToken(id,secret);assert.equal(policy.verifyCollectionSessionToken(token,secret),id);
  await db.query(`UPDATE "CollectionVoiceAttempt" SET "optOut"=TRUE WHERE "id"=$1`,[id]);
  assert.equal((await db.query('SELECT "optOut" FROM "CollectionVoiceAttempt" WHERE "id"=$1',[id])).rows[0].optOut,true);
});
