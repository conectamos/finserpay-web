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

INSERT INTO "Aliado" ("nombre", "codigo", "activo", "createdAt", "updatedAt")
VALUES
  ('CONECTAMOS', 'CONECTAMOS', true, NOW(), NOW())
ON CONFLICT ("nombre") DO UPDATE
SET
  "codigo" = EXCLUDED."codigo",
  "activo" = EXCLUDED."activo",
  "updatedAt" = NOW();

UPDATE "Sede"
SET
  "aliadoId" = (SELECT "id" FROM "Aliado" WHERE "nombre" = 'CONECTAMOS')
WHERE
  "aliadoId" IS NULL;

COMMIT;
