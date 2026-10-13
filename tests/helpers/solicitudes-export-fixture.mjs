export const EXPORT_FIXTURE_SQL = `
    CREATE TABLE "Aliado" (id integer PRIMARY KEY, nombre text);
    CREATE TABLE "Sede" (id integer PRIMARY KEY, nombre text, "aliadoId" integer);
    CREATE TABLE "Vendedor" (id integer PRIMARY KEY, nombre text);
    CREATE TABLE "SedeVendedor" ("sedeId" integer, "vendedorId" integer, activo boolean);
    CREATE TABLE "Credito" (
      id integer PRIMARY KEY, "sedeId" integer, "vendedorId" integer,
      folio text, "createdAt" timestamp, estado text, "fotoEntregaDataUrl" text,
      "fotoRemisionDataUrl" text, "deliverableReady" boolean,
      "clienteNombre" text, "clienteTipoDocumento" text, "clienteDocumento" text,
      "clienteTelefono" text, "clienteCorreo" text, "clienteDepartamento" text,
      "clienteCiudad" text, "clienteDireccion" text, "equipoMarca" text,
      "referenciaEquipo" text, "equipoModelo" text, imei text,
      "valorEquipoTotal" double precision, "cuotaInicial" double precision,
      "saldoBaseFinanciado" double precision, "plazoMeses" integer,
      "valorCuota" double precision, "frecuenciaPago" text,
      "fechaPrimerPago" timestamp, "contratoSnapshot" jsonb
    );
    CREATE TABLE "CreditoBorrador" (
      id integer PRIMARY KEY, "sedeId" integer, "vendedorId" integer,
      "creditoId" integer, "createdAt" timestamptz, estado text,
      "closedReason" text, "expiresAt" timestamptz, "currentStep" integer,
      "clienteNombre" text, "clienteDocumento" text, "clienteTelefono" text,
      imei text, plataforma text, payload jsonb DEFAULT '{}', "dataCreditoAssessmentId" uuid
    );
    CREATE TABLE "DataCreditoAssessment" (id uuid PRIMARY KEY, "creditId" integer, status text, "errorCode" text, platform text, "updatedAt" timestamptz);
    CREATE TABLE "VeriffIdentityValidation" (id integer PRIMARY KEY, "draftId" integer, status text, "updatedAt" timestamptz);
    CREATE TABLE "FirmaSeguroProcess" (id integer PRIMARY KEY, "draftId" integer, status text, "lastError" text, "updatedAt" timestamptz);
    CREATE TABLE "CreditSadminRegistration" ("creditoId" integer PRIMARY KEY, "numeroCredito" text, "numeroCreditoConfirmado" boolean);
    INSERT INTO "Aliado" VALUES (1,'Aliado Uno'),(2,'Aliado Dos');
    INSERT INTO "Sede" VALUES (10,'Centro',1),(11,'Norte',1),(20,'Externa',2);
    INSERT INTO "Vendedor" VALUES (100,'Ana'),(101,'Luis'),(200,'Externo'),(300,'Histórico');
    INSERT INTO "SedeVendedor" VALUES (10,100,true),(11,101,true),(20,200,true),(10,300,false);
    INSERT INTO "Credito" (id,"sedeId","vendedorId",folio,"createdAt",estado,"clienteNombre","clienteDocumento","clienteTelefono",imei,"valorEquipoTotal","cuotaInicial","saldoBaseFinanciado","plazoMeses","valorCuota","frecuenciaPago","fechaPrimerPago","contratoSnapshot") VALUES
      (1,10,100,'00001','2026-10-02 15:00:00','GENERADO','Ana Cliente','001.234.567','003001234567','001234567890123',1000000,200000,800000,12,85000,'QUINCENAL','2026-10-20','{"equipo":{"plataforma":"ANDROID"},"private":"DO_NOT_EXPORT"}'),
      (2,11,101,'00002','2026-10-31 23:59:59','GENERADO','Ana Cliente','001.234.567','003001234567','001234567890124',null,null,null,null,null,null,null,'{}'),
      (3,20,200,'00003','2026-10-16 15:00:00','GENERADO','Externa','99999','999','999',null,null,null,null,null,null,null,'{}'),
      (4,10,300,'00004','2026-11-01 04:59:59.999','GENERADO','Fin de mes','00004',null,null,null,null,null,null,null,null,null,'{}'),
      (5,10,100,'00005','2026-11-01 05:00:00','GENERADO','Otro mes','00005',null,null,null,null,null,null,null,null,null,'{}');
    INSERT INTO "CreditoBorrador" (id,"sedeId","vendedorId","creditoId","createdAt",estado,"closedReason","expiresAt","currentStep","clienteNombre","clienteDocumento","clienteTelefono",imei,plataforma,payload,"dataCreditoAssessmentId") VALUES
      (1,10,100,null,'2026-10-01 05:00:00+00','ABIERTO',null,'2099-01-01',2,'Misma cédula','001.234.567','00300','00123','ANDROID','{"clienteCorreo":"uno@example.test","equipoModelo":"Modelo","valorEquipoTotal":"1200000","cuotaInicial":"200000","plazoMeses":"12","cuotaComercial":"100000","fechaPrimerPago":"2026-10-20","private":"DO_NOT_EXPORT"}','00000000-0000-4000-8000-000000000001'),
      (2,10,100,null,'2026-10-01 04:59:59.999+00','CERRADO','RECHAZADA','2099-01-01',1,null,'00002',null,null,'IPHONE','{}','00000000-0000-4000-8000-000000000002'),
      (3,10,100,1,'2026-09-15 15:00:00+00','CERRADO','FINALIZADA','2099-01-01',5,'Ana Cliente','001234567',null,null,'ANDROID','{}',null),
      (4,10,100,1,'2026-09-16 15:00:00+00','CERRADO','FINALIZADA','2099-01-01',5,'Duplicado de relación','001234567',null,null,'ANDROID','{}',null),
      (5,20,200,null,'2026-10-01 05:00:00+00','ABIERTO',null,'2099-01-01',1,'Fuera','90000',null,null,'IPHONE','{}','00000000-0000-4000-8000-000000000003'),
      (6,10,100,null,'2026-10-01 05:00:00+00','ABIERTO',null,'2099-01-01',1,'Sin evaluación',null,null,null,null,'{}',null);
    INSERT INTO "DataCreditoAssessment" VALUES
      ('00000000-0000-4000-8000-000000000001',null,'APROBADO',null,'ANDROID','2026-10-01'),
      ('00000000-0000-4000-8000-000000000002',null,'RECHAZADO',null,'IPHONE','2026-10-01'),
      ('00000000-0000-4000-8000-000000000003',null,'PENDING',null,'IPHONE','2026-10-01'),
      ('00000000-0000-4000-8000-000000000004',1,'APROBADO',null,'ANDROID','2026-10-01'),
      ('00000000-0000-4000-8000-000000000005',1,'APROBADO',null,'ANDROID','2026-10-02');
    INSERT INTO "VeriffIdentityValidation" VALUES (1,1,'PENDING','2026-10-01'),(2,1,'APPROVED','2026-10-02');
    INSERT INTO "FirmaSeguroProcess" VALUES (1,1,'PENDING',null,'2026-10-01'),(2,1,'SIGNED',null,'2026-10-02');
    INSERT INTO "CreditSadminRegistration" VALUES (1,'000000123',true),(2,'000000999',false);
`;

// Current production retains assessment outcomes after provider-record cleanup
// and ignores signature processes replaced by a subsequent retry.
export const EXPORT_CURRENT_SCHEMA_SQL = `
  ALTER TABLE "CreditoBorrador" ADD COLUMN "dataCreditoStatus" text;
  ALTER TABLE "CreditoBorrador" ADD COLUMN "dataCreditoErrorCode" text;
  ALTER TABLE "FirmaSeguroProcess" ADD COLUMN "supersededAt" timestamptz;
  INSERT INTO "CreditoBorrador" (id,"sedeId","vendedorId","createdAt",estado,"closedReason","expiresAt","currentStep","clienteDocumento","dataCreditoStatus","dataCreditoErrorCode","dataCreditoAssessmentId") VALUES
    (20,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',2,'001.234.567','APROBADO',null,null),
    (21,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',2,'0021','NO_EVALUADO','RETAINED_ERROR',null),
    (22,10,100,'2026-10-05','CERRADO','DESISTIDO','2099-01-01',2,'001.234.567','APROBADO',null,null),
    (23,10,100,'2026-10-05','CERRADO','EXPIRADA','2099-01-01',2,'001.234.567','APROBADO',null,null),
    (24,10,100,'2026-10-05','CERRADO','DUPLICADA','2099-01-01',2,'001.234.567','APROBADO',null,null),
    (25,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',2,'0025','RECHAZADO',null,null),
    (26,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',1,'0026',null,null,'00000000-0000-4000-8000-999999999999'),
    (27,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',4,'0027','APROBADO',null,null),
    (28,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',5,'0028','APROBADO',null,null),
    (29,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',2,'0029','APROBADO',null,null),
    (30,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',3,'0030','APROBADO',null,null),
    (31,10,100,'2026-10-05','ABIERTO',null,'2099-01-01',2,'0031','RECHAZADO','RETAINED_ERROR','00000000-0000-4000-8000-000000000001');
  INSERT INTO "VeriffIdentityValidation" VALUES
    (20,28,'PENDING','2026-10-05'),
    (30,31,'ERROR','2026-10-07'),
    (31,31,'APPROVED','2026-10-06');
  INSERT INTO "FirmaSeguroProcess" VALUES
    (20,29,'SIGNED',null,'2026-10-05',null),
    (21,29,'FAILED','SUPERSEDED_ERROR','2026-10-06','2026-10-06');
  UPDATE "Credito" SET "sedeId" = 11 WHERE id = 1;
  UPDATE "Credito" SET estado = 'CANCELADO' WHERE id = 3;
`;
