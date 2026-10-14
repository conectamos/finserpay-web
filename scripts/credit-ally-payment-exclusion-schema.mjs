// Operational exclusions are separate from the signed credit snapshot. Only
// explicitly registered credit IDs are excluded; ordinary imports stay eligible.
export const creditAllyPaymentExclusionSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditAllyPaymentExclusion" (
    "creditoId" INTEGER PRIMARY KEY,
    "reason" TEXT NOT NULL CHECK (LENGTH(BTRIM("reason")) > 0),
    "sourceFile" TEXT NOT NULL CHECK (LENGTH(BTRIM("sourceFile")) > 0),
    "sourceSha256" CHAR(64) NOT NULL CHECK ("sourceSha256" ~ '^[0-9a-f]{64}$'),
    "sourceSheet" TEXT NOT NULL CHECK (LENGTH(BTRIM("sourceSheet")) > 0),
    "sourceRow" INTEGER NOT NULL CHECK ("sourceRow" > 0),
    "createdBy" TEXT NOT NULL CHECK (LENGTH(BTRIM("createdBy")) > 0),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "CreditAllyPaymentExclusion_creditoId_fkey"
      FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE OR REPLACE FUNCTION public.credit_ally_payment_exclusion_guard_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM public."Credito" WHERE "id" = NEW."creditoId" FOR UPDATE;
      IF EXISTS (SELECT 1 FROM public."LiquidacionAliadoCredito" WHERE "creditoId" = NEW."creditoId") THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_CREDIT_ALREADY_SETTLED' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditAllyPaymentExclusion_require_unsettled"
    BEFORE INSERT ON public."CreditAllyPaymentExclusion"
    FOR EACH ROW EXECUTE FUNCTION public.credit_ally_payment_exclusion_guard_insert()`,
  `CREATE OR REPLACE FUNCTION public.credit_ally_payment_exclusion_reject_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ALLY_PAYMENT_EXCLUSION_IMMUTABLE' USING ERRCODE = '23514';
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditAllyPaymentExclusion_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditAllyPaymentExclusion"
    FOR EACH ROW EXECUTE FUNCTION public.credit_ally_payment_exclusion_reject_mutation()`,
  `CREATE OR REPLACE TRIGGER "CreditAllyPaymentExclusion_no_truncate"
    BEFORE TRUNCATE ON public."CreditAllyPaymentExclusion"
    FOR EACH STATEMENT EXECUTE FUNCTION public.credit_ally_payment_exclusion_reject_mutation()`,
  `CREATE OR REPLACE FUNCTION public.credit_ally_payment_guard_exclusion()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      actual_credit_id INTEGER;
      attribution_owner VARCHAR(16);
      attribution_ally_id INTEGER;
      settlement_ally_id INTEGER;
    BEGIN
      IF TG_TABLE_NAME = 'LiquidacionAliadoRecaudo' THEN
        SELECT payment."creditoId", attribution."titularTipo", attribution."aliadoId"
        INTO actual_credit_id, attribution_owner, attribution_ally_id
        FROM public."CreditoAbono" payment
        LEFT JOIN public."CreditoAbonoAtribucionAliado" attribution
          ON attribution."abonoId" = payment."id"
        WHERE payment."id" = NEW."abonoId";
        IF actual_credit_id IS DISTINCT FROM NEW."creditoId" THEN
          RAISE EXCEPTION 'ALLY_PAYMENT_COLLECTION_CREDIT_MISMATCH' USING ERRCODE = '23514';
        END IF;
        IF attribution_owner IS DISTINCT FROM 'ALIADO' THEN
          RAISE EXCEPTION 'ALLY_PAYMENT_COLLECTION_NOT_OWNED_BY_ALLY' USING ERRCODE = '23514';
        END IF;
        SELECT "aliadoId" INTO settlement_ally_id
        FROM public."LiquidacionAliado" WHERE "id" = NEW."liquidacionId";
        IF settlement_ally_id IS DISTINCT FROM attribution_ally_id THEN
          RAISE EXCEPTION 'ALLY_PAYMENT_COLLECTION_ALLY_MISMATCH' USING ERRCODE = '23514';
        END IF;
        -- Una exclusión impide pagar el crédito, no descontar dinero que el
        -- aliado efectivamente recibió por él.
        PERFORM 1 FROM public."Credito" WHERE "id" = actual_credit_id FOR UPDATE;
        RETURN NEW;
      END IF;
      -- Exclusion registration takes this lock too, serializing concurrent inserts.
      PERFORM 1 FROM public."Credito" WHERE "id" = NEW."creditoId" FOR UPDATE;
      IF EXISTS (SELECT 1 FROM public."CreditAllyPaymentExclusion"
        WHERE "creditoId" = NEW."creditoId") THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_CREDIT_EXCLUDED' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "LiquidacionAliadoCredito_require_not_excluded"
    BEFORE INSERT ON public."LiquidacionAliadoCredito"
    FOR EACH ROW EXECUTE FUNCTION public.credit_ally_payment_guard_exclusion()`,
  `CREATE OR REPLACE TRIGGER "LiquidacionAliadoRecaudo_require_not_excluded"
    BEFORE INSERT ON public."LiquidacionAliadoRecaudo"
    FOR EACH ROW EXECUTE FUNCTION public.credit_ally_payment_guard_exclusion()`,
];
