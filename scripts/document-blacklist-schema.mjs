// Schema changes only: no historic customer, credit, sale, or payment is rewritten.
export const blacklistSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."ListaNegraDocumento" (
    "id" UUID PRIMARY KEY,
    "documento" VARCHAR(13) NOT NULL UNIQUE CHECK ("documento" ~ '^[1-9][0-9]{2,12}$'),
    "motivo" TEXT NOT NULL CHECK (char_length(btrim("motivo")) BETWEEN 5 AND 500),
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
    "createdByUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "createdByName" TEXT NOT NULL,
    "updatedByUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "updatedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE public."ListaNegraDocumento" ADD COLUMN IF NOT EXISTS "eliminadaAt" TIMESTAMPTZ`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ListaNegraDocumento_deleted_inactive_check'
    AND conrelid='public."ListaNegraDocumento"'::regclass) THEN
    ALTER TABLE public."ListaNegraDocumento" ADD CONSTRAINT "ListaNegraDocumento_deleted_inactive_check"
    CHECK ("eliminadaAt" IS NULL OR NOT "activa"); END IF; END $$`,
  `CREATE INDEX IF NOT EXISTS "ListaNegraDocumento_activa_updatedAt_idx" ON public."ListaNegraDocumento" ("activa", "updatedAt")`,
  `CREATE TABLE IF NOT EXISTS public."ListaNegraDocumentoEvento" (
    "id" UUID PRIMARY KEY,
    "registroId" UUID NOT NULL REFERENCES public."ListaNegraDocumento"("id") ON DELETE RESTRICT,
    "mutationId" UUID NOT NULL UNIQUE,
    "requestHash" CHAR(64) NOT NULL,
    "accion" TEXT NOT NULL CHECK ("accion" IN ('BLOQUEAR', 'DESBLOQUEAR')),
    "motivo" TEXT NOT NULL CHECK (char_length(btrim("motivo")) BETWEEN 5 AND 500),
    "actorUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "actorName" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE public."ListaNegraDocumentoEvento" DROP CONSTRAINT IF EXISTS "ListaNegraDocumentoEvento_accion_check"`,
  `ALTER TABLE public."ListaNegraDocumentoEvento" ADD CONSTRAINT "ListaNegraDocumentoEvento_accion_check"
    CHECK ("accion" IN ('BLOQUEAR','DESBLOQUEAR','ELIMINAR'))`,
  `CREATE INDEX IF NOT EXISTS "ListaNegraDocumentoEvento_registroId_createdAt_idx" ON public."ListaNegraDocumentoEvento" ("registroId", "createdAt")`,
  `CREATE OR REPLACE FUNCTION public."prevent_blacklist_event_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'ListaNegraDocumentoEvento is append-only'; END;
  $$`,
  `DROP TRIGGER IF EXISTS "ListaNegraDocumentoEvento_immutable" ON public."ListaNegraDocumentoEvento"`,
  `CREATE TRIGGER "ListaNegraDocumentoEvento_immutable" BEFORE UPDATE OR DELETE ON public."ListaNegraDocumentoEvento"
    FOR EACH ROW EXECUTE FUNCTION public."prevent_blacklist_event_mutation"()`,
  `CREATE TABLE IF NOT EXISTS public."ListaNegraImportacion" (
    "id" UUID PRIMARY KEY,
    "requestHash" CHAR(64) NOT NULL,
    "actorUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "actorName" TEXT NOT NULL,
    "motivo" TEXT NOT NULL CHECK (char_length(btrim("motivo")) BETWEEN 5 AND 500),
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE OR REPLACE FUNCTION public."prevent_blacklist_import_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'ListaNegraImportacion is append-only'; END;
  $$`,
  `DROP TRIGGER IF EXISTS "ListaNegraImportacion_immutable" ON public."ListaNegraImportacion"`,
  `CREATE TRIGGER "ListaNegraImportacion_immutable" BEFORE UPDATE OR DELETE ON public."ListaNegraImportacion"
    FOR EACH ROW EXECUTE FUNCTION public."prevent_blacklist_import_mutation"()`,
  `SELECT "id", "requestHash", "actorUserId", "actorName", "motivo", "result", "createdAt" FROM public."ListaNegraImportacion" LIMIT 0`,
  `CREATE TABLE IF NOT EXISTS public."ListaNegraLimpieza" (
    "id" UUID PRIMARY KEY, "requestHash" CHAR(64) NOT NULL,
    "actorUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "actorName" TEXT NOT NULL, "motivo" TEXT NOT NULL CHECK (char_length(btrim("motivo")) BETWEEN 5 AND 500),
    "result" JSONB NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `DROP TRIGGER IF EXISTS "ListaNegraLimpieza_immutable" ON public."ListaNegraLimpieza"`,
  `CREATE TRIGGER "ListaNegraLimpieza_immutable" BEFORE UPDATE OR DELETE ON public."ListaNegraLimpieza"
    FOR EACH ROW EXECUTE FUNCTION public."prevent_blacklist_import_mutation"()`,
  `SELECT "id","requestHash","actorUserId","actorName","motivo","result","createdAt" FROM public."ListaNegraLimpieza" LIMIT 0`,
  `ALTER TABLE public."Venta" ADD COLUMN IF NOT EXISTS "clienteDocumento" TEXT`,
  // Verify the columns consumed by the application even on a pre-existing schema.
  `SELECT "id", "documento", "motivo", "activa", "version", "createdByUserId", "createdByName", "updatedByUserId", "updatedByName", "createdAt", "updatedAt", "eliminadaAt" FROM public."ListaNegraDocumento" LIMIT 0`,
  `SELECT "id", "registroId", "mutationId", "requestHash", "accion", "motivo", "actorUserId", "actorName", "before", "after", "createdAt" FROM public."ListaNegraDocumentoEvento" LIMIT 0`,
];
