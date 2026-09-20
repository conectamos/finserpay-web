import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { installCreditApprovalSchema } from "../scripts/credit-approval-schema.mjs";
import { installCreditApprovalActorSchema } from "../scripts/credit-approval-actor-schema.mjs";
import { installApprovalSharedSchema } from "../scripts/approval-shared-schema.mjs";
import { installCreditApprovalNoveltiesSchema } from "../scripts/credit-approval-novelties-schema.mjs";
import { installCreditApprovalCallSchema } from "../scripts/credit-approval-call-schema.mjs";
const connectionString = process.env.CREDIT_APPROVAL_CALL_GATE_TEST_DATABASE_URL;
const hash = "a".repeat(64), bytes = Buffer.from("fixture SQL sin voz");
const sha256 = createHash("sha256").update(bytes).digest("hex");

test("PostgreSQL: grabación obligatoria, concurrencia e historia preservada", {
  skip: connectionString ? false : "Requiere CREDIT_APPROVAL_CALL_GATE_TEST_DATABASE_URL local approval_gate_test",
}, async (t) => {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/approval_gate_test");
  const db = new pg.Client({ connectionString }); await db.connect(); t.after(() => db.end());
  const tables = ["CreditApprovalCallContinuation","CreditApprovalNoveltyEvent","CreditApprovalNoveltyItem","CreditApprovalNovelty","CreditApprovalEvent","CreditApprovalReview","CreditApprovalCallRecording","CreditApprovalSharedSession",
    "CreditApprovalSharedGrant","CreditApprovalPolicy","CreditApprovalReissue","LiquidacionAliadoCredito","Credito","Sede","Aliado","Usuario","Rol"];
  const existing = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(existing.rows.every(({ tablename }) => tables.includes(tablename)), "No reiniciar tablas ajenas");
  for (const table of tables) await db.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
  await db.query(`CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY,"nombre" TEXT NOT NULL);
    INSERT INTO "Rol" VALUES (1,'ANALISTA_APROBACION'),(2,'ADMIN');
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"codigo" TEXT,"activo" BOOLEAN NOT NULL);
    INSERT INTO "Aliado" VALUES (10,'ALLY',TRUE),(20,'FINSERPAY',TRUE),(30,'FINSERPAY',FALSE);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER,"activa" BOOLEAN NOT NULL);
    INSERT INTO "Sede" VALUES (10,10,TRUE),(20,20,TRUE),(21,20,FALSE),(30,30,TRUE);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY,"nombre" TEXT NOT NULL,"activo" BOOLEAN NOT NULL,"rolId" INTEGER NOT NULL,"sedeId" INTEGER NOT NULL);
    INSERT INTO "Usuario" VALUES
      (1,'Analista QA',TRUE,1,10),(2,'Emisor QA',TRUE,1,10),(3,'Admin central',TRUE,2,20),
      (4,'Analista central',TRUE,1,20),(5,'Admin aliado',TRUE,2,10),(6,'Admin central inactivo',FALSE,2,20),
      (7,'Admin sede inactiva',TRUE,2,21),(8,'Admin aliado inactivo',TRUE,2,30);
    CREATE TABLE "Credito" (
      "id" SERIAL PRIMARY KEY,"createdAt" TIMESTAMP(3) DEFAULT '2099-01-01',"estado" TEXT DEFAULT 'ACTIVO',
      "clienteNombre" TEXT DEFAULT 'Cliente sintético',"clienteDocumento" TEXT DEFAULT '12345',
      "valorEquipoTotal" FLOAT DEFAULT 1000000,"cuotaInicial" FLOAT DEFAULT 200000,
      "saldoBaseFinanciado" FLOAT DEFAULT 800000,"montoCredito" FLOAT DEFAULT 800000,
      "imei" TEXT DEFAULT '111111111111111',"sedeId" INTEGER DEFAULT 10,
      "equipoMarca" TEXT DEFAULT 'Marca QA',"equipoModelo" TEXT DEFAULT 'Modelo QA',
      "equalityService" TEXT,"contratoSnapshot" JSONB DEFAULT '{"firma":{"hash":"original"}}',
      "contratoCedulaFrenteDataUrl" TEXT DEFAULT 'front',"contratoCedulaRespaldoDataUrl" TEXT DEFAULT 'back',
      "iphoneSelfieCedulaDataUrl" TEXT DEFAULT 'selfie',"fotoEntregaDataUrl" TEXT DEFAULT 'delivery',"fotoRemisionDataUrl" TEXT DEFAULT 'remission');
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER UNIQUE REFERENCES "Credito"("id"),"snapshot" TEXT DEFAULT 'pago original');
    CREATE TABLE "CreditApprovalReissue" ("creditoId" INTEGER,"status" TEXT);`);
  await installCreditApprovalSchema(db); await installCreditApprovalActorSchema(db); await installApprovalSharedSchema(db);
  await installCreditApprovalNoveltiesSchema(db);
  const createCredit = async () => (await db.query('INSERT INTO "Credito" DEFAULT VALUES RETURNING "id"')).rows[0].id;
  const review = async id => (await db.query('SELECT to_jsonb(r) AS row FROM "CreditApprovalReview" r WHERE "creditoId"=$1',[id])).rows[0].row;
  const defaultActor={kind:"USER",userId:1,name:"Analista QA",grantId:null,sessionId:null};
  const approve = (id, recordingId, client=db, reviewHash=hash, actor=defaultActor) => client.query(`UPDATE "CreditApprovalReview" SET "status"='APPROVED',
    "approvedRevision"="revision","approvedHashVersion"="reviewHashVersion","approvedByKind"=$4,"approvedByUserId"=$5,"approvedByName"=$6,
    "approvedByGrantId"=$7::uuid,"approvedBySessionId"=$8::uuid,
    "approvedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',"reviewHash"=$2,"callRecordingId"=$3::uuid WHERE "creditoId"=$1`,
    [id,reviewHash,recordingId,actor.kind,actor.userId,actor.name,actor.grantId,actor.sessionId]);
  const event = (id, recordingId, actor=defaultActor) => db.query(`INSERT INTO "CreditApprovalEvent"
    ("creditoId","eventType","revision","actorUserId","actorName","actorKind","actorGrantId","actorSessionId","reviewHash","callRecordingId","reviewHashVersion")
    SELECT "creditoId",'APPROVED',"revision",$3,$4,$5,$6::uuid,$7::uuid,"reviewHash",$2::uuid,"reviewHashVersion"
    FROM "CreditApprovalReview" WHERE "creditoId"=$1`,
    [id,recordingId,actor.userId,actor.name,actor.kind,actor.grantId,actor.sessionId]);
  const audio = async (id, overrides={}, client=db) => {
    const row={id:randomUUID(),creditoId:id,revision:1,reviewHash:hash,fileName:"llamada.wav",mimeType:"audio/wav",sizeBytes:bytes.length,sha256,bytes,
      actorKind:"USER",actorUserId:1,actorName:"Analista QA",actorGrantId:null,actorSessionId:null,idempotencyKey:randomUUID(),...overrides};
    const keys=Object.keys(row);
    return (await client.query(`INSERT INTO "CreditApprovalCallRecording" (${keys.map(key=>`"${key}"`).join(",")})
      VALUES (${keys.map((_,i)=>`$${i+1}`).join(",")}) RETURNING "id","createdAt",
      ABS(EXTRACT(EPOCH FROM ("createdAt"-(clock_timestamp() AT TIME ZONE 'UTC'))))<5 AS utc`,Object.values(row))).rows[0];
  };
  const legacy=await createCredit(), paid=await createCredit(), pending=await createCredit();
  for(const id of [legacy,paid]) {
    await db.query(`UPDATE "CreditApprovalReview" SET "status"='APPROVED',"approvedRevision"="revision","approvedHashVersion"="reviewHashVersion",
      "approvedByKind"='USER',"approvedByUserId"=1,"approvedByName"='Analista histórico',"approvedAt"='2026-09-01 12:34:56.123',"reviewHash"=$2 WHERE "creditoId"=$1`,[id,hash]);
    await db.query(`INSERT INTO "CreditApprovalEvent" ("creditoId","eventType","revision","actorUserId","actorName","reviewHash")
      SELECT "creditoId",'APPROVED',"revision",1,'Analista histórico',"reviewHash" FROM "CreditApprovalReview" WHERE "creditoId"=$1`,[id]);
  }
  await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)',[paid]);
  const stableTables=["Credito","CreditApprovalReview","CreditApprovalEvent","CreditApprovalPolicy","LiquidacionAliadoCredito"];
  const snapshot=async()=>{const result={};for(const table of stableTables) result[table]=(await db.query(`SELECT to_jsonb(row) AS value FROM "${table}" row ORDER BY to_jsonb(row)::text`)).rows.map(row=>row.value);return result;};
  const before=await snapshot();
  // Prisma-first: the table/columns exist without CHECK constraints.
  await db.query(`CREATE TABLE "CreditApprovalCallRecording" (
    "id" UUID PRIMARY KEY,"creditoId" INTEGER NOT NULL,"revision" INTEGER NOT NULL,"reviewHash" VARCHAR(64) NOT NULL,
    "fileName" VARCHAR(160) NOT NULL,"mimeType" VARCHAR(32) NOT NULL,"sizeBytes" INTEGER NOT NULL,"sha256" VARCHAR(64) NOT NULL,
    "bytes" BYTEA NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"actorUserId" INTEGER,
    "actorName" VARCHAR(160) NOT NULL,"actorKind" VARCHAR(16) NOT NULL,"actorGrantId" UUID,"actorSessionId" UUID,"idempotencyKey" UUID NOT NULL);
    ALTER TABLE "CreditApprovalReview" ADD COLUMN "callRecordingId" UUID;
    ALTER TABLE "CreditApprovalEvent" ADD COLUMN "callRecordingId" UUID;`);
  await db.query("SET TIME ZONE 'America/Bogota'"); await installCreditApprovalCallSchema(db);

  await t.test("instalación repetible conserva política, créditos, decisiones y pagos previos",async()=>{
    await installCreditApprovalCallSchema(db); const after=await snapshot();
    for(const table of stableTables) {
      const removeAdded=row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=="callRecordingId"));
      const sort=rows=>[...rows].sort((a,b)=>String(a.id??a.creditoId).localeCompare(String(b.id??b.creditoId)));
      assert.deepEqual(sort(after[table].map(removeAdded)),sort(before[table]),table);
    }
    assert.equal((await review(legacy)).callRecordingId,null);
    assert.equal((await review(paid)).callRecordingId,null);
    await assert.rejects(db.query('UPDATE "CreditApprovalReview" SET "creditoId"=999999 WHERE "creditoId"=$1',[legacy]),{code:"23514"});
    assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM "CreditApprovalCallRecording"')).rows[0].count,0);
  });
  await t.test("base nueva instala el CHECK con audio/ogg",async()=>{
    const definition=(await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname='CreditApprovalCallRecording_file_check'
        AND conrelid='public."CreditApprovalCallRecording"'::regclass AND contype='c'`)).rows[0]?.definition;
    assert.match(definition,/audio\/ogg/);
  });
  await t.test("upgrade del CHECK viejo es repetible y preserva grabaciones",async()=>{
    const id=await createCredit(),saved=await audio(id);
    const stored=()=>db.query(`SELECT "id","creditoId","fileName","mimeType","sizeBytes","sha256",encode("bytes",'hex') AS bytes
      FROM "CreditApprovalCallRecording" WHERE "id"=$1`,[saved.id]).then(result=>result.rows[0]);
    const definition=()=>db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname='CreditApprovalCallRecording_file_check'
        AND conrelid='public."CreditApprovalCallRecording"'::regclass AND contype='c'`).then(result=>result.rows[0]?.definition);
    const before=await stored();
    await db.query('ALTER TABLE public."CreditApprovalCallRecording" DROP CONSTRAINT "CreditApprovalCallRecording_file_check"');
    await db.query(`ALTER TABLE public."CreditApprovalCallRecording" ADD CONSTRAINT "CreditApprovalCallRecording_file_check"
      CHECK (LENGTH(BTRIM("fileName")) BETWEEN 1 AND 160 AND "mimeType" IN ('audio/mpeg','audio/mp4','audio/wav'))`);
    assert.doesNotMatch(await definition(),/audio\/ogg/);
    await installCreditApprovalCallSchema(db);
    assert.match(await definition(),/audio\/ogg/); assert.deepEqual(await stored(),before);
    await installCreditApprovalCallSchema(db);
    assert.match(await definition(),/audio\/ogg/); assert.deepEqual(await stored(),before);
    const ogg=await audio(id,{fileName:"llamada.ogg",mimeType:"audio/ogg"});
    assert.equal(ogg.utc,true);
  });
  await t.test("SQL directo bloquea nuevo OK y liquidación sin grabación",async()=>{
    await assert.rejects(approve(pending,null),{code:"23514"}); assert.equal((await review(pending)).status,"PENDING");
    await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)',[pending]),{code:"23514"});
  });
  await t.test("solo el ADMIN central activo puede aprobar y auditar sin audio",async()=>{
    const central={kind:"USER",userId:3,name:"Admin central",grantId:null,sessionId:null};
    const centralAnalyst={kind:"USER",userId:4,name:"Analista central",grantId:null,sessionId:null};
    const externalAdmin={kind:"USER",userId:5,name:"Admin aliado",grantId:null,sessionId:null};
    const inactiveUser={kind:"USER",userId:6,name:"Admin central inactivo",grantId:null,sessionId:null};
    const inactiveSite={kind:"USER",userId:7,name:"Admin sede inactiva",grantId:null,sessionId:null};
    const inactiveAlly={kind:"USER",userId:8,name:"Admin aliado inactivo",grantId:null,sessionId:null};
    const canSkip=async(kind,userId)=>(await db.query(
      "SELECT public.credit_approval_actor_can_skip_call_recording($1,$2) AS allowed",[kind,userId])).rows[0].allowed;
    assert.equal(await canSkip("USER",central.userId),true);
    for(const [kind,userId] of [["USER",centralAnalyst.userId],["USER",externalAdmin.userId],
      ["USER",inactiveUser.userId],["USER",inactiveSite.userId],["USER",inactiveAlly.userId],
      ["SHARED_LINK",central.userId],["USER",null]]) assert.equal(await canSkip(kind,userId),false);

    const grant=randomUUID(),session=randomUUID();
    await db.query('INSERT INTO "CreditApprovalSharedGrant" ("id","issuedByUserId") VALUES ($1,1)',[grant]);
    await db.query(`INSERT INTO "CreditApprovalSharedSession" ("id","grantId","expiresAt")
      VALUES ($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '1 hour')`,[session,grant]);
    const shared={kind:"SHARED_LINK",userId:null,name:"Analista por enlace",grantId:grant,sessionId:session};
    for(const actor of [defaultActor,centralAnalyst,externalAdmin,inactiveUser,inactiveSite,inactiveAlly,shared]) {
      const id=await createCredit();
      await assert.rejects(approve(id,null,db,hash,actor),{code:"23514"});
      assert.equal((await review(id)).status,"PENDING");
    }

    const id=await createCredit();
    await approve(id,null,db,hash,central);
    assert.equal((await review(id)).callRecordingId,null);
    await assert.rejects(event(id,null,{...central,name:"Nombre falsificado"}),{code:"23514"});
    await db.query('UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=$1',[central.userId]);
    await assert.rejects(event(id,null,central),{code:"23514"});
    await db.query('UPDATE "Usuario" SET "activo"=TRUE WHERE "id"=$1',[central.userId]);
    await event(id,null,central);

    const withAudio=await createCredit(),older=await audio(withAudio),latest=await audio(withAudio);
    await assert.rejects(approve(withAudio,null,db,hash,central),{code:"23514"});
    await assert.rejects(approve(withAudio,older.id,db,hash,central),{code:"23514"});
    assert.equal((await review(withAudio)).status,"PENDING");
    await approve(withAudio,latest.id,db,hash,central);
    await assert.rejects(event(withAudio,older.id,central),{code:"23514"});
    await event(withAudio,latest.id,central);
  });
  await t.test("Prisma-first instala checksum, tamaño, MIME, actor y archivo inmutable",async()=>{
    const id=await createCredit();
    for(const fields of [{revision:0},{reviewHash:"invalid"},{sha256:"invalid"},{sha256:"b".repeat(64)},{sizeBytes:0},{sizeBytes:bytes.length+1},
      {mimeType:"application/pdf"},{fileName:" "},{actorName:" "},{actorKind:"USER",actorUserId:null},{actorKind:"SHARED_LINK",actorUserId:1},{actorKind:"OTHER"}])
      await assert.rejects(audio(id,fields),{code:"23514"});
    await assert.rejects(audio(id,{bytes:null}),{code:"23502"}); await assert.rejects(audio(id,{sha256:null}),{code:"23502"});
    const saved=await audio(id); assert.equal(saved.utc,true);
    for(const sql of ['UPDATE "CreditApprovalCallRecording" SET "fileName"=\'otro.wav\' WHERE "id"=$1','DELETE FROM "CreditApprovalCallRecording" WHERE "id"=$1'])
      await assert.rejects(db.query(sql,[saved.id]),{code:"23514"});
    await assert.rejects(db.query('TRUNCATE "CreditApprovalCallRecording" CASCADE'),{code:"23514"});
  });
  await t.test("solo último audio de mismo crédito, revisión y huella habilita OK y evento",async()=>{
    const id=await createCredit(),other=await createCredit(); const first=await audio(id),foreign=await audio(other);
    await db.query("BEGIN"); const second=await audio(id),third=await audio(id); await db.query("COMMIT");
    const ids=(await db.query('SELECT "id" FROM "CreditApprovalCallRecording" WHERE "creditoId"=$1 ORDER BY "createdAt" DESC,"id" DESC',[id])).rows.map(row=>row.id);
    assert.deepEqual(ids,[third.id,second.id,first.id]);
    for(const wrong of [null,foreign.id,first.id,second.id,randomUUID()]) await assert.rejects(approve(id,wrong),{code:"23514"});
    await assert.rejects(approve(id,third.id,db,"b".repeat(64)),{code:"23514"}); await approve(id,third.id);
    await assert.rejects(event(id,null),{code:"23514"}); await assert.rejects(event(id,first.id),{code:"23514"}); await event(id,third.id);
    await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)',[id]); await assert.rejects(audio(id),{code:"23514"});
  });
  await t.test("invalidación conserva audio pero limpia vínculo y exige nueva revisión",async()=>{
    const id=await createCredit(),saved=await audio(id); await approve(id,saved.id); await event(id,saved.id);
    await db.query('UPDATE "Credito" SET "fotoEntregaDataUrl"=\'new-delivery\' WHERE "id"=$1',[id]);
    const changed=await review(id); assert.equal(changed.status,"PENDING"); assert.equal(changed.callRecordingId,null); assert.equal(changed.revision,2);
    assert.equal((await db.query('SELECT "bytes" FROM "CreditApprovalCallRecording" WHERE "id"=$1',[saved.id])).rows[0].bytes.equals(bytes),true);
    await assert.rejects(approve(id,saved.id),{code:"23514"}); await assert.rejects(audio(id),{code:"23514"});
    const next=await audio(id,{revision:2}); await approve(id,next.id);
  });
  await t.test("OK anterior acepta actualización neutra y liquidación sin requerir audio retroactivo",async()=>{
    const original=await review(legacy); await db.query('UPDATE "CreditApprovalReview" SET "updatedAt"="updatedAt" WHERE "creditoId"=$1',[legacy]);
    assert.deepEqual(await review(legacy),original); await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)',[legacy]);
    assert.deepEqual(await review(legacy),original); await assert.rejects(approve(paid,null),{code:"23514"});
  });
  await t.test("rechaza grabaciones en cancelados, centrales y reemisión pendiente",async()=>{
    for(const state of ["ANULADO","ANULADA","CANCELADO","CANCELADA"]) {const id=await createCredit(); await db.query('UPDATE "Credito" SET "estado"=$2 WHERE "id"=$1',[id,state]); await assert.rejects(audio(id),{code:"23514"});}
    const central=await createCredit(); await db.query('UPDATE "Credito" SET "sedeId"=20 WHERE "id"=$1',[central]); await assert.rejects(audio(central,{revision:(await review(central)).revision}),{code:"23514"});
    const blocked=await createCredit(); await db.query('INSERT INTO "CreditApprovalReissue" VALUES ($1,\'AWAITING_SIGNATURE\')',[blocked]); await assert.rejects(audio(blocked),{code:"23514"});
  });
  await t.test("sesión compartida mantiene autoría y FK compuesta impide referencias mezcladas",async()=>{
    const grant=randomUUID(),session=randomUUID(); await db.query('INSERT INTO "CreditApprovalSharedGrant" ("id","issuedByUserId") VALUES ($1,1)',[grant]);
    await db.query(`INSERT INTO "CreditApprovalSharedSession" ("id","grantId","expiresAt") VALUES ($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '1 hour')`,[session,grant]);
    const id=await createCredit(),fields={actorKind:"SHARED_LINK",actorUserId:null,actorGrantId:grant,actorSessionId:session};
    await assert.rejects(audio(id,{...fields,actorGrantId:randomUUID()}),{code:"23503"}); const saved=await audio(id,fields);
    assert.equal((await db.query('SELECT "actorUserId" FROM "CreditApprovalCallRecording" WHERE "id"=$1',[saved.id])).rows[0].actorUserId,null);
  });
  await t.test("upload concurrente hace esperar OK y rechaza su identificador sustituido",async()=>{
    const id=await createCredit(),old=await audio(id),second=new pg.Client({connectionString}); await second.connect();
    try {
      await db.query("BEGIN"); const latest=await audio(id); await second.query("BEGIN"); await second.query("SET LOCAL lock_timeout='5s'");
      let acquired=false; const waiting=second.query('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE',[id]).then(()=>{acquired=true;});
      await db.query('SELECT 1'); assert.equal(acquired,false); await db.query("COMMIT"); await waiting;
      await assert.rejects(approve(id,old.id,second),{code:"23514"}); await second.query("ROLLBACK");
      assert.equal((await review(id)).status,"PENDING"); await approve(id,latest.id);
    } finally {await db.query("ROLLBACK");await second.query("ROLLBACK");await second.end();}
  });
});
