// Positive, append-only compensation for the one central-admin collection that
// was already deducted from a paid ally settlement. The paid settlement,
// collection snapshot and immutable collection attribution remain untouched.
export const allyPaymentCentralCollectionAdjustmentSchemaStatements = [
  `ALTER TABLE public."LiquidacionAliado"
    ADD COLUMN IF NOT EXISTS "numeroAjustesRecaudoCentral" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "totalAjustesRecaudoCentral" NUMERIC(20,2) NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS public."AjusteRecaudoCentralAliado" (
    "id" SERIAL PRIMARY KEY,
    "abonoId" INTEGER NOT NULL,
    "liquidacionRecaudoOrigenId" INTEGER NOT NULL,
    "creditoId" INTEGER NOT NULL,
    "aliadoId" INTEGER NOT NULL,
    "aliadoNombre" VARCHAR(180) NOT NULL,
    "fechaRecaudo" TIMESTAMP(3) NOT NULL,
    "fechaAjuste" TIMESTAMP(3) NOT NULL,
    "folio" VARCHAR(80) NOT NULL,
    "clienteNombre" VARCHAR(180) NOT NULL,
    "clienteDocumento" VARCHAR(80) NOT NULL,
    "sedeId" INTEGER NOT NULL,
    "sedeNombre" VARCHAR(180) NOT NULL,
    "metodoPago" VARCHAR(40) NOT NULL,
    "liquidacionOrigenId" INTEGER NOT NULL,
    "valorAjuste" NUMERIC(20,2) NOT NULL,
    "motivo" VARCHAR(500) NOT NULL,
    "fuente" VARCHAR(40) NOT NULL,
    "usuarioRecaudoId" INTEGER NOT NULL,
    "usuarioRecaudoNombre" VARCHAR(160) NOT NULL,
    "usuarioRecaudoLogin" VARCHAR(160) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "AjusteRecaudoCentralAliado_abonoId_key" UNIQUE ("abonoId"),
    CONSTRAINT "AjusteRecaudoCentral_origenRecaudo_key" UNIQUE ("liquidacionRecaudoOrigenId")
  )`,
  `CREATE TABLE IF NOT EXISTS public."LiquidacionAliadoAjusteRecaudoCentral" (
    "id" SERIAL PRIMARY KEY,
    "liquidacionId" INTEGER NOT NULL,
    "ajusteId" INTEGER NOT NULL,
    "valorAjuste" NUMERIC(20,2) NOT NULL,
    "estado" VARCHAR(24) NOT NULL DEFAULT 'ACREDITADO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "LiquidacionAliadoAjusteRecaudoCentral_ajusteId_key" UNIQUE ("ajusteId")
  )`,
  `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'AjusteRecaudoCentralAliado_abonoId_fkey'
        AND conrelid = 'public."AjusteRecaudoCentralAliado"'::regclass
    ) THEN
      ALTER TABLE public."AjusteRecaudoCentralAliado"
        ADD CONSTRAINT "AjusteRecaudoCentralAliado_abonoId_fkey"
        FOREIGN KEY ("abonoId") REFERENCES public."CreditoAbono"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'AjusteRecaudoCentral_origenRecaudo_fkey'
        AND conrelid = 'public."AjusteRecaudoCentralAliado"'::regclass
    ) THEN
      ALTER TABLE public."AjusteRecaudoCentralAliado"
        ADD CONSTRAINT "AjusteRecaudoCentral_origenRecaudo_fkey"
        FOREIGN KEY ("liquidacionRecaudoOrigenId")
        REFERENCES public."LiquidacionAliadoRecaudo"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'AjusteRecaudoCentralAliado_creditoId_fkey'
        AND conrelid = 'public."AjusteRecaudoCentralAliado"'::regclass
    ) THEN
      ALTER TABLE public."AjusteRecaudoCentralAliado"
        ADD CONSTRAINT "AjusteRecaudoCentralAliado_creditoId_fkey"
        FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'AjusteRecaudoCentralAliado_aliadoId_fkey'
        AND conrelid = 'public."AjusteRecaudoCentralAliado"'::regclass
    ) THEN
      ALTER TABLE public."AjusteRecaudoCentralAliado"
        ADD CONSTRAINT "AjusteRecaudoCentralAliado_aliadoId_fkey"
        FOREIGN KEY ("aliadoId") REFERENCES public."Aliado"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'AjusteRecaudoCentral_origenLiquidacion_fkey'
        AND conrelid = 'public."AjusteRecaudoCentralAliado"'::regclass
    ) THEN
      ALTER TABLE public."AjusteRecaudoCentralAliado"
        ADD CONSTRAINT "AjusteRecaudoCentral_origenLiquidacion_fkey"
        FOREIGN KEY ("liquidacionOrigenId") REFERENCES public."LiquidacionAliado"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'AjusteRecaudoCentral_usuarioRecaudo_fkey'
        AND conrelid = 'public."AjusteRecaudoCentralAliado"'::regclass
    ) THEN
      ALTER TABLE public."AjusteRecaudoCentralAliado"
        ADD CONSTRAINT "AjusteRecaudoCentral_usuarioRecaudo_fkey"
        FOREIGN KEY ("usuarioRecaudoId") REFERENCES public."Usuario"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'LiquidacionAjusteRecaudoCentral_liquidacion_fkey'
        AND conrelid = 'public."LiquidacionAliadoAjusteRecaudoCentral"'::regclass
    ) THEN
      ALTER TABLE public."LiquidacionAliadoAjusteRecaudoCentral"
        ADD CONSTRAINT "LiquidacionAjusteRecaudoCentral_liquidacion_fkey"
        FOREIGN KEY ("liquidacionId") REFERENCES public."LiquidacionAliado"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'LiquidacionAjusteRecaudoCentral_ajuste_fkey'
        AND conrelid = 'public."LiquidacionAliadoAjusteRecaudoCentral"'::regclass
    ) THEN
      ALTER TABLE public."LiquidacionAliadoAjusteRecaudoCentral"
        ADD CONSTRAINT "LiquidacionAjusteRecaudoCentral_ajuste_fkey"
        FOREIGN KEY ("ajusteId") REFERENCES public."AjusteRecaudoCentralAliado"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;
  END $$`,
  `ALTER TABLE public."AjusteRecaudoCentralAliado"
    DROP CONSTRAINT IF EXISTS "AjusteRecaudoCentralAliado_datos_check";
  ALTER TABLE public."AjusteRecaudoCentralAliado"
    ADD CONSTRAINT "AjusteRecaudoCentralAliado_datos_check"
    CHECK (
      "valorAjuste" > 0
      AND LENGTH(BTRIM("aliadoNombre")) BETWEEN 1 AND 180
      AND LENGTH(BTRIM("folio")) BETWEEN 1 AND 80
      AND LENGTH(BTRIM("clienteNombre")) BETWEEN 1 AND 180
      AND LENGTH(BTRIM("clienteDocumento")) BETWEEN 1 AND 80
      AND LENGTH(BTRIM("sedeNombre")) BETWEEN 1 AND 180
      AND LENGTH(BTRIM("metodoPago")) BETWEEN 1 AND 40
      AND LENGTH(BTRIM("motivo")) BETWEEN 1 AND 500
      AND "fuente" = 'CORRECCION_DIRIGIDA_ABONO'
      AND LENGTH(BTRIM("usuarioRecaudoNombre")) BETWEEN 1 AND 160
      AND LENGTH(BTRIM("usuarioRecaudoLogin")) BETWEEN 1 AND 160
    )`,
  `ALTER TABLE public."LiquidacionAliadoAjusteRecaudoCentral"
    DROP CONSTRAINT IF EXISTS "LiquidacionAjusteRecaudoCentral_datos_check";
  ALTER TABLE public."LiquidacionAliadoAjusteRecaudoCentral"
    ADD CONSTRAINT "LiquidacionAjusteRecaudoCentral_datos_check"
    CHECK ("valorAjuste" > 0 AND "estado" = 'ACREDITADO')`,
  `ALTER TABLE public."LiquidacionAliado"
    DROP CONSTRAINT IF EXISTS "LiquidacionAliado_balance_check";
  ALTER TABLE public."LiquidacionAliado"
    ADD CONSTRAINT "LiquidacionAliado_balance_check"
    CHECK (
      ("totalRecaudosAliado" IS NULL AND "saldoNeto" IS NULL AND "direccionSaldo" IS NULL)
      OR (
        "totalRecaudosAliado" >= 0
        AND "totalAjustesAnulacion" >= 0
        AND "totalAjustesRecaudoCentral" >= 0
        AND "saldoNeto" = "totalPagar" - "totalRecaudosAliado"
          - "totalAjustesAnulacion" + "totalAjustesRecaudoCentral"
        AND "direccionSaldo" = CASE
          WHEN "saldoNeto" > 0 THEN 'PAGO_ALIADO'
          WHEN "saldoNeto" < 0 THEN 'CONSIGNACION_ALIADO'
          ELSE 'SALDO_CERO'
        END
      )
    )`,
  `ALTER TABLE public."LiquidacionAliado"
    DROP CONSTRAINT IF EXISTS "LiquidacionAliado_totales_check";
  ALTER TABLE public."LiquidacionAliado"
    ADD CONSTRAINT "LiquidacionAliado_totales_check"
    CHECK (
      "totalValorVenta" >= 0
      AND "totalCreditoAutorizado" >= 0
      AND "totalCuotaInicial" >= 0
      AND "totalIntermediacion" >= 0
      AND "totalPagar" >= 0
      AND "numeroAjustesAnulacion" >= 0
      AND "totalAjustesAnulacion" >= 0
      AND "numeroAjustesRecaudoCentral" >= 0
      AND "totalAjustesRecaudoCentral" >= 0
    )`,
  // This directed correction is intentionally scoped to the audited production
  // payment. Every financial and descriptive value is copied from the immutable
  // paid collection snapshot; only the source payment id is fixed.
  `INSERT INTO public."AjusteRecaudoCentralAliado" (
      "abonoId", "liquidacionRecaudoOrigenId", "creditoId", "aliadoId",
      "aliadoNombre", "fechaRecaudo", "fechaAjuste", "folio",
      "clienteNombre", "clienteDocumento", "sedeId", "sedeNombre",
      "metodoPago", "liquidacionOrigenId", "valorAjuste", "motivo",
      "fuente", "usuarioRecaudoId", "usuarioRecaudoNombre",
      "usuarioRecaudoLogin", "createdAt"
    )
    SELECT
      payment."id",
      source_collection."id",
      source_collection."creditoId",
      source_settlement."aliadoId",
      LEFT(COALESCE(NULLIF(BTRIM(ally."nombre"), ''), 'Aliado'), 180),
      source_collection."fechaAbono",
      CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      LEFT(COALESCE(NULLIF(BTRIM(source_collection."folio"), ''), 'Credito ' || source_collection."creditoId"), 80),
      LEFT(COALESCE(NULLIF(BTRIM(source_collection."clienteNombre"), ''), 'Cliente'), 180),
      LEFT(COALESCE(NULLIF(BTRIM(source_collection."clienteDocumento"), ''), 'Sin documento'), 80),
      source_collection."sedeId",
      LEFT(COALESCE(NULLIF(BTRIM(source_collection."sedeNombre"), ''), 'Sede sin nombre'), 180),
      LEFT(COALESCE(NULLIF(BTRIM(source_collection."metodoPago"), ''), 'OTRO'), 40),
      source_settlement."id",
      source_collection."valor",
      'Reintegro por recaudo registrado por el administrador central FINSER PAY y descontado en una liquidacion previa.',
      'CORRECCION_DIRIGIDA_ABONO',
      actor."id",
      LEFT(COALESCE(NULLIF(BTRIM(actor."nombre"), ''), 'Administrador FINSER PAY'), 160),
      LEFT(COALESCE(NULLIF(BTRIM(actor."usuario"), ''), 'admin'), 160),
      CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    FROM public."CreditoAbono" payment
    INNER JOIN public."LiquidacionAliadoRecaudo" source_collection
      ON source_collection."abonoId" = payment."id"
    INNER JOIN public."LiquidacionAliado" source_settlement
      ON source_settlement."id" = source_collection."liquidacionId"
    INNER JOIN public."Aliado" ally
      ON ally."id" = source_settlement."aliadoId"
    INNER JOIN public."Usuario" actor
      ON actor."id" = payment."usuarioId"
    INNER JOIN public."Rol" actor_role
      ON actor_role."id" = actor."rolId"
    INNER JOIN public."Sede" actor_site
      ON actor_site."id" = actor."sedeId"
    LEFT JOIN public."Aliado" actor_ally
      ON actor_ally."id" = actor_site."aliadoId"
    LEFT JOIN public."Sede" payment_site
      ON payment_site."id" = payment."sedeId"
    LEFT JOIN public."Aliado" payment_ally
      ON payment_ally."id" = payment_site."aliadoId"
    WHERE payment."id" = 1574
      AND UPPER(BTRIM(COALESCE(source_settlement."estado", ''))) = 'PAGADA'
      AND UPPER(BTRIM(COALESCE(source_collection."estado", ''))) = 'DESCONTADO'
      AND source_collection."valor" > 0
      AND (
        UPPER(BTRIM(COALESCE(payment_ally."codigo", ''))) = 'FINSERPAY'
        OR LOWER(BTRIM(COALESCE(actor."usuario", ''))) = 'admin'
        OR (
          UPPER(BTRIM(COALESCE(actor_role."nombre", ''))) = 'ADMIN'
          AND UPPER(BTRIM(COALESCE(actor_ally."codigo", ''))) = 'FINSERPAY'
        )
      )
    ON CONFLICT ("abonoId") DO NOTHING`,
  `CREATE OR REPLACE FUNCTION public.validate_liquidacion_aliado_ajuste_recaudo_central()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      adjustment_ally_id INTEGER;
      adjustment_origin_settlement_id INTEGER;
      adjustment_value NUMERIC(20,2);
      target_ally_id INTEGER;
    BEGIN
      SELECT adjustment."aliadoId", adjustment."liquidacionOrigenId", adjustment."valorAjuste"
      INTO adjustment_ally_id, adjustment_origin_settlement_id, adjustment_value
      FROM public."AjusteRecaudoCentralAliado" adjustment
      WHERE adjustment."id" = NEW."ajusteId";

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_ADJUSTMENT_NOT_FOUND'
          USING ERRCODE = '23514';
      END IF;

      SELECT settlement."aliadoId"
      INTO target_ally_id
      FROM public."LiquidacionAliado" settlement
      WHERE settlement."id" = NEW."liquidacionId";

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_SETTLEMENT_NOT_FOUND'
          USING ERRCODE = '23514';
      END IF;

      IF NEW."liquidacionId" = adjustment_origin_settlement_id THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_SAME_SETTLEMENT'
          USING ERRCODE = '23514';
      END IF;

      IF target_ally_id IS DISTINCT FROM adjustment_ally_id THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_ALLY_MISMATCH'
          USING ERRCODE = '23514';
      END IF;

      IF NEW."valorAjuste" IS DISTINCT FROM adjustment_value THEN
        RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_VALUE_MISMATCH'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END $$`,
  `DROP TRIGGER IF EXISTS "LiquidacionAliadoAjusteRecaudoCentral_validate"
      ON public."LiquidacionAliadoAjusteRecaudoCentral";
    CREATE TRIGGER "LiquidacionAliadoAjusteRecaudoCentral_validate"
      BEFORE INSERT ON public."LiquidacionAliadoAjusteRecaudoCentral"
      FOR EACH ROW EXECUTE FUNCTION public.validate_liquidacion_aliado_ajuste_recaudo_central()`,
  `CREATE OR REPLACE FUNCTION public.reject_ajuste_recaudo_central_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_ADJUSTMENT_IMMUTABLE'
        USING ERRCODE = '23514';
    END $$`,
  `DROP TRIGGER IF EXISTS "AjusteRecaudoCentralAliado_immutable"
      ON public."AjusteRecaudoCentralAliado";
    CREATE TRIGGER "AjusteRecaudoCentralAliado_immutable"
      BEFORE UPDATE OR DELETE ON public."AjusteRecaudoCentralAliado"
      FOR EACH ROW EXECUTE FUNCTION public.reject_ajuste_recaudo_central_mutation();

    DROP TRIGGER IF EXISTS "AjusteRecaudoCentralAliado_no_truncate"
      ON public."AjusteRecaudoCentralAliado";
    CREATE TRIGGER "AjusteRecaudoCentralAliado_no_truncate"
      BEFORE TRUNCATE ON public."AjusteRecaudoCentralAliado"
      FOR EACH STATEMENT EXECUTE FUNCTION public.reject_ajuste_recaudo_central_mutation()`,
  `CREATE OR REPLACE FUNCTION public.reject_liquidacion_ajuste_recaudo_central_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_APPLICATION_IMMUTABLE'
        USING ERRCODE = '23514';
    END $$`,
  `DROP TRIGGER IF EXISTS "LiquidacionAliadoAjusteRecaudoCentral_immutable"
      ON public."LiquidacionAliadoAjusteRecaudoCentral";
    CREATE TRIGGER "LiquidacionAliadoAjusteRecaudoCentral_immutable"
      BEFORE UPDATE OR DELETE ON public."LiquidacionAliadoAjusteRecaudoCentral"
      FOR EACH ROW EXECUTE FUNCTION public.reject_liquidacion_ajuste_recaudo_central_mutation();

    DROP TRIGGER IF EXISTS "LiquidacionAliadoAjusteRecaudoCentral_no_truncate"
      ON public."LiquidacionAliadoAjusteRecaudoCentral";
    CREATE TRIGGER "LiquidacionAliadoAjusteRecaudoCentral_no_truncate"
      BEFORE TRUNCATE ON public."LiquidacionAliadoAjusteRecaudoCentral"
      FOR EACH STATEMENT EXECUTE FUNCTION public.reject_liquidacion_ajuste_recaudo_central_mutation()`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "AjusteRecaudoCentralAliado_abonoId_key" ON public."AjusteRecaudoCentralAliado" ("abonoId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "AjusteRecaudoCentral_origenRecaudo_key" ON public."AjusteRecaudoCentralAliado" ("liquidacionRecaudoOrigenId")',
  'CREATE INDEX IF NOT EXISTS "AjusteRecaudoCentral_aliado_fecha_idx" ON public."AjusteRecaudoCentralAliado" ("aliadoId", "fechaAjuste", "id")',
  'CREATE INDEX IF NOT EXISTS "AjusteRecaudoCentral_origenLiquidacion_idx" ON public."AjusteRecaudoCentralAliado" ("liquidacionOrigenId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "LiquidacionAliadoAjusteRecaudoCentral_ajusteId_key" ON public."LiquidacionAliadoAjusteRecaudoCentral" ("ajusteId")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAjusteRecaudoCentral_liquidacion_idx" ON public."LiquidacionAliadoAjusteRecaudoCentral" ("liquidacionId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAjusteRecaudoCentral_estado_idx" ON public."LiquidacionAliadoAjusteRecaudoCentral" ("estado", "createdAt")',
];

export const allyPaymentCentralCollectionAdjustmentValidationStatements = [
  `DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM public."AjusteRecaudoCentralAliado" adjustment
      INNER JOIN public."LiquidacionAliadoRecaudo" source_collection
        ON source_collection."id" = adjustment."liquidacionRecaudoOrigenId"
      INNER JOIN public."LiquidacionAliado" source_settlement
        ON source_settlement."id" = source_collection."liquidacionId"
      WHERE adjustment."abonoId" IS DISTINCT FROM source_collection."abonoId"
        OR adjustment."creditoId" IS DISTINCT FROM source_collection."creditoId"
        OR adjustment."aliadoId" IS DISTINCT FROM source_settlement."aliadoId"
        OR adjustment."liquidacionOrigenId" IS DISTINCT FROM source_settlement."id"
        OR adjustment."valorAjuste" IS DISTINCT FROM source_collection."valor"
    ) THEN
      RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_ADJUSTMENT_SOURCE_MISMATCH'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public."LiquidacionAliadoAjusteRecaudoCentral" application
      INNER JOIN public."AjusteRecaudoCentralAliado" adjustment
        ON adjustment."id" = application."ajusteId"
      INNER JOIN public."LiquidacionAliado" target_settlement
        ON target_settlement."id" = application."liquidacionId"
      WHERE application."liquidacionId" = adjustment."liquidacionOrigenId"
        OR target_settlement."aliadoId" IS DISTINCT FROM adjustment."aliadoId"
        OR application."valorAjuste" IS DISTINCT FROM adjustment."valorAjuste"
    ) THEN
      RAISE EXCEPTION 'ALLY_PAYMENT_CENTRAL_COLLECTION_APPLICATION_MISMATCH'
        USING ERRCODE = '23514';
    END IF;

  END $$`,
];
