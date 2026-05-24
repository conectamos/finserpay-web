BEGIN;

INSERT INTO "Rol" ("nombre", "descripcion", "createdAt", "updatedAt")
VALUES
  ('ADMIN', 'Administrador del sistema', NOW(), NOW()),
  ('USUARIO', 'Usuario operativo por sede', NOW(), NOW())
ON CONFLICT ("nombre") DO UPDATE
SET
  "descripcion" = EXCLUDED."descripcion",
  "updatedAt" = NOW();

INSERT INTO "Aliado" ("nombre", "codigo", "activo", "createdAt", "updatedAt")
VALUES
  ('FINSER PAY', 'FINSERPAY', true, NOW(), NOW()),
  ('CONECTAMOS', 'CONECTAMOS', true, NOW(), NOW())
ON CONFLICT ("nombre") DO UPDATE
SET
  "codigo" = EXCLUDED."codigo",
  "activo" = EXCLUDED."activo",
  "updatedAt" = NOW();

ALTER TABLE "Sede" DROP CONSTRAINT IF EXISTS "Sede_nombre_key";
ALTER TABLE "Sede" DROP CONSTRAINT IF EXISTS "Sede_codigo_key";
DROP INDEX IF EXISTS "Sede_nombre_key";
DROP INDEX IF EXISTS "Sede_codigo_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Sede_aliadoId_nombre_key"
  ON "Sede" ("aliadoId", "nombre");

CREATE UNIQUE INDEX IF NOT EXISTS "Sede_aliadoId_codigo_key"
  ON "Sede" ("aliadoId", "codigo");

INSERT INTO "Sede" ("nombre", "codigo", "aliadoId", "activa", "clavePanelFinancieroHash", "createdAt", "updatedAt")
VALUES
  ('BODEGA PRINCIPAL', 'BODEGA-PRINCIPAL', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('SEDE 1', 'SEDE-1', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('SEDE 2', 'SEDE-2', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('SEDE 3', 'SEDE-3', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('SEDE 4', 'SEDE-4', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('SEDE 5', 'SEDE-5', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('SEDE 6', 'SEDE-6', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('SEDE 7', 'SEDE-7', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('ONLINE', 'ONLINE', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('TROPAS', 'TROPAS', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('Stand PuntoNet', 'STAND-PUNTONET', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('Stand Monky', 'STAND-MONKY', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW()),
  ('Stand Solutions', 'STAND-SOLUTIONS', (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS'), true, NULL, NOW(), NOW())
ON CONFLICT ("aliadoId", "nombre") DO UPDATE
SET
  "codigo" = EXCLUDED."codigo",
  "aliadoId" = EXCLUDED."aliadoId",
  "activa" = EXCLUDED."activa",
  "updatedAt" = NOW();

UPDATE "Sede"
SET
  "aliadoId" = (SELECT "id" FROM "Aliado" WHERE "nombre" = 'FINSER PAY'),
  "codigo" = 'ADMIN-FINSERPAY',
  "activa" = true,
  "updatedAt" = NOW()
WHERE
  "nombre" = 'ADMIN FINSER PAY'
  OR "codigo" = 'ADMIN-FINSERPAY';

UPDATE "Sede"
SET
  "aliadoId" = (SELECT "id" FROM "Aliado" WHERE "nombre" = 'FINSER PAY'),
  "nombre" = 'RECAUDO DIGITAL FINSER PAY',
  "codigo" = 'RECAUDO_DIGITAL',
  "activa" = true,
  "updatedAt" = NOW()
WHERE
  "codigo" = 'RECAUDO_DIGITAL'
  OR "nombre" = 'RECAUDO DIGITAL FINSER PAY';

UPDATE "Sede"
SET
  "aliadoId" = (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS')
WHERE
  "aliadoId" IS NULL
  AND COALESCE("nombre", '') NOT IN ('ADMIN FINSER PAY', 'RECAUDO DIGITAL FINSER PAY')
  AND COALESCE("codigo", '') NOT IN ('ADMIN-FINSERPAY', 'RECAUDO_DIGITAL');

INSERT INTO "Sede" ("nombre", "codigo", "aliadoId", "activa", "clavePanelFinancieroHash", "createdAt", "updatedAt")
VALUES (
  'ADMIN FINSER PAY',
  'ADMIN-FINSERPAY',
  (SELECT "id" FROM "Aliado" WHERE "nombre" = 'FINSER PAY'),
  true,
  NULL,
  NOW(),
  NOW()
)
ON CONFLICT ("aliadoId", "nombre") DO UPDATE
SET
  "codigo" = EXCLUDED."codigo",
  "aliadoId" = EXCLUDED."aliadoId",
  "activa" = true,
  "updatedAt" = NOW();

UPDATE "Usuario"
SET
  "sedeId" = (SELECT "id" FROM "Sede" WHERE "nombre" = 'ADMIN FINSER PAY'),
  "activo" = true,
  "updatedAt" = NOW()
WHERE
  "usuario" = 'admin'
  AND "rolId" = (SELECT "id" FROM "Rol" WHERE "nombre" = 'ADMIN');

INSERT INTO "Usuario" ("nombre", "usuario", "claveHash", "activo", "rolId", "sedeId", "createdAt", "updatedAt")
SELECT
  data.nombre,
  data.usuario,
  data.clave,
  true,
  rol.id,
  sede.id,
  NOW(),
  NOW()
FROM (
  VALUES
    ('Administrador', 'admin', '123456', 'ADMIN', 'BODEGA PRINCIPAL'),
    ('Usuario Sede 1', 'sede1', '123456', 'USUARIO', 'SEDE 1'),
    ('Usuario Sede 2', 'sede2', '123456', 'USUARIO', 'SEDE 2'),
    ('Usuario Sede 3', 'sede3', '123456', 'USUARIO', 'SEDE 3'),
    ('Usuario Sede 4', 'sede4', '123456', 'USUARIO', 'SEDE 4'),
    ('Usuario Sede 5', 'sede5', '123456', 'USUARIO', 'SEDE 5'),
    ('Usuario Sede 6', 'sede6', '123456', 'USUARIO', 'SEDE 6'),
    ('Usuario Sede 7', 'sede7', '123456', 'USUARIO', 'SEDE 7'),
    ('Usuario Online', 'online', '123456', 'USUARIO', 'ONLINE'),
    ('Usuario Tropas', 'tropas', '123456', 'USUARIO', 'TROPAS'),
    ('Usuario Stand PuntoNet', 'standpuntonet', '123456', 'USUARIO', 'Stand PuntoNet'),
    ('Usuario Stand Monky', 'standmonky', '123456', 'USUARIO', 'Stand Monky'),
    ('Usuario Stand Solutions', 'standsolutions', '123456', 'USUARIO', 'Stand Solutions')
) AS data(nombre, usuario, clave, rol_nombre, sede_nombre)
JOIN "Rol" rol
  ON rol."nombre" = data.rol_nombre
JOIN "Sede" sede
  ON sede."nombre" = data.sede_nombre
ON CONFLICT ("usuario") DO UPDATE
SET
  "nombre" = EXCLUDED."nombre",
  "claveHash" = EXCLUDED."claveHash",
  "activo" = EXCLUDED."activo",
  "rolId" = EXCLUDED."rolId",
  "sedeId" = EXCLUDED."sedeId",
  "updatedAt" = NOW();

COMMIT;
