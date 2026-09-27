// Dedicated permissions only: no legacy exemption, customer, credit, or payment is imported or changed.
export const secondCreditAuthorizationSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."SecondCreditAuthorization" (
    "id" UUID PRIMARY KEY,
    "documento" VARCHAR(13) NOT NULL UNIQUE CHECK ("documento" ~ '^[1-9][0-9]{2,12}$'),
    "active" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL CHECK (char_length(btrim("reason")) BETWEEN 5 AND 500),
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
    "createdByUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "createdByName" TEXT NOT NULL,
    "updatedByUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "updatedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS public."SecondCreditAuthorizationEvent" (
    "id" UUID PRIMARY KEY,
    "authorizationId" UUID NOT NULL REFERENCES public."SecondCreditAuthorization"("id") ON DELETE RESTRICT,
    "mutationId" UUID NOT NULL UNIQUE,
    "requestHash" CHAR(64) NOT NULL,
    "action" TEXT NOT NULL CHECK ("action" IN ('AUTHORIZE', 'REVOKE')),
    "reason" TEXT NOT NULL CHECK (char_length(btrim("reason")) BETWEEN 5 AND 500),
    "actorUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "actorName" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "SecondCreditAuthorizationEvent_authorizationId_createdAt_idx"
    ON public."SecondCreditAuthorizationEvent" ("authorizationId", "createdAt")`,
  `CREATE OR REPLACE FUNCTION public."prevent_second_credit_authorization_event_mutation"()
    RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SecondCreditAuthorizationEvent is append-only'; END;
    $$`,
  `DROP TRIGGER IF EXISTS "SecondCreditAuthorizationEvent_immutable" ON public."SecondCreditAuthorizationEvent"`,
  `CREATE TRIGGER "SecondCreditAuthorizationEvent_immutable" BEFORE UPDATE OR DELETE ON public."SecondCreditAuthorizationEvent"
    FOR EACH ROW EXECUTE FUNCTION public."prevent_second_credit_authorization_event_mutation"()`,
  `SELECT "id", "documento", "active", "reason", "version", "createdByUserId", "createdByName",
    "updatedByUserId", "updatedByName", "createdAt", "updatedAt" FROM public."SecondCreditAuthorization" LIMIT 0`,
  `SELECT "id", "authorizationId", "mutationId", "requestHash", "action", "reason", "actorUserId", "actorName", "before", "after", "createdAt"
    FROM public."SecondCreditAuthorizationEvent" LIMIT 0`,
];