// Additive only: no historic customer, credit, sale, or payment is rewritten.
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
  `CREATE INDEX IF NOT EXISTS "ListaNegraDocumentoEvento_registroId_createdAt_idx" ON public."ListaNegraDocumentoEvento" ("registroId", "createdAt")`,
  `CREATE OR REPLACE FUNCTION public."prevent_blacklist_event_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'ListaNegraDocumentoEvento is append-only'; END;
  $$`,
  `DROP TRIGGER IF EXISTS "ListaNegraDocumentoEvento_immutable" ON public."ListaNegraDocumentoEvento"`,
  `CREATE TRIGGER "ListaNegraDocumentoEvento_immutable" BEFORE UPDATE OR DELETE ON public."ListaNegraDocumentoEvento"
    FOR EACH ROW EXECUTE FUNCTION public."prevent_blacklist_event_mutation"()`,
  `ALTER TABLE public."Venta" ADD COLUMN IF NOT EXISTS "clienteDocumento" TEXT`,
  // Verify the columns consumed by the application even on a pre-existing schema.
  `SELECT "id", "documento", "motivo", "activa", "version", "createdByUserId", "createdByName", "updatedByUserId", "updatedByName", "createdAt", "updatedAt" FROM public."ListaNegraDocumento" LIMIT 0`,
  `SELECT "id", "registroId", "mutationId", "requestHash", "accion", "motivo", "actorUserId", "actorName", "before", "after", "createdAt" FROM public."ListaNegraDocumentoEvento" LIMIT 0`,
];
