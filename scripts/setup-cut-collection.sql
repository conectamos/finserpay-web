BEGIN;
CREATE TABLE IF NOT EXISTS "CutCollectionProjection" (
  id UUID PRIMARY KEY,
  "requestKey" UUID NOT NULL,
  "createdBy" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cutDate" DATE NOT NULL,
  "scopeSedeIds" INTEGER[] NOT NULL,
  snapshot JSONB NOT NULL,
  CONSTRAINT "CutCollectionProjection_request" UNIQUE ("createdBy", "requestKey"),
  CONSTRAINT "CutCollectionProjection_day" CHECK (EXTRACT(DAY FROM "cutDate") IN (2,17)),
  CONSTRAINT "CutCollectionProjection_version" CHECK (snapshot->>'version' = '1')
);
CREATE INDEX IF NOT EXISTS "CutCollectionProjection_cut_created" ON "CutCollectionProjection" ("cutDate", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "CutCollectionProjection_scope" ON "CutCollectionProjection" USING GIN ("scopeSedeIds");
CREATE OR REPLACE FUNCTION finser_cut_projection_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Las proyecciones son inmutables; guarde una nueva versión.';
END;
$$;
DROP TRIGGER IF EXISTS "CutCollectionProjection_immutable" ON "CutCollectionProjection";
CREATE TRIGGER "CutCollectionProjection_immutable" BEFORE UPDATE OR DELETE ON "CutCollectionProjection"
FOR EACH ROW EXECUTE FUNCTION finser_cut_projection_immutable();
COMMIT;
