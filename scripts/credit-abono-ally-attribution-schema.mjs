// A payment's accounting site remains untouched. This immutable attribution
// only determines whether it can be deducted from an ally settlement.
const creditAbonoAllyAttributionConsistencyValidation = `DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM public."CreditoAbono" payment
      LEFT JOIN public."CreditoAbonoAtribucionAliado" attribution
        ON attribution."abonoId" = payment."id"
      WHERE attribution."abonoId" IS NULL
    ) THEN
      RAISE EXCEPTION 'ALLY_PAYMENT_ATTRIBUTION_INCOMPLETE' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public."LiquidacionAliadoRecaudo" snapshot
      INNER JOIN public."LiquidacionAliado" settlement ON settlement."id" = snapshot."liquidacionId"
      INNER JOIN public."CreditoAbonoAtribucionAliado" attribution
        ON attribution."abonoId" = snapshot."abonoId"
      WHERE attribution."titularTipo" <> 'ALIADO'
        OR attribution."aliadoId" IS DISTINCT FROM settlement."aliadoId"
    ) THEN
      RAISE EXCEPTION 'ALLY_PAYMENT_PAID_ATTRIBUTION_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END $$`;

export const creditAbonoAllyAttributionSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditoAbonoAtribucionAliado" (
    "abonoId" INTEGER PRIMARY KEY,
    "titularTipo" VARCHAR(16) NOT NULL,
    "aliadoId" INTEGER,
    "fuente" VARCHAR(40) NOT NULL,
    "actorAliadoIdSnapshot" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "CreditoAbonoAtribucionAliado_abonoId_fkey"
      FOREIGN KEY ("abonoId") REFERENCES public."CreditoAbono"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CreditoAbonoAtribucionAliado_aliadoId_fkey"
      FOREIGN KEY ("aliadoId") REFERENCES public."Aliado"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CreditoAbonoAtribucionAliado_titular_check"
      CHECK (
        ("titularTipo" = 'FINSER_PAY' AND "aliadoId" IS NULL)
        OR ("titularTipo" = 'ALIADO' AND "aliadoId" IS NOT NULL)
      ),
    CONSTRAINT "CreditoAbonoAtribucionAliado_fuente_check"
      CHECK ("fuente" IN (
        'TRIGGER_SEDE_CENTRAL',
        'TRIGGER_ADMIN_CENTRAL',
        'TRIGGER_SEDE_ALIADA',
        'TRIGGER_SIN_ALIADO',
        'LEGACY_LIQUIDADO',
        'LEGACY_SEDE_CENTRAL',
        'LEGACY_ADMIN_CANONICO',
        'LEGACY_SEDE_ALIADA',
        'LEGACY_SIN_ALIADO'
      ))
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditoAbonoAtribucionAliado_titular_aliado_abono_idx"
    ON public."CreditoAbonoAtribucionAliado" ("titularTipo", "aliadoId", "abonoId")`,
  `CREATE OR REPLACE FUNCTION public.credit_abono_assign_ally_attribution()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      payment_ally_id INTEGER;
      payment_ally_code TEXT;
      actor_username TEXT;
      actor_role TEXT;
      actor_ally_id INTEGER;
      actor_ally_code TEXT;
      owner_type VARCHAR(16);
      owner_ally_id INTEGER;
      attribution_source VARCHAR(40);
    BEGIN
      SELECT site."aliadoId", ally."codigo"
      INTO payment_ally_id, payment_ally_code
      FROM public."Sede" site
      LEFT JOIN public."Aliado" ally ON ally."id" = site."aliadoId"
      WHERE site."id" = NEW."sedeId";

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_ATTRIBUTION_SITE_NOT_FOUND' USING ERRCODE = '23514';
      END IF;

      SELECT actor."usuario", role."nombre", actor_site."aliadoId", actor_ally."codigo"
      INTO actor_username, actor_role, actor_ally_id, actor_ally_code
      FROM public."Usuario" actor
      INNER JOIN public."Rol" role ON role."id" = actor."rolId"
      INNER JOIN public."Sede" actor_site ON actor_site."id" = actor."sedeId"
      LEFT JOIN public."Aliado" actor_ally ON actor_ally."id" = actor_site."aliadoId"
      WHERE actor."id" = NEW."usuarioId";

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_ATTRIBUTION_ACTOR_NOT_FOUND' USING ERRCODE = '23514';
      END IF;

      IF UPPER(BTRIM(COALESCE(payment_ally_code, ''))) = 'FINSERPAY' THEN
        owner_type := 'FINSER_PAY';
        owner_ally_id := NULL;
        attribution_source := 'TRIGGER_SEDE_CENTRAL';
      ELSIF LOWER(BTRIM(COALESCE(actor_username, ''))) = 'admin'
        OR (
          UPPER(BTRIM(COALESCE(actor_role, ''))) = 'ADMIN'
          AND UPPER(BTRIM(COALESCE(actor_ally_code, ''))) = 'FINSERPAY'
        )
      THEN
        owner_type := 'FINSER_PAY';
        owner_ally_id := NULL;
        attribution_source := 'TRIGGER_ADMIN_CENTRAL';
      ELSIF payment_ally_id IS NOT NULL THEN
        owner_type := 'ALIADO';
        owner_ally_id := payment_ally_id;
        attribution_source := 'TRIGGER_SEDE_ALIADA';
      ELSE
        owner_type := 'FINSER_PAY';
        owner_ally_id := NULL;
        attribution_source := 'TRIGGER_SIN_ALIADO';
      END IF;

      INSERT INTO public."CreditoAbonoAtribucionAliado" (
        "abonoId", "titularTipo", "aliadoId", "fuente", "actorAliadoIdSnapshot"
      ) VALUES (
        NEW."id", owner_type, owner_ally_id, attribution_source, actor_ally_id
      );
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditoAbono_assign_ally_attribution"
    AFTER INSERT ON public."CreditoAbono"
    FOR EACH ROW EXECUTE FUNCTION public.credit_abono_assign_ally_attribution()`,
  `CREATE OR REPLACE FUNCTION public.credit_abono_ally_attribution_guard_settlement()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      attribution_owner VARCHAR(16);
      attribution_ally_id INTEGER;
      settlement_ally_id INTEGER;
    BEGIN
      SELECT "titularTipo", "aliadoId"
      INTO attribution_owner, attribution_ally_id
      FROM public."CreditoAbonoAtribucionAliado"
      WHERE "abonoId" = NEW."abonoId";

      IF attribution_owner IS DISTINCT FROM 'ALIADO' THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_COLLECTION_NOT_OWNED_BY_ALLY' USING ERRCODE = '23514';
      END IF;

      SELECT "aliadoId" INTO settlement_ally_id
      FROM public."LiquidacionAliado"
      WHERE "id" = NEW."liquidacionId";

      IF settlement_ally_id IS DISTINCT FROM attribution_ally_id THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_COLLECTION_ALLY_MISMATCH' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "LiquidacionAliadoRecaudo_require_owned_attribution"
    BEFORE INSERT ON public."LiquidacionAliadoRecaudo"
    FOR EACH ROW EXECUTE FUNCTION public.credit_abono_ally_attribution_guard_settlement()`,
  `INSERT INTO public."CreditoAbonoAtribucionAliado" (
      "abonoId", "titularTipo", "aliadoId", "fuente", "actorAliadoIdSnapshot"
    )
    SELECT DISTINCT ON (payment."id")
      payment."id", 'ALIADO', settlement."aliadoId", 'LEGACY_LIQUIDADO', actor_site."aliadoId"
    FROM public."LiquidacionAliadoRecaudo" snapshot
    INNER JOIN public."LiquidacionAliado" settlement ON settlement."id" = snapshot."liquidacionId"
    INNER JOIN public."CreditoAbono" payment ON payment."id" = snapshot."abonoId"
    INNER JOIN public."Usuario" actor ON actor."id" = payment."usuarioId"
    INNER JOIN public."Sede" actor_site ON actor_site."id" = actor."sedeId"
    ORDER BY payment."id", settlement."id"
    ON CONFLICT ("abonoId") DO NOTHING`,
  `WITH facts AS (
      SELECT
        payment."id" AS "abonoId",
        payment_site."aliadoId" AS "paymentAllyId",
        payment_ally."codigo" AS "paymentAllyCode",
        actor."usuario" AS "actorUsername",
        actor_site."aliadoId" AS "actorAllyId"
      FROM public."CreditoAbono" payment
      INNER JOIN public."Sede" payment_site ON payment_site."id" = payment."sedeId"
      LEFT JOIN public."Aliado" payment_ally ON payment_ally."id" = payment_site."aliadoId"
      INNER JOIN public."Usuario" actor ON actor."id" = payment."usuarioId"
      INNER JOIN public."Sede" actor_site ON actor_site."id" = actor."sedeId"
      LEFT JOIN public."CreditoAbonoAtribucionAliado" existing ON existing."abonoId" = payment."id"
      WHERE existing."abonoId" IS NULL
    ), classified AS (
      SELECT facts.*,
        CASE
          WHEN UPPER(BTRIM(COALESCE("paymentAllyCode", ''))) = 'FINSERPAY' THEN 'FINSER_PAY'
          WHEN LOWER(BTRIM(COALESCE("actorUsername", ''))) = 'admin' THEN 'FINSER_PAY'
          WHEN "paymentAllyId" IS NOT NULL THEN 'ALIADO'
          ELSE 'FINSER_PAY'
        END AS "ownerType",
        CASE
          WHEN UPPER(BTRIM(COALESCE("paymentAllyCode", ''))) = 'FINSERPAY' THEN 'LEGACY_SEDE_CENTRAL'
          WHEN LOWER(BTRIM(COALESCE("actorUsername", ''))) = 'admin' THEN 'LEGACY_ADMIN_CANONICO'
          WHEN "paymentAllyId" IS NOT NULL THEN 'LEGACY_SEDE_ALIADA'
          ELSE 'LEGACY_SIN_ALIADO'
        END AS "attributionSource"
      FROM facts
    )
    INSERT INTO public."CreditoAbonoAtribucionAliado" (
      "abonoId", "titularTipo", "aliadoId", "fuente", "actorAliadoIdSnapshot"
    )
    SELECT "abonoId", "ownerType",
      CASE WHEN "ownerType" = 'ALIADO' THEN "paymentAllyId" ELSE NULL END,
      "attributionSource", "actorAllyId"
    FROM classified
    ON CONFLICT ("abonoId") DO NOTHING`,
  creditAbonoAllyAttributionConsistencyValidation,
  `CREATE OR REPLACE FUNCTION public.credit_abono_ally_attribution_reject_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ALLY_PAYMENT_ATTRIBUTION_IMMUTABLE' USING ERRCODE = '23514';
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditoAbonoAtribucionAliado_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditoAbonoAtribucionAliado"
    FOR EACH ROW EXECUTE FUNCTION public.credit_abono_ally_attribution_reject_mutation()`,
  `CREATE OR REPLACE TRIGGER "CreditoAbonoAtribucionAliado_no_truncate"
    BEFORE TRUNCATE ON public."CreditoAbonoAtribucionAliado"
    FOR EACH STATEMENT EXECUTE FUNCTION public.credit_abono_ally_attribution_reject_mutation()`,
];

// Run this again after the settlement insert guards have taken their table
// locks, closing the deployment cutover window with older app instances.
export const creditAbonoAllyAttributionValidationStatements = [
  creditAbonoAllyAttributionConsistencyValidation,
];
