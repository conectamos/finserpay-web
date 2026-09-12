import assert from "node:assert/strict";
import { installCreditApprovalSchema } from "../scripts/credit-approval-schema.mjs";
import { installCreditApprovalReissueSchema } from "../scripts/credit-approval-reissue-schema.mjs";
import { installCreditApprovalActorSchema } from "../scripts/credit-approval-actor-schema.mjs";
import { installCreditApprovalNoveltiesSchema } from "../scripts/credit-approval-novelties-schema.mjs";
import { installApprovalSharedSchema } from "../scripts/approval-shared-schema.mjs";
import { installCreditApprovalCallSchema } from "../scripts/credit-approval-call-schema.mjs";

/** Only the dedicated local call test database may be prepared with these fixtures. */
export async function prepareCallIntegrationFixture(client, connectionString) {
  const url=new URL(connectionString);
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname));
  assert.equal(url.pathname,"/approval_call_test");
  const tables=["CreditApprovalCallRecording","CreditApprovalNoveltyEvent","CreditApprovalNoveltyItem","CreditApprovalNovelty","CreditApprovalSharedSession","CreditApprovalSharedGrant","CreditApprovalReissueEvent","CreditApprovalReissue","CreditApprovalEvent","CreditApprovalReview","CreditApprovalPolicy","FirmaSeguroProcess","DataCreditoAssessment","LiquidacionAliadoCredito","CreditoAmortizacion","Credito","Usuario","Sede","Aliado"];
  const existing=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(existing.rows.every(({tablename})=>tables.includes(tablename)),"No se reinician bases con tablas ajenas");
  for(const table of tables)await client.query('DROP TABLE IF EXISTS public."'+table+'" CASCADE');
  await client.query(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (7);
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"codigo" TEXT,"nombre" TEXT);
    INSERT INTO "Aliado" VALUES (10,'ALLY','Aliado sintético'),(20,'FINSERPAY','Central');
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER);
    INSERT INTO "Sede" VALUES (10,10),(20,20);
    CREATE TABLE "Credito" (
      "id" SERIAL PRIMARY KEY,"folio" TEXT DEFAULT 'TEST',"clienteNombre" TEXT DEFAULT 'Cliente sintético',
      "clienteDocumento" TEXT DEFAULT '100000001',"clienteCorreo" TEXT,"clienteTelefono" TEXT,
      "clienteDepartamento" TEXT,"clienteCiudad" TEXT,"clienteDireccion" TEXT,
      "plazoMeses" INTEGER,"frecuenciaPago" TEXT,"valorCuota" FLOAT,"fechaPrimerPago" TIMESTAMP(3),
      "fechaCredito" TIMESTAMP DEFAULT '2026-09-10T12:00:00',
      "createdAt" TIMESTAMP(3) DEFAULT '2099-01-01T00:00:00',"updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
      "estado" TEXT DEFAULT 'ACTIVO',"sedeId" INTEGER DEFAULT 10,"imei" TEXT DEFAULT '000000000000001',
      "referenciaEquipo" TEXT DEFAULT 'Samsung Sintético',"equipoMarca" TEXT DEFAULT 'Samsung',"equipoModelo" TEXT DEFAULT 'Sintético',
      "valorEquipoTotal" FLOAT DEFAULT 1000000,"cuotaInicial" FLOAT DEFAULT 200000,
      "saldoBaseFinanciado" FLOAT DEFAULT 800000,"montoCredito" FLOAT DEFAULT 800000,"equalityService" TEXT,
      "contratoSnapshot" JSONB DEFAULT '{"equipo":{"plataforma":"ANDROID"},"financiero":{"condicion":"original"},"firma":{"valor":"original"}}',
      "contratoCedulaFrenteDataUrl" TEXT,"contratoCedulaRespaldoDataUrl" TEXT,"iphoneSelfieCedulaDataUrl" TEXT,
      "fotoEntregaDataUrl" TEXT,"fotoRemisionDataUrl" TEXT
    );
    CREATE TABLE "CreditoAmortizacion" ("creditoId" INTEGER PRIMARY KEY REFERENCES "Credito"("id"),"cuotaComercial" NUMERIC(20,2));
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER UNIQUE REFERENCES "Credito"("id"));
    CREATE TABLE "DataCreditoAssessment" ("id" TEXT PRIMARY KEY,"creditId" INTEGER,"score" INTEGER,"offer" JSONB,
      "status" TEXT,"consumedAt" TIMESTAMP,"retainedUntil" TIMESTAMP);
    CREATE TABLE "FirmaSeguroProcess" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER,"processUuid" TEXT,
      "status" TEXT,"signedDocumentBase64" TEXT,"signedDocumentFileName" TEXT,"draftPayload" JSONB,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"completedAt" TIMESTAMP,"supersededAt" TIMESTAMP);
  `);
  await installCreditApprovalSchema(client);
  await installCreditApprovalReissueSchema(client);
  await installCreditApprovalActorSchema(client);
  await installCreditApprovalNoveltiesSchema(client);
  await installApprovalSharedSchema(client);
  await installCreditApprovalCallSchema(client);
}
