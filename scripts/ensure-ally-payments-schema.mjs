import pg from "pg";
import { creditAllyPaymentExclusionSchemaStatements } from "./credit-ally-payment-exclusion-schema.mjs";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para preparar el esquema de pagos a aliados."
  );
}

const client = new Client({
  application_name: "finserpay-ally-payments-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

const statements = [
  `
    CREATE TABLE IF NOT EXISTS public."LiquidacionAliado" (
      "id" SERIAL PRIMARY KEY,
      "mutationId" UUID NOT NULL,
      "requestHash" CHAR(64) NOT NULL,
      "aliadoId" INTEGER NOT NULL,
      "periodoInicio" DATE NOT NULL,
      "periodoFin" DATE NOT NULL,
      "numeroAprobacionBancaria" VARCHAR(120) NOT NULL,
      "numeroAprobacionNormalizado" VARCHAR(120) NOT NULL,
      "estado" VARCHAR(16) NOT NULL DEFAULT 'PAGADA',
      "numeroCreditos" INTEGER NOT NULL,
      "totalValorVenta" NUMERIC(20,2) NOT NULL,
      "totalCreditoAutorizado" NUMERIC(20,2) NOT NULL,
      "totalCuotaInicial" NUMERIC(20,2) NOT NULL,
      "totalIntermediacion" NUMERIC(20,2) NOT NULL,
      "totalPagar" NUMERIC(20,2) NOT NULL,
      "totalRecaudosAliado" NUMERIC(20,2),
      "numeroAjustesAnulacion" INTEGER NOT NULL DEFAULT 0,
      "totalAjustesAnulacion" NUMERIC(20,2) NOT NULL DEFAULT 0,
      "saldoNeto" NUMERIC(20,2),
      "direccionSaldo" VARCHAR(32),
      "registradoPorUsuarioId" INTEGER NOT NULL,
      "registradoPorNombre" VARCHAR(160) NOT NULL,
      "pagadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `,
  `
    ALTER TABLE public."LiquidacionAliado"
      ADD COLUMN IF NOT EXISTS "totalRecaudosAliado" NUMERIC(20,2),
      ADD COLUMN IF NOT EXISTS "numeroAjustesAnulacion" INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "totalAjustesAnulacion" NUMERIC(20,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "saldoNeto" NUMERIC(20,2),
      ADD COLUMN IF NOT EXISTS "direccionSaldo" VARCHAR(32)
  `,
  `
    UPDATE public."LiquidacionAliado"
    SET
      "numeroAjustesAnulacion" = COALESCE("numeroAjustesAnulacion", 0),
      "totalAjustesAnulacion" = COALESCE("totalAjustesAnulacion", 0)
    WHERE "numeroAjustesAnulacion" IS NULL
      OR "totalAjustesAnulacion" IS NULL
  `,
  `
    ALTER TABLE public."LiquidacionAliado"
      ALTER COLUMN "numeroAjustesAnulacion" SET DEFAULT 0,
      ALTER COLUMN "numeroAjustesAnulacion" SET NOT NULL,
      ALTER COLUMN "totalAjustesAnulacion" SET DEFAULT 0,
      ALTER COLUMN "totalAjustesAnulacion" SET NOT NULL
  `,
  `
    CREATE TABLE IF NOT EXISTS public."LiquidacionAliadoRecaudo" (
      "id" SERIAL PRIMARY KEY,
      "liquidacionId" INTEGER NOT NULL,
      "abonoId" INTEGER NOT NULL,
      "creditoId" INTEGER NOT NULL,
      "sedeId" INTEGER NOT NULL,
      "fechaAbono" TIMESTAMP(3) NOT NULL,
      "folio" VARCHAR(80) NOT NULL,
      "clienteNombre" VARCHAR(180) NOT NULL,
      "clienteDocumento" VARCHAR(80) NOT NULL,
      "sedeNombre" VARCHAR(180) NOT NULL,
      "metodoPago" VARCHAR(40) NOT NULL,
      "valor" NUMERIC(20,2) NOT NULL,
      "estado" VARCHAR(16) NOT NULL DEFAULT 'DESCONTADO',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS public."LiquidacionAliadoCredito" (
      "id" SERIAL PRIMARY KEY,
      "liquidacionId" INTEGER NOT NULL,
      "creditoId" INTEGER NOT NULL,
      "fechaCredito" TIMESTAMP(3) NOT NULL,
      "folio" VARCHAR(80) NOT NULL,
      "clienteNombre" VARCHAR(180) NOT NULL,
      "clienteDocumento" VARCHAR(80) NOT NULL,
      "imei" VARCHAR(80) NOT NULL,
      "equipo" VARCHAR(240) NOT NULL,
      "plataforma" VARCHAR(16) NOT NULL,
      "valorVenta" NUMERIC(20,2) NOT NULL,
      "creditoAutorizado" NUMERIC(20,2) NOT NULL,
      "cuotaInicial" NUMERIC(20,2) NOT NULL,
      "porcentajeIntermediacion" NUMERIC(7,4) NOT NULL,
      "valorIntermediacion" NUMERIC(20,2) NOT NULL,
      "valorPagar" NUMERIC(20,2) NOT NULL,
      "estado" VARCHAR(16) NOT NULL DEFAULT 'PAGADO',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `,
  `
    ALTER TABLE public."LiquidacionAliadoCredito"
      ADD COLUMN IF NOT EXISTS "clienteDocumento" VARCHAR(80),
      ADD COLUMN IF NOT EXISTS "imei" VARCHAR(80)
  `,
  `
    UPDATE public."LiquidacionAliadoCredito" detail
    SET
      "clienteDocumento" = LEFT(
        COALESCE(
          NULLIF(BTRIM(detail."clienteDocumento"), ''),
          NULLIF(BTRIM(credit."clienteDocumento"), ''),
          'Sin documento'
        ),
        80
      ),
      "imei" = LEFT(
        COALESCE(
          NULLIF(BTRIM(detail."imei"), ''),
          NULLIF(BTRIM(credit."imei"), ''),
          NULLIF(BTRIM(credit."deviceUid"), ''),
          'Sin IMEI'
        ),
        80
      )
    FROM public."Credito" credit
    WHERE credit."id" = detail."creditoId"
      AND (
        NULLIF(BTRIM(detail."clienteDocumento"), '') IS NULL
        OR NULLIF(BTRIM(detail."imei"), '') IS NULL
      )
  `,
  `
    UPDATE public."LiquidacionAliadoCredito"
    SET
      "clienteDocumento" = COALESCE(
        NULLIF(BTRIM("clienteDocumento"), ''),
        'Sin documento'
      ),
      "imei" = COALESCE(NULLIF(BTRIM("imei"), ''), 'Sin IMEI')
    WHERE "clienteDocumento" IS NULL
      OR NULLIF(BTRIM("clienteDocumento"), '') IS NULL
      OR "imei" IS NULL
      OR NULLIF(BTRIM("imei"), '') IS NULL
  `,
  `
    ALTER TABLE public."LiquidacionAliadoCredito"
      ALTER COLUMN "clienteDocumento" SET NOT NULL,
      ALTER COLUMN "imei" SET NOT NULL
  `,
  `
    CREATE TABLE IF NOT EXISTS public."AjusteAnulacionCreditoAliado" (
      "id" SERIAL PRIMARY KEY,
      "creditoId" INTEGER NOT NULL,
      "liquidacionCreditoOrigenId" INTEGER NOT NULL,
      "aliadoId" INTEGER NOT NULL,
      "aliadoNombre" VARCHAR(180) NOT NULL,
      "fechaAnulacion" TIMESTAMP(3) NOT NULL,
      "fechaAnulacionFuente" VARCHAR(32) NOT NULL,
      "folio" VARCHAR(80) NOT NULL,
      "clienteNombre" VARCHAR(180) NOT NULL,
      "clienteDocumento" VARCHAR(80) NOT NULL,
      "imei" VARCHAR(80) NOT NULL,
      "equipo" VARCHAR(240) NOT NULL,
      "plataforma" VARCHAR(16) NOT NULL,
      "sedeId" INTEGER NOT NULL,
      "sedeNombre" VARCHAR(180) NOT NULL,
      "liquidacionOrigenId" INTEGER NOT NULL,
      "valorDescuento" NUMERIC(20,2) NOT NULL,
      "motivo" VARCHAR(500) NOT NULL,
      "creadoPorUsuarioId" INTEGER,
      "creadoPorNombre" VARCHAR(160) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AjusteAnulacionCreditoAliado_creditoId_key" UNIQUE ("creditoId"),
      CONSTRAINT "AjusteAnulacionCreditoAliado_origenCredito_key" UNIQUE ("liquidacionCreditoOrigenId")
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS public."LiquidacionAliadoAjusteAnulacion" (
      "id" SERIAL PRIMARY KEY,
      "liquidacionId" INTEGER NOT NULL,
      "ajusteId" INTEGER NOT NULL,
      "valorDescuento" NUMERIC(20,2) NOT NULL,
      "estado" VARCHAR(24) NOT NULL DEFAULT 'DESCONTADO',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LiquidacionAliadoAjusteAnulacion_ajusteId_key" UNIQUE ("ajusteId")
    )
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_aliadoId_fkey'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_aliadoId_fkey"
          FOREIGN KEY ("aliadoId") REFERENCES public."Aliado"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_formula_check'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_formula_check"
          CHECK (
            "totalCreditoAutorizado" = "totalValorVenta" - "totalCuotaInicial"
            AND "totalIntermediacion" <= "totalCreditoAutorizado"
            AND "totalPagar" = "totalCreditoAutorizado" - "totalIntermediacion"
          );
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_registradoPorUsuarioId_fkey'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_registradoPorUsuarioId_fkey"
          FOREIGN KEY ("registradoPorUsuarioId") REFERENCES public."Usuario"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoCredito_formula_check'
          AND conrelid = 'public."LiquidacionAliadoCredito"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoCredito"
          ADD CONSTRAINT "LiquidacionAliadoCredito_formula_check"
          CHECK (
            "creditoAutorizado" = "valorVenta" - "cuotaInicial"
            AND "valorIntermediacion" = ROUND(
              "creditoAutorizado" * "porcentajeIntermediacion" / 100,
              2
            )
            AND "valorPagar" = "creditoAutorizado" - "valorIntermediacion"
          );
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoCredito_liquidacionId_fkey'
          AND conrelid = 'public."LiquidacionAliadoCredito"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoCredito"
          ADD CONSTRAINT "LiquidacionAliadoCredito_liquidacionId_fkey"
          FOREIGN KEY ("liquidacionId")
          REFERENCES public."LiquidacionAliado"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoCredito_creditoId_fkey'
          AND conrelid = 'public."LiquidacionAliadoCredito"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoCredito"
          ADD CONSTRAINT "LiquidacionAliadoCredito_creditoId_fkey"
          FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_requestHash_check'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_requestHash_check"
          CHECK ("requestHash" ~ '^[0-9a-f]{64}$');
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_periodo_check'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_periodo_check"
          CHECK ("periodoInicio" <= "periodoFin");
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_aprobacion_check'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_aprobacion_check"
          CHECK (
            LENGTH(BTRIM("numeroAprobacionBancaria")) BETWEEN 1 AND 120
            AND LENGTH(BTRIM("numeroAprobacionNormalizado")) BETWEEN 1 AND 120
          );
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_estado_check'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_estado_check"
          CHECK ("estado" = 'PAGADA');
      END IF;
    END $$;
  `,
  `
    ALTER TABLE public."LiquidacionAliado"
      DROP CONSTRAINT IF EXISTS "LiquidacionAliado_numeroCreditos_check";
    ALTER TABLE public."LiquidacionAliado"
      ADD CONSTRAINT "LiquidacionAliado_numeroCreditos_check"
      CHECK ("numeroCreditos" >= 0);
  `,
  `
    ALTER TABLE public."LiquidacionAliado"
      DROP CONSTRAINT IF EXISTS "LiquidacionAliado_balance_check";
    ALTER TABLE public."LiquidacionAliado"
      ADD CONSTRAINT "LiquidacionAliado_balance_check"
      CHECK (
        ("totalRecaudosAliado" IS NULL AND "saldoNeto" IS NULL AND "direccionSaldo" IS NULL)
        OR (
          "totalRecaudosAliado" >= 0
          AND "totalAjustesAnulacion" >= 0
          AND "saldoNeto" = "totalPagar" - "totalRecaudosAliado" - "totalAjustesAnulacion"
          AND "direccionSaldo" = CASE
            WHEN "saldoNeto" > 0 THEN 'PAGO_ALIADO'
            WHEN "saldoNeto" < 0 THEN 'CONSIGNACION_ALIADO'
            ELSE 'SALDO_CERO'
          END
        )
      )
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoRecaudo_liquidacionId_fkey'
          AND conrelid = 'public."LiquidacionAliadoRecaudo"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoRecaudo"
          ADD CONSTRAINT "LiquidacionAliadoRecaudo_liquidacionId_fkey"
          FOREIGN KEY ("liquidacionId") REFERENCES public."LiquidacionAliado"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoRecaudo_valor_check'
          AND conrelid = 'public."LiquidacionAliadoRecaudo"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoRecaudo"
          ADD CONSTRAINT "LiquidacionAliadoRecaudo_valor_check"
          CHECK ("valor" > 0 AND "estado" = 'DESCONTADO');
      END IF;
    END $$;
  `,
  `
    CREATE OR REPLACE FUNCTION public."prevent_liquidacion_aliado_recaudo_mutation"()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'LiquidacionAliadoRecaudo is append-only';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS "LiquidacionAliadoRecaudo_immutable"
      ON public."LiquidacionAliadoRecaudo";
    CREATE TRIGGER "LiquidacionAliadoRecaudo_immutable"
      BEFORE UPDATE OR DELETE ON public."LiquidacionAliadoRecaudo"
      FOR EACH ROW EXECUTE FUNCTION public."prevent_liquidacion_aliado_recaudo_mutation"();
  `,
  `
    ALTER TABLE public."LiquidacionAliado"
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
      )
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_registradoPorNombre_check'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_registradoPorNombre_check"
          CHECK (LENGTH(BTRIM("registradoPorNombre")) BETWEEN 1 AND 160);
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoCredito_plataforma_check'
          AND conrelid = 'public."LiquidacionAliadoCredito"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoCredito"
          ADD CONSTRAINT "LiquidacionAliadoCredito_plataforma_check"
          CHECK ("plataforma" IN ('ANDROID', 'IPHONE'));
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoCredito_porcentaje_check'
          AND conrelid = 'public."LiquidacionAliadoCredito"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoCredito"
          ADD CONSTRAINT "LiquidacionAliadoCredito_porcentaje_check"
          CHECK (
            "porcentajeIntermediacion" >= 0
            AND "porcentajeIntermediacion" <= 100
          );
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoCredito_importes_check'
          AND conrelid = 'public."LiquidacionAliadoCredito"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoCredito"
          ADD CONSTRAINT "LiquidacionAliadoCredito_importes_check"
          CHECK (
            "valorVenta" >= 0
            AND "creditoAutorizado" >= 0
            AND "cuotaInicial" >= 0
            AND "valorIntermediacion" >= 0
            AND "valorPagar" >= 0
          );
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoCredito_estado_check'
          AND conrelid = 'public."LiquidacionAliadoCredito"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoCredito"
          ADD CONSTRAINT "LiquidacionAliadoCredito_estado_check"
          CHECK ("estado" = 'PAGADO');
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'AjusteAnulacionCreditoAliado_creditoId_fkey'
          AND conrelid = 'public."AjusteAnulacionCreditoAliado"'::regclass
      ) THEN
        ALTER TABLE public."AjusteAnulacionCreditoAliado"
          ADD CONSTRAINT "AjusteAnulacionCreditoAliado_creditoId_fkey"
          FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'AjusteAnulacionCreditoAliado_origenCredito_fkey'
          AND conrelid = 'public."AjusteAnulacionCreditoAliado"'::regclass
      ) THEN
        ALTER TABLE public."AjusteAnulacionCreditoAliado"
          ADD CONSTRAINT "AjusteAnulacionCreditoAliado_origenCredito_fkey"
          FOREIGN KEY ("liquidacionCreditoOrigenId")
          REFERENCES public."LiquidacionAliadoCredito"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'AjusteAnulacionCreditoAliado_aliadoId_fkey'
          AND conrelid = 'public."AjusteAnulacionCreditoAliado"'::regclass
      ) THEN
        ALTER TABLE public."AjusteAnulacionCreditoAliado"
          ADD CONSTRAINT "AjusteAnulacionCreditoAliado_aliadoId_fkey"
          FOREIGN KEY ("aliadoId") REFERENCES public."Aliado"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'AjusteAnulacionCreditoAliado_origenLiquidacion_fkey'
          AND conrelid = 'public."AjusteAnulacionCreditoAliado"'::regclass
      ) THEN
        ALTER TABLE public."AjusteAnulacionCreditoAliado"
          ADD CONSTRAINT "AjusteAnulacionCreditoAliado_origenLiquidacion_fkey"
          FOREIGN KEY ("liquidacionOrigenId")
          REFERENCES public."LiquidacionAliado"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'AjusteAnulacionCreditoAliado_creadoPor_fkey'
          AND conrelid = 'public."AjusteAnulacionCreditoAliado"'::regclass
      ) THEN
        ALTER TABLE public."AjusteAnulacionCreditoAliado"
          ADD CONSTRAINT "AjusteAnulacionCreditoAliado_creadoPor_fkey"
          FOREIGN KEY ("creadoPorUsuarioId") REFERENCES public."Usuario"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoAjusteAnulacion_liquidacionId_fkey'
          AND conrelid = 'public."LiquidacionAliadoAjusteAnulacion"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoAjusteAnulacion"
          ADD CONSTRAINT "LiquidacionAliadoAjusteAnulacion_liquidacionId_fkey"
          FOREIGN KEY ("liquidacionId") REFERENCES public."LiquidacionAliado"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliadoAjusteAnulacion_ajusteId_fkey'
          AND conrelid = 'public."LiquidacionAliadoAjusteAnulacion"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliadoAjusteAnulacion"
          ADD CONSTRAINT "LiquidacionAliadoAjusteAnulacion_ajusteId_fkey"
          FOREIGN KEY ("ajusteId") REFERENCES public."AjusteAnulacionCreditoAliado"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;
  `,
  `
    ALTER TABLE public."AjusteAnulacionCreditoAliado"
      DROP CONSTRAINT IF EXISTS "AjusteAnulacionCreditoAliado_datos_check";
    ALTER TABLE public."AjusteAnulacionCreditoAliado"
      ADD CONSTRAINT "AjusteAnulacionCreditoAliado_datos_check"
      CHECK (
        "valorDescuento" > 0
        AND "plataforma" IN ('ANDROID', 'IPHONE')
        AND LENGTH(BTRIM("aliadoNombre")) BETWEEN 1 AND 180
        AND LENGTH(BTRIM("fechaAnulacionFuente")) BETWEEN 1 AND 32
        AND LENGTH(BTRIM("motivo")) BETWEEN 1 AND 500
        AND LENGTH(BTRIM("creadoPorNombre")) BETWEEN 1 AND 160
      )
  `,
  `
    ALTER TABLE public."LiquidacionAliadoAjusteAnulacion"
      DROP CONSTRAINT IF EXISTS "LiquidacionAliadoAjusteAnulacion_datos_check";
    ALTER TABLE public."LiquidacionAliadoAjusteAnulacion"
      ADD CONSTRAINT "LiquidacionAliadoAjusteAnulacion_datos_check"
      CHECK ("valorDescuento" > 0 AND "estado" = 'DESCONTADO')
  `,
  `
    CREATE OR REPLACE FUNCTION public."try_parse_ally_payment_annulment_timestamp"(
      candidate TEXT
    ) RETURNS TIMESTAMPTZ AS $$
    BEGIN
      RETURN candidate::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql STABLE;
  `,
  // Preserve the cutover invariant explicitly: while the compatibility trigger
  // and backfill are installed, legacy application instances cannot update a
  // credit between the backfill snapshot and the transaction commit.
  'LOCK TABLE public."Credito" IN SHARE ROW EXCLUSIVE MODE',
  `
    CREATE OR REPLACE FUNCTION public."capture_paid_credit_annulment_adjustment"()
    RETURNS TRIGGER AS $$
    BEGIN
      IF UPPER(BTRIM(COALESCE(NEW."estado", ''))) IN (
        'ANULADO', 'ANULADA', 'CANCELADO', 'CANCELADA'
      ) AND UPPER(BTRIM(COALESCE(OLD."estado", ''))) NOT IN (
        'ANULADO', 'ANULADA', 'CANCELADO', 'CANCELADA'
      ) THEN
        INSERT INTO public."AjusteAnulacionCreditoAliado" (
          "creditoId", "liquidacionCreditoOrigenId", "aliadoId", "aliadoNombre",
          "fechaAnulacion", "fechaAnulacionFuente", "folio", "clienteNombre",
          "clienteDocumento", "imei", "equipo", "plataforma", "sedeId",
          "sedeNombre", "liquidacionOrigenId", "valorDescuento", "motivo",
          "creadoPorUsuarioId", "creadoPorNombre", "createdAt"
        )
        SELECT
          paid_credit."creditoId",
          paid_credit."id",
          settlement."aliadoId",
          LEFT(COALESCE(NULLIF(BTRIM(ally."nombre"), ''), 'Aliado'), 180),
          clock_timestamp() AT TIME ZONE 'UTC',
          'TRIGGER_BASE_DATOS',
          LEFT(COALESCE(NULLIF(BTRIM(paid_credit."folio"), ''), 'Credito ' || paid_credit."creditoId"), 80),
          LEFT(COALESCE(NULLIF(BTRIM(paid_credit."clienteNombre"), ''), 'Cliente'), 180),
          LEFT(COALESCE(NULLIF(BTRIM(paid_credit."clienteDocumento"), ''), 'Sin documento'), 80),
          LEFT(COALESCE(NULLIF(BTRIM(paid_credit."imei"), ''), 'Sin IMEI'), 80),
          LEFT(COALESCE(NULLIF(BTRIM(paid_credit."equipo"), ''), 'Equipo sin referencia'), 240),
          CASE WHEN UPPER(BTRIM(paid_credit."plataforma")) = 'IPHONE' THEN 'IPHONE' ELSE 'ANDROID' END,
          NEW."sedeId",
          LEFT(COALESCE(NULLIF(BTRIM(site."nombre"), ''), 'Sede sin nombre'), 180),
          settlement."id",
          paid_credit."valorPagar",
          LEFT(
            COALESCE(
              NULLIF(BTRIM((cancellation.matches)[1]), ''),
              'Anulacion capturada automaticamente'
            ),
            500
          ),
          NULL,
          'Captura automatica de base de datos',
          CURRENT_TIMESTAMP
        FROM public."LiquidacionAliadoCredito" paid_credit
        INNER JOIN public."LiquidacionAliado" settlement
          ON settlement."id" = paid_credit."liquidacionId"
        INNER JOIN public."Aliado" ally
          ON ally."id" = settlement."aliadoId"
        INNER JOIN public."Sede" site
          ON site."id" = NEW."sedeId"
        LEFT JOIN LATERAL (
          SELECT captured.matches
          FROM regexp_matches(
            COALESCE(NEW."observacionAdmin", ''),
            'ANULACION:[[:space:]]*([^\\r\\n]*)',
            'g'
          ) WITH ORDINALITY AS captured(matches, ordinal)
          ORDER BY captured.ordinal DESC
          LIMIT 1
        ) cancellation ON TRUE
        WHERE paid_credit."creditoId" = NEW."id"
          AND UPPER(BTRIM(COALESCE(settlement."estado", ''))) = 'PAGADA'
          AND UPPER(BTRIM(COALESCE(paid_credit."estado", ''))) = 'PAGADO'
          AND paid_credit."valorPagar" > 0
        ON CONFLICT DO NOTHING;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS "Credito_capture_paid_annulment_adjustment"
      ON public."Credito";
    CREATE TRIGGER "Credito_capture_paid_annulment_adjustment"
      AFTER UPDATE OF "estado" ON public."Credito"
      FOR EACH ROW EXECUTE FUNCTION public."capture_paid_credit_annulment_adjustment"();
  `,
  `
    INSERT INTO public."AjusteAnulacionCreditoAliado" (
      "creditoId", "liquidacionCreditoOrigenId", "aliadoId", "aliadoNombre",
      "fechaAnulacion", "fechaAnulacionFuente", "folio", "clienteNombre",
      "clienteDocumento", "imei", "equipo", "plataforma", "sedeId",
      "sedeNombre", "liquidacionOrigenId", "valorDescuento", "motivo",
      "creadoPorUsuarioId", "creadoPorNombre", "createdAt"
    )
    SELECT
      paid_credit."creditoId",
      paid_credit."id",
      settlement."aliadoId",
      LEFT(COALESCE(NULLIF(BTRIM(ally."nombre"), ''), 'Aliado'), 180),
      COALESCE(
        cancellation.parsed_at AT TIME ZONE 'UTC',
        credit."updatedAt",
        paid_credit."createdAt"
      ),
      CASE
        WHEN cancellation.parsed_at IS NOT NULL THEN 'OBSERVACION_ADMIN'
        ELSE 'CREDITO_UPDATED_AT'
      END,
      LEFT(COALESCE(NULLIF(BTRIM(paid_credit."folio"), ''), 'Credito ' || paid_credit."creditoId"), 80),
      LEFT(COALESCE(NULLIF(BTRIM(paid_credit."clienteNombre"), ''), 'Cliente'), 180),
      LEFT(COALESCE(NULLIF(BTRIM(paid_credit."clienteDocumento"), ''), 'Sin documento'), 80),
      LEFT(COALESCE(NULLIF(BTRIM(paid_credit."imei"), ''), 'Sin IMEI'), 80),
      LEFT(COALESCE(NULLIF(BTRIM(paid_credit."equipo"), ''), 'Equipo sin referencia'), 240),
      CASE WHEN UPPER(BTRIM(paid_credit."plataforma")) = 'IPHONE' THEN 'IPHONE' ELSE 'ANDROID' END,
      credit."sedeId",
      LEFT(COALESCE(NULLIF(BTRIM(site."nombre"), ''), 'Sede sin nombre'), 180),
      settlement."id",
      paid_credit."valorPagar",
      LEFT(
        COALESCE(NULLIF(BTRIM((cancellation.matches)[2]), ''), 'Anulacion registrada previamente'),
        500
      ),
      NULL,
      'Migracion automatica predeploy',
      CURRENT_TIMESTAMP
    FROM public."LiquidacionAliadoCredito" paid_credit
    INNER JOIN public."LiquidacionAliado" settlement
      ON settlement."id" = paid_credit."liquidacionId"
    INNER JOIN public."Aliado" ally
      ON ally."id" = settlement."aliadoId"
    INNER JOIN public."Credito" credit
      ON credit."id" = paid_credit."creditoId"
    INNER JOIN public."Sede" site
      ON site."id" = credit."sedeId"
    LEFT JOIN LATERAL (
      SELECT captured.matches
        , public."try_parse_ally_payment_annulment_timestamp"(
            (captured.matches)[1]
          ) AS parsed_at
      FROM regexp_matches(
        COALESCE(credit."observacionAdmin", ''),
        '\\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9T:.+Z-]+)\\][[:space:]]+ANULACION:[[:space:]]*([^\\r\\n]*)',
        'g'
      ) WITH ORDINALITY AS captured(matches, ordinal)
      ORDER BY captured.ordinal DESC
      LIMIT 1
    ) cancellation ON TRUE
    WHERE UPPER(BTRIM(COALESCE(credit."estado", ''))) IN (
      'ANULADO', 'ANULADA', 'CANCELADO', 'CANCELADA'
    )
      AND UPPER(BTRIM(COALESCE(settlement."estado", ''))) = 'PAGADA'
      AND UPPER(BTRIM(COALESCE(paid_credit."estado", ''))) = 'PAGADO'
      AND paid_credit."valorPagar" > 0
    ON CONFLICT DO NOTHING
  `,
  `
    CREATE OR REPLACE FUNCTION public."prevent_ajuste_anulacion_credito_aliado_mutation"()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'AjusteAnulacionCreditoAliado is append-only';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS "AjusteAnulacionCreditoAliado_immutable"
      ON public."AjusteAnulacionCreditoAliado";
    CREATE TRIGGER "AjusteAnulacionCreditoAliado_immutable"
      BEFORE UPDATE OR DELETE ON public."AjusteAnulacionCreditoAliado"
      FOR EACH ROW EXECUTE FUNCTION public."prevent_ajuste_anulacion_credito_aliado_mutation"();

    DROP TRIGGER IF EXISTS "AjusteAnulacionCreditoAliado_no_truncate"
      ON public."AjusteAnulacionCreditoAliado";
    CREATE TRIGGER "AjusteAnulacionCreditoAliado_no_truncate"
      BEFORE TRUNCATE ON public."AjusteAnulacionCreditoAliado"
      FOR EACH STATEMENT EXECUTE FUNCTION public."prevent_ajuste_anulacion_credito_aliado_mutation"();
  `,
  `
    CREATE OR REPLACE FUNCTION public."prevent_liquidacion_aliado_ajuste_mutation"()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'LiquidacionAliadoAjusteAnulacion is append-only';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS "LiquidacionAliadoAjusteAnulacion_immutable"
      ON public."LiquidacionAliadoAjusteAnulacion";
    CREATE TRIGGER "LiquidacionAliadoAjusteAnulacion_immutable"
      BEFORE UPDATE OR DELETE ON public."LiquidacionAliadoAjusteAnulacion"
      FOR EACH ROW EXECUTE FUNCTION public."prevent_liquidacion_aliado_ajuste_mutation"();

    DROP TRIGGER IF EXISTS "LiquidacionAliadoAjusteAnulacion_no_truncate"
      ON public."LiquidacionAliadoAjusteAnulacion";
    CREATE TRIGGER "LiquidacionAliadoAjusteAnulacion_no_truncate"
      BEFORE TRUNCATE ON public."LiquidacionAliadoAjusteAnulacion"
      FOR EACH STATEMENT EXECUTE FUNCTION public."prevent_liquidacion_aliado_ajuste_mutation"();
  `,
  'CREATE UNIQUE INDEX IF NOT EXISTS "LiquidacionAliado_mutationId_key" ON public."LiquidacionAliado" ("mutationId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "LiquidacionAliado_numeroAprobacionNormalizado_key" ON public."LiquidacionAliado" ("numeroAprobacionNormalizado")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliado_aliadoId_pagadoAt_idx" ON public."LiquidacionAliado" ("aliadoId", "pagadoAt")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliado_periodoInicio_periodoFin_idx" ON public."LiquidacionAliado" ("periodoInicio", "periodoFin")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliado_estado_pagadoAt_idx" ON public."LiquidacionAliado" ("estado", "pagadoAt")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliado_registradoPorUsuarioId_pagadoAt_idx" ON public."LiquidacionAliado" ("registradoPorUsuarioId", "pagadoAt")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "LiquidacionAliadoCredito_creditoId_key" ON public."LiquidacionAliadoCredito" ("creditoId")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliadoCredito_liquidacionId_plataforma_idx" ON public."LiquidacionAliadoCredito" ("liquidacionId", "plataforma")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliadoCredito_plataforma_fechaCredito_idx" ON public."LiquidacionAliadoCredito" ("plataforma", "fechaCredito")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliadoCredito_estado_createdAt_idx" ON public."LiquidacionAliadoCredito" ("estado", "createdAt")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "LiquidacionAliadoRecaudo_abonoId_key" ON public."LiquidacionAliadoRecaudo" ("abonoId")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliadoRecaudo_liquidacionId_fechaAbono_idx" ON public."LiquidacionAliadoRecaudo" ("liquidacionId", "fechaAbono")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliadoRecaudo_sedeId_fechaAbono_idx" ON public."LiquidacionAliadoRecaudo" ("sedeId", "fechaAbono")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliadoRecaudo_estado_createdAt_idx" ON public."LiquidacionAliadoRecaudo" ("estado", "createdAt")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "AjusteAnulacionCreditoAliado_creditoId_key" ON public."AjusteAnulacionCreditoAliado" ("creditoId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "AjusteAnulacionCreditoAliado_origenCredito_key" ON public."AjusteAnulacionCreditoAliado" ("liquidacionCreditoOrigenId")',
  'CREATE INDEX IF NOT EXISTS "AjusteAnulacionCreditoAliado_aliadoId_fechaAnulacion_idx" ON public."AjusteAnulacionCreditoAliado" ("aliadoId", "fechaAnulacion")',
  'CREATE INDEX IF NOT EXISTS "AjusteAnulacionCreditoAliado_liquidacionOrigenId_idx" ON public."AjusteAnulacionCreditoAliado" ("liquidacionOrigenId")',
  'CREATE INDEX IF NOT EXISTS "AjusteAnulacionCreditoAliado_fuente_createdAt_idx" ON public."AjusteAnulacionCreditoAliado" ("fechaAnulacionFuente", "createdAt")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "LiquidacionAliadoAjusteAnulacion_ajusteId_key" ON public."LiquidacionAliadoAjusteAnulacion" ("ajusteId")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliadoAjusteAnulacion_liquidacionId_createdAt_idx" ON public."LiquidacionAliadoAjusteAnulacion" ("liquidacionId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "LiquidacionAliadoAjusteAnulacion_estado_createdAt_idx" ON public."LiquidacionAliadoAjusteAnulacion" ("estado", "createdAt")',
];

statements.push(...creditAllyPaymentExclusionSchemaStatements);

const expectedColumns = [
  ["CreditAllyPaymentExclusion", "creditoId", "integer", "NO"],
  ["CreditAllyPaymentExclusion", "reason", "text", "NO"],
  ["CreditAllyPaymentExclusion", "sourceFile", "text", "NO"],
  ["CreditAllyPaymentExclusion", "sourceSha256", "character", "NO", 64],
  ["CreditAllyPaymentExclusion", "sourceSheet", "text", "NO"],
  ["CreditAllyPaymentExclusion", "sourceRow", "integer", "NO"],
  ["CreditAllyPaymentExclusion", "createdBy", "text", "NO"],
  ["CreditAllyPaymentExclusion", "createdAt", "timestamp without time zone", "NO"],
  ["LiquidacionAliado", "id", "integer", "NO"],
  ["LiquidacionAliado", "mutationId", "uuid", "NO"],
  ["LiquidacionAliado", "requestHash", "character", "NO", 64],
  ["LiquidacionAliado", "aliadoId", "integer", "NO"],
  ["LiquidacionAliado", "periodoInicio", "date", "NO"],
  ["LiquidacionAliado", "periodoFin", "date", "NO"],
  ["LiquidacionAliado", "numeroAprobacionBancaria", "character varying", "NO", 120],
  ["LiquidacionAliado", "numeroAprobacionNormalizado", "character varying", "NO", 120],
  ["LiquidacionAliado", "estado", "character varying", "NO", 16],
  ["LiquidacionAliado", "numeroCreditos", "integer", "NO"],
  ["LiquidacionAliado", "totalValorVenta", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliado", "totalCreditoAutorizado", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliado", "totalCuotaInicial", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliado", "totalIntermediacion", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliado", "totalPagar", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliado", "totalRecaudosAliado", "numeric", "YES", null, 20, 2],
  ["LiquidacionAliado", "numeroAjustesAnulacion", "integer", "NO"],
  ["LiquidacionAliado", "totalAjustesAnulacion", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliado", "saldoNeto", "numeric", "YES", null, 20, 2],
  ["LiquidacionAliado", "direccionSaldo", "character varying", "YES", 32],
  ["LiquidacionAliado", "registradoPorUsuarioId", "integer", "NO"],
  ["LiquidacionAliado", "registradoPorNombre", "character varying", "NO", 160],
  ["LiquidacionAliado", "pagadoAt", "timestamp without time zone", "NO"],
  ["LiquidacionAliado", "createdAt", "timestamp without time zone", "NO"],
  ["LiquidacionAliado", "updatedAt", "timestamp without time zone", "NO"],
  ["LiquidacionAliadoCredito", "id", "integer", "NO"],
  ["LiquidacionAliadoCredito", "liquidacionId", "integer", "NO"],
  ["LiquidacionAliadoCredito", "creditoId", "integer", "NO"],
  ["LiquidacionAliadoCredito", "fechaCredito", "timestamp without time zone", "NO"],
  ["LiquidacionAliadoCredito", "folio", "character varying", "NO", 80],
  ["LiquidacionAliadoCredito", "clienteNombre", "character varying", "NO", 180],
  ["LiquidacionAliadoCredito", "clienteDocumento", "character varying", "NO", 80],
  ["LiquidacionAliadoCredito", "imei", "character varying", "NO", 80],
  ["LiquidacionAliadoCredito", "equipo", "character varying", "NO", 240],
  ["LiquidacionAliadoCredito", "plataforma", "character varying", "NO", 16],
  ["LiquidacionAliadoCredito", "valorVenta", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliadoCredito", "creditoAutorizado", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliadoCredito", "cuotaInicial", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliadoCredito", "porcentajeIntermediacion", "numeric", "NO", null, 7, 4],
  ["LiquidacionAliadoCredito", "valorIntermediacion", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliadoCredito", "valorPagar", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliadoCredito", "estado", "character varying", "NO", 16],
  ["LiquidacionAliadoCredito", "createdAt", "timestamp without time zone", "NO"],
  ["LiquidacionAliadoRecaudo", "id", "integer", "NO"],
  ["LiquidacionAliadoRecaudo", "liquidacionId", "integer", "NO"],
  ["LiquidacionAliadoRecaudo", "abonoId", "integer", "NO"],
  ["LiquidacionAliadoRecaudo", "creditoId", "integer", "NO"],
  ["LiquidacionAliadoRecaudo", "sedeId", "integer", "NO"],
  ["LiquidacionAliadoRecaudo", "fechaAbono", "timestamp without time zone", "NO"],
  ["LiquidacionAliadoRecaudo", "folio", "character varying", "NO", 80],
  ["LiquidacionAliadoRecaudo", "clienteNombre", "character varying", "NO", 180],
  ["LiquidacionAliadoRecaudo", "clienteDocumento", "character varying", "NO", 80],
  ["LiquidacionAliadoRecaudo", "sedeNombre", "character varying", "NO", 180],
  ["LiquidacionAliadoRecaudo", "metodoPago", "character varying", "NO", 40],
  ["LiquidacionAliadoRecaudo", "valor", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliadoRecaudo", "estado", "character varying", "NO", 16],
  ["LiquidacionAliadoRecaudo", "createdAt", "timestamp without time zone", "NO"],
  ["AjusteAnulacionCreditoAliado", "id", "integer", "NO"],
  ["AjusteAnulacionCreditoAliado", "creditoId", "integer", "NO"],
  ["AjusteAnulacionCreditoAliado", "liquidacionCreditoOrigenId", "integer", "NO"],
  ["AjusteAnulacionCreditoAliado", "aliadoId", "integer", "NO"],
  ["AjusteAnulacionCreditoAliado", "aliadoNombre", "character varying", "NO", 180],
  ["AjusteAnulacionCreditoAliado", "fechaAnulacion", "timestamp without time zone", "NO"],
  ["AjusteAnulacionCreditoAliado", "fechaAnulacionFuente", "character varying", "NO", 32],
  ["AjusteAnulacionCreditoAliado", "folio", "character varying", "NO", 80],
  ["AjusteAnulacionCreditoAliado", "clienteNombre", "character varying", "NO", 180],
  ["AjusteAnulacionCreditoAliado", "clienteDocumento", "character varying", "NO", 80],
  ["AjusteAnulacionCreditoAliado", "imei", "character varying", "NO", 80],
  ["AjusteAnulacionCreditoAliado", "equipo", "character varying", "NO", 240],
  ["AjusteAnulacionCreditoAliado", "plataforma", "character varying", "NO", 16],
  ["AjusteAnulacionCreditoAliado", "sedeId", "integer", "NO"],
  ["AjusteAnulacionCreditoAliado", "sedeNombre", "character varying", "NO", 180],
  ["AjusteAnulacionCreditoAliado", "liquidacionOrigenId", "integer", "NO"],
  ["AjusteAnulacionCreditoAliado", "valorDescuento", "numeric", "NO", null, 20, 2],
  ["AjusteAnulacionCreditoAliado", "motivo", "character varying", "NO", 500],
  ["AjusteAnulacionCreditoAliado", "creadoPorUsuarioId", "integer", "YES"],
  ["AjusteAnulacionCreditoAliado", "creadoPorNombre", "character varying", "NO", 160],
  ["AjusteAnulacionCreditoAliado", "createdAt", "timestamp without time zone", "NO"],
  ["LiquidacionAliadoAjusteAnulacion", "id", "integer", "NO"],
  ["LiquidacionAliadoAjusteAnulacion", "liquidacionId", "integer", "NO"],
  ["LiquidacionAliadoAjusteAnulacion", "ajusteId", "integer", "NO"],
  ["LiquidacionAliadoAjusteAnulacion", "valorDescuento", "numeric", "NO", null, 20, 2],
  ["LiquidacionAliadoAjusteAnulacion", "estado", "character varying", "NO", 24],
  ["LiquidacionAliadoAjusteAnulacion", "createdAt", "timestamp without time zone", "NO"],
];

const expectedIndexes = [
  ["CreditAllyPaymentExclusion", "CreditAllyPaymentExclusion_pkey", true, ["creditoId"]],
  ["LiquidacionAliado", "LiquidacionAliado_mutationId_key", true, ["mutationId"]],
  [
    "LiquidacionAliado",
    "LiquidacionAliado_numeroAprobacionNormalizado_key",
    true,
    ["numeroAprobacionNormalizado"],
  ],
  [
    "LiquidacionAliado",
    "LiquidacionAliado_aliadoId_pagadoAt_idx",
    false,
    ["aliadoId", "pagadoAt"],
  ],
  [
    "LiquidacionAliado",
    "LiquidacionAliado_periodoInicio_periodoFin_idx",
    false,
    ["periodoInicio", "periodoFin"],
  ],
  [
    "LiquidacionAliado",
    "LiquidacionAliado_estado_pagadoAt_idx",
    false,
    ["estado", "pagadoAt"],
  ],
  [
    "LiquidacionAliado",
    "LiquidacionAliado_registradoPorUsuarioId_pagadoAt_idx",
    false,
    ["registradoPorUsuarioId", "pagadoAt"],
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_creditoId_key",
    true,
    ["creditoId"],
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_liquidacionId_plataforma_idx",
    false,
    ["liquidacionId", "plataforma"],
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_plataforma_fechaCredito_idx",
    false,
    ["plataforma", "fechaCredito"],
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_estado_createdAt_idx",
    false,
    ["estado", "createdAt"],
  ],
  ["LiquidacionAliadoRecaudo", "LiquidacionAliadoRecaudo_abonoId_key", true, ["abonoId"]],
  ["LiquidacionAliadoRecaudo", "LiquidacionAliadoRecaudo_liquidacionId_fechaAbono_idx", false, ["liquidacionId", "fechaAbono"]],
  ["LiquidacionAliadoRecaudo", "LiquidacionAliadoRecaudo_sedeId_fechaAbono_idx", false, ["sedeId", "fechaAbono"]],
  ["LiquidacionAliadoRecaudo", "LiquidacionAliadoRecaudo_estado_createdAt_idx", false, ["estado", "createdAt"]],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_creditoId_key", true, ["creditoId"]],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_origenCredito_key", true, ["liquidacionCreditoOrigenId"]],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_aliadoId_fechaAnulacion_idx", false, ["aliadoId", "fechaAnulacion"]],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_liquidacionOrigenId_idx", false, ["liquidacionOrigenId"]],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_fuente_createdAt_idx", false, ["fechaAnulacionFuente", "createdAt"]],
  ["LiquidacionAliadoAjusteAnulacion", "LiquidacionAliadoAjusteAnulacion_ajusteId_key", true, ["ajusteId"]],
  ["LiquidacionAliadoAjusteAnulacion", "LiquidacionAliadoAjusteAnulacion_liquidacionId_createdAt_idx", false, ["liquidacionId", "createdAt"]],
  ["LiquidacionAliadoAjusteAnulacion", "LiquidacionAliadoAjusteAnulacion_estado_createdAt_idx", false, ["estado", "createdAt"]],
];

const expectedConstraints = [
  ["CreditAllyPaymentExclusion", "CreditAllyPaymentExclusion_creditoId_fkey", "f"],
  ["LiquidacionAliado", "LiquidacionAliado_aliadoId_fkey", "f"],
  [
    "LiquidacionAliado",
    "LiquidacionAliado_registradoPorUsuarioId_fkey",
    "f",
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_liquidacionId_fkey",
    "f",
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_creditoId_fkey",
    "f",
  ],
  ["LiquidacionAliado", "LiquidacionAliado_requestHash_check", "c"],
  ["LiquidacionAliado", "LiquidacionAliado_periodo_check", "c"],
  ["LiquidacionAliado", "LiquidacionAliado_aprobacion_check", "c"],
  ["LiquidacionAliado", "LiquidacionAliado_estado_check", "c"],
  ["LiquidacionAliado", "LiquidacionAliado_numeroCreditos_check", "c"],
  ["LiquidacionAliado", "LiquidacionAliado_totales_check", "c"],
  ["LiquidacionAliado", "LiquidacionAliado_formula_check", "c"],
  ["LiquidacionAliado", "LiquidacionAliado_balance_check", "c"],
  ["LiquidacionAliado", "LiquidacionAliado_registradoPorNombre_check", "c"],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_plataforma_check",
    "c",
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_porcentaje_check",
    "c",
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_importes_check",
    "c",
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_formula_check",
    "c",
  ],
  [
    "LiquidacionAliadoCredito",
    "LiquidacionAliadoCredito_estado_check",
    "c",
  ],
  ["LiquidacionAliadoRecaudo", "LiquidacionAliadoRecaudo_liquidacionId_fkey", "f"],
  ["LiquidacionAliadoRecaudo", "LiquidacionAliadoRecaudo_valor_check", "c"],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_creditoId_fkey", "f"],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_origenCredito_fkey", "f"],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_aliadoId_fkey", "f"],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_origenLiquidacion_fkey", "f"],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_creadoPor_fkey", "f"],
  ["AjusteAnulacionCreditoAliado", "AjusteAnulacionCreditoAliado_datos_check", "c"],
  ["LiquidacionAliadoAjusteAnulacion", "LiquidacionAliadoAjusteAnulacion_liquidacionId_fkey", "f"],
  ["LiquidacionAliadoAjusteAnulacion", "LiquidacionAliadoAjusteAnulacion_ajusteId_fkey", "f"],
  ["LiquidacionAliadoAjusteAnulacion", "LiquidacionAliadoAjusteAnulacion_datos_check", "c"],
];

async function assertCompatibleColumns() {
  const result = await client.query(
    `
      SELECT table_name, column_name, data_type, is_nullable,
        character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [["LiquidacionAliado", "LiquidacionAliadoCredito", "LiquidacionAliadoRecaudo", "AjusteAnulacionCreditoAliado", "LiquidacionAliadoAjusteAnulacion", "CreditAllyPaymentExclusion"]]
  );
  const columns = new Map(
    result.rows.map((row) => [
      row.table_name + "." + row.column_name,
      row,
    ])
  );

  for (const [
    table,
    column,
    dataType,
    nullable,
    maxLength,
    precision,
    scale,
  ] of expectedColumns) {
    const actual = columns.get(table + "." + column);
    const compatible =
      actual &&
      actual.data_type === dataType &&
      actual.is_nullable === nullable &&
      (maxLength == null ||
        Number(actual.character_maximum_length) === maxLength) &&
      (precision == null || Number(actual.numeric_precision) === precision) &&
      (scale == null || Number(actual.numeric_scale) === scale);

    if (!compatible) {
      throw new Error("Definicion incompatible en " + table + "." + column + ".");
    }
  }
}

async function assertCompatibleIndexes() {
  const result = await client.query(
    `
      SELECT table_class.relname AS table_name,
        index_class.relname AS index_name,
        index_definition.indisunique AS is_unique,
        ARRAY_AGG(attribute.attname::text ORDER BY key_column.ordinality) AS columns
      FROM pg_class table_class
      JOIN pg_namespace namespace
        ON namespace.oid = table_class.relnamespace
      JOIN pg_index index_definition
        ON index_definition.indrelid = table_class.oid
      JOIN pg_class index_class
        ON index_class.oid = index_definition.indexrelid
      CROSS JOIN LATERAL
        UNNEST(index_definition.indkey) WITH ORDINALITY
          AS key_column(attribute_number, ordinality)
      JOIN pg_attribute attribute
        ON attribute.attrelid = table_class.oid
        AND attribute.attnum = key_column.attribute_number
      WHERE namespace.nspname = 'public'
        AND table_class.relname = ANY($1::text[])
        AND key_column.ordinality <= index_definition.indnkeyatts
      GROUP BY table_class.relname, index_class.relname,
        index_definition.indisunique
    `,
    [["LiquidacionAliado", "LiquidacionAliadoCredito", "LiquidacionAliadoRecaudo", "AjusteAnulacionCreditoAliado", "LiquidacionAliadoAjusteAnulacion", "CreditAllyPaymentExclusion"]]
  );
  const indexes = new Map(
    result.rows.map((row) => [
      row.table_name + "." + row.index_name,
      row,
    ])
  );

  for (const [table, indexName, unique, columns] of expectedIndexes) {
    const actual = indexes.get(table + "." + indexName);
    if (
      !actual ||
      actual.is_unique !== unique ||
      JSON.stringify(actual.columns) !== JSON.stringify(columns)
    ) {
      const actualDefinition = actual
        ? `unique=${String(actual.is_unique)}, columns=${JSON.stringify(actual.columns)}`
        : "ausente";
      throw new Error(
        "Indice incompatible: " +
          indexName +
          `. Esperado unique=${String(unique)}, columns=${JSON.stringify(columns)}; ` +
          "actual " +
          actualDefinition +
          "."
      );
    }
  }
}

async function assertCompatibleConstraints() {
  const result = await client.query(
    `
      SELECT table_class.relname AS table_name,
        constraint_definition.conname AS constraint_name,
        constraint_definition.contype AS constraint_type
      FROM pg_constraint constraint_definition
      JOIN pg_class table_class
        ON table_class.oid = constraint_definition.conrelid
      JOIN pg_namespace namespace
        ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = 'public'
        AND table_class.relname = ANY($1::text[])
    `,
    [["LiquidacionAliado", "LiquidacionAliadoCredito", "LiquidacionAliadoRecaudo", "AjusteAnulacionCreditoAliado", "LiquidacionAliadoAjusteAnulacion", "CreditAllyPaymentExclusion"]]
  );
  const constraints = new Map(
    result.rows.map((row) => [
      row.table_name + "." + row.constraint_name,
      row,
    ])
  );

  for (const [table, constraintName, type] of expectedConstraints) {
    const actual = constraints.get(table + "." + constraintName);
    if (!actual || actual.constraint_type !== type) {
      throw new Error("Restriccion incompatible: " + constraintName + ".");
    }
  }
}

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");

  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('finserpay-ally-payments-schema'))"
    );

    for (const statement of statements) {
      await client.query(statement);
    }

    await assertCompatibleColumns();
    await assertCompatibleIndexes();
    await assertCompatibleConstraints();
    await client.query("COMMIT");
    console.log("Esquema de pagos a aliados preparado correctamente.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24)
      : "";
  const safeReason =
    error instanceof Error &&
    /^(Definicion incompatible en|Indice incompatible:|Restriccion incompatible:)/.test(
      error.message
    )
      ? error.message
      : "";
  throw new Error(
    "No se pudo preparar el esquema de pagos a aliados" +
      (code ? " (" + code + ")" : "") +
      "." +
      (safeReason ? " " + safeReason : "")
  );
} finally {
  await client.end().catch(() => undefined);
}
