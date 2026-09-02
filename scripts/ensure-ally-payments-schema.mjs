import pg from "pg";

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
      "registradoPorUsuarioId" INTEGER NOT NULL,
      "registradoPorNombre" VARCHAR(160) NOT NULL,
      "pagadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_numeroCreditos_check'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_numeroCreditos_check"
          CHECK ("numeroCreditos" > 0);
      END IF;
    END $$;
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LiquidacionAliado_totales_check'
          AND conrelid = 'public."LiquidacionAliado"'::regclass
      ) THEN
        ALTER TABLE public."LiquidacionAliado"
          ADD CONSTRAINT "LiquidacionAliado_totales_check"
          CHECK (
            "totalValorVenta" >= 0
            AND "totalCreditoAutorizado" >= 0
            AND "totalCuotaInicial" >= 0
            AND "totalIntermediacion" >= 0
            AND "totalPagar" >= 0
          );
      END IF;
    END $$;
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
];

const expectedColumns = [
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
];

const expectedIndexes = [
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
];

const expectedConstraints = [
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
    [["LiquidacionAliado", "LiquidacionAliadoCredito"]]
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
    [["LiquidacionAliado", "LiquidacionAliadoCredito"]]
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
    [["LiquidacionAliado", "LiquidacionAliadoCredito"]]
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
