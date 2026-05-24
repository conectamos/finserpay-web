BEGIN;

CREATE TABLE IF NOT EXISTS "Aliado" (
  "id" SERIAL PRIMARY KEY,
  "nombre" TEXT NOT NULL,
  "codigo" TEXT,
  "activo" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "Aliado_nombre_key"
  ON "Aliado" ("nombre");

CREATE UNIQUE INDEX IF NOT EXISTS "Aliado_codigo_key"
  ON "Aliado" ("codigo");

CREATE INDEX IF NOT EXISTS "Aliado_activo_idx"
  ON "Aliado" ("activo");

ALTER TABLE "Sede"
  ADD COLUMN IF NOT EXISTS "aliadoId" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Sede_aliadoId_fkey'
  ) THEN
    ALTER TABLE "Sede"
      ADD CONSTRAINT "Sede_aliadoId_fkey"
      FOREIGN KEY ("aliadoId") REFERENCES "Aliado"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "Sede_aliadoId_idx"
  ON "Sede" ("aliadoId");

ALTER TABLE "Sede" DROP CONSTRAINT IF EXISTS "Sede_nombre_key";
ALTER TABLE "Sede" DROP CONSTRAINT IF EXISTS "Sede_codigo_key";
DROP INDEX IF EXISTS "Sede_nombre_key";
DROP INDEX IF EXISTS "Sede_codigo_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Sede_aliadoId_nombre_key"
  ON "Sede" ("aliadoId", "nombre");

CREATE UNIQUE INDEX IF NOT EXISTS "Sede_aliadoId_codigo_key"
  ON "Sede" ("aliadoId", "codigo");

INSERT INTO "Aliado" ("nombre", "codigo", "activo", "createdAt", "updatedAt")
VALUES
  ('FINSER PAY', 'FINSERPAY', true, NOW(), NOW()),
  ('CONECTAMOS', 'CONECTAMOS', true, NOW(), NOW())
ON CONFLICT ("nombre") DO UPDATE
SET
  "codigo" = EXCLUDED."codigo",
  "activo" = EXCLUDED."activo",
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

INSERT INTO "Sede" ("nombre", "codigo", "aliadoId", "activa", "createdAt", "updatedAt")
VALUES (
  'ADMIN FINSER PAY',
  'ADMIN-FINSERPAY',
  (SELECT "id" FROM "Aliado" WHERE "nombre" = 'FINSER PAY'),
  true,
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

COMMIT;
